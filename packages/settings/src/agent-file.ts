import { CustomAgentDefinition, TempoError, type McpServerDef } from "@tempo/protocol";
import { Schema } from "effect";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

/** The custom agent file, agents/<id>.toml (01, Custom agents). */

const decode = Schema.decodeUnknownSync(CustomAgentDefinition);

type Toml = Record<string, unknown>;
const obj = (u: unknown): Toml =>
  typeof u === "object" && u !== null && !Array.isArray(u) ? (u as Toml) : {};

const serverFromToml = (raw: unknown): unknown => {
  const s = obj(raw);
  return s["type"] === "stdio"
    ? { name: s["name"], type: s["type"], command: s["command"], args: s["args"] ?? [], env: s["env"] ?? {} }
    : { name: s["name"], type: s["type"], url: s["url"], headers: s["headers"] ?? {} };
};

/** Throws VALIDATION_FAILED with the first problem as detail. */
export const parseAgentFile = (text: string): CustomAgentDefinition => {
  let doc: Toml;
  try {
    doc = parseToml(text) as Toml;
  } catch (cause) {
    throw new TempoError("VALIDATION_FAILED", undefined, cause instanceof Error ? cause.message : "bad TOML");
  }
  return validateAgentDefinition({
    name: doc["name"],
    description: doc["description"] ?? "",
    baseAgent: doc["base_agent"],
    model: doc["model"] ?? "",
    thoughtLevel: doc["thought_level"] ?? "",
    systemPrompt: doc["system_prompt"] ?? "",
    tools: { allow: obj(doc["tools"])["allow"] ?? [], deny: obj(doc["tools"])["deny"] ?? [] },
    mcp: {
      playwright: obj(doc["mcp"])["playwright"] ?? true,
      servers: ((obj(doc["mcp"])["servers"] as unknown[] | undefined) ?? []).map(serverFromToml),
    },
  });
};

export const validateAgentDefinition = (u: unknown): CustomAgentDefinition => {
  try {
    return decode(u, { onExcessProperty: "error" });
  } catch (cause) {
    throw new TempoError("VALIDATION_FAILED", undefined, cause instanceof Error ? cause.message : undefined);
  }
};

const serverToToml = (s: McpServerDef): Toml =>
  s.type === "stdio"
    ? { name: s.name, type: s.type, command: s.command, args: [...s.args], env: { ...s.env } }
    : { name: s.name, type: s.type, url: s.url, headers: { ...s.headers } };

export const stringifyAgentFile = (def: CustomAgentDefinition): string =>
  stringifyToml({
    name: def.name,
    description: def.description,
    base_agent: def.baseAgent,
    model: def.model,
    thought_level: def.thoughtLevel,
    system_prompt: def.systemPrompt,
    tools: { allow: [...def.tools.allow], deny: [...def.tools.deny] },
    mcp: { playwright: def.mcp.playwright, servers: def.mcp.servers.map(serverToToml) },
  }) + "\n";
