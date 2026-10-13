import { Schema } from "effect";
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
const viaSocket = (path: string) => (p: string, init?: RequestInit) => {
  const options = { ...init, unix: path };

  return fetch(`http://tempod${p}`, options);
};

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

    const list = Schema.decodeUnknownSync(
      Schema.Struct({
        result: Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
      }),
    )(await handleMcpMessage({ jsonrpc: "2.0", id: 3, method: "tools/list" }, call));

    expect(list.result.tools.map((t) => t.name)).toEqual([
      "environment_status",
      "propose_environment_change",
      "publish_artifact",
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
      Schema.decodeUnknownSync(
        Schema.Struct({
          result: Schema.Struct({ content: Schema.Array(Schema.Struct({ text: Schema.String })) }),
        }),
      )(
        await handleMcpMessage(
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "environment_status", arguments: {} },
          },
          call,
        ),
      );

    await client.waitFor(() => existsSync(h!.app.config.mcpSocket), 5000, "mcp socket");
    expect((await status()).result.content[0]!.text).toContain("has not sent the environment yet");
    await client.ok("environment.set", { summary: SUMMARY });
    expect(JSON.parse((await status()).result.content[0]!.text)).toEqual(SUMMARY);

    const proposal = { note: "pip needs PyPI files.", allowlistAdd: ["files.pythonhosted.org"] };

    const sent = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "propose_environment_change", arguments: proposal },
      },
      call,
    );

    expect(sent).toHaveProperty("result", {
      content: [{ type: "text", text: "Sent to the owner for review." }],
    });
    const event = await client.waitEvent("environment.proposed");
    expect(event.proposal).toEqual(proposal);

    const bad = await handleMcpMessage(
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
    );

    expect(bad).toHaveProperty("result.isError", true);
    expect(client.of("environment.proposed")).toHaveLength(1);
    client.close();
  });
});
