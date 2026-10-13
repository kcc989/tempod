import type * as P from "../src/index.ts";
import { DEFAULT_SETTINGS } from "../src/index.ts";
import * as w from "./world.ts";

const { uid, at, W1, S1, S2, PROJECT_ID } = w;

const ROLE_FILE = {
  description: "Review the change",
  agent: "other",
  model: "default",
  access: "read-only",
  inputs: ["diff"],
  requestable: true,
  on: [],
  limits: { rounds: 1, continues: 2, timeout: "20m", tokens: 0 },
} as const;

const ROLE_INFO = {
  name: "reviewer",
  scope: "builtin",
  sha: "a".repeat(64),
  description: ROLE_FILE.description,
  agent: ROLE_FILE.agent,
  access: ROLE_FILE.access,
  requestable: true,
  on: [],
  limits: ROLE_FILE.limits,
} as const;

const RUN = {
  id: uid(920),
  changeId: uid(921),
  parentRunId: null,
  agentId: uid(923),
  attachmentId: null,
  handle: "reviewer",
  name: "Reviewer",
  agentVersion: 1,
  agentSha: "a".repeat(64),
  triggerEventId: uid(922),
  decisionP: null,
  sessionId: S1,
  originSessionId: S2,
  agent: "codex",
  access: "read-only",
  outputKind: "review",
  status: "running",
  followUpSent: false,
  tokens: 0,
  pinCheckpointId: null,
  warning: null,
  result: null,
  sentTurnId: null,
  errorCode: null,
  errorDetail: null,
  deadlineAt: at(40),
  createdAt: at(1),
  startedAt: at(2),
  endedAt: null,
} as const;

const RUN_STARTED = {
  agentId: uid(923),
  handle: "reviewer",
  agentVersion: 1,
  agentSha: "a".repeat(64),
  agent: "codex",
  access: "read-only",
  outputKind: "review",
} as const;

const RUN_COMPLETED = {
  agentId: uid(923),
  handle: "reviewer",
  result: { status: "pass", summary: "No blocking findings." },
} as const;

const RUN_FAILED = { agentId: uid(923), handle: "reviewer", errorCode: "RUN_LIMIT" } as const;

const RUN_DECIDED = {
  attachmentId: uid(924),
  agentId: uid(923),
  handle: "reviewer",
  hookIndex: 0,
  hookEvent: "prompt",
  outcome: "run",
  threshold: 0.5,
  p: 0.8,
} as const;

const LIFE_EVENT = {
  id: uid(922),
  occurredAt: at(1),
  workspaceId: W1,
  type: "tempo.change.created",
  source: "tempo",
  changeId: uid(921),
  dedupeKey: `change:${uid(921)}:created`,
  payload: { origin: "request", handle: "reviewer", text: "Review auth" },
} as const;

const LIFE_LOG = { seq: 1, event: LIFE_EVENT };

/** Hand-written samples of the shared types. Enums and unions of named types are filled in by gen-fixtures. */
const ENV_ID = uid(901);

const INJECTOR_CODE = "export default { async fetch(request, env) { return fetch(request); } };\n";

const ENVIRONMENT = {
  id: ENV_ID,
  name: "Payments",
  egressPolicy: "allowlist",
  egressAllowlist: ["pypi.org", "*.stripe.com"],
  secrets: [
    { name: "STRIPE_KEY", hosts: ["api.stripe.com"], set: true },
    { name: "LOCAL_DB_URL", hosts: [], set: false },
  ],
  injectors: [
    { name: "aws-sigv4", hosts: ["s3.amazonaws.com"], code: INJECTOR_CODE, sha256: "b".repeat(64) },
  ],
  createdAt: 1_790_000_000_000,
  updatedAt: 1_790_000_100_000,
} as const;

const PROPOSAL = {
  note: "The tests call the Stripe API and pip installs from PyPI.",
  allowlistAdd: ["pypi.org", "files.pythonhosted.org"],
  secrets: [{ name: "STRIPE_KEY", hosts: ["api.stripe.com"] }],
} as const;

const LIBRARY_DEFINITION: P.AgentDefinition = {
  handle: "reviewer",
  name: "Reviewer",
  description: "Reviews code",
  baseAgent: "auto",
  model: "",
  thoughtLevel: "",
  prompt: "Review code.",
  access: "read-only",
  tools: { allow: [], deny: ["Edit"] },
  mcp: { playwright: true, servers: [] },
  outputKind: "review",
};

