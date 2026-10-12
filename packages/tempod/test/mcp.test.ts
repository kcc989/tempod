import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PLAYWRIGHT_MCP_SERVER, type McpServerSpec, type SessionStartResult } from "@tempo/protocol";
import { acpMcpServers, piMcpConfig, writePiMcpConfig, type Bridge } from "../src/acp/mcp.ts";
import { parseBridgeArgs, runBridge, sseEvents, streamLines } from "../src/mcp-bridge.ts";
import {
  cleanupDirs,
  DoClient,
  fakeAgentCommand,
  startTempod,
  testConfig,
  tmpDir,
  type Harness,
} from "./helpers.ts";

afterAll(cleanupDirs);

const bridge: Bridge = { command: ["/usr/local/bin/tempod"], env: { SSL_CERT_FILE: "/ca.crt" } };
const fs: McpServerSpec = {
  name: "fs",
  transport: "stdio",
  command: "npx",
  args: ["-y", "fs"],
  env: [{ name: "ROOT", value: "/w" }],
};
const linear: McpServerSpec = {
  name: "linear",
  transport: "http",
  url: "https://mcp.linear.app/mcp",
  headers: [{ name: "Authorization", value: "tempo-placeholder:mcp:abc:authorization" }],
};
const legacy: McpServerSpec = { name: "old", transport: "sse", url: "https://old.test/sse", headers: [] };

const bridged = (spec: Extract<McpServerSpec, { transport: "http" | "sse" }>) => ({
  name: spec.name,
  command: "/usr/local/bin/tempod",
  args: [
    "mcp-bridge",
    "--transport",
    spec.transport,
    "--url",
    spec.url,
    ...spec.headers.flatMap((h) => ["--header", `${h.name}: ${h.value}`]),
  ],
  env: [{ name: "SSL_CERT_FILE", value: "/ca.crt" }],
});

describe("acpMcpServers (01, User MCP servers)", () => {
  test("Playwright first; remote transports pass through when the agent supports them", () => {
    const list = acpMcpServers([fs, linear, legacy], { mcpCapabilities: { http: true, sse: true } }, bridge);
    expect(list.map((s) => s.name)).toEqual([PLAYWRIGHT_MCP_SERVER.name, "tempo", "fs", "linear", "old"]);
    expect(list[2]).toEqual({
      name: "fs",
      command: "npx",
      args: ["-y", "fs"],
      env: [{ name: "ROOT", value: "/w" }],
    });
    expect(list[3]).toEqual({ type: "http", name: "linear", url: linear.url, headers: [...linear.headers] });
    expect(list[4]).toEqual({ type: "sse", name: "old", url: legacy.url, headers: [] });
  });

  test("a transport the agent lacks goes through the tempod bridge", () => {
    const list = acpMcpServers([linear, legacy], { mcpCapabilities: { http: true, sse: false } }, bridge);
    expect(list[2]).toMatchObject({ type: "http" });
    expect(list[3]).toEqual(bridged(legacy));
    expect(acpMcpServers([linear], {}, bridge)[2]).toEqual(bridged(linear));
  });
});

describe("pi mcp.json (01, Pi)", () => {
  test("holds Playwright and every server; sse uses the bridge", () => {
    const config = piMcpConfig([fs, linear, legacy], bridge);
    expect(Object.keys(config.mcpServers)).toEqual(["playwright", "tempo", "fs", "linear", "old"]);
    expect(config.mcpServers["fs"]).toEqual({ command: "npx", args: ["-y", "fs"], env: { ROOT: "/w" } });
    expect(config.mcpServers["linear"]).toEqual({
      url: linear.url,
      headers: { Authorization: linear.headers[0]!.value },
    });
    expect(config.mcpServers["old"]).toEqual({
      command: "/usr/local/bin/tempod",
      args: bridged(legacy).args,
      env: { SSL_CERT_FILE: "/ca.crt" },
    });
  });

  test("is written with mode 0600 and replaced on each write", () => {
    const dir = join(tmpDir(), ".pi", "agent");
    writePiMcpConfig(dir, [fs, linear], bridge);
    writePiMcpConfig(dir, [fs], bridge);
    const path = join(dir, "mcp.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8")).mcpServers)).toEqual([
      "playwright",
      "tempo",
      "fs",
    ]);
  });
});

