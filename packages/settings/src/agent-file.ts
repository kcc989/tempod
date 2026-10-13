import { CustomAgentDefinition, TempoError, type McpServerDef } from "@tempo/protocol";
import { Schema } from "effect";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** The custom agent file, agents/<id>.yaml (01, Custom agents). */

const decode = Schema.decodeUnknownSync(CustomAgentDefinition);

type Doc = Record<string, unknown>;
const obj = (u: unknown): Doc => (typeof u === "object" && u !== null && !Array.isArray(u) ? (u as Doc) : {});

const serverFromDoc = (raw: unknown): unknown => {
  const s = obj(raw);
  return s["type"] === "stdio"
    ? { name: s["name"], type: s["type"], command: s["command"], args: s["args"] ?? [], env: s["env"] ?? {} }
    : { name: s["name"], type: s["type"], url: s["url"], headers: s["headers"] ?? {} };
};

/** Throws VALIDATION_FAILED with the first problem as detail. */
export const parseAgentFile = (text: string): CustomAgentDefinition => {
  let doc: Doc;
  try {
    doc = obj(parseYaml(text));
  } catch (cause) {
    throw new TempoError("VALIDATION_FAILED", undefined, cause instanceof Error ? cause.message : "bad YAML");
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
      servers: ((obj(doc["mcp"])["servers"] as unknown[] | undefined) ?? []).map(serverFromDoc),
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

const serverToDoc = (s: McpServerDef): Doc =>
  s.type === "stdio"
    ? { name: s.name, type: s.type, command: s.command, args: [...s.args], env: { ...s.env } }
    : { name: s.name, type: s.type, url: s.url, headers: { ...s.headers } };

export const stringifyAgentFile = (def: CustomAgentDefinition): string =>
  stringifyYaml({
    name: def.name,
    description: def.description,
    base_agent: def.baseAgent,
    model: def.model,
    thought_level: def.thoughtLevel,
    system_prompt: def.systemPrompt,
    tools: { allow: [...def.tools.allow], deny: [...def.tools.deny] },
    mcp: { playwright: def.mcp.playwright, servers: def.mcp.servers.map(serverToDoc) },
  });
