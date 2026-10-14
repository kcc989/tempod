import { Run } from "./runs.ts";
import { LifecyclePage, LifecycleTrace } from "./lifecycle.ts";
import { Schema } from "effect";
import {
  AgentId,
  ApiKeyProvider,
  DiffScope,
  EgressStatusFilter,
  MergeMethod,
  ReviewSide,
  IssueState,
  ProjectRole,
  ProjectVisibility,
} from "./enums.ts";
import { EgressPolicy } from "./enums.ts";
import {
  EgressAllowlist,
  Environment,
  EnvironmentName,
  InjectorInputs,
  SecretBindings,
} from "./environments.ts";
import { McpServer, McpServerInput } from "./mcp.ts";
import { Artifact } from "./artifacts.ts";
import { Agent, AgentDefinition, AgentSummary, AgentAttachment, AttachmentOptions } from "./agent-library.ts";
import { EnvName } from "./settings.ts";
import {
  AgentModelOptions,
  ChangedFile,
  ConversationArtifact,
  ConversationSummary,
  CheckRun,
  CheckpointInfo,
  CredentialStatus,
  Diagnostics,
  Mention,
  Project,
  ProjectMember,
  ProjectSummary,
  StarState,
  CiPipeline,
  CiRun,
  CiRunDetail,
  RepositoryCommit,
  RepositoryDetail,
  RepositoryPullRequest,
  RepositoryIssue,
  RepositoryIssueComment,
  RepositoryLabel,
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

/** Optional owner and visibility for new projects (11, Function access). */
const NewProject = { organizationId: opt(NonEmpty), visibility: opt(ProjectVisibility) };

const Offset = opt(N.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)));