describe("session.start with mcpServers", () => {
  let h: Harness | null = null;
  afterEach(async () => {
    await h?.close();
    h = null;
  });

  const run = async (agent: "claude" | "pi", env: Record<string, string>) => {
    const cmd = fakeAgentCommand();
    const config = testConfig({ agentCommands: { claude: cmd, pi: cmd }, selfCommand: ["/opt/tempod"] });
    h = startTempod(config);
    const c = new DoClient(h.base);
    await c.hello();
    await c.waitEvent("incarnation.changed");
    const state = tmpDir("fake-agent-");
    await c.ok<SessionStartResult>(
      "session.start",
      {
        sessionId: "s1",
        agent,
        env: { FAKE_STATE_DIR: state, ...env },
        browser: "local",
        mcpServers: [fs, linear],
      },
      20_000,
    );
    const line = readFileSync(join(state, "calls.log"), "utf8")
      .split("\n")
      .find((l) => l.includes(" mcpjson "))!;
    return {
      config,
      servers: JSON.parse(line.slice(line.indexOf(" mcpjson ") + 9)) as Array<Record<string, unknown>>,
    };
  };

  test("passes the user servers after Playwright and bridges http when the agent lacks it", async () => {
    const { servers } = await run("claude", {});
    expect(servers.map((s) => s["name"])).toEqual(["playwright", "tempo", "fs", "linear"]);
    expect(servers[3]).toMatchObject({
      command: "/opt/tempod",
      args: [
        "mcp-bridge",
        "--transport",
        "http",
        "--url",
        linear.url,
        "--header",
        `Authorization: ${linear.headers[0]!.value}`,
      ],
    });
    await h!.close();
    h = null;
    const direct = await run("claude", { FAKE_MCP_HTTP: "1" });
    expect(direct.servers[3]).toEqual({
      type: "http",
      name: "linear",
      url: linear.url,
      headers: linear.headers,
    });
  }, 30_000);

  test("writes ~/.pi/agent/mcp.json before a Pi session starts", async () => {
    const { config } = await run("pi", {});
    const file = JSON.parse(readFileSync(join(config.piAgentDir, "mcp.json"), "utf8"));
    expect(Object.keys(file.mcpServers)).toEqual(["playwright", "tempo", "fs", "linear"]);
  }, 30_000);
});

const lines = async function* (items: string[], waitFor?: Promise<unknown>) {
  for (const item of items) yield item;
  if (waitFor) await waitFor;
};

