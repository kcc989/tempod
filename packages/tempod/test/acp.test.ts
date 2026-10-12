import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { MAX_MESSAGE_BYTES, type SessionStartResult } from "@tempo/protocol";
import { TRUNCATED } from "../src/bounds.ts";
import {
  cleanupDirs,
  DoClient,
  fakeAgentCommand,
  isAlive,
  sleep,
  startTempod,
  testConfig,
  tmpDir,
  writeFile,
  type Harness,
} from "./helpers.ts";

afterAll(cleanupDirs);

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const T = 30_000;

const setup = async (opts: { maxLiveAgents?: number } = {}) => {
  const cmd = fakeAgentCommand();
  const config = testConfig({
    agentCommands: { claude: cmd, codex: cmd, opencode: cmd, pi: cmd },
    limits: {
      cancelGraceMs: 300,
      killGraceMs: 300,
      maxLiveAgents: opts.maxLiveAgents ?? 3,
      deltaMergeMs: 20,
    },
  });
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
  const start = (sessionId: string, extra: Record<string, unknown> = {}, env: Record<string, string> = {}) =>
    c.ok<SessionStartResult>(
      "session.start",
      { sessionId, agent: "claude", env: { FAKE_STATE_DIR: state, ...env }, browser: "local", ...extra },
      20_000,
    );
  const prompt = (sessionId: string, turnId: string, text: string) =>
    c.ok("session.prompt", { sessionId, turnId, content: [{ type: "text", text }] });
  const ended = (turnId: string) => c.waitEvent("turn.ended", (e) => e.turnId === turnId, 15_000);
  return { c, config, state, calls, start, prompt, ended, h: h! };
};

const textOf = (c: DoClient, itemId: string): string => {
  const created = c.of("item.created").find((e) => e.item.id === itemId);
  const deltas = c
    .of("item.delta")
    .filter((e) => e.itemId === itemId)
    .map((e) => e.append.text);
  return String(created?.item.content["text"] ?? "") + deltas.join("");
};

