import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { BROWSER_IDLE_MS, BROWSER_KEEP_ALIVE_MS } from "../../src/do/workspace/browser.ts";
import type { WorkspaceDO } from "../../src/do/workspace/index.ts";
import { WORKSPACE_MIGRATIONS } from "../../src/db/do-migrations.ts";
import {
  DEFAULT_EFFECTIVE,
  driveToState,
  internals,
  seedCredentials,
  seedProject,
  seedWorkspace,
  sqlRows,
  waitFor,
  type FakeTempod,
} from "./fakes.ts";

// 01 Browser Run; 02 getBrowserLiveView, WorkspaceDetail.browserActive; 06 AT-39.

type Stub = DurableObjectStub<WorkspaceDO>;

class FakeBrowserRun {
  readonly acquires: BrowserRunAcquireOptions[] = [];
  readonly connects: string[] = [];
  readonly closed: string[] = [];
  readonly liveViews: Array<{ sessionId: string } & BrowserRunLiveViewOptions> = [];
  readonly sessions = new Map<string, BrowserRunSession>();
  targets: BrowserRunDevToolsTarget[] = [
    { id: "p1", type: "page", url: "about:blank" },
    { id: "w1", type: "service_worker", url: "http://localhost:3000/sw.js" },
    { id: "p2", type: "page", url: "http://localhost:3000/" },
  ];
  private next = 0;

  async acquire(options: BrowserRunAcquireOptions): Promise<BrowserRunAcquireResult> {
    this.acquires.push(options);
    const sessionId = `br-${++this.next}`;
    this.sessions.set(sessionId, { sessionId, startTime: Date.now() });
    return { sessionId };
  }
  async getSession(id: string): Promise<BrowserRunSession | null> {
    return this.sessions.get(id) ?? null;
  }
  async connectSession(id: string): Promise<BrowserRunConnection> {
    this.connects.push(id);
    const s = this.sessions.get(id)!;
    s.connectionId = `c-${this.connects.length}`;
    s.connectionStartTime = Date.now();
    delete s.connectionEndTime;
    return {
      sessionId: id,
      webSocket: {
        fetch: async () => {
          const pair = new WebSocketPair();
          pair[1].accept();
          return new Response(null, { status: 101, webSocket: pair[0] });
        },
      } as unknown as Fetcher,
    };
  }
  disconnect(id: string, endedAt: number): void {
    const s = this.sessions.get(id)!;
    s.connectionEndTime = endedAt;
  }
  async closeSession(id: string): Promise<BrowserRunCloseSessionResult> {
    this.closed.push(id);
    const s = this.sessions.get(id);
    if (s) s.endTime = Date.now();
    return { status: "closed" };
  }
  async getLiveView(sessionId: string, options: BrowserRunLiveViewOptions = {}): Promise<BrowserRunLiveView> {
    this.liveViews.push({ sessionId, ...options });
    return {
      devtoolsFrontendUrl: `https://live.browser.run/ui/view?s=${sessionId}&t=${options.targetId}&jwt=secret`,
      webSocketDebuggerUrl: "wss://live.browser.run/x",
      id: options.targetId ?? "",
      options: { mode: options.mode ?? "tab" },
    };
  }
  readonly devtools = { listTargets: async () => this.targets };
}

const BROWSER_ON = { ...DEFAULT_EFFECTIVE, browser: { run: true } };

interface Ctx {
  workspaceId: string;
  stub: Stub;
  tempod: FakeTempod;
  browser: FakeBrowserRun;
  userId: string;
}

const installBrowser = (stub: Stub, browser: FakeBrowserRun | undefined) =>
  runInDurableObject(stub, (instance: WorkspaceDO) => {
    internals(instance).core.browser = browser as unknown as BrowserRun | undefined;
  });

const readyWorkspace = async (
  opts: { effective?: unknown; prompt?: string; binding?: boolean } = {},
): Promise<Ctx> => {
  const seeded = await seedProject();
  await seedCredentials(seeded.userId);
  const { workspaceId, stub, tempod } = await seedWorkspace(
    seeded,
    opts.prompt ? { prompt: opts.prompt } : {},
  );
  const effective = opts.effective ?? BROWSER_ON;
  tempod.on("settings.read", () => ({ effective, warnings: [], errors: [], sources: {} }));
  const browser = new FakeBrowserRun();
  await installBrowser(stub, opts.binding === false ? undefined : browser);
  await driveToState(stub, ["ready", "working"]);
  return { workspaceId, stub, tempod, browser, userId: seeded.userId };
};

const outbound = (workspaceId: string, userId: string) =>
  (
    exports as unknown as {
      TempoOutbound: (o: { props: { workspaceId: string; userId: string } }) => Fetcher;
    }
  ).TempoOutbound({ props: { workspaceId, userId } });