export const API = {
  // Artifacts repositories and Tempo pull requests and issues (09).
  createRepository: fn(
    "POST",
    Schema.Struct({ name: NonEmpty, description: opt(S), defaultBranch: opt(NonEmpty), ...NewProject }),
    Project,
  ),
  importRepository: fn(
    "POST",
    Schema.Struct({ name: NonEmpty, url: NonEmpty, description: opt(S), ...NewProject }),
    Project,
  ),
  linkArtifactRepository: fn("POST", Schema.Struct({ name: NonEmpty }), Project),
  getRepository: fn("GET", Schema.Struct({ projectId: S, ref: opt(S), path: opt(S) }), RepositoryDetail),
  getRepositoryFile: fn(
    "GET",
    Schema.Struct({ projectId: S, ref: NonEmpty, path: NonEmpty }),
    Schema.Struct({ content: S, encoding: Schema.Literals(["utf8", "base64"]), size: N }),
  ),
  listRepositoryCommits: fn(
    "GET",
    Schema.Struct({ projectId: S, ref: opt(S), offset: opt(N) }),
    Schema.Array(RepositoryCommit),
  ),
  listRepositoryPullRequests: fn(
    "GET",
    Schema.Struct({ projectId: S, state: opt(Schema.Literals(["open", "closed", "all"])) }),
    Schema.Array(RepositoryPullRequest),
  ),
  getRepositoryPullRequest: fn("GET", Schema.Struct({ projectId: S, number: N }), RepositoryPullRequest),
  createRepositoryPullRequest: fn(
    "POST",
    Schema.Struct({
      projectId: S,
      title: NonEmpty,
      body: S,
      headBranch: NonEmpty,
      baseBranch: NonEmpty,
      draft: B,
    }),
    RepositoryPullRequest,
  ),
  updateRepositoryPullRequest: fn(
    "POST",
    Schema.Struct({
      projectId: S,
      number: N,
      title: opt(NonEmpty),
      body: opt(S),
      state: opt(Schema.Literals(["open", "closed"])),
      draft: opt(B),
    }),
    RepositoryPullRequest,
  ),
  getCiPipeline: fn("GET", Schema.Struct({ projectId: S }), CiPipeline),
  updateCiPipeline: fn("POST", Schema.Struct({ projectId: S, source: S, revision: N }), CiPipeline),
  listCiRuns: fn(
    "GET",
    Schema.Struct({ projectId: S, branch: opt(NonEmpty), offset: opt(N) }),
    Schema.Array(CiRun),
  ),
  getCiRun: fn("GET", Schema.Struct({ projectId: S, runId: NonEmpty }), CiRunDetail),
  startCiRun: fn("POST", Schema.Struct({ projectId: S, branch: NonEmpty }), CiRun),
  rerunCiRun: fn("POST", Schema.Struct({ projectId: S, runId: NonEmpty }), CiRun),
  cancelCiRun: fn("POST", Schema.Struct({ projectId: S, runId: NonEmpty }), CiRun),
  getCiJobLog: fn(
    "GET",
    Schema.Struct({ projectId: S, runId: NonEmpty, job: NonEmpty }),
    Schema.Struct({ text: S, truncated: B }),
  ),
  listRepositoryIssues: fn(
    "GET",
    Schema.Struct({
      projectId: S,
      state: opt(Schema.Literals(["open", "closed", "all"])),
      query: opt(S),
      labelId: opt(S),
      offset: opt(N),
    }),
    Schema.Array(RepositoryIssue),
  ),
  getRepositoryIssue: fn("GET", Schema.Struct({ projectId: S, number: N }), RepositoryIssue),
  createRepositoryIssue: fn(
    "POST",
    Schema.Struct({ projectId: S, title: NonEmpty, body: opt(S), labelIds: opt(Schema.Array(S)) }),
    RepositoryIssue,
  ),
  updateRepositoryIssue: fn(
    "POST",
    Schema.Struct({
      projectId: S,
      number: N,
      title: opt(NonEmpty),
      body: opt(S),
      state: opt(IssueState),
      labelIds: opt(Schema.Array(S)),
    }),
    RepositoryIssue,
  ),
  deleteRepositoryIssue: fn("POST", Schema.Struct({ projectId: S, number: N }), Empty),
  listRepositoryIssueComments: fn(
    "GET",
    Schema.Struct({ projectId: S, number: N, offset: opt(N) }),
    Schema.Array(RepositoryIssueComment),
  ),
  createRepositoryIssueComment: fn(
    "POST",
    Schema.Struct({ projectId: S, number: N, body: NonEmpty }),
    RepositoryIssueComment,
  ),
  updateRepositoryIssueComment: fn(
    "POST",
    Schema.Struct({ projectId: S, number: N, commentId: S, body: NonEmpty }),
    RepositoryIssueComment,
  ),
  deleteRepositoryIssueComment: fn("POST", Schema.Struct({ projectId: S, number: N, commentId: S }), Empty),
  listRepositoryLabels: fn("GET", Schema.Struct({ projectId: S }), Schema.Array(RepositoryLabel)),
  createRepositoryLabel: fn(
    "POST",
    Schema.Struct({ projectId: S, name: NonEmpty, color: S, description: opt(S) }),
    RepositoryLabel,
  ),
  updateRepositoryLabel: fn(
    "POST",
    Schema.Struct({ projectId: S, labelId: S, name: opt(NonEmpty), color: opt(S), description: opt(S) }),
    RepositoryLabel,
  ),
  deleteRepositoryLabel: fn("POST", Schema.Struct({ projectId: S, labelId: S }), Empty),
  listAgents: fn("GET", Empty, Schema.Array(AgentSummary)),
  getAgent: fn("GET", Schema.Struct({ agentId: S }), Agent),
  saveAgent: fn("POST", Schema.Struct({ agentId: opt(S), definition: AgentDefinition }), Agent),
  deleteAgent: fn("POST", Schema.Struct({ agentId: S }), Empty),
  listProjectAgents: fn("GET", Schema.Struct({ projectId: S }), Schema.Array(AgentAttachment)),
  putProjectAgent: fn(
    "POST",
    Schema.Struct({ projectId: S, agentId: S, ...AttachmentOptions.fields }),
    AgentAttachment,
  ),
  deleteProjectAgent: fn("POST", Schema.Struct({ projectId: S, agentId: S }), Empty),
  requestAgent: fn(
    "POST",
    Schema.Struct({ ...W, agentId: S, text: opt(S), sessionId: opt(S) }),
    Schema.Struct({ changeId: S, runId: S }),
  ),
  cancelRun: fn("POST", Schema.Struct({ ...W, runId: S }), Empty),
  listRuns: fn("GET", Schema.Struct({ ...W, changeId: opt(S) }), Schema.Array(Run)),
  resolveAgentProposal: fn("POST", Schema.Struct({ ...W, proposalId: S, apply: B }), Empty),
  sendRunToChat: fn("POST", Schema.Struct({ ...W, runId: S }), Schema.Struct({ turnId: S })),
  listLifecycleEvents: fn(
    "GET",
    Schema.Struct({ ...W, changeId: opt(S), beforeSeq: opt(N), limit: opt(N) }),
    LifecyclePage,
  ),
  getTrace: fn("GET", Schema.Struct({ ...W, eventId: S }), LifecycleTrace),
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
  linkProject: fn("POST", Schema.Struct({ installationId: N, repoId: N, ...NewProject }), Project),
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
  setProjectEnvironment: fn(
    "POST",
    Schema.Struct({ projectId: S, environmentId: Schema.NullOr(S) }),
    Project,
  ),

  // Namespaces, members and stars (11)
  getProject: fn("GET", Schema.Struct({ namespace: NonEmpty, slug: NonEmpty }), ProjectSummary),
  listNamespaceProjects: fn(
    "GET",
    Schema.Struct({ namespace: NonEmpty, offset: Offset }),
    Schema.Array(ProjectSummary),
  ),
  exploreProjects: fn("GET", Schema.Struct({ offset: Offset }), Schema.Array(ProjectSummary)),
  listStarredProjects: fn("GET", Schema.Struct({ offset: Offset }), Schema.Array(ProjectSummary)),
  setProjectVisibility: fn("POST", Schema.Struct({ projectId: S, visibility: ProjectVisibility }), Project),
  listProjectMembers: fn("GET", Schema.Struct({ projectId: S }), Schema.Array(ProjectMember)),
  putProjectMember: fn(
    "POST",
    Schema.Struct({ projectId: S, username: NonEmpty, role: ProjectRole }),
    ProjectMember,
  ),
  deleteProjectMember: fn("POST", Schema.Struct({ projectId: S, userId: NonEmpty }), Empty),
  starProject: fn("POST", Schema.Struct({ projectId: S }), StarState),
  unstarProject: fn("POST", Schema.Struct({ projectId: S }), StarState),

  // Environments (01, Environments)
  listEnvironments: fn("GET", Empty, Schema.Array(Environment)),
  createEnvironment: fn("POST", Schema.Struct({ name: EnvironmentName }), Environment),
  updateEnvironment: fn(
    "POST",
    Schema.Struct({
      environmentId: S,
      name: opt(EnvironmentName),
      egressPolicy: opt(EgressPolicy),
      egressAllowlist: opt(EgressAllowlist),
      secrets: opt(SecretBindings),
      injectors: opt(InjectorInputs),
    }),
    Environment,
  ),
  deleteEnvironment: fn("POST", Schema.Struct({ environmentId: S }), Empty),
  setEnvironmentSecret: fn("POST", Schema.Struct({ environmentId: S, name: EnvName, value: S }), Empty),
  deleteEnvironmentSecret: fn("POST", Schema.Struct({ environmentId: S, name: S }), Empty),

  listProjectConversations: fn(
    "GET",
    Schema.Struct({ projectId: S, cursor: opt(S) }),
    Schema.Struct({ conversations: Schema.Array(ConversationSummary), cursor: Schema.NullOr(S) }),
  ),
  getProjectConversation: fn("GET", Schema.Struct({ projectId: S, conversationId: S }), ConversationArtifact),

  // Workspaces
  createWorkspace: fn(
    "POST",
    Schema.Struct({
      projectId: S,
      source: NewSource,
      agent: opt(AgentId),
      model: opt(S),
      agentId: opt(S),
      prompt: opt(Schema.Struct({ text: NonEmpty })),
    }),
    WorkspaceSummary,
  ),
  listModels: fn("GET", Empty, Schema.Array(AgentModelOptions)),
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
  openPreview: fn("POST", Schema.Struct({ ...W, port: N }), Schema.Struct({ url: S })),
  rotatePreviewKey: fn("POST", Schema.Struct(W), Empty),
  /** POST: each call mints a new Live View link, which is a secret (01, Browser Run). */
  getBrowserLiveView: fn("POST", Schema.Struct(W), Schema.Struct({ url: Schema.NullOr(S) })),
  setBaseBranch: fn("POST", Schema.Struct({ ...W, baseBranch: NonEmpty }), Empty),
  /** `egressHost`: text the host contains, any case. `egressStatus` defaults to `all`. */
  getDiagnostics: fn(
    "GET",
    Schema.Struct({ ...W, egressHost: opt(S), egressStatus: opt(EgressStatusFilter) }),
    Diagnostics,
  ),
  setWorkspaceEnvironment: fn("POST", Schema.Struct({ ...W, environmentId: Schema.NullOr(S) }), Empty),
  resolveEnvironmentProposal: fn(
    "POST",
    Schema.Struct({ ...W, proposalId: S, status: Schema.Literals(["applied", "dismissed"]) }),
    Empty,
  ),

  // Sessions and turns
  createSession: fn(
    "POST",
    Schema.Struct({
      ...W,
      agent: AgentId,
      agentId: opt(S),
      model: opt(S),
      modeId: opt(S),
    }),
    Session,
  ),
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
  readFileAt: fn(
    "GET",
    Schema.Struct({ ...W, path: S, sha: NonEmpty }),
    Schema.Struct({ content: S, encoding: Schema.Literals(["utf8", "base64"]), size: N }),
  ),

  // Artifacts (01, Artifacts): DO and R2 only; they never wake the workspace.
  listArtifacts: fn("GET", Schema.Struct(W), Schema.Array(Artifact)),
  openArtifact: fn(
    "POST",
    Schema.Struct({ ...W, artifactId: NonEmpty, version: N }),
    Schema.Struct({ url: S }),
  ),

  // Agent profiles (01, Agent profiles)
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

  // MCP servers
  listMcpServers: fn("GET", Empty, Schema.Array(McpServer)),
  saveMcpServer: fn("POST", McpServerInput, McpServer),
  deleteMcpServer: fn("POST", Schema.Struct({ id: NonEmpty }), Empty),
} as const;

export type Api = typeof API;

export type FnName = keyof Api;

export type FnInput<K extends FnName> = Api[K]["input"]["Type"];

export type FnOutput<K extends FnName> = Api[K]["output"]["Type"];

// SAFETY: API is a closed literal with exactly the registered FnName keys.
export const FN_NAMES = Object.keys(API) as ReadonlyArray<FnName>;

/** Functions whose input carries a workspaceId: the Worker checks ownership, then calls the WorkspaceDO. */
// SAFETY: the filter keeps exactly the registered functions whose input schema declares workspaceId.
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

/** `GET /api/setup/status`, no auth: whether the GitHub App exists, and its install page. */
export const AppSetupStatus = Schema.Struct({
  configured: Schema.Boolean,
  installUrl: Schema.NullOr(S),
});

export type AppSetupStatus = typeof AppSetupStatus.Type;
