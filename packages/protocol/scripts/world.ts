import type * as P from "../src/index.ts";
import { DEFAULT_SETTINGS } from "../src/index.ts";

/** A small, fixed Tempo deployment that the fixtures describe: one project, a few workspaces and sessions. */

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** A deterministic lowercase ULID-shaped id. */
export const uid = (n: number): string => {
  let out = "";
  let v = n;
  for (let i = 0; i < 22; i++) {
    out = CROCKFORD[v % 32]! + out;
    v = Math.floor(v / 32);
  }
  return `01k7${out}`;
};

/** 2026-10-11T09:00:00Z. */
export const T0 = 1_791_709_200_000;
export const at = (seconds: number): number => T0 + seconds * 1000;

export const PROJECT_ID = uid(1);
export const W1 = uid(11);
export const W2 = uid(12);
export const W3 = uid(13);
export const W4 = uid(14);
export const S1 = uid(21);
export const S2 = uid(22);

export const settings: P.Settings = {
  ...DEFAULT_SETTINGS,
  scripts: {
    setup: "bun install",
    archive: "",
    run_mode: "concurrent",
    auto_run_after_setup: true,
    run: {
      dev: { command: "bun run dev", cwd: ".", default: true },
      test: { command: "bun test", cwd: "packages/api", default: false },
    },
  },
  environment: {
    instance: { vcpu: 2, memoryMib: 8192, diskMb: 12000 },
    sleep_after_idle_minutes: 30,
    egress_policy: "allowlist",
    egress_allowlist: ["registry.npmjs.org", "*.githubusercontent.com"],
  },
  environment_variables: { NODE_ENV: "development" },
};

export const settingsLayer: P.SettingsLayer = {
  agent: { default: "claude" },
  scripts: { setup: "bun install", run: { dev: { command: "bun run dev" } } },
  environment: { instance: "standard-4", egress_allowlist: ["registry.npmjs.org"] },
};

export const project: P.Project = {
  id: PROJECT_ID,
  installationId: 51234567,
  repoId: 812345678,
  owner: "acme",
  name: "webapp",
  defaultBranch: "main",
  settings: settingsLayer,
  sortOrder: 0,
};

export const summary = (
  id: string,
  overrides: Partial<P.WorkspaceSummary> & Pick<P.WorkspaceSummary, "slug" | "rev">,
): P.WorkspaceSummary => ({
  id,
  projectId: PROJECT_ID,
  title: "",
  branch: `tempo/${overrides.slug}`,
  baseBranch: "main",
  state: "ready",
  attention: "none",
  defaultAgent: "claude",
  prNumber: null,
  prState: null,
  checksState: null,
  pinned: false,
  lastActivityAt: at(0),
  createdAt: at(-86_400),
  archivedAt: null,
  ...overrides,
});

export const lisbon = summary(W1, {
  slug: "lisbon",
  title: "Add dark mode toggle",
  state: "working",
  rev: 41,
  lastActivityAt: at(60),
});
export const oslo = summary(W2, {
  slug: "oslo",
  title: "Fix flaky checkout test",
  state: "sleeping",
  attention: "unread",
  prNumber: 42,
  prState: "open",
  checksState: "failure",
  pinned: true,
  rev: 17,
  lastActivityAt: at(-3_600),
});
export const kyoto = summary(W3, {
  slug: "kyoto",
  title: "Upgrade to React 19",
  state: "archived",
  prNumber: 38,
  prState: "merged",
  checksState: "success",
  rev: 9,
  archivedAt: at(-7_200),
  lastActivityAt: at(-7_200),
});

export const changedFiles: ReadonlyArray<P.ChangedFile> = [
  { path: "src/theme/toggle.tsx", status: "added", additions: 48, deletions: 0 },
  { path: "src/app.tsx", status: "modified", additions: 6, deletions: 2 },
  { path: "src/styles/colors.css", oldPath: "src/colors.css", status: "renamed", additions: 3, deletions: 1 },
];

export const changesSummary: P.ChangesSummary = { files: changedFiles, additions: 57, deletions: 3 };

export const opProgress: P.OpProgress = {
  kind: "wake",
  status: "running",
  step: "repo.clone",
  steps: [
    { name: "container.start", status: "done", ms: 4210 },
    { name: "tempod.hello", status: "done", ms: 380 },
    { name: "repo.clone", status: "running", ms: null },
    { name: "setup", status: "pending", ms: null },
  ],
};

export const detail = (
  s: P.WorkspaceSummary,
  overrides: Partial<P.WorkspaceDetail> = {},
): P.WorkspaceDetail => ({
  ...s,
  errorCode: null,
  errorDetail: null,
  setupStatus: "succeeded",
  pushed: false,
  ports: [],
  settings,
  runningTurnId: null,
  queue: [],
  imageRef: "registry.cloudflare.com/acme/tempo-workspace:2026-10-10",
  op: null,
  ...overrides,
});

