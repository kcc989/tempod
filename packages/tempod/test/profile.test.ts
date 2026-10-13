import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentProfile } from "@tempo/protocol";
import { offeredOption, prepareProfile, profileDir, sessionProfile } from "../src/acp/profile.ts";
import { applyProfile, expandRefs, toolAllowed } from "../../../container/pi/tempo-profile.ts";
import {
  cleanupDirs,
  DoClient,
  fakeAgentCommand,
  startTempod,
  testConfig,
  tmpDir,
  type Harness,
} from "./helpers.ts";

/** 01, Custom agents: how tempod applies a profile per base agent. */

afterAll(cleanupDirs);

const profile = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  systemPrompt: "Review only.",
  toolsAllow: [],
  toolsDeny: ["Edit"],
  playwright: true,
  mcpServers: [
    { name: "docs", type: "stdio", command: "docs-mcp", args: ["-v"], env: { TOKEN: "${DOCS_TOKEN}" } },
    {
      name: "search",
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "${AUTH}" },
    },
  ],
  thoughtLevel: "",
  ...over,
});

const ENV = { DOCS_TOKEN: "secret-1", AUTH: "Bearer secret-2" };

describe("sessionProfile", () => {
  test("claude: system prompt append, tools and disallowedTools; never allowedTools", () => {
    const p = sessionProfile("claude", profile({ toolsAllow: ["Read"] }), ENV);
    expect(p.meta).toEqual({
      systemPrompt: { append: "Review only." },
      claudeCode: { options: { tools: ["Read"], disallowedTools: ["Edit"] } },
    });
    expect(JSON.stringify(p.meta)).not.toMatch(/"allowedTools"/);
    expect(p.issues).toEqual([]);
  });

  test("claude: an empty allowlist leaves out tools, so every built-in tool stays", () => {
    const p = sessionProfile("claude", profile({ toolsDeny: [] }), ENV);
    expect(p.meta).toEqual({ systemPrompt: { append: "Review only." } });
  });

  test("codex: developer instructions; tool limits are an issue", () => {
    const p = sessionProfile("codex", profile(), ENV);
    expect(p.meta).toEqual({ jetbrains: { air: { customInstructions: "Review only." } } });
    expect(p.issues).toEqual(["tools"]);
  });

  test("MCP servers become specs with refs expanded in memory; a missing name is an issue", () => {
    const p = sessionProfile("opencode", profile({ playwright: false }), ENV);
    expect(p.specs).toEqual([
      {
        name: "docs",
        transport: "stdio",
        command: "docs-mcp",
        args: ["-v"],
        env: [{ name: "TOKEN", value: "secret-1" }],
      },
      {
        name: "search",
        transport: "http",
        url: "https://mcp.example.com/mcp",
        headers: [{ name: "Authorization", value: "Bearer secret-2" }],
      },
    ]);
    expect(p.dropPlaywright).toBe(true);
    expect(p.issues).toEqual([]);
    const missing = sessionProfile("claude", profile(), { AUTH: "x" });
    expect(missing.specs.map((s) => s.name)).toEqual(["search"]);
    expect(missing.issues).toEqual(["mcpServers"]);
  });

  test("pi: no specs (the extension registers them); SSE and missing refs are issues", () => {
    const p = sessionProfile("pi", profile(), ENV);
    expect(p.specs).toEqual([]);
    expect(p.meta).toBeUndefined();
    expect(p.issues).toEqual([]);
    const sse = profile({ mcpServers: [{ name: "e", type: "sse", url: "https://x.dev/sse", headers: {} }] });
    expect(sessionProfile("pi", sse, ENV).issues).toEqual(["mcpServers"]);
    expect(sessionProfile("pi", profile(), {}).issues).toEqual(["mcpServers"]);
  });

  test("no profile: nothing added", () => {
    expect(sessionProfile("claude", undefined, {})).toEqual({
      meta: undefined,
      specs: [],
      dropPlaywright: false,
      issues: [],
    });
  });
});

