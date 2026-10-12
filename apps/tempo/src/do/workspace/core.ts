import { and, asc, desc, eq, gt, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import {
  DEFAULT_SETTINGS,
  Settings as SettingsSchema,
  SettingsLayer,
  TempoError,
  type AgentId,
  type Attention,
  type ChangesSummary,
  type Item,
  type ItemKind,
  type ItemStatus,
  type Session,
  type Settings,
  type SettingsSource,
  type Turn,
  type TurnPrompt,
  type WorkspaceDetail,
  type WorkspaceServerMessage,
  type WorkspaceState,
  type WorkspaceSummary,
  CloseCode,
  newId,
} from "@tempo/protocol";
import { resolveSettings } from "@tempo/settings";
import { Schema } from "effect";
import { projects, workspaces } from "../../db/d1.ts";
import {
  items,
  permissions,
  ports,
  sessions,
  turns,
  workspace,
  workspaceSchema,
  type ItemRow,
  type SessionRow,
  type TurnRow,
  type WorkspaceRowDO,
} from "../../db/workspace-do.ts";
import type { Env } from "../../env.ts";
import { log } from "../../log.ts";
import type { TempodClient } from "./tempod-client.ts";
import { assertTransition } from "./transitions.ts";
import { WorkspaceFiles } from "./files.ts";

export type DB = DrizzleSqliteDODatabase<typeof workspaceSchema>;

export interface ProjectInfo {
  readonly id: string;
  readonly installationId: number;
  readonly repoId: number;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly overrides: SettingsLayer;
}

export interface Author {
  readonly name: string;
  readonly email: string;
}

const MAX_BUFFERED = 4 * 1024 * 1024;
const decodeSettings = Schema.decodeUnknownOption(SettingsSchema);
const decodeLayer = Schema.decodeUnknownOption(SettingsLayer);

export const parseJson = <T>(text: string | null | undefined, fallback: T): T => {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

/** Everything the WorkspaceDO modules share: storage, in-memory state, and helpers. */
export class WorkspaceCore {
  readonly files = new WorkspaceFiles(this);
  readonly db: DB;
  tempod: TempodClient | null = null;
  /** The connect in flight, shared by every caller (container.ts, connectTempod). */
  tempodConnecting: Promise<TempodClient> | null = null;
  /** Sessions with a live adapter process in the current container. */
  readonly liveSessions = new Set<string>();
  ghToken: { token: string; expiresAt: number } | null = null;
  lastPreviewAt = 0;
  lastHomeBackupAt = 0;
  tempodVersion: string | null = null;
  private projectCache: { info: ProjectInfo; at: number } | null = null;
  readonly opWaiters = new Map<
    string,
    Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }>
  >();
  /** Set by index.ts: runs the queue runner after any change to state, turns, sessions or setup. */
  kickQueue: () => void = () => undefined;
  /** Set by index.ts: re-arms the single alarm. */
  scheduleAlarm: () => void = () => undefined;
  closingTempod = false;
  queueBusy = false;
  tempodStopping = false;
  turnEndInProgress = false;
  reconnectAttempt = 0;
  reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Open terminal sockets and their PTY exec processes (01, Terminal). */
  readonly terminals = new Map<WebSocket, { readonly terminalId: string; proc: ExecProcess | null }>();
  private detailTimer: ReturnType<typeof setTimeout> | null = null;

  closeTerminals(code: number, reason: string): void {
    for (const [ws, t] of this.terminals) {
      try {
        t.proc?.kill();
      } catch {
        // already gone
      }
      try {
        ws.close(code, reason);
      } catch {
        // already closed
      }
    }
    this.terminals.clear();
  }

  /** Sends the workspace detail to UI sockets soon, coalescing bursts (op progress, ports). */
  broadcastDetailSoon(): void {
    if (this.detailTimer || this.uiSockets().length === 0) return;
    this.detailTimer = setTimeout(() => {
      this.detailTimer = null;
      if (this.wsOrNull()) this.broadcast({ type: "workspace", workspace: this.detail() });
    }, 50);
  }

  /** The container API (ctx.container). A field, so tests can put a fake in its place. */
  container: Container | undefined;

  constructor(
    readonly ctx: DurableObjectState,
    readonly env: Env,
  ) {
    this.db = drizzle(ctx.storage, { schema: workspaceSchema });
    this.container = ctx.container;
  }

  // ---------- workspace row ----------

  wsOrNull(): WorkspaceRowDO | null {
    return this.db.select().from(workspace).where(eq(workspace.id, 1)).get() ?? null;
  }

  ws(): WorkspaceRowDO {
    const row = this.wsOrNull();
    if (!row) throw new TempoError("NOT_FOUND");
    return row;
  }

  get workspaceId(): string {
    return this.ws().workspaceId;
  }

  updateWs(patch: Partial<typeof workspace.$inferInsert>): void {
    this.db.update(workspace).set(patch).where(eq(workspace.id, 1)).run();
  }

  get state(): WorkspaceState {
    return this.ws().state as WorkspaceState;
  }

  /** Moves the state machine (03). Throws on any transition not in the table. */
  setState(next: WorkspaceState, error?: { code: string; detail?: string | null }): void {
    const row = this.ws();
    const from = row.state as WorkspaceState;
    assertTransition(from, next);
    if (from === next && !error) return;
    this.updateWs({
      state: next,
      stateSince: Date.now(),
      ...(next === "error"
        ? { errorCode: error?.code ?? "INTERNAL", errorDetail: error?.detail ?? null }
        : { errorCode: null, errorDetail: null }),
    });
    log("info", "workspace state", { workspaceId: row.workspaceId, from, to: next });
    this.recomputeAttention(false);
    this.publish();
    this.kickQueue();
    this.scheduleAlarm();
  }

  // ---------- settings ----------

  settings(): Settings {
    const row = this.ws();
    const stored = decodeSettings(parseJson(row.settingsJson, {}));
    if (stored._tag === "Some") return stored.value;
    const overrides = this.projectCache?.info.overrides ?? {};
    return resolveSettings(overrides, {}).effective ?? DEFAULT_SETTINGS;
  }

  kv<T>(key: string): T | undefined {
    return this.ctx.storage.kv.get<T>(key);
  }

  setKv(key: string, value: unknown): void {
    if (value === undefined) this.ctx.storage.kv.delete(key);
    else this.ctx.storage.kv.put(key, value);
  }

  settingsIssues(): { warnings: string[]; errors: string[]; sources: Record<string, SettingsSource> } {
    return this.kv("settingsIssues") ?? { warnings: [], errors: [], sources: {} };
  }

  async project(fresh = false): Promise<ProjectInfo> {
    if (!fresh && this.projectCache && Date.now() - this.projectCache.at < 30_000)
      return this.projectCache.info;
    const row = await drizzleD1(this.env.DB)
      .select()
      .from(projects)
      .where(eq(projects.id, this.ws().projectId))
      .get();
    if (!row) throw new TempoError("NOT_FOUND", undefined, "project not found");
    const overrides = decodeLayer(parseJson(row.settingsJson, {}));
    const info: ProjectInfo = {
      id: row.id,
      installationId: row.installationId,
      repoId: row.repoId,
      owner: row.repoOwner,
      name: row.repoName,
      defaultBranch: row.defaultBranch,
      overrides: overrides._tag === "Some" ? overrides.value : {},
    };
    this.projectCache = { info, at: Date.now() };
    return info;
  }

  author(): Author {
    return this.kv<Author>("author") ?? { name: "Tempo", email: "tempo@users.noreply.github.com" };
  }

  credentials() {
    return this.env.CREDENTIALS.getByName(this.ws().userId);
  }

  /** Script env (01, Scripts): TEMPO_* and CONDUCTOR_* vars plus the project's env vars and secrets. */
  async scriptEnv(): Promise<Record<string, string>> {
    const row = this.ws();
    const settings = this.settings();
    const secrets = await this.credentials().listProjectEnv(row.projectId);
    const base = {
      TEMPO_WORKSPACE_ID: row.workspaceId,
      TEMPO_WORKSPACE_NAME: row.slug,
      TEMPO_WORKSPACE_PATH: "/workspace",
      TEMPO_DEFAULT_BRANCH: row.baseBranch,
      TEMPO_PORT: "3000",
      CONDUCTOR_WORKSPACE_NAME: row.slug,
      CONDUCTOR_WORKSPACE_PATH: "/workspace",
      CONDUCTOR_ROOT_PATH: "/workspace",
      CONDUCTOR_DEFAULT_BRANCH: row.baseBranch,
      CONDUCTOR_PORT: "3000",
    };
    return { ...settings.environment_variables, ...secrets, ...base };
  }

  // ---------- attention, summary, detail ----------

  computeAttention(): Attention {
    const row = this.ws();
    const pending = this.db
      .select({ id: permissions.requestId })
      .from(permissions)
      .where(eq(permissions.status, "pending"))
      .get();
    if (pending) return "needs_input";
    const newest = this.db
      .select()
      .from(turns)
      .where(isNotNull(turns.endedAt))
      .orderBy(desc(turns.endedAt))
      .limit(1)
      .get();
    if (row.state === "error" || row.setupStatus === "failed" || newest?.status === "failed") return "error";
    if (newest?.endedAt && (row.lastViewedAt === null || newest.endedAt > row.lastViewedAt)) return "unread";
    return "none";
  }

  /** Recomputes attention (03). Publishes when it changed, unless the caller publishes itself. */
  recomputeAttention(publish = true): void {
    const row = this.ws();
    const next = this.computeAttention();
    if (next !== row.attention) {
      this.updateWs({ attention: next });
      if (publish) this.publish();
    }
  }

  summary(row: WorkspaceRowDO = this.ws()): WorkspaceSummary {
    return {
      id: row.workspaceId,
      projectId: row.projectId,
      slug: row.slug,
      title: row.title,
      branch: row.branch,
      baseBranch: row.baseBranch,
      state: row.state as WorkspaceState,
      attention: row.attention as Attention,
      defaultAgent: row.defaultAgent as AgentId,
      prNumber: row.prNumber,
      prState: row.prState as WorkspaceSummary["prState"],
      checksState: row.checksState as WorkspaceSummary["checksState"],
      pinned: row.pinned === 1,
      lastActivityAt: row.lastActivityAt,
      createdAt: row.createdAt,
      archivedAt: row.archivedAt,
      rev: row.summaryRev,
    };
  }

  previewUrl(port: number, row: WorkspaceRowDO = this.ws()): string {
    return `https://${port}-${row.workspaceId}-${row.previewToken}.${this.env.PREVIEW_DOMAIN}`;
  }

  /** Set by the op runner: the running op, else the next pending op. */
  opProgress: () => WorkspaceDetail["op"] = () => null;

  detail(): WorkspaceDetail {
    const row = this.ws();
    const running = this.db.select({ id: turns.id }).from(turns).where(eq(turns.status, "running")).get();
    const queue = this.db
      .select({ id: turns.id })
      .from(turns)
      .where(eq(turns.status, "queued"))
      .orderBy(asc(turns.queuePos))
      .all()
      .map((t) => t.id);
    const issues = this.settingsIssues();
    return {
      ...this.summary(row),
      errorCode: row.errorCode,
      errorDetail: row.errorDetail,
      setupStatus: row.setupStatus as WorkspaceDetail["setupStatus"],
      pushed: row.pushed === 1,
      prTitle: row.prNumber === null ? null : (this.kv<string>("prTitle") ?? null),
      previewToken: row.previewToken,
      ports: this.db
        .select()
        .from(ports)
        .orderBy(asc(ports.port))
        .all()
        .map((p) => ({ port: p.port, url: this.previewUrl(p.port, row) })),
      settings: this.settings(),
      runningTurnId: running?.id ?? null,
      queue,
      imageRef: row.imageRef,
      op: this.opProgress(),
      settingsWarnings: issues.warnings,
      settingsErrors: issues.errors,
      settingsSources: issues.sources,
      changes: this.kv<ChangesSummary>("changes") ?? null,
      hasUnpushedCommits: this.kv<boolean>("hasUnpushedCommits") ?? false,
    };
  }

  /**
   * Writes the D1 summary row with a monotonic `summary_rev`, publishes to UserHubDO, and
   * sends the detail to every UI socket (02, Write rules).
   */
  publish(): void {
    const row = this.ws();
    const rev = row.summaryRev + 1;
    this.updateWs({ summaryRev: rev });
    const fresh = this.ws();
    const summary = this.summary(fresh);
    const d1 = drizzleD1(this.env.DB);
    const write = d1
      .update(workspaces)
      .set({
        slug: summary.slug,
        title: summary.title,
        branch: summary.branch,
        baseBranch: summary.baseBranch,
        state: summary.state,
        attention: summary.attention,
        defaultAgent: summary.defaultAgent,
        prNumber: summary.prNumber,
        prState: summary.prState,
        checksState: summary.checksState,
        pinned: summary.pinned ? 1 : 0,
        lastActivityAt: summary.lastActivityAt,
        archivedAt: summary.archivedAt,
        summaryRev: rev,
      })
      .where(and(eq(workspaces.id, summary.id), sql`${workspaces.summaryRev} < ${rev}`))
      .run()
      .then(() => this.env.USER_HUB.getByName(fresh.userId).publish(summary))
      .catch((e) => log("warn", "summary publish failed", { workspaceId: summary.id, error: String(e) }));
    this.ctx.waitUntil(write);
    this.broadcast({ type: "workspace", workspace: this.detail() });
  }

  // ---------- sessions and turns ----------

  sessionRow(id: string): SessionRow {
    const row = this.db.select().from(sessions).where(eq(sessions.id, id)).get();
    if (!row) throw new TempoError("NOT_FOUND", undefined, "session not found");
    return row;
  }

  sessionToWire(r: SessionRow): Session {
    return {
      id: r.id,
      agent: r.agent as AgentId,
      title: r.title,
      status: r.status as Session["status"],
      modeId: r.modeId,
      modes: parseJson(r.modesJson, []),
      configOptions: parseJson(r.configOptionsJson, []),
      config: parseJson(r.configJson, {}),
      commands: parseJson(r.commandsJson, []),
      usage: parseJson(r.usageJson, {}),
      sortOrder: r.sortOrder,
      steering: parseJson<Record<string, unknown>>(r.capabilitiesJson, {})["steering"] === true,
    };
  }

  updateSession(id: string, patch: Partial<typeof sessions.$inferInsert>): Session {
    this.db
      .update(sessions)
      .set({ ...patch, updatedAt: Date.now() })
      .where(eq(sessions.id, id))
      .run();
    const s = this.sessionToWire(this.sessionRow(id));
    this.broadcast({ type: "session", session: s });
    return s;
  }

  turnRow(id: string): TurnRow {
    const row = this.db.select().from(turns).where(eq(turns.id, id)).get();
    if (!row) throw new TempoError("NOT_FOUND", undefined, "turn not found");
    return row;
  }

  turnToWire(r: TurnRow): Turn {
    return {
      id: r.id,
      sessionId: r.sessionId,
      seq: r.seq,
      status: r.status as Turn["status"],
      queuePos: r.queuePos,
      steeringPending: r.steeringPending === 1,
      prompt: parseJson<TurnPrompt>(r.promptJson, {
        text: "",
        mentions: [],
        attachmentIds: [],
        reviewCommentIds: [],
      }),
      stopReason: r.stopReason,
      errorCode: r.errorCode,
      checkpointId: r.checkpointId,
      reverted: r.reverted === 1,
      queuedAt: r.queuedAt,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
    };
  }

  updateTurn(id: string, patch: Partial<typeof turns.$inferInsert>): Turn {
    this.db.update(turns).set(patch).where(eq(turns.id, id)).run();
    const t = this.turnToWire(this.turnRow(id));
    this.broadcast({ type: "turn", turn: t });
    return t;
  }

  runningTurn(): TurnRow | null {
    return this.db.select().from(turns).where(eq(turns.status, "running")).get() ?? null;
  }

  queuedTurns(): TurnRow[] {
    return this.db
      .select()
      .from(turns)
      .where(and(eq(turns.status, "queued"), eq(turns.steeringPending, 0)))
      .orderBy(asc(turns.queuePos))
      .all();
  }

  nextTurnSeq(): number {
    const row = this.db
      .select({ max: sql<number>`coalesce(max(${turns.seq}), 0)` })
      .from(turns)
      .get();
    return (row?.max ?? 0) + 1;
  }

  nextQueuePos(): number {
    const row = this.db
      .select({ max: sql<number>`coalesce(max(${turns.queuePos}), 0)` })
      .from(turns)
      .get();
    return (row?.max ?? 0) + 1;
  }

  // ---------- items ----------

  private bumpItemsRev(): number {
    const rev = this.ws().itemsRev + 1;
    this.updateWs({ itemsRev: rev });
    return rev;
  }

  itemToWire(r: ItemRow): Item {
    return {
      id: r.id,
      sessionId: r.sessionId,
      turnId: r.turnId,
      kind: r.kind,
      status: r.status,
      content: parseJson(r.contentJson, {}),
      rev: r.rev,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    } as Item;
  }

  itemRow(id: string): ItemRow | null {
    return this.db.select().from(items).where(eq(items.id, id)).get() ?? null;
  }

  /** Inserts an item and bumps items_rev in one transaction (02, Rules). Broadcasts item.upsert. */
  insertItem(input: {
    id?: string;
    sessionId: string;
    turnId: string | null;
    kind: ItemKind;
    status: ItemStatus;
    content: unknown;
    createdAt?: number;
  }): Item {
    const now = Date.now();
    const id = input.id ?? newId();
    const row = this.ctx.storage.transactionSync(() => {
      const rev = this.bumpItemsRev();
      const values = {
        id,
        sessionId: input.sessionId,
        turnId: input.turnId,
        kind: input.kind,
        status: input.status,
        contentJson: JSON.stringify(input.content),
        rev,
        createdAt: input.createdAt ?? now,
        updatedAt: now,
      };
      this.db.insert(items).values(values).onConflictDoNothing().run();
      return this.itemRow(id)!;
    });
    const item = this.itemToWire(row);
    this.broadcast({ type: "item.upsert", item, itemsRev: row.rev });
    return item;
  }

  updateItem(id: string, patch: { status?: ItemStatus; content?: unknown; turnId?: string }): Item | null {
    const row = this.ctx.storage.transactionSync(() => {
      const existing = this.itemRow(id);
      if (!existing) return null;
      const rev = this.bumpItemsRev();
      this.db
        .update(items)
        .set({
          ...(patch.status ? { status: patch.status } : {}),
          ...(patch.content !== undefined ? { contentJson: JSON.stringify(patch.content) } : {}),
          ...(patch.turnId !== undefined ? { turnId: patch.turnId } : {}),
          rev,
          updatedAt: Date.now(),
        })
        .where(eq(items.id, id))
        .run();
      return this.itemRow(id);
    });
    if (!row) return null;
    const item = this.itemToWire(row);
    this.broadcast({ type: "item.upsert", item, itemsRev: row.rev });
    return item;
  }

  /** Appends streamed text. Every change bumps items_rev; the delta goes to live sockets only. */
  appendItemText(id: string, text: string): void {
    const rev = this.ctx.storage.transactionSync(() => {
      const existing = this.itemRow(id);
      if (!existing) return null;
      const content = parseJson<{ text?: string }>(existing.contentJson, {});
      content.text = (content.text ?? "") + text;
      const rev = this.bumpItemsRev();
      this.db
        .update(items)
        .set({ contentJson: JSON.stringify(content), rev, updatedAt: Date.now() })
        .where(eq(items.id, id))
        .run();
      return rev;
    });
    if (rev !== null) this.broadcast({ type: "item.delta", itemId: id, append: { text }, itemsRev: rev });
  }

  /** Closes open items of a turn: completed for a normal end, cancelled otherwise (02, Status). */
  closeTurnItems(turnId: string, outcome: "completed" | "cancelled"): void {
    const open = this.db
      .select()
      .from(items)
      .where(and(eq(items.turnId, turnId), inArray(items.status, ["streaming", "pending", "in_progress"])))
      .all();
    for (const it of open) {
      const status =
        outcome === "completed" && it.status === "streaming"
          ? "completed"
          : outcome === "cancelled"
            ? "cancelled"
            : it.status;
      if (status !== it.status) this.updateItem(it.id, { status: status as ItemStatus });
    }
  }

  itemsSince(rev: number, limit: number, afterRev?: number): Item[] {
    return this.db
      .select()
      .from(items)
      .where(gt(items.rev, afterRev ?? rev))
      .orderBy(asc(items.rev))
      .limit(limit)
      .all()
      .map((r) => this.itemToWire(r));
  }

  /** A notice in the transcript of the given (or newest) session. */
  notice(
    level: "info" | "warning" | "error",
    text: string,
    sessionId?: string | null,
    turnId?: string | null,
  ): void {
    const sid =
      sessionId ??
      this.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(ne(sessions.status, "closed"))
        .orderBy(desc(sessions.updatedAt))
        .get()?.id;
    if (!sid) {
      log(level === "error" ? "error" : level === "warning" ? "warn" : "info", text, {
        workspaceId: this.wsOrNull()?.workspaceId,
      });
      return;
    }
    this.insertItem({
      sessionId: sid,
      turnId: turnId ?? null,
      kind: "notice",
      status: "completed",
      content: { level, text },
    });
  }

  // ---------- sockets ----------

  uiSockets(): WebSocket[] {
    return this.ctx.getWebSockets("ui");
  }

  broadcast(message: WorkspaceServerMessage): void {
    const sockets = this.uiSockets();
    if (sockets.length === 0) return;
    const text = JSON.stringify(message);
    for (const ws of sockets) this.sendTo(ws, text);
  }

  sendTo(ws: WebSocket, message: WorkspaceServerMessage | string): void {
    try {
      const buffered = (ws as unknown as { bufferedAmount?: number }).bufferedAmount ?? 0;
      if (buffered > MAX_BUFFERED) {
        ws.close(CloseCode.tooMuchBuffered, "too much buffered");
        return;
      }
      ws.send(typeof message === "string" ? message : JSON.stringify(message));
    } catch {
      // socket gone
    }
  }

  error(code: string, message: string): void {
    this.broadcast({ type: "error", code, message });
  }

  // ---------- activity ----------

  /** 03, Activity. Open UI sockets do not count. */
  isActive(terminalsOpen: number): boolean {
    if (this.runningTurn() || this.queuedTurns().length > 0) return true;
    if (
      this.db
        .select({ id: permissions.requestId })
        .from(permissions)
        .where(eq(permissions.status, "pending"))
        .get()
    )
      return true;
    if (terminalsOpen > 0) return true;
    if (Date.now() - this.lastPreviewAt < 5 * 60_000) return true;
    return this.hasRunningScripts();
  }

  hasRunningScripts(): boolean {
    const row = this.ctx.storage.sql
      .exec("SELECT 1 FROM script_runs WHERE status = 'running' AND kind IN ('setup','run') LIMIT 1")
      .toArray();
    return row.length > 0;
  }

  touchActivity(): void {
    this.setKv("lastBusyAt", Date.now());
  }
}
