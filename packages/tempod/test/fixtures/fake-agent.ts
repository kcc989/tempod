/**
 * A scripted ACP v1 agent for tests. The first word of the prompt text picks the behaviour:
 * hello, tool, permission, slow, hang, crash, child, big-image, big-text, fail401, write <path>, read <path>.
 * Env: FAKE_STATE_DIR (sessions on disk, for session/load), FAKE_LOAD=0 (no loadSession),
 * FAKE_LOAD_FAIL=1 (session/load fails after replaying), FAKE_CLOSE=0 (no session/close),
 * FAKE_IGNORE_SIGTERM=1.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AgentSideConnection,
  ndJsonStream,
  RequestError,
  type Agent,
  type AuthenticateResponse,
  type CancelNotification,
  type CloseSessionRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionConfigOption,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
} from "@agentclientprotocol/sdk";

const env = process.env;
const stateDir = env["FAKE_STATE_DIR"] ?? join(env["HOME"] ?? "/tmp", ".fake-agent");
mkdirSync(stateDir, { recursive: true });
if (env["FAKE_IGNORE_SIGTERM"] === "1") process.on("SIGTERM", () => {});

const record = (line: string): void =>
  appendFileSync(join(stateDir, "calls.log"), `${process.pid} ${line}\n`);
process.stderr.write(`fake agent ${process.pid} started\n`);
record("start");

interface SessionRec {
  modeId: string;
  model: string;
  history: string[];
}

const sessionFile = (id: string): string => join(stateDir, `session-${id}.json`);
const loadRec = (id: string): SessionRec | null => {
  try {
    return JSON.parse(readFileSync(sessionFile(id), "utf8")) as SessionRec;
  } catch {
    return null;
  }
};
const saveRec = (id: string, rec: SessionRec): void => writeFileSync(sessionFile(id), JSON.stringify(rec));

const modes = (current: string) => ({
  availableModes: [
    { id: "default", name: "Default" },
    { id: "plan", name: "Plan" },
  ],
  currentModeId: current,
});

const configOptions = (model: string, mode = "default"): SessionConfigOption[] => [
  ...(env["FAKE_MODE_CONFIG"] === "1"
    ? [
        {
          id: "agent-mode",
          name: "Session Mode",
          category: "mode",
          type: "select" as const,
          currentValue: mode,
          options: [
            {
              group: "agents",
              name: "Agents",
              options: [
                { value: "default", name: "Default" },
                { value: "plan", name: "Plan", description: "Plan only" },
              ],
            },
          ],
        },
      ]
    : []),
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: model,
    options: [
      { value: "m1", name: "Model one" },
      { value: "m2", name: "Model two" },
    ],
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeAgent implements Agent {
  private readonly cancels = new Map<string, () => void>();

  constructor(private readonly conn: AgentSideConnection) {}

  private update(sessionId: string, update: SessionNotification["update"]): Promise<void> {
    return this.conn.sessionUpdate({ sessionId, update });
  }

  private text(
    sessionId: string,
    text: string,
    kind: "agent_message_chunk" | "agent_thought_chunk" = "agent_message_chunk",
  ) {
    return this.update(sessionId, { sessionUpdate: kind, content: { type: "text", text } });
  }

  initialize(): InitializeResponse {
    record("initialize");
    return {
      protocolVersion: 1,
      _meta: { steering: { supported: env["FAKE_STEERING"] === "1" } },
      agentCapabilities: {
        loadSession: env["FAKE_LOAD"] !== "0",
        promptCapabilities: { image: true },
        ...(env["FAKE_CLOSE"] === "0" ? {} : { sessionCapabilities: { close: {} } }),
      },
    };
  }

  authenticate(): AuthenticateResponse {
    return {};
  }

  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (method !== "_session/steering" || env["FAKE_STEERING"] !== "1")
      throw RequestError.methodNotFound(method);
    record(`steer ${JSON.stringify(params)}`);
    const sessionId = params["sessionId"] as string;
    const prompt = params["prompt"] as Array<{ text?: string }>;
    await this.text(sessionId, `Steered: ${prompt.map((p) => p.text ?? "").join("")}`);
    return { outcome: env["FAKE_STEERING_IDLE"] === "1" ? "promptRequired" : "injected" };
  }

  newSession(): NewSessionResponse {
    const sessionId = `acp-${Math.random().toString(36).slice(2, 10)}`;
    saveRec(sessionId, { modeId: "default", model: "m1", history: [] });
    record(`new ${sessionId}`);
    return {
      sessionId,
      ...(env["FAKE_MODE_CONFIG"] === "1" ? {} : { modes: modes("default") }),
      configOptions: configOptions("m1"),
    };
  }

  async loadSession(p: LoadSessionRequest): Promise<LoadSessionResponse> {
    record(`load ${p.sessionId}`);
    const rec = loadRec(p.sessionId);
    if (!rec) throw RequestError.resourceNotFound(p.sessionId);
    for (const line of rec.history) await this.text(p.sessionId, `replay: ${line}`);
    await this.update(p.sessionId, { sessionUpdate: "session_info_update", title: "Old title" });
    if (env["FAKE_LOAD_FAIL"] === "1") throw RequestError.internalError(undefined, "load failed");
    return {
      ...(env["FAKE_MODE_CONFIG"] === "1" ? {} : { modes: modes(rec.modeId) }),
      configOptions: configOptions(rec.model, rec.modeId),
    };
  }

  setSessionMode(p: SetSessionModeRequest): Record<string, never> {
    if (env["FAKE_MODE_CONFIG"] === "1") throw RequestError.methodNotFound("session/set_mode");
    const rec = loadRec(p.sessionId);
    if (rec) saveRec(p.sessionId, { ...rec, modeId: p.modeId });
    record(`mode ${p.modeId}`);
    return {};
  }

  setSessionConfigOption(p: SetSessionConfigOptionRequest): SetSessionConfigOptionResponse {
    const rec = loadRec(p.sessionId);
    if (p.configId === "agent-mode" && !["default", "plan"].includes(String(p.value)))
      throw RequestError.invalidParams();
    const next = {
      modeId: rec?.modeId ?? "default",
      model: rec?.model ?? "m1",
      history: rec?.history ?? [],
      ...(p.configId === "agent-mode" ? { modeId: String(p.value) } : { model: String(p.value) }),
    };
    if (rec) saveRec(p.sessionId, next);
    record(`config ${p.configId}=${String(p.value)}`);
    return { configOptions: configOptions(next.model, next.modeId) };
  }

  closeSession(p: CloseSessionRequest): Record<string, never> {
    record(`close ${p.sessionId}`);
    return {};
  }

  cancel(p: CancelNotification): void {
    record(`cancel ${p.sessionId}`);
    this.cancels.get(p.sessionId)?.();
  }

  private waitCancel(sessionId: string): Promise<void> {
    return new Promise((resolve) => this.cancels.set(sessionId, resolve));
  }

  async prompt(p: PromptRequest): Promise<PromptResponse> {
    const sid = p.sessionId;
    const first = p.prompt.find((b) => b.type === "text");
    const text = first && first.type === "text" ? first.text : "";
    const [cmd = "", ...rest] = text.trim().split(/\s+/);
    const arg = rest.join(" ");
    record(`prompt ${text}`);
    const rec = loadRec(sid);
    if (rec) saveRec(sid, { ...rec, history: [...rec.history, text] });
    switch (cmd) {
      case "hello":
        await this.text(sid, "Thinking", "agent_thought_chunk");
        await this.text(sid, "Hel");
        await this.text(sid, "lo");
        await this.text(sid, " world");
        await this.update(sid, { sessionUpdate: "session_info_update", title: "Greeting" });
        return { stopReason: "end_turn" };
      case "tool":
        await this.update(sid, {
          sessionUpdate: "tool_call",
          toolCallId: "tc1",
          title: "Read a.txt",
          kind: "read",
          status: "pending",
          locations: [{ path: "/workspace/a.txt", line: 1 }],
          rawInput: { path: "a.txt" },
        });
        await this.update(sid, {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "one" } }],
        });
        await this.text(sid, "done");
        return { stopReason: "end_turn" };
      case "permission": {
        await this.update(sid, {
          sessionUpdate: "tool_call",
          toolCallId: "tc2",
          title: "Edit b.txt",
          kind: "edit",
          status: "pending",
        });
        const res = await this.conn.requestPermission({
          sessionId: sid,
          toolCall: { toolCallId: "tc2", title: "Edit b.txt" },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        });
        const outcome = res.outcome.outcome === "selected" ? `selected:${res.outcome.optionId}` : "cancelled";
        record(`permission ${outcome}`);
        if (outcome === "cancelled") return { stopReason: "cancelled" };
        await this.update(sid, { sessionUpdate: "tool_call_update", toolCallId: "tc2", status: "completed" });
        await this.text(sid, outcome);
        return { stopReason: "end_turn" };
      }
      case "slow":
        await this.text(sid, "working");
        await this.waitCancel(sid);
        return { stopReason: "cancelled" };
      case "hang":
        await this.text(sid, "stuck");
        return new Promise<PromptResponse>(() => {});
      case "crash":
        process.stderr.write("about to crash\nfatal: boom\n");
        await sleep(20);
        process.exit(3);
      // falls through: unreachable
      case "child": {
        const child = spawn("sleep", ["1000"], { stdio: "ignore" });
        writeFileSync(join(stateDir, "child.pid"), String(child.pid));
        await sleep(50);
        process.exit(4);
      }
      // falls through: unreachable
      case "big-image": {
        const data = Buffer.alloc(400 * 1024, 7).toString("base64");
        await this.update(sid, {
          sessionUpdate: "tool_call",
          toolCallId: "tc3",
          title: "Screenshot",
          kind: "other",
          status: "completed",
          content: [{ type: "content", content: { type: "image", data, mimeType: "image/png" } }],
        });
        return { stopReason: "end_turn" };
      }
      case "big-text": {
        await this.update(sid, {
          sessionUpdate: "tool_call",
          toolCallId: "tc4",
          title: "Big",
          kind: "other",
          status: "pending",
        });
        const big = "x".repeat(1_500_000);
        await this.update(sid, {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc4",
          status: "completed",
          content: [{ type: "diff", path: "/workspace/big.txt", oldText: big, newText: `${big}y` }],
          rawOutput: { output: big },
        });
        await this.text(sid, "z");
        await this.text(sid, "z".repeat(299_999));
        return { stopReason: "end_turn" };
      }
      case "fail401":
        throw RequestError.internalError({ status: 401 }, "Unauthorized: refresh_token expired");
      case "write":
        try {
          await this.conn.writeTextFile({ sessionId: sid, path: arg, content: "written by agent" });
          await this.text(sid, "write ok");
        } catch (e) {
          await this.text(sid, `write error: ${e instanceof Error ? e.message : JSON.stringify(e)}`);
        }
        return { stopReason: "end_turn" };
      case "read":
        try {
          const r = await this.conn.readTextFile({ sessionId: sid, path: arg });
          await this.text(sid, `read ok: ${r.content}`);
        } catch (e) {
          await this.text(sid, `read error: ${e instanceof Error ? e.message : JSON.stringify(e)}`);
        }
        return { stopReason: "end_turn" };
      default:
        await this.text(sid, `echo: ${text}`);
        return { stopReason: "end_turn" };
    }
  }
}

const output = new WritableStream<Uint8Array>({
  write(chunk) {
    return new Promise<void>((resolve, reject) =>
      process.stdout.write(chunk, (e) => (e ? reject(e) : resolve())),
    );
  },
});
const input = Bun.stdin.stream() as ReadableStream<Uint8Array>;
const connection = new AgentSideConnection((conn) => new FakeAgent(conn), ndJsonStream(output, input));
await connection.closed;
record("closed");
process.exit(0);
