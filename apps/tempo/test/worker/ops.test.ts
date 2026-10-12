import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { TempoError, newId, type Source, type TempodEvent } from "@tempo/protocol";
import type { WorkspaceDO } from "../../src/do/workspace/index.ts";
import { OP_STEPS, STEP_LIMITS, backoffMs } from "../../src/do/workspace/runner.ts";
import { github } from "../../src/github/provider.ts";
import {
  DEFAULT_EFFECTIVE,
  FakeTempod,
  OWNER_GITHUB_ID,
  installFakes,
  internals,
  seedCredentials,
  seedProject,
  waitFor,
  type FakeContainer,
  type Internals,
  type Seeded,
} from "./fakes.ts";

/**
 * The op step runner and the workspace lifecycles (03: Step runner, Ops and their steps, Step limits,
 * Sleep and wake, Archive and restore, Revert, Failure handling; 01: Durability).
 */

type Stub = DurableObjectStub<WorkspaceDO>;
type Res<T = any> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; detail?: string } };
type Row = Record<string, any>;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const IMAGE = "registry.example/workspace@sha256:1111";
const OTHER_IMAGE = "registry.example/workspace@sha256:2222";
const ULID = /^[0-9a-hjkmnp-tv-z]{26}$/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = <T>(r: Res<T>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message} ${r.error.detail ?? ""}`);
  return r.value;
};
const codeOf = (r: Res): string => (r.ok ? "OK" : r.error.code);

// ---------- storage ----------

const rows = (stub: Stub, query: string, ...binds: Array<string | number | null>): Promise<Row[]> =>
  runInDurableObject(
    stub,
    (_i: WorkspaceDO, state: DurableObjectState) =>
      state.storage.sql.exec(query, ...binds).toArray() as Row[],
  );
const one = async (
  stub: Stub,
  query: string,
  ...binds: Array<string | number | null>
): Promise<Row | undefined> => (await rows(stub, query, ...binds))[0];
const exec = (stub: Stub, query: string, ...binds: Array<string | number | null>): Promise<void> =>
  runInDurableObject(stub, (_i: WorkspaceDO, state: DurableObjectState) => {
    state.storage.sql.exec(query, ...binds);
  });

const wsRow = async (stub: Stub) => (await one(stub, "SELECT * FROM workspace WHERE id = 1"))!;
const detail = async (stub: Stub) => ok(await stub.getWorkspace({}));
const stateOf = async (stub: Stub): Promise<string> => (await wsRow(stub))["state"];
const d1Row = (id: string) => env.DB.prepare("SELECT * FROM workspaces WHERE id = ?").bind(id).first<Row>();
const opsOf = (stub: Stub, kind: string) =>
  rows(stub, "SELECT * FROM ops WHERE kind = ? ORDER BY created_at, rowid", kind);
const opOf = async (stub: Stub, kind: string): Promise<Row | undefined> => (await opsOf(stub, kind)).at(-1);
const opState = (
  op: Row | undefined,
): {
  timings: Record<string, number>;
  skipped?: string[];
  waiting?: { step: string; deadline: number };
  [k: string]: unknown;
} => JSON.parse(op?.["state_json"] ?? "{}");
const turnOf = (stub: Stub, id: string) => one(stub, "SELECT * FROM turns WHERE id = ?", id);
const sessionOf = (stub: Stub, id: string) => one(stub, "SELECT * FROM sessions WHERE id = ?", id);

// ---------- driving ----------

/** Makes every backoff due now, so retries run without waiting (the delays have their own test). */
const hurry = (stub: Stub) =>
  exec(
    stub,
    "UPDATE ops SET next_run_at = 0 WHERE status IN ('pending', 'running') AND kind != 'housekeeping'",
  );

const drive = async (
  stub: Stub,
  check: () => Promise<boolean>,
  label: string,
  opts: { fast?: boolean; timeoutMs?: number } = {},
): Promise<void> => {
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out driving to ${label}`);
    if (opts.fast !== false) await hurry(stub);
    await runDurableObjectAlarm(stub);
    await sleep(20);
  }
};
const driveToState = (stub: Stub, ...states: string[]) =>
  drive(stub, async () => states.includes(await stateOf(stub)), `state ${states.join("|")}`);
const driveOp = (stub: Stub, kind: string, ...statuses: string[]) =>
  drive(
    stub,
    async () => statuses.includes((await opOf(stub, kind))?.["status"]),
    `${kind} op ${statuses.join("|")}`,
  );

/** Runs alarms while an RPC call that waits on an op (revert, commit_push) is in flight. */
const whileDriving = async (stub: Stub, rpc: PromiseLike<unknown>): Promise<Res> => {
  const call = Promise.resolve(rpc) as Promise<Res>;
  let settled = false;
  void call.then(
    () => (settled = true),
    () => (settled = true),
  );
  const deadline = Date.now() + 20_000;
  while (!settled && Date.now() < deadline) {
    await hurry(stub);
    await runDurableObjectAlarm(stub);
    await sleep(20);
  }
  return call;
};

// ---------- seeding ----------

interface Ws {
  readonly workspaceId: string;
  readonly stub: Stub;
  readonly tempod: FakeTempod;
  readonly container: FakeContainer;
  readonly seeded: Seeded;
  readonly slug: string;
  readonly branch: string;
  /** Every state change, in order (recorded from core.setState). */
  readonly states: string[];
}

/** The fake tempod's socket belongs to the DO's I/O context, so events are sent from inside it. */
const emit = (w: Ws, event: Record<string, unknown>): Promise<number> =>
  runInDurableObject(w.stub, () => w.tempod.emit(event as unknown as TempodEvent));

const settingsWith = (patch: {
  scripts?: Record<string, unknown>;
  environment?: Record<string, unknown>;
  git?: Record<string, unknown>;
}) => ({
  ...DEFAULT_EFFECTIVE,
  scripts: { ...DEFAULT_EFFECTIVE.scripts, ...patch.scripts },
  environment: { ...DEFAULT_EFFECTIVE.environment, ...patch.environment },
  git: { ...DEFAULT_EFFECTIVE.git, ...patch.git },
});

const useEffective = (tempod: FakeTempod, effective: unknown) =>
  tempod.on("settings.read", () => ({ effective, warnings: [], errors: [], sources: {} }));

let counter = 0;

/**
 * Inserts the D1 row and calls init, like createWorkspace. `prepare` runs on the fakes before init,
 * because the create op starts on the first alarm right after it.
 */
const seedWs = async (
  opts: {
    prompt?: string;
    credentials?: boolean;
    effective?: unknown;
    source?: Source;
    branch?: string;
    prepare?: (tempod: FakeTempod, container: FakeContainer) => void;
    /** Runs inside the DO before init, with its internals. */
    inside?: (x: Internals) => void;
  } = {},
): Promise<Ws> => {
  const seeded = await seedProject();
  if (opts.credentials) await seedCredentials(seeded.userId);
  counter++;
  const workspaceId = newId();
  const slug = `ops${counter}`;
  const branch = opts.branch ?? `tempo/${slug}`;
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO workspaces (id, project_id, user_id, slug, title, branch, base_branch, state, attention, default_agent, pinned, last_activity_at, created_at, summary_rev) VALUES (?, ?, ?, ?, ?, ?, 'main', 'creating', 'none', 'claude', 0, ?, ?, 0)",
  )
    .bind(workspaceId, seeded.projectId, seeded.userId, slug, slug, branch, now, now)
    .run();
  const stub = env.WORKSPACE.getByName(workspaceId);
  const tempod = new FakeTempod();
  if (opts.effective) useEffective(tempod, opts.effective);
  const { container } = await installFakes(stub, tempod);
  opts.prepare?.(tempod, container);
  const states: string[] = [];
  await runInDurableObject(stub, (i: WorkspaceDO) => {
    opts.inside?.(internals(i));
    const core = internals(i).core;
    const original = core.setState.bind(core);
    core.setState = (next, error) => {
      const before = core.wsOrNull()?.state;
      original(next, error);
      if (before !== next) states.push(next);
    };
  });
  ok(
    await stub.init({
      workspaceId,
      projectId: seeded.projectId,
      userId: seeded.userId,
      slug,
      branch,
      baseBranch: "main",
      source: opts.source ?? { kind: "new" },
      defaultAgent: "claude",
      agent: "claude",
      prompt: opts.prompt ? { text: opts.prompt } : null,
      author: { name: "Owner", email: `${OWNER_GITHUB_ID}+owner@users.noreply.github.com` },
      createdAt: now,
    }),
  );
  return { workspaceId, stub, tempod, container, seeded, slug, branch, states };
};

/** A workspace driven through the create op to `ready` (or `working` with a prompt). */
const readyWs = async (opts: Parameters<typeof seedWs>[0] = {}): Promise<Ws> => {
  const w = await seedWs(opts);
  await driveToState(w.stub, "ready", "working");
  await driveOp(w.stub, "create", "done");
  return w;
};

/** A ready workspace put to sleep by sleepWorkspace and the sleep op. */
const asleep = async (opts: Parameters<typeof seedWs>[0] = {}): Promise<Ws> => {
  const w = await readyWs(opts);
  expect(codeOf(await w.stub.sleepWorkspace({}))).toBe("OK");
  await driveToState(w.stub, "sleeping");
  return w;
};

const insertSession = (stub: Stub, id: string, status = "idle") =>
  exec(
    stub,
    "INSERT INTO sessions (id, agent, status, sort_order, created_at, updated_at, closed_at) VALUES (?, 'claude', ?, 1, ?, ?, ?)",
    id,
    status,
    Date.now(),
    Date.now(),
    status === "closed" ? Date.now() : null,
  );
const insertTurn = (stub: Stub, id: string, sessionId: string, seq: number, status = "completed") =>
  exec(
    stub,
    "INSERT INTO turns (id, session_id, seq, queue_pos, status, prompt_json, queued_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    sessionId,
    seq,
    status === "queued" ? seq : null,
    status,
    JSON.stringify({ text: `turn ${seq}`, mentions: [], attachmentIds: [], reviewCommentIds: [] }),
    Date.now(),
    status === "queued" ? null : Date.now(),
  );
const insertCheckpoint = (
  stub: Stub,
  id: string,
  turnId: string | null,
  reason = "turn_end",
  createdAt = Date.now(),
) =>
  exec(
    stub,
    "INSERT INTO checkpoints (id, turn_id, reason, commit_sha, tree_sha, parent_sha, base_sha, created_at) VALUES (?, ?, ?, 'c', 't', 'p', 'b', ?)",
    id,
    turnId,
    reason,
    createdAt,
  );
const insertSnapshot = (
  stub: Stub,
  s: { id: string; imageRef: string; createdAt: number; lastRestoredAt?: number | null; unusable?: number },
) =>
  exec(
    stub,
    "INSERT INTO snapshots (id, name, size_bytes, image_ref, created_at, last_restored_at, unusable) VALUES (?, ?, 1, ?, ?, ?, ?)",
    s.id,
    s.id,
    s.imageRef,
    s.createdAt,
    s.lastRestoredAt ?? null,
    s.unusable ?? 0,
  );

const checkpointResult = (p: { checkpointId: string }) => ({
  commit: "1".repeat(40),
  tree: "2".repeat(40),
  parent: "3".repeat(40),
  base: "4".repeat(40),
  bundlePath: `/home/tempo/.tempod/${p.checkpointId}.bundle`,
  bundleBytes: 10,
});

const FRESH_STEPS = ["repo.clone", "repo.applyCheckpoint", "home.restore", "settings.read", "setup.run"];

/** A cached installation token, so GitHub calls go straight to the (spied) provider. */
const withGithubToken = (w: Ws) =>
  runInDurableObject(w.stub, (i: WorkspaceDO) => {
    internals(i).core.ghToken = { token: "ghs_test", expiresAt: Date.now() + HOUR };
  });

/** Closes the DO's side of the tempod socket the way a DO restart loses it: no close handling runs. */
const dropSocketSilently = (w: Ws) =>
  runInDurableObject(w.stub, (i: WorkspaceDO) => {
    const core = internals(i).core;
    core.closingTempod = true;
    core.tempod?.close(1001, "do restart");
    core.closingTempod = false;
    core.tempod = null;
  });

// =====================================================================================

describe("op tables", () => {
  it("lists the steps of every op exactly as in 03 Ops and their steps", () => {
    // 03 Ops and their steps (done is implied after the last step)
    expect(OP_STEPS).toEqual({
      create: ["container.start", "tempod.connect", "repo.clone", "settings.read", "setup.run"],
      wake: [
        "container.start",
        "tempod.connect",
        "repo.clone",
        "repo.applyCheckpoint",
        "home.restore",
        "settings.read",
        "setup.run",
        "sessions.markReload",
        "artifacts.resume",
      ],
      sleep: [
        "turns.check",
        "git.checkpoint",
        "bundle.upload",
        "home.backup",
        "artifacts.upload",
        "tempod.shutdown",
        "container.snapshot",
        "container.destroy",
      ],
      archive: [
        "turns.cancel",
        "script.archive",
        "git.checkpoint",
        "bundle.upload",
        "home.backup",
        "artifacts.upload",
        "tempod.shutdown",
        "container.snapshot",
        "container.destroy",
        "github.deleteBranch",
      ],
      restore: ["branch.check"],
      revert: ["git.checkpoint", "bundle.upload", "git.revert", "transcript.mark"],
      commit_push: ["git.commitAndPush"],
      housekeeping: ["events.prune", "r2.retention", "egress.trim"],
    });
  });

  it("uses the max attempts and permanent outcome of 03 Step limits", () => {
    // 03 Step limits: [step, max attempts, permanent error code or "skip"]
    const table: Array<[string, number, string]> = [
      ["container.start", 3, "CONTAINER_START_FAILED"],
      ["tempod.connect", 5, "TEMPOD_UNREACHABLE"],
      ["repo.clone", 3, "CLONE_FAILED"],
      ["repo.applyCheckpoint", 2, "skip"],
      ["home.restore", 2, "skip"],
      ["settings.read", 3, "skip"],
      ["setup.run", 1, "skip"],
      ["script.archive", 1, "skip"],
      ["git.checkpoint", 3, "skip"],
      ["bundle.upload", 3, "skip"],
      ["home.backup", 2, "skip"],
      ["artifacts.upload", 2, "skip"],
      ["artifacts.resume", 1, "skip"],
      ["tempod.shutdown", 1, "skip"],
      ["container.snapshot", 2, "skip"],
      ["container.destroy", 3, "INTERNAL"],
      ["git.revert", 1, "INTERNAL"],
      ["github.deleteBranch", 3, "skip"],
    ];
    for (const [step, attempts, outcome] of table) {
      const limit = STEP_LIMITS[step]!;
      expect(limit.maxAttempts, step).toBe(attempts);
      expect(limit.onPermanent.kind === "skip" ? "skip" : limit.onPermanent.code, step).toBe(outcome);
    }
    // Timeouts (03 Step limits). container.start's 60 s is the health poll (see the health test).
    const timeouts: Array<[string, number]> = [
      ["tempod.connect", 10_000],
      ["repo.clone", 10 * MIN],
      ["repo.applyCheckpoint", 5 * MIN],
      ["home.restore", 5 * MIN],
      ["settings.read", 10_000],
      ["setup.run", 30 * MIN],
      ["script.archive", 120_000],
      ["git.checkpoint", 2 * MIN],
      ["bundle.upload", 5 * MIN],
      ["home.backup", 5 * MIN],
      ["artifacts.upload", 5 * MIN],
      ["artifacts.resume", 30_000],
      ["tempod.shutdown", 45_000],
      ["container.snapshot", 5 * MIN],
      ["container.destroy", 30_000],
      ["git.revert", 2 * MIN],
      ["git.commitAndPush", 5 * MIN],
      ["github.deleteBranch", 30_000],
    ];
    for (const [step, ms] of timeouts) expect(STEP_LIMITS[step]!.timeoutMs, step).toBe(ms);
    // git.commitAndPush: max 1 attempt
    expect(STEP_LIMITS["git.commitAndPush"]!.maxAttempts).toBe(1);
  });

  it("backs off min(1 s × 2^(attempt − 1), 60 s) with ±20% jitter", () => {
    // 03 Step runner: "next_run_at = now + min(1 s × 2^(attempt − 1), 60 s) with ±20% jitter"
    for (let attempt = 1; attempt <= 10; attempt++) {
      const base = Math.min(1000 * 2 ** (attempt - 1), 60_000);
      for (let i = 0; i < 50; i++) {
        const ms = backoffMs(attempt);
        expect(ms).toBeGreaterThanOrEqual(base * 0.8 - 1);
        expect(ms).toBeLessThanOrEqual(base * 1.2 + 1);
      }
    }
  });
});

