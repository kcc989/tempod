import { DEPLOY_TOOL_NAMES, ISSUE_TOOL_NAMES, ToolReq, type TempodParams } from "@tempo/protocol";
import { Schema } from "effect";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { handleMcpMessage, TOOLS } from "../src/tempo-mcp.ts";
import { cleanupDirs, DoClient, fakeAgentCommand, testConfig, startTempod, type Harness } from "./helpers.ts";

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
      ...ISSUE_TOOL_NAMES,
      ...DEPLOY_TOOL_NAMES,
      "get_project_profile",
      "propose_intent",
      "submit_proof",
      "list_agents",
      "propose_agent_change",
    ]);
    expect(await handleMcpMessage({ jsonrpc: "2.0", id: 4, method: "nope" }, call)).toMatchObject({
      error: { code: -32601 },
    });
    expect(TOOLS[1].description).toContain("never ask the user to paste a secret value");
  });

  test("every tool's input schema is an object, as MCP clients require", async () => {
    const call = () => Promise.reject(new Error("unused"));

    const Listed = Schema.Struct({
      result: Schema.Struct({
        tools: Schema.Array(
          Schema.Struct({ name: Schema.String, inputSchema: Schema.Struct({ type: Schema.String }) }),
        ),
      }),
    });

    for (const [runId, outputKind] of [
      [undefined, undefined],
      ["run-1", "review"],
    ] as const) {
      const list = Schema.decodeUnknownSync(Listed)(
        await handleMcpMessage(
          { jsonrpc: "2.0", id: 1, method: "tools/list" },
          call,
          "session-1",
          runId,
          outputKind,
        ),
      );

      expect(list.result.tools.filter((t) => t.inputSchema.type !== "object").map((t) => t.name)).toEqual([]);
    }
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

describe("run MCP reports", () => {
  test("lists only the selected report schema in run sessions and carries validation replies outside events", async () => {
    const config = testConfig();
    h = startTempod({ ...config, agentCommands: { ...config.agentCommands, claude: fakeAgentCommand() } });
    const client = new DoClient(h.base);
    await client.hello();
    await client.waitFor(() => existsSync(h!.app.config.mcpSocket), 5000, "mcp socket");
    await client.ok("session.start", {
      sessionId: "run-session",
      agent: "claude",
      env: { TEMPO_RUN_ID: "run-id", TEMPO_RUN_OUTPUT_KIND: "plan", FAKE_STATE_DIR: h.app.config.stateDir },
      browser: "local",
    });
    const call = viaSocket(h.app.config.mcpSocket);

    const list = await handleMcpMessage(
      { id: 1, method: "tools/list" },
      call,
      "run-session",
      "run-id",
      "plan",
    );

    const names = Schema.decodeUnknownSync(
      Schema.Struct({
        result: Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
      }),
    )(list).result.tools.map((t) => t.name);

    expect(names).not.toContain("list_agents");
    expect(names).not.toContain("propose_agent_change");
    expect(
      await handleMcpMessage(
        { id: 99, method: "tools/call", params: { name: "list_agents", arguments: {} } },
        call,
        "run-session",
        "run-id",
        "plan",
      ),
    ).toMatchObject({ error: { code: -32602 } });

    expect(list).toMatchObject({
      result: {
        tools: expect.arrayContaining([
          {
            name: "report_result",
            description: expect.any(String),
            inputSchema: expect.objectContaining({
              required: expect.arrayContaining(["steps"]),
              additionalProperties: false,
            }),
          },
        ]),
      },
    });

    const request = {
      id: 2,
      method: "tools/call",
      params: {
        name: "report_result",
        arguments: { status: "done", summary: "private report", steps: [{ text: "Build" }] },
      },
    } as const;

    const pending = handleMcpMessage(request, call, "run-session", "run-id", "plan");
    await client.waitFor(() => client.raw.some((m) => m.type === "tool.req"), 5000, "report request");
    const frame = client.raw.find((m) => m.type === "tool.req")!;
    expect(frame).toMatchObject({
      type: "tool.req",
      op: "report_result",
      sessionId: "run-session",
      runId: "run-id",
      params: request.params.arguments,
    });
    client.send({
      type: "tool.res",
      id: frame.id,
      ok: false,
      error: { code: "VALIDATION_FAILED", message: "Correct the steps." },
    });
    expect(await pending).toMatchObject({
      result: { isError: true, content: [{ type: "text", text: "Correct the steps." }] },
    });
    const corrected = handleMcpMessage(request, call, "run-session", "run-id", "plan");
    await client.waitFor(
      () => client.raw.filter((m) => m.type === "tool.req").length === 2,
      5000,
      "corrected report",
    );
    const next = client.raw.filter((m) => m.type === "tool.req")[1]!;
    client.send({ type: "tool.res", id: next.id, ok: true, result: {} });
    expect(await corrected).toMatchObject({
      result: { content: [{ type: "text", text: "Result reported." }] },
    });
    expect(JSON.stringify(client.events)).not.toContain("private report");
    const stale = await handleMcpMessage(request, call, "run-session", "wrong-run", "plan");
    expect(stale).toMatchObject({ result: { isError: true } });
    const missing = await handleMcpMessage(request, call, "run-session");
    expect(missing).toMatchObject({ error: { code: -32602 } });
    const disconnected = handleMcpMessage(request, call, "run-session", "run-id", "plan");
    await client.waitFor(
      () => client.raw.filter((m) => m.type === "tool.req").length === 3,
      5000,
      "disconnect report",
    );
    client.close();
    expect(await disconnected).toMatchObject({ result: { isError: true } });
  });
  test("chat tools use request/reply frames and proposals receive validation errors without raw events", async () => {
    const config = testConfig();
    h = startTempod({ ...config, agentCommands: { ...config.agentCommands, claude: fakeAgentCommand() } });
    const client = new DoClient(h.base);
    await client.hello();
    await client.waitFor(() => existsSync(h!.app.config.mcpSocket), 5000, "mcp socket");
    await client.ok("session.start", {
      sessionId: "chat-session",
      agent: "claude",
      env: { FAKE_STATE_DIR: h.app.config.stateDir },
      browser: "local",
    });
    const call = viaSocket(h.app.config.mcpSocket);

    const listed = handleMcpMessage(
      { id: 1, method: "tools/call", params: { name: "list_agents", arguments: {} } },
      call,
      "chat-session",
    );

    await client.waitFor(() => client.raw.some((m) => m.type === "tool.req"), 5000, "library request");
    const list = client.raw.find((m) => m.type === "tool.req")!;
    expect(list).toMatchObject({ op: "list_agents", sessionId: "chat-session", params: {} });
    client.send({ type: "tool.res", id: list.id, ok: true, result: { agents: [], attachments: [] } });
    expect(await listed).toMatchObject({
      result: { content: [{ type: "text", text: '{"agents":[],"attachments":[]}' }] },
    });

    const proposal = handleMcpMessage(
      {
        id: 2,
        method: "tools/call",
        params: { name: "propose_agent_change", arguments: { note: "private proposal" } },
      },
      call,
      "chat-session",
    );

    await client.waitFor(
      () => client.raw.filter((m) => m.type === "tool.req").length === 2,
      5000,
      "proposal request",
    );
    const frame = client.raw.filter((m) => m.type === "tool.req")[1]!;
    expect(frame).toMatchObject({ op: "propose_agent_change", params: { note: "private proposal" } });
    client.send({
      type: "tool.res",
      id: frame.id,
      ok: false,
      error: { code: "AGENT_INVALID", message: "The agent is not valid." },
    });
    expect(await proposal).toMatchObject({
      result: { isError: true, content: [{ type: "text", text: "The agent is not valid." }] },
    });
    expect(JSON.stringify(client.events)).not.toContain("private proposal");

    const intent = handleMcpMessage(
      {
        id: 3,
        method: "tools/call",
        params: {
          name: "propose_intent",
          arguments: { goal: "Add due dates", approach: "A nullable column", notDoing: "No reminders" },
        },
      },
      call,
      "chat-session",
    );

    await client.waitFor(
      () => client.raw.filter((m) => m.type === "tool.req").length === 3,
      5000,
      "intent request",
    );
    const asked = client.raw.filter((m) => m.type === "tool.req")[2]!;

    expect(asked).toMatchObject({
      op: "propose_intent",
      sessionId: "chat-session",
      params: { goal: "Add due dates", approach: "A nullable column", notDoing: "No reminders" },
    });
    client.send({
      type: "tool.res",
      id: asked.id,
      ok: true,
      result: "The owner will confirm or correct the intent. End your turn now.",
    });
    expect(await intent).toMatchObject({
      result: {
        content: [{ type: "text", text: "The owner will confirm or correct the intent. End your turn now." }],
      },
    });
  });
  test("issue tools forward chat and run identity, reject forged inputs, and keep content outside events and logs", async () => {
    const config = testConfig();

    const daemon = startTempod({
      ...config,
      agentCommands: { ...config.agentCommands, claude: fakeAgentCommand() },
    });

    h = daemon;
    const client = new DoClient(daemon.base);
    await client.hello();
    await client.waitFor(() => existsSync(daemon.app.config.mcpSocket), 5000, "mcp socket");
    const call = viaSocket(daemon.app.config.mcpSocket);

    for (const identity of [
      { sessionId: "issue-chat", runId: undefined },
      { sessionId: "issue-run", runId: "actual-run" },
    ]) {
      let start: TempodParams<"session.start"> = {
        sessionId: identity.sessionId,
        agent: "claude",
        env: { FAKE_STATE_DIR: daemon.app.config.stateDir },
        browser: "local",
      };

      if (identity.runId)
        start = {
          ...start,
          env: { ...start.env, TEMPO_RUN_ID: identity.runId, TEMPO_RUN_OUTPUT_KIND: "note" },
        };
      await client.ok("session.start", start);

      const pending = handleMcpMessage(
        {
          id: 1,
          method: "tools/call",
          params: { name: "create_issue", arguments: { title: "Issue", body: "private MCP issue" } },
        },
        call,
        identity.sessionId,
        identity.runId,
        "note",
      );

      await client.waitFor(
        () => client.raw.some((frame) => frame.type === "tool.req" && frame.sessionId === identity.sessionId),
        5000,
        "issue request",
      );

      const frame = client.raw.find(
        (entry) => entry.type === "tool.req" && entry.sessionId === identity.sessionId,
      );

      const parsed = Schema.decodeUnknownSync(ToolReq)(frame);
      expect(parsed).toMatchObject({
        op: "create_issue",
        sessionId: identity.sessionId,
        params: { title: "Issue", body: "private MCP issue" },
      });
      expect(parsed.runId).toBe(identity.runId);
      client.send({ type: "tool.res", id: parsed.id, ok: true, result: { number: 1 } });
      expect(await pending).toMatchObject({ result: { content: [{ type: "text", text: '{"number":1}' }] } });
      expect(
        await handleMcpMessage(
          {
            id: 2,
            method: "tools/call",
            params: { name: "create_issue", arguments: { title: "Forged", projectId: "foreign" } },
          },
          call,
          identity.sessionId,
          identity.runId,
        ),
      ).toMatchObject({ result: { isError: true } });

      const forged = await call("/agent-tools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          op: "delete_issue",
          sessionId: identity.sessionId,
          runId: "forged-run",
          params: { number: 1 },
        }),
      });

      expect(forged.status).toBe(400);
      await client.ok("session.close", { sessionId: identity.sessionId });

      const closed = await call("/agent-tools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          op: "get_issue",
          sessionId: identity.sessionId,
          runId: identity.runId,
          params: { number: 1 },
        }),
      });

      expect(closed.status).toBe(400);
    }

    expect(JSON.stringify(client.events)).not.toContain("private MCP issue");
    expect(daemon.log.lines.join("\n")).not.toContain("private MCP issue");
  });

  test("deploy tools forward the target with run identity and refuse extra fields and forged runs", async () => {
    const config = testConfig();

    const daemon = startTempod({
      ...config,
      agentCommands: { ...config.agentCommands, claude: fakeAgentCommand() },
    });

    h = daemon;
    const client = new DoClient(daemon.base);
    await client.hello();
    await client.waitFor(() => existsSync(daemon.app.config.mcpSocket), 5000, "mcp socket");
    const call = viaSocket(daemon.app.config.mcpSocket);
    await client.ok("session.start", {
      sessionId: "deploy-run",
      agent: "claude",
      env: {
        FAKE_STATE_DIR: daemon.app.config.stateDir,
        TEMPO_RUN_ID: "run-1",
        TEMPO_RUN_OUTPUT_KIND: "note",
      },
      browser: "local",
    });

    const pending = handleMcpMessage(
      { id: 1, method: "tools/call", params: { name: "deploy_app", arguments: { target: "preview" } } },
      call,
      "deploy-run",
      "run-1",
      "note",
    );

    await client.waitFor(() => client.raw.some((frame) => frame.type === "tool.req"), 5000, "deploy request");
    const parsed = Schema.decodeUnknownSync(ToolReq)(client.raw.find((frame) => frame.type === "tool.req"));
    expect(parsed).toMatchObject({
      op: "deploy_app",
      sessionId: "deploy-run",
      runId: "run-1",
      params: { target: "preview" },
    });
    client.send({
      type: "tool.res",
      id: parsed.id,
      ok: false,
      error: { code: "FORBIDDEN", message: "Target preview is not open to agents." },
    });
    expect(await pending).toMatchObject({
      result: { isError: true, content: [{ type: "text", text: "Target preview is not open to agents." }] },
    });

    expect(
      await handleMcpMessage(
        {
          id: 2,
          method: "tools/call",
          params: { name: "deploy_app", arguments: { target: "preview", branch: "main" } },
        },
        call,
        "deploy-run",
        "run-1",
      ),
    ).toMatchObject({ result: { isError: true, content: [{ text: "Invalid deploy tool arguments." }] } });

    const forged = await call("/agent-tools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        op: "deploy_app",
        sessionId: "deploy-run",
        runId: "other-run",
        params: { target: "x" },
      }),
    });

    expect(forged.status).toBe(400);
    expect(client.raw.filter((frame) => frame.type === "tool.req")).toHaveLength(1);
  });
});
