import { Schema, SchemaAST } from "effect";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HubServerMessage, WorkspaceServerMessage } from "../src/index.ts";
import {
  applyHubMessage,
  emptyHubState,
  notifyEvents,
  type HubState,
} from "../../../apps/tempo/src/ui/stores/hub-state.ts";
import {
  applyWorkspaceMessage,
  emptyWorkspaceState,
  type WorkspaceState,
} from "../../../apps/tempo/src/ui/stores/workspace-state.ts";
import { CHANNEL_SESSIONS } from "./channel-sessions.ts";
import { CHANNEL_SAMPLES, INPUT_SAMPLES, OUTPUT_SAMPLES, SHARED_SAMPLES } from "./samples.ts";
import { formatFiles, repoRoot, sortKeys } from "./util.ts";
import { API_FUNCTIONS, WIRE_TYPES, nameOfAst } from "./wire.ts";

/**
 * `bun run protocol:fixtures` (07, Testing): writes packages/protocol/fixtures/.
 * - types/<Type>.jsonl: valid samples of every wire type, one JSON value per line.
 * - channel/<session>.jsonl: channel messages in arrival order, and <session>.expected.json: the
 *   end state and events of the web stores (apps/tempo/src/ui/stores) after applying them.
 */

const fixturesDir = join(repoRoot, "packages/protocol/fixtures");
const typesDir = join(fixturesDir, "types");
const channelDir = join(fixturesDir, "channel");

const strict = { onExcessProperty: "error" } as const;

const samples = new Map<string, unknown[]>();
const add = (name: string, values: ReadonlyArray<unknown>): void => {
  const list = samples.get(name) ?? [];
  for (const v of values) {
    const json = JSON.stringify(v);
    if (!list.some((x) => JSON.stringify(x) === json)) list.push(v);
  }
  samples.set(name, list);
};

const known = new Set(WIRE_TYPES.map(([n]) => n));
for (const group of [SHARED_SAMPLES, CHANNEL_SAMPLES, OUTPUT_SAMPLES]) {
  for (const [name, values] of Object.entries(group)) {
    if (!known.has(name)) throw new Error(`samples for unknown wire type ${name}`);
    add(name, values);
  }
}
for (const f of API_FUNCTIONS) {
  if (f.input.kind !== "named") throw new Error(`${f.name}: an array input`);
  add(f.input.name, INPUT_SAMPLES[f.name]);
}

const literalValues = (ast: SchemaAST.AST): ReadonlyArray<unknown> | undefined => {
  if (ast._tag === "Literal") return [ast.literal];
  if (ast._tag !== "Union") return undefined;
  const out: unknown[] = [];
  for (const m of ast.types) {
    const values = literalValues(m);
    if (!values) return undefined;
    out.push(...values);
  }
  return out;
};

// Enums get every value; unions of named types get the samples of each member.
for (const [name, schema] of WIRE_TYPES) {
  const values = literalValues(schema.ast);
  if (values) {
    add(name, values);
    continue;
  }
  if (schema.ast._tag === "Union") {
    for (const m of schema.ast.types) {
      const member = nameOfAst(m);
      if (member) add(name, samples.get(member) ?? []);
    }
  }
}

mkdirSync(typesDir, { recursive: true });
mkdirSync(channelDir, { recursive: true });
for (const dir of [typesDir, channelDir]) for (const f of readdirSync(dir)) rmSync(join(dir, f));

for (const [name, schema] of WIRE_TYPES) {
  const values = samples.get(name) ?? [];
  if (values.length === 0) throw new Error(`no samples for ${name}`);
  const decode = Schema.decodeUnknownSync(schema as Schema.Codec<unknown, unknown>);
  for (const v of values) decode(JSON.parse(JSON.stringify(v)), strict);
  writeFileSync(join(typesDir, `${name}.jsonl`), values.map((v) => `${JSON.stringify(v)}\n`).join(""));
}

const decodeHub = Schema.decodeUnknownSync(HubServerMessage);
const decodeWorkspace = Schema.decodeUnknownSync(WorkspaceServerMessage);

const expectedFiles: string[] = [];
for (const session of CHANNEL_SESSIONS) {
  const lines = session.messages.map((m) => JSON.stringify(m));
  const events: Array<{ readonly line: number; readonly event: unknown }> = [];
  let state: unknown;
  if (session.channel === "hub") {
    let hub: HubState = emptyHubState;
    lines.forEach((raw, i) => {
      const next = applyHubMessage(hub, decodeHub(JSON.parse(raw), strict));
      for (const e of notifyEvents(hub, next)) {
        events.push({ line: i + 1, event: { kind: e.kind, workspaceId: e.workspace.id } });
      }
      hub = next;
    });
    state = hub;
  } else {
    let ws: WorkspaceState = emptyWorkspaceState;
    lines.forEach((raw, i) => {
      const r = applyWorkspaceMessage(ws, decodeWorkspace(JSON.parse(raw), strict));
      for (const e of r.events) events.push({ line: i + 1, event: e });
      ws = r.state;
    });
    state = ws;
  }
  writeFileSync(join(channelDir, `${session.name}.jsonl`), lines.map((l) => `${l}\n`).join(""));
  const expected = join(channelDir, `${session.name}.expected.json`);
  const body = { channel: session.channel, messages: lines.length, state: sortKeys(state), events };
  writeFileSync(expected, `${JSON.stringify(body, null, 2)}\n`);
  expectedFiles.push(expected);
}
formatFiles(expectedFiles);

console.log(
  `protocol:fixtures wrote ${WIRE_TYPES.length} type fixtures and ${CHANNEL_SESSIONS.length} channel sessions`,
);
