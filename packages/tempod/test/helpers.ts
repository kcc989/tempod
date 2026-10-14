import { mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TempodEvent,
  TempodToDo,
  TEMPOD_REQUESTS,
  type TempodRes,
  type TempodOp,
  type TempodParams,
  type TempodResult,
  type JsonData,
  type JsonDataFields,
  type DoToTempod,
  type TempodEventOf,
} from "@tempo/protocol";
import { Schema } from "effect";
import { loadConfig, type Config, type ConfigOverrides } from "../src/config.ts";
import { run } from "../src/exec.ts";
import { Logger } from "../src/log.ts";
import { startServer, type TempodServer } from "../src/server.ts";
import { Tempod, type TempodOptions } from "../src/tempod.ts";
import { connectWebSocket } from "../src/websocket.ts";

export const TOKEN = "test-token-0123456789";

const dirs: string[] = [];

export const tmpDir = (prefix = "tempod-"): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);

  return d;
};

export const cleanupDirs = (): void => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
};

export const quietLogger = (): Logger & { lines: string[] } => {
  const lines: string[] = [];
  const log = Object.assign(new Logger({ write: (l) => lines.push(l), minLevel: "debug" }), { lines });

  return log;
};

export const testConfig = (
  overrides: ConfigOverrides & { home?: string; workspace?: string } = {},
): Config => {
  const root = tmpDir();
  const home = overrides.home ?? join(root, "home");
  const workspace = overrides.workspace ?? join(root, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });

  return loadConfig(
    {
      TEMPOD_TOKEN: TOKEN,
      TEMPOD_PORT: "0",
      TEMPOD_HOME: home,
      TEMPOD_WORKSPACE: workspace,
      TEMPOD_CA_CERT: join(root, "missing-ca.crt"),
      TEMPOD_CA_WAIT_MS: "0",
    },
    overrides,
  );
};

export interface Harness {
  app: Tempod;
  server: TempodServer;
  config: Config;
  log: Logger & { lines: string[] };
  base: string;
  close(): Promise<void>;
}

export const startTempod = (config: Config = testConfig(), opts: Partial<TempodOptions> = {}): Harness => {
  const log = quietLogger();
  const app = new Tempod(config, { log, forcePollingWatcher: true, portFiles: [], exit: () => {}, ...opts });
  const server = startServer(app, { hostname: "127.0.0.1", port: 0 });

  return {
    app,
    server,
    config,
    log,
    base: `http://127.0.0.1:${server.port}`,
    close: async () => {
      await server.stop();
      await app.close();
    },
  };
};

export const hello = (over: JsonDataFields = {}) => ({
  type: "hello",
  v: 1,
  incarnation: null,
  lastAckedSeq: 0,
  workspace: {
    id: "01ws",
    slug: "lisbon",
    branch: "tempo/lisbon",
    baseBranch: "main",
    repo: { owner: "o", name: "r" },
  },
  env: { TEMPO_WORKSPACE_ID: "01ws", TEMPO_PORT: "3000" },
  ...over,
});

const decodeEvent = Schema.decodeUnknownSync(TempodEvent);

export interface EventMsg {
  seq: number;
  ts: number;
  event: TempodEvent;
}

/** A WebSocket client that plays the WorkspaceDO. */
export class DoClient {
  readonly ws: WebSocket;
  readonly events: EventMsg[] = [];
  readonly raw: TempodToDo[] = [];
  closed: { code: number; reason: string } | null = null;
  private readonly waiters = new Map<string, (res: TempodRes) => void>();
  private readonly listeners = new Set<() => void>();
  private nextId = 0;
  readonly opened: Promise<void>;

