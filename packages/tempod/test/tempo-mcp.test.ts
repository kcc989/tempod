import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { handleMcpMessage, TOOLS } from "../src/tempo-mcp.ts";
import { cleanupDirs, DoClient, startTempod, type Harness } from "./helpers.ts";

afterAll(cleanupDirs);

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const SUMMARY = {
  name: "Payments",
  egressPolicy: "allowlist",
  egressAllowlist: ["pypi.org"],
  secrets: [{ name: "STRIPE_KEY", hosts: ["api.stripe.com"], set: true }],
  injectors: [],
  blockedHosts: ["files.pythonhosted.org"],
} as const;

/** Calls the daemon over its Unix socket, as `tempod mcp` does. */
const viaSocket = (path: string) => (p: string, init?: RequestInit) =>
  fetch(`http://tempod${p}`, { ...init, unix: path } as RequestInit);

describe("tempo MCP server (01, Environments)", () => {
  test("initialize, ping and tools/list follow MCP; notifications get no answer", async () => {
    const call = () => Promise.reject(new Error("unused"));
    const init = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, call);
    expect(init).toMatchObject({
      id: 1,
      result: { capabilities: { tools: {} }, serverInfo: { name: "tempo" } },
    });
    expect(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, call)).toBeNull();
    expect(await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "ping" }, call)).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: {},
    });
    const list = (await handleMcpMessage({ jsonrpc: "2.0", id: 3, method: "tools/list" }, call)) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(list.result.tools.map((t) => t.name)).toEqual([
      "environment_status",
      "propose_environment_change",
    ]);
    expect(await handleMcpMessage({ jsonrpc: "2.0", id: 4, method: "nope" }, call)).toMatchObject({
      error: { code: -32601 },
    });
    expect(TOOLS[1].description).toContain("never ask the user to paste a secret value");
  });

  test("environment_status returns the last environment.set summary; a proposal becomes an event", async () => {
    h = startTempod();
    const client = new DoClient(h.base);
    await client.opened;
    await client.hello();
    const call = viaSocket(h.app.config.mcpSocket);
    const status = async () =>
      (await handleMcpMessage(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "environment_status", arguments: {} },
        },
        call,
      )) as { result: { content: Array<{ text: string }> } };
    await client.waitFor(() => existsSync(h!.app.config.mcpSocket), 5000, "mcp socket");
    expect((await status()).result.content[0]!.text).toContain("has not sent the environment yet");
    await client.ok("environment.set", { summary: SUMMARY });
    expect(JSON.parse((await status()).result.content[0]!.text)).toEqual(SUMMARY);

    const proposal = { note: "pip needs PyPI files.", allowlistAdd: ["files.pythonhosted.org"] };
    const sent = (await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "propose_environment_change", arguments: proposal },
      },
      call,
    )) as { result: unknown };
    expect(sent.result).toEqual({ content: [{ type: "text", text: "Sent to the owner for review." }] });
    const event = await client.waitEvent("environment.proposed");
    expect(event.proposal).toEqual(proposal);

    const bad = (await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "propose_environment_change",
          arguments: { note: "x", allowlistAdd: ["Not A Host"] },
        },
      },
      call,
    )) as { result: { isError?: boolean } };
    expect(bad.result.isError).toBe(true);
    expect(client.of("environment.proposed")).toHaveLength(1);
    client.close();
  });
});
