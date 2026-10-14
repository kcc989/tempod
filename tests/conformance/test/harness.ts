import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  client,
  ndJsonStream,
  RequestError,
  type AnyMessage,
  type ClientConnection,
  type InitializeResponse,
  type McpServer,
  type NewSessionResponse,
  type RequestPermissionRequest,
} from "@agentclientprotocol/sdk";
import { AcpFields, AcpSessionNotification, PLAYWRIGHT_MCP_SERVER, type AgentId } from "@tempo/protocol";
import { Option, Predicate, Schema } from "effect";
import type { Subprocess } from "bun";

/**
 * Adapter conformance (05, Agent upgrades; 06 rule 14: run inside the image). Each agent's
 * adapter is driven the way tempod drives it (01, Agents and Sessions): ACP v1 over stdio,
 * `initialize` with tempod's client capabilities, `session/new` with the Playwright MCP server.
 */
/** Prompts that need model credentials run only with CONFORMANCE_LIVE=1. */
export const LIVE = process.env["CONFORMANCE_LIVE"] === "1";

/** tempod's per-step limit for adapter requests (packages/tempod/src/acp/session.ts). */
const STEP_MS = 90_000;

const LIVE_TURN_MS = 5 * 60_000;

/** tempod kills an adapter whose turn has not returned 10 s after session/cancel (01, Cancel). */
const CANCEL_MS = 10_000;

/** `initialize` client capabilities from 01 (Rules for every agent). */
export const CLIENT_CAPABILITIES = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: false,
  session: { notices: {} },
} as const;

export const playwrightServer = (): McpServer => ({
  name: PLAYWRIGHT_MCP_SERVER.name,
  command: PLAYWRIGHT_MCP_SERVER.command,
  args: [...PLAYWRIGHT_MCP_SERVER.args],
  env: PLAYWRIGHT_MCP_SERVER.env.map((e) => ({ ...e })),
});

export interface AgentSpec {
  readonly id: AgentId;
  /** Binary that must be on PATH, else the agent's tests are skipped. */
  readonly bin: string;
  /** Command line as tempod runs it (01, Agents "Command"), with cwd = the workspace. */
  readonly command: (cwd: string) => string[];
  /** Env tempod adds for this agent (01, Agents "Extra env" and "Login"). */
  readonly env: () => Record<string, string>;
  /** Mode ids `session/new` must report. */
  readonly requiredModes: ReadonlyArray<string>;
  /** Tempo's default mode id, or null for the agent's own default (01, Agents "Default mode"). */
  readonly defaultMode: string | null;
  /** 01 says `session/load` works; null where 01 says to verify (OpenCode, spike S9). */
  readonly loadSession: boolean | null;
}

const home = (): string => process.env["HOME"] ?? homedir();

const keep = (name: string, fallback: string) =>
  ({
    [name]: process.env[name] ?? fallback,
  }) satisfies Record<string, string>;

/** The agent table of 01. Paths follow HOME, which is /home/tempo inside the image. */
export const AGENTS: Record<AgentId, AgentSpec> = {
  claude: {
    id: "claude",
    bin: "claude-agent-acp",
    command: () => ["claude-agent-acp"],
    env: () => ({ ...keep("CLAUDE_CONFIG_DIR", join(home(), ".claude")) }),
    requiredModes: ["auto", "plan"],
    defaultMode: "auto",
    loadSession: true,
  },
  codex: {
    id: "codex",
    bin: "codex-acp",
    command: () => ["codex-acp"],
    env: () => ({ ...keep("CODEX_HOME", join(home(), ".codex")), INITIAL_AGENT_MODE: "agent-full-access" }),
    requiredModes: ["agent-full-access", "read-only"],
    defaultMode: "agent-full-access",
    loadSession: true,
  },
  opencode: {
    id: "opencode",
    bin: "opencode",
    command: (cwd) => ["opencode", "acp", "--cwd", cwd],
    env: () => ({ ...keep("OPENROUTER_API_KEY", "tempo-placeholder") }),
    requiredModes: ["build", "plan"],
    defaultMode: null,
    loadSession: null,
  },
  pi: {
    id: "pi",
    bin: "pi-acp",
    command: () => ["pi-acp"],
    env: () => ({
      ...keep("OPENROUTER_API_KEY", "tempo-placeholder"),
      ...keep("PI_CODING_AGENT_SESSION_DIR", join(home(), ".pi", "agent", "sessions")),
    }),
    requiredModes: [],
    defaultMode: null,
    loadSession: true,
  },
};