describe("prepareProfile", () => {
  test("claude and codex need no files or env", () => {
    const dir = join(tmpDir("profile-"), "s1");
    expect(prepareProfile("claude", profile(), dir)).toEqual({});
    expect(existsSync(dir)).toBe(false);
  });

  test("opencode: OPENCODE_CONFIG_CONTENT with instructions and permission; deny after allow", () => {
    const dir = join(tmpDir("profile-"), "s1");

    const env = prepareProfile(
      "opencode",
      profile({ toolsAllow: ["read", "edit"], toolsDeny: ["edit"] }),
      dir,
    );

    const config = JSON.parse(env["OPENCODE_CONFIG_CONTENT"]!);
    expect(config).toEqual({
      instructions: [join(dir, "prompt.md")],
      permission: { "*": "deny", read: "allow", edit: "deny" },
    });
    expect(readFileSync(join(dir, "prompt.md"), "utf8")).toBe("Review only.");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(prepareProfile("opencode", profile({ systemPrompt: "", toolsDeny: [] }), dir)).toEqual({});
  });

  test("pi: a wrapper with pi's flags, the extension, and mcp.json without secret values", () => {
    const dir = join(tmpDir("profile-"), "s1");
    const env = prepareProfile("pi", profile({ toolsAllow: ["read", "bash"] }), dir, "/ext.ts");
    expect(env).toEqual({ PI_ACP_PI_COMMAND: join(dir, "pi"), TEMPO_PROFILE_DIR: dir });
    const wrapper = readFileSync(join(dir, "pi"), "utf8");
    expect(wrapper).toBe(
      `#!/bin/sh\nexec pi "$@" '--append-system-prompt' '${join(dir, "prompt.md")}' '--tools' 'read,bash,codemode' '--exclude-tools' 'Edit' '-e' '/ext.ts'\n`,
    );
    expect(statSync(join(dir, "pi")).mode & 0o777).toBe(0o700);
    const mcp = readFileSync(join(dir, "mcp.json"), "utf8");
    expect(mcp).toContain("${DOCS_TOKEN}");
    expect(mcp).not.toContain("secret-1");
    expect(JSON.parse(mcp).tools).toEqual({ allow: ["read", "bash"], deny: ["Edit"] });
  });

  test("pi: with Playwright off, its tools are denied (it comes from ~/.pi/agent/mcp.json)", () => {
    const dir = join(tmpDir("profile-"), "s1");
    prepareProfile("pi", profile({ playwright: false }), dir, "/ext.ts");
    expect(readFileSync(join(dir, "pi"), "utf8")).toContain(`'--exclude-tools' 'Edit,mcp__playwright__*'`);
    expect(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")).tools.deny).toEqual([
      "Edit",
      "mcp__playwright__*",
    ]);
  });

  test("pi: no allowlist means no --tools; a quote in the prompt path is safe", () => {
    const dir = join(tmpDir("pro'file-"), "s1");
    prepareProfile("pi", profile({ toolsDeny: [] }), dir, "/ext.ts");
    const wrapper = readFileSync(join(dir, "pi"), "utf8");
    expect(wrapper).not.toContain("--tools");
    expect(wrapper).toContain(`'\\''`);
  });
});

describe("offeredOption", () => {
  const options = [
    {
      id: "model",
      name: "Model",
      type: "select",
      category: "model",
      currentValue: "a",
      options: [{ value: "a", name: "A" }],
    },
    {
      id: "effort",
      name: "Effort",
      type: "select",
      category: "thought_level",
      currentValue: "low",
      options: [{ group: "g", name: "G", options: [{ value: "high", name: "High" }] }],
    },
  ];

  test("finds the option by category and checks grouped values", () => {
    expect(offeredOption(options, "thought_level", "high")?.id).toBe("effort");
    expect(offeredOption(options, "thought_level", "max")).toBeUndefined();
    expect(offeredOption(options, "model", "b")).toBeUndefined();
    expect(offeredOption([], "model", "a")).toBeUndefined();
  });
});

describe("Tempo pi extension (container/pi/tempo-profile.ts)", () => {
  test("registers servers with refs expanded, skips SSE and missing names, and guards tools", () => {
    const registered: Array<[string, import("../../../container/pi/tempo-profile.ts").PiMcpServerConfig]> =
      [];

    let guard:
      | ((e: { toolName: string }) => import("../../../container/pi/tempo-profile.ts").PiToolDecision)
      | undefined;

    const warnings: string[] = [];
    applyProfile(
      { registerMcpServer: (n, c) => registered.push([n, c]), on: (_e, h) => (guard = h) },
      {
        servers: [
          { name: "docs", type: "stdio", command: "docs-mcp", env: { T: "${DOCS_TOKEN}" } },
          { name: "gone", type: "stdio", command: "x", env: { T: "${NOPE}" } },
          { name: "events", type: "sse", url: "https://x.dev/sse" },
          { name: "search", type: "http", url: "https://x.dev/mcp", headers: { A: "${AUTH}" } },
        ],
        tools: { allow: [], deny: ["edit", "mcp__docs__delete_*"] },
      },
      ENV,
      (l) => warnings.push(l),
    );
    expect(registered.map(([n]) => n)).toEqual(["docs", "search"]);
    expect(registered[0]![1]).toEqual({ command: "docs-mcp", args: [], env: { T: "secret-1" } });
    expect(registered[1]![1]).toEqual({ url: "https://x.dev/mcp", headers: { A: "Bearer secret-2" } });
    expect(warnings).toEqual(["tempo-profile: skipped gone", "tempo-profile: skipped events"]);
    expect(guard!({ toolName: "edit" })).toMatchObject({ block: true });
    expect(guard!({ toolName: "mcp__docs__delete_page" })).toMatchObject({ block: true });
    expect(guard!({ toolName: "mcp__docs__search" })).toBeUndefined();
  });

  test("an allowlist blocks everything else but lets codemode run guarded calls", () => {
    const tools = { allow: ["read", "mcp__docs__*"], deny: ["mcp__docs__drop"] };
    expect(toolAllowed(tools, "read")).toBe(true);
    expect(toolAllowed(tools, "bash")).toBe(false);
    expect(toolAllowed(tools, "codemode")).toBe(true);
    expect(toolAllowed(tools, "mcp__docs__search")).toBe(true);
    expect(toolAllowed(tools, "mcp__docs__drop")).toBe(false);
    expect(toolAllowed({ allow: ["a.b"], deny: [] }, "axb")).toBe(false);
  });

  test("expandRefs needs every name", () => {
    expect(expandRefs({ A: "${X}" }, { X: "1" })).toEqual({ A: "1" });
    expect(expandRefs({ A: "${X}" }, {})).toBeNull();
    expect(expandRefs({ A: "plain" }, {})).toBeNull();
  });
});

