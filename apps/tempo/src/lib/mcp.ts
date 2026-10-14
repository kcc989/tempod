import { mcpPlaceholder, type McpServer, type McpServerSpec } from "@tempo/protocol";
import { Schema, Option } from "effect";
import type { McpServerRow } from "../db/d1.ts";

/** One entry of `headers_json` (02): a plain header, or a secret whose value is in CredentialDO. */
export interface StoredHeader {
  readonly name: string;
  readonly value?: string;
  readonly secret?: true;
}

export interface StoredEnv {
  readonly name: string;
  readonly value: string;
}

/** What TempoOutbound needs to know about one server (01, rule 12). */
export interface McpEgress {
  readonly serverId: string;
  readonly host: string;
  readonly secretHeaders: ReadonlyArray<string>;
}

export const mcpHeaderKey = (serverId: string, header: string) =>
  `mcp.${serverId}.header.${header.toLowerCase()}`;

export const mcpKeyPrefix = (serverId: string) => `mcp.${serverId}.header.`;

const StoredHeaderSchema = Schema.Struct({
  name: Schema.String,
  value: Schema.optional(Schema.String),
  secret: Schema.optional(Schema.Literal(true)),
});

const StoredEnvSchema = Schema.Struct({ name: Schema.String, value: Schema.String });

const parse =
  <A>(schema: Schema.ConstraintDecoder<ReadonlyArray<A>>) =>
  (text: string): ReadonlyArray<A> =>
    Option.getOrElse(Schema.decodeUnknownOption(Schema.fromJsonString(schema))(text), () => []);

export const storedHeaders = (row: McpServerRow): ReadonlyArray<StoredHeader> =>
  parse(Schema.Array(StoredHeaderSchema))(row.headersJson);

const isSecret = (h: StoredHeader) => h.secret === true;

export const mcpToWire = (row: McpServerRow, storedSecrets: ReadonlySet<string>): McpServer => ({
  id: row.id,
  name: row.name,
  enabled: row.enabled === 1,
  transport: row.transport,
  command: row.command,
  args: parse(Schema.Array(Schema.String))(row.argsJson),
  env: parse(Schema.Array(StoredEnvSchema))(row.envJson),
  url: row.url,
  headers: storedHeaders(row).map((h) =>
    isSecret(h)
      ? { name: h.name, secret: true, value: null, set: storedSecrets.has(mcpHeaderKey(row.id, h.name)) }
      : { name: h.name, secret: false, value: h.value ?? "" },
  ),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** The `session.start` form (01, User MCP servers). Secret values become placeholders. */
export const mcpToSpec = (row: McpServerRow): McpServerSpec =>
  row.transport === "stdio"
    ? {
        name: row.name,
        transport: "stdio",
        command: row.command ?? "",
        args: parse(Schema.Array(Schema.String))(row.argsJson),
        env: parse(Schema.Array(StoredEnvSchema))(row.envJson),
      }
    : {
        name: row.name,
        transport: row.transport,
        url: row.url ?? "",
        headers: storedHeaders(row).map((h) => ({
          name: h.name,
          value: isSecret(h) ? mcpPlaceholder(row.id, h.name) : (h.value ?? ""),
        })),
      };

export const mcpToEgress = (row: McpServerRow): McpEgress | null => {
  if (row.transport === "stdio" || !row.url) return null;
  let host: string;

  try {
    host = new URL(row.url).hostname.toLowerCase();
  } catch {
    return null;
  }

  return {
    serverId: row.id,
    host,
    secretHeaders: storedHeaders(row)
      .filter(isSecret)
      .map((h) => h.name.toLowerCase()),
  };
};
