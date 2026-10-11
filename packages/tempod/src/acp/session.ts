import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  client,
  ndJsonStream,
  RequestError,
  type AnyMessage,
  type ClientConnection,
  type ContentBlock as AcpContentBlock,
  type McpServer,
  type ReadTextFileRequest,
  type RequestPermissionResponse,
  type WriteTextFileRequest,
} from "@agentclientprotocol/sdk";
import {
  modelOption,
  newId,
  PLAYWRIGHT_MCP_SERVER,
  TempoError,
  type AgentId,
  type PermissionOption,
  type SessionStartResult,
  type TempodEvent,
} from "@tempo/protocol";
import type { Subprocess } from "bun";
import { ITEM_CONTENT_MAX, tailLines } from "../bounds.ts";
import { VERSION } from "../config.ts";
import { killGroup } from "../exec.ts";
import { insideRoots } from "../fs.ts";
import { errorText, type Logger } from "../log.ts";
import { isObj, modeConfig, toConfigOptions, toModes } from "./convert.ts";
import { SessionMapper, type TurnOutcome } from "./mapper.ts";

const STDERR_LINES = 200;
const STDERR_LINE_CHARS = 2_000;
const START_STEP_MS = 90_000;
const CLOSE_REQUEST_MS = 3_000;

export const playwrightServer = (): McpServer => ({
  name: PLAYWRIGHT_MCP_SERVER.name,
  command: PLAYWRIGHT_MCP_SERVER.command,
  args: [...PLAYWRIGHT_MCP_SERVER.args],
  env: PLAYWRIGHT_MCP_SERVER.env.map((e) => ({ ...e })),
});

export const CLIENT_CAPABILITIES = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: false,
  session: { notices: {} },
} as const;

const CREDENTIAL_ERROR = /\b401\b|refresh_token/;

export interface SessionDeps {
  readonly workspace: string;
  readonly attachments: string;
  readonly log: Logger;
  readonly emit: (event: TempodEvent) => void;
  readonly cancelGraceMs: number;
  readonly killGraceMs: number;
  readonly mergeMs: number;
  readonly maxBytes: number;
  readonly onGone: (session: AgentSession) => void;
  readonly onProcess: (session: AgentSession, pid: number | null) => void;
}

interface Turn {
  readonly turnId: string;
  cancelRequested: boolean;
  ended: boolean;
  cancelTimer: ReturnType<typeof setTimeout> | null;
  readonly endedPromise: Promise<void>;
  readonly resolveEnded: () => void;
}

interface PendingPermission {
  readonly turnId: string;
  readonly itemId: string;
  readonly options: PermissionOption[];
  readonly resolve: (r: RequestPermissionResponse) => void;
}

/** Why tempod stopped the adapter itself; null means it exited on its own (a crash). */
type ExitReason = "requested" | "evicted" | "cancel-timeout";

const withTimeout = <A>(p: Promise<A>, ms: number, what: string): Promise<A> =>
  new Promise<A>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(errorText(e)));
      },
    );
  });

/** One adapter process with one ACP session (01, Sessions). */
export class AgentSession {
  readonly mapper: SessionMapper;
  readonly proc: Subprocess<"pipe", "pipe", "pipe">;
  private readonly conn: ClientConnection;
  private readonly stderr: string[] = [];
  acpSessionId: string | null = null;
  capabilities: Record<string, unknown> = {};
  alive = true;
  lastUsed = Date.now();
  turn: Turn | null = null;
  private loading = false;
  /** The ACP session id whose `session/load` failed: its late replay messages are dropped. */
  private dropReplayOf: string | null = null;
  private started = false;
  private exitReason: ExitReason | null = null;
  private readonly permissions = new Map<string, PendingPermission>();
  private readonly byRpcId = new Map<string, Promise<RequestPermissionResponse>>();
  private readonly seenTurns: string[] = [];
  readonly exited: Promise<{ code: number | null; signal: string | null }>;

