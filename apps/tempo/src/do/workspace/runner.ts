import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import {
  TempoError,
  newId,
  type ErrorCode,
  type OpKind,
  type OpProgress,
  toErrorBody,
} from "@tempo/protocol";
import { Schema } from "effect";
import type { PendingBundle } from "./durability.ts";
import { ops, type OpRow } from "../../db/workspace-do.ts";
import { errorText, log } from "../../log.ts";
import { parseJson, type WorkspaceCore } from "./core.ts";

/** 03, Step limits: the Setup tab notice when dotfiles.apply is skipped. */
export const DOTFILES_NOT_APPLIED = "Could not apply your shell files. Terminals use the defaults.";

/** 03, Ops and their steps. `done` is implied after the last step. */
export const OP_STEPS: Record<OpKind, ReadonlyArray<string>> = {
  create: ["container.start", "tempod.connect", "repo.clone", "settings.read", "dotfiles.apply", "setup.run"],
  wake: [
    "container.start",
    "tempod.connect",
    "repo.clone",
    "repo.applyCheckpoint",
    "home.restore",
    "settings.read",
    "setup.run",
    "dotfiles.apply",
    "sessions.markReload",
    "artifacts.resume",
  ],
  sleep: [
    "turns.check",
    "git.checkpoint",
    "bundle.upload",
    "home.backup",
    "artifacts.upload",
    "tempod.shutdown",
    "container.snapshot",
    "container.destroy",
  ],
  archive: [
    "turns.cancel",
    "script.archive",
    "git.checkpoint",
    "bundle.upload",
    "home.backup",
    "artifacts.upload",
    "repo.deleteBranch",
    "tempod.shutdown",
    "container.snapshot",
    "container.destroy",
    "github.deleteBranch",
  ],
  restore: ["branch.check"],
  revert: ["git.checkpoint", "bundle.upload", "git.revert", "transcript.mark"],
  commit_push: ["git.commitAndPush"],
  merge_pr: ["git.merge"],
  housekeeping: ["events.prune", "r2.retention", "egress.trim"],
};

type OnPermanent =
  | { readonly kind: "fail"; readonly code: ErrorCode; readonly passthrough?: boolean }
  | { readonly kind: "skip" };

interface StepLimit {
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly onPermanent: OnPermanent;
}

/** 03, Step limits. */
export const STEP_LIMITS = {
  // 60 s to healthy, plus room for one snapshot fallback within the same attempt.
  "container.start": {
    timeoutMs: 150_000,
    maxAttempts: 3,
    onPermanent: { kind: "fail", code: "CONTAINER_START_FAILED" },
  },
  "tempod.connect": {
    timeoutMs: 10_000,
    maxAttempts: 5,
    onPermanent: { kind: "fail", code: "TEMPOD_UNREACHABLE" },
  },
  "repo.clone": {
    timeoutMs: 10 * 60_000,
    maxAttempts: 3,
    onPermanent: { kind: "fail", code: "CLONE_FAILED" },
  },
  "repo.applyCheckpoint": { timeoutMs: 5 * 60_000, maxAttempts: 2, onPermanent: { kind: "skip" } },
  "home.restore": { timeoutMs: 5 * 60_000, maxAttempts: 2, onPermanent: { kind: "skip" } },
  "settings.read": { timeoutMs: 10_000, maxAttempts: 3, onPermanent: { kind: "skip" } },
  "dotfiles.apply": { timeoutMs: 2 * 60_000, maxAttempts: 2, onPermanent: { kind: "skip" } },
  "setup.run": { timeoutMs: 30 * 60_000, maxAttempts: 1, onPermanent: { kind: "skip" } },
  "script.archive": { timeoutMs: 120_000, maxAttempts: 1, onPermanent: { kind: "skip" } },
  "git.checkpoint": { timeoutMs: 2 * 60_000, maxAttempts: 3, onPermanent: { kind: "skip" } },
  "bundle.upload": { timeoutMs: 5 * 60_000, maxAttempts: 3, onPermanent: { kind: "skip" } },
  "home.backup": { timeoutMs: 5 * 60_000, maxAttempts: 2, onPermanent: { kind: "skip" } },
  "artifacts.upload": { timeoutMs: 5 * 60_000, maxAttempts: 2, onPermanent: { kind: "skip" } },
  "artifacts.resume": { timeoutMs: 30_000, maxAttempts: 1, onPermanent: { kind: "skip" } },
  "tempod.shutdown": { timeoutMs: 45_000, maxAttempts: 1, onPermanent: { kind: "skip" } },
  "container.snapshot": { timeoutMs: 5 * 60_000, maxAttempts: 2, onPermanent: { kind: "skip" } },
  "container.destroy": { timeoutMs: 30_000, maxAttempts: 3, onPermanent: { kind: "fail", code: "INTERNAL" } },
  "git.revert": {
    timeoutMs: 2 * 60_000,
    maxAttempts: 1,
    onPermanent: { kind: "fail", code: "INTERNAL", passthrough: true },
  },
  "git.commitAndPush": {
    timeoutMs: 5 * 60_000,
    maxAttempts: 1,
    onPermanent: { kind: "fail", code: "INTERNAL", passthrough: true },
  },
  "git.merge": {
    timeoutMs: 5 * 60_000,
    maxAttempts: 1,
    onPermanent: { kind: "fail", code: "INTERNAL", passthrough: true },
  },
  "github.deleteBranch": { timeoutMs: 30_000, maxAttempts: 3, onPermanent: { kind: "skip" } },
  "repo.deleteBranch": {
    timeoutMs: 30_000,
    maxAttempts: 3,
    onPermanent: { kind: "fail", code: "INTERNAL", passthrough: true },
  },
  "branch.check": {
    timeoutMs: 30_000,
    maxAttempts: 3,
    onPermanent: { kind: "fail", code: "INTERNAL", passthrough: true },
  },
} satisfies Record<string, StepLimit>;

