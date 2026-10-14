import type { CredentialStatus, Diagnostics, Project } from "@tempo/protocol";
import { describe, expect, it } from "vitest";
import {
  checkApiKey,
  checkClaudeToken,
  checkCodexAuth,
  isApiKeyProvider,
  LOGIN_ROWS,
  loginState,
} from "~/ui/components/dialogs/credentials-model";
import {
  capabilityList,
  diagnosticsInput,
  EGRESS_STATUS_FILTERS,
  egressTone,
  hasEgressFilter,
  isBlocked,
  isEgressStatusFilter,
  logTone,
  opTone,
  timingRows,
} from "~/ui/components/dialogs/diagnostics-model";
import {
  agentsWithLogin,
  buildSource,
  createInput,
  emptySource,
  filterPullRequests,
  initialAgent,
  initialModel,
  modelChoices,
  isSourceTab,
} from "~/ui/components/dialogs/new-workspace-model";

const off = { set: false, updatedAt: null };

const on = { set: true, updatedAt: 1000 };

const status = (over: Partial<CredentialStatus> = {}): CredentialStatus => ({
  claude: off,
  codex: { ...off, lastRefresh: null },
  openrouter: off,
  anthropic: off,
  openai: off,
  ...over,
});

const project: Pick<Project, "id" | "defaultBranch" | "settings"> = {
  id: "p1",
  defaultBranch: "main",
  settings: {},
};

describe("Settings → Logins checks", () => {
  const secret = "sk-ant-oat01-SECRETVALUE-do-not-echo";

  it("never echoes the value in an error", () => {
    for (const msg of [
      checkClaudeToken(`${secret} x`),
      checkApiKey(`${secret} x`),
      checkCodexAuth(`{"tokens":{"access_token":"${secret}"}}`),
      checkCodexAuth(`${secret}`),
    ]) {
      expect(msg).not.toBeNull();
      expect(msg).not.toContain("SECRETVALUE");
    }
  });

  it("checks the Claude token as setClaudeToken does (no spaces, 20 to 4096)", () => {
    expect(checkClaudeToken(secret)).toBeNull();
    expect(checkClaudeToken(`  ${secret}  `)).toBeNull();
    expect(checkClaudeToken("")).not.toBeNull();
    expect(checkClaudeToken("short")).not.toBeNull();
    expect(checkClaudeToken("x".repeat(4097))).not.toBeNull();
  });

  it("checks auth.json as setCodexAuth does", () => {
    const good = JSON.stringify({
      tokens: { access_token: "a", refresh_token: "r" },
      last_refresh: "2026-10-01T00:00:00Z",
    });

    expect(checkCodexAuth(good)).toBeNull();
    expect(checkCodexAuth("")).not.toBeNull();
    expect(checkCodexAuth("{")).not.toBeNull();
    expect(
      checkCodexAuth(JSON.stringify({ tokens: { access_token: "a" }, last_refresh: "2026-10-01" })),
    ).not.toBeNull();
    expect(
      checkCodexAuth(
        JSON.stringify({ tokens: { access_token: "a", refresh_token: "r" }, last_refresh: "never" }),
      ),
    ).not.toBeNull();
  });

  it("checks API keys", () => {
    expect(checkApiKey("sk-or-123")).toBeNull();
    expect(checkApiKey(" ")).not.toBeNull();
    expect(checkApiKey("a b")).not.toBeNull();
  });

  it("lists the five 02 credential keys", () => {
    expect(LOGIN_ROWS.map((r) => r.key)).toEqual([
      "claude.oauth_token",
      "codex.auth_json",
      "openrouter.api_key",
      "anthropic.api_key",
      "openai.api_key",
    ]);
    expect(LOGIN_ROWS.filter((r) => isApiKeyProvider(r.provider)).map((r) => r.provider)).toEqual([
      "openrouter",
      "anthropic",
      "openai",
    ]);
  });

  it("shows set or not set and when", () => {
    expect(loginState(status(), "claude")).toEqual({ set: false, updated: null });
    expect(loginState(status({ claude: on }), "claude", 1000 + 5 * 60_000)).toEqual({
      set: true,
      updated: "Updated 5 min ago",
    });
    expect(loginState(status({ openai: { set: true, updatedAt: null } }), "openai")).toEqual({
      set: true,
      updated: null,
    });
    expect(loginState(undefined, "codex")).toEqual({ set: false, updated: null });
  });
});

