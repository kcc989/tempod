import { Schema } from "effect";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  AgentDefinition,
  AttachmentOptions,
  RUN_REPORTS,
  RunResult,
  TempoError,
  newId,
  type Agent,
  type AgentAttachment,
  type AttachmentHook,
  type ContentBlock,
  type ErrorCode,
  type LifecycleEvent,
} from "@tempo/protocol";
import {
  checkpoints,
  lifecycleEvents,
  runs,
  sessions,
  turns,
  type RunRow,
  type TurnRow,
} from "../../db/workspace-do.ts";
import { EMPTY_PROMPT, json } from "../../db/json.ts";
import { toLibraryProfile } from "../../agents/library.ts";
import { runInputs, sentResultText, RUN_FOLLOW_UP } from "../../agents/run-inputs.ts";
import { roleFileHashes, roleFilesChanged } from "../../roles/guard.ts";
import { lifecycleRedactor } from "../../roles/secrets.ts";
import { migrateRunDefinition } from "../../agents/run-migration.ts";
import { afterTurnEnded, credentialKeys, finishTurn, hasCredential, sessionModel } from "./queue.ts";
import { takeCheckpoint } from "./durability.ts";
import type { Lifecycle } from "./lifecycle.ts";

const ACTIVE = ["queued", "running"];