const browserOutbound = (workspaceId: string) =>
  (
    exports as unknown as { BrowserOutbound: (o: { props: { workspaceId: string } }) => Fetcher }
  ).BrowserOutbound({ props: { workspaceId } });

const cdp = (ctx: Ctx, headers: Record<string, string> = {}) =>
  outbound(ctx.workspaceId, ctx.userId).fetch("https://browser.tempo.internal/", {
    headers: { Upgrade: "websocket", ...headers },
  });

const detail = async (stub: Stub) => {
  const d = await stub.getWorkspace({});
  if (!d.ok) throw new Error(d.error.code);
  return d.value;
};

const browserSessionId = async (stub: Stub) =>
  (await sqlRows(stub, "SELECT browser_session_id FROM workspace WHERE id = 1"))[0]?.["browser_session_id"] ??
  null;

describe("session.start browser mode (01, Browser Run)", { timeout: 30_000 }, () => {
  it("is run with browser.run on and the open egress policy", async () => {
    const ctx = await readyWorkspace({ prompt: "Check the app" });
    await waitFor(() => ctx.tempod.requestsOf("session.start").length === 1, 5000, "session.start");
    expect(ctx.tempod.requestsOf("session.start")[0]).toMatchObject({ browser: "run" });
  });

  it("is local by default, under the allowlist policy, and without the binding", async () => {
    const cases = [
      { effective: DEFAULT_EFFECTIVE },
      {
        effective: {
          ...BROWSER_ON,
          environment: { ...DEFAULT_EFFECTIVE.environment, egress_policy: "allowlist" },
        },
      },
      { binding: false },
    ];
    for (const c of cases) {
      const ctx = await readyWorkspace({ ...c, prompt: "Check the app" });
      await waitFor(() => ctx.tempod.requestsOf("session.start").length === 1, 5000, "session.start");
      expect(ctx.tempod.requestsOf("session.start")[0]).toMatchObject({ browser: "local" });
    }
  });
});

describe("TempoOutbound rule 11 (01, Browser Run)", { timeout: 30_000 }, () => {
  it("joins the CDP socket to one Browser Run session and reports browserActive", async () => {
    const ctx = await readyWorkspace();
    expect((await detail(ctx.stub)).browserActive).toBe(false);
    const res = await cdp(ctx, { "x-tempo-preview": "3000:forged" });
    expect(res.status).toBe(101);
    expect(res.webSocket).toBeTruthy();
    res.webSocket!.accept();
    expect(ctx.browser.acquires).toHaveLength(1);
    expect(ctx.browser.acquires[0]!.keepAlive).toBe(BROWSER_KEEP_ALIVE_MS);
    expect(Object.keys(ctx.browser.acquires[0]!.outboundByHost ?? {})).toEqual(["localhost"]);
    expect(await browserSessionId(ctx.stub)).toBe("br-1");
    expect((await detail(ctx.stub)).browserActive).toBe(true);

    const again = await cdp(ctx);
    expect(again.status).toBe(101);
    again.webSocket!.accept();
    expect(ctx.browser.acquires).toHaveLength(1);
    expect(ctx.browser.connects).toEqual(["br-1", "br-1"]);
    await waitFor(
      async () => (await sqlRows(ctx.stub, "SELECT rule, host FROM egress_log WHERE rule = 11")).length === 2,
      3000,
      "rule 11 rows",
    );
  });

  it("returns 404 for a plain request, and when Browser Run is off", async () => {
    const on = await readyWorkspace();
    const plain = await outbound(on.workspaceId, on.userId).fetch(
      "https://browser.tempo.internal/json/version",
    );
    expect(plain.status).toBe(404);
    expect(on.browser.acquires).toHaveLength(0);

    const off = await readyWorkspace({ effective: DEFAULT_EFFECTIVE });
    expect((await cdp(off)).status).toBe(404);
    expect(off.browser.acquires).toHaveLength(0);
  });

  it("acquires a new session when Browser Run ended the old one", async () => {
    const ctx = await readyWorkspace();
    (await cdp(ctx)).webSocket!.accept();
    ctx.browser.sessions.get("br-1")!.endTime = Date.now();
    (await cdp(ctx)).webSocket!.accept();
    expect(ctx.browser.acquires).toHaveLength(2);
    expect(await browserSessionId(ctx.stub)).toBe("br-2");
  });
});