describe("session.start with a profile (fake agent)", () => {
  let h: Harness | null = null;
  afterEach(async () => {
    await h?.close();
    h = null;
  });

  const setup = async () => {
    const cmd = fakeAgentCommand();
    const config = testConfig({ agentCommands: { claude: cmd, codex: cmd, opencode: cmd, pi: cmd } });
    h = startTempod(config);
    const c = new DoClient(h.base);
    await c.hello();
    await c.waitEvent("incarnation.changed");
    const state = tmpDir("fake-agent-");

    const calls = () => {
      try {
        return readFileSync(join(state, "calls.log"), "utf8");
      } catch {
        return "";
      }
    };

    const params = () =>
      calls()
        .split("\n")
        .filter((l) => / params /.test(l))
        .map((l) => JSON.parse(l.slice(l.indexOf("params ") + 7)));

    return { c, config, state, calls, params };
  };

  test("claude: _meta and MCP servers reach session/new; model then reasoning level; issues reported", async () => {
    const { c, state, calls, params } = await setup();

    const r = await c.ok(
      "session.start",
      {
        sessionId: "s1",
        agent: "claude",
        env: { FAKE_STATE_DIR: state, FAKE_EFFORT: "1", DOCS_TOKEN: "secret-1" },
        model: "m2",
        browser: "local",
        profile: profile({ mcpServers: [profile().mcpServers[0]!], thoughtLevel: "high" }),
      },
      20_000,
    );

    expect(r.profileIssues).toEqual([]);
    const [p] = params();
    expect(p._meta).toEqual({
      systemPrompt: { append: "Review only." },
      claudeCode: { options: { disallowedTools: ["Edit"] } },
    });
    expect(p.mcpServers.map((s: { name: string }) => s.name)).toEqual(["playwright", "tempo", "docs"]);
    const log = calls();
    expect(log.indexOf("config model=m2")).toBeLessThan(log.indexOf("config effort=high"));
    expect(r.configOptions.find((o) => o.category === "thought_level")?.currentValue).toBe("high");
  }, 30_000);

  test("a level the agent does not offer, or no level option, is an issue; no profile means no issues", async () => {
    const { c, state } = await setup();

    const bad = await c.ok(
      "session.start",
      {
        sessionId: "s2",
        agent: "codex",
        env: { FAKE_STATE_DIR: state },
        model: "nope",
        browser: "local",
        profile: profile({ thoughtLevel: "max", mcpServers: [] }),
      },
      20_000,
    );

    expect([...(bad.profileIssues ?? [])].sort()).toEqual(["model", "thoughtLevel", "tools"]);

    const plain = await c.ok(
      "session.start",
      { sessionId: "s3", agent: "claude", env: { FAKE_STATE_DIR: state }, browser: "local" },
      20_000,
    );

    expect(plain.profileIssues).toEqual([]);
  }, 30_000);

  test("pi and opencode get their env; session.close removes the profile directory", async () => {
    const { c, config, state, calls } = await setup();
    await c.ok(
      "session.start",
      { sessionId: "pi1", agent: "pi", env: { FAKE_STATE_DIR: state }, profile: profile(), browser: "local" },
      20_000,
    );
    const dir = profileDir(config.stateDir, "pi1");
    expect(calls()).toContain(`env PI_ACP_PI_COMMAND=${join(dir, "pi")}`);
    expect(calls()).toContain(`env TEMPO_PROFILE_DIR=${dir}`);
    expect(existsSync(join(dir, "mcp.json"))).toBe(true);
    await c.ok("session.close", { sessionId: "pi1" });
    expect(existsSync(dir)).toBe(false);

    await c.ok(
      "session.start",
      {
        sessionId: "oc1",
        agent: "opencode",
        env: { FAKE_STATE_DIR: state },
        profile: profile(),
        browser: "local",
      },
      20_000,
    );
    expect(calls()).toContain("env OPENCODE_CONFIG_CONTENT=");

    // A plain pi session needs no wrapper: Playwright comes from ~/.pi/agent/mcp.json.
    await c.ok(
      "session.start",
      { sessionId: "pi2", agent: "pi", env: { FAKE_STATE_DIR: state }, browser: "local" },
      20_000,
    );
    expect(existsSync(profileDir(config.stateDir, "pi2"))).toBe(false);
  }, 30_000);
});
