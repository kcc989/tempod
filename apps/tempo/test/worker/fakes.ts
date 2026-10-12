import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { newId, type Source, type TempodEvent, type TempodOp } from "@tempo/protocol";
import type { WorkspaceDO } from "../../src/do/workspace/index.ts";
import type { WorkspaceCore } from "../../src/do/workspace/core.ts";
import type { OpRunner } from "../../src/do/workspace/runner.ts";

/**
 * Test doubles for the parts of a workspace that need a real container: `ctx.container` and
 * the tempod daemon behind port 7070. The fake tempod speaks the real protocol over a real
 * WebSocketPair, so the DO's TempodClient, acks and event ordering run unchanged.
 */

export type RequestHandler = (params: any, op: TempodOp) => unknown | Promise<unknown>;

export class FakeTempod {
  readonly requests: Array<{ op: string; params: any }> = [];
  readonly hellos: any[] = [];
  readonly acks: number[] = [];
  incarnation = newId();
  version = "test";
  private seq = 0;
  private socket: WebSocket | null = null;
  readonly handlers = new Map<string, RequestHandler>();
  /** Requests that throw: op → {code, message}. */
  readonly failures = new Map<string, { code: string; message: string }>();
  /** The tempod side of each preview WebSocket proxied through /v1/proxy, with its close code once closed. */
  readonly proxySockets: Array<{ socket: WebSocket; closed: number | null }> = [];
  /** Every request proxied through /v1/proxy, with the headers tempod received. */
  readonly proxyRequests: Array<{ path: string; headers: Headers }> = [];
  healthy = true;

  constructor() {
    const ok = () => ({});
    this.on("repo.clone", () => ({ headSha: "a".repeat(40), remoteHeadSha: null }));
    this.on("repo.applyCheckpoint", () => ({ headSha: "b".repeat(40) }));
    this.on("settings.read", () => ({
      effective: DEFAULT_EFFECTIVE,
      warnings: [],
      errors: [],
      sources: {},
    }));
    this.on("env.set", ok);
    this.on("script.start", () => ({ pid: 1234 }));
    this.on("script.stop", ok);
    this.on("session.start", () => ({
      acpSessionId: `acp-${newId()}`,
      modes: [{ id: "default", name: "Default" }],
      modeId: "default",
      configOptions: [],
      availableCommands: [],
      capabilities: { promptCapabilities: { image: true } },
      reloaded: false,
      handoff: false,
    }));
    this.on("session.prompt", () => ({ accepted: true }));
    this.on("session.cancel", ok);
    this.on("session.setMode", ok);
    this.on("session.setConfig", () => ({ configOptions: [] }));
    this.on("session.close", ok);
    this.on("permission.respond", ok);
    this.on("credential.put", ok);
    this.on("git.changes", () => ({
      files: [],
      baseSha: "c".repeat(40),
      headSha: "d".repeat(40),
      ahead: 0,
      dirty: false,
    }));
    this.on("git.fileDiff", () => ({ diff: "" }));
    this.on("git.checkpoint", () => ({ unchanged: true }));
    this.on("git.revert", () => ({ headSha: "e".repeat(40) }));
    this.on("git.commitAndPush", () => ({ commitSha: "f".repeat(40) }));
    this.on("git.renameBranch", ok);
    this.on("fs.list", () => ({ paths: ["README.md"] }));
    this.on("fs.read", () => ({ content: "hello", encoding: "utf8", size: 5 }));
    this.on("fs.search", () => ({ matches: [] }));
    this.on("terminal.list", () => ({ terminalIds: [] }));
    this.on("shutdown", ok);
  }

  on(op: string, handler: RequestHandler): this {
    this.handlers.set(op, handler);
    return this;
  }

  fail(op: string, code: string, message = `${op} failed`): this {
    this.failures.set(op, { code, message });
    return this;
  }

  get connected(): boolean {
    return this.socket !== null;
  }

  resume(incarnation: string, seq: number): void {
    this.incarnation = incarnation;
    this.seq = seq;
  }

  /** Sends one event with the next seq. */
  emit(event: TempodEvent): number {
    const seq = ++this.seq;
    this.socket?.send(JSON.stringify({ type: "event", seq, ts: Date.now(), event }));
    return seq;
  }

