import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  applyProposal,
  hostMatches,
  InjectorInput,
  isHostPattern,
  AGENT_IDS,
  API,
  DEFAULT_SETTINGS,
  ERROR_CODES,
  ERROR_MESSAGES,
  FN_NAMES,
  Settings,
  SettingsLayer,
  Item,
  TEMPOD_REQUESTS,
  TempodEvent,
  TempoError,
  WORKSPACE_FNS,
  WorkspaceServerMessage,
  capture,
  errorMessage,
  newId,
  randomToken,
  reconnectDelay,
  redact,
  revertNote,
  toErrorBody,
  unwrap,
  ULID_PATTERN,
} from "../src/index.ts";

describe("ids", () => {
  it("makes lowercase, monotonic ULIDs (02, IDs)", () => {
    const ids = Array.from({ length: 100 }, () => newId());
    for (const id of ids) expect(id).toMatch(ULID_PATTERN);
    expect([...ids].sort()).toEqual(ids);
  });
  it("makes random [a-z0-9] tokens of the asked length (05, Preview access codes)", () => {
    expect(randomToken(32)).toMatch(/^[a-z0-9]{32}$/);
    expect(randomToken(32)).not.toBe(randomToken(32));
  });
});

describe("errors", () => {
  it("has one message per code, and agent names fill <agent>", () => {
    expect(ERROR_CODES).toHaveLength(Object.keys(ERROR_MESSAGES).length);
    expect(errorMessage("CREDENTIAL_MISSING", "codex")).toBe("Add your Codex login in Settings.");
    expect(errorMessage("NOT_FOUND")).toBe("Not found.");
    expect(errorMessage("MODEL_REQUIRED", "pi")).toBe(
      "Set a default model for this agent in Settings → Project.",
    );
  });
  it("round-trips TempoError through the Result envelope", async () => {
    const res = await capture(() => {
      throw new TempoError("PUSH_REJECTED", undefined, "remote said no");
    });
    expect(res).toEqual({
      ok: false,
      error: { code: "PUSH_REJECTED", message: ERROR_MESSAGES.PUSH_REJECTED, detail: "remote said no" },
    });
    expect(() => unwrap(res)).toThrowError(TempoError);
    expect(toErrorBody(new Error("secret token sk-1"))).toEqual({
      code: "INTERNAL",
      message: "Something went wrong.",
    });
  });
});