export const withTimeout = <A>(p: Promise<A>, ms: number, what: string): Promise<A> =>
  new Promise<A>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolvePromise(v);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause instanceof Error ? cause : new Error(JSON.stringify(cause)));
      },
    );
  });

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : Predicate.isObject(cause) ? JSON.stringify(cause) : String(cause);

/** A git repo with one commit, standing in for /workspace. */
export const makeRepo = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tempo-conformance-")));

  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });

    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  };

  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# Conformance fixture\n");
  git("add", "README.md");
  git(
    "-c",
    "user.name=Tempo Conformance",
    "-c",
    "user.email=conformance@tempo.invalid",
    "commit",
    "-q",
    "-m",
    "init",
  );

  return dir;
};

/** Absolute path inside `root`, else null: tempod serves fs requests only under its roots (01). */
const inside = (root: string, path: string): string | null => {
  if (!isAbsolute(path)) return null;
  const abs = resolve(path);
  const rel = relative(root, abs);

  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)) ? abs : null;
};

/** One adapter process and its ACP connection, with every update and request it sent. */
export class AgentProcess {
  readonly updates: AcpSessionNotification[] = [];
  readonly permissionRequests: RequestPermissionRequest[] = [];
  readonly fileWrites: string[] = [];
  readonly stderr: string[] = [];
  readonly proc: Subprocess<"pipe", "pipe", "pipe">;
  readonly conn: ClientConnection;
  private readonly listeners = new Set<() => void>();
  private constructor(
    readonly spec: AgentSpec,
    readonly cwd: string,
  ) {
    const env = { ...process.env, ...spec.env() } satisfies Record<string, string | undefined>;
    this.proc = Bun.spawn(spec.command(cwd), { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
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

    // Like tempod, read session/update notifications raw, before the SDK parses them.
    const readable = raw.readable.pipeThrough(
      new TransformStream<AnyMessage, AnyMessage>({
        transform: (msg, controller) => {
          if ("method" in msg && msg.method === "session/update" && !("id" in msg)) {
            const parsed = Schema.decodeUnknownOption(AcpSessionNotification)(msg.params);

            if (Option.isSome(parsed)) this.updates.push(parsed.value);
            this.notify();

            return;
          }

          controller.enqueue(msg);
        },
      }),
    );

    this.conn = client({ name: "tempo-conformance" })
      .onRequest("session/request_permission", (ctx) => {
        this.permissionRequests.push(ctx.params);
        this.notify();

        const option =
          ctx.params.options.find((o) => o.kind === "allow_once") ??
          ctx.params.options.find((o) => o.kind.startsWith("allow"));

        return option
          ? { outcome: { outcome: "selected", optionId: option.optionId } }
          : { outcome: { outcome: "cancelled" } };
      })
      .onRequest("fs/read_text_file", (ctx) => {
        const path = inside(this.cwd, ctx.params.path);

        if (!path) throw RequestError.invalidParams(undefined, "path is outside the workspace");

        if (!existsSync(path)) throw RequestError.resourceNotFound(ctx.params.path);

        return { content: readFileSync(path, "utf8") };
      })
      .onRequest("fs/write_text_file", (ctx) => {
        const path = inside(this.cwd, ctx.params.path);

        if (!path) throw RequestError.invalidParams(undefined, "path is outside the workspace");
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, ctx.params.content);
        this.fileWrites.push(path);

        return {};
      })
      .connect({ readable, writable: raw.writable });
  }
  static start(spec: AgentSpec, cwd: string): AgentProcess {
    return new AgentProcess(spec, cwd);
  }
  get running(): boolean {
    return this.proc.exitCode === null && this.proc.signalCode === null;
  }
  request<A>(method: string, params: AcpFields, ms = STEP_MS): Promise<A> {
    return withTimeout(this.conn.agent.request<A>(method, params), ms, `${this.spec.id} ${method}`);
  }
  initialize(): Promise<InitializeResponse> {
    return this.request<InitializeResponse>("initialize", {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
      clientInfo: { name: "tempo-conformance", version: "0.1.0" },
    });
  }
  newSession(): Promise<NewSessionResponse> {
    return this.request<NewSessionResponse>("session/new", {
      cwd: this.cwd,
      mcpServers: [playwrightServer()],
    });
  }
  updatesFor(sessionId: string, since = 0): AcpSessionNotification[] {
    return this.updates.slice(since).filter((u) => u.sessionId === sessionId);
  }
  /** Resolves once `check` holds, re-checked after every update or request from the agent. */
  waitFor(label: string, check: () => boolean, ms: number): Promise<void> {
    return new Promise<void>((resolvePromise, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.listeners.delete(onChange);
      };

      const onChange = () => {
        if (check()) {
          done();
          resolvePromise();
        }
      };

      const timer = setTimeout(() => {
        done();
        reject(new Error(`${this.spec.id}: timed out after ${ms} ms waiting for ${label}`));
      }, ms);

      this.listeners.add(onChange);
      onChange();
    });
  }
  async stop(): Promise<void> {
    this.conn.close();

    if (!this.running) return;
    this.proc.kill("SIGTERM");

    const exited = await Promise.race([
      this.proc.exited.then(() => true),
      Bun.sleep(5_000).then(() => false),
    ]);

    if (!exited) this.proc.kill("SIGKILL");
  }
  stderrTail(lines = 30): string {
    return this.stderr.slice(-lines).join("\n");
  }
  private notify(): void {
    for (const l of this.listeners) l();
  }
  private async readStderr(): Promise<void> {
    const decoder = new TextDecoder();
    let buf = "";

    try {
      for await (const chunk of this.proc.stderr) {
        buf += decoder.decode(chunk, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        this.stderr.push(...lines);

        if (this.stderr.length > 200) this.stderr.splice(0, this.stderr.length - 200);
      }
    } catch {
      // the process is gone
    }
  }
}

/** `session/load` of `sessionId` in a new adapter process, as tempod's reload path does (01). */
export const loadInNewProcess = async (
  spec: AgentSpec,
  cwd: string,
  sessionId: string,
): Promise<{ ok: boolean; error?: string; replayedUpdates: number }> => {
  const agent = AgentProcess.start(spec, cwd);

  try {
    const init = await agent.initialize();

    if (init.agentCapabilities?.loadSession !== true)
      return { ok: false, error: "not advertised", replayedUpdates: 0 };
    await agent.request("session/load", { sessionId, cwd, mcpServers: [playwrightServer()] });

    return { ok: true, replayedUpdates: agent.updatesFor(sessionId).length };
  } catch (e) {
    return { ok: false, error: errorText(e), replayedUpdates: agent.updatesFor(sessionId).length };
  } finally {
    await agent.stop();
  }
};

/** Prints what the agent reported, and writes it to CONFORMANCE_REPORT_DIR/<agent>.json if set. */
interface ConformanceReport {
  readonly agent: AgentId;
  readonly bin: string | null;
  readonly live: boolean;
  stderrTail?: string;
  agentInfo?: InitializeResponse["agentInfo"] | null;
  agentCapabilities?: InitializeResponse["agentCapabilities"];
  authMethods?: string[];
  modes?: string[];
  currentModeId?: string | null;
  configOptions?: ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    readonly category: string | null;
  }>;
  setMode?: string;
  loadBeforeAnyTurn?: unknown;
  liveTurn?: unknown;
  liveCancel?: string;
  loadAfterTurn?: unknown;
}

