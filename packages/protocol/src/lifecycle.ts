import { Schema } from "effect";
import { AgentId } from "./enums.ts";
import { Id as Ulid } from "./ids.ts";
import { Run, RunResult } from "./runs.ts";
import { AgentAccess, AgentHandle, HookEvent, OutputKind } from "./agent-library.ts";
import { TurnUsage } from "./acp.ts";

const S = Schema.String;

const opt = Schema.optional;

const Int = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

const envelope = {
  id: Ulid,
  occurredAt: Int,
  workspaceId: Ulid,
  changeId: opt(Ulid),
  turnId: opt(Ulid),
  runId: opt(Ulid),
  sessionId: opt(Ulid),
  agent: opt(AgentId),
  causationId: opt(Ulid),
  dedupeKey: S,
};

export const LifecycleTempoSource = Schema.Literal("tempo");

export const LifecycleAgentSource = Schema.Literal("agent");

export const LifecycleRunSource = Schema.Literal("run");

const sources = { tempo: LifecycleTempoSource, agent: LifecycleAgentSource, run: LifecycleRunSource };

export const LifecycleChangeCreatedPayload = Schema.Struct({
  origin: Schema.Literals(["prompt", "request", "event"]),
  handle: opt(AgentHandle),
  text: opt(S.check(Schema.isMaxLength(65536))),
});

export const LifecycleTurnEndedPayload = Schema.Struct({
  status: Schema.Literals(["completed", "cancelled", "failed", "interrupted"]),
  stopReason: Schema.NullOr(S),
  errorCode: opt(S),
  usage: opt(TurnUsage),
});

export const LifecycleRunStartedPayload = Schema.Struct({
  agentId: Schema.NullOr(Ulid),
  handle: AgentHandle,
  attachmentId: opt(Ulid),
  agentVersion: Schema.NullOr(Int),
  agentSha: S,
  agent: Schema.NullOr(AgentId),
  access: AgentAccess,
  outputKind: OutputKind,
});

export const LifecycleRunCompletedPayload = Schema.Struct({
  agentId: Schema.NullOr(Ulid),
  handle: AgentHandle,
  result: RunResult,
});

export const LifecycleRunFailedPayload = Schema.Struct({
  agentId: Schema.NullOr(Ulid),
  handle: AgentHandle,
  errorCode: S,
  detail: opt(S),
});

export const LifecycleRunDecidedPayload = Schema.Struct({
  attachmentId: Ulid,
  agentId: Ulid,
  handle: AgentHandle,
  hookIndex: Int,
  hookEvent: HookEvent,
  outcome: Schema.Literals(["run", "skip", "error"]),
  p: opt(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  threshold: Schema.Number,
});

/** 13, L-ADR-7. */
export const LifecycleIntentProposedPayload = Schema.Struct({
  intentId: Ulid,
  lines: Int,
  enforced: Schema.Boolean,
});

export const LifecycleIntentDecidedPayload = Schema.Struct({
  intentId: Ulid,
  by: Schema.Literals(["owner", "judge"]),
  reasons: Schema.Array(S),
});

export const LifecycleIntentCorrectedPayload = Schema.Struct({ intentId: Ulid });

export const LifecyclePrMergedPayload = Schema.Struct({ prNumber: Int });

export const LifecycleProofPayload = Schema.Struct({ proofId: Ulid, complete: Schema.Boolean });

export const LifecycleChecklistPayload = Schema.Struct({ checklistId: Ulid });

export const LifecycleChangeEndedPayload = Schema.Struct({
  status: Schema.Literals(["done", "failed", "cancelled"]),
});

export const LifecycleBranchPushedPayload = Schema.Struct({ branch: S, commitSha: S });

export const LifecycleCheckPayload = Schema.Struct({ prNumber: Int, commitSha: Schema.optional(S) });

const event = <T extends string, Source extends keyof typeof sources, P extends Schema.Top>(
  type: T,
  source: Source,
  payload: P,
) => Schema.Struct({ ...envelope, type: Schema.Literal(type), source: sources[source], payload });

export const LifecycleEvent = Schema.Union([
  event("tempo.change.created", "tempo", LifecycleChangeCreatedPayload),
  event("agent.turn.ended", "agent", LifecycleTurnEndedPayload),
  event("run.started", "run", LifecycleRunStartedPayload),
  event("run.completed", "run", LifecycleRunCompletedPayload),
  event("run.failed", "run", LifecycleRunFailedPayload),
  event("run.decided", "tempo", LifecycleRunDecidedPayload),
  event("tempo.change.ended", "tempo", LifecycleChangeEndedPayload),
  event("tempo.branch.pushed", "tempo", LifecycleBranchPushedPayload),
  event("tempo.check.passed", "tempo", LifecycleCheckPayload),
  event("tempo.check.failed", "tempo", LifecycleCheckPayload),
  event("loop.intent.proposed", "agent", LifecycleIntentProposedPayload),
  event("loop.intent.confirmed", "tempo", LifecycleIntentDecidedPayload),
  event("loop.intent.corrected", "tempo", LifecycleIntentCorrectedPayload),
  event("loop.proof.submitted", "agent", LifecycleProofPayload),
  event("tempo.pr.merged", "tempo", LifecyclePrMergedPayload),
  event("loop.checklist.added", "tempo", LifecycleChecklistPayload),
  event("loop.checklist.reopened", "tempo", LifecycleChecklistPayload),
]);

export type LifecycleEvent = typeof LifecycleEvent.Type;

export const LifecycleLogEvent = Schema.Struct({ seq: Int, event: LifecycleEvent });

export type LifecycleLogEvent = typeof LifecycleLogEvent.Type;

export const LifecyclePage = Schema.Struct({
  events: Schema.Array(LifecycleLogEvent),
  nextBeforeSeq: Schema.NullOr(Int),
});

export const LifecycleTrace = Schema.Struct({
  chain: Schema.Array(LifecycleLogEvent),
  children: Schema.Array(LifecycleLogEvent),
  runs: Schema.Array(Run),
});
