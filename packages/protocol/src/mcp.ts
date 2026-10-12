import { Schema } from "effect";

/** User MCP servers (01, User MCP servers; 02, MCP servers). */

export const McpTransport = Schema.Literals(["stdio", "http", "sse"]);
export type McpTransport = typeof McpTransport.Type;

export const McpEnvVar = Schema.Struct({ name: Schema.String, value: Schema.String });
export type McpEnvVar = typeof McpEnvVar.Type;

export const McpHeader = Schema.Struct({
  name: Schema.String,
  secret: Schema.Boolean,
  value: Schema.NullOr(Schema.String),
  set: Schema.optional(Schema.Boolean),
});
export type McpHeader = typeof McpHeader.Type;

export const McpServer = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  enabled: Schema.Boolean,
  transport: McpTransport,
  command: Schema.NullOr(Schema.String),
  args: Schema.Array(Schema.String),
  env: Schema.Array(McpEnvVar),
  url: Schema.NullOr(Schema.String),
  headers: Schema.Array(McpHeader),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type McpServer = typeof McpServer.Type;

export const McpHeaderInput = Schema.Struct({
  name: Schema.String,
  secret: Schema.Boolean,
  value: Schema.optional(Schema.String),
});
export type McpHeaderInput = typeof McpHeaderInput.Type;

export const McpServerInput = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.String,
  enabled: Schema.Boolean,
  transport: McpTransport,
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Array(McpEnvVar)),
  url: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Array(McpHeaderInput)),
});
export type McpServerInput = typeof McpServerInput.Type;

/** What the WorkspaceDO sends tempod in `session.start`. Secret header values are placeholders. */
export const McpServerSpec = Schema.Union([
  Schema.Struct({
    name: Schema.String,
    transport: Schema.Literal("stdio"),
    command: Schema.String,
    args: Schema.Array(Schema.String),
    env: Schema.Array(McpEnvVar),
  }),
  Schema.Struct({
    name: Schema.String,
    transport: Schema.Literals(["http", "sse"]),
    url: Schema.String,
    headers: Schema.Array(McpEnvVar),
  }),
]);
export type McpServerSpec = typeof McpServerSpec.Type;

export const MCP_MAX_SERVERS = 20;
export const MCP_MAX_ARGS = 32;
export const MCP_MAX_ENV = 32;
export const MCP_MAX_HEADERS = 16;
export const MCP_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const MCP_HEADER_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
export const MCP_RESERVED_HEADERS = ["host", "content-length", "connection", "transfer-encoding"] as const;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** The value a secret header has inside the container; rule 11 of TempoOutbound swaps it (01). */
export const mcpPlaceholder = (serverId: string, header: string): string =>
  `tempo-placeholder:mcp:${serverId}:${header.toLowerCase()}`;

/**
 * The rules of `saveMcpServer` that need no stored state (02). Returns the first problem, or null.
 * `storedSecrets` holds the lowercase names of secret headers that already have a value.
 */
export const mcpInputProblem = (
  input: McpServerInput,
  storedSecrets: ReadonlySet<string> = new Set(),
): string | null => {
  if (!MCP_NAME_PATTERN.test(input.name))
    return "Name uses a to z, 0 to 9, - and _, starts with a letter or digit, and has at most 32 characters.";
  if (input.name === "playwright") return "The name playwright is reserved.";
  if (input.transport === "stdio") {
    const command = input.command?.trim() ?? "";
    if (command.length === 0 || command.length > 1024) return "A stdio server needs a command.";
    if (input.url !== undefined || (input.headers?.length ?? 0) > 0)
      return "A stdio server has no URL or headers.";
    if ((input.args?.length ?? 0) > MCP_MAX_ARGS) return `At most ${MCP_MAX_ARGS} arguments.`;
    const env = input.env ?? [];
    if (env.length > MCP_MAX_ENV) return `At most ${MCP_MAX_ENV} env vars.`;
    const names = new Set<string>();
    for (const e of env) {
      if (!ENV_NAME.test(e.name)) return `Env var ${e.name || "(empty)"} must match A-Z, 0-9 and _.`;
      if (names.has(e.name)) return `Env var ${e.name} is listed twice.`;
      names.add(e.name);
    }
    return null;
  }
  if (input.command !== undefined || (input.args?.length ?? 0) > 0 || (input.env?.length ?? 0) > 0)
    return "An http or sse server has no command, arguments or env vars.";
  let url: URL;
  try {
    url = new URL(input.url ?? "");
  } catch {
    return "The URL is not valid.";
  }
  if (url.protocol !== "https:") return "The URL must start with https://.";
  if ((input.url ?? "").length > 2048) return "The URL is too long.";
  const headers = input.headers ?? [];
  if (headers.length > MCP_MAX_HEADERS) return `At most ${MCP_MAX_HEADERS} headers.`;
  const seen = new Set<string>();
  for (const h of headers) {
    const lower = h.name.toLowerCase();
    if (!MCP_HEADER_PATTERN.test(h.name)) return `Header ${h.name || "(empty)"} uses A-Z, a-z, 0-9 and -.`;
    if ((MCP_RESERVED_HEADERS as ReadonlyArray<string>).includes(lower))
      return `Header ${h.name} is set by Tempo.`;
    if (seen.has(lower)) return `Header ${h.name} is listed twice.`;
    seen.add(lower);
    if (!h.secret && h.value === undefined) return `Header ${h.name} needs a value.`;
    if (h.secret && (h.value === undefined || h.value === "") && !storedSecrets.has(lower))
      return `Secret header ${h.name} needs a value.`;
    if (h.value !== undefined && /[\r\n]/.test(h.value)) return `Header ${h.name} has a line break.`;
  }
  return null;
};