const LIBRARY_AGENT: P.Agent = {
  ...LIBRARY_DEFINITION,
  id: uid(701),
  version: 1,
  sha: "a".repeat(64),
  starter: null,
  createdAt: at(0),
  updatedAt: at(1),
};

const LIBRARY_SUMMARY: P.AgentSummary = {
  id: LIBRARY_AGENT.id,
  handle: LIBRARY_AGENT.handle,
  name: LIBRARY_AGENT.name,
  description: LIBRARY_AGENT.description,
  baseAgent: LIBRARY_AGENT.baseAgent,
  access: LIBRARY_AGENT.access,
  outputKind: LIBRARY_AGENT.outputKind,
  version: 1,
  sha: LIBRARY_AGENT.sha,
  starter: null,
  updatedAt: at(1),
};

const AGENT_ATTACHMENT: P.AgentAttachment = {
  id: uid(702),
  projectId: PROJECT_ID,
  agentId: LIBRARY_AGENT.id,
  enabled: true,
  hooks: [{ event: "branch.pushed", when: "Does this change touch auth?", threshold: 0.7 }],
  autoSend: false,
  maxRuns: 3,
  timeout: "20m",
  createdAt: at(0),
  updatedAt: at(1),
  agent: LIBRARY_SUMMARY,
};

const AGENT_PROPOSAL: P.AgentProposal = {
  note: "Review auth on push",
  agent: LIBRARY_DEFINITION,
  attach: {
    handle: LIBRARY_DEFINITION.handle,
    hooks: AGENT_ATTACHMENT.hooks,
    autoSend: false,
    maxRuns: 3,
    timeout: "20m",
  },
};

