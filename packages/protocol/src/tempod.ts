import { Schema } from "effect";
import { AvailableCommand, Capabilities, ConfigOption, ContentBlock, PermissionOption, SessionMode } from "./acp.ts";
import { AgentId, CheckpointReason, DiffScope, ItemKind, ItemStatus, LogLevel, ScriptKind } from "./enums.ts";
import { ChangedFile } from "./types.ts";
import { Settings, SettingsLayer, SettingsReadResult } from "./settings.ts";

/** tempod protocol (02): envelopes, requests and events between WorkspaceDO and tempod. */

export const TEMPOD_PORT = 7070;
export const MAX_MESSAGE_BYTES = 1024 * 1024;

const Env = Schema.Record(Schema.String, Schema.String);

export const HelloWorkspace = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  branch: Schema.String,
  baseBranch: Schema.String,
  repo: Schema.Struct({ owner: Schema.String, name: Schema.String }),
});

export const DoHello = Schema.Struct({
  type: Schema.Literal("hello"),
  v: Schema.Literal(1),
  incarnation: Schema.NullOr(Schema.String),
  lastAckedSeq: Schema.Number,
  workspace: HelloWorkspace,
  env: Env,
});
export type DoHello = typeof DoHello.Type;

export const DoAck = Schema.Struct({ type: Schema.Literal("ack"), upTo: Schema.Number });
export const DoReq = Schema.Struct({
  type: Schema.Literal("req"),
  id: Schema.String,
  op: Schema.String,
  params: Schema.Unknown,
});
export type DoReq = typeof DoReq.Type;

export const DoToTempod = Schema.Union([DoHello, DoAck, DoReq]);
export type DoToTempod = typeof DoToTempod.Type;

export const ResError = Schema.Struct({ code: Schema.String, message: Schema.String });
export const TempodRes = Schema.Union([
  Schema.Struct({ type: Schema.Literal("res"), id: Schema.String, ok: Schema.Literal(true), result: Schema.Unknown }),
  Schema.Struct({ type: Schema.Literal("res"), id: Schema.String, ok: Schema.Literal(false), error: ResError }),
]);
export type TempodRes = typeof TempodRes.Type;

// Items as tempod makes them: the DO adds `rev`.
export const TempodItem = Schema.Struct({
  id: Schema.String,
  kind: ItemKind,
  status: ItemStatus,
  content: Schema.Record(Schema.String, Schema.Unknown),
  createdAt: Schema.Number,
});
export type TempodItem = typeof TempodItem.Type;

const ev = <K extends string, F extends Schema.Struct.Fields>(kind: K, fields: F) =>
  Schema.Struct({ kind: Schema.Literal(kind), ...fields });

export const SessionPatch = Schema.Struct({
  modeId: Schema.optional(Schema.NullOr(Schema.String)),
  modes: Schema.optional(Schema.Array(SessionMode)),
  configOptions: Schema.optional(Schema.Array(ConfigOption)),
  commands: Schema.optional(Schema.Array(AvailableCommand)),
  usage: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  title: Schema.optional(Schema.String),
});
export type SessionPatch = typeof SessionPatch.Type;