describe("New workspace", () => {
  it("builds each source, with the project's default branch as the default base", () => {
    expect(buildSource(emptySource(), project)).toEqual({ kind: "new", baseBranch: "main" });
    expect(buildSource({ ...emptySource(), baseBranch: "dev" }, project)).toEqual({
      kind: "new",
      baseBranch: "dev",
    });
    expect(buildSource({ ...emptySource(), tab: "branch" }, project)).toBeNull();
    expect(buildSource({ ...emptySource(), tab: "branch", branch: "fix" }, project)).toEqual({
      kind: "branch",
      branch: "fix",
    });
    expect(buildSource({ ...emptySource(), tab: "pr" }, project)).toBeNull();
    expect(buildSource({ ...emptySource(), tab: "pr", prNumber: 7 }, project)).toEqual({
      kind: "pr",
      number: 7,
    });
    expect(isSourceTab("pr")).toBe(true);
    expect(isSourceTab("tag")).toBe(false);
  });

  it("offers only agents with a login", () => {
    expect(agentsWithLogin(status())).toEqual([]);
    expect(agentsWithLogin(status({ openrouter: on }))).toEqual(["opencode", "pi"]);
    expect(agentsWithLogin(status({ anthropic: on, codex: { ...on, lastRefresh: null } }))).toEqual([
      "claude",
      "codex",
    ]);
    expect(agentsWithLogin(undefined)).toEqual([]);
  });

  it("starts with the project's default agent, else Claude, else the first with a login", () => {
    expect(initialAgent(["claude", "codex"], { settings: { agent: { default: "codex" } } })).toBe("codex");
    expect(initialAgent(["claude", "codex"], { settings: { agent: { default: "pi" } } })).toBe("claude");
    expect(initialAgent(["opencode", "pi"], { settings: {} })).toBe("opencode");
    expect(initialAgent([], undefined)).toBeNull();
  });

  it("builds createWorkspace input with an optional agent and prompt", () => {
    expect(createInput(project, emptySource(), "claude", "  Fix it  ")).toEqual({
      projectId: "p1",
      source: { kind: "new", baseBranch: "main" },
      agent: "claude",
      prompt: { text: "Fix it" },
    });
    expect(createInput(project, emptySource(), null, "   ")).toEqual({
      projectId: "p1",
      source: { kind: "new", baseBranch: "main" },
    });
    expect(createInput(project, { ...emptySource(), tab: "branch" }, "claude", "x")).toBeNull();
  });

  it("routes reported grouped models to the logged-in agent and honours the configured default", () => {
    const reports = [
      {
        agent: "claude" as const,
        currentValue: "same-id",
        options: [{ value: "same-id", name: "Claude model" }],
      },
      {
        agent: "codex" as const,
        currentValue: "same-id",
        options: [
          { value: "same-id", name: "Codex model" },
          { value: "custom", name: "Configured Codex model" },
        ],
      },
    ];

    const configured = { settings: { agent: { default: "codex" as const, models: { codex: "custom" } } } };
    const choices = modelChoices(["claude", "codex"], reports);
    expect(new Set(choices.map((choice) => choice.key)).size).toBe(3);
    expect(initialModel(choices, reports, configured)).toMatchObject({ agent: "codex", model: "custom" });
    expect(
      initialModel(choices, reports, {
        settings: { agent: { default: "codex", models: { codex: "unavailable" } } },
      }),
    ).toMatchObject({ agent: "codex", model: "same-id" });
    expect(modelChoices(["claude"], reports).map((choice) => choice.agent)).toEqual(["claude"]);
    expect(createInput(project, emptySource(), "codex", "Fix it", "same-id")).toMatchObject({
      agent: "codex",
      model: "same-id",
    });
    expect(modelChoices(["pi"], [])).toEqual([]);
  });

  it("filters pull requests by number, title or branch", () => {
    const prs = [
      { number: 12, title: "Add login", headBranch: "feat/login" },
      { number: 3, title: "Fix crash", headBranch: "fix/crash" },
    ];

    expect(filterPullRequests(prs, "")).toEqual(prs);
    expect(filterPullRequests(prs, "#1").map((p) => p.number)).toEqual([12]);
    expect(filterPullRequests(prs, "CRASH").map((p) => p.number)).toEqual([3]);
    expect(filterPullRequests(prs, "feat/").map((p) => p.number)).toEqual([12]);
  });
});

