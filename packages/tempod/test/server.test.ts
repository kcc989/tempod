import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { HealthResponse } from "@tempo/protocol";
import { Schema } from "effect";
import { connectWebSocket } from "../src/websocket.ts";
import { authorized } from "../src/server.ts";
import { cleanupDirs, DoClient, startTempod, testConfig, TOKEN, type Harness } from "./helpers.ts";

afterAll(cleanupDirs);

let h: Harness | null = null;

afterEach(async () => {
  await h?.close();
  h = null;
});

const auth = { Authorization: `Bearer ${TOKEN}` };

describe("HTTP", () => {
  test("every endpoint needs the bearer token", async () => {
    h = startTempod();

    for (const path of ["/v1/health", "/v1/connect", "/v1/proxy/3000/", "/nope"]) {
      expect((await fetch(h.base + path)).status).toBe(401);
      expect((await fetch(h.base + path, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    }

    expect((await fetch(h.base + "/nope", { headers: auth })).status).toBe(404);
  });
  test("constant-time check accepts only the exact header", () => {
    const req = (v?: string) => new Request("http://x/", v ? { headers: { Authorization: v } } : {});
    expect(authorized(req(`Bearer ${TOKEN}`), TOKEN)).toBe(true);
    expect(authorized(req(`Bearer ${TOKEN}x`), TOKEN)).toBe(false);
    expect(authorized(req(`bearer ${TOKEN}`), TOKEN)).toBe(false);
    expect(authorized(req(), TOKEN)).toBe(false);
  });
  test("health returns version and incarnation", async () => {
    h = startTempod();
    const res = await fetch(h.base + "/v1/health", { headers: auth });
    expect(res.status).toBe(200);
    const body = Schema.decodeUnknownSync(HealthResponse)(await res.json());
    expect(body.version).toBe("0.2.0");
    expect(body.incarnation).toBe(h.app.outbox.incarnation);
    expect(body.incarnation).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/);
  });
  test("proxy refuses 7070, ports below 1024 and tempod's own port", async () => {
    h = startTempod();

    for (const port of [7070, 80, 1023, h.server.port]) {
      expect((await fetch(`${h.base}/v1/proxy/${port}/x`, { headers: auth })).status).toBe(403);
    }

    expect((await fetch(`${h.base}/v1/proxy/abc/x`, { headers: auth })).status).toBe(400);
    expect((await fetch(`${h.base}/v1/proxy/99999/x`, { headers: auth })).status).toBe(400);
  });
  test("proxy forwards HTTP with Host localhost:<port>, the query and the body, and streams the answer", async () => {
    h = startTempod();

    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === "/stream") {
          const body = new ReadableStream({
            async start(c) {
              c.enqueue(new TextEncoder().encode("one\n"));
              await Bun.sleep(50);
              c.enqueue(new TextEncoder().encode("two\n"));
              c.close();
            },
          });

          return new Response(body, { headers: { "content-type": "text/plain" } });
        }

        return Response.json(
          {
            host: req.headers.get("host"),
            path: url.pathname,
            query: url.search,
            method: req.method,
            auth: req.headers.get("authorization"),
            fwd: req.headers.get("x-forwarded-host"),
            body: await req.text(),
          },
          { status: 201, headers: { "x-up": "1" } },
        );
      },
    });

    try {
      const res = await fetch(`${h.base}/v1/proxy/${upstream.port}/api/items?q=1&x=a%20b`, {
        method: "POST",
        headers: { ...auth, "x-forwarded-host": "3000-ws.example.com", "content-type": "text/plain" },
        body: "hello body",
      });

      expect(res.status).toBe(201);
      expect(res.headers.get("x-up")).toBe("1");
      expect(await res.json()).toEqual({
        host: `localhost:${upstream.port}`,
        path: "/api/items",
        query: "?q=1&x=a%20b",
        method: "POST",
        auth: null,
        fwd: "3000-ws.example.com",
        body: "hello body",
      });
      const root = await fetch(`${h.base}/v1/proxy/${upstream.port}`, { headers: auth });
      expect(Schema.decodeUnknownSync(Schema.Struct({ path: Schema.String }))(await root.json()).path).toBe(
        "/",
      );
      const streamed = await fetch(`${h.base}/v1/proxy/${upstream.port}/stream`, { headers: auth });
      expect(await streamed.text()).toBe("one\ntwo\n");
    } finally {
      await upstream.stop(true);
    }
  });
  test("proxy answers 502 when nothing listens", async () => {
    h = startTempod();
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = probe.port!;
    await probe.stop(true);
    expect((await fetch(`${h.base}/v1/proxy/${port}/`, { headers: auth })).status).toBe(502);
  });
  test("proxy forwards WebSocket upgrades both ways, with the subprotocol", async () => {
    h = startTempod();

    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        const proto = req.headers.get("sec-websocket-protocol");

        if (
          srv.upgrade(req, {
            data: undefined,
            headers: proto ? { "Sec-WebSocket-Protocol": proto.split(",")[0]!.trim() } : {},
          })
        ) {
          return undefined;
        }

        return new Response("no", { status: 400 });
      },
      websocket: {
        open(ws) {
          ws.send("welcome");
        },
        message(ws, msg) {
          ws.send(`echo:${String(msg)}`);
        },
      },
    });

    try {
      const ws = connectWebSocket(`${h.base.replace("http", "ws")}/v1/proxy/${upstream.port}/hmr`, {
        headers: auth,
        protocols: ["vite-hmr"],
      });

      const got: string[] = [];
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("message", (ev) => {
          got.push(String(ev.data));

          if (got.length === 1) ws.send("ping");

          if (got.length === 2) resolve();
        });
        ws.addEventListener("error", () => reject(new Error("ws error")));
      });
      expect(got).toEqual(["welcome", "echo:ping"]);
      expect(ws.protocol).toBe("vite-hmr");
      ws.close();
    } finally {
      await upstream.stop(true);
    }
  });
});

