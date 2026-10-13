import { lifecycleRedactor } from "../../roles/secrets.ts";
import { and, asc, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { Schema } from "effect";
import {
  LifecycleEvent,
  RoleRun,
  TempoError,
  newId,
  type AgentId,
  type FnInput,
  type FnOutput,
  type RoleTrigger,
} from "@tempo/protocol";
import {
  lifecycleEvents,
  roleRuns,
  turns,
  type LifecycleRow,
  type RoleRunRow,
} from "../../db/workspace-do.ts";
import { baseRoles, parseRole, withPrecedence, type ParsedRole } from "../../roles/catalog.ts";
import { matchTrigger } from "../../roles/match.ts";
import { errorText, log } from "../../log.ts";
import type { WorkspaceCore } from "./core.ts";
import { requireTempod } from "./container.ts";
import { RoleRuns } from "./role-runs.ts";

export class Lifecycle {
  readonly runs: RoleRuns;
  private roles: ParsedRole[] = [];
  private loading: Promise<void> | null = null;
  private dispatching: Promise<void> | null = null;
  private dirty = false;
  private loaded = false;
  retryAt: number | null = null;
  constructor(readonly core: WorkspaceCore) {
    this.runs = new RoleRuns(this);
  }

  async load(repo = false): Promise<void> {
    if (this.loading) await this.loading;
    this.loading = (async () => {
      const base = await baseRoles(this.core.env, this.core.ws().userId);
      let cached = this.core.kv<Array<{ name: string; text: string }>>("repoRoles") ?? [];
      if (repo) {
        const tempod = requireTempod(this.core);
        const { paths } = await tempod.request("fs.list", {});
        const next: typeof cached = [];
        for (const path of paths.filter((p) => /^\.tempo\/roles\/[^/]+\.md$/.test(p))) {
          let read: { content: string; encoding: string };
          try {
            read = await tempod.request("fs.read", { path, maxBytes: 65536 });
          } catch {
            read = { content: "", encoding: "utf8" };
          }
          next.push({
            name: path.slice(".tempo/roles/".length, -3),
            text: read.encoding === "utf8" ? read.content : "",
          });
        }
        cached = next;
        this.core.setKv("repoRoles", cached);
      }
      this.roles = withPrecedence([
        ...base,
        ...(await Promise.all(cached.map((r) => parseRole(r.name, "repo", r.text)))),
      ]);
      this.loaded = true;
    })();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }
  async list(): Promise<FnOutput<"listRoles">> {
    if (!this.loaded) await this.load();
    return this.roles.map((r) => r.info);
  }
  async text(name: string, scope: ParsedRole["info"]["scope"]): Promise<{ text: string }> {
    if (!this.loaded) await this.load();
    const r = this.roles.find((r) => r.info.name === name && r.info.scope === scope);
    if (!r) throw new TempoError("NOT_FOUND");
    return { text: r.text };
  }
  append(input: Omit<LifecycleEvent, "id" | "occurredAt" | "workspaceId">): LifecycleRow | null {
    const event = { ...input, id: newId(), occurredAt: Date.now(), workspaceId: this.core.workspaceId };
    let valid: LifecycleEvent;
    try {
      valid = Schema.decodeUnknownSync(LifecycleEvent, { onExcessProperty: "error" })(event);
    } catch {
      throw new TempoError("EVENT_INVALID");
    }
    const { payload, ...fields } = valid;
    return (
      this.core.db
        .insert(lifecycleEvents)
        .values({ ...fields, payloadJson: JSON.stringify(payload), dispatchedAt: null })
        .onConflictDoNothing()
        .returning()
        .all()[0] ?? null
    );
  }
  event(row: LifecycleRow): LifecycleEvent {
    const { seq: _seq, payloadJson, dispatchedAt: _at, ...fields } = row;
    return Schema.decodeUnknownSync(LifecycleEvent)({
      ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null)),
      workspaceId: this.core.workspaceId,
      payload: JSON.parse(payloadJson),
    });
  }
  logEvent(row: LifecycleRow) {
    return { seq: row.seq, event: this.event(row) };
  }
  row(id: string): LifecycleRow | null {
    return this.core.db.select().from(lifecycleEvents).where(eq(lifecycleEvents.id, id)).get() ?? null;
  }
  runWire(row: RoleRunRow): RoleRun {
    const { resultJson, ...rest } = row;
    return Schema.decodeUnknownSync(RoleRun)({
      ...rest,
      result: resultJson ? JSON.parse(resultJson) : null,
      trigger: this.core.kv<RoleTrigger>(`runTrigger:${row.id}`),
    });
  }
  listRuns(changeId?: string): RoleRun[] {
    return this.core.db
      .select()
      .from(roleRuns)
      .where(changeId ? eq(roleRuns.changeId, changeId) : undefined)
      .orderBy(desc(roleRuns.createdAt), desc(roleRuns.id))
      .limit(200)
      .all()
      .map((r) => this.runWire(r));
  }
  listEvents(input: Omit<FnInput<"listLifecycleEvents">, "workspaceId">): FnOutput<"listLifecycleEvents"> {
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 500)));
    if (
      !Number.isFinite(limit) ||
      (input.beforeSeq !== undefined && (!Number.isInteger(input.beforeSeq) || input.beforeSeq < 1))
    )
      throw new TempoError("VALIDATION_FAILED");
    const rows = this.core.db
      .select()
      .from(lifecycleEvents)
      .where(
        and(
          input.changeId ? eq(lifecycleEvents.changeId, input.changeId) : undefined,
          input.beforeSeq ? lt(lifecycleEvents.seq, input.beforeSeq) : undefined,
        ),
      )
      .orderBy(desc(lifecycleEvents.seq))
      .limit(limit + 1)
      .all();
    const page = rows.slice(0, limit);
    return {
      events: page.map((r) => this.logEvent(r)),
      nextBeforeSeq: rows.length > limit ? page.at(-1)!.seq : null,
    };
  }
  trace(id: string): FnOutput<"getTrace"> {
    let row = this.row(id);
    if (!row) throw new TempoError("NOT_FOUND");
    const chain: FnOutput<"getTrace">["chain"][number][] = [];
    const seen = new Set<string>();
    while (row && !seen.has(row.id)) {
      seen.add(row.id);
      chain.unshift(this.logEvent(row));
      row = row.causationId ? this.row(row.causationId) : null;
    }
    return {
      chain,
      children: this.core.db
        .select()
        .from(lifecycleEvents)
        .where(eq(lifecycleEvents.causationId, id))
        .orderBy(asc(lifecycleEvents.seq))
        .all()
        .map((r) => this.logEvent(r)),
      runs: this.core.db
        .select()
        .from(roleRuns)
        .where(eq(roleRuns.triggerEventId, id))
        .orderBy(asc(roleRuns.createdAt))
        .all()
        .map((r) => this.runWire(r)),
    };
  }
  createPromptChange(turnId: string, sessionId: string, agent: AgentId): string {
    const changeId = newId();
    this.core.db.update(turns).set({ changeId, origin: "user" }).where(eq(turns.id, turnId)).run();
    this.append({
      type: "tempo.change.created",
      source: "tempo",
      changeId,
      turnId,
      sessionId,
      agent,
      dedupeKey: `change:${changeId}:created`,
      payload: { origin: "prompt" },
    });
    return changeId;
  }
  recordCause(input: Omit<LifecycleEvent, "id" | "occurredAt" | "workspaceId">): void {
    if (
      this.core.db.select().from(lifecycleEvents).where(eq(lifecycleEvents.dedupeKey, input.dedupeKey)).get()
    )
      return;
    const probe = {
      ...input,
      id: newId(),
      occurredAt: Date.now(),
      workspaceId: this.core.workspaceId,
    } as LifecycleEvent;
    let changeId = input.changeId;
    let causationId: string | undefined;
    if (
      !changeId &&
      this.core.settings().roles.enabled &&
      this.roles.some(
        (r) => r.file && !r.info.shadowedBy && !r.info.error && r.file.on.some((t) => matchTrigger(t, probe)),
      )
    ) {
      changeId = newId();
      const origin = this.append({
        type: "tempo.change.created",
        source: "tempo",
        changeId,
        dedupeKey: `change:${changeId}:created`,
        payload: { origin: "event" },
      });
      causationId = origin!.id;
    }
    this.append({ ...input, changeId, ...(causationId ? { causationId } : {}) });
  }
  newestOpenChange(): string | undefined {
    return this.core.ctx.storage.sql
      .exec<{ change_id: string }>(
        "SELECT change_id FROM lifecycle_events e WHERE e.type = 'tempo.change.created' AND NOT EXISTS (SELECT 1 FROM lifecycle_events ended WHERE ended.change_id = e.change_id AND ended.type = 'tempo.change.ended') ORDER BY e.seq DESC LIMIT 1",
      )
      .toArray()[0]?.change_id;
  }
  origin(changeId: string): LifecycleRow | null {
    return (
      this.core.db
        .select()
        .from(lifecycleEvents)
        .where(and(eq(lifecycleEvents.changeId, changeId), eq(lifecycleEvents.type, "tempo.change.created")))
        .get() ?? null
    );
  }
  async request(roleName: string, text?: string, sessionId?: string): Promise<FnOutput<"requestRole">> {
    if (["archived", "archiving"].includes(this.core.state)) throw new TempoError("WORKSPACE_ARCHIVED");
    if (new TextEncoder().encode(text ?? "").length > 65536) throw new TempoError("VALIDATION_FAILED");
    await this.load();
    const role = this.roles.find((r) => r.info.name === roleName && !r.info.shadowedBy && !r.info.error);
    if (!role) throw new TempoError("ROLE_NOT_FOUND");
    if (!role.file?.requestable) throw new TempoError("ROLE_NOT_REQUESTABLE");
    if (!this.core.settings().roles.enabled) throw new TempoError("ROLE_LIMIT", undefined, "roles.enabled");
    if (text) text = (await lifecycleRedactor(this.core))(text);
    const agent = sessionId ? (this.core.sessionRow(sessionId).agent as AgentId) : undefined;
    const changeId = newId();
    const run = this.core.ctx.storage.transactionSync(() => {
      const cause = this.append({
        type: "tempo.change.created",
        source: "tempo",
        changeId,
        ...(sessionId ? { sessionId, agent } : {}),
        dedupeKey: `change:${changeId}:created`,
        payload: { origin: "request", role: roleName, ...(text ? { text } : {}) },
      })!;
      return this.runs.insert(role, this.event(cause));
    });
    this.kick();
    return { changeId, roleRunId: run.id };
  }
  kick(): void {
    this.dirty = true;
    if (this.dispatching || !this.core.wsOrNull()) return;
    this.dispatching = this.dispatch()
      .catch((e) => {
        this.dirty = false;
        this.retryAt = Date.now() + 1000;
        log("warn", "lifecycle dispatch failed", { workspaceId: this.core.workspaceId, error: errorText(e) });
        this.core.scheduleAlarm();
      })
      .finally(() => {
        this.dispatching = null;
        if (this.dirty) this.kick();
      });
    this.core.ctx.waitUntil(this.dispatching);
  }
  async drain(): Promise<void> {
    this.kick();
    await this.dispatching;
  }
  private async dispatch(): Promise<void> {
    if (!this.loaded) await this.load();
    this.retryAt = null;
    do {
      this.dirty = false;
      let row: LifecycleRow | undefined;
      while (
        (row = this.core.db
          .select()
          .from(lifecycleEvents)
          .where(isNull(lifecycleEvents.dispatchedAt))
          .orderBy(asc(lifecycleEvents.seq))
          .get())
      ) {
        const event = this.event(row);
        this.core.ctx.storage.transactionSync(() => {
          if (
            this.core.settings().roles.enabled &&
            event.changeId &&
            !(event.type === "role.run.failed" && event.payload.errorCode === "ROLE_LIMIT")
          ) {
            for (const role of this.roles) {
              if (!role.file || role.info.error || role.info.shadowedBy) continue;
              const trigger = role.file.on.find((t) => matchTrigger(t, event));
              if (trigger) this.runs.insert(role, event, trigger);
            }
          }
          this.core.db
            .update(lifecycleEvents)
            .set({ dispatchedAt: Date.now() })
            .where(eq(lifecycleEvents.seq, row!.seq))
            .run();
          if (event.changeId) this.checkEnd(event.changeId);
        });
      }
      await this.runs.recover();
      await this.runs.admit();
    } while (this.dirty);
  }
  checkEnd(changeId: string): void {
    if (this.core.turnEndInProgress) return;
    const pendingEvent = this.core.db
      .select()
      .from(lifecycleEvents)
      .where(and(eq(lifecycleEvents.changeId, changeId), isNull(lifecycleEvents.dispatchedAt)))
      .get();
    const pendingTurn = this.core.db
      .select()
      .from(turns)
      .where(and(eq(turns.changeId, changeId), inArray(turns.status, ["queued", "running"])))
      .get();
    const pendingRun = this.core.db
      .select()
      .from(roleRuns)
      .where(and(eq(roleRuns.changeId, changeId), inArray(roleRuns.status, ["queued", "running"])))
      .get();
    if (pendingEvent || pendingTurn || pendingRun) return;
    const last = this.core.db
      .select()
      .from(lifecycleEvents)
      .where(eq(lifecycleEvents.changeId, changeId))
      .orderBy(desc(lifecycleEvents.seq))
      .get();
    if (!last || last.type === "tempo.change.ended") return;
    const run = this.core.db
      .select()
      .from(roleRuns)
      .where(eq(roleRuns.changeId, changeId))
      .orderBy(desc(roleRuns.createdAt), desc(roleRuns.id))
      .get();
    this.append({
      type: "tempo.change.ended",
      source: "tempo",
      changeId,
      causationId: last.id,
      dedupeKey: `change:${changeId}:ended`,
      payload: {
        status:
          run?.status === "cancelled"
            ? "cancelled"
            : run && ["failed", "timed_out"].includes(run.status)
              ? "failed"
              : "done",
      },
    });
    this.dirty = true;
  }
}
