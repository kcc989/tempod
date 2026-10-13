import { Schema } from "effect";

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