export const lisbonDetail = detail(lisbon, {
  ports: [{ port: 3000, url: `https://3000-${W1}.example-previews.com` }],
  settingsWarnings: ["Unknown key scripts.watch in .tempo/settings.toml"],
  settingsErrors: [],
  settingsSources: { "agent.default": "tempo", "scripts.setup": ".tempo", "environment.instance": "default" },
  changes: changesSummary,
  hasUnpushedCommits: false,
});

export const claudeSession: P.Session = {
  id: S1,
  agent: "claude",
  title: "Claude",
  status: "idle",
  modeId: "default",
  modes: [
    { id: "default", name: "Default", description: "Ask before editing files" },
    { id: "acceptEdits", name: "Accept Edits", description: null },
    { id: "plan", name: "Plan Mode" },
  ],
  configOptions: [
    {
      id: "model",
      name: "Model",
      type: "select",
      category: "model",
      currentValue: "default",
      options: [
        { value: "default", name: "Default", description: "The recommended model" },
        { value: "opus", name: "Opus" },
      ],
    },
  ],
  config: { model: "default" },
  commands: [
    { name: "review", description: "Review the current changes" },
    { name: "init", description: null, input: { hint: "what to document" } },
  ],
  usage: { inputTokens: 18234, outputTokens: 2211, cachedReadTokens: 12000 },
  sortOrder: 0,
};

export const codexSession: P.Session = {
  id: S2,
  agent: "codex",
  title: "Codex",
  status: "starting",
  modeId: null,
  modes: [],
  configOptions: [
    {
      id: "model",
      name: "Model",
      type: "select",
      category: "model",
      currentValue: "gpt-5-codex",
      options: [
        {
          group: "recommended",
          name: "Recommended",
          options: [{ value: "gpt-5-codex", name: "GPT-5 Codex" }],
        },
        { group: "other", name: "Other", options: [{ value: "gpt-5", name: "GPT-5", description: null }] },
      ],
    },
    {
      id: "web_search",
      name: "Web search",
      type: "boolean",
      description: "Let the agent search the web",
      currentValue: false,
    },
  ],
  config: {},
  commands: [],
  usage: {},
  sortOrder: 1,
};

export const turn = (n: number, overrides: Partial<P.Turn> = {}): P.Turn => ({
  id: uid(100 + n),
  sessionId: S1,
  seq: n,
  status: "completed",
  queuePos: null,
  prompt: { text: `Prompt ${n}`, mentions: [], attachmentIds: [], reviewCommentIds: [] },
  stopReason: "end_turn",
  errorCode: null,
  checkpointId: uid(300 + n),
  reverted: false,
  queuedAt: at(n * 100),
  startedAt: at(n * 100 + 1),
  endedAt: at(n * 100 + 60),
  ...overrides,
});

const itemBase = (n: number, turnId: string | null, rev: number, seconds: number) => ({
  id: uid(1000 + n),
  sessionId: S1,
  turnId,
  rev,
  createdAt: at(seconds),
  updatedAt: at(seconds),
});

type ItemInit<K extends P.Item["kind"]> = {
  readonly n: number;
  readonly turnId?: string | null;
  readonly rev: number;
  readonly seconds: number;
  readonly status?: P.Item["status"];
  readonly sessionId?: string;
  readonly content: P.ItemOf<K>["content"];
};

export const item = <K extends P.Item["kind"]>(kind: K, init: ItemInit<K>): P.Item =>
  ({
    ...itemBase(init.n, init.turnId === undefined ? uid(101) : init.turnId, init.rev, init.seconds),
    ...(init.sessionId ? { sessionId: init.sessionId } : {}),
    kind,
    status: init.status ?? "completed",
    content: init.content,
  }) as P.Item;

export const userMessageContent: P.UserMessageContent = {
  text: "Add a dark mode toggle to the header. Keep @src/app.tsx tidy.",
  mentions: [{ path: "src/app.tsx" }],
  attachments: [{ id: uid(401), name: "mockup.png", mime: "image/png" }],
  reviewCommentIds: [],
};

export const toolCallContent: P.ToolCallItemContent = {
  toolCallId: "toolu_01",
  title: "Edit src/app.tsx",
  toolKind: "edit",
  locations: [{ path: "src/app.tsx", line: 12 }, { path: "src/theme/toggle.tsx" }],
  content: [{ type: "diff", path: "src/app.tsx", oldText: "<Header />", newText: "<Header toggle />" }],
  rawInput: { file_path: "src/app.tsx", old_string: "<Header />", new_string: "<Header toggle />" },
};

export const planContent: P.PlanContent = {
  entries: [
    { content: "Add a theme context", priority: "high", status: "completed" },
    { content: "Build the toggle", priority: "medium", status: "in_progress" },
    { content: "Persist the choice", priority: "low", status: "pending" },
  ],
};

