import { Schema } from "effect";

/** Agent profile controls (01). */

export const MAX_TOOL_NAMES = 100;

export const MAX_MCP_SERVERS = 10;

export const MAX_SYSTEM_PROMPT = 32_000;

export const ToolName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.:*-]{1,128}$/));

export const McpServerName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9_-]{1,32}$/),
  Schema.makeFilter((s) => s !== "playwright" || "playwright is reserved"),
);

/** A value is exactly `${NAME}`; literal values would put secrets in stored definitions (05, Secrets). */
export const ENV_REF_PATTERN = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;

export const EnvRef = Schema.String.check(Schema.isPattern(ENV_REF_PATTERN));

const RefMap = Schema.Record(Schema.String.check(Schema.isMinLength(1)), EnvRef);

export const McpStdioServer = Schema.Struct({
  name: McpServerName,
  type: Schema.Literal("stdio"),
  command: Schema.String.check(Schema.isMinLength(1)),
  args: Schema.Array(Schema.String),
  env: RefMap,
});

export const McpRemoteServer = Schema.Struct({
  name: McpServerName,
  type: Schema.Literals(["http", "sse"]),
  url: Schema.String.check(Schema.isPattern(/^https:\/\/\S+$/)),
  headers: RefMap,
});

export const McpServerDef = Schema.Union([McpStdioServer, McpRemoteServer]);

export type McpServerDef = typeof McpServerDef.Type;

/** What a session needs from a saved agent; `model` travels in session.start's own field. */
export const AgentProfile = Schema.Struct({
  systemPrompt: Schema.String,
  toolsAllow: Schema.Array(Schema.String),
  toolsDeny: Schema.Array(Schema.String),
  playwright: Schema.Boolean,
  mcpServers: Schema.Array(McpServerDef),
  thoughtLevel: Schema.String,
});

export type AgentProfile = typeof AgentProfile.Type;

export const PROFILE_ISSUES = [
  "systemPrompt",
  "tools",
  "mcpServers",
  "model",
  "thoughtLevel",
  "access",
] as const;

export const ProfileIssue = Schema.Literals(PROFILE_ISSUES);

export type ProfileIssue = typeof ProfileIssue.Type;