describe("settings (01, Project settings file)", () => {
  it("decodes protocol 1 settings without a model map using the existing defaults", () => {
    const decode = Schema.decodeUnknownSync(Settings);
    const { browser: _, ...withoutBrowser } = DEFAULT_SETTINGS;
    const legacy = { ...withoutBrowser, agent: { default: "claude" } };
    expect(decode(legacy)).toEqual(DEFAULT_SETTINGS);
    expect(() => decode({ ...legacy, agent: { default: "claude", models: null } })).toThrow();
    expect(() => decode({ ...legacy, agent: { default: "claude", models: { claude: 1 } } })).toThrow();
    expect(() => decode({ ...legacy, browser: null })).toThrow();
    expect(() => decode({ ...legacy, browser: { run: "yes" } })).toThrow();
  });
  it("defaults to an empty model for each agent and Browser Run off", () => {
    expect(Schema.decodeUnknownSync(Settings)(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    expect(Object.keys(DEFAULT_SETTINGS.agent.models).sort()).toEqual([...AGENT_IDS].sort());
    for (const agent of AGENT_IDS) expect(DEFAULT_SETTINGS.agent.models[agent]).toBe("");
    expect(DEFAULT_SETTINGS.browser.run).toBe(false);
  });
  it("accepts a layer with some agent models and browser.run, and rejects bad types", () => {
    const decode = Schema.decodeUnknownSync(SettingsLayer);
    expect(decode({ agent: { models: { pi: "openrouter/x" } }, browser: { run: true } })).toEqual({
      agent: { models: { pi: "openrouter/x" } },
      browser: { run: true },
    });
    expect(() => decode({ agent: { models: { pi: 1 } } })).toThrow();
    expect(() => decode({ browser: { run: "yes" } })).toThrow();
  });
});

describe("contract", () => {
  it("lists every function with a method", () => {
    expect(FN_NAMES.length).toBeGreaterThan(50);
    for (const name of FN_NAMES) expect(["GET", "POST"]).toContain(API[name].method);
  });
  it("routes exactly the functions that take workspaceId to the WorkspaceDO", () => {
    expect(WORKSPACE_FNS).toContain("sendPrompt");
    expect(WORKSPACE_FNS).not.toContain("createWorkspace");
    expect(WORKSPACE_FNS).not.toContain("listWorkspaces");
  });
  it("validates sendPrompt input", () => {
    const decode = Schema.decodeUnknownSync(API.sendPrompt.input);
    expect(() => decode({ workspaceId: "w", sessionId: "s", text: "hi" })).toThrow();
    expect(
      decode({
        workspaceId: "w",
        sessionId: "s",
        text: "hi",
        mentions: [],
        attachmentIds: [],
        reviewCommentIds: [],
      }).text,
    ).toBe("hi");
  });
  it("checks setClaudeToken: no spaces, 20 to 4096 chars (02, Credentials)", () => {
    const decode = Schema.decodeUnknownExit(API.setClaudeToken.input);
    expect(decode({ token: "short" })._tag).toBe("Failure");
    expect(decode({ token: "has space ".repeat(5) })._tag).toBe("Failure");
    expect(decode({ token: "x".repeat(20) })._tag).toBe("Success");
  });
  it("has the 02 timeout for every tempod op", () => {
    expect(TEMPOD_REQUESTS["repo.clone"].timeoutMs).toBe(600_000);
    expect(TEMPOD_REQUESTS["session.start"].timeoutMs).toBe(120_000);
    expect(TEMPOD_REQUESTS.shutdown.timeoutMs).toBe(45_000);
    expect(TEMPOD_REQUESTS["environment.set"].timeoutMs).toBe(10_000);
    expect(Object.keys(TEMPOD_REQUESTS).sort()).toEqual(
      [
        "repo.clone",
        "repo.applyCheckpoint",
        "settings.read",
        "env.set",
        "environment.set",
        "script.start",
        "script.stop",
        "session.start",
        "session.prompt",
        "session.steer",
        "session.cancel",
        "session.setMode",
        "session.setConfig",
        "session.close",
        "permission.respond",
        "credential.put",
        "git.changes",
        "git.fileDiff",
        "git.checkpoint",
        "git.revert",
        "git.commitAndPush",
        "git.renameBranch",
        "fs.list",
        "fs.read",
        "fs.search",
        "terminal.list",
        "shutdown",
      ].sort(),
    );
  });
});

describe("wire messages", () => {
  it("decodes items by kind", () => {
    const item = Schema.decodeUnknownSync(Item)({
      id: "i",
      sessionId: "s",
      turnId: "t",
      kind: "plan",
      status: "completed",
      content: { entries: [{ content: "a", priority: "high", status: "pending" }] },
      rev: 3,
      createdAt: 1,
      updatedAt: 2,
    });
    expect(item.kind).toBe("plan");
  });
  it("decodes tempod events and channel messages", () => {
    expect(Schema.decodeUnknownSync(TempodEvent)({ kind: "ports.changed", ports: [3000] })).toEqual({
      kind: "ports.changed",
      ports: [3000],
    });
    expect(Schema.decodeUnknownSync(WorkspaceServerMessage)({ type: "pong" })).toEqual({ type: "pong" });
    expect(Schema.decodeUnknownExit(TempodEvent)({ kind: "nope" })._tag).toBe("Failure");
  });
});

describe("helpers", () => {
  it("redacts secret-looking fields (05, Secrets)", () => {
    expect(
      redact({ token: "a", nested: { apiKey: "b", Authorization: "c", ok: 1 }, list: [{ cookie: "d" }] }),
    ).toEqual({
      token: "[redacted]",
      nested: { apiKey: "[redacted]", Authorization: "[redacted]", ok: 1 },
      list: [{ cookie: "[redacted]" }],
    });
  });
  it("backs off 0.5 s doubling to 10 s with 20% jitter (02, reconnect)", () => {
    expect(reconnectDelay(0, () => 0.5)).toBe(500);
    expect(reconnectDelay(10, () => 0.5)).toBe(10_000);
    expect(reconnectDelay(0, () => 1)).toBe(600);
    expect(reconnectDelay(0, () => 0)).toBe(400);
  });
  it("writes the revert note exactly (03, Revert)", () => {
    expect(revertNote(3)).toBe(
      "Note: the user reverted the files to the state after turn 3. Changes made after that point are gone.",
    );
  });
});

describe("environments (01, Environments)", () => {
  it("checks host patterns", () => {
    expect(isHostPattern("api.stripe.com")).toBe(true);
    expect(isHostPattern("*.stripe.com")).toBe(true);
    expect(isHostPattern("API.stripe.com")).toBe(false);
    expect(isHostPattern("api.stripe.com:443")).toBe(false);
    expect(isHostPattern("*")).toBe(false);
  });
  it("matches wildcard hosts below the domain only", () => {
    expect(hostMatches("a.example.com", "*.example.com")).toBe(true);
    expect(hostMatches("b.a.example.com", "*.example.com")).toBe(true);
    expect(hostMatches("example.com", "*.example.com")).toBe(false);
    expect(hostMatches("EXAMPLE.com", "example.com")).toBe(true);
  });
  it("applies a proposal by adding or replacing, never removing", () => {
    const next = applyProposal(
      {
        egressPolicy: "open",
        egressAllowlist: ["a.com"],
        secrets: [
          { name: "A", hosts: ["a.com"] },
          { name: "B", hosts: [] },
        ],
        injectors: [{ name: "x", hosts: ["x.com"], code: "1" }],
      },
      {
        note: "",
        egressPolicy: "allowlist",
        allowlistAdd: ["a.com", "b.com"],
        secrets: [{ name: "B", hosts: ["b.com"] }],
        injectors: [{ name: "y", hosts: ["y.com"], code: "2" }],
      },
    );
    expect(next.egressPolicy).toBe("allowlist");
    expect(next.egressAllowlist).toEqual(["a.com", "b.com"]);
    expect(next.secrets).toEqual([
      { name: "A", hosts: ["a.com"] },
      { name: "B", hosts: ["b.com"] },
    ]);
    expect(next.injectors.map((i) => i.name)).toEqual(["x", "y"]);
  });
  it("limits injector code to 64 KiB", () => {
    const decode = Schema.decodeUnknownExit(InjectorInput);
    expect(decode({ name: "a", hosts: ["a.com"], code: "x".repeat(64 * 1024) })._tag).toBe("Success");
    expect(decode({ name: "a", hosts: ["a.com"], code: "x".repeat(64 * 1024 + 1) })._tag).toBe("Failure");
    expect(decode({ name: "a", hosts: [], code: "x" })._tag).toBe("Failure");
  });
});