describe("session.start", () => {
  test(
    "ACP mode config drives modes, setters and reload without session/set_mode",
    async () => {
      const { start, calls, c } = await setup();
      const result = await start("mode-config", { modeId: "plan", model: "m2" }, { FAKE_MODE_CONFIG: "1" });
      expect(result.modes).toEqual([
        { id: "default", name: "Default" },
        { id: "plan", name: "Plan", description: "Plan only" },
      ]);
      expect(result.modeId).toBe("plan");
      expect(calls()).toContain("config agent-mode=plan");
      expect(calls()).not.toContain(" mode plan");
      await c.ok("session.setConfig", { sessionId: "mode-config", configId: "agent-mode", value: "default" });
      expect((await start("mode-config")).modeId).toBe("default");
      const failed = await c.req("session.setMode", { sessionId: "mode-config", modeId: "unknown" });
      expect(failed.ok).toBe(false);
      expect((await start("mode-config")).modeId).toBe("default");
      await c.ok("session.close", { sessionId: "mode-config" });
      const loaded = await start(
        "mode-config",
        { acpSessionId: result.acpSessionId },
        { FAKE_MODE_CONFIG: "1" },
      );
      expect(loaded.reloaded).toBe(true);
      expect(loaded.modeId).toBe("default");
      expect(loaded.configOptions.find((o) => o.category === "model")?.currentValue).toBe("m2");
    },
    T,
  );

  test(
    "new session: initialize, session/new, then mode and model; the result carries the agent's state",
    async () => {
      const { start, calls } = await setup();
      const r = await start("s1", { modeId: "plan", model: "m2" });
      expect(r.acpSessionId).toMatch(/^acp-/);
      expect(r.reloaded).toBe(false);
      expect(r.handoff).toBe(false);
      expect(r.modes.map((m) => m.id)).toEqual(["default", "plan"]);
      expect(r.modeId).toBe("plan");
      expect(r.configOptions[0]).toMatchObject({ id: "model", category: "model", currentValue: "m2" });
      expect(r.capabilities["loadSession"]).toBe(true);
      const log = calls();
      expect(log).toContain("initialize");
      expect(log).toContain(`new ${r.acpSessionId}`);
      expect(log).toContain("mode plan");
      expect(log).toContain("config model=m2");
      // A second start of a live session is answered from memory.
      const again = await start("s1");
      expect(again.acpSessionId).toBe(r.acpSessionId);
      expect(
        calls()
          .split("\n")
          .filter((l) => l.endsWith(" initialize")),
      ).toHaveLength(1);
    },
    T,
  );

  test(
    "Playwright MCP uses local Chromium, or the Browser Run CDP endpoint with browser run (01)",
    async () => {
      const { start, calls } = await setup();
      await start("local");
      await start("remote", { browser: "run" });
      const mcp = calls()
        .split("\n")
        .filter((l) => l.includes(" mcp "))
        .map((l) => l.slice(l.indexOf(" mcp ") + 5));
      expect(mcp).toEqual([
        "playwright --headless --isolated --browser chromium",
        "tempo mcp",
        "playwright --cdp-endpoint wss://browser.tempo.internal/",
        "tempo mcp",
      ]);
    },
    T,
  );

  test(
    "reload: session/load with replay dropped, reloaded: true",
    async () => {
      const { c, start, prompt, ended, h } = await setup();
      const first = await start("s1");
      await prompt("s1", "t1", "hello");
      await ended("t1");
      await h.app.agents.close({ sessionId: "s1" });
      const before = c.events.length;
      const r = await start("s1", { acpSessionId: first.acpSessionId });
      expect(r.reloaded).toBe(true);
      expect(r.handoff).toBe(false);
      expect(r.acpSessionId).toBe(first.acpSessionId);
      await sleep(100);
      const after = c.events.slice(before).map((e) => e.event);
      expect(after.filter((e) => e.kind === "item.created" || e.kind === "item.delta")).toHaveLength(0);
      expect(after.filter((e) => e.kind === "session.updated")).toHaveLength(0);
    },
    T,
  );

  test(
    "handoff when session/load fails, and its late replay is dropped",
    async () => {
      const { c, start, prompt, ended, h } = await setup();
      const first = await start("s1");
      await prompt("s1", "t1", "hello");
      await ended("t1");
      await h.app.agents.close({ sessionId: "s1" });
      const before = c.events.length;
      const r = await start("s1", { acpSessionId: first.acpSessionId }, { FAKE_LOAD_FAIL: "1" });
      expect(r.handoff).toBe(true);
      expect(r.reloaded).toBe(false);
      expect(r.acpSessionId).not.toBe(first.acpSessionId);
      await sleep(100);
      const after = c.events.slice(before).map((e) => e.event);
      expect(after.filter((e) => e.kind === "item.created" || e.kind === "session.updated")).toHaveLength(0);
    },
    T,
  );

  test(
    "handoff when the agent cannot load sessions",
    async () => {
      const { start } = await setup();
      const r = await start("s1", { acpSessionId: "acp-gone" }, { FAKE_LOAD: "0" });
      expect(r.handoff).toBe(true);
      expect(r.capabilities["loadSession"]).toBe(false);
    },
    T,
  );

  test(
    "a command that cannot run fails with AGENT_START_FAILED",
    async () => {
      const config = testConfig({ agentCommands: { claude: ["/nonexistent/agent-binary"] } });
      h = startTempod(config);
      const c = new DoClient(h.base);
      await c.hello();
      const res = await c.req(
        "session.start",
        { sessionId: "s1", agent: "claude", env: {}, browser: "local" },
        20_000,
      );
      expect(res).toMatchObject({ ok: false, error: { code: "AGENT_START_FAILED" } });
    },
    T,
  );
});