describe("create op", { timeout: 60_000 }, () => {
  it("runs container.start → tempod.connect → repo.clone → settings.read → setup.run and records each step's time", async () => {
    const w = await seedWs();
    await driveToState(w.stub, "ready");
    await driveOp(w.stub, "create", "done");
    const op = (await opOf(w.stub, "create"))!;
    expect(op["status"]).toBe("done");
    expect(op["error_code"]).toBeNull();
    const st = opState(op);
    // Keys are inserted in the order the steps ran (03 Ops and their steps).
    expect(Object.keys(st.timings)).toEqual([
      "container.start",
      "tempod.connect",
      "repo.clone",
      "settings.read",
      "setup.run",
    ]);
    for (const ms of Object.values(st.timings)) expect(ms).toBeGreaterThanOrEqual(0);
    expect(st.skipped ?? []).toEqual([]);
    // 03 Transitions: creating → starting (init) → setting_up (fresh disk) → ready
    expect(w.states).toEqual(["starting", "setting_up", "ready"]);
    // tempod makes no request before hello; the clone and settings follow it in order.
    expect(w.tempod.hellos).toHaveLength(1);
    const order = w.tempod.requests
      .map((r) => r.op)
      .filter((o) => o === "repo.clone" || o === "settings.read");
    expect(order).toEqual(["repo.clone", "settings.read"]);
    expect(w.tempod.requestsOf("repo.clone")[0]).toMatchObject({
      url: "https://github.com/acme/app.git",
      branch: w.branch,
      baseBranch: "main",
      source: { kind: "new" },
    });
    expect(w.container.starts).toHaveLength(1);
    expect(w.container.starts[0].image).toBe(IMAGE);
    // IMPLEMENTATION_NOTES Setup: "With no setup script, setup_status stays none."
    const row = await wsRow(w.stub);
    expect(row["setup_status"]).toBe("none");
    expect(row["image_ref"]).toBe(IMAGE);
    // source.kind = "new": the branch is not on origin yet.
    expect(row["pushed"]).toBe(0);
    await waitFor(async () => (await d1Row(w.workspaceId))?.["state"] === "ready", 5000, "D1 ready");
  });

  it("schedules housekeeping 24 hours after init", async () => {
    const w = await seedWs();
    // 03 Step runner: "Housekeeping: once every 24 hours."
    const hk = (await opsOf(w.stub, "housekeeping"))[0]!;
    expect(hk["status"]).toBe("pending");
    expect(hk["step"]).toBe("events.prune");
    expect(hk["next_run_at"] - hk["created_at"]).toBe(DAY);
  });

  it("for a branch source, sets pushed = 1 and last_pushed_sha to the remote head", async () => {
    const w = await seedWs({
      source: { kind: "branch" },
      branch: "feature/x",
      prepare: (t) => t.on("repo.clone", () => ({ headSha: "a".repeat(40), remoteHeadSha: "7".repeat(40) })),
    });
    await driveToState(w.stub, "ready");
    // 03 repo.clone: "For branch and pr, set pushed = 1 and last_pushed_sha to the remote head."
    const row = await wsRow(w.stub);
    expect(row["pushed"]).toBe(1);
    expect(row["last_pushed_sha"]).toBe("7".repeat(40));
    expect(w.tempod.requestsOf("repo.clone")[0]).toMatchObject({
      source: { kind: "branch" },
      branch: "feature/x",
    });
  });

  it("a Retry of a create that never finished clones like the create: a branch source gets pushed and last_pushed_sha", async () => {
    const w = await seedWs({
      source: { kind: "branch" },
      branch: "feature/retry",
      prepare: (t) => t.fail("repo.clone", "INTERNAL", "fatal: unable to access"),
    });
    await driveOp(w.stub, "create", "failed");
    expect(await wsRow(w.stub)).toMatchObject({ state: "error", error_code: "CLONE_FAILED", pushed: 0 });
    w.tempod.failures.delete("repo.clone");
    w.tempod.on("repo.clone", () => ({ headSha: "a".repeat(40), remoteHeadSha: "7".repeat(40) }));
    // 03 Transitions: the UI's Retry is a wake. The workspace was never created, so 03 repo.clone still applies:
    // the create checkout per source, and "For branch and pr, set pushed = 1 and last_pushed_sha to the remote head."
    expect(codeOf(await w.stub.wakeWorkspace({}))).toBe("OK");
    await driveToState(w.stub, "ready");
    await driveOp(w.stub, "wake", "done");
    expect(w.tempod.requestsOf("repo.clone").at(-1)).toMatchObject({
      mode: "create",
      source: { kind: "branch" },
      branch: "feature/retry",
    });
    expect(await wsRow(w.stub)).toMatchObject({
      pushed: 1,
      last_pushed_sha: "7".repeat(40),
      error_code: null,
    });

    // Once a start has completed, a fresh-disk wake tracks the branch (IMPLEMENTATION_NOTES, repo.clone mode).
    expect(codeOf(await w.stub.sleepWorkspace({}))).toBe("OK");
    await driveToState(w.stub, "sleeping");
    await exec(w.stub, "DELETE FROM snapshots");
    expect(codeOf(await w.stub.wakeWorkspace({}))).toBe("OK");
    await driveToState(w.stub, "ready");
    expect(w.tempod.requestsOf("repo.clone").at(-1)).toMatchObject({ mode: "wake" });
    expect((await wsRow(w.stub))["pushed"]).toBe(1);
  });

  it("retries a transient repo.clone error with backoff, then fails for good with CLONE_FAILED after 3 attempts", async () => {
    const w = await seedWs({ prepare: (t) => t.fail("repo.clone", "INTERNAL", "fatal: unable to access") });
    // Watch the op row: each failed attempt waits for its backoff before the next one runs.
    const seen = new Map<number, { delay: number; status: string; code: string; step: string }>();
    const deadline = Date.now() + 20_000;
    for (;;) {
      const op = await opOf(w.stub, "create");
      if (op && op["attempt"] > 0 && !seen.has(op["attempt"])) {
        seen.set(op["attempt"], {
          delay: op["next_run_at"] - op["updated_at"],
          status: op["status"],
          code: op["error_code"],
          step: op["step"],
        });
      }
      if (op?.["status"] === "failed" || Date.now() > deadline) break;
      await runDurableObjectAlarm(w.stub);
      await sleep(15);
    }
    // 03 Step runner: "On a transient error: attempt += 1, next_run_at = now + min(1 s × 2^(attempt − 1), 60 s) with ±20% jitter."
    expect([...seen.keys()]).toEqual([1, 2]);
    expect(seen.get(1)).toMatchObject({ status: "running", code: "INTERNAL", step: "repo.clone" });
    expect(seen.get(1)!.delay).toBeGreaterThanOrEqual(800);
    expect(seen.get(1)!.delay).toBeLessThanOrEqual(1200);
    expect(seen.get(2)!.delay).toBeGreaterThanOrEqual(1600);
    expect(seen.get(2)!.delay).toBeLessThanOrEqual(2400);
    // 03 Failure handling: "Clone fails | repo.clone | 3 attempts, then error / CLONE_FAILED"
    expect(w.tempod.requestsOf("repo.clone")).toHaveLength(3);
    const op = (await opOf(w.stub, "create"))!;
    expect(op["status"]).toBe("failed");
    expect(op["error_code"]).toBe("CLONE_FAILED");
    expect(op["error_detail"]).toContain("unable to access");
    const row = await wsRow(w.stub);
    expect(row["state"]).toBe("error");
    expect(row["error_code"]).toBe("CLONE_FAILED");
    expect((await detail(w.stub)).attention).toBe("error");
    await waitFor(async () => (await d1Row(w.workspaceId))?.["state"] === "error", 5000, "D1 error");
    // No later step ran.
    expect(w.tempod.requestsOf("settings.read")).toHaveLength(0);

    // Retry (wakeWorkspace). 03 Step runner: "Each step ... MUST check the current state before it acts
    // (for example, ctx.container.running before start())": the container still runs, so it is reused.
    w.tempod.failures.delete("repo.clone");
    expect(codeOf(await w.stub.wakeWorkspace({}))).toBe("OK");
    await driveToState(w.stub, "ready");
    expect(w.container.starts).toHaveLength(1);
    expect(w.tempod.requestsOf("repo.clone")).toHaveLength(4);
    expect((await opOf(w.stub, "wake"))!["status"]).toBe("done");
  });

  it("container.start: start() throwing is retried 3 times, then error / CONTAINER_START_FAILED; Retry wakes it", async () => {
    const w = await seedWs({
      prepare: (_t, c) => {
        c.start = (options: any) => {
          c.starts.push(options);
          throw new Error("no capacity");
        };
      },
    });
    await driveOp(w.stub, "create", "failed");
    // 03 Failure handling: "start() throws | container.start step | Retry with backoff, 3 attempts, then error / CONTAINER_START_FAILED"
    expect(w.container.starts).toHaveLength(3);
    const op = (await opOf(w.stub, "create"))!;
    expect(op["error_code"]).toBe("CONTAINER_START_FAILED");
    expect(op["error_detail"]).toContain("no capacity");
    expect(await stateOf(w.stub)).toBe("error");
    expect((await wsRow(w.stub))["error_code"]).toBe("CONTAINER_START_FAILED");
    expect(w.tempod.hellos).toHaveLength(0);

    // 03 Transitions: error → starting on wakeWorkspace (the UI's Retry)
    delete (w.container as { start?: unknown }).start;
    expect(codeOf(await w.stub.wakeWorkspace({}))).toBe("OK");
    await driveToState(w.stub, "ready");
    expect(w.states).toEqual(["starting", "error", "starting", "setting_up", "ready"]);
    expect((await wsRow(w.stub))["error_code"]).toBeNull();
    expect((await opOf(w.stub, "wake"))!["status"]).toBe("done");
  });

  it("container.start: health never returning 200 destroys the container and retries; the 3rd failure is CONTAINER_START_FAILED", async () => {
    // The 60 s health poll is real; the clock jumps 25 s on every health request so it ends quickly.
    const realNow = Date.now.bind(Date);
    let skew = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    try {
      const w = await seedWs({
        prepare: (t, c) => {
          t.healthy = false;
          const port = c.getTcpPort.bind(c);
          c.getTcpPort = () =>
            ({
              fetch: (input: RequestInfo | URL, init?: RequestInit) => {
                if (new URL(new Request(input, init).url).pathname === "/v1/health") skew += 25_000;
                return port().fetch(input, init);
              },
            }) as unknown as Fetcher;
        },
      });
      const failedAttempts = async (n: number) => {
        for (let i = 0; i < 400; i++) {
          const op = await opOf(w.stub, "create");
          if (op && (op["attempt"] >= n || op["status"] === "failed")) return op;
          await sleep(25);
        }
        throw new Error(`attempt ${n} never failed`);
      };
      const first = await failedAttempts(1);
      // 03 Failure handling: "Health never returns 200 | 60 s poll in container.start | destroy(), then retry as above"
      expect(first["status"]).toBe("running");
      expect(first["step"]).toBe("container.start");
      expect(first["error_code"]).toBe("CONTAINER_START_FAILED");
      expect(first["error_detail"]).toBeTruthy();
      expect(w.container.destroyed).toBe(1);
      expect(await stateOf(w.stub)).toBe("starting");
      for (const n of [2, 3]) {
        skew += 70_000;
        await runDurableObjectAlarm(w.stub);
        await failedAttempts(n);
      }
      const op = (await opOf(w.stub, "create"))!;
      expect(op["status"]).toBe("failed");
      expect(op["error_code"]).toBe("CONTAINER_START_FAILED");
      expect(w.container.starts).toHaveLength(3);
      expect(w.container.destroyed).toBe(3);
      const row = await wsRow(w.stub);
      expect(row["state"]).toBe("error");
      expect(row["error_code"]).toBe("CONTAINER_START_FAILED");
      expect(row["tempod_token"]).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("tempod.connect fails 5 times, then error / TEMPOD_UNREACHABLE without restarting the container", async () => {
    let connects = 0;
    const w = await seedWs({
      prepare: (_t, c) => {
        const port = c.getTcpPort.bind(c);
        c.getTcpPort = () =>
          ({
            fetch: (input: RequestInfo | URL, init?: RequestInit) => {
              if (new URL(new Request(input, init).url).pathname === "/v1/connect") {
                connects++;
                return Promise.resolve(new Response("busy", { status: 503 }));
              }
              return port().fetch(input, init);
            },
          }) as unknown as Fetcher;
      },
    });
    await driveOp(w.stub, "create", "failed");
    // 03 Step limits: tempod.connect | 10 s | 5 | TEMPOD_UNREACHABLE
    expect(connects).toBe(5);
    expect(w.container.starts).toHaveLength(1);
    expect((await opOf(w.stub, "create"))!["error_code"]).toBe("TEMPOD_UNREACHABLE");
    const row = await wsRow(w.stub);
    expect(row["state"]).toBe("error");
    expect(row["error_code"]).toBe("TEMPOD_UNREACHABLE");
  });

  it("settings.read failing 3 times is skipped: defaults are used, the error shows in the Setup tab, and the op continues", async () => {
    const w = await seedWs({ prepare: (t) => t.fail("settings.read", "INTERNAL", "invalid TOML at line 3") });
    await driveToState(w.stub, "ready");
    await driveOp(w.stub, "create", "done");
    // 03 Step limits: settings.read | 10 s | 3 | Use defaults; show the error in the Setup tab
    expect(w.tempod.requestsOf("settings.read")).toHaveLength(3);
    const op = (await opOf(w.stub, "create"))!;
    expect(opState(op).skipped).toEqual(["settings.read"]);
    expect(Object.keys(opState(op).timings)).toContain("setup.run");
    const d = await detail(w.stub);
    expect((d.settingsErrors ?? []).some((e: string) => e.includes("invalid TOML at line 3"))).toBe(true);
    expect(d.settings.scripts.setup).toBe("");
    expect(d.settings.environment.instance).toBe("standard-3");
    expect(d.state).toBe("ready");
    expect(d.errorCode).toBeNull();
  });
});

describe("setup.run", { timeout: 60_000 }, () => {
  const withSetup = (extra: Record<string, unknown> = {}) =>
    settingsWith({ scripts: { setup: "npm ci", ...extra } });

  const waitForSetupStart = async (w: Ws) => {
    await drive(w.stub, async () => w.tempod.requestsOf("script.start").length === 1, "setup script start");
    await waitFor(
      async () => opState(await opOf(w.stub, "create")).waiting?.step === "setup.run",
      5000,
      "create op waiting",
    );
    return w.tempod.requestsOf("script.start")[0];
  };

  it("waits for script.exited; exit 0 sets setup_status succeeded and the state ready", async () => {
    const w = await seedWs({ effective: withSetup() });
    const start = await waitForSetupStart(w);
    // 01 Setup script: timeout 30 min
    expect(start).toMatchObject({ kind: "setup", command: "npm ci", scriptId: null, timeoutMs: 30 * MIN });
    expect(start.runId).toMatch(ULID);
    // 03 Step runner: "A step that waits for an event ... ends its alarm run without finishing."
    let op = (await opOf(w.stub, "create"))!;
    expect(op["status"]).toBe("running");
    expect(op["step"]).toBe("setup.run");
    expect(await stateOf(w.stub)).toBe("setting_up");
    expect((await wsRow(w.stub))["setup_status"]).toBe("running");
    await runDurableObjectAlarm(w.stub);
    await sleep(50);
    expect(w.tempod.requestsOf("script.start")).toHaveLength(1);
    expect((await opOf(w.stub, "create"))!["status"]).toBe("running");

    // "The event handler finishes the step and sets the alarm to now."
    await emit(w, { kind: "script.exited", runId: start.runId, exitCode: 0, signal: null, timedOut: false });
    await waitFor(async () => (await opOf(w.stub, "create"))?.["status"] === "done", 5000, "create done");
    op = (await opOf(w.stub, "create"))!;
    expect(opState(op).waiting).toBeUndefined();
    const row = await wsRow(w.stub);
    expect(row["setup_status"]).toBe("succeeded");
    expect(row["state"]).toBe("ready");
    expect(row["attention"]).toBe("none");
    expect(w.states).toEqual(["starting", "setting_up", "ready"]);
    // auto_run_after_setup is false: no run script starts.
    expect(w.tempod.requestsOf("script.start")).toHaveLength(1);
  });

  it("a non-zero exit sets setup_status failed, the state still becomes ready (not error), and queued turns wait", async () => {
    const w = await seedWs({ effective: withSetup(), prompt: "Build it", credentials: true });
    const start = await waitForSetupStart(w);
    await emit(w, { kind: "script.exited", runId: start.runId, exitCode: 2, signal: null, timedOut: false });
    await waitFor(async () => (await opOf(w.stub, "create"))?.["status"] === "done", 5000, "create done");
    // 03 Step limits: setup.run | 30 min | 1 | Not an error: set setup_status = 'failed'
    // 03 Transitions: setting_up → ready when "setup done (any exit code)"
    const row = await wsRow(w.stub);
    expect(row["setup_status"]).toBe("failed");
    expect(row["state"]).toBe("ready");
    expect(row["error_code"]).toBeNull();
    expect((await opOf(w.stub, "create"))!["error_code"]).toBeNull();
    // 03 Attention: error when setup_status is failed
    expect(row["attention"]).toBe("error");
    // 01 Setup script: "On a non-zero exit ... The queue waits"
    await sleep(100);
    expect(w.tempod.requestsOf("session.prompt")).toHaveLength(0);
    const queued = await rows(w.stub, "SELECT status FROM turns");
    expect(queued.map((t) => t["status"])).toEqual(["queued"]);
  });

  it("with auto_run_after_setup, exit 0 starts the default run script; a failed setup does not", async () => {
    const run = {
      web: { command: "bun run web", cwd: "apps/web", default: false },
      dev: { command: "bun run dev", cwd: "", default: true },
    };
    const w = await seedWs({ effective: withSetup({ auto_run_after_setup: true, run }) });
    const start = await waitForSetupStart(w);
    await emit(w, { kind: "script.exited", runId: start.runId, exitCode: 0, signal: null, timedOut: false });
    // 01 Setup script: "If auto_run_after_setup is true, the default run script starts."
    await waitFor(() => w.tempod.requestsOf("script.start").length === 2, 5000, "run script start");
    expect(w.tempod.requestsOf("script.start")[1]).toMatchObject({
      kind: "run",
      scriptId: "dev",
      command: "bun run dev",
      cwd: "",
      timeoutMs: null,
    });
    await waitFor(async () => (await stateOf(w.stub)) === "ready", 5000, "ready");

    const f = await seedWs({ effective: withSetup({ auto_run_after_setup: true, run }) });
    const fStart = await waitForSetupStart(f);
    await emit(f, { kind: "script.exited", runId: fStart.runId, exitCode: 1, signal: null, timedOut: false });
    await waitFor(async () => (await opOf(f.stub, "create"))?.["status"] === "done", 5000, "create done");
    await sleep(100);
    expect(f.tempod.requestsOf("script.start")).toHaveLength(1);
  });

  it("past its deadline, setup.run gives up: setup_status failed and the op still ends with the workspace ready", async () => {
    const w = await seedWs({ effective: withSetup() });
    await waitForSetupStart(w);
    await exec(
      w.stub,
      "UPDATE ops SET state_json = json_set(state_json, '$.waiting.deadline', 1) WHERE kind = 'create'",
    );
    await runDurableObjectAlarm(w.stub);
    await waitFor(async () => (await opOf(w.stub, "create"))?.["status"] === "done", 5000, "create done");
    const op = (await opOf(w.stub, "create"))!;
    expect(opState(op).skipped).toEqual(["setup.run"]);
    const row = await wsRow(w.stub);
    expect(row["setup_status"]).toBe("failed");
    expect(row["state"]).toBe("ready");
  });
});

describe("sleep op", { timeout: 60_000 }, () => {
  it("checkpoints (pre_sleep), backs up home, shuts tempod down, snapshots, destroys, then sleeping with no token", async () => {
    const w = await readyWs();
    // A Codex lease that the sleep must drop (03 Sleep 7).
    await env.CREDENTIALS.getByName(w.seeded.userId).addCodexLease(w.workspaceId);
    await runInDurableObject(w.stub, (i: WorkspaceDO) => internals(i).core.setKv("codexLease", true));
    const mark = w.states.length;
    const before = w.tempod.requests.length;
    expect(codeOf(await w.stub.sleepWorkspace({}))).toBe("OK");
    await driveToState(w.stub, "sleeping");
    await driveOp(w.stub, "sleep", "done");

    const op = (await opOf(w.stub, "sleep"))!;
    const st = opState(op);
    // 03 Ops and their steps: sleep, in order
    expect(Object.keys(st.timings)).toEqual([
      "turns.check",
      "git.checkpoint",
      "bundle.upload",
      "home.backup",
      "artifacts.upload",
      "tempod.shutdown",
      "container.snapshot",
      "container.destroy",
    ]);
    // Unchanged checkpoint → nothing to upload; home.backup fails here (no shim) → "Skip; log warn".
    expect(st.skipped).toEqual(["bundle.upload", "home.backup"]);
    // 03 Transitions: ready → stopping → sleeping
    expect(w.states.slice(mark)).toEqual(["stopping", "sleeping"]);

    const sent = w.tempod.requests.slice(before).map((r) => r.op);
    expect(sent.indexOf("git.checkpoint")).toBeLessThan(sent.indexOf("shutdown"));
    // 03 Sleep 2: git.checkpoint with reason pre_sleep
    const ckpt = w.tempod.requestsOf("git.checkpoint").at(-1);
    expect(ckpt).toMatchObject({ reason: "pre_sleep", turnId: null });
    expect(ckpt.checkpointId).toMatch(ULID);
    // 03 Sleep 4: tempod.shutdown
    expect(w.tempod.requestsOf("shutdown")).toEqual([{ reason: "sleep" }]);
    // 03 Sleep 5 and 01 Snapshot: snapshotContainer({name: <workspaceId>-<n>}), row {id, size, imageRef, createdAt}
    expect(w.container.snapshots).toEqual([{ id: "snap-1", size: 1024, name: `${w.workspaceId}-1` }]);
    const snaps = await rows(w.stub, "SELECT * FROM snapshots");
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({
      id: "snap-1",
      name: `${w.workspaceId}-1`,
      size_bytes: 1024,
      image_ref: IMAGE,
      unusable: 0,
      last_restored_at: null,
    });
    // 03 Sleep 6: destroy, tempod_token = null
    expect(w.container.destroyed).toBe(1);
    expect(w.container.running).toBe(false);
    const row = await wsRow(w.stub);
    expect(row["tempod_token"]).toBeNull();
    expect(row["state"]).toBe("sleeping");
    await waitFor(async () => (await d1Row(w.workspaceId))?.["state"] === "sleeping", 5000, "D1 sleeping");
    // 03 Sleep 7: "Drop the Codex lease in CredentialDO."
    await waitFor(
      async () =>
        (
          await runInDurableObject(
            env.CREDENTIALS.getByName(w.seeded.userId),
            (_i: unknown, state: DurableObjectState) =>
              state.storage.sql
                .exec("SELECT * FROM codex_leases WHERE workspace_id = ?", w.workspaceId)
                .toArray(),
          )
        ).length === 0,
      5000,
      "codex lease dropped",
    );
  });

  it("turns.check cancels the op while a turn is running, and the workspace keeps working", async () => {
    const w = await readyWs({ prompt: "Do work", credentials: true });
    await waitFor(
      async () => (await rows(w.stub, "SELECT id FROM turns WHERE status = 'running'")).length === 1,
      5000,
      "turn running",
    );
    await runInDurableObject(w.stub, (i: WorkspaceDO) => {
      internals(i).runner.insert("sleep");
    });
    await driveOp(w.stub, "sleep", "cancelled");
    // 03 Sleep 1: "turns.check: if a turn is running or queued, cancel the op. The workspace is not idle."
    expect(await stateOf(w.stub)).toBe("working");
    expect(w.tempod.requestsOf("git.checkpoint").filter((p) => p.reason === "pre_sleep")).toHaveLength(0);
    expect(w.tempod.requestsOf("shutdown")).toHaveLength(0);
    expect(w.container.destroyed).toBe(0);
    expect(w.states).not.toContain("stopping");
  });

  it("turns.check cancels the op while a turn is queued", async () => {
    // A failed setup keeps prompts queued while the state is ready (01 Setup script).
    const w = await seedWs({
      effective: settingsWith({ scripts: { setup: "npm ci" } }),
      prompt: "Queued work",
      credentials: true,
    });
    await drive(w.stub, async () => w.tempod.requestsOf("script.start").length === 1, "setup start");
    await waitFor(
      async () => opState(await opOf(w.stub, "create")).waiting?.step === "setup.run",
      5000,
      "waiting",
    );
    await emit(w, {
      kind: "script.exited",
      runId: w.tempod.requestsOf("script.start")[0].runId,
      exitCode: 1,
      signal: null,
      timedOut: false,
    });
    await waitFor(async () => (await opOf(w.stub, "create"))?.["status"] === "done", 5000, "create done");
    expect(await stateOf(w.stub)).toBe("ready");
    expect(codeOf(await w.stub.sleepWorkspace({}))).toBe("OK");
    await driveOp(w.stub, "sleep", "cancelled");
    expect(await stateOf(w.stub)).toBe("ready");
    expect(w.container.destroyed).toBe(0);
    expect((await rows(w.stub, "SELECT status FROM turns")).map((t) => t["status"])).toEqual(["queued"]);
  });

  it("a checkpoint whose bundle upload fails 3 times is marked local_only, and the sleep goes on", async () => {
    const w = await readyWs();
    w.tempod.on("git.checkpoint", checkpointResult);
    expect(codeOf(await w.stub.sleepWorkspace({}))).toBe("OK");
    await driveToState(w.stub, "sleeping");
    const id = w.tempod.requestsOf("git.checkpoint").at(-1).checkpointId;
    // 03 Step limits: bundle.upload | 5 min | 3 | Mark local_only
    const ckpt = (await one(w.stub, "SELECT * FROM checkpoints WHERE id = ?", id))!;
    expect(ckpt).toMatchObject({
      reason: "pre_sleep",
      local_only: 1,
      r2_key: null,
      commit_sha: "1".repeat(40),
    });
    const op = (await opOf(w.stub, "sleep"))!;
    expect(opState(op).skipped).toContain("bundle.upload");
    expect(w.container.snapshots).toHaveLength(1);
  });

  it("git.checkpoint failing 3 times is skipped and the sleep goes on", async () => {
    const w = await readyWs();
    w.tempod.fail("git.checkpoint", "INTERNAL", "index.lock exists");
    expect(codeOf(await w.stub.sleepWorkspace({}))).toBe("OK");
    await driveToState(w.stub, "sleeping");
    // 03 Step limits: git.checkpoint | 2 min | 3 | Skip; log warn
    expect(w.tempod.requestsOf("git.checkpoint")).toHaveLength(3);
    expect(opState(await opOf(w.stub, "sleep")).skipped).toContain("git.checkpoint");
    expect(await rows(w.stub, "SELECT id FROM checkpoints")).toHaveLength(0);
    expect(w.tempod.requestsOf("shutdown")).toHaveLength(1);
    expect(w.container.snapshots).toHaveLength(1);
  });

  it("a failed tempod.shutdown is not retried and the sleep goes on", async () => {
    const w = await readyWs();
    w.tempod.fail("shutdown", "INTERNAL", "busy");
    expect(codeOf(await w.stub.sleepWorkspace({}))).toBe("OK");
    await driveToState(w.stub, "sleeping");
    // 03 Step limits: tempod.shutdown | 45 s | 1 | Continue
    expect(w.tempod.requestsOf("shutdown")).toHaveLength(1);
    expect(opState(await opOf(w.stub, "sleep")).skipped).toContain("tempod.shutdown");
    expect(w.container.snapshots).toHaveLength(1);
    expect(w.container.destroyed).toBe(1);
  });

  it("container.snapshot failing twice is skipped: no snapshot row, and the next wake takes the fresh path", async () => {
    const w = await readyWs();
    w.container.snapshotFails = true;
    expect(codeOf(await w.stub.sleepWorkspace({}))).toBe("OK");
    await driveToState(w.stub, "sleeping");
    // 03 Step limits: container.snapshot | 5 min | 2 | Continue; the next wake uses the fresh path
    expect(opState(await opOf(w.stub, "sleep")).skipped).toContain("container.snapshot");
    expect(await rows(w.stub, "SELECT id FROM snapshots")).toHaveLength(0);
    expect(w.container.destroyed).toBe(1);
    const clones = w.tempod.requestsOf("repo.clone").length;
    expect(codeOf(await w.stub.wakeWorkspace({}))).toBe("OK");
    await driveToState(w.stub, "ready");
    expect(w.container.starts.at(-1).containerSnapshot).toBeUndefined();
    expect(w.tempod.requestsOf("repo.clone")).toHaveLength(clones + 1);
  });

  it("container.destroy failing 3 times fails the op and moves the workspace to error / INTERNAL", async () => {
    const w = await readyWs();
    w.container.destroy = async () => {
      throw new Error("destroy refused");
    };
    expect(codeOf(await w.stub.sleepWorkspace({}))).toBe("OK");
    await driveOp(w.stub, "sleep", "failed");
    // 03 Step limits: container.destroy | 30 s | 3 | INTERNAL; Step runner: sleep → error with the step's code
    const op = (await opOf(w.stub, "sleep"))!;
    expect(op["step"]).toBe("container.destroy");
    expect(op["error_code"]).toBe("INTERNAL");
    const row = await wsRow(w.stub);
    expect(row["state"]).toBe("error");
    expect(row["error_code"]).toBe("INTERNAL");
  });
});

describe("wake op", { timeout: 60_000 }, () => {
  it("starts from the newest usable snapshot, goes straight to ready and skips the fresh-disk steps", async () => {
    const w = await asleep();
    const incarnation = (await wsRow(w.stub))["tempod_incarnation"];
    const acked = (await wsRow(w.stub))["tempod_acked_seq"];
    expect(incarnation).toBe(w.tempod.incarnation);
    const counts = {
      clone: w.tempod.requestsOf("repo.clone").length,
      settings: w.tempod.requestsOf("settings.read").length,
    };
    const mark = w.states.length;
    expect(codeOf(await w.stub.wakeWorkspace({}))).toBe("OK");
    await driveToState(w.stub, "ready");
    await driveOp(w.stub, "wake", "done");
    // 01 Restore order on wake 1: start({containerSnapshot: id})
    const start = w.container.starts.at(-1);
    expect(start.containerSnapshot).toEqual({ id: "snap-1" });
    expect(start.image).toBeUndefined();
    // 03 Transitions: sleeping → starting → ready (disk came from a snapshot)
    expect(w.states.slice(mark)).toEqual(["starting", "ready"]);
    const st = opState(await opOf(w.stub, "wake"));
    expect(st.skipped).toEqual(FRESH_STEPS);
    expect(Object.keys(st.timings)).toEqual(OP_STEPS.wake);
    expect(w.tempod.requestsOf("repo.clone")).toHaveLength(counts.clone);
    expect(w.tempod.requestsOf("settings.read")).toHaveLength(counts.settings);
    // 03 Wake 2: hello with the stored incarnation and tempod_acked_seq
    expect(w.tempod.hellos.at(-1)).toMatchObject({ incarnation, lastAckedSeq: acked });
    // 01 Snapshot: usable while "created or last restored less than 29 days ago"
    expect(
      (await one(w.stub, "SELECT last_restored_at FROM snapshots WHERE id = 'snap-1'"))!["last_restored_at"],
    ).not.toBeNull();
    expect((await wsRow(w.stub))["tempod_token"]).not.toBeNull();
  });

  it("picks the newest snapshot with the current image that is under 29 days old and not unusable", async () => {
    const w = await asleep();
    await exec(w.stub, "DELETE FROM snapshots");
    const now = Date.now();
    await insertSnapshot(w.stub, { id: "older", imageRef: IMAGE, createdAt: now - 2 * HOUR });
    await insertSnapshot(w.stub, { id: "expected", imageRef: IMAGE, createdAt: now - HOUR });
    await insertSnapshot(w.stub, { id: "other-image", imageRef: OTHER_IMAGE, createdAt: now - 10 * MIN });
    await insertSnapshot(w.stub, { id: "marked", imageRef: IMAGE, createdAt: now - 5 * MIN, unusable: 1 });
    expect(codeOf(await w.stub.wakeWorkspace({}))).toBe("OK");
    await driveToState(w.stub, "ready");
    // 01 Durability: usable = same imageRef and < 29 days; 03 Wake 1: "Pick the newest snapshot that is usable"
    expect(w.container.starts.at(-1).containerSnapshot).toEqual({ id: "expected" });
  });

  it("a snapshot last restored recently is usable even when it was created over 29 days ago", async () => {
    const w = await asleep();
    await exec(w.stub, "DELETE FROM snapshots");
    await insertSnapshot(w.stub, {
      id: "old-but-used",
      imageRef: IMAGE,
      createdAt: Date.now() - 40 * DAY,
      lastRestoredAt: Date.now() - DAY,
    });
    expect(codeOf(await w.stub.wakeWorkspace({}))).toBe("OK");
    await driveToState(w.stub, "ready");
    // 01 Durability: "It was created or last restored less than 29 days ago."
    expect(w.container.starts.at(-1).containerSnapshot).toEqual({ id: "old-but-used" });
  });

  it("does not use a snapshot older than 29 days: starts from the image and runs the fresh-disk steps", async () => {
    const w = await asleep();
    await exec(w.stub, "UPDATE snapshots SET created_at = ?", Date.now() - 29 * DAY - MIN);
    const counts = {
      clone: w.tempod.requestsOf("repo.clone").length,
      settings: w.tempod.requestsOf("settings.read").length,
    };
    const mark = w.states.length;
    expect(codeOf(await w.stub.wakeWorkspace({}))).toBe("OK");
    await driveToState(w.stub, "ready");
    await driveOp(w.stub, "wake", "done");
    expect(w.container.starts.at(-1)).toMatchObject({ image: IMAGE });
    expect(w.container.starts.at(-1).containerSnapshot).toBeUndefined();
    // 03 Transitions: starting → setting_up on a fresh disk
    expect(w.states.slice(mark)).toEqual(["starting", "setting_up", "ready"]);
    // 03 Wake 3: fresh disk only: repo.clone, repo.applyCheckpoint, home.restore, settings.read, setup.run
    expect(w.tempod.requestsOf("repo.clone")).toHaveLength(counts.clone + 1);
    expect(w.tempod.requestsOf("settings.read")).toHaveLength(counts.settings + 1);
    // No uploaded checkpoint and no home backup: those two have nothing to restore.
    expect(opState(await opOf(w.stub, "wake")).skipped).toEqual(["repo.applyCheckpoint", "home.restore"]);
  });

  it("does not use a snapshot made from another image", async () => {
    const w = await asleep();
    // A deploy changed the image: the stored snapshot came from the old one.
    w.container.images["workspace"] = OTHER_IMAGE;
    const clones = w.tempod.requestsOf("repo.clone").length;
    expect(codeOf(await w.stub.wakeWorkspace({}))).toBe("OK");
    await driveToState(w.stub, "ready");
    // 01 Durability: "imageRef equals the current ctx.container.images.workspace"
    expect(w.container.starts.at(-1)).toMatchObject({ image: OTHER_IMAGE });
    expect(w.container.starts.at(-1).containerSnapshot).toBeUndefined();
    expect(w.tempod.requestsOf("repo.clone")).toHaveLength(clones + 1);
    expect((await wsRow(w.stub))["image_ref"]).toBe(OTHER_IMAGE);
  });

  it("when the start from a snapshot fails, marks it unusable and starts from the image in the same attempt", async () => {
    const w = await asleep();
    w.container.failStartWithSnapshot = true;
    const starts = w.container.starts.length;
    const clones = w.tempod.requestsOf("repo.clone").length;
    expect(codeOf(await w.stub.wakeWorkspace({}))).toBe("OK");
    await driveToState(w.stub, "ready");
    await driveOp(w.stub, "wake", "done");
    // 03 Wake 1: "If a start from a snapshot fails, mark the snapshot unusable and start from the image at once.
    // That retry does not count as an attempt."
    const tries = w.container.starts.slice(starts);
    expect(tries).toHaveLength(2);
    expect(tries[0].containerSnapshot).toEqual({ id: "snap-1" });
    expect(tries[1]).toMatchObject({ image: IMAGE });
    expect((await one(w.stub, "SELECT unusable FROM snapshots WHERE id = 'snap-1'"))!["unusable"]).toBe(1);
    const op = (await opOf(w.stub, "wake"))!;
    expect(op["error_code"]).toBeNull();
    // The disk is fresh: clone and settings run again.
    expect(w.tempod.requestsOf("repo.clone")).toHaveLength(clones + 1);
    expect(opState(op).skipped ?? []).not.toContain("repo.clone");
    expect(opState(op).skipped ?? []).not.toContain("settings.read");
  });

  it("when the image start fails too, the snapshot fallback is not an attempt: 3 attempts, then error / CONTAINER_START_FAILED", async () => {
    const w = await asleep();
    const before = w.container.starts.length;
    w.container.start = (options: any) => {
      w.container.starts.push(options);
      throw new Error("host full");
    };
    expect(codeOf(await w.stub.wakeWorkspace({}))).toBe("OK");
    await driveOp(w.stub, "wake", "failed");
    // 03 Wake 1: the image retry after a failed snapshot start "does not count as an attempt";
    // 03 Failure handling: "start() throws ... 3 attempts, then error / CONTAINER_START_FAILED"
    const tries = w.container.starts.slice(before);
    expect(tries.map((t) => (t.containerSnapshot ? "snapshot" : "image"))).toEqual([
      "snapshot",
      "image",
      "image",
      "image",
    ]);
    expect((await one(w.stub, "SELECT unusable FROM snapshots WHERE id = 'snap-1'"))!["unusable"]).toBe(1);
    expect((await opOf(w.stub, "wake"))!["error_code"]).toBe("CONTAINER_START_FAILED");
    const row = await wsRow(w.stub);
    expect(row["state"]).toBe("error");
    expect(row["error_code"]).toBe("CONTAINER_START_FAILED");
  });

  it("on a fresh disk, a branch gone from GitHub sets pushed = 0", async () => {
    const w = await asleep();
    await exec(w.stub, "DELETE FROM snapshots");
    await exec(
      w.stub,
      "UPDATE workspace SET pushed = 1, last_pushed_sha = ?, force_push_lease = 1",
      "9".repeat(40),
    );
    w.tempod.on("repo.clone", () => ({ headSha: "a".repeat(40), remoteHeadSha: null }));
    expect(codeOf(await w.stub.wakeWorkspace({}))).toBe("OK");
    await driveToState(w.stub, "ready");
    // 03 Restore 2: "If the branch was deleted on GitHub, the next wake recreates it ... and sets pushed = 0."
    // Nothing is on origin any more, so there is no pushed sha to lease against.
    expect(await wsRow(w.stub)).toMatchObject({ pushed: 0, last_pushed_sha: null, force_push_lease: 0 });
  });

  it("a snapshot wake asks GitHub whether a pushed branch still exists; a gone branch sets pushed = 0", async () => {
    // 03 Restore 2: "If the branch was deleted on GitHub, the next wake ... sets pushed = 0." A snapshot wake skips repo.clone.
    const exists = vi.spyOn(github, "branchExists");
    try {
      const gone = await asleep();
      await exec(
        gone.stub,
        "UPDATE workspace SET pushed = 1, last_pushed_sha = ?, force_push_lease = 1",
        "9".repeat(40),
      );
      await withGithubToken(gone);
      exists.mockResolvedValue(false);
      expect(codeOf(await gone.stub.wakeWorkspace({}))).toBe("OK");
      await driveToState(gone.stub, "ready");
      expect(gone.container.starts.at(-1).containerSnapshot).toEqual({ id: "snap-1" });
      expect(exists).toHaveBeenCalledWith("ghs_test", { owner: "acme", name: "app" }, gone.branch);
      expect(await wsRow(gone.stub)).toMatchObject({ pushed: 0, last_pushed_sha: null, force_push_lease: 0 });

      // Still on GitHub: nothing changes. A GitHub error does not stop the wake either.
      for (const answer of [
        () => exists.mockResolvedValue(true),
        () => exists.mockRejectedValue(new TempoError("GITHUB_API_ERROR")),
      ]) {
        const kept = await asleep();
        await exec(kept.stub, "UPDATE workspace SET pushed = 1, last_pushed_sha = ?", "9".repeat(40));
        await withGithubToken(kept);
        answer();
        expect(codeOf(await kept.stub.wakeWorkspace({}))).toBe("OK");
        await driveToState(kept.stub, "ready");
        await driveOp(kept.stub, "wake", "done");
        expect(await wsRow(kept.stub)).toMatchObject({ pushed: 1, last_pushed_sha: "9".repeat(40) });
      }
    } finally {
      exists.mockRestore();
    }
  });

  it("on a fresh disk, a failing checkpoint restore and home restore are skipped after 2 attempts each", async () => {
    const w = await asleep();
    await exec(w.stub, "DELETE FROM snapshots");
    const ckpt = newId();
    await insertCheckpoint(w.stub, ckpt, null, "pre_sleep");
    const key = `checkpoints/${w.workspaceId}/${ckpt}.bundle`;
    await env.DATA.put(key, "bundle");
    await exec(w.stub, "UPDATE checkpoints SET r2_key = ? WHERE id = ?", key, ckpt);
    await exec(
      w.stub,
      "INSERT INTO home_backups (id, record_json, size_bytes, created_at) VALUES ('hb1', ?, 10, ?)",
      JSON.stringify({ id: "hb1", dir: "/home/tempo", size: 10, sha256: "0".repeat(64), format: 1 }),
      Date.now(),
    );
    expect(codeOf(await w.stub.wakeWorkspace({}))).toBe("OK");
    await driveToState(w.stub, "ready");
    await driveOp(w.stub, "wake", "done");
    // 03 Step limits: repo.applyCheckpoint | 2 | Skip; home.restore | 2 | Skip; sessions hand off
    const st = opState(await opOf(w.stub, "wake"));
    expect(st.skipped).toEqual(["repo.applyCheckpoint", "home.restore"]);
    expect(w.tempod.requestsOf("repo.applyCheckpoint")).toHaveLength(0);
    expect((await wsRow(w.stub))["state"]).toBe("ready");
    expect((await wsRow(w.stub))["error_code"]).toBeNull();
  });

  it("marks sessions for reload: the next prompt starts the agent again with its stored ACP session id", async () => {
    const w = await readyWs({ prompt: "First", credentials: true });
    await waitFor(() => w.tempod.requestsOf("session.prompt").length === 1, 5000, "first prompt");
    const first = w.tempod.requestsOf("session.prompt")[0];
    await waitFor(
      async () => (await turnOf(w.stub, first.turnId))?.["status"] === "running",
      5000,
      "running",
    );
    await emit(w, {
      kind: "turn.ended",
      sessionId: first.sessionId,
      turnId: first.turnId,
      stopReason: "end_turn",
    });
    await driveToState(w.stub, "ready");
    await waitFor(
      async () =>
        (await runInDurableObject(w.stub, (i: WorkspaceDO) => internals(i).core.turnEndInProgress)) === false,
      5000,
      "turn end work",
    );
    const acp = (await sessionOf(w.stub, first.sessionId))!["acp_session_id"];
    expect(acp).toMatch(/^acp-/);
    expect(codeOf(await w.stub.sleepWorkspace({}))).toBe("OK");
    await driveToState(w.stub, "sleeping");
    expect(codeOf(await w.stub.wakeWorkspace({}))).toBe("OK");
    await driveToState(w.stub, "ready");
    await driveOp(w.stub, "wake", "done");
    // 03 Wake 4: "sessions.markReload: mark every non-closed session as having no live process."
    expect(await runInDurableObject(w.stub, (i: WorkspaceDO) => internals(i).core.liveSessions.size)).toBe(0);
    ok(
      await w.stub.sendPrompt({
        sessionId: first.sessionId,
        text: "Second",
        mentions: [],
        attachmentIds: [],
        reviewCommentIds: [],
      }),
    );
    // "The next prompt reloads it."
    await waitFor(() => w.tempod.requestsOf("session.start").length === 2, 5000, "session reload");
    expect(w.tempod.requestsOf("session.start")[1]).toMatchObject({
      sessionId: first.sessionId,
      acpSessionId: acp,
    });
  });
});

describe("archive and restore ops", { timeout: 60_000 }, () => {
  it("archive from sleeping skips every container step, then archived with archived_at in the DO and D1", async () => {
    const w = await asleep();
    const starts = w.container.starts.length;
    const destroyed = w.container.destroyed;
    const requests = w.tempod.requests.length;
    const mark = w.states.length;
    expect(codeOf(await w.stub.archiveWorkspace({}))).toBe("OK");
    await driveToState(w.stub, "archived");
    await driveOp(w.stub, "archive", "done");
    // 03 Ops and their steps: "When the container is not running, archive skips every step that needs it"
    const st = opState(await opOf(w.stub, "archive"));
    for (const step of [
      "script.archive",
      "git.checkpoint",
      "bundle.upload",
      "home.backup",
      "artifacts.upload",
      "tempod.shutdown",
      "container.snapshot",
    ]) {
      expect(st.skipped, step).toContain(step);
    }
    expect(Object.keys(st.timings)).toEqual(OP_STEPS.archive);
    expect(w.container.starts).toHaveLength(starts);
    expect(w.container.destroyed).toBe(destroyed);
    expect(w.tempod.requests).toHaveLength(requests);
    // 03 Transitions: sleeping → archiving → archived
    expect(w.states.slice(mark)).toEqual(["archiving", "archived"]);
    // 03 Archive 5: "Set archived_at = now in the DO and in D1. State archived."
    const archivedAt = (await wsRow(w.stub))["archived_at"];
    expect(archivedAt).toBeGreaterThan(0);
    await waitFor(
      async () => {
        const r = await d1Row(w.workspaceId);
        return r?.["state"] === "archived" && r["archived_at"] === archivedAt;
      },
      5000,
      "D1 archived",
    );
  });

  it("archive while a turn is starting aborts the start before its prompt and deletes the queued turn", async () => {
    // session.start may take up to 120 s (02); turns.cancel must not fail the archive while it runs.
    const w = await readyWs({
      prompt: "Slow agent",
      credentials: true,
      prepare: (t) => t.on("session.start", () => new Promise(() => undefined)),
    });
    await waitFor(() => w.tempod.requestsOf("session.start").length === 1, 5000, "session.start sent");
    const turnId = (await one(w.stub, "SELECT id FROM turns"))!["id"];
    expect(codeOf(await w.stub.archiveWorkspace({}))).toBe("OK");
    await driveToState(w.stub, "archived");
    // 03 Archive 1: "turns.cancel: cancel the running turn and delete queued turns."
    expect((await opOf(w.stub, "archive"))!["status"]).toBe("done");
    expect(await turnOf(w.stub, turnId)).toBeUndefined();
    expect(await rows(w.stub, "SELECT id FROM items WHERE turn_id = ?", turnId)).toHaveLength(0);
    expect(w.tempod.requestsOf("session.prompt")).toHaveLength(0);
    // 03 Transitions: the starting turn never moves the workspace on from archiving.
    expect(w.states.slice(w.states.indexOf("archiving"))).toEqual(["archiving", "archived"]);
  });

  it("a prompt accepted after archiving began is cancelled at once and never moves the workspace to working", async () => {
    let inner: Internals | null = null;
    const w = await seedWs({
      prompt: "Racing the archive",
      credentials: true,
      inside: (x) => (inner = x),
      prepare: (t) =>
        t.on("session.prompt", () => {
          // archiveWorkspace while session.prompt is in flight.
          inner!.core.setState("archiving");
          inner!.runner.insert("archive");
          return { accepted: true };
        }),
    });
    await driveToState(w.stub, "archived");
    const p = w.tempod.requestsOf("session.prompt")[0];
    // The turn never counts as running: it is cancelled where it would have started.
    expect(await turnOf(w.stub, p.turnId)).toMatchObject({ status: "cancelled", started_at: null });
    expect(w.tempod.requestsOf("session.cancel")).toContainEqual({
      sessionId: p.sessionId,
      turnId: p.turnId,
    });
    expect(w.states).not.toContain("working");
    expect(w.states).not.toContain("error");
    expect((await opOf(w.stub, "archive"))!["status"]).toBe("done");
  });

  it("deleting queued turns during an archive raises items_rev (02 Rules)", async () => {
    const w = await asleep();
    await insertSession(w.stub, "s-archive");
    await insertTurn(w.stub, "t-archive", "s-archive", 1, "queued");
    const before = (await wsRow(w.stub))["items_rev"];
    await exec(
      w.stub,
      "INSERT INTO items (id, session_id, turn_id, kind, status, content_json, rev, created_at, updated_at) VALUES ('i-archive', 's-archive', 't-archive', 'user_message', 'completed', ?, ?, 1, 1)",
      JSON.stringify({ text: "queued", mentions: [], attachments: [], reviewCommentIds: [] }),
      before + 1,
    );
    await exec(w.stub, "UPDATE workspace SET items_rev = ?", before + 1);
    expect(codeOf(await w.stub.archiveWorkspace({}))).toBe("OK");
    await driveToState(w.stub, "archived");
    expect(await turnOf(w.stub, "t-archive")).toBeUndefined();
    expect(await rows(w.stub, "SELECT id FROM items WHERE turn_id = 't-archive'")).toHaveLength(0);
    expect((await wsRow(w.stub))["items_rev"]).toBe(before + 2);
  });

  it("archive from ready runs the archive script; a non-zero exit is a warning notice and the archive goes on", async () => {
    const w = await readyWs({ effective: settingsWith({ scripts: { archive: "./bin/cleanup" } }) });
    const sessionId = newId();
    await insertSession(w.stub, sessionId);
    await env.CREDENTIALS.getByName(w.seeded.userId).addCodexLease(w.workspaceId);
    await runInDurableObject(w.stub, (i: WorkspaceDO) => internals(i).core.setKv("codexLease", true));
    expect(codeOf(await w.stub.archiveWorkspace({}))).toBe("OK");
    await drive(w.stub, async () => w.tempod.requestsOf("script.start").length === 1, "archive script start");
    // 01 Archive script: "Runs at archive time with a 120 s timeout."
    const start = w.tempod.requestsOf("script.start")[0];
    expect(start).toMatchObject({ kind: "archive", command: "./bin/cleanup", timeoutMs: 120_000 });
    await waitFor(
      async () => opState(await opOf(w.stub, "archive")).waiting?.step === "script.archive",
      5000,
      "waiting",
    );
    expect(await stateOf(w.stub)).toBe("archiving");
    await emit(w, { kind: "script.exited", runId: start.runId, exitCode: 3, signal: null, timedOut: false });
    await driveToState(w.stub, "archived");
    // 03 Step limits: script.archive | 120 s | 1 | Continue; warn notice
    const notices = (await rows(w.stub, "SELECT content_json FROM items WHERE kind = 'notice'")).map((r) =>
      JSON.parse(r["content_json"]),
    );
    expect(notices.some((n) => n.level === "warning" && /archive script failed/i.test(n.text))).toBe(true);
    // 03 Archive 3: checkpoint pre_archive, shutdown, snapshot, destroy, as in sleep
    expect(w.tempod.requestsOf("git.checkpoint").map((p) => p.reason)).toContain("pre_archive");
    expect(w.tempod.requestsOf("shutdown")).toEqual([{ reason: "archive" }]);
    expect(w.container.snapshots).toHaveLength(1);
    expect(w.container.destroyed).toBe(1);
    expect((await wsRow(w.stub))["tempod_token"]).toBeNull();
    // 03 Archive 5: "Drop the Codex lease."
    await waitFor(
      async () =>
        (
          await runInDurableObject(
            env.CREDENTIALS.getByName(w.seeded.userId),
            (_i: unknown, state: DurableObjectState) =>
              state.storage.sql
                .exec("SELECT * FROM codex_leases WHERE workspace_id = ?", w.workspaceId)
                .toArray(),
          )
        ).length === 0,
      5000,
      "codex lease dropped",
    );
  });

  it("github.deleteBranch runs only with delete_branch_on_archive, pushed = 1 and no open PR; failing 3 times it is skipped", async () => {
    const w = await asleep({ effective: settingsWith({ git: { delete_branch_on_archive: true } }) });
    await exec(w.stub, "UPDATE workspace SET pushed = 1, last_pushed_sha = ?", "9".repeat(40));
    expect(codeOf(await w.stub.archiveWorkspace({}))).toBe("OK");
    await driveToState(w.stub, "archived");
    // No GitHub App is set up here, so every attempt fails with GITHUB_API_ERROR.
    // 03 Step limits: github.deleteBranch | 30 s | 3 | Skip; log warn
    let op = (await opOf(w.stub, "archive"))!;
    expect(op["status"]).toBe("done");
    expect(op["error_code"]).toBe("GITHUB_API_ERROR");
    expect(opState(op).skipped).toContain("github.deleteBranch");

    // 03 Archive 4: "only if git.delete_branch_on_archive is true, pushed = 1, and there is no open PR"
    const pr = await asleep({ effective: settingsWith({ git: { delete_branch_on_archive: true } }) });
    await exec(pr.stub, "UPDATE workspace SET pushed = 1, pr_number = 7, pr_state = 'open'");
    expect(codeOf(await pr.stub.archiveWorkspace({}))).toBe("OK");
    await driveToState(pr.stub, "archived");
    op = (await opOf(pr.stub, "archive"))!;
    expect(op["error_code"]).toBeNull();
    expect(opState(op).skipped).toContain("github.deleteBranch");

    const unpushed = await asleep({ effective: settingsWith({ git: { delete_branch_on_archive: true } }) });
    expect(codeOf(await unpushed.stub.archiveWorkspace({}))).toBe("OK");
    await driveToState(unpushed.stub, "archived");
    expect((await opOf(unpushed.stub, "archive"))!["error_code"]).toBeNull();
  });

  it("github.deleteBranch that succeeds (or finds no branch) sets pushed = 0, so the next wake and PR know", async () => {
    // 03 Archive 4 deletes the branch; 03 Restore 2: with the branch gone, "sets pushed = 0".
    const del = vi.spyOn(github, "deleteBranch");
    try {
      for (const outcome of [
        () => del.mockResolvedValue(undefined),
        () => del.mockRejectedValue(new TempoError("NOT_FOUND")),
      ]) {
        const w = await asleep({ effective: settingsWith({ git: { delete_branch_on_archive: true } }) });
        await exec(
          w.stub,
          "UPDATE workspace SET pushed = 1, last_pushed_sha = ?, force_push_lease = 1",
          "9".repeat(40),
        );
        await withGithubToken(w);
        outcome();
        expect(codeOf(await w.stub.archiveWorkspace({}))).toBe("OK");
        await driveToState(w.stub, "archived");
        expect(del).toHaveBeenLastCalledWith("ghs_test", { owner: "acme", name: "app" }, w.branch);
        const op = (await opOf(w.stub, "archive"))!;
        expect(opState(op).skipped ?? []).not.toContain("github.deleteBranch");
        expect(await wsRow(w.stub)).toMatchObject({ pushed: 0, last_pushed_sha: null, force_push_lease: 0 });
        expect((await detail(w.stub)).pushed).toBe(false);
      }
    } finally {
      del.mockRestore();
    }
  });

  it("restore moves archived → sleeping, clears archived_at in the DO and D1", async () => {
    const w = await asleep();
    expect(codeOf(await w.stub.archiveWorkspace({}))).toBe("OK");
    await driveToState(w.stub, "archived");
    await waitFor(async () => (await d1Row(w.workspaceId))?.["archived_at"] != null, 5000, "D1 archived_at");
    const mark = w.states.length;
    expect(codeOf(await w.stub.restoreWorkspace({}))).toBe("OK");
    await driveToState(w.stub, "sleeping");
    await driveOp(w.stub, "restore", "done");
    // 03 Restore 3: "Clear archived_at. State sleeping. The container starts on the next wake trigger."
    expect(w.states.slice(mark)).toEqual(["sleeping"]);
    expect((await wsRow(w.stub))["archived_at"]).toBeNull();
    expect(w.container.running).toBe(false);
    await waitFor(
      async () => {
        const r = await d1Row(w.workspaceId);
        return r?.["state"] === "sleeping" && r["archived_at"] === null;
      },
      5000,
      "D1 restored",
    );
  });

  it("branch.check fails the restore with BRANCH_IN_USE when another live workspace has the branch; the workspace stays archived", async () => {
    const w = await asleep();
    expect(codeOf(await w.stub.archiveWorkspace({}))).toBe("OK");
    await driveToState(w.stub, "archived");
    await waitFor(async () => (await d1Row(w.workspaceId))?.["archived_at"] != null, 5000, "D1 archived_at");
    const now = Date.now();
    // Same branch in an archived workspace and in another project: neither counts.
    const other = await seedProject();
    for (const [projectId, slug, archivedAt] of [
      [w.seeded.projectId, "old1", now],
      [other.projectId, "elsewhere", null],
    ] as const) {
      await env.DB.prepare(
        "INSERT INTO workspaces (id, project_id, user_id, slug, title, branch, base_branch, state, attention, default_agent, pinned, last_activity_at, created_at, archived_at, summary_rev) VALUES (?, ?, ?, ?, ?, ?, 'main', 'ready', 'none', 'claude', 0, ?, ?, ?, 0)",
      )
        .bind(newId(), projectId, w.seeded.userId, slug, slug, w.branch, now, now, archivedAt)
        .run();
    }
    // A live workspace of this project took the branch after the archive.
    await env.DB.prepare(
      "INSERT INTO workspaces (id, project_id, user_id, slug, title, branch, base_branch, state, attention, default_agent, pinned, last_activity_at, created_at, summary_rev) VALUES (?, ?, ?, 'thief', 'thief', ?, 'main', 'ready', 'none', 'claude', 0, ?, ?, 0)",
    )
      .bind(newId(), w.seeded.projectId, w.seeded.userId, w.branch, now, now)
      .run();
    await runInDurableObject(w.stub, (i: WorkspaceDO) => {
      internals(i).runner.insert("restore");
    });
    await driveOp(w.stub, "restore", "failed");
    // 03 Restore 1: "Else BRANCH_IN_USE." 03 Transitions: a failing step never moves `archived` to error.
    expect((await opOf(w.stub, "restore"))!["error_code"]).toBe("BRANCH_IN_USE");
    const row = await wsRow(w.stub);
    expect(row["state"]).toBe("archived");
    expect(row["archived_at"]).not.toBeNull();
  });

  it("restore with only the slug taken gives the workspace a new slug and keeps its branch", async () => {
    const w = await asleep();
    expect(codeOf(await w.stub.archiveWorkspace({}))).toBe("OK");
    await driveToState(w.stub, "archived");
    await waitFor(async () => (await d1Row(w.workspaceId))?.["archived_at"] != null, 5000, "D1 archived_at");
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO workspaces (id, project_id, user_id, slug, title, branch, base_branch, state, attention, default_agent, pinned, last_activity_at, created_at, summary_rev) VALUES (?, ?, ?, ?, ?, 'tempo/someone-else', 'main', 'ready', 'none', 'claude', 0, ?, ?, 0)",
    )
      .bind(newId(), w.seeded.projectId, w.seeded.userId, w.slug, w.slug, now, now)
      .run();
    expect(codeOf(await w.stub.restoreWorkspace({}))).toBe("OK");
    await driveToState(w.stub, "sleeping");
    // 03 Restore 1: "If only the slug is taken, give the workspace a new slug; keep the branch."
    const row = await wsRow(w.stub);
    expect(row["slug"]).not.toBe(w.slug);
    expect(row["slug"]).toMatch(/^[a-z0-9-]+$/);
    expect(row["branch"]).toBe(w.branch);
    await waitFor(
      async () => {
        const r = await d1Row(w.workspaceId);
        return r?.["slug"] === row["slug"] && r?.["archived_at"] === null;
      },
      5000,
      "D1 slug",
    );
  });
});

describe("revert and commit_push ops", { timeout: 60_000 }, () => {
  /** A ready workspace with an open session, three ended turns and a checkpoint at the end of turn 1. */
  const withHistory = async () => {
    const w = await readyWs();
    const initialId = (await rows(w.stub, "SELECT id FROM sessions"))[0]!["id"];
    const sessionId = newId();
    const closedId = newId();
    await insertSession(w.stub, sessionId);
    await insertSession(w.stub, closedId, "closed");
    const turnIds = [newId(), newId(), newId()];
    for (const [n, id] of turnIds.entries()) await insertTurn(w.stub, id, sessionId, n + 1);
    const c1 = newId();
    await insertCheckpoint(w.stub, c1, turnIds[0]!, "turn_end", Date.now() - MIN);
    w.tempod.on("git.checkpoint", checkpointResult);
    return { ...w, initialId, sessionId, closedId, turnIds, c1 };
  };

  it("takes a pre_revert safety checkpoint, reverts, marks later turns and notes the sessions", async () => {
    const w = await withHistory();
    await exec(w.stub, "UPDATE workspace SET pushed = 1, last_pushed_sha = ?", "9".repeat(40));
    const res = await whileDriving(w.stub, w.stub.revertToCheckpoint({ checkpointId: w.c1 }));
    expect(codeOf(res)).toBe("OK");
    const op = (await opOf(w.stub, "revert"))!;
    expect(op["status"]).toBe("done");
    // 03 Ops and their steps: revert = git.checkpoint (pre_revert) → bundle.upload → git.revert → transcript.mark
    expect(Object.keys(opState(op).timings)).toEqual([
      "git.checkpoint",
      "bundle.upload",
      "git.revert",
      "transcript.mark",
    ]);
    const sent = w.tempod.requests.map((r) => r.op);
    expect(sent.lastIndexOf("git.checkpoint")).toBeLessThan(sent.indexOf("git.revert"));
    // 03 Revert 2: the safety checkpoint (its upload fails here, so it is local_only)
    const safety = await rows(w.stub, "SELECT * FROM checkpoints WHERE reason = 'pre_revert'");
    expect(safety).toHaveLength(1);
    expect(safety[0]!["local_only"]).toBe(1);
    expect(w.tempod.requestsOf("git.checkpoint").at(-1)).toMatchObject({
      reason: "pre_revert",
      checkpointId: safety[0]!["id"],
    });
    // 03 Revert 3
    expect(w.tempod.requestsOf("git.revert")).toEqual([{ checkpointId: w.c1 }]);
    // 03 Revert 4: turns after the checkpoint's turn are reverted; a revert_marker item
    const reverted = await rows(w.stub, "SELECT seq, reverted FROM turns ORDER BY seq");
    expect(reverted.map((t) => [t["seq"], t["reverted"]])).toEqual([
      [1, 0],
      [2, 1],
      [3, 1],
    ]);
    const markers = await rows(
      w.stub,
      "SELECT session_id, content_json FROM items WHERE kind = 'revert_marker'",
    );
    expect(markers.map((marker) => marker["session_id"]).sort()).toEqual([w.initialId, w.sessionId].sort());
    for (const marker of markers)
      expect(JSON.parse(marker["content_json"])).toEqual({ checkpointId: w.c1, toTurnSeq: 1 });
    // 03 Revert 5: exactly this note, for every non-closed session
    expect((await sessionOf(w.stub, w.sessionId))!["pending_note"]).toBe(
      "Note: the user reverted the files to the state after turn 1. Changes made after that point are gone.",
    );
    expect((await sessionOf(w.stub, w.closedId))!["pending_note"]).toBeNull();
    // 03 Revert 6: HEAD (eee…) differs from last_pushed_sha (999…) → force flag
    expect((await wsRow(w.stub))["force_push_lease"]).toBe(1);
    // 03 Step runner: "The user starts revert and commit_push, so they do not change the state"
    expect(await stateOf(w.stub)).toBe("ready");
  });

  it("reuses the durable checkpoint identity after an uncertain daemon response", async () => {
    const w = await withHistory();
    let calls = 0;
    w.tempod.on("git.checkpoint", (params) => {
      if (++calls === 1) throw new Error("acknowledgement lost after checkpoint");
      return checkpointResult(params);
    });
    const res = await whileDriving(w.stub, w.stub.revertToCheckpoint({ checkpointId: w.c1 }));
    expect(codeOf(res)).toBe("OK");
    const requests = w.tempod.requestsOf("git.checkpoint");
    expect(requests).toHaveLength(2);
    expect(requests[0].checkpointId).toBe(requests[1].checkpointId);
    expect(opState(await opOf(w.stub, "revert"))["checkpointRequestId"]).toBe(requests[0].checkpointId);
    expect(await rows(w.stub, "SELECT id FROM checkpoints WHERE reason = 'pre_revert'")).toEqual([
      { id: requests[0].checkpointId },
    ]);
  });

  it("refuses revert when the safety checkpoint fails, keeping files and transcript intact", async () => {
    const w = await withHistory();
    w.tempod.fail("git.checkpoint", "INTERNAL", "checkpoint failed");
    const res = await whileDriving(w.stub, w.stub.revertToCheckpoint({ checkpointId: w.c1 }));
    expect(codeOf(res)).toBe("INTERNAL");
    expect(w.tempod.requestsOf("git.checkpoint")).toHaveLength(3);
    expect(w.tempod.requestsOf("git.revert")).toHaveLength(0);
    expect((await opOf(w.stub, "revert"))!["status"]).toBe("failed");
    expect((await rows(w.stub, "SELECT reverted FROM turns")).every((t) => t["reverted"] === 0)).toBe(true);
    expect(await rows(w.stub, "SELECT id FROM items WHERE kind = 'revert_marker'")).toHaveLength(0);
    expect(await stateOf(w.stub)).toBe("ready");
  });

  it("does not set the force flag when HEAD equals last_pushed_sha or nothing was pushed", async () => {
    const w = await withHistory();
    await exec(w.stub, "UPDATE workspace SET pushed = 1, last_pushed_sha = ?", "e".repeat(40));
    expect(codeOf(await whileDriving(w.stub, w.stub.revertToCheckpoint({ checkpointId: w.c1 })))).toBe("OK");
    expect((await wsRow(w.stub))["force_push_lease"]).toBe(0);

    const u = await withHistory();
    expect(codeOf(await whileDriving(u.stub, u.stub.revertToCheckpoint({ checkpointId: u.c1 })))).toBe("OK");
    expect((await wsRow(u.stub))["force_push_lease"]).toBe(0);
  });

  it("a failing git.revert is not retried, returns INTERNAL and keeps the safety checkpoint; nothing is marked", async () => {
    const w = await withHistory();
    w.tempod.fail("git.revert", "INTERNAL", "read-tree failed");
    const res = await whileDriving(w.stub, w.stub.revertToCheckpoint({ checkpointId: w.c1 }));
    // 03 Step limits: git.revert | 2 min | 1 | INTERNAL; the safety checkpoint is kept
    expect(codeOf(res)).toBe("INTERNAL");
    expect(w.tempod.requestsOf("git.revert")).toHaveLength(1);
    const op = (await opOf(w.stub, "revert"))!;
    expect(op["status"]).toBe("failed");
    expect(op["error_code"]).toBe("INTERNAL");
    expect(await rows(w.stub, "SELECT id FROM checkpoints WHERE reason = 'pre_revert'")).toHaveLength(1);
    expect((await rows(w.stub, "SELECT reverted FROM turns")).every((t) => t["reverted"] === 0)).toBe(true);
    expect(await rows(w.stub, "SELECT id FROM items WHERE kind = 'revert_marker'")).toHaveLength(0);
    expect((await sessionOf(w.stub, w.sessionId))!["pending_note"]).toBeNull();
    // A user op does not move the workspace to error.
    const row = await wsRow(w.stub);
    expect(row["state"]).toBe("ready");
    expect(row["error_code"]).toBeNull();
  });

  it("reverting to a checkpoint with no turn marks only the turns after the one it holds", async () => {
    // 03 Revert 4: "Mark every turn with seq greater than the checkpoint's turn as reverted = 1." A pre_sleep or sigterm
    // checkpoint has no turn_id: it holds the turn that points at it (an unchanged turn_end), else the last turn ended before it.
    const w = await withHistory();
    const base = Date.now() - 10 * MIN;
    for (const [n, id] of w.turnIds.entries())
      await exec(w.stub, "UPDATE turns SET ended_at = ? WHERE id = ?", base + (n + 1) * MIN, id);
    const pointed = newId();
    await insertCheckpoint(w.stub, pointed, null, "pre_sleep", base + 2 * MIN + 1000);
    await exec(w.stub, "UPDATE turns SET checkpoint_id = ? WHERE id = ?", pointed, w.turnIds[2]!);
    const between = newId();
    await insertCheckpoint(w.stub, between, null, "sigterm", base + 2 * MIN + 2000);

    expect(codeOf(await whileDriving(w.stub, w.stub.revertToCheckpoint({ checkpointId: pointed })))).toBe(
      "OK",
    );
    expect((await rows(w.stub, "SELECT reverted FROM turns ORDER BY seq")).map((t) => t["reverted"])).toEqual(
      [0, 0, 0],
    );
    expect((await sessionOf(w.stub, w.sessionId))!["pending_note"]).toBe(
      "Note: the user reverted the files to the state after turn 3. Changes made after that point are gone.",
    );

    expect(codeOf(await whileDriving(w.stub, w.stub.revertToCheckpoint({ checkpointId: between })))).toBe(
      "OK",
    );
    expect((await rows(w.stub, "SELECT reverted FROM turns ORDER BY seq")).map((t) => t["reverted"])).toEqual(
      [0, 0, 1],
    );
    const markers = (
      await rows(
        w.stub,
        "SELECT content_json FROM items WHERE kind = 'revert_marker' AND session_id = ? ORDER BY rev",
        w.sessionId,
      )
    ).map((r) => JSON.parse(r["content_json"]));
    expect(markers).toEqual([
      { checkpointId: pointed, toTurnSeq: 3 },
      { checkpointId: between, toTurnSeq: 2 },
    ]);
  });

  it("commit_push pushes with --force-with-lease=<last_pushed_sha> when the flag is set, then clears it", async () => {
    const w = await readyWs();
    await exec(
      w.stub,
      "UPDATE workspace SET pushed = 1, last_pushed_sha = ?, force_push_lease = 1",
      "9".repeat(40),
    );
    const res = await whileDriving(w.stub, w.stub.commitAndPush({ message: "After revert" }));
    expect(ok(res)).toEqual({ commitSha: "f".repeat(40) });
    // 03 Commit and push 3-4
    expect(w.tempod.requestsOf("git.commitAndPush")).toEqual([
      { message: "After revert", branch: w.branch, forceWithLeaseSha: "9".repeat(40) },
    ]);
    const row = await wsRow(w.stub);
    expect(row["force_push_lease"]).toBe(0);
    expect(row["last_pushed_sha"]).toBe("f".repeat(40));
    expect(row["pushed"]).toBe(1);
    const op = (await opOf(w.stub, "commit_push"))!;
    expect(op["status"]).toBe("done");
    expect(Object.keys(opState(op).timings)).toEqual(["git.commitAndPush"]);
  });

  it("a rejected push keeps the force flag and last_pushed_sha, and is not retried", async () => {
    const w = await readyWs();
    await exec(
      w.stub,
      "UPDATE workspace SET pushed = 1, last_pushed_sha = ?, force_push_lease = 1",
      "9".repeat(40),
    );
    w.tempod.fail("git.commitAndPush", "PUSH_REJECTED", "stale info");
    const res = await whileDriving(w.stub, w.stub.commitAndPush({ message: "Try" }));
    expect(codeOf(res)).toBe("PUSH_REJECTED");
    // 03 Step limits: git.commitAndPush | 5 min | 1 | PUSH_REJECTED or INTERNAL
    expect(w.tempod.requestsOf("git.commitAndPush")).toHaveLength(1);
    const row = await wsRow(w.stub);
    expect(row["force_push_lease"]).toBe(1);
    expect(row["last_pushed_sha"]).toBe("9".repeat(40));
    expect(row["state"]).toBe("ready");
  });

  it("any other push failure is INTERNAL", async () => {
    const w = await readyWs();
    w.tempod.fail("git.commitAndPush", "INTERNAL", "disk full");
    const res = await whileDriving(w.stub, w.stub.commitAndPush({ message: "Try" }));
    expect(codeOf(res)).toBe("INTERNAL");
    expect((await opOf(w.stub, "commit_push"))!["error_code"]).toBe("INTERNAL");
    expect(await stateOf(w.stub)).toBe("ready");
  });
});

describe("step runner rules", { timeout: 60_000 }, () => {
  it("runs one op at a time, in creation order", async () => {
    const w = await readyWs();
    w.tempod.on("git.commitAndPush", async () => {
      await sleep(1500);
      return { commitSha: "f".repeat(40) };
    });
    await runInDurableObject(w.stub, (i: WorkspaceDO) => {
      const runner = internals(i).runner;
      runner.insert("commit_push", { message: "first" });
      runner.insert("sleep");
    });
    void runDurableObjectAlarm(w.stub).catch(() => undefined);
    await waitFor(() => w.tempod.requestsOf("git.commitAndPush").length === 1, 5000, "commit sent");
    // 03 Step runner: "At most one op is running at a time. Ops wait as pending and start in creation order."
    const during = await w.stub.listOps();
    expect(during.find((o) => o.kind === "commit_push")).toMatchObject({
      status: "running",
      step: "git.commitAndPush",
    });
    expect(during.find((o) => o.kind === "sleep")).toMatchObject({ status: "pending", step: "turns.check" });
    expect(during.filter((o) => o.status === "running")).toHaveLength(1);
    await driveToState(w.stub, "sleeping");
    const sent = w.tempod.requests.map((r) => r.op);
    expect(sent.indexOf("git.commitAndPush")).toBeLessThan(sent.lastIndexOf("git.checkpoint"));
    const commit = (await opOf(w.stub, "commit_push"))!;
    expect(commit["status"]).toBe("done");
    // Timings record the step's real duration.
    expect(opState(commit).timings["git.commitAndPush"]).toBeGreaterThanOrEqual(1000);
  });

  it("aborts a step at its timeout, counts it as a failed attempt and records the time spent", async () => {
    // The real settings.read timeout is 10 s; a short one keeps the test fast.
    const original = STEP_LIMITS["settings.read"]!;
    STEP_LIMITS["settings.read"] = { ...original, timeoutMs: 300 };
    try {
      const w = await seedWs({ prepare: (t) => t.on("settings.read", () => new Promise(() => undefined)) });
      await driveToState(w.stub, "ready");
      await driveOp(w.stub, "create", "done");
      // 03 Step runner: "runs its current step with an AbortSignal that fires at the step's timeout"
      expect(w.tempod.requestsOf("settings.read")).toHaveLength(3);
      const op = (await opOf(w.stub, "create"))!;
      expect(op["error_code"]).toBe("TEMPOD_TIMEOUT");
      expect(opState(op).skipped).toEqual(["settings.read"]);
      expect(opState(op).timings["settings.read"]).toBeGreaterThanOrEqual(600);
    } finally {
      STEP_LIMITS["settings.read"] = original;
    }
  });

  it("recovery after a DO restart: a running op that waits goes back to pending and its step runs again without repeating work", async () => {
    const w = await seedWs({ effective: settingsWith({ scripts: { setup: "npm ci" } }) });
    await drive(w.stub, async () => w.tempod.requestsOf("script.start").length === 1, "setup start");
    await waitFor(
      async () => opState(await opOf(w.stub, "create")).waiting?.step === "setup.run",
      5000,
      "waiting",
    );
    const after = await runInDurableObject(w.stub, (i: WorkspaceDO, state: DurableObjectState) => {
      internals(i).runner.recover();
      return {
        op: state.storage.sql.exec("SELECT * FROM ops WHERE kind = 'create'").one() as Row,
        now: Date.now(),
      };
    });
    // 03 Step runner: "every op with status running goes back to pending with next_run_at = now"
    expect(after.op["status"]).toBe("pending");
    expect(after.op["step"]).toBe("setup.run");
    expect(after.op["next_run_at"]).toBeLessThanOrEqual(after.now);
    expect(opState(after.op).waiting).toBeUndefined();
    // "Its step runs again." setup.run is idempotent: it waits on the same run.
    await runDurableObjectAlarm(w.stub);
    await waitFor(
      async () => opState(await opOf(w.stub, "create")).waiting?.step === "setup.run",
      5000,
      "waiting again",
    );
    expect((await opOf(w.stub, "create"))!["status"]).toBe("running");
    expect(w.tempod.requestsOf("script.start")).toHaveLength(1);
    await emit(w, {
      kind: "script.exited",
      runId: w.tempod.requestsOf("script.start")[0].runId,
      exitCode: 0,
      signal: null,
      timedOut: false,
    });
    await waitFor(async () => (await opOf(w.stub, "create"))?.["status"] === "done", 5000, "create done");
    expect((await wsRow(w.stub))["setup_status"]).toBe("succeeded");
    expect(await stateOf(w.stub)).toBe("ready");
  });

  it("a step's timing includes the time it waited for its event, whether the event came or the wait timed out", async () => {
    // 05 Observability: "Each op stores its step timings in ops.state_json". setup.run lasts until script.exited.
    const w = await seedWs({ effective: settingsWith({ scripts: { setup: "npm ci" } }) });
    await drive(w.stub, async () => w.tempod.requestsOf("script.start").length === 1, "setup start");
    await waitFor(
      async () => opState(await opOf(w.stub, "create")).waiting?.step === "setup.run",
      5000,
      "waiting",
    );
    await exec(w.stub, "UPDATE ops SET updated_at = ? WHERE kind = 'create'", Date.now() - 5000);
    await emit(w, {
      kind: "script.exited",
      runId: w.tempod.requestsOf("script.start")[0].runId,
      exitCode: 0,
      signal: null,
      timedOut: false,
    });
    await waitFor(async () => (await opOf(w.stub, "create"))?.["status"] === "done", 5000, "create done");
    expect(opState(await opOf(w.stub, "create")).timings["setup.run"]).toBeGreaterThanOrEqual(5000);

    const t = await seedWs({ effective: settingsWith({ scripts: { setup: "npm ci" } }) });
    await drive(t.stub, async () => t.tempod.requestsOf("script.start").length === 1, "setup start");
    await waitFor(
      async () => opState(await opOf(t.stub, "create")).waiting?.step === "setup.run",
      5000,
      "waiting",
    );
    await exec(
      t.stub,
      "UPDATE ops SET updated_at = ?, state_json = json_set(state_json, '$.waiting.deadline', 1) WHERE kind = 'create'",
      Date.now() - 7000,
    );
    await runDurableObjectAlarm(t.stub);
    await waitFor(async () => (await opOf(t.stub, "create"))?.["status"] === "done", 5000, "create done");
    expect(opState(await opOf(t.stub, "create")).timings["setup.run"]).toBeGreaterThanOrEqual(7000);
  });

  it("WorkspaceDetail.op is the next pending op, even when the housekeeping op was made first", async () => {
    // 02 OpProgress: "WorkspaceDetail.op is the running op, else the next pending op, else null." Housekeeping is never shown.
    const w = await readyWs();
    expect((await detail(w.stub)).op).toBeNull();
    await runInDurableObject(w.stub, (i: WorkspaceDO) => {
      internals(i).runner.insert("commit_push", { message: "later" }, Date.now() + HOUR);
    });
    expect((await detail(w.stub)).op).toMatchObject({
      kind: "commit_push",
      status: "pending",
      step: "git.commitAndPush",
    });
  });

  it("recovery after a DO restart: a running op in backoff becomes due now and reruns its step", async () => {
    let clones = 0;
    const w = await seedWs({
      prepare: (t) =>
        t.on("repo.clone", () => {
          clones++;
          if (clones === 1) throw new Error("connection reset");
          return { headSha: "a".repeat(40), remoteHeadSha: null };
        }),
    });
    await waitFor(async () => (await opOf(w.stub, "create"))?.["attempt"] === 1, 5000, "first clone failed");
    const after = await runInDurableObject(w.stub, (i: WorkspaceDO, state: DurableObjectState) => {
      const before = state.storage.sql.exec("SELECT * FROM ops WHERE kind = 'create'").one() as Row;
      internals(i).runner.recover();
      return {
        before,
        op: state.storage.sql.exec("SELECT * FROM ops WHERE kind = 'create'").one() as Row,
        now: Date.now(),
      };
    });
    expect(after.before).toMatchObject({ status: "running", step: "repo.clone" });
    expect(after.before["next_run_at"]).toBeGreaterThan(after.now);
    expect(after.op).toMatchObject({ status: "pending", step: "repo.clone" });
    expect(after.op["next_run_at"]).toBeLessThanOrEqual(after.now);
    await drive(w.stub, async () => (await stateOf(w.stub)) === "ready", "ready", { fast: false });
    expect(clones).toBe(2);
    expect((await opOf(w.stub, "create"))!["status"]).toBe("done");
  });
});

describe("tempod reconnect during a create or wake op", { timeout: 60_000 }, () => {
  const withSetup = () => settingsWith({ scripts: { setup: "npm ci" } });
  const waitingOnSetup = async (w: Ws) => {
    await drive(w.stub, async () => w.tempod.requestsOf("script.start").length === 1, "setup start");
    await waitFor(
      async () => opState(await opOf(w.stub, "create")).waiting?.step === "setup.run",
      5000,
      "waiting",
    );
  };
  const finishSetup = async (w: Ws, n = 0) => {
    await emit(w, {
      kind: "script.exited",
      runId: w.tempod.requestsOf("script.start")[n].runId,
      exitCode: 0,
      signal: null,
      timedOut: false,
    });
  };

  it("after a DO restart with the socket gone, setup.run runs again, reconnects and still gets script.exited", async () => {
    // 03 Failure handling: "DO restarts during an op | running op back to pending; its step runs again" and
    // "The DO reconnects with workspace.tempod_token." script.exited only arrives over the socket.
    const w = await seedWs({ effective: withSetup() });
    await waitingOnSetup(w);
    const token = (await wsRow(w.stub))["tempod_token"];
    await dropSocketSilently(w);
    await runInDurableObject(w.stub, (i: WorkspaceDO) => internals(i).runner.recover());
    await runDurableObjectAlarm(w.stub);
    await waitFor(() => w.tempod.hellos.length === 2, 5000, "reconnect hello");
    expect((await wsRow(w.stub))["tempod_token"]).toBe(token);
    await waitFor(
      async () => opState(await opOf(w.stub, "create")).waiting?.step === "setup.run",
      5000,
      "waiting again",
    );
    expect(w.tempod.requestsOf("script.start")).toHaveLength(1);
    expect(w.container.starts).toHaveLength(1);
    await finishSetup(w);
    await waitFor(async () => (await opOf(w.stub, "create"))?.["status"] === "done", 5000, "create done");
    expect(await wsRow(w.stub)).toMatchObject({ state: "ready", setup_status: "succeeded" });
  });

  it("a socket that closes during repo.clone is reconnected by the next attempt instead of failing with CLONE_FAILED", async () => {
    // 03 Failure handling: "tempod socket closes while the container runs | Reconnect up to 5 times".
    let clones = 0;
    const w = await seedWs({
      prepare: (t) =>
        t.on("repo.clone", () => {
          clones++;
          if (clones === 1) {
            t.close(1011);
            return new Promise(() => undefined);
          }
          return { headSha: "a".repeat(40), remoteHeadSha: null };
        }),
    });
    await driveToState(w.stub, "ready");
    await driveOp(w.stub, "create", "done");
    expect(clones).toBe(2);
    expect(w.tempod.hellos.length).toBeGreaterThanOrEqual(2);
    expect(w.container.starts).toHaveLength(1);
    expect((await wsRow(w.stub))["error_code"]).toBeNull();
  });

  it("the heartbeat reconnects a lost socket while a create op waits on setup.run", async () => {
    // 03 Step runner: "Heartbeat ... checks ctx.container.running and that the tempod socket is open."
    const w = await seedWs({ effective: withSetup() });
    await waitingOnSetup(w);
    await dropSocketSilently(w);
    await runInDurableObject(w.stub, async (i: WorkspaceDO) => {
      await (i as unknown as { heartbeat(): Promise<void> }).heartbeat();
    });
    await waitFor(() => w.tempod.hellos.length === 2, 5000, "reconnect hello");
    await waitFor(
      async () => runInDurableObject(w.stub, (i: WorkspaceDO) => internals(i).core.tempod?.open ?? false),
      3000,
      "socket open",
    );
    await finishSetup(w);
    await waitFor(async () => (await opOf(w.stub, "create"))?.["status"] === "done", 5000, "create done");
    expect(await stateOf(w.stub)).toBe("ready");
  });

  it("when every reconnect fails, the op waiting on setup.run is cancelled and a wake restarts the container", async () => {
    // 03 Failure handling: "Reconnect up to 5 times (1, 2, 4, 8, 16 s). Then destroy() and wake."
    const w = await seedWs({ effective: withSetup() });
    await waitingOnSetup(w);
    await runInDurableObject(w.stub, (i: WorkspaceDO) => {
      internals(i).core.reconnectAttempt = 5;
    });
    await runInDurableObject(w.stub, () => w.tempod.close(1011));
    await waitFor(
      async () => (await opOf(w.stub, "create"))?.["status"] === "cancelled",
      5000,
      "create cancelled",
    );
    expect(w.container.destroyed).toBe(1);
    expect(await opsOf(w.stub, "wake")).toHaveLength(1);
    await drive(
      w.stub,
      async () => w.tempod.requestsOf("script.start").length === 2,
      "setup runs again after the wake",
    );
    await waitFor(
      async () => opState(await opOf(w.stub, "wake")).waiting?.step === "setup.run",
      5000,
      "wake waiting",
    );
    await finishSetup(w, 1);
    await waitFor(async () => (await opOf(w.stub, "wake"))?.["status"] === "done", 5000, "wake done");
    expect(await stateOf(w.stub)).toBe("ready");
    expect(w.container.starts).toHaveLength(2);
  });
});

describe("container stops during a create or wake op", { timeout: 60_000 }, () => {
  /** repo.clone stops the container on its first call, the way an out-of-memory kill would. */
  const stopOnFirstClone = (remoteHeadSha: string | null) => (t: FakeTempod, c: FakeContainer) => {
    let clones = 0;
    t.on("repo.clone", () => {
      clones++;
      if (clones === 1) {
        c.running = false;
        t.close(1011);
        return new Promise(() => undefined);
      }
      return { headSha: "a".repeat(40), remoteHeadSha };
    });
  };

  it("a stop during repo.clone cancels the create and a wake restarts it, still cloning like the create", async () => {
    const w = await seedWs({
      source: { kind: "branch" },
      branch: "feature/stop",
      prepare: stopOnFirstClone("7".repeat(40)),
    });
    await driveToState(w.stub, "ready");
    await driveOp(w.stub, "wake", "done");
    // 03 Transitions: "ready, working, setting_up | Container stopped without Tempo asking | starting | wake"
    expect((await opOf(w.stub, "create"))!["status"]).toBe("cancelled");
    expect(w.states).toEqual(["starting", "setting_up", "starting", "setting_up", "ready"]);
    expect(w.container.starts).toHaveLength(2);
    // 03 Unplanned restarts: tracked in workspace.auto_restarts_json.
    expect(JSON.parse((await wsRow(w.stub))["auto_restarts_json"])).toHaveLength(1);
    expect(w.tempod.requestsOf("repo.clone").map((r) => r.mode)).toEqual(["create", "create"]);
    expect(await wsRow(w.stub)).toMatchObject({
      pushed: 1,
      last_pushed_sha: "7".repeat(40),
      error_code: null,
    });
  });

  it("the 4th unplanned stop within an hour during a create step goes to error / CONTAINER_START_FAILED", async () => {
    const now = Date.now();
    const w = await seedWs({ prepare: stopOnFirstClone(null) });
    await exec(
      w.stub,
      "UPDATE workspace SET auto_restarts_json = ?",
      JSON.stringify([now - 50 * MIN, now - 30 * MIN, now - 10 * MIN]),
    );
    await driveToState(w.stub, "error");
    // 03 Unplanned restarts: "At most 3 in any 60 minutes ... The 4th goes to error with CONTAINER_START_FAILED."
    expect((await wsRow(w.stub))["error_code"]).toBe("CONTAINER_START_FAILED");
    expect(await opsOf(w.stub, "wake")).toHaveLength(0);
    expect(w.container.starts).toHaveLength(1);
  });

  it("the heartbeat sees a stop while a create step waits for its retry, cancels the op and wakes", async () => {
    const w = await seedWs({ prepare: (t) => t.fail("settings.read", "INTERNAL", "busy") });
    await drive(
      w.stub,
      async () => {
        const op = await opOf(w.stub, "create");
        return op?.["step"] === "settings.read" && op["attempt"] >= 1;
      },
      "settings.read in backoff",
      { fast: false },
    );
    w.container.running = false;
    await runInDurableObject(w.stub, async (i: WorkspaceDO) => {
      await (i as unknown as { heartbeat(): Promise<void> }).heartbeat();
    });
    expect((await opOf(w.stub, "create"))!["status"]).toBe("cancelled");
    expect(await stateOf(w.stub)).toBe("starting");
    expect(await opsOf(w.stub, "wake")).toHaveLength(1);
    w.tempod.failures.delete("settings.read");
    await driveToState(w.stub, "ready");
    expect(w.container.starts).toHaveLength(2);
  });
});

describe("housekeeping op", { timeout: 60_000 }, () => {
  it("prunes events older than 7 days, trims egress_log to the newest 10,000 rows and schedules the next run", async () => {
    const w = await readyWs();
    const now = Date.now();
    await exec(
      w.stub,
      "INSERT INTO events (incarnation, seq, kind, payload_json, received_at) VALUES ('hk', 1, 'log', '{}', ?), ('hk', 2, 'log', '{}', ?), ('hk', 3, 'log', '{}', ?), ('hk', 4, 'log', '{}', ?)",
      now - 8 * DAY,
      now - 7 * DAY - MIN,
      now - 6 * DAY,
      now - HOUR,
    );
    await exec(w.stub, "DELETE FROM egress_log");
    await exec(
      w.stub,
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10005) INSERT INTO egress_log (ts, method, host, path, status, ms, rule) SELECT i, 'GET', 'example.com', '/' || i, 200, 1, 9 FROM n",
    );
    expect((await one(w.stub, "SELECT count(*) AS n FROM egress_log"))!["n"]).toBe(10_005);
    await exec(w.stub, "UPDATE ops SET next_run_at = 0 WHERE kind = 'housekeeping' AND status = 'pending'");
    await runDurableObjectAlarm(w.stub);
    await waitFor(
      async () => (await opsOf(w.stub, "housekeeping"))[0]?.["status"] === "done",
      5000,
      "housekeeping done",
    );
    const done = (await opsOf(w.stub, "housekeeping"))[0]!;
    expect(Object.keys(opState(done).timings)).toEqual(["events.prune", "r2.retention", "egress.trim"]);
    // 02 Rules: "Delete events rows older than 7 days in the daily housekeeping op."
    const left = await rows(w.stub, "SELECT seq FROM events WHERE incarnation = 'hk' ORDER BY seq");
    expect(left.map((r) => r["seq"])).toEqual([3, 4]);
    // 02 egress_log: "Newest 10,000 rows only."
    const egress = (await one(w.stub, "SELECT count(*) AS n, min(ts) AS lo, max(ts) AS hi FROM egress_log"))!;
    expect(egress).toMatchObject({ n: 10_000, lo: 6, hi: 10_005 });
    // 03 Step runner: "Housekeeping: once every 24 hours."
    const next = (await opsOf(w.stub, "housekeeping")).filter((o) => o["status"] === "pending");
    expect(next).toHaveLength(1);
    expect(next[0]!["next_run_at"] - next[0]!["created_at"]).toBe(DAY);
  });

  it("r2.retention keeps the newest 20 bundles, the newest 3 home backups and script logs for 30 days", async () => {
    const w = await readyWs();
    const now = Date.now();
    const ckpts: string[] = [];
    for (let n = 0; n < 22; n++) {
      const id = newId();
      ckpts.push(id);
      const key = `checkpoints/${w.workspaceId}/${id}.bundle`;
      await env.DATA.put(key, "b");
      await insertCheckpoint(w.stub, id, null, "pre_sleep", now - (30 - n) * MIN);
      await exec(w.stub, "UPDATE checkpoints SET r2_key = ? WHERE id = ?", key, id);
    }
    const homes: string[] = [];
    for (let n = 0; n < 5; n++) {
      const id = `rec${n}`;
      homes.push(id);
      await env.DATA.put(`homes/${w.workspaceId}/${id}.tar.zst`, "h");
      await exec(
        w.stub,
        "INSERT INTO home_backups (id, record_json, size_bytes, created_at) VALUES (?, ?, 1, ?)",
        id,
        JSON.stringify({ id, dir: "/home/tempo", size: 1, sha256: "0".repeat(64), format: 1 }),
        now - (10 - n) * MIN,
      );
    }
    for (const [id, age] of [
      ["oldlog", 31 * DAY],
      ["newlog", DAY],
    ] as const) {
      const key = `logs/${w.workspaceId}/${id}.log`;
      await env.DATA.put(key, "log");
      await exec(
        w.stub,
        "INSERT INTO script_runs (id, kind, command, status, log_tail, r2_key, started_at, ended_at) VALUES (?, 'run', 'x', 'exited', '', ?, ?, ?)",
        id,
        key,
        now - age,
        now - age,
      );
    }
    await exec(w.stub, "UPDATE ops SET next_run_at = 0 WHERE kind = 'housekeeping' AND status = 'pending'");
    await runDurableObjectAlarm(w.stub);
    await waitFor(
      async () => (await opsOf(w.stub, "housekeeping"))[0]?.["status"] === "done",
      5000,
      "housekeeping done",
    );
    // 02 R2 layout: checkpoints "Newest 20 per workspace"
    for (const [n, id] of ckpts.entries()) {
      const key = `checkpoints/${w.workspaceId}/${id}.bundle`;
      const row = (await one(w.stub, "SELECT r2_key FROM checkpoints WHERE id = ?", id))!;
      if (n < 2) {
        expect(await env.DATA.head(key), `bundle ${n}`).toBeNull();
        expect(row["r2_key"]).toBeNull();
      } else {
        expect(await env.DATA.head(key), `bundle ${n}`).not.toBeNull();
        expect(row["r2_key"]).toBe(key);
      }
    }
    // homes: "Newest 3 per workspace"
    expect(
      (await rows(w.stub, "SELECT id FROM home_backups ORDER BY created_at")).map((r) => r["id"]),
    ).toEqual(homes.slice(2));
    for (const [n, id] of homes.entries()) {
      const head = await env.DATA.head(`homes/${w.workspaceId}/${id}.tar.zst`);
      if (n < 2) expect(head, id).toBeNull();
      else expect(head, id).not.toBeNull();
    }
    // logs: "30 days"
    expect(await env.DATA.head(`logs/${w.workspaceId}/oldlog.log`)).toBeNull();
    expect(await env.DATA.head(`logs/${w.workspaceId}/newlog.log`)).not.toBeNull();
    expect((await one(w.stub, "SELECT r2_key FROM script_runs WHERE id = 'oldlog'"))!["r2_key"]).toBeNull();
  });

  it("starts only when no other op is pending", async () => {
    const w = await readyWs();
    await exec(
      w.stub,
      "INSERT INTO events (incarnation, seq, kind, payload_json, received_at) VALUES ('hk2', 1, 'log', '{}', ?)",
      Date.now() - 30 * DAY,
    );
    const blocker = await runInDurableObject(
      w.stub,
      (i: WorkspaceDO) =>
        internals(i).runner.insert("commit_push", { message: "later" }, Date.now() + HOUR).id,
    );
    await exec(w.stub, "UPDATE ops SET next_run_at = 0 WHERE kind = 'housekeeping' AND status = 'pending'");
    await runDurableObjectAlarm(w.stub);
    await sleep(150);
    await runDurableObjectAlarm(w.stub);
    // 03 Step runner: "housekeeping starts only when no other op is pending."
    expect((await opsOf(w.stub, "housekeeping"))[0]!["status"]).toBe("pending");
    expect(await rows(w.stub, "SELECT id FROM events WHERE incarnation = 'hk2'")).toHaveLength(1);
    await exec(w.stub, "UPDATE ops SET status = 'cancelled' WHERE id = ?", blocker);
    await runDurableObjectAlarm(w.stub);
    await waitFor(
      async () => (await opsOf(w.stub, "housekeeping"))[0]?.["status"] === "done",
      5000,
      "housekeeping done",
    );
    expect(await rows(w.stub, "SELECT id FROM events WHERE incarnation = 'hk2'")).toHaveLength(0);
    expect(w.tempod.requestsOf("git.commitAndPush")).toHaveLength(0);
  });
});

describe("unplanned container stop", { timeout: 60_000 }, () => {
  const heartbeat = (w: Ws) =>
    runInDurableObject(w.stub, async (i: WorkspaceDO, state: DurableObjectState) => {
      await (i as unknown as { heartbeat(): Promise<void> }).heartbeat();
      return {
        row: state.storage.sql.exec("SELECT * FROM workspace WHERE id = 1").one() as Row,
        wake: state.storage.sql.exec("SELECT * FROM ops WHERE kind = 'wake'").toArray() as Row[],
      };
    });

  const workingWs = async () => {
    const w = await readyWs({ prompt: "Long task", credentials: true });
    await waitFor(() => w.tempod.requestsOf("session.prompt").length === 1, 5000, "first prompt");
    const p = w.tempod.requestsOf("session.prompt")[0];
    await waitFor(
      async () => (await turnOf(w.stub, p.turnId))?.["status"] === "running",
      5000,
      "turn running",
    );
    return { ...w, sessionId: p.sessionId as string, turnId: p.turnId as string };
  };

  it("the heartbeat sees running = false: the turn is interrupted with a notice, and a wake op restarts the container", async () => {
    const w = await workingWs();
    await runInDurableObject(w.stub, (i: WorkspaceDO) => {
      (i as unknown as { lastHeartbeat: number }).lastHeartbeat = 0;
    });
    w.container.running = false;
    await runDurableObjectAlarm(w.stub);
    // 03 Failure handling: "Container stops on its own | Heartbeat sees running = false |
    // Running turn becomes interrupted; notice item; wake, within the 3-per-hour limit"
    await waitFor(
      async () => (await turnOf(w.stub, w.turnId))?.["status"] === "interrupted",
      5000,
      "turn interrupted",
    );
    const notices = await rows(
      w.stub,
      "SELECT session_id, turn_id, content_json FROM items WHERE kind = 'notice'",
    );
    expect(
      notices.some(
        (n) =>
          n["session_id"] === w.sessionId &&
          n["turn_id"] === w.turnId &&
          JSON.parse(n["content_json"]).level === "warning",
      ),
    ).toBe(true);
    expect(await opsOf(w.stub, "wake")).toHaveLength(1);
    expect(JSON.parse((await wsRow(w.stub))["auto_restarts_json"])).toHaveLength(1);
    // 03 Transitions: working → starting (container stopped without Tempo asking)
    expect(w.states).toContain("starting");
    await driveToState(w.stub, "ready");
    await driveOp(w.stub, "wake", "done");
    expect(w.container.starts).toHaveLength(2);
    expect(w.container.running).toBe(true);
    expect((await wsRow(w.stub))["tempod_token"]).not.toBeNull();
  });

  // Regression (fixed): WorkspaceDO.heartbeat (src/do/workspace/index.ts:405) returns early while a create or wake op is
  // pending or running. setting_up only exists while such an op waits on setup.run, so the spec's
  // setting_up → starting transition can never happen: the workspace sits in setting_up until the 31-minute
  // setup.run deadline, then goes to ready with a dead container before a later heartbeat wakes it.
  it("a container that stops during setup (setting_up) is detected by the heartbeat and woken", async () => {
    const w = await seedWs({ effective: settingsWith({ scripts: { setup: "npm ci" } }) });
    await drive(w.stub, async () => w.tempod.requestsOf("script.start").length === 1, "setup start");
    await waitFor(
      async () => opState(await opOf(w.stub, "create")).waiting?.step === "setup.run",
      5000,
      "waiting",
    );
    expect(await stateOf(w.stub)).toBe("setting_up");
    w.container.running = false;
    const { row } = await heartbeat(w);
    // 03 Transitions: "ready, working, setting_up | Container stopped without Tempo asking | starting | wake"
    // 03 Step runner: "Heartbeat: every 30 s while the container runs. It checks ctx.container.running"
    expect(row["state"]).toBe("starting");
    await driveToState(w.stub, "setting_up", "ready");
    expect(w.container.starts).toHaveLength(2);
  });

  it("after a SIGTERM and a restart, a later interrupted turn ends normally and the state returns to ready", async () => {
    const w = await workingWs();
    await emit(w, { kind: "tempod.stopping", reason: "sigterm" });
    await waitFor(() => w.tempod.requestsOf("shutdown").length === 1, 5000, "shutdown");
    expect(await runInDurableObject(w.stub, (i: WorkspaceDO) => internals(i).core.tempodStopping)).toBe(true);
    // 03 Failure handling: "When the container stops, the row above applies."
    w.container.running = false;
    await heartbeat(w);
    await driveToState(w.stub, "ready");
    await driveOp(w.stub, "wake", "done");
    expect(await runInDurableObject(w.stub, (i: WorkspaceDO) => internals(i).core.tempodStopping)).toBe(
      false,
    );
    const turn = ok(
      await w.stub.sendPrompt({
        sessionId: w.sessionId,
        text: "Again",
        mentions: [],
        attachmentIds: [],
        reviewCommentIds: [],
      }),
    ) as { id: string };
    await waitFor(
      async () => (await turnOf(w.stub, turn.id))?.["status"] === "running",
      5000,
      "turn running",
    );
    const checkpoints = w.tempod.requestsOf("git.checkpoint").length;
    await emit(w, {
      kind: "turn.ended",
      sessionId: w.sessionId,
      turnId: turn.id,
      stopReason: "cancelled",
      interrupted: true,
    });
    // 03 turn.ended: checkpoint, then the queue runner; with nothing queued the state goes back to ready.
    await waitFor(async () => (await stateOf(w.stub)) === "ready", 5000, "ready");
    expect((await turnOf(w.stub, turn.id))!["status"]).toBe("interrupted");
    expect(w.tempod.requestsOf("git.checkpoint").length).toBe(checkpoints + 1);
  });

  it("the 4th unplanned restart within an hour goes to error / CONTAINER_START_FAILED instead of waking", async () => {
    const w = await workingWs();
    const now = Date.now();
    await exec(
      w.stub,
      "UPDATE workspace SET auto_restarts_json = ?",
      JSON.stringify([now - 50 * MIN, now - 30 * MIN, now - 10 * MIN]),
    );
    w.container.running = false;
    const { row, wake } = await heartbeat(w);
    // 03 Unplanned restarts: "At most 3 in any 60 minutes ... The 4th goes to error with CONTAINER_START_FAILED."
    expect(row["state"]).toBe("error");
    expect(row["error_code"]).toBe("CONTAINER_START_FAILED");
    expect(wake).toHaveLength(0);
    expect((await turnOf(w.stub, w.turnId))!["status"]).toBe("interrupted");
    await sleep(100);
    expect(w.container.starts).toHaveLength(1);
    await waitFor(async () => (await d1Row(w.workspaceId))?.["state"] === "error", 5000, "D1 error");
  });

  it("restarts older than an hour do not count", async () => {
    const w = await workingWs();
    const now = Date.now();
    await exec(
      w.stub,
      "UPDATE workspace SET auto_restarts_json = ?",
      JSON.stringify([now - 3 * HOUR, now - 2 * HOUR, now - 61 * MIN]),
    );
    w.container.running = false;
    const { row, wake } = await heartbeat(w);
    expect(row["state"]).toBe("starting");
    expect(wake).toHaveLength(1);
    const restarts = JSON.parse(row["auto_restarts_json"]) as number[];
    expect(restarts).toHaveLength(1);
    expect(restarts[0]).toBeGreaterThanOrEqual(now);
    await driveToState(w.stub, "ready");
  });
});

describe("idle check and tempod socket loss", { timeout: 60_000 }, () => {
  const runIdleCheck = (w: Ws) =>
    runInDurableObject(w.stub, (i: WorkspaceDO) => {
      (i as unknown as { lastIdleCheck: number; lastHeartbeat: number }).lastIdleCheck = 0;
      (i as unknown as { lastIdleCheck: number; lastHeartbeat: number }).lastHeartbeat = Date.now();
    }).then(() => runDurableObjectAlarm(w.stub));

  it("sleeps a ready workspace idle for sleep_after_idle_minutes, even with a UI socket open", async () => {
    const w = await readyWs();
    const res = await w.stub.fetch(`https://tempo.test/api/ws/workspace/${w.workspaceId}?sinceRev=0`, {
      headers: { Upgrade: "websocket" },
    });
    const socket = res.webSocket!;
    socket.accept();
    await exec(w.stub, "UPDATE workspace SET last_activity_at = ?", Date.now() - 16 * MIN);
    await runIdleCheck(w);
    // 03 Transitions: ready → stopping when "Idle for sleep_after_idle_minutes"; Activity: "Open UI sockets do not count."
    await waitFor(async () => (await opsOf(w.stub, "sleep")).length === 1, 5000, "sleep op");
    await driveToState(w.stub, "sleeping");
    socket.close(1000, "done");
  });

  it("does not sleep before sleep_after_idle_minutes, or while a run script runs", async () => {
    const w = await readyWs({
      effective: settingsWith({
        scripts: { run: { dev: { command: "bun run dev", cwd: "", default: true } } },
      }),
    });
    await exec(w.stub, "UPDATE workspace SET last_activity_at = ?", Date.now() - 14 * MIN);
    await runIdleCheck(w);
    await sleep(100);
    expect(await opsOf(w.stub, "sleep")).toHaveLength(0);

    ok(await w.stub.runScript({ scriptId: "dev" }));
    await exec(w.stub, "UPDATE workspace SET last_activity_at = ?", Date.now() - 60 * MIN);
    await runInDurableObject(w.stub, (i: WorkspaceDO) =>
      internals(i).core.setKv("lastBusyAt", Date.now() - 60 * MIN),
    );
    await runIdleCheck(w);
    await sleep(100);
    // 03 Activity: "The setup script or a run script is running."
    expect(await opsOf(w.stub, "sleep")).toHaveLength(0);
    expect(await stateOf(w.stub)).toBe("ready");
  });

  it("stopScript on a sleeping workspace answers ok and does not wake it", async () => {
    // 03 Wake triggers: sendPrompt, createSession, a terminal WebSocket, a preview request, wakeWorkspace, rerunSetup,
    // runScript. stopScript is not one: with no container, nothing runs.
    const w = await asleep();
    const starts = w.container.starts.length;
    expect(codeOf(await w.stub.stopScript({ runId: newId() }))).toBe("OK");
    await sleep(100);
    expect(await opsOf(w.stub, "wake")).toHaveLength(0);
    expect(await stateOf(w.stub)).toBe("sleeping");
    expect(w.container.starts).toHaveLength(starts);
  });

  it("reconnects to tempod when its socket closes while the container runs, without a wake", async () => {
    const w = await readyWs();
    expect(w.tempod.hellos).toHaveLength(1);
    await runInDurableObject(w.stub, () => w.tempod.close(1011));
    // 03 Failure handling: "tempod socket closes while the container runs | WebSocket close | Reconnect up to 5 times (1, 2, 4, 8, 16 s)"
    await waitFor(() => w.tempod.hellos.length === 2, 5000, "second hello");
    expect(w.tempod.hellos[1]).toMatchObject({ incarnation: w.tempod.incarnation });
    expect(await stateOf(w.stub)).toBe("ready");
    expect(await opsOf(w.stub, "wake")).toHaveLength(0);
    expect(w.container.starts).toHaveLength(1);
    expect(
      await runInDurableObject(w.stub, (i: WorkspaceDO) => internals(i).core.tempod?.open ?? false),
    ).toBe(true);
  });
});