const DEFAULT_LIMIT: StepLimit = {
  timeoutMs: 30_000,
  maxAttempts: 3,
  onPermanent: { kind: "fail", code: "INTERNAL" },
};

export const limitOf = (step: string): StepLimit =>
  Object.entries(STEP_LIMITS).find(([key]) => key === step)?.[1] ?? DEFAULT_LIMIT;

/** Errors that no retry can fix. */
const PERMANENT_CODES: ReadonlySet<ErrorCode> = new Set([
  "NOTHING_TO_COMMIT",
  "PUSH_REJECTED",
  "CHECKPOINT_NOT_FOUND",
  "UNKNOWN_OP",
  "BRANCH_IN_USE",
  "VALIDATION_FAILED",
  "NOT_FOUND",
]);

export interface OpState {
  timings: Record<string, number>;
  skipped?: string[];
  waiting?: { step: string; deadline: number; runId?: string };
  freshDisk?: boolean;
  setupRunId?: string;
  archiveRunId?: string;
  checkpointId?: string | null;
  checkpointRequestId?: string;
  pendingBundle?: PendingBundle | null;
  headSha?: string;
  pushedMergeSha?: string;
  result?: OpResult;
}

export interface OpInput {
  readonly checkpointId?: string;
  readonly message?: string;
  readonly number?: number;
  readonly method?: "merge" | "squash";
  readonly pushedMergeSha?: string;
}

export interface OpResult {
  readonly commitSha?: string;
}

export const OpStateSchema = Schema.Struct({
  timings: Schema.Record(Schema.String, Schema.Number),
  skipped: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  waiting: Schema.optional(
    Schema.Struct({ step: Schema.String, deadline: Schema.Number, runId: Schema.optional(Schema.String) }),
  ),
  freshDisk: Schema.optional(Schema.Boolean),
  setupRunId: Schema.optional(Schema.String),
  archiveRunId: Schema.optional(Schema.String),
  checkpointId: Schema.optional(Schema.NullOr(Schema.String)),
  checkpointRequestId: Schema.optional(Schema.String),
  pendingBundle: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ checkpointId: Schema.String, bundlePath: Schema.String, bundleBytes: Schema.Number }),
    ),
  ),
  headSha: Schema.optional(Schema.String),
  pushedMergeSha: Schema.optional(Schema.String),
  result: Schema.optional(Schema.Struct({ commitSha: Schema.optional(Schema.String) })),
});

const OpInputSchema = Schema.Struct({
  checkpointId: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  number: Schema.optional(Schema.Number),
  method: Schema.optional(Schema.Literals(["merge", "squash"])),
  pushedMergeSha: Schema.optional(Schema.String),
});

