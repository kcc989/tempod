import { Schema } from "effect";
import { AgentId, ApiKeyProvider, DiffScope, MergeMethod, ReviewSide } from "./enums.ts";
import { EnvName } from "./settings.ts";
import {
  ChangedFile,
  CheckRun,
  CheckpointInfo,
  CredentialStatus,
  Diagnostics,
  Mention,
  Project,
  ReviewComment,
  ScriptRun,
  Session,
  Turn,
  WorkspaceDetail,
  WorkspaceSummary,
} from "./types.ts";

/**
 * Server function contract (02, Server functions). One entry per function: method, input and
 * output schemas. The Worker wraps each handler twice (createServerFn and /api/v1/rpc).
 */

const fn = <I extends Schema.Top, O extends Schema.Top>(method: "GET" | "POST", input: I, output: O) => ({
  method,
  input,
  output,
});

const Empty = Schema.Struct({});
const W = { workspaceId: Schema.String };
const S = Schema.String;
const N = Schema.Number;
const B = Schema.Boolean;
const opt = Schema.optional;

export const NewSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("new"), baseBranch: S }),
  Schema.Struct({ kind: Schema.Literal("branch"), branch: S }),
  Schema.Struct({ kind: Schema.Literal("pr"), number: N }),
]);
export type NewSource = typeof NewSource.Type;

export const ScriptRunWithLog = Schema.Struct({ ...ScriptRun.fields, logTail: S });
export type ScriptRunWithLog = typeof ScriptRunWithLog.Type;

const NonEmpty = S.check(Schema.isMinLength(1));

