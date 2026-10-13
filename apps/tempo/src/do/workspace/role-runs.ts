import { roleFileHashes, roleFilesChanged } from "../../roles/guard.ts";
import { lifecycleRedactor } from "../../roles/secrets.ts";
import { Files } from "@cloudflare/sandbox";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  TempoError,
  errorMessage,
  newId,
  type ContentBlock,
  type ErrorCode,
  type LifecycleEvent,
  type RoleFile,
  type RoleTrigger,
} from "@tempo/protocol";
import { parseRoleFile, parseRoleResult } from "@tempo/settings";
import {
  checkpoints,
  lifecycleEvents,
  roleRuns,
  sessions,
  turns,
  type RoleRunRow,
  type TurnRow,
} from "../../db/workspace-do.ts";
import { EMPTY_PROMPT, json } from "../../db/json.ts";
import type { ParsedRole } from "../../roles/catalog.ts";
import { chooseRoleAgent } from "../../roles/match.ts";
import { roleInputs } from "../../roles/inputs.ts";
import { afterTurnEnded, credentialKeys, finishTurn, hasCredential } from "./queue.ts";
import { takeCheckpoint, uploadBundleWithRetry } from "./durability.ts";
import type { Lifecycle } from "./lifecycle.ts";

const ACTIVE = ["queued", "running"];

export const roleResultPath = (id: string) => `/home/tempo/roles/${id}/result.json`;

export const ROLE_ACCESS_TEXT = {
  "read-only":
    "This role is read-only. Do not create, change, move or delete files under /workspace, and do not run commands that do, such as formatters, code generators or git commands that change the branch. You may read files and run commands that only read. Tempo compares the files before and after each turn and fails the run if they differ.",
  write:
    "This role may change files under /workspace. Do not commit, push or change the branch. Tempo does that.",
};

export const roleResultText = (id: string) =>
  `When you finish, write your result to ${roleResultPath(id)} as JSON: {"status": "done" or "pass" or "fail" or "blocked", "summary": "<text>", "findings": [{"path": "<path>", "line": <number>, "text": "<text>", "blocking": true or false}]}. "findings" is optional. Use "done" only when the work is complete.`;

