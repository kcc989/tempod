import { RoleFile, RoleName } from "@tempo/protocol/migrations/legacy-agents";
import { TempoError } from "@tempo/protocol";
import { Schema } from "effect";
import { parseDocument } from "yaml";

export const ROLE_DEFAULTS = {
  agent: "auto",
  model: "default",
  access: "read-only",
  inputs: [],
  requestable: false,
  on: [],
  limits: { rounds: 1, continues: 2, timeout: "20m", tokens: 0 },
} as const;

export const parseRoleFile = (name: string, text: string) => {
  try {
    Schema.decodeUnknownSync(RoleName)(name);

    if (new TextEncoder().encode(text).length > 65536) throw new Error("role file exceeds 64 KiB");
    const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);

    if (!match) throw new Error("YAML front matter is required");
    const doc = parseDocument(match[1]!, { version: "1.2", uniqueKeys: true });

    if (doc.errors.length) throw new Error("invalid YAML front matter");
    const raw = Schema.decodeUnknownSync(Schema.JsonObject)(doc.toJS({ maxAliasCount: 50 }));

    if (raw.limits !== undefined && !Schema.is(Schema.JsonObject)(raw.limits))
      throw new Error("limits must be a mapping");

    const value = {
      ...ROLE_DEFAULTS,
      ...raw,
      limits: { ...ROLE_DEFAULTS.limits, ...Schema.decodeUnknownSync(Schema.JsonObject)(raw.limits ?? {}) },
    };

    const file = Schema.decodeUnknownSync(RoleFile, { onExcessProperty: "error" })(value);

    return { file, body: match[2]! };
  } catch {
    throw new TempoError("AGENT_INVALID", undefined, "The legacy definition could not be migrated.");
  }
};
