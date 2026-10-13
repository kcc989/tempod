/// <reference types="node" />
import { Schema } from "effect";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ChangesSummary,
  HubServerMessage,
  Item,
  PermissionRequest,
  ScriptRun,
  Session,
  Turn,
  WorkspaceDetail,
  WorkspaceServerMessage,
  WorkspaceSummary,
} from "../src/index.ts";
import { API_FUNCTIONS, WIRE_TYPES, wireType } from "../scripts/wire.ts";

const fixtures = join(import.meta.dirname, "../fixtures");

const schemaDir = join(import.meta.dirname, "../schema");

const strict = { onExcessProperty: "error" } as const;

const lines = (path: string): string[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);

const decoder = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => Schema.decodeUnknownSync(schema);

describe("type fixtures (07, Testing)", () => {
  const files = readdirSync(join(fixtures, "types")).filter((f) => f.endsWith(".jsonl"));

  it("has a fixture file and a schema file for every wire type, and no others", () => {
    const names = WIRE_TYPES.map(([n]) => n).sort();
    expect(files.map((f) => f.replace(/\.jsonl$/, "")).sort()).toEqual(names);
    const schemas = readdirSync(schemaDir).filter((f) => f.endsWith(".json"));
    expect(schemas.map((f) => f.replace(/\.json$/, "")).sort()).toEqual([...names, "Api"].sort());
  });

  it.each(files)("%s decodes with its Effect schema", (file) => {
    const decode = decoder(wireType(file.replace(/\.jsonl$/, "")));
    const values = lines(join(fixtures, "types", file));
    expect(values.length).toBeGreaterThan(0);

    for (const raw of values) expect(() => decode(JSON.parse(raw), strict)).not.toThrow();
  });

  it("covers every server function's input and output", () => {
    const names = new Set(files.map((f) => f.replace(/\.jsonl$/, "")));

    for (const f of API_FUNCTIONS) {
      expect(names.has(f.input.name), f.name).toBe(true);
      expect(names.has(f.output.name), f.name).toBe(true);
    }
  });
});

const decodeRecord = (schema: Schema.ConstraintDecoder<unknown>, record: Schema.JsonObject): void => {
  const decode = decoder(schema);

  for (const v of Object.values(record)) decode(v, strict);
};

describe("channel fixtures (07, Testing)", () => {
  it("normalizes absent additive protocol 1 fields and rejects explicit invalid values", () => {
    const value = JSON.parse(lines(join(fixtures, "channel", "workspace-first-load.jsonl"))[0]!);
    delete value.workspace.browserActive;
    delete value.workspace.settings.browser;
    delete value.workspace.settings.agent.models;
    const decode = Schema.decodeUnknownSync(WorkspaceServerMessage);
    const decoded = decode(value);
    expect(decoded.type).toBe("hello");

    if (decoded.type !== "hello") throw new Error("expected hello");
    expect(decoded.workspace.browserActive).toBe(false);
    expect(decoded.workspace.settings.browser.run).toBe(false);
    expect(decoded.workspace.settings.agent.models).toEqual({ claude: "", codex: "", opencode: "", pi: "" });

    for (const invalid of [null, "yes"]) {
      expect(() => decode({ ...value, workspace: { ...value.workspace, browserActive: invalid } })).toThrow();
    }
  });

  const sessions = readdirSync(join(fixtures, "channel"))
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.replace(/\.jsonl$/, ""));

  it("has hub and workspace sessions", () => {
    expect(sessions.some((s) => s.startsWith("hub-"))).toBe(true);
    expect(sessions.some((s) => s.startsWith("workspace-"))).toBe(true);
  });

  it.each(sessions)("%s decodes, and its expected end state holds wire types", (name) => {
    const expectedPath = join(fixtures, "channel", `${name}.expected.json`);
    expect(existsSync(expectedPath)).toBe(true);
    const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
    const messages = lines(join(fixtures, "channel", `${name}.jsonl`));
    expect(expected.messages).toBe(messages.length);
    expect(name.startsWith(`${expected.channel}-`)).toBe(true);
    const decode = decoder(expected.channel === "hub" ? HubServerMessage : WorkspaceServerMessage);

    for (const raw of messages) expect(() => decode(JSON.parse(raw), strict)).not.toThrow();

    for (const e of expected.events) {
      expect(e.line).toBeGreaterThan(0);
      expect(e.line).toBeLessThanOrEqual(messages.length);
    }

    const state = expected.state;

    if (expected.channel === "hub") {
      expect(state.ready).toBe(true);
      decodeRecord(WorkspaceSummary, state.workspaces);

      return;
    }

    expect(state.ready).toBe(true);
    decoder(WorkspaceDetail)(state.workspace, strict);
    decodeRecord(Session, state.sessions);
    decodeRecord(Turn, state.turns);
    decodeRecord(Item, state.items);
    decodeRecord(PermissionRequest, state.permissions);
    decodeRecord(ScriptRun, state.scriptRuns);

    if (state.changes !== null) decoder(ChangesSummary)(state.changes, strict);

    const ordered = Object.values(
      Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Array(Schema.String)))(state.order),
    ).flat();

    expect(ordered.sort()).toEqual(Object.keys(state.items).sort());
  });
});