export type StepOutcome = "next" | "wait" | "cancel" | "done";

export interface StepCtx {
  readonly core: WorkspaceCore;
  readonly op: OpRow;
  readonly input: OpInput;
  readonly state: OpState;
  readonly signal: AbortSignal;
  readonly attempt: number;
}

export type StepFn = (sc: StepCtx) => Promise<StepOutcome>;

export interface OpHooks {
  onDone(core: WorkspaceCore, op: OpRow, state: OpState): Promise<void> | void;
  onFailed(
    core: WorkspaceCore,
    op: OpRow,
    error: { code: ErrorCode; detail: string | null },
  ): Promise<void> | void;
  onCancelled?(core: WorkspaceCore, op: OpRow): Promise<void> | void;
}

const jitter = (ms: number) => Math.round(ms * (0.8 + Math.random() * 0.4));

export const backoffMs = (attempt: number) => jitter(Math.min(1000 * 2 ** (attempt - 1), 60_000));

/**
 * The step runner (03): one op runs at a time, one step per alarm turn, idempotent steps,
 * backoff with jitter, waiting steps finished by event handlers.
 */
export class OpRunner {
  private busy = false;

  constructor(
    private readonly core: WorkspaceCore,
    private readonly steps: Record<string, StepFn>,
    private readonly hooks: Record<OpKind, OpHooks>,
    private readonly onSkip: (step: string, state: OpState) => void = () => undefined,
  ) {
    core.opProgress = () => this.progress();
  }

  /** DO constructor rule: running ops go back to pending and their step runs again. */
  recover(): void {
    const now = Date.now();

    for (const op of this.core.db.select().from(ops).where(eq(ops.status, "running")).all()) {
      const state = this.stateOf(op);
      delete state.waiting;
      this.core.db
        .update(ops)
        .set({ status: "pending", nextRunAt: now, stateJson: JSON.stringify(state), updatedAt: now })
        .where(eq(ops.id, op.id))
        .run();
    }
  }

  insert(kind: OpKind, input: OpInput = {}, at = Date.now()): OpRow {
    const now = Date.now();

    const row: OpRow = {
      id: newId(),
      kind,
      step: OP_STEPS[kind][0]!,
      status: "pending",
      attempt: 0,
      nextRunAt: at,
      inputJson: JSON.stringify(input),
      stateJson: JSON.stringify({ timings: {} } satisfies OpState),
      errorCode: null,
      errorDetail: null,
      createdAt: now,
      updatedAt: now,
    };

    this.core.db.insert(ops).values(row).run();
    this.core.scheduleAlarm();
    this.core.broadcastDetailSoon();

    return row;
  }

  active(): OpRow | null {
    return (
      this.core.db.select().from(ops).where(eq(ops.status, "running")).get() ??
      this.core.db
        .select()
        .from(ops)
        .where(and(eq(ops.status, "pending"), ne(ops.kind, "housekeeping")))
        .orderBy(asc(ops.createdAt))
        .get() ??
      null
    );
  }

  hasPendingOrRunning(kinds?: ReadonlyArray<OpKind>, exceptHousekeeping = true): boolean {
    const rows = this.core.db
      .select({ kind: ops.kind })
      .from(ops)
      .where(inArray(ops.status, ["pending", "running"]))
      .all();

    return rows.some(
      (r) => (!exceptHousekeeping || r.kind !== "housekeeping") && (!kinds || kinds.includes(r.kind)),
    );
  }

  find(kind: OpKind): OpRow | null {
    return (
      this.core.db
        .select()
        .from(ops)
        .where(and(eq(ops.kind, kind), inArray(ops.status, ["pending", "running"])))
        .get() ?? null
    );
  }

  /** The time the next op step is due, or null. */
  nextDueAt(): number | null {
    const running = this.core.db.select().from(ops).where(eq(ops.status, "running")).get();

    if (running) {
      const st = this.stateOf(running);

      return st.waiting ? st.waiting.deadline : running.nextRunAt;
    }

    const pending = this.core.db
      .select()
      .from(ops)
      .where(and(eq(ops.status, "pending"), ne(ops.kind, "housekeeping")))
      .orderBy(asc(ops.createdAt))
      .get();

    if (pending) return pending.nextRunAt;

    const hk = this.core.db
      .select()
      .from(ops)
      .where(and(eq(ops.status, "pending"), eq(ops.kind, "housekeeping")))
      .get();

    return hk?.nextRunAt ?? null;
  }