export const API = {
  // Projects and GitHub
  listInstallationRepos: fn(
    "GET",
    Schema.Struct({ installationId: N }),
    Schema.Array(Schema.Struct({ repoId: N, owner: S, name: S, defaultBranch: S, private: B })),
  ),
  listInstallations: fn(
    "GET",
    Empty,
    Schema.Array(
      Schema.Struct({
        installationId: N,
        accountLogin: S,
        accountType: Schema.Literals(["User", "Organization"]),
      }),
    ),
  ),
  linkProject: fn("POST", Schema.Struct({ installationId: N, repoId: N }), Project),
  listProjects: fn("GET", Empty, Schema.Array(Project)),
  /** `settings` is checked by the handler, so bad values and unknown keys give SETTINGS_INVALID. */
  updateProjectSettings: fn(
    "POST",
    Schema.Struct({ projectId: S, settings: Schema.Record(Schema.String, Schema.Unknown) }),
    Project,
  ),
  unlinkProject: fn("POST", Schema.Struct({ projectId: S }), Empty),
  listBranches: fn(
    "GET",
    Schema.Struct({ projectId: S, query: opt(S) }),
    Schema.Array(Schema.Struct({ name: S })),
  ),
  listOpenPullRequests: fn(
    "GET",
    Schema.Struct({ projectId: S }),
    Schema.Array(Schema.Struct({ number: N, title: S, headBranch: S })),
  ),

  // Workspaces
  createWorkspace: fn(
    "POST",
    Schema.Struct({
      projectId: S,
      source: NewSource,
      agent: opt(AgentId),
      prompt: opt(Schema.Struct({ text: NonEmpty })),
    }),
    WorkspaceSummary,
  ),
  listWorkspaces: fn("GET", Schema.Struct({ includeArchived: opt(B) }), Schema.Array(WorkspaceSummary)),
  getWorkspace: fn("GET", Schema.Struct(W), WorkspaceDetail),
  renameWorkspace: fn("POST", Schema.Struct({ ...W, title: S }), Empty),
  renameBranch: fn("POST", Schema.Struct({ ...W, branch: NonEmpty }), Empty),
  setPinned: fn("POST", Schema.Struct({ ...W, pinned: B }), Empty),
  markViewed: fn("POST", Schema.Struct(W), Empty),
  wakeWorkspace: fn("POST", Schema.Struct(W), Empty),
  sleepWorkspace: fn("POST", Schema.Struct(W), Empty),
  archiveWorkspace: fn("POST", Schema.Struct(W), Empty),
  restoreWorkspace: fn("POST", Schema.Struct(W), Empty),
  deleteWorkspace: fn("POST", Schema.Struct(W), Empty),
  rotatePreviewToken: fn("POST", Schema.Struct(W), Schema.Struct({ previewToken: S })),
  setBaseBranch: fn("POST", Schema.Struct({ ...W, baseBranch: NonEmpty }), Empty),
  getDiagnostics: fn("GET", Schema.Struct(W), Diagnostics),

  // Sessions and turns
  createSession: fn("POST", Schema.Struct({ ...W, agent: AgentId, model: opt(S), modeId: opt(S) }), Session),
  closeSession: fn("POST", Schema.Struct({ ...W, sessionId: S }), Empty),
  renameSession: fn("POST", Schema.Struct({ ...W, sessionId: S, title: S }), Empty),
  sendPrompt: fn(
    "POST",
    Schema.Struct({
      ...W,
      sessionId: S,
      text: S,
      mentions: Schema.Array(Mention),
      attachmentIds: Schema.Array(S),
      reviewCommentIds: Schema.Array(S),
      delivery: Schema.optional(Schema.Literals(["queue", "steer"])),
    }),
    Turn,
  ),
  cancelTurn: fn("POST", Schema.Struct({ ...W, turnId: S }), Empty),
  editQueuedTurn: fn("POST", Schema.Struct({ ...W, turnId: S, text: S }), Turn),
  deleteQueuedTurn: fn("POST", Schema.Struct({ ...W, turnId: S }), Empty),
  reorderQueue: fn("POST", Schema.Struct({ ...W, turnIds: Schema.Array(S) }), Empty),
  setSessionMode: fn("POST", Schema.Struct({ ...W, sessionId: S, modeId: S }), Empty),
  setSessionConfig: fn(
    "POST",
    Schema.Struct({ ...W, sessionId: S, configId: S, value: Schema.Union([S, B]) }),
    Empty,
  ),
  respondPermission: fn("POST", Schema.Struct({ ...W, requestId: S, optionId: S }), Empty),

  // Review and git
  getChanges: fn(
    "GET",
    Schema.Struct({ ...W, scope: DiffScope }),
    Schema.Struct({ files: Schema.Array(ChangedFile), baseSha: S, headSha: S }),
  ),
  getFileDiff: fn("GET", Schema.Struct({ ...W, scope: DiffScope, path: S }), Schema.Struct({ diff: S })),
  addReviewComment: fn(
    "POST",
    Schema.Struct({
      ...W,
      path: S,
      lineStart: opt(N),
      lineEnd: opt(N),
      side: opt(ReviewSide),
      body: NonEmpty,
    }),
    ReviewComment,
  ),
  deleteReviewComment: fn("POST", Schema.Struct({ ...W, commentId: S }), Empty),
  listReviewComments: fn("GET", Schema.Struct(W), Schema.Array(ReviewComment)),
  listCheckpoints: fn("GET", Schema.Struct(W), Schema.Array(CheckpointInfo)),
  revertToCheckpoint: fn("POST", Schema.Struct({ ...W, checkpointId: S }), Empty),
  commitAndPush: fn("POST", Schema.Struct({ ...W, message: S }), Schema.Struct({ commitSha: S })),
  createPullRequest: fn(
    "POST",
    Schema.Struct({ ...W, title: S, body: S, draft: B }),
    Schema.Struct({ number: N, url: S }),
  ),
  mergePullRequest: fn("POST", Schema.Struct({ ...W, method: MergeMethod }), Empty),
  refreshPullRequest: fn(
    "POST",
    Schema.Struct(W),
    Schema.Struct({
      prNumber: Schema.NullOr(N),
      prState: Schema.NullOr(S),
      checksState: Schema.NullOr(S),
      prTitle: Schema.optional(Schema.NullOr(S)),
    }),
  ),
  listCheckRuns: fn("GET", Schema.Struct(W), Schema.Array(CheckRun)),

  // Files, scripts, terminals
  listFiles: fn("GET", Schema.Struct(W), Schema.Struct({ paths: Schema.Array(S) })),
  readFile: fn(
    "GET",
    Schema.Struct({ ...W, path: S }),
    Schema.Struct({ content: S, encoding: Schema.Literals(["utf8", "base64"]), size: N }),
  ),
  searchFiles: fn(
    "GET",
    Schema.Struct({ ...W, query: NonEmpty, regex: opt(B) }),
    Schema.Array(Schema.Struct({ path: S, line: N, text: S })),
  ),
  runScript: fn("POST", Schema.Struct({ ...W, scriptId: S }), ScriptRun),
  stopScript: fn("POST", Schema.Struct({ ...W, runId: S }), Empty),
  rerunSetup: fn("POST", Schema.Struct(W), ScriptRun),
  continueAfterSetupFailure: fn("POST", Schema.Struct(W), Empty),
  listTerminals: fn("GET", Schema.Struct(W), Schema.Array(Schema.Struct({ terminalId: S }))),
  /** Additive: script history for the Setup and Run tabs. */
  listScriptRuns: fn("GET", Schema.Struct(W), Schema.Array(ScriptRunWithLog)),

  // Credentials
  getCredentialStatus: fn("GET", Empty, CredentialStatus),
  setClaudeToken: fn(
    "POST",
    Schema.Struct({
      token: S.check(Schema.isBetweenLength(20, 4096), Schema.isPattern(/^\S+$/)),
    }),
    Empty,
  ),
  setCodexAuth: fn("POST", Schema.Struct({ authJson: NonEmpty }), Empty),
  startCodexLogin: fn(
    "POST",
    Empty,
    Schema.Struct({ loginId: S, verificationUrl: S, userCode: S, expiresAt: N, intervalMs: N }),
  ),
  pollCodexLogin: fn(
    "POST",
    Schema.Struct({ loginId: NonEmpty }),
    Schema.Struct({ status: Schema.Literals(["pending", "connected", "expired"]) }),
  ),
  cancelCodexLogin: fn("POST", Schema.Struct({ loginId: NonEmpty }), Empty),
  setApiKey: fn("POST", Schema.Struct({ provider: ApiKeyProvider, key: NonEmpty }), Empty),
  deleteCredential: fn("POST", Schema.Struct({ key: S }), Empty),
  setProjectSecret: fn("POST", Schema.Struct({ projectId: S, name: EnvName, value: S }), Empty),
  deleteProjectSecret: fn("POST", Schema.Struct({ projectId: S, name: S }), Empty),
  listProjectSecretNames: fn(
    "GET",
    Schema.Struct({ projectId: S }),
    Schema.Struct({ names: Schema.Array(S) }),
  ),
} as const;

export type Api = typeof API;
export type FnName = keyof Api;
export type FnInput<K extends FnName> = Api[K]["input"]["Type"];
export type FnOutput<K extends FnName> = Api[K]["output"]["Type"];
export const FN_NAMES = Object.keys(API) as ReadonlyArray<FnName>;

/** Functions whose input carries a workspaceId: the Worker checks ownership, then calls the WorkspaceDO. */
export const WORKSPACE_FNS = FN_NAMES.filter((n) => "workspaceId" in API[n].input.fields) as ReadonlyArray<
  Extract<FnName, { [K in FnName]: "workspaceId" extends keyof FnInput<K> ? K : never }[FnName]>
>;
export type WorkspaceFnName = (typeof WORKSPACE_FNS)[number];

/** Native client meta (07). */
export const ApiMeta = Schema.Struct({
  protocol: Schema.Literal(1),
  serverVersion: S,
  minMacClient: S,
  latestMacClient: Schema.NullOr(S),
  latestMacClientSha256: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
});
export type ApiMeta = typeof ApiMeta.Type;
