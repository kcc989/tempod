import { CustomAgentDefinition, TempoError, type McpServerDef } from "@tempo/protocol";
import { Schema } from "effect";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** The custom agent file, agents/<id>.yaml (01, Custom agents). */

const decode = Schema.decodeUnknownSync(CustomAgentDefinition);

const JsonObject = Schema.Record(Schema.String, Schema.Json);

type Doc = typeof JsonObject.Type;

const obj = (value: Schema.Json | undefined): Doc => (Schema.is(JsonObject)(value) ? value : {});

const serverFromDoc = (raw: Schema.Json) => {
  const s = obj(raw);

  return s["type"] === "stdio"
    ? { name: s["name"], type: s["type"], command: s["command"], args: s["args"] ?? [], env: s["env"] ?? {} }
    : { name: s["name"], type: s["type"], url: s["url"], headers: s["headers"] ?? {} };
};

/** Throws VALIDATION_FAILED with the first problem as detail. */
export const parseAgentFile = (text: string): CustomAgentDefinition => {
  try {
    const doc = obj(Schema.decodeUnknownSync(Schema.Union([Schema.Json, Schema.Undefined]))(parseYaml(text)));
    const servers = obj(doc["mcp"])["servers"] ?? [];

    if (!Array.isArray(servers)) throw new Error("mcp.servers must be an array");

    return decode(
      {
        name: doc["name"],
        description: doc["description"] ?? "",
        baseAgent: doc["base_agent"],
        model: doc["model"] ?? "",
        thoughtLevel: doc["thought_level"] ?? "",
        systemPrompt: doc["system_prompt"] ?? "",
        tools: { allow: obj(doc["tools"])["allow"] ?? [], deny: obj(doc["tools"])["deny"] ?? [] },
        mcp: { playwright: obj(doc["mcp"])["playwright"] ?? true, servers: servers.map(serverFromDoc) },
      },
      { onExcessProperty: "error" },
    );
  } catch (cause) {
    throw new TempoError("VALIDATION_FAILED", undefined, cause instanceof Error ? cause.message : "bad YAML");
  }
};

const serverToDoc = (s: McpServerDef) =>
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