  /** Sends an event with an explicit seq (for dedupe tests). */
  emitRaw(seq: number, event: TempodEvent): void {
    this.socket?.send(JSON.stringify({ type: "event", seq, ts: Date.now(), event }));
  }

  close(code = 1011): void {
    this.socket?.close(code, "fake close");
    this.socket = null;
  }

  requestsOf(op: string): any[] {
    return this.requests.filter((r) => r.op === op).map((r) => r.params);
  }

  /** The Fetcher behind getTcpPort(7070). */
  fetcher(token: () => string | null): Fetcher {
    return {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        const url = new URL(req.url);
        if (req.headers.get("Authorization") !== `Bearer ${token()}`)
          return new Response("unauthorized", { status: 401 });
        if (url.pathname === "/v1/health") {
          if (!this.healthy) return new Response("starting", { status: 503 });
          return Response.json({ ok: true, version: this.version, incarnation: this.incarnation });
        }
        if (url.pathname === "/v1/connect") return this.accept();
        if (url.pathname.startsWith("/v1/proxy/")) {
          this.proxyRequests.push({ path: `${url.pathname}${url.search}`, headers: req.headers });
          if (req.headers.get("Upgrade")?.toLowerCase() === "websocket") return this.acceptProxy();
          return new Response(`proxied ${url.pathname}${url.search}`, { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
      connect: () => {
        throw new Error("not supported");
      },
    } as unknown as Fetcher;
  }

  private acceptProxy(): Response {
    const pair = new WebSocketPair();
    const entry = { socket: pair[1], closed: null as number | null };
    entry.socket.accept();
    entry.socket.addEventListener("close", (e) => {
      entry.closed = e.code;
    });
    this.proxySockets.push(entry);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private accept(): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    this.socket?.close(4001, "replaced");
    this.socket = server;
    server.addEventListener("message", (e) => void this.onMessage(server, String(e.data)));
    server.addEventListener("close", () => {
      if (this.socket === server) this.socket = null;
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  private async onMessage(ws: WebSocket, data: string): Promise<void> {
    const msg = JSON.parse(data);
    if (msg.type === "hello") {
      this.hellos.push(msg);
      if (msg.incarnation !== this.incarnation) {
        this.seq = 0;
        this.emit({ kind: "incarnation.changed", incarnation: this.incarnation });
      }
      return;
    }
    if (msg.type === "ack") {
      this.acks.push(msg.upTo);
      return;
    }
    if (msg.type === "req") {
      this.requests.push({ op: msg.op, params: msg.params });
      const failure = this.failures.get(msg.op);
      if (failure) {
        ws.send(JSON.stringify({ type: "res", id: msg.id, ok: false, error: failure }));
        return;
      }
      const handler = this.handlers.get(msg.op);
      if (!handler) {
        ws.send(
          JSON.stringify({
            type: "res",
            id: msg.id,
            ok: false,
            error: { code: "UNKNOWN_OP", message: msg.op },
          }),
        );
        return;
      }
      try {
        const result = await handler(msg.params, msg.op);
        ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, result }));
      } catch (e) {
        ws.send(
          JSON.stringify({
            type: "res",
            id: msg.id,
            ok: false,
            error: { code: "INTERNAL", message: String(e) },
          }),
        );
      }
    }
  }
}

export const DEFAULT_EFFECTIVE = {
  agent: { default: "claude", models: { claude: "", codex: "", opencode: "", pi: "" } },
  browser: { run: false },
  scripts: { setup: "", archive: "", run_mode: "concurrent", auto_run_after_setup: false, run: {} },
  environment: {
    instance: "standard-3",
    sleep_after_idle_minutes: 15,
    egress_policy: "open",
    egress_allowlist: [],
  },
  environment_variables: {},
  git: { branch_prefix: "tempo/", delete_branch_on_archive: false, archive_on_merge: false },
  prompts: { general: "" },
} as const;

/** A stand-in for `ctx.container`. Files and DirectoryBackup calls (exec) fail, like a missing shim. */
export class FakeContainer {
  running = false;
  readonly starts: any[] = [];
  readonly intercepts: string[] = [];
  readonly snapshots: Array<{ id: string; name?: string }> = [];
  destroyed = 0;
  failStartWithSnapshot = false;
  snapshotFails = false;
  readonly images: Record<string, string> = { workspace: "registry.example/workspace@sha256:1111" };

  constructor(
    readonly tempod: FakeTempod,
    private readonly token: () => string | null,
  ) {}

  start(options: any): void {
    this.starts.push(options);
    if (this.failStartWithSnapshot && options.containerSnapshot) throw new Error("snapshot restore failed");
    this.running = true;
  }
  async monitor(): Promise<void> {}
  async destroy(): Promise<void> {
    this.destroyed++;
    this.running = false;
    this.tempod.close(1001);
  }
  signal(): void {}
  getTcpPort(): Fetcher {
    return this.tempod.fetcher(this.token);
  }
  async setInactivityTimeout(): Promise<void> {}
  async interceptOutboundHttp(addr: string): Promise<void> {
    this.intercepts.push(`http:${addr}`);
  }
  async interceptAllOutboundHttp(): Promise<void> {
    this.intercepts.push("all");
  }
  async interceptOutboundHttps(addr: string): Promise<void> {
    this.intercepts.push(`https:${addr}`);
  }
  async snapshotContainer(options?: { name?: string }): Promise<{ id: string; size: number; name?: string }> {
    if (this.snapshotFails) throw new Error("snapshot failed");
    const snap = {
      id: `snap-${this.snapshots.length + 1}`,
      size: 1024,
      ...(options?.name ? { name: options.name } : {}),
    };
    this.snapshots.push(snap);
    return snap;
  }
  async exec(): Promise<never> {
    throw new Error("exec is not available in tests");
  }
  async inspect(): Promise<null> {
    return null;
  }
}

/** Internals of a WorkspaceDO instance, for tests only. */
export interface Internals {
  readonly core: WorkspaceCore;
  readonly runner: OpRunner;
  readonly handlers: { onEvent: (e: TempodEvent) => Promise<void> | void };
}

export const internals = (instance: WorkspaceDO): Internals => instance as unknown as Internals;

/** Installs a fake container (and its tempod) in the DO. Call again after each DO restart. */
export const installFakes = async (
  stub: DurableObjectStub<WorkspaceDO>,
  tempod = new FakeTempod(),
): Promise<{ tempod: FakeTempod; container: FakeContainer }> => {
  let container!: FakeContainer;
  await runInDurableObject(stub, (instance: WorkspaceDO) => {
    const core = internals(instance).core;
    container = new FakeContainer(tempod, () => core.wsOrNull()?.tempodToken ?? null);
    core.container = container as unknown as Container;
  });
  return { tempod, container };
};

/** Polls until `check` holds (DO work runs on alarms and microtasks). */
export const waitFor = async (
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  label = "condition",
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

// ---------- DO helpers ----------

type WorkspaceStub = DurableObjectStub<WorkspaceDO>;

/** Rows from the DO's own SQLite. */
export const sqlRows = (
  stub: WorkspaceStub,
  query: string,
  ...binds: unknown[]
): Promise<Array<Record<string, any>>> =>
  runInDurableObject(stub, (_i: WorkspaceDO, state: DurableObjectState) =>
    state.storage.sql.exec(query, ...binds).toArray(),
  );

/** Sends one tempod event. The fake's socket belongs to the DO's I/O context, so it is sent from inside the DO. */
export const emitEvent = (stub: WorkspaceStub, tempod: FakeTempod, event: TempodEvent): Promise<number> =>
  runInDurableObject(stub, () => tempod.emit(event));

/** Waits until the DO has applied the event with this seq of its current incarnation. */
export const waitApplied = (stub: WorkspaceStub, seq: number, timeoutMs = 5000): Promise<void> =>
  waitFor(
    async () =>
      Number(
        (await sqlRows(stub, "SELECT tempod_acked_seq FROM workspace WHERE id = 1"))[0]?.["tempod_acked_seq"],
      ) >= seq,
    timeoutMs,
    `event ${seq} applied`,
  );

/** Runs alarms, with every op backoff due at once, until the workspace state is one of `states`. */
export const driveToState = async (
  stub: WorkspaceStub,
  states: ReadonlyArray<string>,
  timeoutMs = 20_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = String((await sqlRows(stub, "SELECT state FROM workspace WHERE id = 1"))[0]?.["state"]);
    if (states.includes(state)) return;
    if (Date.now() > deadline) throw new Error(`timed out driving to ${states.join("|")} (state ${state})`);
    await runInDurableObject(stub, (_i: WorkspaceDO, s: DurableObjectState) => {
      s.storage.sql.exec(
        "UPDATE ops SET next_run_at = 0 WHERE status IN ('pending', 'running') AND kind != 'housekeeping'",
      );
    });
    await runDurableObjectAlarm(stub);
    await new Promise((r) => setTimeout(r, 20));
  }
};

// ---------- D1 seeding ----------

export const OWNER_GITHUB_ID = "4242";

export interface Seeded {
  readonly userId: string;
  readonly projectId: string;
  readonly installationId: number;
  readonly repoId: number;
}

let seedCounter = 0;

/** Inserts a user, a GitHub installation and a project into D1. */
export const seedProject = async (opts: { settingsJson?: string } = {}): Promise<Seeded> => {
  seedCounter++;
  const userId = `user-${newId()}`;
  const installationId = 900_000 + seedCounter;
  const repoId = 700_000 + seedCounter;
  const projectId = newId();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    ).bind(userId, "Owner", `${userId}@example.com`, now, now),
    env.DB.prepare(
      "INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES (?, ?, 'github', ?, ?, ?)",
    ).bind(`acc-${userId}`, OWNER_GITHUB_ID, userId, now, now),
    env.DB.prepare(
      "INSERT INTO github_installations (id, user_id, installation_id, account_login, account_type, created_at) VALUES (?, ?, ?, 'acme', 'Organization', ?)",
    ).bind(newId(), userId, installationId, now),
    env.DB.prepare(
      "INSERT INTO projects (id, user_id, installation_id, repo_id, repo_owner, repo_name, default_branch, settings_json, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 'acme', 'app', 'main', ?, 1, ?, ?)",
    ).bind(projectId, userId, installationId, repoId, opts.settingsJson ?? "{}", now, now),
  ]);
  return { userId, projectId, installationId, repoId };
};

