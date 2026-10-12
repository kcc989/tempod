import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodexCredentials } from "../src/credentials.ts";
import { cleanupDirs, DoClient, quietLogger, startTempod, tmpDir, type Harness } from "./helpers.ts";

afterAll(cleanupDirs);

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const auth = (lastRefresh: string, token = "at-1") =>
  JSON.stringify({ tokens: { access_token: token, refresh_token: "rt-1" }, last_refresh: lastRefresh });

describe("codex auth.json", () => {
  test("credential.put writes auth.json atomically with mode 0600", async () => {
    h = startTempod();
    const c = new DoClient(h.base);
    await c.hello();
    const content = auth("2026-10-01T10:00:00Z");
    expect(await c.ok<unknown>("credential.put", { provider: "codex", content, version: 3 })).toEqual({});
    const path = join(h.config.codexHome, "auth.json");
    expect(readFileSync(path, "utf8")).toBe(content);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(h.config.codexHome)).toEqual(["auth.json"]);
    const next = auth("2026-10-02T10:00:00Z", "at-2");
    await c.ok("credential.put", { provider: "codex", content: next, version: 4 });
    expect(readFileSync(path, "utf8")).toBe(next);
    expect(readdirSync(h.config.codexHome)).toEqual(["auth.json"]);
    // Our own write is not reported back as a change.
    h.app.codex.check();
    expect(c.of("credential.changed")).toHaveLength(0);
    expect(h.log.lines.join("\n")).not.toContain("at-2");
  });

  test("a refresh by Codex is sent as credential.changed with lastRefresh in epoch ms", async () => {
    h = startTempod();
    const c = new DoClient(h.base);
    await c.hello();
    await c.ok("credential.put", { provider: "codex", content: auth("2026-10-01T10:00:00Z"), version: 1 });
    const refreshed = auth("2026-10-09T08:30:00.000Z", "at-refreshed");
    writeFileSync(join(h.config.codexHome, "auth.json"), refreshed, { mode: 0o600 });
    const ev = await c.waitEvent("credential.changed", () => true, 15_000);
    expect(ev).toEqual({
      kind: "credential.changed",
      provider: "codex",
      content: refreshed,
      lastRefresh: Date.parse("2026-10-09T08:30:00.000Z"),
    });
    h.app.codex.check();
    expect(c.of("credential.changed")).toHaveLength(1);
  });

  test("closing a discovery session flushes a refresh before the container is destroyed", async () => {
    h = startTempod();
    const c = new DoClient(h.base);
    await c.hello();
    await c.ok("credential.put", { provider: "codex", content: auth("2026-10-01T10:00:00Z"), version: 1 });
    h.app.codex.stop();
    const refreshed = auth("2026-10-12T00:00:00Z", "discovery-refreshed");
    writeFileSync(join(h.config.codexHome, "auth.json"), refreshed, { mode: 0o600 });
    await c.ok("session.close", { sessionId: "discovery" });
    expect(await c.waitEvent("credential.changed", () => true, 5000)).toMatchObject({ content: refreshed });
    expect(h.log.lines.join("\n")).not.toContain("discovery-refreshed");
  });

  test("half-written and last_refresh-less files are not sent", () => {
    const home = tmpDir("codex-");
    const changes: Array<[string, number]> = [];
    const log = quietLogger();
    const creds = new CodexCredentials({
      codexHome: home,
      log,
      onChanged: (content, lastRefresh) => changes.push([content, lastRefresh]),
    });
    const path = join(home, "auth.json");
    writeFileSync(path, '{"tokens": {"access_tok');
    creds.check();
    expect(changes).toHaveLength(0);
    writeFileSync(path, JSON.stringify({ tokens: { access_token: "x" } }));
    creds.check();
    expect(changes).toHaveLength(0);
    expect(log.lines.some((l) => l.includes("without a valid last_refresh"))).toBe(true);
    const good = auth("2026-10-05T00:00:00Z");
    writeFileSync(path, good);
    creds.check();
    expect(changes).toEqual([[good, Date.parse("2026-10-05T00:00:00Z")]]);
    creds.check();
    expect(changes).toHaveLength(1);
  });
});