export const ItemPatch = Schema.Struct({
  status: Schema.optional(ItemStatus),
  content: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type ItemPatch = typeof ItemPatch.Type;

export const ScriptStream = Schema.Literals(["stdout", "stderr"]);

export const TempodEvent = Schema.Union([
  ev("item.created", { sessionId: Schema.String, turnId: Schema.NullOr(Schema.String), item: TempodItem }),
  ev("item.delta", { sessionId: Schema.String, itemId: Schema.String, append: Schema.Struct({ text: Schema.String }) }),
  ev("item.updated", { sessionId: Schema.String, itemId: Schema.String, patch: ItemPatch }),
  ev("session.updated", { sessionId: Schema.String, patch: SessionPatch }),
  ev("turn.started", { sessionId: Schema.String, turnId: Schema.String }),
  ev("turn.ended", {
    sessionId: Schema.String,
    turnId: Schema.String,
    stopReason: Schema.NullOr(Schema.String),
    error: Schema.optional(ResError),
    interrupted: Schema.optional(Schema.Boolean),
  }),
  ev("permission.requested", {
    requestId: Schema.String,
    sessionId: Schema.String,
    turnId: Schema.String,
    itemId: Schema.String,
    title: Schema.String,
    options: Schema.Array(PermissionOption),
  }),
  ev("agent.exited", {
    sessionId: Schema.String,
    code: Schema.NullOr(Schema.Number),
    signal: Schema.NullOr(Schema.String),
    stderrTail: Schema.String,
  }),
  ev("script.output", { runId: Schema.String, stream: ScriptStream, data: Schema.String }),
  ev("script.exited", {
    runId: Schema.String,
    exitCode: Schema.NullOr(Schema.Number),
    signal: Schema.NullOr(Schema.String),
    timedOut: Schema.Boolean,
  }),
  ev("git.changed", { files: Schema.Array(ChangedFile), additions: Schema.Number, deletions: Schema.Number }),
  ev("ports.changed", { ports: Schema.Array(Schema.Number) }),
  ev("settings.changed", {
    effective: Settings,
    warnings: Schema.Array(Schema.String),
    errors: Schema.Array(Schema.String),
    sources: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
  ev("credential.changed", { provider: Schema.Literal("codex"), content: Schema.String, lastRefresh: Schema.Number }),
  ev("credential.invalid", { provider: Schema.Literals(["claude", "codex", "openrouter", "anthropic", "openai"]) }),
  ev("incarnation.changed", { incarnation: Schema.String }),
  ev("outbox.overflow", { dropped: Schema.Number }),
  ev("tempod.stopping", { reason: Schema.String }),
  ev("log", { level: LogLevel, msg: Schema.String, data: Schema.optional(Schema.Unknown) }),
]);
export type TempodEvent = typeof TempodEvent.Type;
export type TempodEventOf<K extends TempodEvent["kind"]> = Extract<TempodEvent, { kind: K }>;

export const TempodEventEnvelope = Schema.Struct({
  type: Schema.Literal("event"),
  seq: Schema.Number,
  ts: Schema.Number,
  event: Schema.Unknown,
});
export type TempodEventEnvelope = typeof TempodEventEnvelope.Type;

export const TempodToDo = Schema.Union([...TempodRes.members, TempodEventEnvelope]);
export type TempodToDo = typeof TempodToDo.Type;

// Requests: op → params, result, timeout (02, tempod protocol).
const req = <P extends Schema.Top, R extends Schema.Top>(params: P, result: R, timeoutMs: number) => ({
  params,
  result,
  timeoutMs,
});

export const Source = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("new") }),
  Schema.Struct({ kind: Schema.Literal("branch") }),
  Schema.Struct({ kind: Schema.Literal("pr"), number: Schema.Number }),
]);
export type Source = typeof Source.Type;

export const CheckpointResult = Schema.Union([
  Schema.Struct({
    commit: Schema.String,
    tree: Schema.String,
    parent: Schema.String,
    base: Schema.String,
    bundlePath: Schema.String,
    bundleBytes: Schema.Number,
  }),
  Schema.Struct({ unchanged: Schema.Literal(true) }),
]);
export type CheckpointResult = typeof CheckpointResult.Type;

export const SessionStartResult = Schema.Struct({
  acpSessionId: Schema.String,
  modes: Schema.Array(SessionMode),
  /** Additive: the agent's current mode. */
  modeId: Schema.optional(Schema.NullOr(Schema.String)),
  configOptions: Schema.Array(ConfigOption),
  availableCommands: Schema.Array(AvailableCommand),
  capabilities: Capabilities,
  reloaded: Schema.Boolean,
  handoff: Schema.Boolean,
});
export type SessionStartResult = typeof SessionStartResult.Type;

const Empty = Schema.Struct({});

