import { DEPLOY_TOOL_NAMES } from "./deploy-tools.ts";
import { ISSUE_TOOL_NAMES } from "./issue-tools.ts";
import { Schema } from "effect";
import {
  AvailableCommand,
  Capabilities,
  ConfigOption,
  ContentBlock,
  PermissionOption,
  SessionMode,
  TurnUsage,
} from "./acp.ts";
import { AgentId, CheckpointReason, DiffScope, ItemKind, ItemStatus, LogLevel, ScriptKind } from "./enums.ts";
import { McpServerSpec } from "./mcp.ts";
import { AgentProfile, ProfileIssue } from "./agents.ts";
import { ChangedFile } from "./types.ts";
import { Settings, SettingsLayer, SettingsReadResult } from "./settings.ts";
import { EnvironmentProposal, EnvironmentSummary } from "./environments.ts";
import { ArtifactKind } from "./artifacts.ts";

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

export const ToolReq = Schema.Struct({
  type: Schema.Literal("tool.req"),
  id: Schema.String,
  op: Schema.Literals([
    "report_result",
    "propose_intent",
    "get_project_profile",
    "list_agents",
    "propose_agent_change",
    ...ISSUE_TOOL_NAMES,
    ...DEPLOY_TOOL_NAMES,
  ]),
  sessionId: Schema.String,
  runId: Schema.optional(Schema.String),
  params: Schema.Json,
});

export type ToolReq = typeof ToolReq.Type;

export const ToolRes = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("tool.res"),
    id: Schema.String,
    ok: Schema.Literal(true),
    result: Schema.Json,
  }),
  Schema.Struct({
    type: Schema.Literal("tool.res"),
    id: Schema.String,
    ok: Schema.Literal(false),
    error: Schema.Struct({ code: Schema.String, message: Schema.String }),
  }),
]);

export type ToolRes = typeof ToolRes.Type;

export const DoToTempod = Schema.Union([DoHello, DoAck, DoReq, ...ToolRes.members]);

export type DoToTempod = typeof DoToTempod.Type;

export const ResError = Schema.Struct({ code: Schema.String, message: Schema.String });

