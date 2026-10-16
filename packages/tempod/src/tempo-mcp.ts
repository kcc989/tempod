import { chmodSync, rmSync } from "node:fs";
import { Schema, Exit, JsonSchema } from "effect";
import {
  ARTIFACT_SUMMARY_MAX,
  ARTIFACT_TITLE_MAX,
  ARTIFACT_TOOL_DESCRIPTION,
  EnvironmentProposal,
  AgentProposal,
  OutputKind,
  RUN_REPORTS,
  TEMPO_RUN_ID_ENV,
  TEMPO_RUN_OUTPUT_KIND_ENV,
  ToolReq,
  IssueToolName,
  ISSUE_TOOL_NAMES,
  ISSUE_TOOLS,
  DeployToolName,
  DEPLOY_TOOL_NAMES,
  DEPLOY_TOOLS,
  DEPLOY_PERMISSIONS,
  PublishArtifactRequest,
  TEMPO_SESSION_ID_ENV,
  EnvironmentSummary,
} from "@tempo/protocol";
import type { PublishAnswer } from "./artifacts.ts";
import { VERSION } from "./config.ts";

/**
 * The `tempo` MCP server (01, Environments; Artifacts). `tempod mcp` speaks MCP over stdio and
 * forwards its tools to the daemon over a Unix socket. The agent can read its environment, propose
 * changes that only the owner can apply, and publish artifacts.
 */

const PROTOCOL_VERSION = "2025-06-18";

const decodeProposal = Schema.decodeUnknownExit(EnvironmentProposal);

const decodePublish = Schema.decodeUnknownExit(PublishArtifactRequest);

const hostList = {
  type: "array",
  items: { type: "string", description: "api.example.com or *.example.com" },
};

export const TOOLS = [
  {
    name: "environment_status",
    description:
      "Shows this workspace's Tempo environment: egress policy, allowed hosts, secret names and the hosts each is sent to, injectors, and hosts that were blocked recently. Never shows secret values.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "propose_environment_change",
    description:
      "Asks the owner to change this workspace's environment, for example to allow a blocked host or add an API key. The owner reviews and applies it in Tempo. Name secrets only: never ask the user to paste a secret value in chat; the owner types values in Tempo. In code, read a secret from its env var; for a secret with hosts the var holds tempo-secret-<NAME>, and Tempo puts in the real value only for requests to those hosts.",
    inputSchema: {
      type: "object",
      properties: {
        note: { type: "string", description: "Why the change is needed. Shown to the owner." },
        egressPolicy: { type: "string", enum: ["open", "allowlist"] },
        allowlistAdd: { ...hostList, description: "Hosts to allow." },
        secrets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Env var name, for example STRIPE_KEY." },
              hosts: {
                ...hostList,
                description: "Hosts that get the value. Empty means the agent can read it.",
              },
            },
            required: ["name", "hosts"],
          },
        },
        injectors: {
          type: "array",
          description:
            "Code for auth that a header swap cannot do, such as request signing. An ES module whose default export has fetch(request, env); env.SECRETS.hmac(name, data, {hash, prefix}) returns a MAC.",
          items: {
            type: "object",
            properties: { name: { type: "string" }, hosts: hostList, code: { type: "string" } },
            required: ["name", "hosts", "code"],
          },
        },
      },
      required: ["note"],
      additionalProperties: false,
    },
  },
  {
    name: "publish_artifact",
    description: ARTIFACT_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path of the file." },
        title: { type: "string", minLength: 1, maxLength: ARTIFACT_TITLE_MAX },
        summary: { type: "string", maxLength: ARTIFACT_SUMMARY_MAX },
      },
      required: ["path", "title"],
      additionalProperties: false,
    },
  },
] as const;

export interface McpBackend {
  readonly agentTool?: (input: Omit<ToolReq, "id" | "type">) => Promise<Schema.Json>;
  readonly summary: () => EnvironmentSummary | null;
  readonly propose: (proposal: EnvironmentProposal) => void;
  readonly publish: (req: PublishArtifactRequest) => Promise<PublishAnswer>;
}