describe("session.prompt", () => {
  test(
    "turn.ended carries the token usage from the prompt response",
    async () => {
      const { start, prompt, ended } = await setup();
      await start("s1");
      expect(await prompt("s1", "t1", "usage")).toEqual({ accepted: true });
      expect((await ended("t1")).usage).toEqual({
        totalTokens: 1500,
        inputTokens: 1200,
        outputTokens: 300,
        cachedReadTokens: 800,
      });
    },
    T,
  );

  test(
    "chunks become one streaming item with coalesced deltas; turn.ended carries the stop reason",
    async () => {
      const { c, start, prompt, ended } = await setup();
      await start("s1");
      expect(await prompt("s1", "t1", "hello")).toEqual({ accepted: true });
      const end = await ended("t1");
      expect(end.stopReason).toBe("end_turn");
      expect(end.error).toBeUndefined();
      expect(end.usage).toBeUndefined();
      expect(c.of("turn.started").some((e) => e.turnId === "t1")).toBe(true);
      const created = c.of("item.created").filter((e) => e.turnId === "t1");
      expect(created.map((e) => e.item.kind)).toEqual(["agent_thought", "agent_message"]);
      const message = created[1]!.item;
      expect(textOf(c, message.id)).toBe("Hello world");
      expect(c.of("item.delta").filter((e) => e.itemId === message.id).length).toBeLessThanOrEqual(2);
      const statuses = c
        .of("item.updated")
        .filter((e) => e.itemId === message.id)
        .map((e) => e.patch.status);
      expect(statuses).toContain("completed");
      expect(c.of("session.updated").some((e) => e.patch.title === "Greeting")).toBe(true);
      // The same turn id is not run twice.
      expect(await prompt("s1", "t1", "hello")).toEqual({ accepted: true });
    },
    T,
  );

  test(
    "a tool call becomes a tool_call item that is updated in place",
    async () => {
      const { c, start, prompt, ended } = await setup();
      await start("s1");
      await prompt("s1", "t1", "tool");
      await ended("t1");
      const tool = c.of("item.created").find((e) => e.item.kind === "tool_call")!.item;
      expect(tool.status).toBe("pending");
      expect(tool.content).toMatchObject({
        toolCallId: "tc1",
        title: "Read a.txt",
        toolKind: "read",
        locations: [{ path: "/workspace/a.txt", line: 1 }],
        rawInput: { path: "a.txt" },
      });
      const upd = c.of("item.updated").find((e) => e.itemId === tool.id && e.patch.status === "completed")!;
      expect(upd.patch.content?.["content"]).toEqual([
        { type: "content", content: { type: "text", text: "one" } },
      ]);
    },
    T,
  );

  test(
    "permission: a permission item, then permission.requested; the choice goes back to the agent",
    async () => {
      const { c, start, prompt, ended, calls } = await setup();
      await start("s1");
      await prompt("s1", "t1", "permission");
      const req = await c.waitEvent("permission.requested", () => true, 10_000);
      expect(req).toMatchObject({ sessionId: "s1", turnId: "t1", title: "Edit b.txt" });
      expect(req.options.map((o) => o.optionId)).toEqual(["allow", "deny"]);
      const item = c.of("item.created").find((e) => e.item.id === req.itemId)!.item;
      expect(item.kind).toBe("permission");
      expect(item.content).toMatchObject({
        requestId: req.requestId,
        toolCallId: "tc2",
        title: "Edit b.txt",
      });
      const bad = await c.req("permission.respond", { requestId: req.requestId, optionId: "nope" });
      expect(bad).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
      await c.ok("permission.respond", { requestId: req.requestId, optionId: "allow" });
      const end = await ended("t1");
      expect(end.stopReason).toBe("end_turn");
      expect(calls()).toContain("permission selected:allow");
      const chosen = c.of("item.updated").find((e) => e.itemId === req.itemId)!;
      expect(chosen.patch).toMatchObject({ status: "completed", content: { chosenOptionId: "allow" } });
      const unknown = await c.req("permission.respond", { requestId: req.requestId, optionId: "allow" });
      expect(unknown).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    },
    T,
  );

  test(
    "a codex 401 fails the turn with CREDENTIAL_INVALID and sends credential.invalid",
    async () => {
      const { c, start, prompt, ended } = await setup();
      await start("s1", { agent: "codex" });
      await prompt("s1", "t1", "fail401");
      const end = await ended("t1");
      expect(end.error?.code).toBe("CREDENTIAL_INVALID");
      expect(await c.waitEvent("credential.invalid")).toEqual({
        kind: "credential.invalid",
        provider: "codex",
      });
    },
    T,
  );

  test(
    "prompts to a session with no live agent fail with NOT_FOUND",
    async () => {
      const { c } = await setup();
      const res = await c.req("session.prompt", {
        sessionId: "nope",
        turnId: "t1",
        content: [{ type: "text", text: "x" }],
      });
      expect(res).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    },
    T,
  );

  test(
    "fs/write_text_file and fs/read_text_file: only under the workspace and attachments",
    async () => {
      const { c, start, prompt, ended, config } = await setup();
      await start("s1");
      const inside = join(config.workspace, "sub", "w.txt");
      await prompt("s1", "t1", `write ${inside}`);
      await ended("t1");
      expect(readFileSync(inside, "utf8")).toBe("written by agent");
      const outside = join(tmpDir("outside-"), "x.txt");
      await prompt("s1", "t2", `write ${outside}`);
      await ended("t2");
      expect(existsSync(outside)).toBe(false);
      const target = join(tmpDir("outside-"), "authorized_keys");
      symlinkSync(target, join(config.workspace, "dangling"));
      await prompt("s1", "t3", `write ${join(config.workspace, "dangling")}`);
      await ended("t3");
      expect(existsSync(target)).toBe(false);
      writeFile(join(config.attachments, "t9", "note.txt"), "attached");
      await prompt("s1", "t4", `read ${join(config.attachments, "t9", "note.txt")}`);
      await ended("t4");
      await prompt("s1", "t5", "read /etc/hostname");
      await ended("t5");
      const texts = c
        .of("item.created")
        .filter((e) => e.item.kind === "agent_message")
        .map((e) => textOf(c, e.item.id));
      expect(texts[0]).toBe("write ok");
      expect(texts[1]).toStartWith("write error");
      expect(texts[2]).toStartWith("write error");
      expect(texts[3]).toBe("read ok: attached");
      expect(texts[4]).toStartWith("read error");
    },
    T,
  );
});