describe("BrowserOutbound (01, Browser Run)", { timeout: 30_000 }, () => {
  it("forwards localhost:<port> through tempod and drops internal headers", async () => {
    const ctx = await readyWorkspace();
    (await cdp(ctx)).webSocket!.accept();
    const res = await browserOutbound(ctx.workspaceId).fetch("http://localhost:3000/app?x=1", {
      headers: { "x-tempo-preview": "3000:forged", "x-tempo-browser-cdp": "1", Accept: "text/html" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("proxied /v1/proxy/3000/app?x=1");
    const sent = ctx.tempod.proxyRequests.at(-1)!;
    expect(sent.path).toBe("/v1/proxy/3000/app?x=1");
    expect([...sent.headers.keys()].filter((k) => k.startsWith("x-tempo-"))).toEqual([]);
  });

  it("refuses other hosts, tempod's port, and requests with no open session", async () => {
    const ctx = await readyWorkspace();
    expect((await browserOutbound(ctx.workspaceId).fetch("http://localhost:3000/")).status).toBe(404);
    (await cdp(ctx)).webSocket!.accept();
    expect((await browserOutbound(ctx.workspaceId).fetch("http://localhost:7070/v1/health")).status).toBe(
      404,
    );
    expect((await browserOutbound(ctx.workspaceId).fetch("http://example.com:3000/")).status).toBe(404);
    expect((await browserOutbound(ctx.workspaceId).fetch("http://localhost/")).status).toBe(404);
  });
});

describe("getBrowserLiveView (02)", { timeout: 30_000 }, () => {
  it("is null with no session, else a fresh tab-mode URL for the newest page", async () => {
    const ctx = await readyWorkspace();
    expect(await ctx.stub.getBrowserLiveView({})).toEqual({ ok: true, value: { url: null } });
    (await cdp(ctx)).webSocket!.accept();
    const res = await ctx.stub.getBrowserLiveView({});
    expect(res).toEqual({
      ok: true,
      value: { url: "https://live.browser.run/ui/view?s=br-1&t=p2&jwt=secret" },
    });
    expect(ctx.browser.liveViews).toEqual([{ sessionId: "br-1", targetId: "p2", mode: "tab" }]);
    const rows = await sqlRows(ctx.stub, "SELECT payload_json FROM events");
    expect(JSON.stringify(rows)).not.toContain("jwt=secret");
  });

  it("is null and clears browserActive when Browser Run ended the session", async () => {
    const ctx = await readyWorkspace();
    (await cdp(ctx)).webSocket!.accept();
    ctx.browser.sessions.get("br-1")!.endTime = Date.now();
    expect(await ctx.stub.getBrowserLiveView({})).toEqual({ ok: true, value: { url: null } });
    expect((await detail(ctx.stub)).browserActive).toBe(false);
  });
});

describe("Browser Run session end (01, Browser Run)", { timeout: 30_000 }, () => {
  const age = (stub: Stub, ms: number) =>
    runInDurableObject(stub, (instance: WorkspaceDO) => {
      const core = internals(instance).core;
      const since = core.kv<number>("browserIdleSince");
      if (since !== undefined) core.setKv("browserIdleSince", since - ms);
      (instance as unknown as { lastBrowserCheck: number }).lastBrowserCheck = 0;
    });

  it("closes the session after 60 s with no CDP connection, not while one is open", async () => {
    const ctx = await readyWorkspace();
    (await cdp(ctx)).webSocket!.accept();
    await age(ctx.stub, 0);
    await runDurableObjectAlarm(ctx.stub);
    expect(ctx.browser.closed).toEqual([]);

    ctx.browser.disconnect("br-1", Date.now());
    await age(ctx.stub, 0);
    await runDurableObjectAlarm(ctx.stub);
    expect(ctx.browser.closed).toEqual([]);
    await age(ctx.stub, BROWSER_IDLE_MS);
    await runDurableObjectAlarm(ctx.stub);
    await waitFor(() => ctx.browser.closed.length === 1, 3000, "session closed");
    expect(ctx.browser.closed).toEqual(["br-1"]);
    expect((await detail(ctx.stub)).browserActive).toBe(false);
  });

  it("closes the session when the container stops", async () => {
    const ctx = await readyWorkspace();
    (await cdp(ctx)).webSocket!.accept();
    const slept = await ctx.stub.sleepWorkspace({});
    expect(slept.ok).toBe(true);
    await driveToState(ctx.stub, ["sleeping"]);
    await waitFor(() => ctx.browser.closed.length === 1, 3000, "session closed");
    expect(await browserSessionId(ctx.stub)).toBeNull();
  });
});

describe("DO migration 0005_browser_run", () => {
  it("adds workspace.browser_session_id", () => {
    const m = WORKSPACE_MIGRATIONS.find((x) => x.tag === "0005_browser_run")!;
    expect(m.statements).toEqual(["ALTER TABLE workspace ADD COLUMN browser_session_id TEXT"]);
  });
});