export const SHARED_SAMPLES = {
  AgentProposal: [AGENT_PROPOSAL],
  AgentProposalRecord: [
    { id: uid(704), sessionId: S1, createdAt: at(0), status: "pending", proposal: AGENT_PROPOSAL },
  ],
  AgentLibraryToolResult: [{ agents: [LIBRARY_SUMMARY], attachments: [AGENT_ATTACHMENT] }],
  AgentDefinition: [LIBRARY_DEFINITION],
  Agent: [LIBRARY_AGENT],
  AgentSummary: [LIBRARY_SUMMARY],
  AgentHandle: ["reviewer"],
  AttachmentHook: AGENT_ATTACHMENT.hooks,
  AgentAttachment: [AGENT_ATTACHMENT, { ...AGENT_ATTACHMENT, agent: null }],
  ConversationSummary: [
    {
      conversationId: W1,
      projectId: PROJECT_ID,
      title: "Saved chat",
      branch: "tempo/chat",
      updatedAt: at(10),
    },
  ],
  ConversationArtifact: [
    {
      version: 1,
      conversationId: W1,
      projectId: PROJECT_ID,
      title: "Saved chat",
      branch: "tempo/chat",
      updatedAt: at(10),
      sessions: [],
      turns: [],
      items: [],
    },
  ],
  RoleName: ["reviewer"],
  RoleFinding: [{ path: "src/auth.ts", line: 1, text: "Check auth", blocking: true }],
  RoleResult: [{ status: "pass", summary: "No blocking findings." }],
  RoleLimits: [ROLE_FILE.limits],
  RoleTrigger: [
    { event: "role.run.completed", role: "coder", status: "done" },
    { event: "agent.turn.ended", session: "user", status: "completed" },
  ],
  RoleFile: [ROLE_FILE],
  RoleInfo: [ROLE_INFO],
  Run: [RUN],
  RunResult: [RUN_COMPLETED.result],
  RunFinding: [{ path: "src/auth.ts", line: 1, text: "Check auth", blocking: true }],
  PlanStep: [{ text: "Check auth", files: ["src/auth.ts"] }],
  PlanReport: [{ status: "done", summary: "Plan", steps: [{ text: "Check auth" }], verify: "Run tests" }],
  ReviewReport: [RUN_COMPLETED.result],
  NoteReport: [{ status: "done", summary: "Finished" }],
  RunContent: [{ runId: uid(920) }],
  AgentProposalContent: [{ proposalId: uid(925) }],
  LifecycleRunDecidedPayload: [RUN_DECIDED],
  LifecycleEvent: [
    LIFE_EVENT,
    {
      ...LIFE_EVENT,
      type: "agent.turn.ended",
      source: "agent",
      payload: {
        status: "completed",
        stopReason: "end_turn",
        usage: { totalTokens: 8, inputTokens: 5, outputTokens: 3 },
      },
    },
    {
      ...LIFE_EVENT,
      type: "run.started",
      source: "run",
      payload: RUN_STARTED,
    },
    { ...LIFE_EVENT, type: "run.completed", source: "run", payload: RUN_COMPLETED },
    { ...LIFE_EVENT, type: "run.failed", source: "run", payload: RUN_FAILED },
    { ...LIFE_EVENT, type: "run.decided", source: "tempo", payload: RUN_DECIDED },
    { ...LIFE_EVENT, type: "tempo.change.ended", payload: { status: "done" } },
    {
      ...LIFE_EVENT,
      type: "tempo.branch.pushed",
      payload: { branch: "tempo/test", commitSha: "a".repeat(40) },
    },
    { ...LIFE_EVENT, type: "tempo.check.passed", payload: { prNumber: 25 } },
    { ...LIFE_EVENT, type: "tempo.check.failed", payload: { prNumber: 25 } },
  ],
  LifecycleChangeCreatedPayload: [LIFE_EVENT.payload],
  LifecycleTurnEndedPayload: [
    {
      status: "completed",
      stopReason: "end_turn",
      usage: { totalTokens: 8, inputTokens: 5, outputTokens: 3 },
    },
  ],
  LifecycleRunStartedPayload: [RUN_STARTED],
  LifecycleRunCompletedPayload: [RUN_COMPLETED],
  LifecycleRunFailedPayload: [RUN_FAILED],
  LifecycleChangeEndedPayload: [{ status: "done" }],
  LifecycleBranchPushedPayload: [{ branch: "tempo/test", commitSha: "a".repeat(40) }],
  LifecycleCheckPayload: [{ prNumber: 25 }],
  LifecycleLogEvent: [LIFE_LOG],
  LifecyclePage: [{ events: [LIFE_LOG], nextBeforeSeq: null }],
  LifecycleTrace: [{ chain: [LIFE_LOG], children: [], runs: [RUN] }],
  RolesSettings: [DEFAULT_SETTINGS.roles],
  TurnUsage: [{ totalTokens: 0, inputTokens: 0, outputTokens: 0 }],

  AgentModelOptions: [
    {
      agent: "claude",
      currentValue: "reported-model",
      options: [{ value: "reported-model", name: "Reported model" }],
    },
  ],
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
  McpStdioServer: [w.reviewerDefinition.mcp.servers[0]],
  McpRemoteServer: [
    w.reviewerDefinition.mcp.servers[1],
    { name: "events", type: "sse", url: "https://mcp.example.com/sse", headers: {} },
  ],
  CustomAgentDefinition: [
    w.reviewerDefinition,
    {
      name: "Pi tester",
      description: "",
      baseAgent: "pi",
      model: "",
      thoughtLevel: "",
      systemPrompt: "",
      tools: { allow: ["read", "bash", "mcp__docs__*"], deny: [] },
      mcp: { playwright: true, servers: [] },
    },
  ],
  CustomAgent: [w.reviewerAgent],
  CustomAgentSummary: [
    {
      id: w.CUSTOM_AGENT_ID,
      name: "Reviewer",
      description: "Reviews code without editing it",
      baseAgent: "claude",
      updatedAt: 1_791_000_000_000,
    },
  ],
  SessionCustomAgent: [w.reviewerSession.customAgent],
  ContentBlock: [
    { type: "text", text: "Done." },
    { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
    { type: "resource_link", uri: "file:///workspace/src/app.tsx", name: "app.tsx" },
  ],
  Usage: [{}, w.claudeSession.usage],
  Attachment: [{ id: uid(201), name: "shot.png", mime: "image/png", size: 8 }],
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
      warnings: ["Unknown key scripts.watch in .tempo/settings.yaml"],
      errors: [],
      sources: { "agent.default": "tempo", "scripts.setup": ".tempo", "git.branch_prefix": "default" },
    },
  ],
  Project: [
    w.project,
    { ...w.project, id: uid(2), name: "docs", repoId: 812345679, settings: {}, sortOrder: 1 },
    { ...w.project, id: uid(3), name: "pay", repoId: 812345680, sortOrder: 2, environmentId: ENV_ID },
  ],
  WorkspaceSummary: [w.lisbon, w.oslo, w.kyoto],
  OpProgress: [w.opProgress],
  ChangedFile: w.changedFiles,
  ChangesSummary: [w.changesSummary, { files: [], additions: 0, deletions: 0 }],
  WorkspaceDetail: [
    w.lisbonDetail,
    {
      ...w.lisbonDetail,
      environmentId: ENV_ID,
      environmentProposals: [{ id: uid(903), createdAt: 1_790_000_200_000, proposal: PROPOSAL }],
    },
    w.detail(w.oslo, { pushed: true, setupStatus: "none", op: w.opProgress, imageRef: null }),
    w.detail(w.kyoto, {
      state: "error",
      errorCode: "CLONE_FAILED",
      errorDetail: "repository not found",
      setupStatus: "failed",
      changes: null,
    }),
  ],
  Session: [w.claudeSession, w.codexSession, w.reviewerSession],
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
    w.turn(5, {
      usage: { totalTokens: 15300, inputTokens: 12000, outputTokens: 3300, cachedReadTokens: 9000 },
    }),
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
  ArtifactItemContent: [
    w.artifactContent,
    {
      artifactId: w.ARTIFACT_ID,
      version: 1,
      title: "Login screen",
      name: "login.png",
      path: "/workspace/shots/login.png",
      mime: "image/png",
      artifactKind: "image",
      size: 48213,
    },
  ],
  Artifact: [
    w.artifact,
    { ...w.artifact, version: 1, summary: null, turnId: null, status: "uploading" },
    { ...w.artifact, version: 3, status: "lost" },
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
  McpEnvVar: [{ name: "ROOT", value: "/workspace" }],
  McpHeader: [
    { name: "Authorization", secret: true, value: null, set: true },
    { name: "X-Team", secret: false, value: "core" },
  ],
  McpHeaderInput: [
    { name: "Authorization", secret: true },
    { name: "X-Team", secret: false, value: "core" },
  ],
  McpServer: [
    {
      id: "01jmcp0000000000000000000a",
      name: "linear",
      enabled: true,
      transport: "http",
      command: null,
      args: [],
      env: [],
      url: "https://mcp.linear.app/mcp",
      headers: [{ name: "Authorization", secret: true, value: null, set: true }],
      createdAt: 1760000000000,
      updatedAt: 1760000000000,
    },
    {
      id: "01jmcp0000000000000000000b",
      name: "fs",
      enabled: false,
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
      env: [{ name: "ROOT", value: "/workspace" }],
      url: null,
      headers: [],
      createdAt: 1760000000000,
      updatedAt: 1760000100000,
    },
  ],
  Diagnostics: [w.diagnostics],
  NewSource: [
    { kind: "new", baseBranch: "main" },
    { kind: "branch", branch: "feature/search" },
    { kind: "pr", number: 42 },
  ],
  SecretBinding: [
    { name: "STRIPE_KEY", hosts: ["api.stripe.com"] },
    { name: "LOCAL_DB_URL", hosts: [] },
  ],
  InjectorInput: [{ name: "aws-sigv4", hosts: ["s3.amazonaws.com"], code: INJECTOR_CODE }],
  Injector: ENVIRONMENT.injectors,
  EnvironmentSecret: ENVIRONMENT.secrets,
  Environment: [
    ENVIRONMENT,
    {
      ...ENVIRONMENT,
      id: uid(902),
      name: "Open",
      egressPolicy: "open",
      egressAllowlist: [],
      secrets: [],
      injectors: [],
    },
  ],
  EnvironmentProposal: [
    PROPOSAL,
    {
      note: "Sign S3 requests.",
      egressPolicy: "allowlist",
      injectors: [ENVIRONMENT.injectors[0]].map(({ name, hosts, code }) => ({ name, hosts, code })),
    },
  ],
  PendingEnvironmentProposal: [{ id: uid(903), createdAt: 1_790_000_200_000, proposal: PROPOSAL }],
  AppSetupStatus: [
    { configured: false, installUrl: null },
    { configured: true, installUrl: "https://github.com/apps/tempo-example/installations/new" },
  ],
  ApiMeta: [
    { protocol: 1, serverVersion: "0.1.0", minMacClient: "0.1.0", latestMacClient: null },
    { protocol: 1, serverVersion: "0.2.0", minMacClient: "0.1.0", latestMacClient: "0.2.1" },
    {
      protocol: 1,
      serverVersion: "0.2.0",
      minMacClient: "0.1.0",
      latestMacClient: "0.2.1",
      latestMacClientSha256: "a".repeat(64),
    },
  ],
} satisfies Record<string, ReadonlyArray<unknown>>;

