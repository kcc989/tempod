import type * as P from "../src/index.ts";
import { DEFAULT_SETTINGS } from "../src/index.ts";
import * as w from "./world.ts";

const { uid, at, W1, S1, S2, PROJECT_ID } = w;

/** Hand-written samples of the shared types. Enums and unions of named types are filled in by gen-fixtures. */
export const SHARED_SAMPLES: Record<string, ReadonlyArray<unknown>> = {
  ErrorBody: [
    { code: "NOT_FOUND", message: "Not found." },
    {
      code: "PUSH_REJECTED",
      message: "Push was rejected. Pull or rebase first.",
      detail: "non-fast-forward",
    },
  ],
  SessionMode: w.claudeSession.modes,
  ConfigSelectOption: [
    { value: "opus", name: "Opus" },
    { value: "default", name: "Default", description: "The recommended model" },
    { value: "gpt-5", name: "GPT-5", description: null },
  ],
  ConfigSelectGroup: [
    { group: "recommended", name: "Recommended", options: [{ value: "gpt-5-codex", name: "GPT-5 Codex" }] },
  ],
  ConfigOption: [...w.claudeSession.configOptions, ...w.codexSession.configOptions],
  AvailableCommand: w.claudeSession.commands,
  PermissionOption: w.permissionOptions,
  PlanEntry: w.planContent.entries,
  ToolLocation: w.toolCallContent.locations,
  ContentBlock: [
    { type: "text", text: "Done." },
    { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
    { type: "resource_link", uri: "file:///workspace/src/app.tsx", name: "app.tsx" },
  ],
  Usage: [{}, w.claudeSession.usage],
  Capabilities: [{}, { loadSession: true, promptCapabilities: { image: true } }],

  RunScript: Object.values(w.settings.scripts.run),
  CustomInstance: [
    { vcpu: 2, memoryMib: 8192, diskMb: 12000 },
    { vcpu: 4, memoryMib: 12288, diskMb: 20000 },
  ],
  Settings: [DEFAULT_SETTINGS, w.settings],
  SettingsLayer: [{}, w.settingsLayer],
  SettingsReadResult: [
    { effective: DEFAULT_SETTINGS, warnings: [], errors: [] },
    {
      effective: w.settings,
      warnings: ["Unknown key scripts.watch in .tempo/settings.toml"],
      errors: [],
      sources: { "agent.default": "tempo", "scripts.setup": ".tempo", "git.branch_prefix": "default" },
    },
  ],

  Project: [
    w.project,
    { ...w.project, id: uid(2), name: "docs", repoId: 812345679, settings: {}, sortOrder: 1 },
  ],
  WorkspaceSummary: [w.lisbon, w.oslo, w.kyoto],
  OpProgress: [w.opProgress],
  ChangedFile: w.changedFiles,
  ChangesSummary: [w.changesSummary, { files: [], additions: 0, deletions: 0 }],
  WorkspaceDetail: [
    w.lisbonDetail,
    w.detail(w.oslo, { pushed: true, setupStatus: "none", op: w.opProgress, imageRef: null }),
    w.detail(w.kyoto, {
      state: "error",
      errorCode: "CLONE_FAILED",
      errorDetail: "repository not found",
      setupStatus: "failed",
      changes: null,
    }),
  ],
  Session: [w.claudeSession, w.codexSession],
  Mention: [{ path: "src/app.tsx" }],
  TurnPrompt: [
    w.turn(1).prompt,
    {
      text: "Address the review comments",
      mentions: [],
      attachmentIds: [uid(401)],
      reviewCommentIds: [uid(701)],
    },
  ],
  Turn: [
    w.turn(1, { prompt: { ...w.turn(1).prompt, mentions: [{ path: "src/app.tsx" }] } }),
    w.turn(2, { status: "running", stopReason: null, checkpointId: null, endedAt: null }),
    w.turn(3, {
      status: "queued",
      queuePos: 0,
      stopReason: null,
      checkpointId: null,
      startedAt: null,
      endedAt: null,
    }),
    w.turn(4, { status: "failed", stopReason: null, errorCode: "AGENT_CRASHED", reverted: true }),
  ],
  UserMessageContent: [w.userMessageContent],
  AgentMessageContent: [
    { text: "Done." },
    { text: "I added the toggle", blocks: [{ type: "text", text: "I added the toggle" }] },
  ],
  AgentThoughtContent: [{ text: "The header lives in src/app.tsx." }],
  ToolCallItemContent: [
    w.toolCallContent,
    {
      toolCallId: "toolu_03",
      title: "bun test",
      toolKind: null,
      locations: [],
      content: [],
      rawInput: null,
      rawOutput: { exitCode: 0, stdout: "12 pass" },
    },
  ],
  PlanContent: [w.planContent, { entries: [] }],
  PermissionContent: [w.permissionContent, { ...w.permissionContent, chosenOptionId: "allow_once" }],
  NoticeContent: [{ level: "info", text: "Claude is ready." }],
  HandoffContent: [{ text: "Earlier, Claude added a dark mode toggle." }],
  RevertMarkerContent: [{ checkpointId: uid(301), toTurnSeq: 1 }],
  ErrorContent: [
    { code: "AGENT_CRASHED", detail: null },
    { code: "CREDENTIAL_INVALID" },
    { code: "INTERNAL", detail: "exit 137" },
  ],
  Item: w.itemsOfEveryKind,
  ScriptRun: [w.scriptRun, w.setupRun],
  ScriptRunWithLog: [{ ...w.setupRun, logTail: "installed 412 packages in 3.1s\n" }],
  ReviewComment: [
    w.reviewComment,
    {
      ...w.reviewComment,
      id: uid(702),
      lineStart: null,
      lineEnd: null,
      side: null,
      status: "sent",
      sentTurnId: uid(102),
    },
  ],
  PermissionRequest: [w.permissionRequest],
  CheckpointInfo: [
    w.checkpoint,
    { id: uid(302), turnId: null, turnSeq: null, reason: "pre_sleep", createdAt: at(500) },
  ],
  CheckRun: [
    {
      name: "test",
      status: "completed",
      conclusion: "failure",
      url: "https://github.com/acme/webapp/actions/runs/1",
    },
    {
      name: "lint",
      status: "in_progress",
      conclusion: null,
      url: "https://github.com/acme/webapp/actions/runs/2",
    },
  ],
  CredentialState: [w.credentialStatus.claude, w.credentialStatus.openrouter],
  CredentialStatus: [w.credentialStatus],
  Diagnostics: [w.diagnostics],
  NewSource: [
    { kind: "new", baseBranch: "main" },
    { kind: "branch", branch: "feature/search" },
    { kind: "pr", number: 42 },
  ],
  ApiMeta: [
    { protocol: 1, serverVersion: "0.1.0", minMacClient: "0.1.0", latestMacClient: null },
    { protocol: 1, serverVersion: "0.2.0", minMacClient: "0.1.0", latestMacClient: "0.2.1" },
  ],
};

export const CHANNEL_SAMPLES: Record<string, ReadonlyArray<unknown>> = {
  WsHello: [
    {
      type: "hello",
      v: 1,
      workspace: w.lisbonDetail,
      sessions: [w.claudeSession, w.codexSession],
      turns: [w.turn(1)],
      itemsRev: 10,
    },
  ],
  WsItems: [
    { type: "items", items: w.itemsOfEveryKind.slice(0, 5), itemsRev: 10, done: false },
    { type: "items", items: w.itemsOfEveryKind.slice(5), itemsRev: 10, done: true },
    { type: "items", items: [], itemsRev: 0, done: true },
  ],
  WsItemUpsert: [{ type: "item.upsert", item: w.itemsOfEveryKind[5], itemsRev: 6 }],
  WsItemDelta: [{ type: "item.delta", itemId: uid(1006), append: { text: " to the header." }, itemsRev: 11 }],
  WsWorkspace: [{ type: "workspace", workspace: w.lisbonDetail }],
  WsSession: [{ type: "session", session: w.claudeSession }],
  WsTurn: [
    {
      type: "turn",
      turn: w.turn(2, { status: "running", stopReason: null, endedAt: null, checkpointId: null }),
    },
  ],
  WsTurnDeleted: [{ type: "turn.deleted", turnId: uid(103) }],
  WsPermission: [{ type: "permission", request: w.permissionRequest }],
  WsScriptOutput: [
    { type: "script.output", runId: uid(601), stream: "stdout", data: "  VITE v7.1.0  ready in 412 ms\n" },
    {
      type: "script.output",
      runId: uid(601),
      stream: "stderr",
      data: "warning: port 3000 in use, trying 3001\n",
    },
  ],
  WsScriptRun: [{ type: "script.run", run: w.scriptRun }],
  WsChanges: [{ type: "changes", ...w.changesSummary }],
  WsCredentialInvalid: [{ type: "credential.invalid", provider: "claude" }],
  WsError: [{ type: "error", code: "SETUP_FAILED", message: "Setup failed. See the Setup tab." }],
  WsPong: [{ type: "pong" }],
  ClientPing: [{ type: "ping" }],
  HubHello: [
    { type: "hello", v: 1, workspaces: [w.lisbon, w.oslo] },
    { type: "hello", v: 1, workspaces: [] },
  ],
  HubWorkspace: [
    { type: "workspace", summary: { ...w.lisbon, state: "ready", attention: "unread", rev: 42 } },
  ],
  HubWorkspaceRemoved: [{ type: "workspace.removed", workspaceId: w.W3 }],
  TerminalResize: [{ type: "resize", cols: 120, rows: 36 }],
  TerminalReady: [{ type: "ready" }],
};

const ws = { workspaceId: W1 };

/** At least one input per server function, typed against the function's schema. */
export const INPUT_SAMPLES: { readonly [K in P.FnName]: ReadonlyArray<P.FnInput<K>> } = {
  listInstallationRepos: [{ installationId: 51234567 }],
  listInstallations: [{}],
  linkProject: [{ installationId: 51234567, repoId: 812345678 }],
  listProjects: [{}],
  updateProjectSettings: [
    { projectId: PROJECT_ID, settings: { agent: { default: "codex" }, git: { archive_on_merge: true } } },
  ],
  unlinkProject: [{ projectId: PROJECT_ID }],
  listBranches: [{ projectId: PROJECT_ID }, { projectId: PROJECT_ID, query: "feat" }],
  listOpenPullRequests: [{ projectId: PROJECT_ID }],
  createWorkspace: [
    { projectId: PROJECT_ID, source: { kind: "new", baseBranch: "main" } },
    {
      projectId: PROJECT_ID,
      source: { kind: "pr", number: 42 },
      agent: "codex",
      prompt: { text: "Fix the flaky test" },
    },
  ],
  listWorkspaces: [{}, { includeArchived: true }],
  getWorkspace: [ws],
  renameWorkspace: [{ ...ws, title: "Dark mode" }],
  renameBranch: [{ ...ws, branch: "tempo/dark-mode" }],
  setPinned: [{ ...ws, pinned: true }],
  markViewed: [ws],
  wakeWorkspace: [ws],
  sleepWorkspace: [ws],
  archiveWorkspace: [ws],
  restoreWorkspace: [ws],
  deleteWorkspace: [ws],
  rotatePreviewToken: [ws],
  setBaseBranch: [{ ...ws, baseBranch: "develop" }],
  getDiagnostics: [ws],
  createSession: [
    { ...ws, agent: "codex" },
    { ...ws, agent: "claude", model: "opus", modeId: "plan" },
  ],
  closeSession: [{ ...ws, sessionId: S2 }],
  renameSession: [{ ...ws, sessionId: S1, title: "Reviewer" }],
  sendPrompt: [
    {
      ...ws,
      sessionId: S1,
      text: "Add a dark mode toggle",
      mentions: [{ path: "src/app.tsx" }],
      attachmentIds: [uid(401)],
      reviewCommentIds: [],
    },
  ],
  cancelTurn: [{ ...ws, turnId: uid(102) }],
  editQueuedTurn: [{ ...ws, turnId: uid(103), text: "Also add tests" }],
  deleteQueuedTurn: [{ ...ws, turnId: uid(103) }],
  reorderQueue: [{ ...ws, turnIds: [uid(104), uid(103)] }],
  setSessionMode: [{ ...ws, sessionId: S1, modeId: "plan" }],
  setSessionConfig: [
    { ...ws, sessionId: S1, configId: "model", value: "opus" },
    { ...ws, sessionId: S2, configId: "web_search", value: true },
  ],
  respondPermission: [{ ...ws, requestId: uid(501), optionId: "allow_once" }],
  getChanges: [{ ...ws, scope: "branch" }],
  getFileDiff: [{ ...ws, scope: "uncommitted", path: "src/app.tsx" }],
  addReviewComment: [
    {
      ...ws,
      path: "src/app.tsx",
      lineStart: 12,
      lineEnd: 14,
      side: "new",
      body: "Move this into the header.",
    },
    { ...ws, path: "src/app.tsx", body: "Split this file." },
  ],
  deleteReviewComment: [{ ...ws, commentId: uid(701) }],
  listReviewComments: [ws],
  listCheckpoints: [ws],
  revertToCheckpoint: [{ ...ws, checkpointId: uid(301) }],
  commitAndPush: [{ ...ws, message: "Add dark mode toggle" }],
  createPullRequest: [{ ...ws, title: "Add dark mode toggle", body: "- Add dark mode toggle", draft: false }],
  mergePullRequest: [{ ...ws, method: "squash" }],
  refreshPullRequest: [ws],
  listCheckRuns: [ws],
  listFiles: [ws],
  readFile: [{ ...ws, path: "src/app.tsx" }],
  searchFiles: [
    { ...ws, query: "useTheme" },
    { ...ws, query: "use[A-Z]\\w+", regex: true },
  ],
  runScript: [{ ...ws, scriptId: "dev" }],
  stopScript: [{ ...ws, runId: uid(601) }],
  rerunSetup: [ws],
  continueAfterSetupFailure: [ws],
  listTerminals: [ws],
  listScriptRuns: [ws],
  getCredentialStatus: [{}],
  setClaudeToken: [{ token: "fixture-claude-token-not-a-secret" }],
  setCodexAuth: [{ authJson: '{"tokens":{"note":"fixture"}}' }],
  startCodexLogin: [{}],
  pollCodexLogin: [{ loginId: "fixture-login-id" }],
  cancelCodexLogin: [{ loginId: "fixture-login-id" }],
  setApiKey: [{ provider: "openrouter", key: "fixture-openrouter-key" }],
  deleteCredential: [{ key: "codex" }],
  setProjectSecret: [{ projectId: PROJECT_ID, name: "DATABASE_URL", value: "fixture-value" }],
  deleteProjectSecret: [{ projectId: PROJECT_ID, name: "DATABASE_URL" }],
  listProjectSecretNames: [{ projectId: PROJECT_ID }],
};

/** Outputs that are not shared types, by their wire type name. */
export const OUTPUT_SAMPLES: Record<string, ReadonlyArray<unknown>> = {
  Empty: [{}],
  StartCodexLoginOut: [
    {
      loginId: "fixture-login-id",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
      expiresAt: 1_800_000_000_000,
      intervalMs: 5000,
    },
  ],
  PollCodexLoginOut: [{ status: "pending" }, { status: "connected" }, { status: "expired" }],
  ListInstallationReposItem: [
    { repoId: 812345678, owner: "acme", name: "webapp", defaultBranch: "main", private: true },
    { repoId: 812345679, owner: "acme", name: "docs", defaultBranch: "trunk", private: false },
  ],
  ListInstallationsItem: [
    { installationId: 51234567, accountLogin: "acme", accountType: "Organization" },
    { installationId: 51234568, accountLogin: "casey", accountType: "User" },
  ],
  ListBranchesItem: [{ name: "main" }, { name: "feature/search" }],
  ListOpenPullRequestsItem: [{ number: 42, title: "Fix flaky checkout test", headBranch: "tempo/oslo" }],
  GetChangesOut: [
    {
      files: w.changedFiles,
      baseSha: "9f2c1e0b7a6d5c4b3a291807f6e5d4c3b2a19087",
      headSha: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
    },
  ],
  GetFileDiffOut: [
    {
      diff: "diff --git a/src/app.tsx b/src/app.tsx\n--- a/src/app.tsx\n+++ b/src/app.tsx\n@@ -10,3 +10,3 @@\n export function App() {\n-  return <Header />;\n+  return <Header toggle />;\n }\n",
    },
  ],
  CommitAndPushOut: [{ commitSha: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d" }],
  CreatePullRequestOut: [{ number: 43, url: "https://github.com/acme/webapp/pull/43" }],
  RefreshPullRequestOut: [
    { prNumber: 42, prState: "open", checksState: "pending" },
    { prNumber: null, prState: null, checksState: null },
  ],
  ListFilesOut: [{ paths: ["package.json", "src/app.tsx", "src/theme/toggle.tsx"] }],
  ReadFileOut: [
    { content: "export const answer = 42;\n", encoding: "utf8", size: 26 },
    { content: "iVBORw0KGgo=", encoding: "base64", size: 8 },
  ],
  SearchFilesItem: [{ path: "src/theme/toggle.tsx", line: 3, text: "export const useTheme = () => {" }],
  ListTerminalsItem: [{ terminalId: "t1" }, { terminalId: "t2" }],
  RotatePreviewTokenOut: [{ previewToken: "q8w7e5r1k3j9x2m4" }],
  ListProjectSecretNamesOut: [{ names: ["DATABASE_URL", "STRIPE_KEY"] }],
};