describe("Diagnostics", () => {
  const egress: Diagnostics["egress"] = [
    { ts: 1, method: "GET", host: "api.github.com", path: "/repos", status: 200, ms: 5, rule: 3 },
    { ts: 2, method: "POST", host: "evil.example.com", path: "/", status: 403, ms: 1, rule: 10 },
    { ts: 3, method: "GET", host: "registry.npmjs.org", path: "/x", status: 404, ms: 9, rule: 8 },
    { ts: 4, method: "GET", host: "tempo.example.com", path: "/api", status: 403, ms: 1, rule: 0 },
    { ts: 5, method: "GET", host: "openrouter.ai", path: "/v1", status: 502, ms: 3, rule: 4 },
  ];

  it("sends the egress filters to getDiagnostics and leaves the defaults out (02)", () => {
    expect(diagnosticsInput("w1", "", "all")).toEqual({ workspaceId: "w1" });
    expect(diagnosticsInput("w1", "  GitHub ", "all")).toEqual({ workspaceId: "w1", egressHost: "GitHub" });
    expect(diagnosticsInput("w1", "", "blocked")).toEqual({ workspaceId: "w1", egressStatus: "blocked" });
    expect(diagnosticsInput("w1", "npm", "4xx")).toEqual({
      workspaceId: "w1",
      egressHost: "npm",
      egressStatus: "4xx",
    });
    expect(hasEgressFilter(" ", "all")).toBe(false);
    expect(hasEgressFilter("a", "all")).toBe(true);
    expect(hasEgressFilter("", "5xx")).toBe(true);
  });

  it("offers exactly the statuses getDiagnostics accepts", () => {
    expect(EGRESS_STATUS_FILTERS.map((f) => f.value)).toEqual(["all", "blocked", "2xx", "3xx", "4xx", "5xx"]);
    expect(isEgressStatusFilter("2xx")).toBe(true);
    expect(isEgressStatusFilter("1xx")).toBe(false);
  });

  it("treats rules 0, 7 and 10 as blocks (01, TempoOutbound)", () => {
    expect(egress.filter(isBlocked).map((r) => r.ts)).toEqual([2, 4]);
    expect(egress.map(egressTone)).toEqual(["ok", "bad", "warn", "bad", "bad"]);
  });

  it("tones logs and ops", () => {
    expect(logTone("error")).toBe("bad");
    expect(logTone("warn")).toBe("warn");
    expect(logTone("info")).toBe("muted");
    expect(opTone("failed")).toBe("bad");
    expect(opTone("running")).toBe("warn");
    expect(opTone("done")).toBe("ok");
    expect(opTone("cancelled")).toBe("muted");
  });

  it("lists timings in order and flattens capabilities", () => {
    expect(timingRows({ clone: 1200, setup: 30 })).toEqual([
      { step: "clone", ms: 1200 },
      { step: "setup", ms: 30 },
    ]);
    expect(
      capabilityList({ loadSession: true, promptCapabilities: { image: true, audio: false }, x: 1 }),
    ).toEqual(["loadSession", "promptCapabilities.image"]);
    expect(capabilityList(null)).toEqual([]);
  });
});