  /** Runs due steps until nothing is due or the time budget is spent. */
  async runDue(budgetMs = 25_000): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const started = Date.now();

    try {
      while (Date.now() - started < budgetMs) {
        const op = this.pickDue();

        if (!op) break;
        await this.runStep(op);
      }
    } finally {
      this.busy = false;
      this.core.scheduleAlarm();
    }
  }

  private pickDue(): OpRow | null {
    const now = Date.now();
    const running = this.core.db.select().from(ops).where(eq(ops.status, "running")).get();

    if (running) {
      const st = this.stateOf(running);

      if (st.waiting) {
        if (st.waiting.deadline <= now) {
          void this.timeoutWaiting(running);
        }

        return null;
      }

      return running.nextRunAt <= now ? running : null;
    }

    const nonHk = this.core.db
      .select()
      .from(ops)
      .where(and(eq(ops.status, "pending"), ne(ops.kind, "housekeeping")))
      .orderBy(asc(ops.createdAt))
      .all();

    const due = nonHk.find((o) => o.nextRunAt <= now) ?? null;

    if (nonHk.length > 0) return due && due.id === nonHk[0]!.id ? due : null;

    const hk = this.core.db
      .select()
      .from(ops)
      .where(and(eq(ops.status, "pending"), eq(ops.kind, "housekeeping")))
      .get();

    return hk && hk.nextRunAt <= now ? hk : null;
  }

  stateOf(op: OpRow): OpState {
    return parseJson(OpStateSchema)(op.stateJson, { timings: {} });
  }

  private save(op: OpRow, patch: Partial<OpRow>, state?: OpState): void {
    const changes = { ...patch };

    if (state) changes.stateJson = JSON.stringify(state);
    changes.updatedAt = Date.now();
    this.core.db.update(ops).set(changes).where(eq(ops.id, op.id)).run();
  }

  private async runStep(op: OpRow): Promise<void> {
    const step = op.step;
    const fn = this.steps[step];
    const configured = limitOf(step);

    const limit: StepLimit =
      op.kind === "revert" && step === "git.checkpoint"
        ? { ...configured, onPermanent: { kind: "fail", code: "INTERNAL" } }
        : configured;

    const state = this.stateOf(op);
    const input = parseJson(OpInputSchema)(op.inputJson, {});
    this.save(op, { status: "running" });
    const ctl = new AbortController();

    const timer = setTimeout(
      () => ctl.abort(new TempoError("TEMPOD_TIMEOUT", undefined, `${step} timed out`)),
      limit.timeoutMs,
    );

    const t0 = Date.now();
    log("info", "op step", {
      workspaceId: this.core.wsOrNull()?.workspaceId,
      opId: op.id,
      step,
      attempt: op.attempt,
    });

    try {
      if (!fn) throw new TempoError("INTERNAL", undefined, `unknown step ${step}`);

      const outcome = await Promise.race([
        fn({ core: this.core, op, input, state, signal: ctl.signal, attempt: op.attempt }),
        new Promise<never>((_, reject) =>
          ctl.signal.addEventListener("abort", () => reject(ctl.signal.reason)),
        ),
      ]);

      state.timings[step] = (state.timings[step] ?? 0) + (Date.now() - t0);
      await this.applyOutcome(op, outcome, state, limit);
    } catch (e) {
      state.timings[step] = (state.timings[step] ?? 0) + (Date.now() - t0);
      await this.handleError(op, e, state, limit);
    } finally {
      clearTimeout(timer);
      this.core.broadcastDetailSoon();
    }
  }

  private async applyOutcome(
    op: OpRow,
    outcome: StepOutcome,
    state: OpState,
    limit: StepLimit,
  ): Promise<void> {
    const now = Date.now();

    if (outcome === "wait") {
      state.waiting = {
        ...state.waiting,
        step: op.step,
        deadline: state.waiting?.deadline ?? now + limit.timeoutMs,
      };
      this.save(op, {}, state);

      return;
    }

    if (outcome === "cancel") {
      this.save(op, { status: "cancelled" }, state);
      await this.hooks[op.kind].onCancelled?.(this.core, op);
      this.core.kickQueue();

      return;
    }

    const steps = OP_STEPS[op.kind];
    const idx = steps.indexOf(op.step);
    const next = outcome === "done" ? undefined : steps[idx + 1];

    if (next) {
      this.save(op, { step: next, attempt: 0, nextRunAt: now, status: "running" }, state);

      return;
    }

    this.core.ctx.storage.transactionSync(() => {
      this.save(op, { status: "done" }, state);

      if (op.kind === "commit_push") {
        const result = state.result;

        if (result?.commitSha)
          this.core.lifecycle.recordCause({
            type: "tempo.branch.pushed",
            source: "tempo",
            changeId: this.core.lifecycle.newestOpenChange(),
            dedupeKey: `op:${op.id}:tempo.branch.pushed`,
            payload: { branch: this.core.ws().branch, commitSha: result.commitSha },
          });
      }
    });
    this.core.lifecycle.kick();

    try {
      await this.hooks[op.kind].onDone(this.core, { ...op, status: "done" }, state);
    } catch (e) {
      log("error", "op onDone failed", { opId: op.id, error: errorText(e) });
    }

    this.resolveWaiters(op.id, { ok: true, value: state["result"] ?? {} });
    this.core.kickQueue();
  }

  private async handleError(op: OpRow, cause: unknown, state: OpState, limit: StepLimit): Promise<void> {
    const body = toErrorBody(cause);
    const detail = body.detail ?? (cause instanceof Error ? cause.message : String(cause));
    const attempt = op.attempt + 1;
    const permanent = attempt >= limit.maxAttempts || PERMANENT_CODES.has(body.code);
    log(permanent ? "warn" : "info", "op step failed", {
      workspaceId: this.core.wsOrNull()?.workspaceId,
      opId: op.id,
      step: op.step,
      attempt,
      code: body.code,
      error: detail.slice(0, 500),
    });

    if (!permanent) {
      this.save(
        op,
        {
          attempt,
          nextRunAt: Date.now() + backoffMs(attempt),
          errorCode: body.code,
          errorDetail: detail.slice(0, 2000),
        },
        state,
      );

      return;
    }

    if (limit.onPermanent.kind === "skip") {
      state.skipped = [...(state.skipped ?? []), op.step];
      delete state.waiting;
      await this.afterSkip(op, body.code, detail);
      this.onSkip(op.step, state);
      await this.applyOutcome({ ...op, attempt }, "next", state, limit);

      return;
    }

    const code =
      limit.onPermanent.passthrough && body.code !== "INTERNAL" ? body.code : limit.onPermanent.code;

    await this.fail(op, code, detail, state);
  }

  /** Permanent failures that the spec turns into "continue": log, and for some steps tell the user. */
  private async afterSkip(op: OpRow, code: ErrorCode, detail: string): Promise<void> {
    log("warn", "op step skipped", {
      workspaceId: this.core.wsOrNull()?.workspaceId,
      opId: op.id,
      step: op.step,
      code,
    });

    if (op.step === "script.archive")
      this.core.notice("warning", `The archive script failed: ${detail.slice(0, 300)}`);

    if (op.step === "dotfiles.apply") {
      const issues = this.core.settingsIssues();

      if (!issues.warnings.includes(DOTFILES_NOT_APPLIED))
        this.core.setKv("settingsIssues", {
          ...issues,
          warnings: [...issues.warnings, DOTFILES_NOT_APPLIED],
        });
    }

    if (op.step === "settings.read") {
      const issues = this.core.settingsIssues();
      this.core.setKv("settingsIssues", {
        ...issues,
        errors: [...issues.errors, `Settings could not be read: ${detail.slice(0, 300)}`],
      });
    }
  }

  async fail(op: OpRow, code: ErrorCode, detail: string | null, state?: OpState): Promise<void> {
    this.save(op, { status: "failed", errorCode: code, errorDetail: detail?.slice(0, 2000) ?? null }, state);

    try {
      await this.hooks[op.kind].onFailed(this.core, op, { code, detail });
    } catch (e) {
      log("error", "op onFailed failed", { opId: op.id, error: errorText(e) });
    }

    this.resolveWaiters(op.id, { ok: false, error: { code, detail } });
    this.core.kickQueue();
  }

  /** Adds the time a step spent waiting for its event (05: each op stores its step timings). */
  private addWaitTime(op: OpRow, state: OpState, step: string): void {
    state.timings[step] = (state.timings[step] ?? 0) + Math.max(0, Date.now() - op.updatedAt);
  }

  private async timeoutWaiting(op: OpRow): Promise<void> {
    const state = this.stateOf(op);
    const step = state.waiting?.step ?? op.step;
    delete state.waiting;
    this.addWaitTime(op, state, step);
    await this.handleError(
      { ...op, attempt: limitOf(step).maxAttempts - 1 },
      new TempoError("TEMPOD_TIMEOUT", undefined, `${step} timed out`),
      state,
      limitOf(step),
    );
  }

  /** Called by event handlers to finish a waiting step. */
  async completeWaiting(
    opId: string,
    step: string,
    outcome: "next" | "failed",
    error?: { code: ErrorCode; detail: string },
  ): Promise<void> {
    const op = this.core.db.select().from(ops).where(eq(ops.id, opId)).get();

    if (!op || op.status !== "running" || op.step !== step) return;
    const state = this.stateOf(op);
    delete state.waiting;
    this.addWaitTime(op, state, step);

    if (outcome === "next") await this.applyOutcome(op, "next", state, limitOf(step));
    else
      await this.handleError(
        { ...op, attempt: limitOf(step).maxAttempts - 1 },
        new TempoError(error?.code ?? "INTERNAL", undefined, error?.detail),
        state,
        limitOf(step),
      );
    this.core.scheduleAlarm();
  }

  /** Ends a pending or running op without its hooks: its work is superseded (for example by a wake). */
  cancel(opId: string): void {
    const op = this.core.db.select().from(ops).where(eq(ops.id, opId)).get();

    if (!op || (op.status !== "pending" && op.status !== "running")) return;
    const state = this.stateOf(op);
    delete state.waiting;
    this.save(op, { status: "cancelled" }, state);
    this.resolveWaiters(op.id, {
      ok: false,
      error: { code: "CONTAINER_NOT_READY", detail: "the container stopped" },
    });
  }

  /** The op that waits on `step`, if any. */
  waitingOn(step: string): OpRow | null {
    const op = this.core.db
      .select()
      .from(ops)
      .where(and(eq(ops.status, "running"), eq(ops.step, step)))
      .get();

    return op ?? null;
  }

  wait(opId: string): Promise<OpResult> {
    return new Promise((resolve, reject) => {
      const list = this.core.opWaiters.get(opId) ?? [];
      list.push({ resolve, reject });
      this.core.opWaiters.set(opId, list);
    });
  }

  private resolveWaiters(
    opId: string,
    result: { ok: true; value: OpResult } | { ok: false; error: { code: ErrorCode; detail: string | null } },
  ): void {
    const list = this.core.opWaiters.get(opId);

    if (!list) return;
    this.core.opWaiters.delete(opId);

    for (const w of list) {
      if (result.ok) w.resolve(result.value);
      else w.reject(new TempoError(result.error.code, undefined, result.error.detail ?? undefined));
    }
  }

  progress(): OpProgress | null {
    const op = this.active();

    if (!op || op.kind === "housekeeping") return null;
    const state = this.stateOf(op);
    const steps = OP_STEPS[op.kind];
    const idx = steps.indexOf(op.step);

    return {
      kind: op.kind,
      status: op.status,
      step: op.step,
      steps: steps.map((name, i) => ({
        name,
        status: state.skipped?.includes(name)
          ? "skipped"
          : i < idx
            ? "done"
            : i === idx
              ? op.status === "running"
                ? "running"
                : op.status === "failed"
                  ? "failed"
                  : "pending"
              : "pending",
        ms: state.timings[name] ?? null,
      })),
    };
  }

  recent(limit = 50): OpRow[] {
    return this.core.db.select().from(ops).orderBy(desc(ops.createdAt)).limit(limit).all();
  }

  /** Marks a step as skipped (for fresh-disk-only steps on the snapshot path). */
  static skip(state: OpState, step: string): StepOutcome {
    state.skipped = [...(state.skipped ?? []), step];

    return "next";
  }
}