export class RoleRuns {
  constructor(readonly lifecycle: Lifecycle) {}
  get core() {
    return this.lifecycle.core;
  }
  row(id: string): RoleRunRow {
    const row = this.core.db.select().from(roleRuns).where(eq(roleRuns.id, id)).get();

    if (!row) throw new TempoError("NOT_FOUND");

    return row;
  }
  snapshot(row: RoleRunRow): { file: RoleFile; body: string } {
    const text = this.core.kv<string>(`runFile:${row.id}`);

    if (text === undefined) throw new TempoError("ROLE_INVALID");

    return parseRoleFile(row.roleName, text);
  }
  update(id: string, patch: Partial<typeof roleRuns.$inferInsert>): RoleRunRow {
    this.core.db.update(roleRuns).set(patch).where(eq(roleRuns.id, id)).run();
    const row = this.row(id);
    this.core.broadcast({ type: "roleRun", run: this.lifecycle.runWire(row) });
    this.core.scheduleAlarm();

    return row;
  }
  limit(row: RoleRunRow, file: RoleFile): string | null {
    const settings = this.core.settings().roles;

    if (!settings.enabled) return "roles.enabled";

    if (row.depth > settings.max_chain_depth) return "roles.max_chain_depth";

    if (row.round > file.limits.rounds) return "limits.rounds";

    const before =
      this.core.db
        .select({ n: sql<number>`count(*)` })
        .from(roleRuns)
        .where(and(eq(roleRuns.changeId, row.changeId), sql`${roleRuns.id} < ${row.id}`))
        .get()?.n ?? 0;

    if (before >= settings.max_runs_per_change) return "roles.max_runs_per_change";

    if (file.limits.tokens > 0 && row.tokens >= file.limits.tokens) return "limits.tokens";

    const total =
      this.core.db
        .select({ n: sql<number>`coalesce(sum(${roleRuns.tokens}),0)` })
        .from(roleRuns)
        .where(eq(roleRuns.changeId, row.changeId))
        .get()?.n ?? 0;

    if (settings.max_tokens_per_change > 0 && total >= settings.max_tokens_per_change)
      return "roles.max_tokens_per_change";

    return null;
  }
  insert(role: ParsedRole, event: LifecycleEvent, trigger?: RoleTrigger): RoleRunRow {
    const existing = this.core.db
      .select()
      .from(roleRuns)
      .where(and(eq(roleRuns.triggerEventId, event.id), eq(roleRuns.roleName, role.info.name)))
      .get();

    if (existing) return existing;

    if (!event.changeId || !role.file) throw new TempoError("ROLE_INVALID");
    const parent = event.roleRunId ? this.row(event.roleRunId) : null;

    const round =
      (this.core.db
        .select({ n: sql<number>`count(*)` })
        .from(roleRuns)
        .where(and(eq(roleRuns.changeId, event.changeId), eq(roleRuns.roleName, role.info.name)))
        .get()?.n ?? 0) + 1;

    const id = newId();

    const row: RoleRunRow = {
      id,
      changeId: event.changeId,
      parentRunId: parent?.id ?? null,
      depth: (parent?.depth ?? 0) + 1,
      roleName: role.info.name,
      scope: role.info.scope,
      roleSha: role.info.sha,
      triggerEventId: event.id,
      sessionId: null,
      agent: null,
      access: role.file.access,
      status: "queued",
      round,
      continuesUsed: 0,
      tokens: 0,
      pinCheckpointId: null,
      resultJson: null,
      errorCode: null,
      errorDetail: null,
      deadlineAt: null,
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
    };

    this.core.db.insert(roleRuns).values(row).onConflictDoNothing().run();
    this.core.setKv(`runFile:${id}`, role.text);

    if (trigger) this.core.setKv(`runTrigger:${id}`, trigger);
    const limit = this.limit(row, role.file);

    if (limit) {
      this.fail(row, "ROLE_LIMIT", limit, event.id);

      return this.row(id);
    }

    this.lifecycle.append({
      type: "role.run.started",
      source: "role",
      changeId: row.changeId,
      roleRunId: id,
      causationId: event.id,
      dedupeKey: `run:${id}:role.run.started`,
      payload: {
        role: row.roleName,
        scope: role.info.scope,
        roleSha: row.roleSha,
        round,
        agent: null,
        access: role.file.access,
      },
    });
    this.core.broadcast({ type: "roleRun", run: this.lifecycle.runWire(row) });

    return row;
  }
  async admit(): Promise<void> {
    if (!["ready", "working"].includes(this.core.state) || !this.core.tempod?.open) return;

    const queued = this.core.db
      .select()
      .from(roleRuns)
      .where(eq(roleRuns.status, "queued"))
      .orderBy(asc(roleRuns.createdAt), asc(roleRuns.id))
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
          .from(roleRuns)
          .where(and(eq(roleRuns.access, "write"), eq(roleRuns.status, "running")))
          .get()
      )
        continue;
      const { file } = this.snapshot(row);
      const limit = this.limit(row, file);

      if (limit) {
        this.fail(row, "ROLE_LIMIT", limit, row.triggerEventId);
        continue;
      }

      const cause = this.lifecycle.event(this.lifecycle.row(row.triggerEventId)!);
      const agent = chooseRoleAgent(file, cause, this.core.settings(), (a) => hasCredential(a, keys));

      if (!agent) {
        this.fail(row, "ROLE_NO_AGENT", undefined, row.triggerEventId);
        continue;
      }

