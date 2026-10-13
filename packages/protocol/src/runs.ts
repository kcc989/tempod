import { Schema } from "effect";
import { Id } from "./ids.ts";
import { AgentId } from "./enums.ts";
import { ProfileIssue } from "./agents.ts";
import { AgentAccess, AgentHandle, AttachmentHook, OutputKind } from "./agent-library.ts";

const Text = Schema.String;

const Int = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

const Summary = Text.check(Schema.isMaxLength(4000));

export const RunFinding = Schema.Struct({
  path: Text,
  line: Schema.optionalKey(Int.check(Schema.isGreaterThanOrEqualTo(1))),
  text: Text,
  blocking: Schema.Boolean,
});

export const PlanStep = Schema.Struct({
  text: Text.check(Schema.isMaxLength(1000)),
  files: Schema.optionalKey(Schema.Array(Text).check(Schema.isMaxLength(50))),
});

export const PlanReport = Schema.Struct({
  status: Schema.Literals(["done", "blocked"]),
  summary: Summary,
  steps: Schema.Array(PlanStep).check(Schema.isBetweenLength(1, 50)),
  verify: Schema.optionalKey(Text.check(Schema.isMaxLength(2000))),
});

export const ReviewReport = Schema.Struct({
  status: Schema.Literals(["pass", "fail", "blocked"]),
  summary: Summary,
  findings: Schema.optionalKey(Schema.Array(RunFinding).check(Schema.isMaxLength(200))),
});

export const NoteReport = Schema.Struct({ status: Schema.Literals(["done", "blocked"]), summary: Summary });

export const RUN_REPORTS = { plan: PlanReport, review: ReviewReport, note: NoteReport } as const;

// Stored results also retain migrated reports whose old status does not match their output kind.
export const RunResult = Schema.Struct({
  status: Schema.Literals(["done", "pass", "fail", "blocked"]),
  summary: Summary,
  steps: Schema.optionalKey(Schema.Array(PlanStep).check(Schema.isBetweenLength(1, 50))),
  verify: Schema.optionalKey(Text.check(Schema.isMaxLength(2000))),
  findings: Schema.optionalKey(Schema.Array(RunFinding).check(Schema.isMaxLength(200))),
});

export type RunResult = typeof RunResult.Type;

export const RunStatus = Schema.Literals([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

export const Run = Schema.Struct({
  id: Id,
  changeId: Id,
  parentRunId: Schema.NullOr(Id),
  agentId: Schema.NullOr(Id),
  attachmentId: Schema.NullOr(Id),
  handle: AgentHandle,
  name: Text,
  agentVersion: Schema.NullOr(Int.check(Schema.isGreaterThanOrEqualTo(1))),
  agentSha: Text,
  triggerEventId: Id,
  decisionP: Schema.NullOr(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  sessionId: Schema.NullOr(Id),
  originSessionId: Schema.NullOr(Id),
  agent: Schema.NullOr(AgentId),
  access: AgentAccess,
  outputKind: OutputKind,
  status: RunStatus,
  followUpSent: Schema.Boolean,
  tokens: Int,
  pinCheckpointId: Schema.NullOr(Id),
  warning: Schema.NullOr(Schema.Literal("files_changed")),
  result: Schema.NullOr(RunResult),
  sentTurnId: Schema.NullOr(Id),
  errorCode: Schema.NullOr(Text),
  errorDetail: Schema.NullOr(Text),
  deadlineAt: Schema.NullOr(Int),
  createdAt: Int,
  startedAt: Schema.NullOr(Int),
  endedAt: Schema.NullOr(Int),
  hook: Schema.optional(AttachmentHook),
  profileIssues: Schema.optional(Schema.Array(ProfileIssue)),
});

export type Run = typeof Run.Type;

export const TEMPO_RUN_ID_ENV = "TEMPO_RUN_ID";

export const TEMPO_RUN_OUTPUT_KIND_ENV = "TEMPO_RUN_OUTPUT_KIND";
