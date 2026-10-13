import { chmodSync, rmSync } from "node:fs";
import { Schema, Exit } from "effect";
import {
  ARTIFACT_SUMMARY_MAX,
  ARTIFACT_TITLE_MAX,
  ARTIFACT_TOOL_DESCRIPTION,
  EnvironmentProposal,
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

/** Handles one JSON-RPC message; returns the response, or null for a notification. */
export const handleMcpMessage = async (
  msg: Json,
  call: Call,
  sessionId: string | undefined = process.env[TEMPO_SESSION_ID_ENV],
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
    case "tools/list":
      return reply({ tools: TOOLS });
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