/**
 * Creates a workspace the way createWorkspace does (D1 row, then init) and installs fakes.
 * The create op is pending; call `runAlarm` to drive it.
 */
export const seedWorkspace = async (
  seeded: Seeded,
  opts: {
    prompt?: string;
    slug?: string;
    branch?: string;
    agent?: "claude" | "codex" | "opencode" | "pi";
    source?: Source;
  } = {},
) => {
  const workspaceId = newId();
  const slug = opts.slug ?? `city${seedCounter}`;
  const branch = opts.branch ?? `tempo/${slug}`;
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO workspaces (id, project_id, user_id, slug, title, branch, base_branch, state, attention, default_agent, pinned, last_activity_at, created_at, summary_rev) VALUES (?, ?, ?, ?, ?, ?, 'main', 'creating', 'none', ?, 0, ?, ?, 0)",
  )
    .bind(workspaceId, seeded.projectId, seeded.userId, slug, slug, branch, opts.agent ?? "claude", now, now)
    .run();
  const stub = env.WORKSPACE.getByName(workspaceId);
  const fakes = await installFakes(stub);
  const res = await stub.init({
    workspaceId,
    projectId: seeded.projectId,
    userId: seeded.userId,
    slug,
    branch,
    baseBranch: "main",
    source: opts.source ?? { kind: "new" },
    defaultAgent: opts.agent ?? "claude",
    agent: opts.agent ?? "claude",
    prompt: opts.prompt ? { text: opts.prompt } : null,
    author: { name: "Owner", email: `${OWNER_GITHUB_ID}+owner@users.noreply.github.com` },
    createdAt: now,
  });
  if (!res.ok) throw new Error(`init failed: ${res.error.code}`);
  return { workspaceId, stub, ...fakes };
};

/** Gives the user a credential for every agent. */
export const seedCredentials = async (userId: string): Promise<void> => {
  const creds = env.CREDENTIALS.getByName(userId);
  await creds.putSecret("claude.oauth_token", "sk-ant-oat01-test-token-value");
  await creds.putSecret("openrouter.api_key", "sk-or-test");
  await creds.putSecret("openai.api_key", "sk-openai-test");
};