const firstLines = (cause: unknown) => String(cause).split("\n").slice(0, 6).join(" ");

/** The daemon side: answers on the Unix socket. Started after hello. */
export const startMcpSocket = (path: string, backend: McpBackend) => {
  rmSync(path, { force: true });

  const server = Bun.serve({
    unix: path,
    fetch: async (req) => {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/environment")
        return Response.json({ summary: backend.summary() });

      if (req.method === "POST" && url.pathname === "/proposals") {
        let body: unknown;

        try {
          body = await req.json();
        } catch {
          return Response.json({ error: "body is not JSON" }, { status: 400 });
        }

        const exit = decodeProposal(body, { onExcessProperty: "error" });

        if (Exit.isFailure(exit)) return Response.json({ error: firstLines(exit.cause) }, { status: 400 });
        backend.propose(exit.value);

        return Response.json({ ok: true });
      }

      if (req.method === "POST" && url.pathname === "/artifacts") {
        let body: unknown;

        try {
          body = await req.json();
        } catch {
          return Response.json({ error: "body is not JSON" }, { status: 400 });
        }

        const exit = decodePublish(body, { onExcessProperty: "error" });

        if (Exit.isFailure(exit)) return Response.json({ error: firstLines(exit.cause) }, { status: 400 });
        const answer = await backend.publish(exit.value);

        return Response.json(answer, { status: "error" in answer ? 400 : 200 });
      }

      if (req.method === "POST" && url.pathname === "/agent-tools") {
        try {
          const input = Schema.decodeUnknownSync(
            Schema.Struct({
              op: ToolReq.fields.op,
              sessionId: Schema.String,
              runId: Schema.optional(Schema.String),
              params: Schema.Json,
            }),
            { onExcessProperty: "error" },
          )(await req.json());

          if (!backend.agentTool)
            return Response.json({ error: "Agent tools are unavailable." }, { status: 503 });
          const result = await backend.agentTool(input);

          return Response.json({ result });
        } catch (error) {
          return Response.json(
            {
              error: Schema.isSchemaError(error)
                ? "Invalid tool request."
                : error instanceof Error
                  ? error.message
                  : "Tool failed.",
            },
            { status: 400 },
          );
        }
      }

      return new Response("not found", { status: 404 });
    },
  });

  chmodSync(path, 0o600);

  return { stop: () => void server.stop(true) } satisfies { stop: () => void };
};

const JsonObject = Schema.Record(Schema.String, Schema.Json);

type Json = typeof JsonObject.Type;

type Call = (path: string, init?: RequestInit) => Promise<Response>;

interface McpTextResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

const text = (t: string, isError = false) => {
  const content: McpTextResult = { content: [{ type: "text", text: t }] };

  if (isError) content.isError = true;

  return content;
};

const describeSummary = (s: EnvironmentSummary | null): string => {
  if (!s) return "Tempo has not sent the environment yet. Try again in a few seconds.";

  return JSON.stringify(s, null, 2);
};

const Grants = Schema.Struct({
  result: Schema.Struct({
    read: Schema.Array(Schema.String),
    deploy: Schema.Array(Schema.Struct({ target: Schema.String })),
  }),
});

/** 14, Delivery 3: the chat's granted reads and deploy targets, or null when Tempo does not answer. */
const chatGrants = async (call: Call, sessionId: string) => {
  try {
    const res = await call("/agent-tools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "get_capabilities", sessionId, params: {} }),
    });

    return res.ok ? Schema.decodeUnknownSync(Grants)(await res.json()).result : null;
  } catch {
    return null;
  }
};