describe("session.steer", () => {
  test(
    "injects once into the active turn, preserves the prompt lifecycle and rejects stale targets",
    async () => {
      const { c, start, prompt, ended, calls } = await setup();
      const result = await start("s1", {}, { FAKE_STEERING: "1" });
      expect(result.capabilities["steering"]).toBe(true);
      await prompt("s1", "t1", "slow");
      const input = {
        sessionId: "s1",
        turnId: "t1",
        messageId: "m1",
        content: [{ type: "text", text: "Use the smaller change" }],
      };
      expect(await c.ok<{ outcome: string }>("session.steer", input)).toEqual({ outcome: "injected" });
      expect(await c.ok<{ outcome: string }>("session.steer", input)).toEqual({ outcome: "injected" });
      expect(
        calls()
          .split("\n")
          .filter((l) => l.includes(" steer ")),
      ).toHaveLength(1);
      expect(c.of("turn.ended")).toHaveLength(0);
      expect(
        await c.ok<{ outcome: string }>("session.steer", { ...input, turnId: "old", messageId: "m2" }),
      ).toEqual({ outcome: "promptRequired" });
      await c.ok("session.cancel", { sessionId: "s1", turnId: "t1" });
      expect((await ended("t1")).stopReason).toBe("cancelled");
    },
    T,
  );

  test(
    "does not call an unsupported adapter and uses host-owned fallback when the adapter settles",
    async () => {
      const { c, start, prompt, calls } = await setup();
      await start("s1");
      await prompt("s1", "t1", "slow");
      const input = {
        sessionId: "s1",
        turnId: "t1",
        messageId: "m1",
        content: [{ type: "text", text: "Follow up" }],
      };
      expect(await c.ok<{ outcome: string }>("session.steer", input)).toEqual({ outcome: "unsupported" });
      expect(calls()).not.toContain(" steer ");
      await start("s2", {}, { FAKE_STEERING: "1", FAKE_STEERING_IDLE: "1" });
      await prompt("s2", "t2", "slow");
      expect(
        await c.ok<{ outcome: string }>("session.steer", { ...input, sessionId: "s2", turnId: "t2" }),
      ).toEqual({ outcome: "promptRequired" });
      expect(calls()).toContain('"idleBehavior":"promptRequired"');
    },
    T,
  );
});

