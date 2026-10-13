import { Schema } from "effect";
import { AgentId } from "./enums.ts";

/** Custom agents (01, Custom agents). Snake_case in the YAML file, camelCase on the wire. */

export const CUSTOM_AGENT_LIMIT = 50;

export const MAX_TOOL_NAMES = 100;

export const MAX_MCP_SERVERS = 10;

export const MAX_SYSTEM_PROMPT = 32_000;

export const ToolName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.:*-]{1,128}$/));

export const McpServerName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9_-]{1,32}$/),
  Schema.makeFilter((s) => s !== "playwright" || "playwright is reserved"),
);

/** A value is exactly `${NAME}`; literal values would put secrets in Artifacts (05, Secrets). */
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

const ToolList = Schema.Array(ToolName).check(Schema.isMaxLength(MAX_TOOL_NAMES));

export const CustomAgentDefinition = Schema.Struct({
  name: Schema.String.check(
    Schema.isBetweenLength(1, 60),
    Schema.makeFilter((s) => s.trim() === s || "name has leading or trailing spaces"),
  ),
  description: Schema.String.check(Schema.isMaxLength(200)),
  baseAgent: AgentId,
  model: Schema.String,
  thoughtLevel: Schema.String,
  systemPrompt: Schema.String.check(Schema.isMaxLength(MAX_SYSTEM_PROMPT)),
  tools: Schema.Struct({ allow: ToolList, deny: ToolList }),
  mcp: Schema.Struct({
    playwright: Schema.Boolean,
    servers: Schema.Array(McpServerDef).check(
      Schema.isMaxLength(MAX_MCP_SERVERS),
      Schema.makeFilter(
        (servers) =>
          new Set(servers.map((s) => s.name)).size === servers.length || "MCP server names must be unique",
      ),
    ),
  }),
});

export type CustomAgentDefinition = typeof CustomAgentDefinition.Type;

export const CustomAgent = Schema.Struct({
  ...CustomAgentDefinition.fields,
  id: Schema.String,
  commitSha: Schema.String,
  updatedAt: Schema.Number,
});

export type CustomAgent = typeof CustomAgent.Type;

export const CustomAgentSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  baseAgent: AgentId,
  updatedAt: Schema.Number,
});

export type CustomAgentSummary = typeof CustomAgentSummary.Type;

/** What a session needs from a custom agent; `model` travels in session.start's own field. */
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

export const SessionCustomAgent = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  commitSha: Schema.String,
});

export type SessionCustomAgent = typeof SessionCustomAgent.Type;

export const toAgentProfile = (def: CustomAgentDefinition): AgentProfile => ({
  systemPrompt: def.systemPrompt,
  toolsAllow: def.tools.allow,
  toolsDeny: def.tools.deny,
  playwright: def.mcp.playwright,
  mcpServers: def.mcp.servers,
  thoughtLevel: def.thoughtLevel,
});

export const customAgentRepo = (userId: string): string => `user-${userId}`;

export const customAgentPath = (customAgentId: string): string => `agents/${customAgentId}.yaml`;