export const TempodRes = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("res"),
    id: Schema.String,
    ok: Schema.Literal(true),
    result: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("res"),
    id: Schema.String,
    ok: Schema.Literal(false),
    error: ResError,
  }),
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
  ev("item.delta", {
    sessionId: Schema.String,
    itemId: Schema.String,
    append: Schema.Struct({ text: Schema.String }),
  }),
  ev("item.updated", { sessionId: Schema.String, itemId: Schema.String, patch: ItemPatch }),
  ev("session.updated", { sessionId: Schema.String, patch: SessionPatch }),
  ev("turn.started", { sessionId: Schema.String, turnId: Schema.String }),
  ev("turn.ended", {
    sessionId: Schema.String,
    turnId: Schema.String,
    stopReason: Schema.NullOr(Schema.String),
    error: Schema.optional(ResError),
    interrupted: Schema.optional(Schema.Boolean),
    usage: Schema.optional(TurnUsage),
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
    /** Additive: "evicted" (LRU close) and "cancelled" (killed after a cancel timeout) are planned exits. */
    reason: Schema.optional(Schema.Literals(["crashed", "evicted", "cancelled"])),
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
  ev("credential.changed", {
    provider: Schema.Literal("codex"),
    content: Schema.String,
    lastRefresh: Schema.Number,
  }),
  ev("credential.invalid", {
    provider: Schema.Literals(["claude", "codex", "openrouter", "anthropic", "openai"]),
  }),
  ev("incarnation.changed", { incarnation: Schema.String }),
  ev("outbox.overflow", { dropped: Schema.Number }),
  ev("tempod.stopping", { reason: Schema.String }),
  ev("log", { level: LogLevel, msg: Schema.String, data: Schema.optional(Schema.Unknown) }),
  ev("environment.proposed", { proposal: EnvironmentProposal }),
  ev("artifact.published", {
    sessionId: Schema.String,
    turnId: Schema.NullOr(Schema.String),
    artifactId: Schema.String,
    version: Schema.Number,
    path: Schema.String,
    name: Schema.String,
    title: Schema.String,
    summary: Schema.optional(Schema.String),
    mime: Schema.String,
    /** 02 names this `kind`, which is the event tag; it is the item content's name instead. */
    artifactKind: ArtifactKind,
    size: Schema.Number,
    sha256: Schema.String,
    stagedPath: Schema.String,
  }),
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

export const TempodToDo = Schema.Union([...TempodRes.members, TempodEventEnvelope, ToolReq]);

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

/** 01 Browser Run: `"run"` drives a Browser Run session, `"local"` the container's Chromium. */
export const BrowserMode = Schema.Literals(["local", "run"]);

export type BrowserMode = typeof BrowserMode.Type;

export const SessionStartResult = Schema.Struct({
  acpSessionId: Schema.String,
  modes: Schema.Array(SessionMode),
  /** Additive: the agent's current mode. */
  modeId: Schema.optional(Schema.NullOr(Schema.String)),
  configOptions: Schema.Array(ConfigOption),
  availableCommands: Schema.Array(AvailableCommand),
  capabilities: Capabilities,
  /** Fields of the profile tempod could not apply; absent from an older tempod means none. */
  profileIssues: Schema.optional(Schema.Array(ProfileIssue)),
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
      /** Additive: "create" follows the 03 checkout per source; "wake" tracks origin/<branch> when it exists. */
      mode: Schema.optional(Schema.Literals(["create", "wake"])),
      initializeEmpty: Schema.optional(Schema.Boolean),
    }),
    Schema.Struct({ headSha: Schema.String, remoteHeadSha: Schema.optional(Schema.NullOr(Schema.String)) }),
    10 * 60_000,
  ),
  "ci.checkout": req(
    Schema.Struct({ url: Schema.String, branch: Schema.String, sha: Schema.String }),
    Schema.Struct({ sha: Schema.String }),
    10 * 60_000,
  ),
  "repo.applyCheckpoint": req(
    Schema.Struct({ bundlePath: Schema.String, checkpointId: Schema.String, branch: Schema.String }),
    Schema.Struct({ headSha: Schema.String }),
    5 * 60_000,
  ),
  "settings.read": req(Schema.Struct({ overrides: SettingsLayer }), SettingsReadResult, 10_000),
  "env.set": req(Schema.Struct({ env: Env }), Empty, 10_000),
  "environment.set": req(Schema.Struct({ summary: EnvironmentSummary }), Empty, 10_000),
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
      browser: BrowserMode,
      profile: Schema.optional(AgentProfile),
      access: Schema.optional(Schema.Literals(["read-only", "write"])),
      acpSessionId: Schema.optional(Schema.NullOr(Schema.String)),
      mcpServers: Schema.optional(Schema.Array(McpServerSpec)),
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
  "session.steer": req(
    Schema.Struct({
      sessionId: Schema.String,
      turnId: Schema.String,
      messageId: Schema.String,
      content: Schema.Array(ContentBlock),
    }),
    Schema.Struct({ outcome: Schema.Literals(["injected", "promptRequired", "unsupported"]) }),
    30_000,
  ),
  "session.setMode": req(Schema.Struct({ sessionId: Schema.String, modeId: Schema.String }), Empty, 30_000),
  "session.setConfig": req(
    Schema.Struct({
      sessionId: Schema.String,
      configId: Schema.String,
      value: Schema.Union([Schema.String, Schema.Boolean]),
    }),
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
  "git.fileDiff": req(
    Schema.Struct({ scope: DiffScope, path: Schema.String }),
    Schema.Struct({ diff: Schema.String }),
    30_000,
  ),
  "git.checkpoint": req(
    Schema.Struct({
      checkpointId: Schema.String,
      turnId: Schema.NullOr(Schema.String),
      reason: CheckpointReason,
    }),
    CheckpointResult,
    2 * 60_000,
  ),
  "git.revert": req(
    Schema.Struct({ checkpointId: Schema.String }),
    Schema.Struct({ headSha: Schema.String }),
    2 * 60_000,
  ),
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
  "git.readFile": req(
    Schema.Struct({ sha: Schema.String, path: Schema.String, maxBytes: Schema.Number }),
    Schema.Struct({
      content: Schema.String,
      encoding: Schema.Literals(["utf8", "base64"]),
      size: Schema.Number,
    }),
    10_000,
  ),
  "artifact.release": req(
    Schema.Struct({ artifactId: Schema.String, version: Schema.Number }),
    Empty,
    10_000,
  ),
  "git.merge": req(
    Schema.Struct({
      baseBranch: Schema.String,
      headBranch: Schema.String,
      method: Schema.Literals(["merge", "squash"]),
      headSha: Schema.String,
      baseSha: Schema.String,
      operationId: Schema.String,
    }),
    Schema.Struct({ commitSha: Schema.String }),
    5 * 60_000,
  ),
  "git.deleteBranch": req(Schema.Struct({ branch: Schema.String }), Empty, 30_000),
  "fs.list": req(Empty, Schema.Struct({ paths: Schema.Array(Schema.String) }), 30_000),
  "fs.read": req(
    Schema.Struct({ path: Schema.String, maxBytes: Schema.Number }),
    Schema.Struct({
      content: Schema.String,
      encoding: Schema.Literals(["utf8", "base64"]),
      size: Schema.Number,
    }),
    10_000,
  ),
  "fs.search": req(
    Schema.Struct({ query: Schema.String, regex: Schema.Boolean, maxResults: Schema.Number }),
    Schema.Struct({
      matches: Schema.Array(Schema.Struct({ path: Schema.String, line: Schema.Number, text: Schema.String })),
    }),
    30_000,
  ),
  /** 01, Shell and dotfiles: copies the owner's shell files into /home/tempo; null restores the image defaults. */
  "dotfiles.apply": req(
    Schema.Struct({ source: Schema.NullOr(Schema.Struct({ url: Schema.String, sha: Schema.String })) }),
    Schema.Struct({ applied: Schema.Array(Schema.String), restored: Schema.Array(Schema.String) }),
    2 * 60_000,
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

/** Turn-summary rule (01, Send a prompt, block 1). */
export const TURN_SUMMARY_RULE =
  "Tempo shows your last message in each turn as the summary of that turn. End every turn with a short final message that answers the user or says what you did. If you changed files, say what you changed and link each file you name as file:///workspace/<path>. If you ran checks, name the command for each check and give its result. If work is left, say what it is. Do not report files you did not change, checks you did not run, or that nothing is left to do.";

export const revertNote = (seq: number): string =>
  `Note: the user reverted the files to the state after turn ${seq}. Changes made after that point are gone.`;

export const PLAYWRIGHT_MCP_SERVER = {
  name: "playwright",
  command: "mcp-server-playwright",
  args: ["--headless", "--isolated", "--browser", "chromium"],
  env: [{ name: "PLAYWRIGHT_BROWSERS_PATH", value: "/opt/ms-playwright" }],
} as const;

/** 01 Browser Run: Playwright MCP reaches the session through `TempoOutbound` rule 11. */
export const BROWSER_RUN_HOST = "browser.tempo.internal";

export const BROWSER_RUN_CDP_ENDPOINT = `wss://${BROWSER_RUN_HOST}/`;

export const PLACEHOLDER = "tempo-placeholder";

/** The MCP server tempod serves to every agent (01, Environments). Its env adds `TEMPO_SESSION_ID`. */
export const TEMPO_MCP_SERVER = {
  name: "tempo",
  command: "/usr/local/bin/tempod",
  args: ["mcp"],
} as const;

export const TEMPO_SESSION_ID_ENV = "TEMPO_SESSION_ID";

export const TEMPO_MCP_SOCKET = "/home/tempo/.tempod/mcp.sock";