      this.core.ctx.storage.transactionSync(() => {
        const sessionId = newId();
        this.core.db
          .insert(sessions)
          .values({
            id: sessionId,
            roleRunId: row.id,
            agent,
            title: `${row.roleName} #${row.round}`,
            status: "idle",
            configJson: JSON.stringify(file.model === "default" ? {} : { model: file.model }),
            modesJson: "[]",
            configOptionsJson: "[]",
            commandsJson: "[]",
            capabilitiesJson: "{}",
            usageJson: "{}",
            handoffPending: 0,
            generalPromptSent: 0,
            sortOrder:
              (this.core.db
                .select({ n: sql<number>`coalesce(max(${sessions.sortOrder}),0)` })
                .from(sessions)
                .get()?.n ?? 0) + 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
          .run();

        const timeout =
          Number(file.limits.timeout.slice(0, -1)) * (file.limits.timeout.endsWith("h") ? 3600000 : 60000);

        const run = this.update(row.id, {
          sessionId,
          agent,
          status: "running",
          startedAt: Date.now(),
          deadlineAt: Date.now() + timeout,
        });

        this.core.broadcast({
          type: "session",
          session: this.core.sessionToWire(this.core.sessionRow(sessionId)),
        });
        this.queue(run, "role", "");
        admitted = true;
      });
    }

    if (admitted) this.core.kickQueue();
  }
  queue(run: RoleRunRow, origin: "role" | "continue", text: string): void {
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
        text: text || `Run role ${run.roleName}`,
        mentions: [],
        attachments: [],
        reviewCommentIds: [],
      },
    });
  }
  async beforeTurn(turn: TurnRow): Promise<boolean> {
    if (turn.origin === "user") return true;
    const session = this.core.sessionRow(turn.sessionId);

    if (!session.roleRunId) return true;
    const run = this.row(session.roleRunId);

    if (run.status !== "running") {
      finishTurn(this.core, turn.id, "cancelled", { stopReason: "cancelled" });

      return false;
    }

    const { file } = this.snapshot(run);
    const limit = this.limit(run, file);

    if (limit) {
      this.fail(run, "ROLE_LIMIT", limit, run.triggerEventId);

      return false;
    }

    if (run.deadlineAt! <= Date.now()) {
      await this.cancel(run.id, true);

      return false;
    }

    const checkpoint = await takeCheckpoint(this.core, "role_pin", null);

    if (!checkpoint.checkpointId) throw new TempoError("CHECKPOINT_NOT_FOUND");

    if (checkpoint.bundle) await uploadBundleWithRetry(this.core, checkpoint.bundle);

    if (this.row(run.id).status !== "running") return false;
    const guard = await roleFileHashes(this.core);

    if (this.row(run.id).status !== "running") return false;
    await new Files(this.core.container!).mkdir(`/home/tempo/roles/${run.id}`, {
      recursive: true,
      user: "1000:1000",
    });

    if (this.row(run.id).status !== "running") return false;
    this.core.setKv(`runGuard:${turn.id}`, guard);
    this.update(run.id, { pinCheckpointId: checkpoint.checkpointId });

    return true;
  }
  async content(turn: TurnRow): Promise<ContentBlock[]> {
    const run = this.row(this.core.sessionRow(turn.sessionId).roleRunId!);

    if (turn.origin === "continue")
      return [{ type: "text", text: json.prompt.read(turn.promptJson, EMPTY_PROMPT).text }];
    const { file, body } = this.snapshot(run);
    const origin = this.lifecycle.origin(run.changeId);
    const event = origin ? this.lifecycle.event(origin) : null;
    const request = event?.type === "tempo.change.created" ? event.payload.text : undefined;

    const texts = [
      `You are working as the Tempo role "${run.roleName}": ${file.description}`,
      ROLE_ACCESS_TEXT[file.access],
      roleResultText(run.id),
      body,
      ...(request ? [request] : []),
    ];

    return [
      ...texts.map((text) => ({ type: "text" as const, text })),
      ...(await roleInputs(this.core, file, run.changeId, request)),
    ];
  }
  async turnEnded(turnId: string): Promise<void> {
    const turn = this.core.turnRow(turnId);

    if (turn.origin === "user") return;
    const session = this.core.sessionRow(turn.sessionId);

    if (!session.roleRunId) return;
    let run = this.row(session.roleRunId);

    if (run.status !== "running") return;

    const ended = this.core.db
      .select()
      .from(lifecycleEvents)
      .where(and(eq(lifecycleEvents.turnId, turn.id), eq(lifecycleEvents.type, "agent.turn.ended")))
      .orderBy(desc(lifecycleEvents.seq))
      .get();

    const causeId = ended?.id ?? run.triggerEventId;

    if (this.core.kv(`runTurnHandled:${turn.id}`)) return;
    this.core.ctx.storage.transactionSync(() => {
      if (this.core.kv(`runUsageHandled:${turn.id}`)) return;
      this.core.setKv(`runUsageHandled:${turn.id}`, true);
      const usage = turn.usageJson ? JSON.parse(turn.usageJson) : {};
      run = this.update(run.id, { tokens: run.tokens + (Number(usage.totalTokens) || 0) });
    });

    if (turn.status !== "completed") {
      this.fail(run, "ROLE_TURN_FAILED", undefined, causeId);

      return;
    }

    try {
      if (await roleFilesChanged(this.core, turn.id)) {
        this.fail(run, "ROLE_ACCESS_VIOLATION", "Protected login or config files changed.", causeId);

        return;
      }
    } catch {
      this.fail(
        run,
        "ROLE_ACCESS_VIOLATION",
        "Protected login or config files could not be checked.",
        causeId,
      );

      return;
    }

    const pin = run.pinCheckpointId
      ? this.core.db.select().from(checkpoints).where(eq(checkpoints.id, run.pinCheckpointId)).get()
      : null;

    const end = turn.checkpointId
      ? this.core.db.select().from(checkpoints).where(eq(checkpoints.id, turn.checkpointId)).get()
      : null;

    if (run.access === "read-only" && (!pin || !end || pin.treeSha !== end.treeSha)) {
      this.fail(run, "ROLE_ACCESS_VIOLATION", undefined, causeId);

      return;
    }

    let resultText: string | null = null;

    try {
      const response = await new Files(this.core.container!).readFile(roleResultPath(run.id));

      if (response.ok) {
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;

        if (reader)
          try {
            for (;;) {
              const read = await reader.read();

              if (read.done) break;
              bytes += read.value.byteLength;

              if (bytes > 65536)
                throw new TempoError("ROLE_RESULT_INVALID", undefined, "result exceeds 64 KiB");
              chunks.push(read.value);
            }
          } finally {
            await reader.cancel();
          }

        const data = new Uint8Array(bytes);
        let offset = 0;

        for (const chunk of chunks) {
          data.set(chunk, offset);
          offset += chunk.length;
        }

        resultText = new TextDecoder().decode(data);
      } else if (response.status !== 404)
        throw new TempoError("ROLE_RESULT_INVALID", undefined, "result could not be read");
    } catch (e) {
      if (e instanceof TempoError)
        return this.invalidResult(
          run,
          e.code === "ROLE_RESULT_INVALID" ? "ROLE_RESULT_INVALID" : "ROLE_RESULT_MISSING",
          e.detail,
          causeId,
        );
      else return this.invalidResult(run, "ROLE_RESULT_MISSING", undefined, causeId);
    }

    if (this.row(run.id).status !== "running") return;

    if (resultText === null) return this.invalidResult(run, "ROLE_RESULT_MISSING", undefined, causeId);

    try {
      const redact = await lifecycleRedactor(this.core);
      const parsed = parseRoleResult(resultText);

      const result = parseRoleResult(
        JSON.stringify({
          ...parsed,
          summary: redact(parsed.summary),
          ...(parsed.findings
            ? { findings: parsed.findings.map((f) => ({ ...f, path: redact(f.path), text: redact(f.text) })) }
            : {}),
        }),
      );

      if (this.row(run.id).status !== "running") return;
      this.core.ctx.storage.transactionSync(() => {
        this.core.setKv(`runTurnHandled:${turn.id}`, true);
        this.update(run.id, {
          status: "completed",
          resultJson: JSON.stringify(result),
          endedAt: Date.now(),
          deadlineAt: null,
        });
        this.lifecycle.append({
          type: "role.run.completed",
          source: "role",
          changeId: run.changeId,
          roleRunId: run.id,
          sessionId: session.id,
          ...(run.agent ? { agent: run.agent as "claude" | "codex" | "opencode" | "pi" } : {}),
          causationId: causeId,
          dedupeKey: `run:${run.id}:role.run.completed`,
          payload: { role: run.roleName, round: run.round, result },
        });
      });
      this.close(run);
      this.lifecycle.kick();
    } catch (e) {
      this.invalidResult(run, "ROLE_RESULT_INVALID", e instanceof TempoError ? e.detail : undefined, causeId);
    }
  }
  invalidResult(
    run: RoleRunRow,
    code: "ROLE_RESULT_INVALID" | "ROLE_RESULT_MISSING",
    problem: string | undefined,
    causeId: string,
  ): void {
    if (this.row(run.id).status !== "running") return;
    const { file } = this.snapshot(run);
    const limit = this.limit(run, file);

    if (run.continuesUsed < file.limits.continues && !limit) {
      this.core.ctx.storage.transactionSync(() => {
        if (this.lifecycle.row(causeId)?.turnId)
          this.core.setKv(`runTurnHandled:${this.lifecycle.row(causeId)!.turnId}`, true);
        this.update(run.id, { continuesUsed: run.continuesUsed + 1 });
        this.queue(
          run,
          "continue",
          code === "ROLE_RESULT_MISSING"
            ? `Tempo did not find your result at ${roleResultPath(run.id)}. Finish the work if it is not complete, write the result, then end your turn.`
            : `Your result at ${roleResultPath(run.id)} is not valid: ${problem ?? "Expected status, summary and optional findings."}. Fix the file, then end your turn.`,
        );
      });
      this.core.kickQueue();
    } else this.fail(run, limit ? "ROLE_LIMIT" : code, limit ?? problem, causeId);
  }
  fail(
    run: RoleRunRow,
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
        for (const t of this.core.db
          .select()
          .from(turns)
          .where(and(eq(turns.sessionId, run.sessionId), eq(turns.status, "queued")))
          .all()) {
          this.core.deleteTurn(t.id);
        }

      this.lifecycle.append({
        type: "role.run.failed",
        source: "role",
        changeId: run.changeId,
        roleRunId: run.id,
        ...(run.sessionId ? { sessionId: run.sessionId } : {}),
        ...(run.agent ? { agent: run.agent as "claude" | "codex" | "opencode" | "pi" } : {}),
        causationId: causeId,
        dedupeKey: `run:${run.id}:role.run.failed`,
        payload: { role: run.roleName, round: run.round, errorCode: code, ...(detail ? { detail } : {}) },
      });

      if (run.sessionId)
        this.core.insertItem({
          sessionId: run.sessionId,
          turnId: null,
          kind: "notice",
          status: "completed",
          content:
            code === "ROLE_ACCESS_VIOLATION" && !detail?.startsWith("Protected")
              ? {
                  level: "error",
                  text: "This read-only role changed files. Revert to the checkpoint before its turn to undo.",
                  ...(run.pinCheckpointId ? { checkpointId: run.pinCheckpointId } : {}),
                }
              : { level: "error", text: errorMessage(code) },
        });
    });

    if (closeSession) this.close(run);
    this.lifecycle.kick();
  }
  close(run: RoleRunRow): void {
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

    this.core.updateSession(sid, { status: "idle" });
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
      timedOut ? "ROLE_TIMED_OUT" : "ROLE_TURN_FAILED",
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

    for (const run of this.core.db.select().from(roleRuns).where(eq(roleRuns.status, "running")).all()) {
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
      .from(roleRuns)
      .where(and(eq(roleRuns.status, "running"), sql`${roleRuns.deadlineAt} <= ${Date.now()}`))
      .all())
      await this.cancel(run.id, true);
  }
  nextDeadline(): number | null {
    return (
      this.core.db
        .select({ at: sql<number | null>`min(${roleRuns.deadlineAt})` })
        .from(roleRuns)
        .where(eq(roleRuns.status, "running"))
        .get()?.at ?? null
    );
  }
  hasActive(): boolean {
    return !!this.core.db.select().from(roleRuns).where(inArray(roleRuns.status, ACTIVE)).get();
  }
}