  constructor(
    readonly sessionId: string,
    readonly agent: AgentId,
    command: ReadonlyArray<string>,
    env: Record<string, string>,
    private readonly deps: SessionDeps,
  ) {
    this.mapper = new SessionMapper(sessionId, {
      emit: deps.emit,
      log: deps.log,
      newId,
      mergeMs: deps.mergeMs,
      maxBytes: deps.maxBytes,
      attachments: deps.attachments,
    });
    this.proc = Bun.spawn([...command], {
      cwd: deps.workspace,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    deps.onProcess(this, this.proc.pid);
    void this.readStderr();
    const proc = this.proc;
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        proc.stdin.write(chunk);
        return Promise.resolve(proc.stdin.flush()).then(() => undefined);
      },
      close() {
        void proc.stdin.end();
      },
      abort() {
        void proc.stdin.end();
      },
    });
    const raw = ndJsonStream(writable, proc.stdout);
    const readable = raw.readable.pipeThrough(
      new TransformStream<AnyMessage, AnyMessage>({
        transform: (msg, controller) => {
          if (this.tap(msg)) controller.enqueue(msg);
        },
      }),
    );
    this.conn = client({ name: "tempod" })
      .onRequest("session/request_permission", (ctx) => {
        const key = String(ctx.requestId);
        const p = this.byRpcId.get(key);
        this.byRpcId.delete(key);
        return p ?? Promise.resolve({ outcome: { outcome: "cancelled" } });
      })
      .onRequest("fs/read_text_file", (ctx) => this.readTextFile(ctx.params))
      .onRequest("fs/write_text_file", (ctx) => this.writeTextFile(ctx.params))
      .connect({ readable, writable: raw.writable });
    this.exited = this.proc.exited.then(() => {
      const signal = this.proc.signalCode ?? null;
      const code = signal ? null : this.proc.exitCode;
      this.onExit(code, signal);
      return { code, signal };
    });
  }

  get pid(): number {
    return this.proc.pid;
  }

  get busy(): boolean {
    return this.turn !== null && !this.turn.ended;
  }

  /** The last 200 stderr lines, each cut at 2,000 chars (01, Crashes), within the message size limit. */
  stderrTail(): string {
    return tailLines(this.stderr, ITEM_CONTENT_MAX);
  }

  private async readStderr(): Promise<void> {
    const decoder = new TextDecoder();
    let buf = "";
    const push = (line: string) => {
      this.stderr.push(line.length > STDERR_LINE_CHARS ? line.slice(0, STDERR_LINE_CHARS) : line);
      if (this.stderr.length > STDERR_LINES) this.stderr.shift();
    };
    try {
      for await (const chunk of this.proc.stderr) {
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          push(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
        if (buf.length > STDERR_LINE_CHARS * 4) {
          push(buf);
          buf = "";
        }
      }
    } catch {
      // process gone
    }
    if (buf) push(buf);
  }

  /** Sees every inbound message in stream order, before the SDK; returns false to swallow it. */
  private tap(msg: AnyMessage): boolean {
    if (!isObj(msg) || typeof (msg as { method?: unknown }).method !== "string") return true;
    const m = msg as { id?: string | number | null; method: string; params?: unknown };
    // A throw here would error the stream and end the session, so failures are only logged.
    try {
      if (m.method === "session/update" && m.id === undefined) {
        this.onUpdate(m.params);
        return false;
      }
      if (m.method === "session/request_permission" && m.id !== undefined && m.id !== null) {
        this.onPermissionRequest(String(m.id), m.params);
      }
    } catch (e) {
      this.deps.log.local("error", "agent message handling failed", {
        sessionId: this.sessionId,
        method: m.method,
        error: errorText(e),
      });
      return m.method !== "session/update";
    }
    return true;
  }

  private onUpdate(params: unknown): void {
    if (!isObj(params)) return;
    if (this.loading) {
      this.mapper.captureState(params["update"]);
      return;
    }
    const sid = params["sessionId"];
    if (this.dropReplayOf !== null && sid === this.dropReplayOf && sid !== this.acpSessionId) {
      this.deps.log.debug("replay of a failed session/load dropped", { sessionId: this.sessionId });
      return;
    }
    if (this.acpSessionId !== null && sid !== this.acpSessionId) {
      this.deps.log.warn("session/update for another ACP session dropped", { sessionId: this.sessionId });
      return;
    }
    this.mapper.handle(params["update"]);
  }

  private onPermissionRequest(rpcId: string, params: unknown): void {
    const turn = this.turn;
    if (!turn || turn.ended || turn.cancelRequested || !isObj(params)) {
      this.byRpcId.set(rpcId, Promise.resolve({ outcome: { outcome: "cancelled" } }));
      return;
    }
    const requestId = newId();
    const { itemId, title, options } = this.mapper.addPermission(
      requestId,
      params["toolCall"],
      params["options"],
    );
    const promise = new Promise<RequestPermissionResponse>((resolve) => {
      this.permissions.set(requestId, { turnId: turn.turnId, itemId, options, resolve });
    });
    this.byRpcId.set(rpcId, promise);
    this.deps.emit({
      kind: "permission.requested",
      requestId,
      sessionId: this.sessionId,
      turnId: turn.turnId,
      itemId,
      title,
      options,
    });
  }

  hasPermission(requestId: string): boolean {
    return this.permissions.has(requestId);
  }

  respondPermission(requestId: string, optionId: string | null): void {
    const p = this.permissions.get(requestId);
    if (!p) throw new TempoError("NOT_FOUND");
    if (optionId !== null && !p.options.some((o) => o.optionId === optionId)) {
      throw new TempoError("VALIDATION_FAILED", "Unknown option.");
    }
    this.permissions.delete(requestId);
    p.resolve(
      optionId === null
        ? { outcome: { outcome: "cancelled" } }
        : { outcome: { outcome: "selected", optionId } },
    );
    this.mapper.resolvePermission(p.itemId, optionId);
  }

  private cancelPermissions(): void {
    for (const [id, p] of this.permissions) {
      this.permissions.delete(id);
      p.resolve({ outcome: { outcome: "cancelled" } });
      this.mapper.resolvePermission(p.itemId, null);
    }
  }

  private readTextFile(params: ReadTextFileRequest): { content: string } {
    const path = insideRoots([this.deps.workspace, this.deps.attachments], params.path);
    if (!path) throw RequestError.invalidParams(undefined, "path is outside the allowed folders");
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      throw RequestError.resourceNotFound(params.path);
    }
    const line = params.line ?? null;
    const limit = params.limit ?? null;
    if (line === null && limit === null) return { content: text };
    const lines = text.split("\n");
    const start = Math.max(0, (line ?? 1) - 1);
    const end = limit === null ? lines.length : start + Math.max(0, limit);
    return { content: lines.slice(start, end).join("\n") };
  }

  private writeTextFile(params: WriteTextFileRequest): Record<string, never> {
    const path = insideRoots([this.deps.workspace, this.deps.attachments], params.path);
    if (!path) throw RequestError.invalidParams(undefined, "path is outside the allowed folders");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, params.content);
    return {};
  }

  private request<A>(method: string, params: unknown, ms = START_STEP_MS): Promise<A> {
    return withTimeout(this.conn.agent.request<A>(method, params), ms, method);
  }

  /** Steps 4 to 7 of "Start a session", or the reload path (01, Sessions). */
  async start(p: {
    modeId?: string | null;
    model?: string | null;
    acpSessionId?: string | null;
  }): Promise<SessionStartResult> {
    const init = await this.request<{
      protocolVersion?: unknown;
      agentCapabilities?: unknown;
      _meta?: unknown;
    }>("initialize", {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
      clientInfo: { name: "tempod", version: VERSION },
    });
    if (init.protocolVersion !== 1)
      throw new Error(`unsupported ACP protocol version ${String(init.protocolVersion)}`);
    this.capabilities = isObj(init.agentCapabilities) ? structuredClone(init.agentCapabilities) : {};
    const steering = isObj(init._meta) ? init._meta["steering"] : undefined;
    this.capabilities["steering"] = isObj(steering) && steering["supported"] === true;
    let reloaded = false;
    let handoff = false;
    const wanted = p.acpSessionId ?? null;
    if (wanted !== null) {
      if (this.capabilities["loadSession"] === true) {
        this.loading = true;
        try {
          const res = await this.request<unknown>("session/load", {
            sessionId: wanted,
            cwd: this.deps.workspace,
            mcpServers: [playwrightServer()],
          });
          this.acpSessionId = wanted;
          this.applySessionResponse(res);
          reloaded = true;
        } catch (e) {
          this.deps.log.warn("session/load failed; handing off", {
            sessionId: this.sessionId,
            error: errorText(e),
          });
          handoff = true;
          this.dropReplayOf = wanted;
        } finally {
          this.loading = false;
        }
      } else handoff = true;
    }
    if (!reloaded) {
      const res = await this.request<{ sessionId?: unknown }>("session/new", {
        cwd: this.deps.workspace,
        mcpServers: [playwrightServer()],
      });
      if (typeof res.sessionId !== "string") throw new Error("session/new returned no sessionId");
      this.acpSessionId = res.sessionId;
      this.applySessionResponse(res);
    }
    const state = this.mapper.state;
    if (p.modeId && p.modeId !== state.modeId) {
      try {
        await this.setMode(p.modeId);
      } catch (e) {
        this.deps.log.warn("setting the mode failed", { sessionId: this.sessionId, error: errorText(e) });
      }
    }
    if (p.model) {
      const option = modelOption(state.configOptions);
      if (!option)
        this.deps.log.warn("agent has no model option", { sessionId: this.sessionId, agent: this.agent });
      else if (option.currentValue !== p.model) {
        try {
          await this.setConfig(option.id, p.model);
        } catch (e) {
          this.deps.log.warn("setting the model failed", { sessionId: this.sessionId, error: errorText(e) });
        }
      }
    }
    this.started = true;
    return this.result(reloaded, handoff);
  }

  result(reloaded: boolean, handoff: boolean): SessionStartResult {
    const s = this.mapper.state;
    return {
      acpSessionId: this.acpSessionId ?? "",
      modes: s.modes,
      modeId: s.modeId,
      configOptions: s.configOptions,
      availableCommands: s.commands,
      capabilities: this.capabilities,
      reloaded,
      handoff,
    };
  }

  private applySessionResponse(res: unknown): void {
    if (!isObj(res)) return;
    const state = this.mapper.state;
    const modes = res["modes"];
    if (isObj(modes)) {
      state.modes = toModes(modes["availableModes"]);
      if (typeof modes["currentModeId"] === "string") state.modeId = modes["currentModeId"];
    }
    if (Array.isArray(res["configOptions"])) state.configOptions = toConfigOptions(res["configOptions"]);
    this.mapper.syncModeConfig();
  }

  async setMode(modeId: string): Promise<void> {
    const option = modeConfig(this.mapper.state.configOptions);
    if (option) await this.setConfig(option.id, modeId);
    else {
      await this.request("session/set_mode", { sessionId: this.acpSessionId, modeId }, 30_000);
      this.mapper.state.modeId = modeId;
    }
    this.lastUsed = Date.now();
  }

  async setConfig(configId: string, value: string | boolean): Promise<ReturnType<typeof toConfigOptions>> {
    const params =
      typeof value === "boolean"
        ? { sessionId: this.acpSessionId, configId, type: "boolean", value }
        : { sessionId: this.acpSessionId, configId, value };
    const res = await this.request<{ configOptions?: unknown }>("session/set_config_option", params, 30_000);
    if (Array.isArray(res.configOptions))
      this.mapper.state.configOptions = toConfigOptions(res.configOptions);
    this.mapper.syncModeConfig();
    this.deps.emit({
      kind: "session.updated",
      sessionId: this.sessionId,
      patch: {
        configOptions: this.mapper.state.configOptions,
        ...(modeConfig(this.mapper.state.configOptions)
          ? { modes: this.mapper.state.modes, modeId: this.mapper.state.modeId }
          : {}),
      },
    });
    this.lastUsed = Date.now();
    return this.mapper.state.configOptions;
  }

  /** Starts a turn; the end arrives as `turn.ended`. Returns false for a turn id it already ran. */
  prompt(turnId: string, content: ReadonlyArray<Record<string, unknown>>): boolean {
    if (this.seenTurns.includes(turnId)) return false;
    if (this.busy) throw new TempoError("SESSION_BUSY");
    this.seenTurns.push(turnId);
    if (this.seenTurns.length > 50) this.seenTurns.shift();
    let resolveEnded!: () => void;
    const turn: Turn = {
      turnId,
      cancelRequested: false,
      ended: false,
      cancelTimer: null,
      endedPromise: new Promise<void>((r) => (resolveEnded = r)),
      resolveEnded: () => resolveEnded(),
    };
    this.turn = turn;
    this.lastUsed = Date.now();
    this.mapper.startTurn(turnId);
    this.deps.emit({ kind: "turn.started", sessionId: this.sessionId, turnId });
    this.conn.agent
      .request<{ stopReason?: unknown }>("session/prompt", {
        sessionId: this.acpSessionId,
        prompt: content as unknown as AcpContentBlock[],
      })
      .then(
        (res) => this.finishTurn(turn, typeof res?.stopReason === "string" ? res.stopReason : null),
        (e: unknown) => void this.onPromptError(turn, e),
      );
    return true;
  }

  private steering = new Map<string, Promise<{ outcome: "injected" | "promptRequired" | "unsupported" }>>();

  steer(
    turnId: string,
    messageId: string,
    content: ReadonlyArray<Record<string, unknown>>,
  ): Promise<{ outcome: "injected" | "promptRequired" | "unsupported" }> {
    const previous = this.steering.get(messageId);
    if (previous) return previous;
    if (this.capabilities["steering"] !== true) return Promise.resolve({ outcome: "unsupported" });
    if (!this.turn || this.turn.ended || this.turn.turnId !== turnId)
      return Promise.resolve({ outcome: "promptRequired" });
    const request = this.request<{ outcome?: unknown }>(
      "_session/steering",
      {
        sessionId: this.acpSessionId,
        prompt: content,
        _meta: { steering: { idleBehavior: "promptRequired" } },
      },
      30_000,
    ).then((result) => {
      if (result.outcome !== "injected" && result.outcome !== "promptRequired")
        throw new TempoError("INTERNAL", "The agent returned an invalid steering result.");
      return { outcome: result.outcome } as { outcome: "injected" | "promptRequired" };
    });
    this.steering.set(messageId, request);
    if (this.steering.size > 50) this.steering.delete(this.steering.keys().next().value!);
    return request;
  }

  private async onPromptError(turn: Turn, e: unknown): Promise<void> {
    if (turn.ended) return;
    if (this.conn.signal.aborted || !this.alive) {
      // The adapter is going away: its exit handler ends the turn.
      await Promise.race([this.exited, Bun.sleep(this.deps.killGraceMs + 1_000)]);
      if (!turn.ended)
        this.finishTurn(turn, null, { code: "AGENT_CRASHED", message: "The agent stopped unexpectedly." });
      return;
    }
    const data = e instanceof RequestError && e.data !== undefined ? ` ${JSON.stringify(e.data)}` : "";
    const text = `${errorText(e)}${data}`;
    const credential = CREDENTIAL_ERROR.test(text);
    if (credential && this.agent === "codex")
      this.deps.emit({ kind: "credential.invalid", provider: "codex" });
    this.finishTurn(turn, null, {
      code: credential ? "CREDENTIAL_INVALID" : "INTERNAL",
      message: text.length > 2_000 ? text.slice(0, 2_000) : text,
    });
  }

  private finishTurn(
    turn: Turn,
    stopReason: string | null,
    error?: { code: string; message: string },
    interrupted = false,
  ): void {
    if (turn.ended) return;
    turn.ended = true;
    if (turn.cancelTimer) clearTimeout(turn.cancelTimer);
    this.cancelPermissions();
    const outcome: TurnOutcome = interrupted
      ? "interrupted"
      : error
        ? "failed"
        : stopReason === "cancelled"
          ? "cancelled"
          : "completed";
    this.mapper.endTurn(outcome);
    this.deps.emit({
      kind: "turn.ended",
      sessionId: this.sessionId,
      turnId: turn.turnId,
      stopReason,
      ...(error ? { error } : {}),
      ...(interrupted ? { interrupted: true } : {}),
    });
    if (this.turn === turn) this.turn = null;
    this.lastUsed = Date.now();
    turn.resolveEnded();
  }

  /** session/cancel; after the grace period the adapter is killed and the turn ends as cancelled. */
  async cancel(turnId: string): Promise<void> {
    const turn = this.turn;
    if (!turn || turn.ended || turn.turnId !== turnId) return;
    if (!turn.cancelRequested) {
      turn.cancelRequested = true;
      this.cancelPermissions();
      this.notifyCancel();
      turn.cancelTimer = setTimeout(() => {
        if (turn.ended) return;
        this.deps.log.warn("agent ignored session/cancel; killing it", { sessionId: this.sessionId });
        // agent.exited goes first, so the DO reloads the session before it starts the next queued turn.
        this.kill("cancel-timeout");
        this.finishTurn(turn, "cancelled");
      }, this.deps.cancelGraceMs);
    }
    await turn.endedPromise;
  }

  private notifyCancel(): void {
    if (this.acpSessionId === null || this.conn.signal.aborted) return;
    this.conn.agent.notify("session/cancel", { sessionId: this.acpSessionId }).catch(() => undefined);
  }

  /** SIGTERM mode and shutdown: cancel and end the running turn as interrupted at once. */
  interrupt(): void {
    const turn = this.turn;
    if (!turn || turn.ended) return;
    turn.cancelRequested = true;
    this.notifyCancel();
    this.finishTurn(turn, null, undefined, true);
  }

  /** Stops the adapter: session/close when supported (only if `graceful`), then SIGTERM, SIGKILL later. */
  async close(reason: ExitReason, graceful: boolean): Promise<void> {
    if (!this.alive) {
      await Promise.race([this.exited, Bun.sleep(this.deps.killGraceMs + 1_000)]);
      return;
    }
    const caps = this.capabilities["sessionCapabilities"];
    if (
      graceful &&
      this.acpSessionId !== null &&
      isObj(caps) &&
      isObj(caps["close"]) &&
      !this.conn.signal.aborted
    ) {
      try {
        await this.request("session/close", { sessionId: this.acpSessionId }, CLOSE_REQUEST_MS);
      } catch (e) {
        this.deps.log.debug("session/close failed", { sessionId: this.sessionId, error: errorText(e) });
      }
    }
    this.kill(reason);
    await Promise.race([this.exited, Bun.sleep(this.deps.killGraceMs + 1_000)]);
  }

  /**
   * SIGTERM to the adapter's process group, SIGKILL after the grace period. A planned exit (eviction,
   * cancel timeout) is reported at once, so the DO stops treating the session as live.
   */
  private kill(reason: ExitReason): void {
    if (this.exitReason === null) this.exitReason = reason;
    if (!this.alive) return;
    this.alive = false;
    this.deps.onGone(this);
    if (this.started && reason !== "requested") {
      this.emitExited(null, null, reason === "evicted" ? "evicted" : "cancelled");
    }
    this.killGroupLater();
  }

  private killGroupLater(): void {
    const pid = this.proc.pid;
    killGroup(pid, "SIGTERM");
    // The leader may be gone already while its children (claude, Playwright, Chromium) still run.
    setTimeout(() => killGroup(pid, "SIGKILL"), this.deps.killGraceMs);
  }

  private emitExited(
    code: number | null,
    signal: string | null,
    reason: "crashed" | "evicted" | "cancelled",
  ): void {
    this.deps.emit({
      kind: "agent.exited",
      sessionId: this.sessionId,
      code,
      signal,
      stderrTail: this.stderrTail(),
      reason,
    });
  }

  private onExit(code: number | null, signal: string | null): void {
    const wasAlive = this.alive;
    this.alive = false;
    this.mapper.flush();
    this.conn.close();
    this.deps.onProcess(this, null);
    if (wasAlive) this.deps.onGone(this);
    if (this.exitReason === null) this.killGroupLater();
    const turn = this.turn;
    if (turn && !turn.ended) {
      this.finishTurn(turn, null, { code: "AGENT_CRASHED", message: "The agent stopped unexpectedly." });
    }
    this.cancelPermissions();
    // Planned exits were reported by kill(); a failed start is reported by session.start with the stderr tail.
    if (this.exitReason !== null || !this.started) return;
    this.deps.log.warn("agent exited", { sessionId: this.sessionId, agent: this.agent, code, signal });
    this.emitExited(code, signal, "crashed");
  }
}