export const permissionOptions: ReadonlyArray<P.PermissionOption> = [
  { optionId: "allow_once", name: "Allow", kind: "allow_once" },
  { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject_once", name: "Reject", kind: "reject_once" },
];

export const permissionContent: P.PermissionContent = {
  requestId: uid(501),
  toolCallId: "toolu_02",
  title: "Run bun test",
  options: permissionOptions,
  chosenOptionId: null,
};

/** One item of every kind, in the order a turn makes them. */
export const itemsOfEveryKind: ReadonlyArray<P.Item> = [
  item("user_message", { n: 1, rev: 1, seconds: 100, content: userMessageContent }),
  item("agent_thought", {
    n: 2,
    rev: 2,
    seconds: 101,
    content: { text: "The header lives in src/app.tsx." },
  }),
  item("plan", { n: 3, rev: 3, seconds: 102, content: planContent }),
  item("tool_call", { n: 4, rev: 4, seconds: 103, status: "in_progress", content: toolCallContent }),
  item("permission", { n: 5, rev: 5, seconds: 104, status: "pending", content: permissionContent }),
  item("agent_message", {
    n: 6,
    rev: 6,
    seconds: 105,
    status: "streaming",
    content: { text: "I added the toggle", blocks: [{ type: "text", text: "I added the toggle" }] },
  }),
  item("notice", { n: 7, rev: 7, seconds: 106, content: { level: "warning", text: "Context is 80% full." } }),
  item("handoff", {
    n: 8,
    rev: 8,
    seconds: 107,
    turnId: null,
    content: { text: "Earlier, Claude added a dark mode toggle in src/theme/toggle.tsx." },
  }),
  item("revert_marker", {
    n: 9,
    rev: 9,
    seconds: 108,
    turnId: null,
    content: { checkpointId: uid(301), toTurnSeq: 1 },
  }),
  item("error", {
    n: 10,
    rev: 10,
    seconds: 109,
    status: "failed",
    content: { code: "AGENT_CRASHED", detail: null },
  }),
];

export const permissionRequest: P.PermissionRequest = {
  requestId: uid(501),
  sessionId: S1,
  turnId: uid(101),
  itemId: uid(1005),
  title: "Run bun test",
  options: permissionOptions,
};

export const scriptRun: P.ScriptRun = {
  id: uid(601),
  kind: "run",
  scriptId: "dev",
  command: "bun run dev",
  status: "running",
  exitCode: null,
  signal: null,
  startedAt: at(200),
  endedAt: null,
};

export const setupRun: P.ScriptRun = {
  id: uid(602),
  kind: "setup",
  scriptId: null,
  command: "bun install",
  status: "exited",
  exitCode: 0,
  signal: null,
  startedAt: at(-60),
  endedAt: at(-20),
};

export const reviewComment: P.ReviewComment = {
  id: uid(701),
  path: "src/app.tsx",
  lineStart: 12,
  lineEnd: 14,
  side: "new",
  body: "Move the toggle into the header component.",
  status: "draft",
  sentTurnId: null,
  createdAt: at(300),
};

export const checkpoint: P.CheckpointInfo = {
  id: uid(301),
  turnId: uid(101),
  turnSeq: 1,
  reason: "turn_end",
  createdAt: at(160),
};

export const credentialStatus: P.CredentialStatus = {
  claude: { set: true, updatedAt: at(-86_400) },
  codex: { set: true, updatedAt: at(-86_400), lastRefresh: at(-3_600) },
  openrouter: { set: false, updatedAt: null },
  anthropic: { set: false, updatedAt: null },
  openai: { set: true, updatedAt: at(-172_800) },
};

export const diagnostics: P.Diagnostics = {
  ops: [
    {
      id: uid(801),
      kind: "wake",
      status: "done",
      step: "setup",
      attempt: 1,
      errorCode: null,
      errorDetail: null,
      timings: { "container.start": 4210, "tempod.hello": 380, "repo.clone": 2900 },
      createdAt: at(-120),
      updatedAt: at(-100),
    },
    {
      id: uid(802),
      kind: "commit_push",
      status: "failed",
      step: "git.push",
      attempt: 3,
      errorCode: "PUSH_REJECTED",
      errorDetail: "non-fast-forward",
      timings: {},
      createdAt: at(400),
      updatedAt: at(420),
    },
  ],
  container: {
    state: "working",
    running: true,
    instance: "2 vCPU, 8 GiB",
    imageRef: "registry.cloudflare.com/acme/tempo-workspace:2026-10-10",
    snapshots: [
      {
        id: uid(901),
        name: "pre_sleep",
        sizeBytes: 734_003_200,
        imageRef: "registry.cloudflare.com/acme/tempo-workspace:2026-10-10",
        createdAt: at(-90_000),
        lastRestoredAt: at(-120),
        unusable: false,
      },
    ],
    tempodVersion: "0.1.0",
    incarnation: uid(902),
  },
  logs: [
    { ts: at(-110), level: "info", msg: "op.step", data: { op: "wake", step: "repo.clone" } },
    { ts: at(-100), level: "warn", msg: "tempod.reconnect" },
  ],
  egress: [
    { ts: at(250), method: "GET", host: "registry.npmjs.org", path: "/react", status: 200, ms: 84, rule: 9 },
  ],
  sessions: [
    { id: S1, agent: "claude", acpSessionId: "a1b2c3", capabilities: { loadSession: true }, live: true },
    { id: S2, agent: "codex", acpSessionId: null, capabilities: {}, live: false },
  ],
};
