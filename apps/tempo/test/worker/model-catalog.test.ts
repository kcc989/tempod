import { env, runInDurableObject } from "cloudflare:test";
import { unwrap } from "@tempo/protocol";
import { describe, expect, it } from "vitest";
import { FakeTempod, installFakes, seedProject, seedCredentials, internals, waitFor } from "./fakes.ts";

const sessionResult = (agent: string) => ({
  acpSessionId: `discovery-${agent}`,
  modes: [],
  availableCommands: [],
  capabilities: {},
  reloaded: false,
  handoff: false,
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "a",
      options: [
        { value: "a", name: `${agent} A` },
        { value: "b", name: `${agent} B` },
      ],
    },
  ],
});

const setup = async () => {
  const { userId } = await seedProject();
  const stub = env.WORKSPACE.getByName(`models:${userId}`);
  const tempod = new FakeTempod();
  tempod.on("session.start", ({ agent }) => sessionResult(agent));
  const { container } = await installFakes(stub, tempod);
  return { userId, stub, tempod, container, credentials: env.CREDENTIALS.getByName(userId) };
};

describe("model discovery", { timeout: 30_000 }, () => {
  it("discovers all configured adapters without creating chats and shares simultaneous requests", async () => {
    const w = await setup();
    await seedCredentials(w.userId);
    const [first, second] = await Promise.all([
      w.stub.discoverModels(w.userId),
      w.stub.discoverModels(w.userId),
    ]);
    expect(first).toEqual(second);
    expect(unwrap(first).map((entry) => entry.agent)).toEqual(["claude", "codex", "opencode", "pi"]);
    expect(w.tempod.requestsOf("session.start")).toHaveLength(4);
    expect(w.tempod.requestsOf("session.close")).toHaveLength(4);
    expect(w.tempod.requestsOf("session.prompt")).toEqual([]);
    expect(w.container.starts).toHaveLength(1);
    expect(w.container.starts[0].env).not.toHaveProperty("OPENAI_API_KEY");
    expect(w.container.destroyed).toBe(1);
    expect(
      await runInDurableObject(w.stub, (_, state) =>
        state.storage.sql.exec("SELECT id FROM sessions").toArray(),
      ),
    ).toEqual([]);
  });

  it("invalidates the cache when an agent is configured", async () => {
    const w = await setup();
    await w.credentials.putSecret("claude.oauth_token", "claude-token");
    expect(unwrap(await w.stub.discoverModels(w.userId)).map((entry) => entry.agent)).toEqual(["claude"]);
    await w.stub.discoverModels(w.userId);
    expect(w.container.starts).toHaveLength(1);
    await w.credentials.putSecret("openai.api_key", "openai-key");
    expect(unwrap(await w.stub.discoverModels(w.userId)).map((entry) => entry.agent)).toEqual([
      "claude",
      "codex",
    ]);
    expect(w.container.starts).toHaveLength(2);
  });

  it("includes newly configured agents when credentials change during discovery", async () => {
    const w = await setup();
    await w.credentials.putSecret("claude.oauth_token", "claude-token");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    w.tempod.on("session.start", async ({ agent }) => {
      if (w.tempod.requestsOf("session.start").length === 1) await gate;
      return sessionResult(agent);
    });
    const first = w.stub.discoverModels(w.userId);
    await waitFor(() => w.tempod.requestsOf("session.start").length === 1, 5000, "discovery started");
    await w.credentials.putSecret("openai.api_key", "openai-key");
    const second = w.stub.discoverModels(w.userId);
    release();
    await first;
    expect(unwrap(await second).map((entry) => entry.agent)).toEqual(["claude", "codex"]);
  });

  it("destroys the temporary container on failure and retries rather than returning a default model", async () => {
    const w = await setup();
    await w.credentials.putSecret("claude.oauth_token", "claude-token");
    w.tempod.failures.set("session.start", { code: "AGENT_START_FAILED", message: "adapter failed" });
    expect(await w.stub.discoverModels(w.userId)).toMatchObject({
      ok: false,
      error: { code: "AGENT_START_FAILED" },
    });
    expect(w.container.destroyed).toBe(1);
    expect(w.container.running).toBe(false);
    w.tempod.failures.clear();
    expect(unwrap(await w.stub.discoverModels(w.userId))).toHaveLength(1);
    expect(w.container.starts).toHaveLength(2);
  });

  it("returns refreshed Codex auth to CredentialDO without writing secret events", async () => {
    const w = await setup();
    const initial = JSON.stringify({
      tokens: { access_token: "old", refresh_token: "refresh" },
      last_refresh: "2026-10-11T00:00:00Z",
    });
    const refreshed = JSON.stringify({
      tokens: { access_token: "new", refresh_token: "refresh" },
      last_refresh: "2026-10-12T00:00:00Z",
    });
    await w.credentials.replaceCodexAuth(initial, Date.parse("2026-10-11T00:00:00Z"));
    w.tempod.on("session.start", ({ agent }) => {
      w.tempod.emit({
        kind: "credential.changed",
        provider: "codex",
        content: refreshed,
        lastRefresh: Date.parse("2026-10-12T00:00:00Z"),
      });
      return sessionResult(agent);
    });
    await w.stub.discoverModels(w.userId);
    expect((await w.credentials.getCodexAuth())?.content).toBe(refreshed);
    expect(
      await runInDurableObject(w.stub, (_, state) =>
        state.storage.sql.exec("SELECT id FROM events").toArray(),
      ),
    ).toEqual([]);
  });

  it("rejects discovery using another user's instance", async () => {
    const w = await setup();
    expect(await w.stub.discoverModels("another-user")).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(w.container.starts).toHaveLength(0);
    expect(await runInDurableObject(w.stub, (instance) => internals(instance).core.wsOrNull())).toBeNull();
  });
});