describe("mcp-bridge", () => {
  test("parses its flags", () => {
    expect(
      parseBridgeArgs(["--transport", "http", "--url", "https://x.test/mcp", "--header", "A: b: c"]),
    ).toEqual({
      transport: "http",
      url: "https://x.test/mcp",
      headers: [["A", "b: c"]],
    });
    expect(() => parseBridgeArgs(["--transport", "ws", "--url", "https://x"])).toThrow();
    expect(() => parseBridgeArgs(["--url", "https://x"])).toThrow();
  });

  test("parses server-sent events", async () => {
    const body = new Response(
      'event: endpoint\ndata: /m?s=1\n\n: comment\ndata: {"a":1}\r\n\r\ndata: x\ndata: y\n',
    ).body!;
    const events = [];
    for await (const e of sseEvents(body)) events.push(e);
    expect(events).toEqual([
      { event: "endpoint", data: "/m?s=1" },
      { event: "message", data: '{"a":1}' },
      { event: "message", data: "x\ny" },
    ]);
  });

  test("streamable HTTP: JSON and SSE replies, session id, protocol version and headers", async () => {
    const seen: Array<{ method: string; headers: Headers; body: string }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = req.method === "POST" ? await req.text() : "";
        seen.push({ method: req.method, headers: req.headers, body });
        if (req.method === "GET") return new Response(null, { status: 405 });
        if (req.method === "DELETE") return new Response(null, { status: 200 });
        const msg = JSON.parse(body);
        if (msg.method === "initialize")
          return Response.json(
            { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {} } },
            { headers: { "mcp-session-id": "sess-1" } },
          );
        if (msg.method === "tools/call")
          return new Response(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: 1 } })}\n\n`,
            {
              headers: { "content-type": "text/event-stream" },
            },
          );
        if (msg.method === "boom") return new Response("no", { status: 500 });
        return new Response(null, { status: 202 });
      },
    });
    try {
      const out: string[] = [];
      const url = `http://127.0.0.1:${server.port}/mcp`;
      const code = await runBridge(
        { transport: "http", url, headers: [["Authorization", "Bearer x"]] },
        {
          lines: (async function* () {
            yield JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
            while (out.length < 1) await Bun.sleep(5);
            yield JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
            yield JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {} });
            yield JSON.stringify({ jsonrpc: "2.0", id: 3, method: "boom" });
          })(),
          write: (l) => out.push(l),
          log: () => {},
        },
      );
      expect(code).toBe(0);
      expect(out.map((l) => JSON.parse(l).id).sort()).toEqual([1, 2, 3]);
      expect(JSON.parse(out.find((l) => JSON.parse(l).id === 3)!).error.message).toContain("500");
      const posts = seen.filter((s) => s.method === "POST");
      expect(posts[0]!.headers.get("authorization")).toBe("Bearer x");
      expect(posts[0]!.headers.get("accept")).toBe("application/json, text/event-stream");
      expect(posts[0]!.headers.get("mcp-session-id")).toBeNull();
      expect(posts[1]!.headers.get("mcp-session-id")).toBe("sess-1");
      expect(posts[1]!.headers.get("mcp-protocol-version")).toBe("2025-06-18");
      expect(seen.some((s) => s.method === "DELETE" && s.headers.get("mcp-session-id") === "sess-1")).toBe(
        true,
      );
    } finally {
      await server.stop(true);
    }
  });

  test("SSE transport: posts to the endpoint and relays message events", async () => {
    let push: (data: string) => void = () => {};
    const posts: Array<{ url: string; auth: string | null }> = [];
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "GET") {
          const stream = new ReadableStream<string>({
            start(ctrl) {
              ctrl.enqueue("event: endpoint\ndata: /messages?session=7\n\n");
              push = (data) => ctrl.enqueue(`event: message\ndata: ${data}\n\n`);
            },
          });
          return new Response(stream, { headers: { "content-type": "text/event-stream" } });
        }
        posts.push({ url: url.pathname + url.search, auth: req.headers.get("authorization") });
        const msg = JSON.parse(await req.text());
        push(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { echo: msg.method } }));
        return new Response("Accepted", { status: 202 });
      },
    });
    try {
      const out: string[] = [];
      let done: () => void = () => {};
      const finished = new Promise<void>((r) => (done = r));
      const run = runBridge(
        {
          transport: "sse",
          url: `http://127.0.0.1:${server.port}/sse`,
          headers: [["Authorization", "Bearer s"]],
        },
        {
          lines: lines([JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" })], finished),
          write: (l) => {
            out.push(l);
            done();
          },
          log: () => {},
        },
      );
      expect(await run).toBe(0);
      expect(posts).toEqual([{ url: "/messages?session=7", auth: "Bearer s" }]);
      expect(JSON.parse(out[0]!)).toEqual({ jsonrpc: "2.0", id: 9, result: { echo: "tools/list" } });
    } finally {
      await server.stop(true);
    }
  });

  test("tempod mcp-bridge runs as a subcommand over stdio", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method !== "POST") return new Response(null, { status: 405 });
        const msg = JSON.parse(await req.text());
        return Response.json({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18" } });
      },
    });
    try {
      const proc = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "../src/main.ts"),
          "mcp-bridge",
          "--transport",
          "http",
          "--url",
          `http://127.0.0.1:${server.port}/`,
        ],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      );
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
      await proc.stdin.end();
      const out: string[] = [];
      for await (const l of streamLines(proc.stdout)) out.push(l);
      expect(await proc.exited).toBe(0);
      expect(JSON.parse(out[0]!).result.protocolVersion).toBe("2025-06-18");
    } finally {
      await server.stop(true);
    }
  });
});