describe("session.setMode, session.setConfig, session.close", () => {
  test(
    "mode and config go to the agent; both refuse a busy session; close ends the agent quietly",
    async () => {
      const { c, start, prompt, ended, calls, h } = await setup();
      await start("s1");
      await c.ok("session.setMode", { sessionId: "s1", modeId: "plan" });
      expect(c.of("session.updated").some((e) => e.patch.modeId === "plan")).toBe(true);
      const cfg = await c.ok<{ configOptions: Array<{ id: string; currentValue: unknown }> }>(
        "session.setConfig",
        {
          sessionId: "s1",
          configId: "model",
          value: "m2",
        },
      );
      expect(cfg.configOptions[0]).toMatchObject({ id: "model", currentValue: "m2" });
      expect(calls()).toContain("mode plan");
      expect(calls()).toContain("config model=m2");
      await prompt("s1", "t1", "slow");
      await c.waitEvent("item.created", (e) => e.turnId === "t1");
      expect(await c.req("session.setMode", { sessionId: "s1", modeId: "default" })).toMatchObject({
        ok: false,
        error: { code: "SESSION_BUSY" },
      });
      expect(
        await c.req("session.setConfig", { sessionId: "s1", configId: "model", value: "m1" }),
      ).toMatchObject({
        ok: false,
        error: { code: "SESSION_BUSY" },
      });
      expect(await c.req("session.close", { sessionId: "s1" })).toMatchObject({
        ok: false,
        error: { code: "SESSION_BUSY" },
      });
      await c.ok("session.cancel", { sessionId: "s1", turnId: "t1" }, 20_000);
      await ended("t1");
      expect(await c.ok<unknown>("session.close", { sessionId: "s1" }, 20_000)).toEqual({});
      expect(h.app.agents.liveCount).toBe(0);
      expect(calls()).toContain("close acp-");
      expect(await c.ok<unknown>("session.close", { sessionId: "s1" })).toEqual({});
      expect(await c.req("session.setMode", { sessionId: "s1", modeId: "plan" })).toMatchObject({
        ok: false,
        error: { code: "NOT_FOUND" },
      });
      await sleep(400);
      expect(c.of("agent.exited")).toHaveLength(0);
    },
    T,
  );
});