/** Handles one JSON-RPC message; returns the response, or null for a notification. */
/** MCP clients require `type: "object"`; Effect renders a struct with no fields as any non-null value. */
const toolInputSchema = (input: Schema.Struct<Schema.Struct.Fields>) =>
  Object.keys(input.fields).length === 0
    ? { type: "object", properties: {}, additionalProperties: false }
    : JsonSchema.toDocumentDraft07(Schema.toJsonSchemaDocument(input, { onExcessProperty: "error" })).schema;

export const handleMcpMessage = async (
  msg: Json,
  call: Call,
  sessionId: string | undefined = process.env[TEMPO_SESSION_ID_ENV],
  runId: string | undefined = process.env[TEMPO_RUN_ID_ENV],
  outputKind: string | undefined = process.env[TEMPO_RUN_OUTPUT_KIND_ENV],
) => {
  const id = msg["id"];
  const method = msg["method"];

  if (id === undefined || id === null) return null;
  const reply = <T>(result: T) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "tempo", version: VERSION },
      });
    case "ping":
      return reply({});
    case "tools/list": {
      const grants = !runId && sessionId ? await chatGrants(call, sessionId) : null;
      const issues = !grants || grants.read.includes("issues");
      const deploys = !grants || grants.read.includes("deployments");

      const deployNames = DEPLOY_TOOL_NAMES.filter(
        (name) => deploys && (name !== "deploy_app" || !grants || grants.deploy.length > 0),
      );

      return reply({
        tools: [
          ...TOOLS,
          ...(issues ? ISSUE_TOOL_NAMES : []).map((name) => ({
            name,
            description: ISSUE_TOOLS[name].description,
            inputSchema: toolInputSchema(ISSUE_TOOLS[name].input),
          })),
          ...deployNames.map((name) => ({
            name,
            description: DEPLOY_TOOLS[name].description,
            inputSchema: JsonSchema.toDocumentDraft07(
              Schema.toJsonSchemaDocument(DEPLOY_TOOLS[name].input, { onExcessProperty: "error" }),
            ).schema,
          })),
          ...(!runId
            ? [
                {
                  name: "get_project_profile",
                  description:
                    "Read this project's profile: its stack, services, checks, screens and notes, as the owner wrote them. Use it instead of asking the owner to restate the stack.",
                  inputSchema: { type: "object", properties: {}, additionalProperties: false },
                },
                {
                  name: "propose_intent",
                  description:
                    "Before you change any file in a new task, state the goal, your approach and what you will not do, in at most 5 lines in total. Then end your turn; Tempo confirms the intent or the owner corrects it. Call it again when your work leaves the confirmed goal.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      goal: { type: "string", minLength: 1 },
                      approach: { type: "string", minLength: 1 },
                      notDoing: { type: "string", minLength: 1 },
                    },
                    required: ["goal", "approach", "notDoing"],
                    additionalProperties: false,
                  },
                },
                {
                  name: "get_capabilities",
                  description:
                    "Get this chat's capability manifest: what you can read, which services you can call and how, the Cloudflare access and the deploy targets. Requests outside it are refused.",
                  inputSchema: { type: "object", properties: {}, additionalProperties: false },
                },
                {
                  name: "request_cloudflare_access",
                  description:
                    "Ask the owner for Cloudflare permissions this project needs, with the reason. The owner approves or denies it in Tempo; deploys and your Cloudflare API calls use what the project is granted. End your turn after asking.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      permissions: {
                        type: "array",
                        minItems: 1,
                        items: { type: "string", enum: [...DEPLOY_PERMISSIONS] },
                      },
                      reason: { type: "string", minLength: 1, maxLength: 500 },
                    },
                    required: ["permissions", "reason"],
                    additionalProperties: false,
                  },
                },
                {
                  name: "submit_proof",
                  description:
                    "Submit proof that the preview works: a summary of at most 5 lines, one screen per changed route (images you published with publish_artifact in this chat), and a note for each open design checklist item. Tempo runs the project's checks itself. Then end your turn.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      summary: { type: "string", minLength: 1 },
                      screens: {
                        type: "array",
                        maxItems: 20,
                        items: {
                          type: "object",
                          properties: {
                            route: { type: "string", minLength: 1 },
                            viewport: { type: "string", enum: ["desktop", "phone"] },
                            theme: { type: "string", enum: ["light", "dark"] },
                            image: { type: "string", minLength: 1 },
                            recording: { type: "string" },
                          },
                          required: ["route", "viewport", "theme", "image"],
                          additionalProperties: false,
                        },
                      },
                      checklist: {
                        type: "array",
                        maxItems: 50,
                        items: {
                          type: "object",
                          properties: {
                            itemId: { type: "string" },
                            note: { type: "string", maxLength: 500 },
                          },
                          required: ["itemId", "note"],
                          additionalProperties: false,
                        },
                      },
                    },
                    required: ["summary", "screens", "checklist"],
                    additionalProperties: false,
                  },
                },
                {
                  name: "list_agents",
                  description:
                    "List the owner's active agent library and this project's attachments and hooks.",
                  inputSchema: { type: "object", properties: {}, additionalProperties: false },
                },
                {
                  name: "propose_agent_change",
                  description:
                    "Propose an agent definition, project attachment or detachment. Only the owner can apply this change in Tempo. Reference secrets by name; never include their values.",
                  inputSchema: JsonSchema.toDocumentDraft07(
                    Schema.toJsonSchemaDocument(AgentProposal, { onExcessProperty: "error" }),
                  ).schema,
                },
              ]
            : []),
          ...(runId && Schema.is(OutputKind)(outputKind)
            ? [
                {
                  name: "report_result",
                  description:
                    "Report the result of this Tempo run. Correct invalid reports and try again before ending the turn.",
                  inputSchema: JsonSchema.toDocumentDraft07(
                    Schema.toJsonSchemaDocument(RUN_REPORTS[outputKind], { onExcessProperty: "error" }),
                  ).schema,
                },
              ]
            : []),
        ],
      });
    }

    case "tools/call": {
      const params = Schema.is(JsonObject)(msg["params"]) ? msg["params"] : {};
      const args = Schema.is(JsonObject)(params["arguments"]) ? params["arguments"] : {};

      try {
        if (params["name"] === "environment_status") {
          const res = await call("/environment");

          const body = Schema.decodeUnknownSync(
            Schema.Struct({ summary: Schema.NullOr(EnvironmentSummary) }),
          )(await res.json());

          return reply(text(describeSummary(body.summary)));
        }

        if (params["name"] === "propose_environment_change") {
          const res = await call("/proposals", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(args),
          });

          if (!res.ok) {
            const body = Schema.decodeUnknownSync(Schema.Struct({ error: Schema.optional(Schema.String) }))(
              await res.json().catch(() => ({})),
            );

            return reply(text(`The proposal is not valid: ${body.error ?? res.status}`, true));
          }

          return reply(text("Sent to the owner for review."));
        }

        if (params["name"] === "publish_artifact") {
          const res = await call("/artifacts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...args, sessionId: sessionId ?? "" }),
          });

          const body = Schema.decodeUnknownSync(
            Schema.Struct({ text: Schema.optional(Schema.String), error: Schema.optional(Schema.String) }),
          )(await res.json().catch(() => ({})));

          if (!res.ok) return reply(text(body.error ?? `tempod answered ${res.status}`, true));

          return reply(text(body.text ?? ""));
        }

        if (Schema.is(IssueToolName)(params["name"]) || Schema.is(DeployToolName)(params["name"])) {
          const name = params["name"];
          const issue = Schema.is(IssueToolName)(name);

          const decoded = Schema.decodeUnknownExit(
            issue ? ISSUE_TOOLS[name].input : DEPLOY_TOOLS[name].input,
            {
              onExcessProperty: "error",
            },
          )(params["arguments"] ?? {});

          if (Exit.isFailure(decoded))
            return reply(text(`Invalid ${issue ? "issue" : "deploy"} tool arguments.`, true));

          const res = await call("/agent-tools", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              op: params["name"],
              sessionId: sessionId ?? "",
              runId,
              params: decoded.value,
            }),
          });

          const body = Schema.decodeUnknownSync(
            Schema.Struct({
              result: Schema.optionalKey(Schema.Json),
              error: Schema.optionalKey(Schema.String),
            }),
          )(await res.json());

          return reply(
            text(
              res.ok
                ? JSON.stringify(body.result)
                : (body.error ?? `${issue ? "Issue" : "Deploy"} tool rejected.`),
              !res.ok,
            ),
          );
        }

        if (!runId && params["name"] === "get_project_profile") {
          const res = await call("/agent-tools", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ op: "get_project_profile", sessionId: sessionId ?? "", params: {} }),
          });

          const body = Schema.decodeUnknownSync(
            Schema.Struct({
              result: Schema.optionalKey(Schema.Json),
              error: Schema.optionalKey(Schema.String),
            }),
          )(await res.json());

          return reply(
            text(res.ok ? JSON.stringify(body.result) : (body.error ?? "Profile unavailable."), !res.ok),
          );
        }

        if (
          !runId &&
          (params["name"] === "propose_intent" ||
            params["name"] === "submit_proof" ||
            params["name"] === "request_cloudflare_access")
        ) {
          const res = await call("/agent-tools", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ op: params["name"], sessionId: sessionId ?? "", params: args }),
          });

          const body = Schema.decodeUnknownSync(
            Schema.Struct({
              result: Schema.optionalKey(Schema.String),
              error: Schema.optionalKey(Schema.String),
            }),
          )(await res.json());

          return reply(
            text(res.ok ? (body.result ?? "") : (body.error ?? "Tempo rejected the call."), !res.ok),
          );
        }

        if (
          !runId &&
          (params["name"] === "list_agents" ||
            params["name"] === "propose_agent_change" ||
            params["name"] === "get_capabilities")
        ) {
          const res = await call("/agent-tools", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ op: params["name"], sessionId: sessionId ?? "", params: args }),
          });

          const body = Schema.decodeUnknownSync(
            Schema.Struct({
              result: Schema.optionalKey(Schema.Json),
              error: Schema.optionalKey(Schema.String),
            }),
          )(await res.json());

          return reply(
            text(
              res.ok
                ? params["name"] === "list_agents"
                  ? JSON.stringify(body.result)
                  : "Sent to the owner for review."
                : (body.error ?? "Tool rejected."),
              !res.ok,
            ),
          );
        }

        if (params["name"] === "report_result" && runId && Schema.is(OutputKind)(outputKind)) {
          const res = await call("/agent-tools", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ op: "report_result", sessionId: sessionId ?? "", runId, params: args }),
          });

          const body = Schema.decodeUnknownSync(Schema.Struct({ error: Schema.optional(Schema.String) }))(
            await res.json(),
          );

          return reply(text(res.ok ? "Result reported." : (body.error ?? "Report rejected."), !res.ok));
        }

        return fail(-32602, `unknown tool ${String(params["name"])}`);
      } catch {
        return reply(text("Could not reach tempod.", true));
      }
    }

    default:
      return fail(-32601, `method not found: ${String(method)}`);
  }
};

/** `tempod mcp`: newline-delimited JSON-RPC on stdin and stdout. */
export const runMcpStdio = async (socketPath: string): Promise<void> => {
  const call: Call = (path, init) => {
    const options = { ...init, unix: socketPath };

    return fetch(`http://tempod${path}`, options);
  };

  const write = <T>(m: T) => process.stdout.write(`${JSON.stringify(m)}\n`);
  let buffer = "";
  const decoder = new TextDecoder();

  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;

    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);

      if (!line) continue;
      let msg: Json;

      try {
        msg = Schema.decodeUnknownSync(Schema.fromJsonString(JsonObject))(line);
      } catch {
        write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
        continue;
      }

      const res = await handleMcpMessage(msg, call);

      if (res) write(res);
    }
  }
};