export const CHANNEL_SAMPLES = {
  WsRun: [{ type: "run", run: RUN }],
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
} satisfies Record<string, ReadonlyArray<unknown>>;

const ws = { workspaceId: W1 };

/** At least one input per server function, typed against the function's schema. */
export const INPUT_SAMPLES = {
  resolveAgentProposal: [{ workspaceId: W1, proposalId: uid(704), apply: true }],
  listAgents: [{}],
  getAgent: [{ agentId: LIBRARY_AGENT.id }],
  saveAgent: [
    { definition: LIBRARY_DEFINITION },
    { agentId: LIBRARY_AGENT.id, definition: LIBRARY_DEFINITION },
  ],
  deleteAgent: [{ agentId: LIBRARY_AGENT.id }],
  listProjectAgents: [{ projectId: PROJECT_ID }],
  putProjectAgent: [
    {
      projectId: PROJECT_ID,
      agentId: LIBRARY_AGENT.id,
      enabled: true,
      hooks: AGENT_ATTACHMENT.hooks,
      autoSend: false,
      maxRuns: 3,
      timeout: "20m",
    },
  ],
  deleteProjectAgent: [{ projectId: PROJECT_ID, agentId: LIBRARY_AGENT.id }],
  listRoles: [{}, { workspaceId: W1 }],
  getRoleText: [{ name: "reviewer", scope: "builtin" }],
  putUserRole: [{ name: "reviewer", text: "---\ndescription: Review\nrequestable: true\n---\nReview." }],
  deleteUserRole: [{ name: "reviewer" }],
  reloadRoles: [{ workspaceId: W1 }],
  requestAgent: [{ workspaceId: W1, agentId: uid(923), text: "Review auth", sessionId: S1 }],
  cancelRun: [{ workspaceId: W1, runId: uid(920) }],
  listRuns: [{ workspaceId: W1 }],
  sendRunToChat: [{ workspaceId: W1, runId: uid(920) }],
  listLifecycleEvents: [{ workspaceId: W1, limit: 500 }],
  getTrace: [{ workspaceId: W1, eventId: uid(922) }],
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
  setProjectEnvironment: [
    { projectId: PROJECT_ID, environmentId: ENV_ID },
    { projectId: PROJECT_ID, environmentId: null },
  ],
  listEnvironments: [{}],
  createEnvironment: [{ name: "Payments" }],
  updateEnvironment: [
    { environmentId: ENV_ID, name: "Payments v2" },
    {
      environmentId: ENV_ID,
      egressPolicy: "allowlist",
      egressAllowlist: ["pypi.org"],
      secrets: [{ name: "STRIPE_KEY", hosts: ["api.stripe.com"] }],
      injectors: [{ name: "aws-sigv4", hosts: ["s3.amazonaws.com"], code: INJECTOR_CODE }],
    },
  ],
  deleteEnvironment: [{ environmentId: ENV_ID }],
  setEnvironmentSecret: [{ environmentId: ENV_ID, name: "STRIPE_KEY", value: "fixture-value" }],
  deleteEnvironmentSecret: [{ environmentId: ENV_ID, name: "STRIPE_KEY" }],
  createWorkspace: [
    { projectId: PROJECT_ID, source: { kind: "new", baseBranch: "main" } },
    {
      projectId: PROJECT_ID,
      source: { kind: "pr", number: 42 },
      agent: "codex",
      model: "reported-model",
      prompt: { text: "Fix the flaky test" },
    },
    {
      projectId: PROJECT_ID,
      source: { kind: "branch", branch: "review/auth" },
      customAgentId: w.CUSTOM_AGENT_ID,
    },
  ],
  listProjectConversations: [{ projectId: PROJECT_ID }],
  getProjectConversation: [{ projectId: PROJECT_ID, conversationId: W1 }],
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
  openPreview: [{ ...ws, port: 3000 }],
  rotatePreviewKey: [ws],
  getBrowserLiveView: [ws],
  setBaseBranch: [{ ...ws, baseBranch: "develop" }],
  getDiagnostics: [ws],
  createSession: [
    { ...ws, agent: "codex" },
    { ...ws, agent: "claude", model: "opus", modeId: "plan" },
    { ...ws, agent: "claude", customAgentId: w.CUSTOM_AGENT_ID },
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
  readFileAt: [{ ...ws, path: "src/logo.png", sha: "9f2c1e0b7a6d5c4b3a291807f6e5d4c3b2a19087" }],
  listArtifacts: [ws],
  openArtifact: [{ ...ws, artifactId: w.ARTIFACT_ID, version: 2 }],
  listModels: [{}],
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
  setWorkspaceEnvironment: [
    { ...ws, environmentId: ENV_ID },
    { ...ws, environmentId: null },
  ],
  resolveEnvironmentProposal: [
    { ...ws, proposalId: uid(903), status: "applied" },
    { ...ws, proposalId: uid(903), status: "dismissed" },
  ],
  listMcpServers: [{}],
  saveMcpServer: [
    {
      name: "linear",
      enabled: true,
      transport: "http",
      url: "https://mcp.linear.app/mcp",
      headers: [{ name: "Authorization", secret: true, value: "Bearer lin_api_x" }],
    },
    {
      id: "01jmcp0000000000000000000b",
      name: "fs",
      enabled: true,
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
      env: [],
    },
  ],
  deleteMcpServer: [{ id: "01jmcp0000000000000000000b" }],
  listCustomAgents: [{}],
  getCustomAgent: [{ customAgentId: w.CUSTOM_AGENT_ID }],
  saveCustomAgent: [
    { definition: w.reviewerDefinition },
    { customAgentId: w.CUSTOM_AGENT_ID, definition: { ...w.reviewerDefinition, thoughtLevel: "" } },
  ],
  deleteCustomAgent: [{ customAgentId: w.CUSTOM_AGENT_ID }],
} satisfies { readonly [K in P.FnName]: ReadonlyArray<P.FnInput<K>> };

/** Outputs that are not shared types, by their wire type name. */
export const OUTPUT_SAMPLES = {
  ListProjectConversationsOut: [
    {
      conversations: [
        {
          conversationId: W1,
          projectId: PROJECT_ID,
          title: "Saved chat",
          branch: "tempo/chat",
          updatedAt: at(10),
        },
      ],
      cursor: null,
    },
  ],
  GetRoleTextOut: [{ text: "---\ndescription: Review\nrequestable: true\n---\nReview." }],
  SendRunToChatOut: [{ turnId: uid(926) }],
  RequestAgentOut: [{ changeId: uid(921), runId: uid(920) }],

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
    { prNumber: 12, prState: "merged", checksState: "success", prTitle: "Keep the merged title" },
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
  OpenPreviewOut: [
    {
      url: `https://3000-${W1}.example-previews.com/__tempo/enter?code=k3j9x2m4q8w7e5r1a6s5d4f3g2h1j0k9`,
    },
  ],
  ReadFileAtOut: [{ content: "iVBORw0KGgo=", encoding: "base64", size: 8 }],
  OpenArtifactOut: [
    {
      url: `https://a-${w.ARTIFACT_ID}-${W1}.example-previews.com/__tempo/enter?code=k3j9x2m4q8w7e5r1a6s5d4f3g2h1j0k9`,
    },
  ],
  ListProjectSecretNamesOut: [{ names: ["DATABASE_URL", "STRIPE_KEY"] }],
  GetBrowserLiveViewOut: [
    { url: "https://live.browser.run/ui/view?wss=live.browser.run/api/devtools/browser/s1/page/p1?jwt=x" },
    { url: null },
  ],
} satisfies Record<string, ReadonlyArray<unknown>>;