export class Runs {
  constructor(readonly lifecycle: Lifecycle) {}
  get core() {
    return this.lifecycle.core;
  }
  row(id: string): RunRow {
    const row = this.core.db.select().from(runs).where(eq(runs.id, id)).get();

    if (!row) throw new TempoError("NOT_FOUND");

    return row;
  }
  snapshot(row: RunRow): AgentDefinition {
    const value = this.core.kv<string>(`runDefinition:${row.id}`);

    if (value) return Schema.decodeUnknownSync(AgentDefinition)(JSON.parse(value));

    return migrateRunDefinition(this.core, row);
  }
  options(row: RunRow): AttachmentOptions {
    return Schema.decodeUnknownSync(AttachmentOptions)(this.core.kv(`runOptions:${row.id}`) ?? {});
  }
  update(id: string, patch: Partial<typeof runs.$inferInsert>): RunRow {
    this.core.db.update(runs).set(patch).where(eq(runs.id, id)).run();
    const row = this.row(id);
    this.core.broadcast({ type: "run", run: this.lifecycle.runWire(row) });
    this.core.scheduleAlarm();

    return row;
  }
  insert(
    agent: Agent,
    attachment: AgentAttachment | null,
    event: LifecycleEvent,
    hook?: AttachmentHook,
    decisionP: number | null = null,
  ): RunRow {
    const existing = this.core.db
      .select()
      .from(runs)
      .where(and(eq(runs.triggerEventId, event.id), eq(runs.handle, agent.handle)))
      .get();

    if (existing) return existing;

    if (!event.changeId) throw new TempoError("EVENT_INVALID");
    const origin = this.lifecycle.origin(event.changeId);

    const originSessionId =
      origin?.sessionId ??
      this.core.db
        .select()
        .from(turns)
        .where(and(eq(turns.changeId, event.changeId), eq(turns.origin, "user")))
        .orderBy(asc(turns.seq))
        .get()?.sessionId ??
      null;

    const before =
      this.core.db
        .select({ n: sql<number>`count(*)` })
        .from(runs)
        .where(
          and(
            eq(runs.changeId, event.changeId),
            attachment
              ? eq(runs.attachmentId, attachment.id)
              : and(sql`${runs.attachmentId} IS NULL`, eq(runs.agentId, agent.id)),
          ),
        )
        .get()?.n ?? 0;

    const row: RunRow = {
      id: newId(),
      changeId: event.changeId,
      parentRunId: event.runId ?? null,
      agentId: agent.id,
      attachmentId: attachment?.id ?? null,
      handle: agent.handle,
      agentVersion: agent.version,
      agentSha: agent.sha,
      triggerEventId: event.id,
      decisionP,
      sessionId: null,
      originSessionId,
      agent: null,
      access: agent.access,
      outputKind: agent.outputKind,
      status: "queued",
      followUpSent: 0,
      tokens: 0,
      pinCheckpointId: null,
      warning: null,
      resultJson: null,
      sentTurnId: null,
      errorCode: null,
      errorDetail: null,
      deadlineAt: null,
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
    };

    const definition = Schema.decodeUnknownSync(AgentDefinition)(agent);
    this.core.db.insert(runs).values(row).onConflictDoNothing().run();
    this.core.setKv(`runDefinition:${row.id}`, JSON.stringify(definition));
    this.core.setKv(
      `runOptions:${row.id}`,
      attachment
        ? Schema.decodeUnknownSync(AttachmentOptions)(attachment)
        : Schema.decodeUnknownSync(AttachmentOptions)({}),
    );

    if (hook) this.core.setKv(`runHook:${row.id}`, hook);

    if (originSessionId)
      this.core.insertItem({
        sessionId: originSessionId,
        turnId: null,
        kind: "run",
        status: "completed",
        content: { runId: row.id },
      });

    if (before >= this.options(row).maxRuns) {
      this.fail(row, "RUN_LIMIT");

      return this.row(row.id);
    }

    this.lifecycle.append({
      type: "run.started",
      source: "run",
      changeId: row.changeId,
      runId: row.id,
      causationId: event.id,
      dedupeKey: `run:${row.id}:run.started`,
      payload: {
        agentId: agent.id,
        handle: agent.handle,
        attachmentId: attachment?.id,
        agentVersion: agent.version,
        agentSha: agent.sha,
        agent: null,
        access: agent.access,
        outputKind: agent.outputKind,
      },
    });
    this.core.broadcast({ type: "run", run: this.lifecycle.runWire(row) });

    return row;
  }
  async admit(): Promise<void> {
    if (!["ready", "working"].includes(this.core.state) || !this.core.tempod?.open) return;

    const queued = this.core.db
      .select()
      .from(runs)
      .where(eq(runs.status, "queued"))
      .orderBy(asc(runs.createdAt), asc(runs.id))
      .all();

    if (!queued.length) return;
    const keys = await credentialKeys(this.core);
    let admitted = false;

    for (const row of queued) {
      if (this.row(row.id).status !== "queued") continue;

      if (
        row.access === "write" &&
        this.core.db
          .select()
          .from(runs)
          .where(and(eq(runs.access, "write"), eq(runs.status, "running")))
          .get()
      )
        continue;
      const definition = this.snapshot(row);

      const agent =
        definition.baseAgent === "auto" ? this.core.settings().agent.default : definition.baseAgent;

      try {
        if (!hasCredential(agent, keys)) throw new TempoError("RUN_NO_AGENT");
        sessionModel(agent, { model: definition.model }, this.core.settings());
      } catch {
        this.fail(row, "RUN_NO_AGENT");
        continue;
      }

      this.core.ctx.storage.transactionSync(() => {
        const sessionId = newId();
        this.core.db
          .insert(sessions)
          .values({
            id: sessionId,
            runId: row.id,
            agent,
            title: definition.name,
            status: "idle",
            configJson: JSON.stringify(definition.model ? { model: definition.model } : {}),
            modesJson: "[]",
            configOptionsJson: "[]",
            commandsJson: "[]",
            capabilitiesJson: "{}",
            usageJson: "{}",
            handoffPending: 0,
            generalPromptSent: 0,
            profileJson: JSON.stringify(toLibraryProfile(definition)),
            profileIssuesJson: "[]",
            customAgentId: row.agentId,
            customAgentName: definition.name,
            customAgentCommit: row.agentSha,
            sortOrder:
              (this.core.db
                .select({ n: sql<number>`coalesce(max(${sessions.sortOrder}),0)` })
                .from(sessions)
                .get()?.n ?? 0) + 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
          .run();
        const timeout = this.options(row).timeout;

        const run = this.update(row.id, {
          sessionId,
          agent,
          status: "running",
          startedAt: Date.now(),
          deadlineAt: Date.now() + Number(timeout.slice(0, -1)) * (timeout.endsWith("h") ? 3600000 : 60000),
        });

        this.core.broadcast({
          type: "session",
          session: this.core.sessionToWire(this.core.sessionRow(sessionId)),
        });
        this.queue(run, "run", "");
        admitted = true;
      });
    }

    if (admitted) this.core.kickQueue();
  }
  queue(run: RunRow, origin: "run" | "continue", text: string): void {
    const id = newId();

    const pos =
      origin === "continue"
        ? (this.core.db
            .select({ n: sql<number>`coalesce(min(${turns.queuePos}),1)` })
            .from(turns)
            .where(eq(turns.status, "queued"))
            .get()?.n ?? 1) - 1
        : this.core.nextQueuePos();

    this.core.db
      .insert(turns)
      .values({
        id,
        sessionId: run.sessionId!,
        changeId: run.changeId,
        origin,
        seq: this.core.nextTurnSeq(),
        queuePos: pos,
        status: "queued",
        promptJson: json.prompt.write({ ...EMPTY_PROMPT, text }),
        reverted: 0,
        queuedAt: Date.now(),
      })
      .run();
    this.core.broadcast({ type: "turn", turn: this.core.turnToWire(this.core.turnRow(id)) });
    this.core.insertItem({
      sessionId: run.sessionId!,
      turnId: id,
      kind: "user_message",
      status: "completed",
      content: {
        text: text || `Run agent ${run.handle}`,
        mentions: [],
        attachments: [],
        reviewCommentIds: [],
      },
    });
  }
  async beforeTurn(turn: TurnRow): Promise<boolean> {
    const session = this.core.sessionRow(turn.sessionId);

    if (!session.runId) return true;
    const run = this.row(session.runId);

    if (run.status !== "running") {
      finishTurn(this.core, turn.id, "cancelled", { stopReason: "cancelled" });

      return false;
    }

    if (run.deadlineAt! <= Date.now()) {
      await this.cancel(run.id, true);

      return false;
    }

    if (!run.pinCheckpointId) {
      const checkpoint = await takeCheckpoint(this.core, "run_pin", null);

      if (!checkpoint.checkpointId) throw new TempoError("CHECKPOINT_NOT_FOUND");

      if (this.row(run.id).status !== "running") return false;
      this.update(run.id, { pinCheckpointId: checkpoint.checkpointId });
    }

    const guard = await roleFileHashes(this.core);

    if (this.row(run.id).status !== "running") return false;
    this.core.setKv(`runGuard:${turn.id}`, guard);

    return true;
  }
  async content(turn: TurnRow): Promise<ContentBlock[]> {
    const run = this.row(this.core.sessionRow(turn.sessionId).runId!);

    if (turn.origin === "continue") return [{ type: "text", text: RUN_FOLLOW_UP }];

    return runInputs(this.core, this.snapshot(run), run);
  }
  async report(sessionId: string, runId: string, input: Schema.Json): Promise<{}> {
    const run = this.row(runId);

    if (
      run.status !== "running" ||
      run.sessionId !== sessionId ||
      this.core.sessionRow(sessionId).runId !== runId
    )
      throw new TempoError("RUN_NOT_RUNNING");
    let result: RunResult;

    try {
      if (new TextEncoder().encode(JSON.stringify(input)).length > 65536) throw new Error("Too large");
      const schema = RUN_REPORTS[this.snapshot(run).outputKind];
      result = Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input);
    } catch {
      throw new TempoError(
        "VALIDATION_FAILED",
        undefined,
        `Expected a ${run.outputKind} report within 64 KiB, with the documented fields and status.`,
      );
    }

    const redact = await lifecycleRedactor(this.core);

    const redacted = (value: Schema.Json): Schema.Json =>
      Schema.is(Schema.String)(value)
        ? redact(value)
        : Array.isArray(value)
          ? value.map(redacted)
          : Schema.is(Schema.JsonObject)(value)
            ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redacted(v)]))
            : value;

    const safe = redacted(Schema.decodeUnknownSync(Schema.Json)(result));
    const text = JSON.stringify(safe);

    try {
      Schema.decodeUnknownSync(RUN_REPORTS[this.snapshot(run).outputKind], { onExcessProperty: "error" })(
        safe,
      );

      if (new TextEncoder().encode(text).length > 65536) throw new Error("Too large");
    } catch {
      throw new TempoError(
        "VALIDATION_FAILED",
        undefined,
        "The redacted report exceeds the documented limits. Shorten the report and try again.",
      );
    }

    if (this.row(runId).status !== "running") throw new TempoError("RUN_NOT_RUNNING");
    this.update(runId, { resultJson: text });

    return {};
  }
  async turnEnded(turnId: string): Promise<void> {
    const turn = this.core.turnRow(turnId);
    const session = this.core.sessionRow(turn.sessionId);

    if (!session.runId) return;
    let run = this.row(session.runId);

    if (run.status !== "running" || this.core.kv(`runTurnHandled:${turn.id}`)) return;

    const ended = this.core.db
      .select()
      .from(lifecycleEvents)
      .where(and(eq(lifecycleEvents.turnId, turn.id), eq(lifecycleEvents.type, "agent.turn.ended")))
      .orderBy(desc(lifecycleEvents.seq))
      .get();

    const causeId = ended?.id ?? run.triggerEventId;
    this.core.ctx.storage.transactionSync(() => {
      if (this.core.kv(`runUsageHandled:${turn.id}`)) return;
      this.core.setKv(`runUsageHandled:${turn.id}`, true);
      const usage = turn.usageJson ? JSON.parse(turn.usageJson) : {};
      run = this.update(run.id, { tokens: run.tokens + (Number(usage.totalTokens) || 0) });
    });

    if (turn.status !== "completed") return this.fail(run, "RUN_TURN_FAILED", undefined, causeId);

    try {
      if (await roleFilesChanged(this.core, turn.id))
        return this.fail(run, "RUN_ACCESS_VIOLATION", "Protected login or config files changed.", causeId);
    } catch {
      return this.fail(
        run,
        "RUN_ACCESS_VIOLATION",
        "Protected login or config files could not be checked.",
        causeId,
      );
    }

    if (this.row(run.id).status !== "running") return;

    const pin = run.pinCheckpointId
      ? this.core.db.select().from(checkpoints).where(eq(checkpoints.id, run.pinCheckpointId)).get()
      : null;

    const end = turn.checkpointId
      ? this.core.db.select().from(checkpoints).where(eq(checkpoints.id, turn.checkpointId)).get()
      : null;

    if (run.access === "read-only" && pin && end && pin.treeSha !== end.treeSha)
      run = this.update(run.id, { warning: "files_changed" });

    if (!run.resultJson) {
      if (run.followUpSent) return this.fail(run, "RUN_RESULT_MISSING", undefined, causeId);
      this.core.ctx.storage.transactionSync(() => {
        this.core.setKv(`runTurnHandled:${turn.id}`, true);
        this.update(run.id, { followUpSent: 1 });
        this.queue(run, "continue", RUN_FOLLOW_UP);
      });
      this.core.kickQueue();

      return;
    }

    const result = Schema.decodeUnknownSync(RunResult)(JSON.parse(run.resultJson));
    this.core.ctx.storage.transactionSync(() => {
      this.core.setKv(`runTurnHandled:${turn.id}`, true);
      this.update(run.id, { status: "completed", endedAt: Date.now(), deadlineAt: null });

      const completed = this.lifecycle.append({
        type: "run.completed",
        source: "run",
        changeId: run.changeId,
        runId: run.id,
        sessionId: session.id,
        agent: run.agent ?? undefined,
        causationId: causeId,
        dedupeKey: `run:${run.id}:run.completed`,
        payload: { agentId: run.agentId, handle: run.handle, result },
      });

      if (this.options(run).autoSend && run.originSessionId) {
        try {
          this.send(run.id, completed?.id);
        } catch (error) {
          if (!(error instanceof TempoError) || error.code !== "RUN_NO_CHAT") throw error;
          this.core.insertItem({
            sessionId: run.originSessionId,
            turnId: null,
            kind: "notice",
            status: "completed",
            content: { level: "warning", text: "The run completed, but its origin chat is closed." },
          });
        }
      }
    });
    this.close(run);
    this.lifecycle.kick();
  }
  send(id: string, causeId?: string) {
    const run = this.row(id);

    if (run.status !== "completed" || !run.resultJson) throw new TempoError("RUN_NOT_COMPLETED");

    if (run.sentTurnId) throw new TempoError("RUN_ALREADY_SENT");

    if (!run.originSessionId) throw new TempoError("RUN_NO_CHAT");
    const session = this.core.sessionRow(run.originSessionId);

    if (session.status === "closed") throw new TempoError("RUN_NO_CHAT");

    const text = sentResultText(
      this.snapshot(run).name,
      run.outputKind,
      Schema.decodeUnknownSync(RunResult)(JSON.parse(run.resultJson)),
    );

    const turnId = newId();
    this.core.ctx.storage.transactionSync(() => {
      this.core.db
        .insert(turns)
        .values({
          id: turnId,
          sessionId: session.id,
          changeId: run.changeId,
          origin: "user",
          seq: this.core.nextTurnSeq(),
          queuePos: this.core.nextQueuePos(),
          status: "queued",
          promptJson: json.prompt.write({ ...EMPTY_PROMPT, text }),
          reverted: 0,
          queuedAt: Date.now(),
        })
        .run();
      this.core.insertItem({
        sessionId: session.id,
        turnId,
        kind: "user_message",
        status: "completed",
        content: { text, mentions: [], attachments: [], reviewCommentIds: [] },
      });

      const cause =
        causeId ??
        this.core.db
          .select()
          .from(lifecycleEvents)
          .where(and(eq(lifecycleEvents.runId, id), eq(lifecycleEvents.type, "run.completed")))
          .get()?.id;

      if (cause) this.core.setKv(`turnCause:${turnId}`, cause);
      this.update(id, { sentTurnId: turnId });
      this.core.broadcast({ type: "turn", turn: this.core.turnToWire(this.core.turnRow(turnId)) });
    });
    this.core.kickQueue();
    this.lifecycle.kick();

    return { turnId };
  }
  fail(
    run: RunRow,
    code: ErrorCode,
    detail?: string,
    causeId = run.triggerEventId,
    status: "failed" | "timed_out" | "cancelled" = "failed",
    closeSession = true,
  ): void {
    if (!ACTIVE.includes(this.row(run.id).status)) return;
    this.core.ctx.storage.transactionSync(() => {
      this.update(run.id, {
        status,
        errorCode: code,
        errorDetail: detail ?? null,
        endedAt: Date.now(),
        deadlineAt: null,
      });

      if (run.sessionId)
        for (const turn of this.core.db
          .select()
          .from(turns)
          .where(and(eq(turns.sessionId, run.sessionId), eq(turns.status, "queued")))
          .all())
          this.core.deleteTurn(turn.id);
      this.lifecycle.append({
        type: "run.failed",
        source: "run",
        changeId: run.changeId,
        runId: run.id,
        sessionId: run.sessionId ?? undefined,
        agent: run.agent ?? undefined,
        causationId: causeId,
        dedupeKey: `run:${run.id}:run.failed`,
        payload: { agentId: run.agentId, handle: run.handle, errorCode: code, detail },
      });
    });

    if (closeSession) this.close(run);
    this.lifecycle.kick();
  }
  close(run: RunRow): void {
    if (!run.sessionId) return;
    const sid = run.sessionId;
    this.core.liveSessions.delete(sid);

    if (!this.core.sessionClosures.has(sid)) {
      const closing = (this.core.tempod?.request("session.close", { sessionId: sid }) ?? Promise.resolve())
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => this.core.sessionClosures.delete(sid));

      this.core.sessionClosures.set(sid, closing);
      this.core.ctx.waitUntil(closing);
    }

    this.core.updateSession(sid, { status: "closed", closedAt: Date.now() });
  }
  async cancel(id: string, timedOut = false): Promise<void> {
    const run = this.row(id);

    if (!ACTIVE.includes(run.status)) return;

    const starting = this.core.startingTurnId
      ? this.core.db.select().from(turns).where(eq(turns.id, this.core.startingTurnId)).get()
      : null;

    const turn = this.core.runningTurn() ?? starting;

    if (starting?.sessionId === run.sessionId) {
      this.core.turnStartAbort?.abort();
      finishTurn(this.core, starting.id, "cancelled", { stopReason: "cancelled" });
    }

    this.fail(
      run,
      timedOut ? "RUN_TIMED_OUT" : "RUN_TURN_FAILED",
      undefined,
      run.triggerEventId,
      timedOut ? "timed_out" : "cancelled",
      false,
    );

    if (turn && turn.sessionId === run.sessionId) {
      await this.core.tempod
        ?.request("session.cancel", { sessionId: turn.sessionId, turnId: turn.id })
        .catch(() => undefined);
      finishTurn(this.core, turn.id, "cancelled", { stopReason: "cancelled" });
    }

    this.close(run);
    this.lifecycle.kick();
    this.core.kickQueue();
  }
  async recover(): Promise<void> {
    if (!this.core.tempod?.open || this.core.turnEndInProgress || this.core.queueBusy) return;

    for (const run of this.core.db.select().from(runs).where(eq(runs.status, "running")).all()) {
      if (!run.sessionId) continue;

      const latest = this.core.db
        .select()
        .from(turns)
        .where(eq(turns.sessionId, run.sessionId))
        .orderBy(desc(turns.seq))
        .get();

      if (latest && !ACTIVE.includes(latest.status) && !this.core.kv(`runTurnHandled:${latest.id}`))
        await afterTurnEnded(this.core, latest.id);
    }
  }
  async timeouts(): Promise<void> {
    for (const run of this.core.db
      .select()
      .from(runs)
      .where(and(eq(runs.status, "running"), sql`${runs.deadlineAt} <= ${Date.now()}`))
      .all())
      await this.cancel(run.id, true);
  }
  nextDeadline(): number | null {
    return (
      this.core.db
        .select({ at: sql<number | null>`min(${runs.deadlineAt})` })
        .from(runs)
        .where(eq(runs.status, "running"))
        .get()?.at ?? null
    );
  }
  hasActive(): boolean {
    return !!this.core.db.select().from(runs).where(inArray(runs.status, ACTIVE)).get();
  }
}