describe("message size", () => {
  test(
    "a large image moves to a file and comes back as a resource_link",
    async () => {
      const { c, start, prompt, ended, config } = await setup();
      await start("s1");
      await prompt("s1", "t1", "big-image");
      await ended("t1");
      const tool = c.of("item.created").find((e) => e.item.kind === "tool_call")!.item;
      const block = (tool.content["content"] as Array<{ content: Record<string, unknown> }>)[0]!.content;
      expect(block["type"]).toBe("resource_link");
      expect(block["mimeType"]).toBe("image/png");
      const uri = String(block["uri"]);
      expect(uri.startsWith(`file://${join(config.attachments, "t1")}/`)).toBe(true);
      expect(readFileSync(uri.slice("file://".length)).byteLength).toBe(400 * 1024);
    },
    T,
  );

  test(
    "huge tool output and text stay under the message limit, cut with a marker",
    async () => {
      const { c, start, prompt, ended } = await setup();
      await start("s1");
      await prompt("s1", "t1", "big-text");
      await ended("t1");
      for (const m of c.raw) expect(Buffer.byteLength(JSON.stringify(m))).toBeLessThan(MAX_MESSAGE_BYTES);
      const tool = c.of("item.created").find((e) => e.item.kind === "tool_call")!.item;
      const upd = c.of("item.updated").find((e) => e.itemId === tool.id && e.patch.content)!;
      const diff = (upd.patch.content!["content"] as Array<Record<string, string>>)[0]!;
      expect(diff["type"]).toBe("diff");
      expect(diff["oldText"]!.endsWith(TRUNCATED)).toBe(true);
      const message = c.of("item.created").find((e) => e.item.kind === "agent_message")!.item;
      expect(textOf(c, message.id)).toBe("z".repeat(300_000));
      expect(c.of("item.delta").filter((e) => e.itemId === message.id).length).toBeGreaterThanOrEqual(3);
    },
    T,
  );
});

