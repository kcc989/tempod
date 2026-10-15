import { pendingIntent } from "./intent.ts";
import { listChecklist } from "./proof.ts";
import { proposalRecords } from "../../agents/proposals.ts";
import type { CiCoordinator } from "../../ci/types.ts";
import type { DeployCoordinator } from "../../deploy/types.ts";
import { Lifecycle } from "./lifecycle.ts";
import type { OpResult } from "./runner.ts";
import { and, asc, desc, eq, gt, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import {
  DEFAULT_SETTINGS,
  AcpFields,
  secretPlaceholder,
  type EnvironmentSummary,
  type PendingEnvironmentProposal,
  TempoError,
  type JsonData,
  type Attention,
  type ChangesSummary,
  Item,
  type ItemKind,
  type ItemStatus,
  type Session,
  type Settings,
  type SettingsLayer,
  type SettingsSource,
  type Turn,
  type TurnUsage,
  type WorkspaceDetail,
  type WorkspaceServerMessage,
  type WorkspaceState,
  type WorkspaceSummary,
  CloseCode,
  newId,
  TEMPO_ARTIFACTS_DIR,
} from "@tempo/protocol";
import { resolveSettings } from "@tempo/settings";
import { Match, Schema, Option } from "effect";
import {
  dotfiles,
  environments,
  mcpServers,
  projects,
  workspaces,
  type DotfilesRow,
  type McpServerRow,
} from "../../db/d1.ts";
import { EMPTY_PROMPT, json, readItemContent, itemContentDecoder, type ItemContent } from "../../db/json.ts";
import { parseEnvironment, type EnvironmentConfig } from "../../lib/environments.ts";
import {
  egressLog,
  environmentProposals,
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
import { errorText, log } from "../../log.ts";
import type { TempodClient } from "./tempod-client.ts";
import { markConversationDirty } from "./conversations.ts";
import { assertTransition } from "./transitions.ts";
import { WorkspaceFiles } from "./files.ts";

export type DB = DrizzleSqliteDODatabase<typeof workspaceSchema>;

export interface ProjectInfo {
  readonly id: string;
  readonly installationId: number | null;
  readonly repoId: number | null;
  readonly provider: "github" | "artifacts";
  readonly artifactRepoId: string | null;
  readonly cloneUrl: string | null;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly overrides: SettingsLayer;
  readonly environmentId: string | null;
}

export interface Author {
  readonly name: string;
  readonly email: string;
}

const MAX_BUFFERED = 4 * 1024 * 1024;

export const parseJson =
  <T>(schema: Schema.ConstraintDecoder<T>) =>
  (text: string | null | undefined, fallback: T): T =>
    text
      ? Option.getOrElse(Schema.decodeUnknownOption(Schema.fromJsonString(schema))(text), () => fallback)
      : fallback;

const withUsage = (text: string | null): { usage?: TurnUsage } => {
  const usage = json.turnUsage.read(text, null);

  return usage ? { usage } : {};
};

/** Everything the WorkspaceDO modules share: storage, in-memory state, and helpers. */
export class WorkspaceCore {
  readonly files = new WorkspaceFiles(this);
  readonly db: DB;
  readonly lifecycle: Lifecycle;
  tempod: TempodClient | null = null;
  conversationUpload: Promise<void> | null = null;
  pendingCodexAuth: { content: string; lastRefresh: number } | null = null;
  pendingCodexPush: { content: string; version: number } | null = null;
  credentialsBusy = false;
  /** The connect in flight, shared by every caller (container.ts, connectTempod). */
  tempodConnecting: Promise<TempodClient> | null = null;
  /** Sessions with a live adapter process in the current container. */
  readonly liveSessions = new Set<string>();
  readonly sessionClosures = new Map<string, Promise<void>>();
  ghToken: { token: string; expiresAt: number } | null = null;
  lastPreviewAt = 0;
  lastHomeBackupAt = 0;
  tempodVersion: string | null = null;
  private projectCache: { info: ProjectInfo; at: number } | null = null;
  readonly opWaiters = new Map<
    string,
    Array<{ resolve: (v: OpResult) => void; reject: (cause: unknown) => void }>
  >();
  /** Set by index.ts: runs the queue runner after any change to state, turns, sessions or setup. */
  kickQueue: () => void = () => undefined;
  /** Set by index.ts: re-arms the single alarm. */
  scheduleAlarm: () => void = () => undefined;
  closingTempod = false;
  queueBusy = false;
  /** The queue runner's work in flight (a turn start or a steer), while queueBusy is set. */
  queueWork: Promise<void> | null = null;
  /** Aborts the turn start in flight before its prompt is sent (archive, 03 turns.cancel). */
  turnStartAbort: AbortController | null = null;
  startingTurnId: string | null = null;
  tempodStopping = false;
  turnEndInProgress = false;
  reconnectAttempt = 0;
  /** Scales in-process waits (health polls, tempod reconnect, uploads); tests shorten them per workspace. */
  retryDelayScale = 1;
  reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Open terminal sockets and their PTY exec processes (01, Terminal). */
  readonly terminals = new Map<WebSocket, { readonly terminalId: string; proc: ExecProcess | null }>();
  /** Open preview WebSocket relays: the browser side and the tempod side. */
  readonly previewSockets = new Set<WebSocket>();
  private detailTimer: ReturnType<typeof setTimeout> | null = null;
  closePreviews(code: number, reason: string): void {
    for (const ws of this.previewSockets) {
      try {
        ws.close(code, reason);
      } catch {
        // already closed
      }
    }

    this.previewSockets.clear();
  }
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
  /** The Browser Run binding (01, Browser Run). A field, so tests can put a fake in its place. */
  browser:
    | (Pick<BrowserRun, "acquire" | "getSession" | "connectSession" | "closeSession" | "getLiveView"> & {
        readonly devtools: Pick<BrowserRun["devtools"], "listTargets">;
      })
    | undefined;
  /** The project's CI coordinator, for a CI runner's result (10); tests replace it. */
  ciCoordinator = (projectId: string): CiCoordinator => this.env.REPOSITORY_CI.getByName(projectId);
  /** The project's deploy coordinator, for a deploy runner's result (12); tests replace it. */
  deployCoordinator = (projectId: string): DeployCoordinator => this.env.APP_DEPLOY.getByName(projectId);
  /** BrowserOutbound for this workspace: Browser Run's route to `localhost`. */
  browserOutbound: () => Fetcher = () =>
    this.ctx.exports.BrowserOutbound({ props: { workspaceId: this.workspaceId } });
  /** The Browser Run acquire in flight, shared by concurrent CDP connections. */
  browserAcquire: Promise<string | null> | null = null;
  constructor(
    readonly ctx: DurableObjectState,
    readonly env: Env,
  ) {
    this.db = drizzle(ctx.storage, { schema: workspaceSchema });
    this.container = ctx.container;
    this.lifecycle = new Lifecycle(this);
    this.browser = env.BROWSER;
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
    const row = this.wsOrNull();

    if (row) return row.workspaceId;
    const userId = this.kv<string>("catalogUserId");

    if (userId && this.ctx.id.name === `models:${userId}`) return this.ctx.id.name;

    if (this.ciUserId() && /^(ci|deploy):/.test(this.ctx.id.name ?? "")) return this.ctx.id.name!;
    throw new TempoError("NOT_FOUND");
  }
  /** The owner of the CI job (10) or deployment (12) this runner instance runs, if any. */
  ciUserId(): string | undefined {
    if (this.ctx.id.name?.startsWith("ci:")) return this.kv<{ userId: string }>("ciJob")?.userId;

    if (this.ctx.id.name?.startsWith("deploy:")) return this.kv<{ userId: string }>("deployJob")?.userId;

    return undefined;
  }
  updateWs(patch: Partial<typeof workspace.$inferInsert>): void {
    this.db.update(workspace).set(patch).where(eq(workspace.id, 1)).run();
  }
  get state(): WorkspaceState {
    return this.ws().state;
  }
  /** Moves the state machine (03). Throws on any transition not in the table. */
  setState(next: WorkspaceState, error?: { code: string; detail?: string | null }): void {
    const row = this.ws();
    const from = row.state;
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
    const stored = json.settings.read(this.ws().settingsJson, null);

    if (stored) return stored;
    const overrides = this.projectCache?.info.overrides ?? {};

    return resolveSettings(overrides, {}).effective ?? DEFAULT_SETTINGS;
  }
  kv<T>(key: string): T | undefined {
    return this.ctx.storage.kv.get<T>(key);
  }
  setKv(key: string, value: JsonData): void {
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

    const info: ProjectInfo = {
      id: row.id,
      installationId: row.installationId,
      repoId: row.repoId,
      provider: row.provider,
      artifactRepoId: row.artifactRepoId,
      cloneUrl: row.cloneUrl,
      owner: row.repoOwner,
      name: row.repoName,
      defaultBranch: row.defaultBranch,
      overrides: json.projectSettings.read(row.settingsJson, {}),
      environmentId: row.environmentId,
    };

    this.projectCache = { info, at: Date.now() };

    return info;
  }
  author(): Author {
    return this.kv<Author>("author") ?? { name: "Tempo", email: "tempo@users.noreply.github.com" };
  }
  /** The owner's enabled MCP servers (01, User MCP servers), read from D1 each time. */
  async mcpServers(): Promise<McpServerRow[]> {
    return drizzleD1(this.env.DB)
      .select()
      .from(mcpServers)
      .where(and(eq(mcpServers.userId, this.ws().userId), eq(mcpServers.enabled, 1)))
      .orderBy(asc(mcpServers.name))
      .all();
  }
  /** The owner's shell files row (01, Shell and dotfiles), read from D1 by the workspace's owner. */
  async dotfiles(): Promise<DotfilesRow | null> {
    return (
      (await drizzleD1(this.env.DB)
        .select()
        .from(dotfiles)
        .where(eq(dotfiles.userId, this.ws().userId))
        .get()) ?? null
    );
  }
  credentials() {
    const userId = this.wsOrNull()?.userId ?? this.kv<string>("catalogUserId") ?? this.ciUserId();

    if (!userId) throw new TempoError("NOT_FOUND");

    return this.env.CREDENTIALS.getByName(userId);
  }
  /** The workspace override, else the project's environment, else none (01, Environments). */
  async environment(fresh = false): Promise<EnvironmentConfig | null> {
    const project = await this.project(fresh);
    const row = this.ws();

    for (const id of [row.environmentId, project.environmentId]) {
      if (!id) continue;

      const env = await drizzleD1(this.env.DB)
        .select()
        .from(environments)
        .where(and(eq(environments.id, id), eq(environments.userId, row.userId)))
        .get();

      if (env) return parseEnvironment(env);
    }

    return null;
  }
  /** Environment secrets for the container: placeholders when bound to hosts, else values (01). */
  private async environmentEnv(env: EnvironmentConfig | null): Promise<Record<string, string>> {
    if (!env || env.secrets.length === 0) return {};
    const values = await this.credentials().listEnvironmentSecrets(env.id);
    const out: Record<string, string> = {};

    for (const s of env.secrets) {
      if (s.hosts.length > 0) out[s.name] = secretPlaceholder(s.name);
      else if (values[s.name] !== undefined) out[s.name] = values[s.name]!;
    }

    return out;
  }
  /** What the agent may see (01, Environments): no secret values. */
  async environmentSummary(): Promise<EnvironmentSummary> {
    const env = await this.environment();
    const settings = this.settings().environment;

    const set = env
      ? new Set(await this.credentials().listEnvironmentSecretNames(env.id))
      : new Set<string>();

    return {
      name: env?.name ?? null,
      egressPolicy: env?.egressPolicy ?? settings.egress_policy,
      egressAllowlist: [...(env?.egressAllowlist ?? settings.egress_allowlist)],
      secrets: (env?.secrets ?? []).map((s) => ({ name: s.name, hosts: [...s.hosts], set: set.has(s.name) })),
      injectors: (env?.injectors ?? []).map((i) => ({ name: i.name, hosts: [...i.hosts] })),
      blockedHosts: this.blockedHosts(),
    };
  }
  /** Distinct hosts blocked by rule 7 or 10 in the last 24 h, newest first, at most 50 (02). */
  blockedHosts(): string[] {
    const rows = this.db
      .select({ host: egressLog.host })
      .from(egressLog)
      .where(and(inArray(egressLog.rule, [7, 10]), gt(egressLog.ts, Date.now() - 24 * 3600_000)))
      .orderBy(desc(egressLog.id))
      .limit(2000)
      .all();

    return [...new Set(rows.map((r) => r.host))].slice(0, 50);
  }
  pendingProposals(): PendingEnvironmentProposal[] {
    return this.db
      .select()
      .from(environmentProposals)
      .where(eq(environmentProposals.status, "pending"))
      .orderBy(asc(environmentProposals.createdAt), asc(environmentProposals.id))
      .all()
      .flatMap((r) => {
        const proposal = json.environmentProposal.read(r.proposalJson, null);

        return proposal ? [{ id: r.id, createdAt: r.createdAt, proposal }] : [];
      });
  }
  /** Script env (01, Scripts): TEMPO_* vars plus the project's env vars and secrets. */
  async scriptEnv(): Promise<Record<string, string>> {
    const row = this.ws();
    const settings = this.settings();
    const envSecrets = await this.environmentEnv(await this.environment());
    const secrets = await this.credentials().listProjectEnv(row.projectId);

    const base = {
      TEMPO_WORKSPACE_ID: row.workspaceId,
      TEMPO_WORKSPACE_NAME: row.slug,
      TEMPO_WORKSPACE_PATH: "/workspace",
      TEMPO_DEFAULT_BRANCH: row.baseBranch,
      TEMPO_PORT: "3000",
      TEMPO_ARTIFACTS_DIR,
    };

    return { ...settings.environment_variables, ...envSecrets, ...secrets, ...base };
  }
  // ---------- attention, summary, detail ----------
  computeAttention(): Attention {
    const row = this.ws();

    const pending = this.db
      .select({ id: permissions.requestId })
      .from(permissions)
      .where(eq(permissions.status, "pending"))
      .get();

    if (pending || pendingIntent(this)) return "needs_input";

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
      state: row.state,
      attention: row.attention,
      defaultAgent: row.defaultAgent,
      prNumber: row.prNumber,
      prState: row.prState,
      checksState: row.checksState,
      pinned: row.pinned === 1,
      lastActivityAt: row.lastActivityAt,
      createdAt: row.createdAt,
      archivedAt: row.archivedAt,
      rev: row.summaryRev,
    };
  }
  previewUrl(port: number, row: WorkspaceRowDO = this.ws()): string {
    return `https://${port}-${row.workspaceId}.${this.env.PREVIEW_DOMAIN}`;
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
      setupStatus: row.setupStatus,
      pushed: row.pushed === 1,
      prTitle: row.prNumber === null ? null : (this.kv<string>("prTitle") ?? null),
      ports: this.db
        .select()
        .from(ports)
        .orderBy(asc(ports.port))
        .all()
        .map((p) => ({ port: p.port, url: this.previewUrl(p.port, row) })),
      browserActive: row.browserSessionId !== null,
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
      environmentId: row.environmentId,
      environmentProposals: this.pendingProposals(),
      agentProposals: proposalRecords(this),
      checklist: listChecklist(this),
    };
  }
  /**
   * Writes the D1 summary row with a monotonic `summary_rev`, publishes to UserHubDO, and
   * sends the detail to every UI socket (02, Write rules). The hub gets the summary even when
   * the D1 write fails: the DO stays the source of truth and the next publish repairs D1.
   */
  publish(): void {
    const row = this.ws();
    const rev = row.summaryRev + 1;
    this.updateWs({ summaryRev: rev });
    const fresh = this.ws();
    const summary = this.summary(fresh);

    const writeD1 = async () => {
      await drizzleD1(this.env.DB)
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
        .run();
    };

    const done = writeD1()
      .catch((e) => log("warn", "summary D1 write failed", { workspaceId: summary.id, error: errorText(e) }))
      .then(() => this.env.USER_HUB.getByName(fresh.userId).publish(summary))
      .catch((e) => log("warn", "summary publish failed", { workspaceId: summary.id, error: errorText(e) }));

    this.ctx.waitUntil(done);
    this.broadcast({ type: "workspace", workspace: this.detail() });
  }
  // ---------- sessions and turns ----------
  sessionRow(id: string): SessionRow {
    const row = this.db.select().from(sessions).where(eq(sessions.id, id)).get();

    if (!row) throw new TempoError("NOT_FOUND", undefined, "session not found");

    return row;
  }
  sessionToWire(r: SessionRow): Session {
    const wire = {
      id: r.id,
      agent: r.agent,
      title: r.title,
      status: r.status,
      modeId: r.modeId,
      modes: json.modes.read(r.modesJson, []),
      configOptions: json.configOptions.read(r.configOptionsJson, []),
      config: json.config.read(r.configJson, {}),
      commands: json.commands.read(r.commandsJson, []),
      usage: json.usage.read(r.usageJson, {}),
      sortOrder: r.sortOrder,
      steering: json.capabilities.read(r.capabilitiesJson, {})["steering"] === true,
    } satisfies Session;

    const session = r.runId ? { ...wire, runId: r.runId } : wire;

    if (!r.agentId) return session;

    const saved: Session = {
      ...session,
      agentId: r.agentId,
      agentName: r.agentName ?? "",
      agentSha: r.agentSha ?? "",
      profileIssues: [...json.profileIssues.read(r.profileIssuesJson, [])],
    };

    if (r.agentVersion !== null) return { ...saved, agentVersion: r.agentVersion };

    return saved;
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
      status: r.status,
      queuePos: r.queuePos,
      steeringPending: r.steeringPending === 1,
      prompt: json.prompt.read(r.promptJson, EMPTY_PROMPT),
      stopReason: r.stopReason,
      errorCode: r.errorCode,
      checkpointId: r.checkpointId,
      reverted: r.reverted === 1,
      queuedAt: r.queuedAt,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      ...withUsage(r.usageJson),
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
  itemToWire(r: ItemRow, content: ItemContent = readItemContent(r.kind, r.contentJson)): Item {
    return Schema.decodeUnknownSync(Item)({
      id: r.id,
      sessionId: r.sessionId,
      turnId: r.turnId,
      kind: r.kind,
      status: r.status,
      content,
      rev: r.rev,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    });
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
    const content = itemContentDecoder(input.kind)(input.content);
    const contentJson = JSON.stringify(content);

    const row = this.ctx.storage.transactionSync(() => {
      const rev = this.bumpItemsRev();

      const values = {
        id,
        sessionId: input.sessionId,
        turnId: input.turnId,
        kind: input.kind,
        status: input.status,
        contentJson,
        rev,
        createdAt: input.createdAt ?? now,
        updatedAt: now,
      };

      this.db.insert(items).values(values).onConflictDoNothing().run();

      return this.itemRow(id)!;
    });

    const item = row.contentJson === contentJson ? this.itemToWire(row, content) : this.itemToWire(row);
    this.broadcast({ type: "item.upsert", item, itemsRev: row.rev });

    return item;
  }
  updateItem(id: string, patch: { status?: ItemStatus; content?: unknown; turnId?: string }): Item | null {
    const result = this.ctx.storage.transactionSync(() => {
      const existing = this.itemRow(id);

      if (!existing) return null;
      const content = patch.content !== undefined ? itemContentDecoder(existing.kind)(patch.content) : null;
      const rev = this.bumpItemsRev();
      const changes: Partial<ItemRow> = {};

      if (patch.status) changes.status = patch.status;

      if (content) changes.contentJson = JSON.stringify(content);

      if (patch.turnId !== undefined) changes.turnId = patch.turnId;
      changes.rev = rev;
      changes.updatedAt = Date.now();
      this.db.update(items).set(changes).where(eq(items.id, id)).run();

      return { row: this.itemRow(id)!, content };
    });

    if (!result) return null;
    const item = result.content ? this.itemToWire(result.row, result.content) : this.itemToWire(result.row);
    this.broadcast({ type: "item.upsert", item, itemsRev: result.row.rev });

    return item;
  }
  /**
   * Appends streamed text. Every change bumps items_rev; the delta goes to live sockets only.
   * Appending to a string keeps valid content valid, so only content without a string `text` is re-validated.
   */
  appendItemText(id: string, text: string): void {
    const rev = this.ctx.storage.transactionSync(() => {
      const existing = this.itemRow(id);

      if (!existing) return null;
      const raw = Schema.decodeUnknownOption(Schema.fromJsonString(AcpFields))(existing.contentJson);

      const content =
        Option.isSome(raw) && Schema.is(Schema.String)(raw.value["text"])
          ? raw.value
          : readItemContent(existing.kind, existing.contentJson);

      const currentText = "text" in content ? content.text : "";
      const appended = { ...content, text: String(currentText ?? "") + text };
      const rev = this.bumpItemsRev();
      this.db
        .update(items)
        .set({ contentJson: JSON.stringify(appended), rev, updatedAt: Date.now() })
        .where(eq(items.id, id))
        .run();

      return rev;
    });

    if (rev !== null) this.broadcast({ type: "item.delta", itemId: id, append: { text }, itemsRev: rev });
  }
  /**
   * Deletes a turn and its items in one transaction (02, Rules: items_rev goes up when items go),
   * runs `alsoInTransaction`, then broadcasts turn.deleted.
   */
  deleteTurn(turnId: string, alsoInTransaction?: () => void): void {
    this.ctx.storage.transactionSync(() => {
      const removed = this.db.delete(items).where(eq(items.turnId, turnId)).returning({ id: items.id }).all();

      if (removed.length > 0) this.bumpItemsRev();
      this.db.delete(turns).where(eq(turns.id, turnId)).run();
      alsoInTransaction?.();
    });
    this.broadcast({ type: "turn.deleted", turnId });
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

      if (status !== it.status) this.updateItem(it.id, { status: status });
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
      log(
        Match.value(level).pipe(
          Match.when("error", () => "error" as const),
          Match.when("warning", () => "warn" as const),
          Match.orElse(() => "info" as const),
        ),
        text,
        {
          workspaceId: this.wsOrNull()?.workspaceId,
        },
      );

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
    if (["workspace", "session", "turn", "turn.deleted", "item.upsert", "item.delta"].includes(message.type))
      markConversationDirty(this);

    if (message.type === "turn" && !["queued", "running"].includes(message.turn.status)) {
      this.setKv("conversationDueAt", Date.now());
      this.scheduleAlarm();
    }

    const sockets = this.uiSockets();

    if (sockets.length === 0) return;
    const text = JSON.stringify(message);

    for (const ws of sockets) this.sendTo(ws, text);
  }
  sendTo(ws: WebSocket, message: WorkspaceServerMessage | string): void {
    try {
      const buffered = ws.bufferedAmount ?? 0;

      if (buffered > MAX_BUFFERED) {
        ws.close(CloseCode.tooMuchBuffered, "too much buffered");

        return;
      }

      ws.send(Schema.is(Schema.String)(message) ? message : JSON.stringify(message));
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
    if (this.lifecycle.runs.hasActive()) return true;

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
