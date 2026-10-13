import { Schema } from "effect";
import { AgentId } from "./enums.ts";
import { Id as Ulid } from "./ids.ts";
import { TurnUsage } from "./acp.ts";

const S = Schema.String;
const opt = Schema.optional;
const Int = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
export const RoleName = S.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,31}$/));
export const RoleScope = Schema.Literals(["builtin", "user", "repo"]);
export const RoleAccess = Schema.Literals(["read-only", "write"]);
export const RoleAgent = Schema.Literals(["claude", "codex", "opencode", "pi", "auto", "other"]);
export const RoleResultStatus = Schema.Literals(["done", "pass", "fail", "blocked"]);
export const RoleFinding = Schema.Struct({
  path: S,
  line: opt(Int.check(Schema.isGreaterThanOrEqualTo(1))),
  text: S,
  blocking: Schema.Boolean,
});
export const RoleResult = Schema.Struct({
  status: RoleResultStatus,
  summary: S.check(Schema.isMaxLength(4000)),
  findings: opt(Schema.Array(RoleFinding).check(Schema.isMaxLength(200))),
});
export type RoleResult = typeof RoleResult.Type;
export const RoleLimits = Schema.Struct({
  rounds: Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  continues: Int.check(Schema.isLessThanOrEqualTo(10)),
  timeout: S.check(
    Schema.isPattern(/^[1-9][0-9]*[mh]$/),
    Schema.makeFilter(
      (t) => Number(t.slice(0, -1)) * (t.endsWith("h") ? 60 : 1) <= 120 || "timeout exceeds 2h",
    ),
  ),
  tokens: Int,
});
export const RoleTrigger = Schema.Union([
  Schema.Struct({
    event: Schema.Literal("role.run.completed"),
    role: opt(RoleName),
    status: opt(RoleResultStatus),
  }),
  Schema.Struct({ event: Schema.Literal("role.run.failed"), role: opt(RoleName) }),
  Schema.Struct({
    event: Schema.Literal("agent.turn.ended"),
    status: opt(Schema.Literals(["completed", "cancelled", "failed", "interrupted"])),
    session: opt(Schema.Literals(["user", "role"])),
  }),
  Schema.Struct({ event: Schema.Literal("tempo.branch.pushed") }),
  Schema.Struct({ event: Schema.Literal("tempo.check.passed") }),
  Schema.Struct({ event: Schema.Literal("tempo.check.failed") }),
  Schema.Struct({ event: Schema.Literal("tempo.change.created") }),
]);
export type RoleTrigger = typeof RoleTrigger.Type;
export const RoleFile = Schema.Struct({
  description: S.check(Schema.isMaxLength(500)),
  agent: RoleAgent,
  model: S,
  access: RoleAccess,
  inputs: Schema.Array(S.check(Schema.isPattern(/^(prompt|diff|plan|result:[a-z][a-z0-9-]{1,31})$/))),
  requestable: Schema.Boolean,
  on: Schema.Array(RoleTrigger),
  limits: RoleLimits,
}).check(Schema.makeFilter((r) => r.requestable || r.on.length > 0 || "a role needs on or requestable"));
export type RoleFile = typeof RoleFile.Type;
export const RoleInfo = Schema.Struct({
  name: S,
  scope: RoleScope,
  sha: S,
  description: S,
  agent: RoleAgent,
  access: RoleAccess,
  requestable: Schema.Boolean,
  on: Schema.Array(RoleTrigger),
  limits: RoleLimits,
  error: opt(S),
  shadowedBy: opt(RoleScope),
});
export type RoleInfo = typeof RoleInfo.Type;
export const RoleRunStatus = Schema.Literals([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);
export const RoleRun = Schema.Struct({
  id: Ulid,
  changeId: Ulid,
  parentRunId: Schema.NullOr(Ulid),
  depth: Int,
  roleName: RoleName,
  scope: RoleScope,
  roleSha: S,
  triggerEventId: Ulid,
  sessionId: Schema.NullOr(Ulid),
  agent: Schema.NullOr(AgentId),
  access: RoleAccess,
  status: RoleRunStatus,
  round: Int,
  continuesUsed: Int,
  tokens: Int,
  pinCheckpointId: Schema.NullOr(Ulid),
  result: Schema.NullOr(RoleResult),
  errorCode: Schema.NullOr(S),
  errorDetail: Schema.NullOr(S),
  deadlineAt: Schema.NullOr(Int),
  createdAt: Int,
  startedAt: Schema.NullOr(Int),
  endedAt: Schema.NullOr(Int),
  trigger: opt(RoleTrigger),
});
export type RoleRun = typeof RoleRun.Type;
const envelope = {
  id: Ulid,
  occurredAt: Int,
  workspaceId: Ulid,
  changeId: opt(Ulid),
  turnId: opt(Ulid),
  roleRunId: opt(Ulid),
  sessionId: opt(Ulid),
  agent: opt(AgentId),
  causationId: opt(Ulid),
  dedupeKey: S,
};
export const LifecycleTempoSource = Schema.Literal("tempo");
export const LifecycleAgentSource = Schema.Literal("agent");
export const LifecycleRoleSource = Schema.Literal("role");
const sources = { tempo: LifecycleTempoSource, agent: LifecycleAgentSource, role: LifecycleRoleSource };
export const LifecycleChangeCreatedPayload = Schema.Struct({
  origin: Schema.Literals(["prompt", "request", "event"]),
  role: opt(RoleName),
  text: opt(S.check(Schema.isMaxLength(65536))),
});
export const LifecycleTurnEndedPayload = Schema.Struct({
  status: Schema.Literals(["completed", "cancelled", "failed", "interrupted"]),
  stopReason: Schema.NullOr(S),
  errorCode: opt(S),
  usage: opt(TurnUsage),
});
export const LifecycleRunStartedPayload = Schema.Struct({
  role: RoleName,
  scope: RoleScope,
  roleSha: S,
  round: Int,
  agent: Schema.NullOr(AgentId),
  access: RoleAccess,
});
export const LifecycleRunCompletedPayload = Schema.Struct({ role: RoleName, round: Int, result: RoleResult });
export const LifecycleRunFailedPayload = Schema.Struct({
  role: RoleName,
  round: Int,
  errorCode: S,
  detail: opt(S),
});
export const LifecycleChangeEndedPayload = Schema.Struct({
  status: Schema.Literals(["done", "failed", "cancelled"]),
});
export const LifecycleBranchPushedPayload = Schema.Struct({ branch: S, commitSha: S });
export const LifecycleCheckPayload = Schema.Struct({ prNumber: Int });
const event = <T extends string, Source extends keyof typeof sources, P extends Schema.Top>(
  type: T,
  source: Source,
  payload: P,
) => Schema.Struct({ ...envelope, type: Schema.Literal(type), source: sources[source], payload });
export const LifecycleEvent = Schema.Union([
  event("tempo.change.created", "tempo", LifecycleChangeCreatedPayload),
  event("agent.turn.ended", "agent", LifecycleTurnEndedPayload),
  event("role.run.started", "role", LifecycleRunStartedPayload),
  event("role.run.completed", "role", LifecycleRunCompletedPayload),
  event("role.run.failed", "role", LifecycleRunFailedPayload),
  event("tempo.change.ended", "tempo", LifecycleChangeEndedPayload),
  event("tempo.branch.pushed", "tempo", LifecycleBranchPushedPayload),
  event("tempo.check.passed", "tempo", LifecycleCheckPayload),
  event("tempo.check.failed", "tempo", LifecycleCheckPayload),
]);
export type LifecycleEvent = typeof LifecycleEvent.Type;
export const LifecycleLogEvent = Schema.Struct({ seq: Int, event: LifecycleEvent });
export const LifecyclePage = Schema.Struct({
  events: Schema.Array(LifecycleLogEvent),
  nextBeforeSeq: Schema.NullOr(Int),
});
export const LifecycleTrace = Schema.Struct({
  chain: Schema.Array(LifecycleLogEvent),
  children: Schema.Array(LifecycleLogEvent),
  runs: Schema.Array(RoleRun),
});