const writeReport = (agent: AgentId, report: ConformanceReport): void => {
  const json = JSON.stringify(report, null, 2);
  console.log(`conformance report for ${agent}:\n${json}`);
  const dir = process.env["CONFORMANCE_REPORT_DIR"];

  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${agent}.json`), `${json}\n`);
  }
};

const token = (): string => Math.random().toString(36).slice(2, 10);

/** The whole conformance suite for one agent; skipped when its binary is not on PATH. */
export const conformanceSuite = (spec: AgentSpec): void => {
  const bin = Bun.which(spec.bin);
  describe.skipIf(bin === null)(`${spec.id} adapter: ${spec.command("<workspace>").join(" ")}`, () => {
    let repo = "";
    let agent: AgentProcess | null = null;
    let init: InitializeResponse | null = null;
    let session: NewSessionResponse | null = null;
    const report: ConformanceReport = { agent: spec.id, bin, live: LIVE };

    const running = (): AgentProcess => {
      if (!agent) throw new Error("the adapter did not start");

      return agent;
    };

    const current = (): NewSessionResponse => {
      if (!session) throw new Error("session/new did not succeed");

      return session;
    };

    const modeOption = (s: NewSessionResponse) =>
      s.configOptions?.find((o) => o.category === "mode" && o.type === "select");

    const currentMode = (s: NewSessionResponse): string | null => {
      const option = modeOption(s);

      return Schema.is(Schema.String)(option?.currentValue)
        ? option.currentValue
        : (s.modes?.currentModeId ?? null);
    };

    const modeTarget = (s: NewSessionResponse): string | null => spec.defaultMode ?? currentMode(s);

    const setMode = (a: AgentProcess, s: NewSessionResponse, target: string) => {
      const option = modeOption(s);

      return option
        ? a.request("session/set_config_option", {
            sessionId: s.sessionId,
            configId: option.id,
            value: target,
          })
        : a.request("session/set_mode", { sessionId: s.sessionId, modeId: target });
    };

    beforeAll(() => {
      repo = makeRepo();
      agent = AgentProcess.start(spec, repo);
    });
    afterAll(async () => {
      await agent?.stop();
      report["stderrTail"] = agent?.stderrTail(10) ?? "";
      writeReport(spec.id, report);

      if (repo) rmSync(repo, { recursive: true, force: true });
    });
    test(
      "initialize with protocolVersion 1 and tempod's client capabilities returns protocolVersion 1",
      async () => {
        const a = running();
        init = await a.initialize().catch((cause: unknown) => {
          throw new Error(`initialize failed: ${errorText(cause)}\nstderr:\n${a.stderrTail()}`);
        });
        expect(init.protocolVersion).toBe(1);
        const caps = init.agentCapabilities ?? {};
        report["agentInfo"] = init.agentInfo ?? null;
        report["agentCapabilities"] = caps;
        report["authMethods"] = (init.authMethods ?? []).map((m) => m.id);
        expect(Schema.is(Schema.UndefinedOr(Schema.Boolean))(caps.loadSession)).toBe(true);

        if (spec.loadSession === true) expect(caps.loadSession).toBe(true);
      },
      STEP_MS,
    );
    test(
      "session/new with the Playwright MCP server returns a session id, the modes of 01 and a model option",
      async () => {
        const a = running();
        session = await a.newSession().catch((cause: unknown) => {
          throw new Error(`session/new failed: ${errorText(cause)}\nstderr:\n${a.stderrTail()}`);
        });
        expect(Schema.is(Schema.String)(session.sessionId)).toBe(true);
        expect(session.sessionId.length).toBeGreaterThan(0);
        const mode = modeOption(session);

        const modes =
          mode?.type === "select"
            ? mode.options.flatMap((o) => ("group" in o ? o.options.map((v) => v.value) : [o.value]))
            : (session.modes?.availableModes.map((m) => m.id) ?? []);

        const options = session.configOptions ?? [];
        report["modes"] = modes;
        report["currentModeId"] = currentMode(session);
        report["configOptions"] = options.map((o) => ({
          id: o.id,
          type: o.type,
          category: o.category ?? null,
        }));

        for (const mode of spec.requiredModes) expect(modes).toContain(mode);

        if (spec.id === "codex")
          expect(session.modes?.currentModeId, "INITIAL_AGENT_MODE").toBe("agent-full-access");
        expect(options.some((o) => o.category === "model")).toBe(true);
      },
      STEP_MS,
    );
    test(
      "sets Tempo's default mode through the advertised ACP interface",
      async () => {
        const s = current();
        const target = modeTarget(s);

        if (target === null) {
          report["setMode"] = "the agent reports no modes";
          expect(spec.requiredModes).toHaveLength(0);

          return;
        }

        await setMode(running(), s, target);
        report["setMode"] = target;
      },
      STEP_MS,
    );
    test(
      "session/load in a new adapter process, when advertised (recorded)",
      async () => {
        const s = current();

        if (init?.agentCapabilities?.loadSession !== true) {
          report["loadBeforeAnyTurn"] = "not advertised";

          return;
        }

        // With no turn yet an agent may have nothing on disk to load; the live test asserts it.
        report["loadBeforeAnyTurn"] = await loadInNewProcess(spec, repo, s.sessionId);
      },
      2 * STEP_MS,
    );
    test(
      "session/cancel is accepted and the connection stays usable",
      async () => {
        const a = running();
        const s = current();
        await a.conn.agent.notify("session/cancel", { sessionId: s.sessionId });
        const target = modeTarget(s);

        if (target !== null) await setMode(a, s, target);
        else expect((await a.newSession()).sessionId.length).toBeGreaterThan(0);
        expect(a.running).toBe(true);
      },
      STEP_MS,
    );
    test.if(LIVE)(
      "live: a prompt that creates a file reports a tool_call and ends with end_turn",
      async () => {
        const a = running();
        const s = current();
        const model = process.env[`CONFORMANCE_MODEL_${spec.id.toUpperCase()}`];

        if (model) {
          const option = (s.configOptions ?? []).find((o) => o.category === "model");

          if (!option) throw new Error("no model option to set");
          await a.request("session/set_config_option", {
            sessionId: s.sessionId,
            configId: option.id,
            value: model,
          });
        }

        const word = token();
        const name = `conformance-${word}.txt`;
        const since = a.updates.length;

        const res = await a.request<{ stopReason: string }>(
          "session/prompt",
          {
            sessionId: s.sessionId,
            prompt: [
              {
                type: "text",
                text: `Create a file named ${name} in the current directory that contains exactly the text ${word}. Use your file editing tool, then reply DONE.`,
              },
            ],
          },
          LIVE_TURN_MS,
        );

        const kinds = a.updatesFor(s.sessionId, since).map((u) => u.update.sessionUpdate);
        report["liveTurn"] = {
          stopReason: res.stopReason,
          updates: Object.fromEntries(
            [...new Set(kinds)].map((k) => [k, kinds.filter((x) => x === k).length]),
          ),
          permissionRequests: a.permissionRequests.length,
          clientFileWrites: a.fileWrites.length,
        };
        expect(res.stopReason).toBe("end_turn");
        expect(kinds).toContain("tool_call");
        expect(readFileSync(join(repo, name), "utf8").trim()).toBe(word);
      },
      LIVE_TURN_MS + 10_000,
    );
    test.if(LIVE)(
      "live: session/cancel during a turn ends it with stopReason cancelled within 10 s",
      async () => {
        const a = running();
        const s = current();
        const since = a.updates.length;

        const turn = a.request<{ stopReason: string }>(
          "session/prompt",
          {
            sessionId: s.sessionId,
            prompt: [{ type: "text", text: "Count slowly from 1 to 500, one number per line." }],
          },
          LIVE_TURN_MS,
        );

        await a.waitFor(
          "the first update of the turn",
          () => a.updatesFor(s.sessionId, since).length > 0,
          LIVE_TURN_MS,
        );
        await a.conn.agent.notify("session/cancel", { sessionId: s.sessionId });
        const res = await withTimeout(turn, CANCEL_MS, `${spec.id} cancelled turn`);
        report["liveCancel"] = res.stopReason;
        expect(res.stopReason).toBe("cancelled");
      },
      LIVE_TURN_MS + CANCEL_MS + 10_000,
    );
    test.if(LIVE)(
      "live: session/load in a new adapter process restores the session after a turn",
      async () => {
        const s = current();

        if (init?.agentCapabilities?.loadSession !== true) {
          report["loadAfterTurn"] = "not advertised";
          expect(spec.loadSession).not.toBe(true);

          return;
        }

        const outcome = await loadInNewProcess(spec, repo, s.sessionId);
        report["loadAfterTurn"] = outcome;

        if (spec.loadSession === true) expect(outcome.ok, outcome.error).toBe(true);
      },
      2 * STEP_MS,
    );
  });
};
