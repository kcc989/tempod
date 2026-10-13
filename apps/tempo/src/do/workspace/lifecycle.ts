import { decisionState, decideHooks, type HookDecision, type MatchedHook } from "../../agents/decisions.ts";
import { lifecycleRedactor } from "../../roles/secrets.ts";
import { and, asc, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { Schema } from "effect";
import {
  LifecycleEvent,
  Run,
  TempoError,
  newId,
  type AgentId,
  type FnInput,
  type FnOutput,
  type AttachmentHook,
  type Agent,
  type AgentAttachment,
} from "@tempo/protocol";
import { lifecycleEvents, runs, turns, type LifecycleRow, type RunRow } from "../../db/workspace-do.ts";
import { agentToWire, attachmentToWire } from "../../agents/library.ts";
import { agents, projectAgents } from "../../db/d1.ts";
import { d1 } from "../../server/handlers/common.ts";

import { errorText, log } from "../../log.ts";
import type { WorkspaceCore } from "./core.ts";

import { Runs } from "./runs.ts";

export class Lifecycle {
  readonly runs: Runs;
  agents: Agent[] = [];
  attachments: AgentAttachment[] = [];
  private loading: Promise<void> | null = null;
  private dispatching: Promise<void> | null = null;
  private dirty = false;
  private loaded = false;
  retryAt: number | null = null;
  constructor(readonly core: WorkspaceCore) {
    this.runs = new Runs(this);
  }

  async load(_repo = false): Promise<void> {
    if (this.loading) await this.loading;
    this.loading = (async () => {
      const ws = this.core.ws();
      const db = d1(this.core.env);

      const [definitions, rows] = await db.batch([
        db
          .select()
          .from(agents)
          .where(and(eq(agents.userId, ws.userId), isNull(agents.deletedAt))),
        db.select().from(projectAgents).where(eq(projectAgents.projectId, ws.projectId)),
      ]);

      this.agents = definitions.map(agentToWire);
      const byId = new Map(definitions.map((agent) => [agent.id, agent]));
      this.attachments = await Promise.all(
        rows.map((row) => attachmentToWire(this.core.env, row, byId.get(row.agentId) ?? null)),
      );
      this.loaded = true;
    })();

    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }
  async list(): Promise<FnOutput<"listRoles">> {
    return [];
  }
  async text(_name: string, _scope: string): Promise<{ text: string }> {
    throw new TempoError("NOT_FOUND");
  }
  matches(
    attachment: AgentAttachment,
    event: LifecycleEvent,
  ): Array<{ hook: AttachmentHook; index: number }> {
    if (!attachment.enabled || !attachment.agent) return [];

    const type =
      event.type === "tempo.change.created" && event.payload.origin === "prompt"
        ? "prompt"
        : event.type === "agent.turn.ended"
          ? "turn.ended"
          : event.type.replace(/^tempo\./, "");

    if (type === "turn.ended" && event.runId) return [];

    if (
      (type === "run.completed" || type === "run.failed") &&
      event.runId &&
      this.runs.row(event.runId).attachmentId === attachment.id
    )
      return [];

    if (event.type === "run.failed" && event.payload.errorCode === "RUN_LIMIT") return [];

    return attachment.hooks.flatMap((hook, index) => (hook.event === type ? [{ hook, index }] : []));
  }
  private validated(input: Omit<LifecycleEvent, "id" | "occurredAt" | "workspaceId">): LifecycleEvent {
    try {
      return Schema.decodeUnknownSync(LifecycleEvent, { onExcessProperty: "error" })({
        ...input,
        id: newId(),
        occurredAt: Date.now(),
        workspaceId: this.core.workspaceId,
      });
    } catch {
      throw new TempoError("EVENT_INVALID");
    }
  }
  append(input: Omit<LifecycleEvent, "id" | "occurredAt" | "workspaceId">): LifecycleRow | null {
    const valid = this.validated(input);

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
  runWire(row: RunRow): Run {
    const { resultJson, followUpSent, ...rest } = row;
    const definition = this.runs.snapshot(row);
    const session = row.sessionId ? this.core.sessionRow(row.sessionId) : null;

    return Schema.decodeUnknownSync(Run)({
      ...rest,
      name: definition.name,
      followUpSent: !!followUpSent,
      result: resultJson ? JSON.parse(resultJson) : null,
      hook: this.core.kv<AttachmentHook>(`runHook:${row.id}`),
      profileIssues: session ? JSON.parse(session.profileIssuesJson) : [],
    });
  }
  listRuns(changeId?: string): Run[] {
    return this.core.db
      .select()
      .from(runs)
      .where(changeId ? eq(runs.changeId, changeId) : undefined)
      .orderBy(desc(runs.createdAt), desc(runs.id))
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
        .from(runs)
        .where(eq(runs.triggerEventId, id))
        .orderBy(asc(runs.createdAt))
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

    const probe = this.validated(input);

    let changeId = input.changeId;
    let causationId: string | undefined;

    if (!changeId && this.attachments.some((attachment) => this.matches(attachment, probe).length)) {
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

    const next = { ...input, changeId };
    this.append(causationId ? { ...next, causationId } : next);
  }
  newestOpenChange(): string | undefined {
    return this.core.ctx.storage.sql
      .exec<{ change_id: string }>(
        "SELECT change_id FROM lifecycle_events e WHERE e.type = 'tempo.change.created' AND (NOT EXISTS (SELECT 1 FROM lifecycle_events ended WHERE ended.change_id = e.change_id AND ended.type = 'tempo.change.ended') OR EXISTS (SELECT 1 FROM turns t WHERE t.change_id=e.change_id AND t.status IN ('queued','running')) OR EXISTS (SELECT 1 FROM runs r WHERE r.change_id=e.change_id AND r.status IN ('queued','running'))) ORDER BY e.seq DESC LIMIT 1",
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
  async request(agentId: string, text?: string, sessionId?: string): Promise<FnOutput<"requestAgent">> {
    if (["archived", "archiving"].includes(this.core.state)) throw new TempoError("WORKSPACE_ARCHIVED");

    if (new TextEncoder().encode(text ?? "").length > 65536) throw new TempoError("VALIDATION_FAILED");
    await this.load();
    const agent = this.agents.find((a) => a.id === agentId);

    if (!agent) throw new TempoError("NOT_FOUND");
    const attachment = this.attachments.find((a) => a.agentId === agentId) ?? null;

    if (text) text = (await lifecycleRedactor(this.core))(text);
    const baseAgent = sessionId ? this.core.sessionRow(sessionId).agent : undefined;
    const changeId = newId();

    const run = this.core.ctx.storage.transactionSync(() => {
      const cause = this.append({
        type: "tempo.change.created",
        source: "tempo",
        changeId,
        sessionId,
        agent: baseAgent,
        dedupeKey: `change:${changeId}:created`,
        payload: { origin: "request", handle: agent.handle, text },
      })!;

      return this.runs.insert(agent, attachment, this.event(cause));
    });

    this.kick();

    return { changeId, runId: run.id };
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

        const matches: MatchedHook[] = event.changeId
          ? this.attachments.flatMap((attachment) => {
              const agent = this.agents.find((a) => a.id === attachment.agentId);

              return agent
                ? this.matches(attachment, event).map((m) => ({
                    agent,
                    attachment,
                    hook: m.hook,
                    index: m.index,
                  }))
                : [];
            })
          : [];

        let decisions: HookDecision[] = matches.map((match) => ({ match, outcome: "run" }));

        if (matches.some((m) => m.hook.when !== null)) {
          try {
            const redact = await lifecycleRedactor(this.core);
            const state = await decisionState(this.core, event, redact);
            decisions = await decideHooks(this.core.env, state, matches, redact);
          } catch {
            decisions = matches.map((match) => ({
              match,
              outcome: match.hook.when === null ? "run" : "error",
            }));
          }
        }

        this.core.ctx.storage.transactionSync(() => {
          const admitted = new Set<string>();

          for (const decision of decisions) {
            const { match, outcome, p } = decision;
            this.append({
              type: "run.decided",
              source: "tempo",
              changeId: event.changeId,
              causationId: event.id,
              dedupeKey: `decide:${event.id}:${match.attachment.id}:${match.index}`,
              payload: {
                attachmentId: match.attachment.id,
                agentId: match.agent.id,
                handle: match.agent.handle,
                hookIndex: match.index,
                hookEvent: match.hook.event,
                outcome,
                p,
                threshold: match.hook.threshold,
              },
            });

            if (outcome === "run" && !admitted.has(match.attachment.id)) {
              admitted.add(match.attachment.id);
              this.runs.insert(match.agent, match.attachment, event, match.hook, p ?? null);
            }
          }

          const origin = event.changeId ? this.origin(event.changeId) : null;
          const sessionId = origin?.sessionId ?? null;

          if (sessionId) {
            const warned = new Set<string>();

            for (const decision of decisions.filter(
              (d) =>
                d.outcome === "error" &&
                !decisions.some(
                  (other) => other.match.attachment.id === d.match.attachment.id && other.outcome === "run",
                ),
            )) {
              if (warned.has(decision.match.attachment.id)) continue;
              warned.add(decision.match.attachment.id);
              this.core.insertItem({
                sessionId,
                turnId: null,
                kind: "notice",
                status: "completed",
                content: {
                  level: "warning",
                  text: `${decision.match.agent.name} was not checked because the decision model did not answer.`,
                  agentId: decision.match.agent.id,
                  eventId: event.id,
                },
              });
            }

            const skipped = decisions.filter((d) => d.outcome === "skip");

            if (skipped.length)
              this.core.insertItem({
                sessionId,
                turnId: null,
                kind: "notice",
                status: "completed",
                content: {
                  level: "info",
                  text: skipped
                    .map((d) => `@${d.match.agent.handle} ${Math.round((d.p ?? 0) * 100)}%`)
                    .join(" · "),
                  eventId: event.id,
                },
              });
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
      .from(runs)
      .where(and(eq(runs.changeId, changeId), inArray(runs.status, ["queued", "running"])))
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
      .from(runs)
      .where(eq(runs.changeId, changeId))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .get();

    const ended = this.append({
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

    if (ended) this.dirty = true;
  }
}