describe("WebSocket protocol", () => {
  test("one connection at a time: a new one closes the old with 4001", async () => {
    h = startTempod();
    const a = new DoClient(h.base);
    await a.opened;
    const b = new DoClient(h.base);
    await b.opened;
    await a.waitFor(() => a.closed !== null, 5_000, "close");
    expect(a.closed).toEqual({ code: 4001, reason: "replaced" });
    expect(b.closed).toBeNull();
    b.close();
  });
  test("unknown protocol version closes with 4400", async () => {
    h = startTempod();
    const c = new DoClient(h.base);
    await c.hello({ v: 2 });
    await c.waitFor(() => c.closed !== null, 5_000, "close");
    expect(c.closed!.code).toBe(4400);
  });
  test("requests before hello fail; unknown op and bad params get their codes", async () => {
    h = startTempod();
    const c = new DoClient(h.base);
    await c.opened;
    const early = await c.req("fs.list", {});
    expect(early.ok).toBe(false);
    await c.hello();
    const unknown = await c.reqRaw("magic.op", {});
    expect(unknown).toMatchObject({ ok: false, error: { code: "UNKNOWN_OP" } });
    const bad = await c.req("fs.read", { path: 42 });
    expect(bad).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    const terms = await c.req("terminal.list", {});
    expect(terms.ok).toBe(true);
    c.send({ type: "req", op: "fs.list" });
    c.send({ type: "req", id: "bad-envelope" });
    await c.waitFor(
      () =>
        c.raw.some(
          (m) =>
            Schema.decodeUnknownSync(Schema.Struct({ id: Schema.optional(Schema.String) }))(m).id ===
            "bad-envelope",
        ),
      5_000,
      "envelope error",
    );
    c.close();
  });
  test("first hello gets incarnation.changed at seq 1; a matching hello resends unacked events", async () => {
    h = startTempod();
    const c1 = new DoClient(h.base);
    await c1.hello();
    const first = await c1.waitEvent("incarnation.changed");
    expect(first.incarnation).toBe(h.app.outbox.incarnation);
    expect(c1.events[0]!.seq).toBe(1);
    // The port scanner starts with hello and reports the (empty) port set right after the handshake.
    await c1.waitEvent("ports.changed");
    expect(c1.events[1]).toMatchObject({ seq: 2, event: { kind: "ports.changed", ports: [] } });
    h.app.emit({ kind: "ports.changed", ports: [3000] });
    h.app.emit({ kind: "ports.changed", ports: [3001] });
    await c1.waitFor(() => c1.events.length >= 4);
    expect(c1.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    c1.ack(3);
    await Bun.sleep(50);
    c1.close();
    await c1.waitFor(() => c1.closed !== null);
    h.app.emit({ kind: "ports.changed", ports: [3002] });
    const c2 = new DoClient(h.base);
    await c2.hello({ incarnation: h.app.outbox.incarnation, lastAckedSeq: 3 });
    await c2.waitFor(() => c2.events.length >= 2);
    await Bun.sleep(50);
    expect(c2.events.map((e) => e.seq)).toEqual([4, 5]);
    expect(c2.of("ports.changed").map((e) => e.ports[0])).toEqual([3001, 3002]);
    c2.close();
  });
  test("a second hello on the same socket updates workspace and env without closing", async () => {
    h = startTempod();
    const c = new DoClient(h.base);
    await c.hello();
    await c.waitEvent("incarnation.changed");
    await c.waitEvent("ports.changed");
    c.ack(2);
    h.app.emit({ kind: "ports.changed", ports: [3000] });
    await c.waitFor(() => c.events.length >= 3);
    c.send({
      ...(await import("./helpers.ts")).hello({
        incarnation: h.app.outbox.incarnation,
        lastAckedSeq: 2,
        env: { NEW_VAR: "1" },
        workspace: {
          id: "01ws",
          slug: "porto",
          branch: "tempo/porto",
          baseBranch: "develop",
          repo: { owner: "o", name: "r" },
        },
      }),
    });
    await c.waitFor(() => c.events.length >= 4);
    expect(c.events[3]).toMatchObject({ seq: 3, event: { kind: "ports.changed", ports: [3000] } });
    expect(c.closed).toBeNull();
    expect(h.app.workspaceInfo?.baseBranch).toBe("develop");

    const r = await c.ok("script.start", {
      runId: "01envcheck",
      kind: "run",
      scriptId: null,
      command: 'echo "v=$NEW_VAR"',
      cwd: "",
      timeoutMs: null,
    });

    expect(r.pid).toBeGreaterThan(0);
    await c.waitEvent("script.exited", (e) => e.runId === "01envcheck");
    expect(
      c
        .of("script.output")
        .map((e) => e.data)
        .join(""),
    ).toContain("v=1");
    c.close();
  });
  test("env.set replaces the env for later scripts; settings.read resolves the files", async () => {
    h = startTempod();
    const c = new DoClient(h.base);
    await c.hello();
    await c.ok("env.set", { env: { ONLY: "yes" } });
    await Bun.write(
      `${h.config.workspace}/.tempo/settings.yaml`,
      "scripts:\n  setup: bun install\nunknown:\n  x: 1\n",
    );

    const s = await c.ok("settings.read", { overrides: { agent: { models: { pi: "m9" } } } });

    expect(s.effective.scripts.setup).toBe("bun install");
    expect(s.effective.agent.models.pi).toBe("m9");
    expect(s.warnings.length).toBeGreaterThan(0);
    const bad = await c.req("settings.read", { overrides: { environment: { sleep_after_idle_minutes: 1 } } });
    expect(bad).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    await c.ok("script.start", {
      runId: "01only",
      kind: "run",
      scriptId: null,
      command: 'echo "only=$ONLY tempo=${TEMPO_PORT:-none}"',
      cwd: "",
      timeoutMs: null,
    });
    await c.waitEvent("script.exited", (e) => e.runId === "01only");
    expect(
      c
        .of("script.output")
        .map((e) => e.data)
        .join(""),
    ).toContain("only=yes tempo=none");
    c.close();
  });
  test("SIGTERM mode: tempod.stopping, then exit 0 once shutdown is answered", async () => {
    const exits: number[] = [];
    h = startTempod(testConfig(), { exit: (code) => exits.push(code) });
    const c = new DoClient(h.base);
    await c.hello();
    h.app.onSigterm();
    const ev = await c.waitEvent("tempod.stopping");
    expect(ev.reason).toBe("sigterm");

    const prompt = await c.req("session.prompt", {
      sessionId: "s",
      turnId: "t",
      content: [{ type: "text", text: "x" }],
    });

    expect(prompt).toMatchObject({ ok: false, error: { code: "CONTAINER_NOT_READY" } });
    expect(exits).toEqual([]);
    await c.ok("shutdown", { reason: "sigterm" });
    await c.waitFor(() => exits.length > 0, 5_000, "exit");
    expect(exits).toEqual([0]);
    c.close();
  });
  test("shutdown outside SIGTERM mode keeps tempod running", async () => {
    const exits: number[] = [];
    h = startTempod(testConfig(), { exit: (code) => exits.push(code) });
    const c = new DoClient(h.base);
    await c.hello();
    await c.ok("shutdown", { reason: "sleep" });
    await Bun.sleep(100);
    expect(exits).toEqual([]);
    expect((await c.req("terminal.list", {})).ok).toBe(true);
    c.close();
  });
  test("warnings are sent as log events", async () => {
    h = startTempod(testConfig());
    const c = new DoClient(h.base);
    await c.hello();
    h.app.log.warn("something odd", { token: "secret-value", n: 1 });
    const ev = await c.waitEvent("log", (e) => e.msg === "something odd");
    expect(ev.level).toBe("warn");
    expect(ev.data).toEqual({ token: "[redacted]", n: 1 });
    expect(h.log.lines.join("\n")).not.toContain("secret-value");
    c.close();
  });
});