export const TEMPOD_REQUESTS = {
  "repo.clone": req(
    Schema.Struct({
      url: Schema.String,
      branch: Schema.String,
      baseBranch: Schema.String,
      source: Source,
      author: Schema.Struct({ name: Schema.String, email: Schema.String }),
    }),
    Schema.Struct({ headSha: Schema.String, remoteHeadSha: Schema.optional(Schema.NullOr(Schema.String)) }),
    10 * 60_000,
  ),
  "repo.applyCheckpoint": req(
    Schema.Struct({ bundlePath: Schema.String, checkpointId: Schema.String, branch: Schema.String }),
    Schema.Struct({ headSha: Schema.String }),
    5 * 60_000,
  ),
  "settings.read": req(Schema.Struct({ overrides: SettingsLayer }), SettingsReadResult, 10_000),
  "env.set": req(Schema.Struct({ env: Env }), Empty, 10_000),
  "script.start": req(
    Schema.Struct({
      runId: Schema.String,
      kind: ScriptKind,
      scriptId: Schema.NullOr(Schema.String),
      command: Schema.String,
      cwd: Schema.String,
      timeoutMs: Schema.NullOr(Schema.Number),
    }),
    Schema.Struct({ pid: Schema.Number }),
    10_000,
  ),
  "script.stop": req(Schema.Struct({ runId: Schema.String }), Empty, 15_000),
  "session.start": req(
    Schema.Struct({
      sessionId: Schema.String,
      agent: AgentId,
      env: Env,
      modeId: Schema.optional(Schema.NullOr(Schema.String)),
      model: Schema.optional(Schema.NullOr(Schema.String)),
      acpSessionId: Schema.optional(Schema.NullOr(Schema.String)),
    }),
    SessionStartResult,
    120_000,
  ),
  "session.prompt": req(
    Schema.Struct({ sessionId: Schema.String, turnId: Schema.String, content: Schema.Array(ContentBlock) }),
    Schema.Struct({ accepted: Schema.Literal(true) }),
    30_000,
  ),
  "session.cancel": req(Schema.Struct({ sessionId: Schema.String, turnId: Schema.String }), Empty, 20_000),
  "session.setMode": req(Schema.Struct({ sessionId: Schema.String, modeId: Schema.String }), Empty, 30_000),
  "session.setConfig": req(
    Schema.Struct({ sessionId: Schema.String, configId: Schema.String, value: Schema.Union([Schema.String, Schema.Boolean]) }),
    Schema.Struct({ configOptions: Schema.Array(ConfigOption) }),
    30_000,
  ),
  "session.close": req(Schema.Struct({ sessionId: Schema.String }), Empty, 15_000),
  "permission.respond": req(
    Schema.Struct({ requestId: Schema.String, optionId: Schema.NullOr(Schema.String) }),
    Empty,
    10_000,
  ),
  "credential.put": req(
    Schema.Struct({ provider: Schema.Literal("codex"), content: Schema.String, version: Schema.Number }),
    Empty,
    10_000,
  ),
  "git.changes": req(
    Schema.Struct({ scope: DiffScope }),
    Schema.Struct({
      files: Schema.Array(ChangedFile),
      baseSha: Schema.String,
      headSha: Schema.String,
      /** Additive: commits on the branch that origin does not have. */
      ahead: Schema.optional(Schema.Number),
      dirty: Schema.optional(Schema.Boolean),
    }),
    30_000,
  ),
  "git.fileDiff": req(Schema.Struct({ scope: DiffScope, path: Schema.String }), Schema.Struct({ diff: Schema.String }), 30_000),
  "git.checkpoint": req(
    Schema.Struct({ checkpointId: Schema.String, turnId: Schema.NullOr(Schema.String), reason: CheckpointReason }),
    CheckpointResult,
    2 * 60_000,
  ),
  "git.revert": req(Schema.Struct({ checkpointId: Schema.String }), Schema.Struct({ headSha: Schema.String }), 2 * 60_000),
  "git.commitAndPush": req(
    Schema.Struct({
      message: Schema.String,
      branch: Schema.String,
      forceWithLeaseSha: Schema.optional(Schema.NullOr(Schema.String)),
    }),
    Schema.Struct({ commitSha: Schema.String }),
    5 * 60_000,
  ),
  "git.renameBranch": req(Schema.Struct({ from: Schema.String, to: Schema.String }), Empty, 30_000),
  "fs.list": req(Empty, Schema.Struct({ paths: Schema.Array(Schema.String) }), 30_000),
  "fs.read": req(
    Schema.Struct({ path: Schema.String, maxBytes: Schema.Number }),
    Schema.Struct({ content: Schema.String, encoding: Schema.Literals(["utf8", "base64"]), size: Schema.Number }),
    10_000,
  ),
  "fs.search": req(
    Schema.Struct({ query: Schema.String, regex: Schema.Boolean, maxResults: Schema.Number }),
    Schema.Struct({
      matches: Schema.Array(Schema.Struct({ path: Schema.String, line: Schema.Number, text: Schema.String })),
    }),
    30_000,
  ),
  "terminal.list": req(Empty, Schema.Struct({ terminalIds: Schema.Array(Schema.String) }), 10_000),
  shutdown: req(Schema.Struct({ reason: Schema.String }), Empty, 45_000),
} as const;

export type TempodOp = keyof typeof TEMPOD_REQUESTS;
export type TempodParams<O extends TempodOp> = (typeof TEMPOD_REQUESTS)[O]["params"]["Type"];
export type TempodResult<O extends TempodOp> = (typeof TEMPOD_REQUESTS)[O]["result"]["Type"];

export const HealthResponse = Schema.Struct({
  ok: Schema.Literal(true),
  version: Schema.String,
  incarnation: Schema.String,
});
export type HealthResponse = typeof HealthResponse.Type;

/** Handoff (01, Sessions). */
export const HANDOFF_FIRST_LINE =
  "This conversation continues an earlier session that was lost. Here is the transcript so far, oldest first:";
export const HANDOFF_MAX_CHARS = 24_000;

export const revertNote = (seq: number): string =>
  `Note: the user reverted the files to the state after turn ${seq}. Changes made after that point are gone.`;

export const PLAYWRIGHT_MCP_SERVER = {
  name: "playwright",
  command: "mcp-server-playwright",
  args: ["--headless", "--isolated", "--browser", "chromium"],
  env: [{ name: "PLAYWRIGHT_BROWSERS_PATH", value: "/opt/ms-playwright" }],
} as const;

export const PLACEHOLDER = "tempo-placeholder";