describe("cancel, eviction and crashes", () => {
  test(
    "cancel: session/cancel, and the agent ends the turn as cancelled",
    async () => {
      const { c, start, prompt, ended, calls } = await setup();
      await start("s1");
      await prompt("s1", "t1", "slow");
      await c.waitEvent("item.created", (e) => e.turnId === "t1");
      await c.ok("session.cancel", { sessionId: "s1", turnId: "t1" }, 20_000);
      const end = await ended("t1");
      expect(end.stopReason).toBe("cancelled");
      expect(calls()).toContain("cancel acp-");
      expect(c.of("agent.exited")).toHaveLength(0);
    },
    T,
  );

  test(
    "cancel timeout: the adapter is killed, agent.exited (cancelled) comes before turn.ended; the next start reloads",
    async () => {
      const { c, start, prompt, ended } = await setup();
      const first = await start("s1");
      await prompt("s1", "t1", "hang");
      await c.waitEvent("item.created", (e) => e.turnId === "t1");
      await c.ok("session.cancel", { sessionId: "s1", turnId: "t1" }, 20_000);
      const end = await ended("t1");
      expect(end.stopReason).toBe("cancelled");
      const kinds = c.events.map((e) => e.event);
      const exitIdx = kinds.findIndex((e) => e.kind === "agent.exited");
      const endIdx = kinds.findIndex((e) => e.kind === "turn.ended" && e.turnId === "t1");
      expect(exitIdx).toBeGreaterThanOrEqual(0);
      expect(exitIdx).toBeLessThan(endIdx);
      expect(kinds[exitIdx]).toMatchObject({ kind: "agent.exited", sessionId: "s1", reason: "cancelled" });
      const opened = c.of("item.created").find((e) => e.turnId === "t1")!.item;
      expect(c.of("item.updated").some((e) => e.itemId === opened.id && e.patch.status === "cancelled")).toBe(
        true,
      );
      const res = await c.req("session.prompt", {
        sessionId: "s1",
        turnId: "t2",
        content: [{ type: "text", text: "x" }],
      });
      expect(res).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
      const again = await start("s1", { acpSessionId: first.acpSessionId });
      expect(again.reloaded).toBe(true);
      await sleep(400);
      expect(c.of("agent.exited")).toHaveLength(1);
    },
    T,
  );

  test(
    "eviction: the least recently used idle agent is closed with session/close and reason evicted",
    async () => {
      const { c, start, prompt, ended, calls, h } = await setup({ maxLiveAgents: 2 });
      const a = await start("a");
      await start("b");
      await prompt("b", "tb", "hello");
      await ended("tb");
      await start("c");
      const ev = await c.waitEvent("agent.exited", (e) => e.sessionId === "a");
      expect(ev.reason).toBe("evicted");
      expect(calls()).toContain(`close ${a.acpSessionId}`);
      expect(h.app.agents.liveCount).toBe(2);
      expect(h.app.agents.get("a")).toBeUndefined();
      await sleep(400);
      expect(c.of("agent.exited")).toHaveLength(1);
    },
    T,
  );

  test(
    "concurrent session starts never exceed the process limit",
    async () => {
      const { start, h } = await setup({ maxLiveAgents: 2 });
      await Promise.all(["a", "b", "c", "d", "e"].map((id) => start(id)));
      expect(h.app.agents.liveCount).toBe(2);
      expect(h.app.agents.get("d")).toBeDefined();
      expect(h.app.agents.get("e")).toBeDefined();
    },
    T,
  );

  test(
    "a full manager preserves its active turn instead of starting beyond its limit",
    async () => {
      const { c, start, prompt, h } = await setup({ maxLiveAgents: 1 });
      await start("a");
      await prompt("a", "ta", "slow");
      await c.waitEvent("item.created", (e) => e.turnId === "ta");
      const result = await c.req("session.start", {
        sessionId: "b",
        agent: "claude",
        env: {},
        browser: "local",
      });
      expect(result).toMatchObject({ ok: false, error: { code: "AGENT_START_FAILED" } });
      expect(h.app.agents.liveCount).toBe(1);
      expect(h.app.agents.get("a")?.busy).toBe(true);
      expect(h.app.agents.get("b")).toBeUndefined();
    },
    T,
  );

  test(
    "crash: the turn fails with AGENT_CRASHED and agent.exited carries the stderr tail",
    async () => {
      const { c, start, prompt, ended } = await setup();
      await start("s1");
      await prompt("s1", "t1", "crash");
      const end = await ended("t1");
      expect(end.error?.code).toBe("AGENT_CRASHED");
      const ev = await c.waitEvent("agent.exited");
      expect(ev).toMatchObject({ sessionId: "s1", code: 3, signal: null, reason: "crashed" });
      expect(ev.stderrTail).toContain("fatal: boom");
      expect(ev.stderrTail).toContain("started");
    },
    T,
  );

  test(
    "crash: children left in the adapter's process group are killed",
    async () => {
      const { c, start, prompt, ended, state } = await setup();
      await start("s1");
      await prompt("s1", "t1", "child");
      await ended("t1");
      await c.waitEvent("agent.exited");
      const pid = Number(readFileSync(join(state, "child.pid"), "utf8"));
      const alive = () => isAlive(pid);
      for (let i = 0; i < 40 && alive(); i++) await sleep(50);
      expect(alive()).toBe(false);
    },
    T,
  );

  test(
    "shutdown stops agents without agent.exited; SIGTERM mode refuses prompts and interrupts the turn",
    async () => {
      const { c, start, prompt, ended, h } = await setup();
      await start("s1");
      await prompt("s1", "t1", "slow");
      await c.waitEvent("item.created", (e) => e.turnId === "t1");
      h.app.onSigterm();
      const end = await ended("t1");
      expect(end.interrupted).toBe(true);
      await c.waitEvent("tempod.stopping");
      const res = await c.req("session.prompt", {
        sessionId: "s1",
        turnId: "t2",
        content: [{ type: "text", text: "x" }],
      });
      expect(res).toMatchObject({ ok: false, error: { code: "CONTAINER_NOT_READY" } });
      await c.ok("shutdown", { reason: "test" }, 20_000);
      expect(h.app.agents.liveCount).toBe(0);
      expect(c.of("agent.exited")).toHaveLength(0);
    },
    T,
  );
});