  constructor(base: string, token = TOKEN) {
    this.ws = connectWebSocket(`${base.replace("http", "ws")}/v1/connect`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve(), { once: true });
      this.ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = Schema.decodeUnknownSync(Schema.fromJsonString(TempodToDo))(String(ev.data));
      this.raw.push(msg);

      if (msg.type === "res") this.waiters.get(msg.id)?.(msg);

      if (msg.type === "event") this.events.push({ seq: msg.seq, ts: msg.ts, event: decodeEvent(msg.event) });

      for (const l of this.listeners) l();
    });
    this.ws.addEventListener("close", (ev) => {
      this.closed = { code: ev.code, reason: ev.reason };

      for (const l of this.listeners) l();
    });
  }

  send(msg: JsonData | DoToTempod): void {
    this.ws.send(JSON.stringify(msg));
  }

  async hello(over: JsonDataFields = {}): Promise<void> {
    await this.opened;
    this.send(hello(over));
  }

  reqRaw(op: string, params: JsonData | TempodParams<TempodOp>, timeoutMs = 30_000): Promise<TempodRes> {
    const id = `req-${++this.nextId}-${Math.random().toString(36).slice(2)}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${op} timed out`)), timeoutMs);
      this.waiters.set(id, (response) => {
        clearTimeout(timer);
        this.waiters.delete(id);
        resolve(response);
      });
      this.send({ type: "req", id, op, params });
    });
  }
  async req<O extends TempodOp>(
    op: O,
    params: JsonData | TempodParams<O>,
    timeoutMs = 30_000,
  ): Promise<Res<TempodResult<O>>> {
    const response = await this.reqRaw(op, params, timeoutMs);

    if (!response.ok) return response;
    // SAFETY: the same op sent in the request selects its result codec and TempodResult<O>.
    const schema = TEMPOD_REQUESTS[op].result as Schema.ConstraintDecoder<TempodResult<O>>;

    return { ...response, result: Schema.decodeUnknownSync(schema)(response.result) };
  }
  async ok<O extends TempodOp>(
    op: O,
    params: JsonData | TempodParams<O>,
    timeoutMs?: number,
  ): Promise<TempodResult<O>> {
    const response = await this.req(op, params, timeoutMs);

    if (!response.ok) throw new Error(`${op} failed: ${response.error.code} ${response.error.message}`);

    return response.result;
  }

  ack(upTo: number): void {
    this.send({ type: "ack", upTo });
  }

  kinds(): string[] {
    return this.events.map((e) => e.event.kind);
  }

  of<K extends TempodEvent["kind"]>(kind: K): Array<TempodEventOf<K>> {
    return this.events
      .map(({ event }) => event)
      .filter((event): event is TempodEventOf<K> => event.kind === kind);
  }

  waitFor(pred: () => boolean, timeoutMs = 10_000, what = "condition"): Promise<void> {
    if (pred()) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error(`timed out waiting for ${what}`));
      }, timeoutMs);

      const check = () => {
        if (pred()) {
          clearTimeout(t);
          this.listeners.delete(check);
          resolve();
        }
      };

      this.listeners.add(check);
    });
  }

  async waitEvent<K extends TempodEvent["kind"]>(
    kind: K,
    pred: (e: TempodEventOf<K>) => boolean = () => true,
    timeoutMs = 10_000,
  ): Promise<TempodEventOf<K>> {
    await this.waitFor(() => this.of(kind).some(pred), timeoutMs, kind);

    return this.of(kind).find(pred)!;
  }

  close(): void {
    this.ws.close();
  }
}

export type Res<R = unknown> =
  | { type: "res"; id: string; ok: true; result: R }
  | { type: "res"; id: string; ok: false; error: { code: string; message: string } };

export const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const r = await run(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  });

  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);

  return r.stdout.trim();
};

/** A bare "origin" with `main` holding a few files; returns its file:// URL and a work clone path. */
export const makeOrigin = async (): Promise<{ url: string; bare: string; seed: string }> => {
  const root = tmpDir("origin-");
  const bare = join(root, "origin.git");
  const seed = join(root, "seed");
  await git(root, "init", "-q", "--bare", "-b", "main", bare);
  mkdirSync(seed);
  await git(seed, "init", "-q", "-b", "main");
  await git(seed, "config", "user.email", "seed@example.com");
  await git(seed, "config", "user.name", "Seed");
  writeFileSync(join(seed, "README.md"), "# Demo\n\nline 1\nline 2\n");
  writeFileSync(join(seed, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(seed, "old.txt"), "this file will be renamed\nwith two lines\n");
  writeFileSync(join(seed, "gone.txt"), "to delete\n");
  writeFileSync(join(seed, ".gitignore"), "ignored/\n*.log\n");
  await git(seed, "add", "-A");
  await git(seed, "commit", "-q", "-m", "initial");
  await git(seed, "remote", "add", "origin", bare);
  await git(seed, "push", "-q", "origin", "main");

  return { url: `file://${bare}`, bare, seed };
};

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** True while the process runs. A zombie counts as gone: PID 1 in a test sandbox may never reap it. */
export const isAlive = (pid: number): boolean => {
  try {
    if (process.platform !== "linux") {
      return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" })
        .trim()
        .startsWith("Z");
    }

    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");

    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
};

export const FAKE_AGENT = join(import.meta.dir, "fixtures", "fake-agent.ts");

export const fakeAgentCommand = (): string[] => [process.execPath, FAKE_AGENT];

export const writeFile = (path: string, content: string | Uint8Array): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
};
