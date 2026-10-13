import { Effect, Schema } from "effect";
import { McpServerDef, MAX_MCP_SERVERS, MAX_SYSTEM_PROMPT, MAX_TOOL_NAMES, ToolName } from "./agents.ts";

export const AGENT_LIMIT = 50;

export const AgentHandle = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,31}$/));

export const AgentAccess = Schema.Literals(["read-only", "write"]);

export const AgentBase = Schema.Literals(["claude", "codex", "opencode", "pi", "auto"]);

export const OutputKind = Schema.Literals(["plan", "review", "note"]);

export type OutputKind = typeof OutputKind.Type;

const defaulted = <S extends Schema.Top>(schema: S, value: S["Type"]) =>
  schema.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)));

const Tools = Schema.Struct({
  allow: Schema.Array(ToolName).check(Schema.isMaxLength(MAX_TOOL_NAMES)),
  deny: Schema.Array(ToolName).check(Schema.isMaxLength(MAX_TOOL_NAMES)),
});

const Mcp = Schema.Struct({
  playwright: Schema.Boolean,
  servers: Schema.Array(McpServerDef).check(
    Schema.isMaxLength(MAX_MCP_SERVERS),
    Schema.makeFilter(
      (servers) =>
        new Set(servers.map((s) => s.name)).size === servers.length || "MCP server names must be unique",
    ),
  ),
});

export const AgentDefinition = Schema.Struct({
  handle: AgentHandle,
  name: Schema.String.check(Schema.isBetweenLength(1, 60)),
  description: defaulted(Schema.String.check(Schema.isMaxLength(500)), ""),
  baseAgent: defaulted(AgentBase, "auto"),
  model: defaulted(Schema.String, ""),
  thoughtLevel: defaulted(Schema.String, ""),
  prompt: defaulted(Schema.String.check(Schema.isMaxLength(MAX_SYSTEM_PROMPT)), ""),
  access: defaulted(AgentAccess, "read-only"),
  tools: defaulted(Tools, { allow: [], deny: [] }),
  mcp: defaulted(Mcp, { playwright: true, servers: [] }),
  outputKind: defaulted(OutputKind, "note"),
});

export type AgentDefinition = typeof AgentDefinition.Type;

export const Agent = Schema.Struct({
  ...AgentDefinition.fields,
  description: Schema.String.check(Schema.isMaxLength(500)),
  baseAgent: AgentBase,
  model: Schema.String,
  thoughtLevel: Schema.String,
  prompt: Schema.String.check(Schema.isMaxLength(MAX_SYSTEM_PROMPT)),
  access: AgentAccess,
  tools: Tools,
  mcp: Mcp,
  outputKind: OutputKind,
  id: Schema.String,
  version: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  sha: Schema.String,
  starter: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export type Agent = typeof Agent.Type;

export const AgentSummary = Schema.Struct({
  id: Agent.fields.id,
  handle: Agent.fields.handle,
  name: Agent.fields.name,
  description: Agent.fields.description,
  baseAgent: Agent.fields.baseAgent,
  access: Agent.fields.access,
  outputKind: Agent.fields.outputKind,
  version: Agent.fields.version,
  sha: Agent.fields.sha,
  starter: Agent.fields.starter,
  updatedAt: Agent.fields.updatedAt,
});

export type AgentSummary = typeof AgentSummary.Type;

export const HOOK_EVENTS = [
  "prompt",
  "turn.ended",
  "branch.pushed",
  "check.passed",
  "check.failed",
  "run.completed",
  "run.failed",
] as const;

export const HookEvent = Schema.Literals(HOOK_EVENTS);

export const AttachmentHook = Schema.Struct({
  event: HookEvent,
  when: defaulted(Schema.NullOr(Schema.String.check(Schema.isBetweenLength(1, 500))), null),
  threshold: defaulted(Schema.Number.check(Schema.isBetween({ minimum: 0.05, maximum: 0.95 })), 0.5),
});

export type AttachmentHook = typeof AttachmentHook.Type;

export const AttachmentHooks = Schema.Array(AttachmentHook).check(Schema.isMaxLength(8));

export const RunTimeout = Schema.String.check(
  Schema.isPattern(/^[1-9][0-9]*[mh]$/),
  Schema.makeFilter(
    (t) => Number(t.slice(0, -1)) * (t.endsWith("h") ? 60 : 1) <= 120 || "timeout exceeds 2h",
  ),
);

export const AttachmentOptions = Schema.Struct({
  enabled: defaulted(Schema.Boolean, true),
  hooks: defaulted(AttachmentHooks, []),
  autoSend: defaulted(Schema.Boolean, false),
  maxRuns: defaulted(Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 10 })), 3),
  timeout: defaulted(RunTimeout, "20m"),
});

export const AgentAttachment = Schema.Struct({
  ...AttachmentOptions.fields,
  enabled: Schema.Boolean,
  hooks: AttachmentHooks,
  autoSend: Schema.Boolean,
  maxRuns: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 10 })),
  timeout: RunTimeout,
  id: Schema.String,
  projectId: Schema.String,
  agentId: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  agent: Schema.NullOr(AgentSummary),
});

export type AgentAttachment = typeof AgentAttachment.Type;

export type AttachmentOptions = typeof AttachmentOptions.Type;
