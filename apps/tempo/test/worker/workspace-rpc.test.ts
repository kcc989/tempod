import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newId, type AgentId, type TempodEvent } from "@tempo/protocol";
import { github } from "../../src/github/provider.ts";
import { previewCookie } from "../../src/do/workspace/preview.ts";
import type { WorkspaceDO } from "../../src/do/workspace/index.ts";
import {
  DEFAULT_EFFECTIVE,
  FakeTempod,
  OWNER_GITHUB_ID,
  installFakes,
  internals,
  seedCredentials,
  seedProject,
  seedWorkspace,
  waitFor,
  type FakeContainer,
  type Seeded,
} from "./fakes.ts";

/**
 * WorkspaceDO RPC methods (02, Server functions: Workspaces, Sessions and turns, Review and git,
 * Files) and the flows behind them (03, Prompt and turn, Revert, Archive and restore, Commit, push).
 */

type Stub = DurableObjectStub<WorkspaceDO>;
type Res = { readonly ok: boolean };
type ErrorBody = { code: string; message: string; detail?: string };
type Row = Record<string, any>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Unwraps a Result envelope. RPC stubs widen the value types, so tests read values loosely. */
const ok = (r: Res): any => {
  if (!r.ok) {
    const e = (r as unknown as { error: ErrorBody }).error;
    throw new Error(`expected ok, got ${e.code}: ${e.message} ${e.detail ?? ""}`);
  }
  return (r as unknown as { value: unknown }).value;
};
const codeOf = (r: Res): string => (r.ok ? "OK" : (r as unknown as { error: ErrorBody }).error.code);

const ULID = /^[0-9a-hjkmnp-tv-z]{26}$/;
const PREVIEW_KEY = /^[A-Za-z0-9_-]{43}$/;

// ---------- storage helpers ----------

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

const turnOf = (stub: Stub, id: string) => one(stub, "SELECT * FROM turns WHERE id = ?", id);
const sessionOf = (stub: Stub, id: string) => one(stub, "SELECT * FROM sessions WHERE id = ?", id);
const wsRow = async (stub: Stub) => (await one(stub, "SELECT * FROM workspace WHERE id = 1"))!;
const detail = async (stub: Stub) => ok(await stub.getWorkspace({}));
const d1Row = (id: string) => env.DB.prepare("SELECT * FROM workspaces WHERE id = ?").bind(id).first<Row>();
const hubRev = (userId: string, workspaceId: string): Promise<number | null> =>
  runInDurableObject(env.USER_HUB.getByName(userId), (_i: unknown, state: DurableObjectState) => {
    const r = state.storage.sql
      .exec("SELECT rev FROM summaries WHERE workspace_id = ?", workspaceId)
      .toArray();
    return r.length ? Number(r[0]!["rev"]) : null;
  });
const opsOf = async (stub: Stub, kind: string) => (await stub.listOps()).filter((o) => o.kind === kind);

// ---------- driving ----------

const driveUntil = async (
  stub: Stub,
  check: () => Promise<boolean>,
  label: string,
  timeoutMs = 20_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out driving to ${label}`);
    await runDurableObjectAlarm(stub);
    await sleep(25);
  }
};
const stateOf = async (stub: Stub): Promise<string> => (await detail(stub)).state;
const driveToState = (stub: Stub, ...states: string[]) =>
  driveUntil(stub, async () => states.includes(await stateOf(stub)), `state ${states.join("|")}`);

/** Runs alarms while an RPC call that waits on an op (revert, commit_push) is in flight. */
const whileDriving = async (stub: Stub, rpc: PromiseLike<unknown>): Promise<Res> => {
  const call = Promise.resolve(rpc);
  let settled = false;
  void call.then(
    () => (settled = true),
    () => (settled = true),
  );
  const deadline = Date.now() + 20_000;
  while (!settled && Date.now() < deadline) {
    await runDurableObjectAlarm(stub);
    await sleep(25);
  }
  return (await call) as Res;
};

/** The fake tempod's socket belongs to the DO's I/O context, so events are sent from inside it. */
const emit = (w: Ws, event: Record<string, unknown>): Promise<number> =>
  runInDurableObject(w.stub, () => w.tempod.emit(event as unknown as TempodEvent));

// ---------- seeding ----------

interface Ws {
  readonly workspaceId: string;
  readonly stub: Stub;
  readonly tempod: FakeTempod;
  readonly container: FakeContainer;
  readonly seeded: Seeded;
}

const holds: FakeTempod[] = [];
afterEach(() => {
  for (const t of holds.splice(0)) t.healthy = true;
});
/** Keeps the next container start waiting for health, so the workspace stays `starting`. */
const hold = (tempod: FakeTempod) => {
  tempod.healthy = false;
  holds.push(tempod);
};

let counter = 0;
const author = { name: "Owner", email: `${OWNER_GITHUB_ID}+owner@users.noreply.github.com` };

const initInput = (
  w: { workspaceId: string; seeded: Seeded; slug: string; branch: string },
  opts: { prompt?: string; agent?: AgentId } = {},
) => ({
  workspaceId: w.workspaceId,
  projectId: w.seeded.projectId,
  userId: w.seeded.userId,
  slug: w.slug,
  branch: w.branch,
  baseBranch: "main",
  source: { kind: "new" as const },
  defaultAgent: "claude" as const,
  agent: opts.agent ?? "claude",
  prompt: opts.prompt ? { text: opts.prompt } : null,
  author,
  createdAt: Date.now(),
});

const insertD1Workspace = async (
  seeded: Seeded,
  w: { id?: string; slug: string; branch: string; archived?: boolean },
): Promise<string> => {
  const id = w.id ?? newId();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO workspaces (id, project_id, user_id, slug, title, branch, base_branch, state, attention, default_agent, pinned, last_activity_at, created_at, archived_at, summary_rev) VALUES (?, ?, ?, ?, ?, ?, 'main', ?, 'none', 'claude', 0, ?, ?, ?, 0)",
  )
    .bind(
      id,
      seeded.projectId,
      seeded.userId,
      w.slug,
      w.slug,
      w.branch,
      w.archived ? "archived" : w.id ? "creating" : "ready",
      now,
      now,
      w.archived ? now : null,
    )
    .run();
  return id;
};

/**
 * Like seedWorkspace, but the fake tempod never turns healthy: the create op waits in
 * `container.start`, so the state stays `starting` and queued turns stay queued.
 */
const seedHeld = async (
  opts: { prompt?: string; agent?: AgentId; credentials?: boolean } = {},
): Promise<Ws & { slug: string; branch: string; summary: any }> => {
  const seeded = await seedProject();
  if (opts.credentials !== false) await seedCredentials(seeded.userId);
  counter++;
  const workspaceId = newId();
  const slug = `held-${counter}`;
  const branch = `tempo/${slug}`;
  await insertD1Workspace(seeded, { id: workspaceId, slug, branch });
  const stub = env.WORKSPACE.getByName(workspaceId);
  const tempod = new FakeTempod();
  hold(tempod);
  const { container } = await installFakes(stub, tempod);
  const summary = ok(await stub.init(initInput({ workspaceId, seeded, slug, branch }, opts)));
  return { workspaceId, stub, tempod, container, seeded, slug, branch, summary };
};

/** A workspace driven through the create op to `ready` (or `working` when a prompt is given). */
const readyWs = async (
  opts: { prompt?: string; credentials?: boolean } = {},
): Promise<Ws & { first: { sessionId: string; turnId: string } | null }> => {
  const seeded = await seedProject();
  if (opts.credentials !== false) await seedCredentials(seeded.userId);
  const w = await seedWorkspace(seeded, opts.prompt ? { prompt: opts.prompt } : {});
  await driveToState(w.stub, "ready", "working");
  let first: { sessionId: string; turnId: string } | null = null;
  if (opts.prompt && opts.credentials !== false) {
    await waitFor(() => w.tempod.requestsOf("session.prompt").length === 1, 5000, "first prompt");
    const p = w.tempod.requestsOf("session.prompt")[0];
    first = { sessionId: p.sessionId, turnId: p.turnId };
    await waitFor(
      async () => (await turnOf(w.stub, p.turnId))?.["status"] === "running",
      5000,
      "first turn running",
    );
  }
  return { ...w, seeded, first };
};

const liveSession = async (w: Ws, agent: AgentId = "claude") => {
  const s = ok(await w.stub.createSession({ agent }));
  await waitFor(async () => (await sessionOf(w.stub, s.id))?.["status"] === "idle", 5000, "session idle");
  return s;
};

const prompt = (
  w: Ws,
  sessionId: string,
  text: string,
  extra: { reviewCommentIds?: string[]; mentions?: Array<{ path: string }> } = {},
) =>
  w.stub.sendPrompt({
    sessionId,
    text,
    mentions: extra.mentions ?? [],
    attachmentIds: [],
    reviewCommentIds: extra.reviewCommentIds ?? [],
  });

const endTurn = async (w: Ws, sessionId: string, turnId: string, stopReason = "end_turn") => {
  await emit(w, { kind: "turn.ended", sessionId, turnId, stopReason });
  await waitFor(async () => (await turnOf(w.stub, turnId))?.["status"] !== "running", 5000, "turn ended");
};

/** sleepWorkspace on a ready workspace, then the sleep op until `sleeping`. */
const putToSleep = async (w: Ws) => {
  expect(codeOf(await w.stub.sleepWorkspace({}))).toBe("OK");
  await driveToState(w.stub, "sleeping");
};

/** archiveWorkspace, then the archive op until `archived`, and the D1 row caught up. */
const archiveIt = async (w: Ws) => {
  expect(codeOf(await w.stub.archiveWorkspace({}))).toBe("OK");
  await driveToState(w.stub, "archived");
  await waitFor(async () => (await d1Row(w.workspaceId))?.["archived_at"] != null, 5000, "D1 archived_at");
};

const settingsWith = (patch: {
  scripts?: Record<string, unknown>;
  environment?: Record<string, unknown>;
}) => ({
  ...DEFAULT_EFFECTIVE,
  scripts: { ...DEFAULT_EFFECTIVE.scripts, ...patch.scripts },
  environment: { ...DEFAULT_EFFECTIVE.environment, ...patch.environment },
});

/** Makes tempod report new effective settings and has the DO read them again. */
const useSettings = async (w: Ws, effective: unknown) => {
  w.tempod.on("settings.read", () => ({ effective, warnings: [], errors: [], sources: {} }));
  await w.stub.refreshSettings();
};

const uninitialised = (): Stub => env.WORKSPACE.getByName(newId());

/** Opens the workspace channel (02) and collects what the DO sends. */
const openUi = async (w: Ws) => {
  const res = await w.stub.fetch(`https://tempo.test/api/ws/workspace/${w.workspaceId}?sinceRev=0`, {
    headers: { Upgrade: "websocket" },
  });
  const socket = res.webSocket!;
  const messages: any[] = [];
  socket.accept();
  socket.addEventListener("message", (e) => {
    messages.push(JSON.parse(String(e.data)));
  });
  return { socket, messages };
};

/** Moves a workspace to `error` the way a permanently failed step does. */
const forceError = (w: Ws) =>
  runInDurableObject(w.stub, (i: WorkspaceDO) =>
    internals(i).core.setState("error", { code: "CONTAINER_START_FAILED", detail: "test" }),
  );

// =====================================================================================

describe("init", { timeout: 30_000 }, () => {
  it("writes the workspace row, the first session, turn and user_message item, inserts the create op and sets state starting", async () => {
    const text = "Move invoice generation into a background job, add retries and cover the job with tests";
    const w = await seedHeld({ prompt: text, agent: "codex" });
    // 03 createWorkspace 5: "Call WorkspaceDO.init(...) and return its WorkspaceSummary."
    expect(Object.keys(w.summary).sort()).toEqual(
      [
        "archivedAt",
        "attention",
        "baseBranch",
        "branch",
        "checksState",
        "createdAt",
        "defaultAgent",
        "id",
        "lastActivityAt",
        "pinned",
        "prNumber",
        "prState",
        "projectId",
        "rev",
        "slug",
        "state",
        "title",
      ].sort(),
    );
    expect(w.summary).toMatchObject({
      id: w.workspaceId,
      projectId: w.seeded.projectId,
      slug: w.slug,
      branch: w.branch,
      state: "starting",
      title: text.slice(0, 60),
      pinned: false,
      archivedAt: null,
    });
    const d = await detail(w.stub);
    // 03 "In WorkspaceDO.init" 1: "Set title to the first 60 characters of the prompt, or to the slug."
    expect(d.title).toBe(text.slice(0, 60));
    // 03 init 1: "Make preview_key (32 random bytes from crypto.getRandomValues, base64url)."
    expect((await wsRow(w.stub))["preview_key"]).toMatch(PREVIEW_KEY);
    expect(d).not.toHaveProperty("previewToken");
    // 03 init 3: "Insert the create op. Set state starting."
    expect(d.state).toBe("starting");
    const create = await opsOf(w.stub, "create");
    expect(create).toHaveLength(1);
    expect(["pending", "running"]).toContain(create[0]!.status);
    // 03 init 2: "create a session (starting, agent = input agent ...), a turn (queued, seq = 1) and its user_message item"
    const sessions = await rows(w.stub, "SELECT * FROM sessions");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ status: "starting", agent: "codex" });
    const turns = await rows(w.stub, "SELECT * FROM turns");
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ session_id: sessions[0]!["id"], status: "queued", seq: 1 });
    expect(JSON.parse(turns[0]!["prompt_json"])).toEqual({
      text,
      mentions: [],
      attachmentIds: [],
      reviewCommentIds: [],
    });
    const items = await rows(w.stub, "SELECT * FROM items");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "user_message",
      session_id: sessions[0]!["id"],
      turn_id: turns[0]!["id"],
    });
    // 02 Item model: user_message content_json = {text, mentions: [{path}], attachments: [{id, name, mime}], reviewCommentIds: []}
    expect(JSON.parse(items[0]!["content_json"])).toEqual({
      text,
      mentions: [],
      attachments: [],
      reviewCommentIds: [],
    });
    // 02 WorkspaceDO Rules: "Every change to items increments workspace.items_rev by 1 and sets items.rev to the new value"
    expect(items[0]!["rev"]).toBe((await wsRow(w.stub))["items_rev"]);
    expect(d.queue).toEqual([turns[0]!["id"]]);
    expect(d.runningTurnId).toBeNull();
    // 03 init 4: "Publish the summary to UserHubDO." (02: the DO writes the D1 row with summary_rev)
    await waitFor(async () => (await d1Row(w.workspaceId))?.["state"] === "starting", 5000, "D1 state");
    expect((await d1Row(w.workspaceId))!["summary_rev"]).toBeGreaterThan(0);
    await waitFor(async () => (await hubRev(w.seeded.userId, w.workspaceId)) !== null, 5000, "hub summary");
  });

  it("uses the slug as the title and creates no session, turn or item without a prompt", async () => {
    const w = await seedHeld();
    const d = await detail(w.stub);
    expect(d.title).toBe(w.slug);
    expect(d.state).toBe("starting");
    expect(await rows(w.stub, "SELECT id FROM sessions")).toHaveLength(0);
    expect(await rows(w.stub, "SELECT id FROM turns")).toHaveLength(0);
    expect(await rows(w.stub, "SELECT id FROM items")).toHaveLength(0);
    expect(await opsOf(w.stub, "create")).toHaveLength(1);
  });

  it("keeps whole short prompts as the title and makes a fresh preview key per workspace", async () => {
    const a = await seedHeld({ prompt: "Fix the login bug" });
    const b = await seedHeld({ prompt: "Fix the login bug" });
    expect((await detail(a.stub)).title).toBe("Fix the login bug");
    expect((await wsRow(a.stub))["preview_key"]).not.toBe((await wsRow(b.stub))["preview_key"]);
  });

  it("is idempotent: a second init returns the existing summary and adds nothing", async () => {
    const w = await seedHeld({ prompt: "First prompt" });
    const before = await wsRow(w.stub);
    const again = ok(
      await w.stub.init(
        initInput({ ...w, slug: "other-slug", branch: "tempo/other" }, { prompt: "Second prompt" }),
      ),
    );
    expect(again.id).toBe(w.workspaceId);
    expect(again.title).toBe("First prompt");
    expect(again.slug).toBe(w.slug);
    expect(again.branch).toBe(w.branch);
    expect((await wsRow(w.stub))["preview_key"]).toBe(before["preview_key"]);
    expect(await rows(w.stub, "SELECT id FROM sessions")).toHaveLength(1);
    expect(await rows(w.stub, "SELECT id FROM turns")).toHaveLength(1);
    expect(await rows(w.stub, "SELECT id FROM items")).toHaveLength(1);
    expect(await opsOf(w.stub, "create")).toHaveLength(1);
  });
});

describe("getWorkspace", { timeout: 30_000 }, () => {
  it("returns every WorkspaceDetail field for a ready workspace", async () => {
    const w = await readyWs();
    const d = await detail(w.stub);
    // 02 Shared types: WorkspaceDetail = WorkspaceSummary plus errorCode, errorDetail, setupStatus, pushed,
    // ports, settings, runningTurnId, queue, imageRef, op
    for (const key of [
      "id",
      "projectId",
      "slug",
      "title",
      "branch",
      "baseBranch",
      "state",
      "attention",
      "defaultAgent",
      "prNumber",
      "prState",
      "checksState",
      "pinned",
      "lastActivityAt",
      "createdAt",
      "archivedAt",
      "rev",
      "errorCode",
      "errorDetail",
      "setupStatus",
      "pushed",
      "ports",
      "settings",
      "runningTurnId",
      "queue",
      "imageRef",
      "op",
    ]) {
      expect(d, key).toHaveProperty(key);
    }
    expect(d).toMatchObject({
      id: w.workspaceId,
      projectId: w.seeded.projectId,
      baseBranch: "main",
      state: "ready",
      attention: "none",
      defaultAgent: "claude",
      prNumber: null,
      prState: null,
      checksState: null,
      pinned: false,
      archivedAt: null,
      errorCode: null,
      errorDetail: null,
      setupStatus: "none",
      pushed: false,
      ports: [],
      runningTurnId: null,
      queue: [],
      imageRef: "registry.example/workspace@sha256:1111",
    });
    expect(d.settings).toEqual(DEFAULT_EFFECTIVE);
    expect(d.rev).toBe((await wsRow(w.stub))["summary_rev"]);
  });

  it("lists ports with their preview URLs", async () => {
    const w = await readyWs();
    await emit(w, { kind: "ports.changed", ports: [5173, 3000] });
    await waitFor(async () => (await detail(w.stub)).ports.length === 2, 5000, "ports");
    const d = await detail(w.stub);
    // 01 Preview URL: https://<P>-<workspaceId lowercase>.<PREVIEW_DOMAIN>; the hostname holds no secret.
    expect(d.ports).toEqual([
      { port: 3000, url: `https://3000-${w.workspaceId}.previews.test` },
      { port: 5173, url: `https://5173-${w.workspaceId}.previews.test` },
    ]);
    expect(d).not.toHaveProperty("previewToken");
  });

  it("shows the create op's progress while it runs", async () => {
    const w = await seedHeld();
    await waitFor(async () => (await detail(w.stub)).op?.status === "running", 5000, "create op running");
    const d = await detail(w.stub);
    // 02 OpProgress: kind, status, step, steps: [{name, status, ms}]; 03 create steps
    expect(d.op).toMatchObject({ kind: "create", status: "running", step: "container.start" });
    expect(d.op!.steps.map((s: { name: string }) => s.name)).toEqual([
      "container.start",
      "tempod.connect",
      "repo.clone",
      "settings.read",
      "setup.run",
    ]);
    expect(d.op!.steps[0]!.status).toBe("running");
    expect(d.op!.steps.slice(1).every((s: { status: string }) => s.status === "pending")).toBe(true);
  });

  it("returns NOT_FOUND for a workspace that was never created", async () => {
    expect(codeOf(await uninitialised().getWorkspace({}))).toBe("NOT_FOUND");
  });
});

describe("renameWorkspace", { timeout: 30_000 }, () => {
  it("stores the title and publishes it to the D1 row", async () => {
    const w = await seedHeld();
    const rev = (await detail(w.stub)).rev;
    expect(codeOf(await w.stub.renameWorkspace({ title: "Billing refactor" }))).toBe("OK");
    const d = await detail(w.stub);
    expect(d.title).toBe("Billing refactor");
    expect(d.rev).toBeGreaterThan(rev);
    await waitFor(
      async () => (await d1Row(w.workspaceId))?.["title"] === "Billing refactor",
      5000,
      "D1 title",
    );
  });

  it("returns NOT_FOUND for a workspace that was never created", async () => {
    expect(codeOf(await uninitialised().renameWorkspace({ title: "x" }))).toBe("NOT_FOUND");
  });
});

describe("renameBranch", { timeout: 30_000 }, () => {
  it("rejects names that are not valid git branch names with BRANCH_INVALID", async () => {
    const w = await seedHeld();
    // 02 Error codes: BRANCH_INVALID = "Not a valid git branch name"
    for (const bad of [
      "",
      "   ",
      "has space",
      "a..b",
      "a~b",
      "a^b",
      "a:b",
      "a?b",
      "a*b",
      "a[b",
      "a\\b",
      "a//b",
      "/a",
      "a/",
      "a.",
      "a.lock",
      "a@{b",
      "@",
      "a/.b",
    ]) {
      expect(codeOf(await w.stub.renameBranch({ branch: bad })), JSON.stringify(bad)).toBe("BRANCH_INVALID");
    }
    expect((await detail(w.stub)).branch).toBe(w.branch);
  });

  // Regression (fixed): isValidBranch (src/do/workspace/rpc.ts:57-58) accepts names git refuses as branch names:
  // a first component that starts with ".", a component that ends in ".lock", a leading "-", and
  // "HEAD". renameBranch returns OK and stores them; git.renameBranch / repo.clone then fail.
  it("rejects other names git refuses as branch names with BRANCH_INVALID", async () => {
    const w = await seedHeld();
    for (const bad of [".hidden", "a.lock/b", "-oops", "HEAD"]) {
      expect(codeOf(await w.stub.renameBranch({ branch: bad })), JSON.stringify(bad)).toBe("BRANCH_INVALID");
    }
  });

  it("returns BRANCH_ALREADY_PUSHED once the branch is on origin", async () => {
    const w = await seedHeld();
    await exec(w.stub, "UPDATE workspace SET pushed = 1");
    // 02 Error codes: BRANCH_ALREADY_PUSHED = "Rename after push"
    expect(codeOf(await w.stub.renameBranch({ branch: "feature/new-name" }))).toBe("BRANCH_ALREADY_PUSHED");
    expect((await detail(w.stub)).branch).toBe(w.branch);
  });

  it("returns BRANCH_IN_USE when another live workspace of the project has the branch, and allows archived or other-project ones", async () => {
    const w = await seedHeld();
    // 02 Error codes: BRANCH_IN_USE = "Another live workspace has the branch"
    await insertD1Workspace(w.seeded, { slug: `taken-${++counter}`, branch: "feature/taken" });
    expect(codeOf(await w.stub.renameBranch({ branch: "feature/taken" }))).toBe("BRANCH_IN_USE");
    expect((await detail(w.stub)).branch).toBe(w.branch);

    await insertD1Workspace(w.seeded, { slug: `old-${++counter}`, branch: "feature/old", archived: true });
    expect(codeOf(await w.stub.renameBranch({ branch: "feature/old" }))).toBe("OK");
    expect((await detail(w.stub)).branch).toBe("feature/old");

    const other = await seedProject();
    await insertD1Workspace(other, { slug: `else-${++counter}`, branch: "feature/elsewhere" });
    expect(codeOf(await w.stub.renameBranch({ branch: "feature/elsewhere" }))).toBe("OK");
    await waitFor(
      async () => (await d1Row(w.workspaceId))?.["branch"] === "feature/elsewhere",
      5000,
      "D1 branch",
    );
  });

  it("stores the branch without a tempod request while the container is not up", async () => {
    const w = await seedHeld();
    expect(codeOf(await w.stub.renameBranch({ branch: "feature/offline" }))).toBe("OK");
    expect((await detail(w.stub)).branch).toBe("feature/offline");
    expect(w.tempod.requestsOf("git.renameBranch")).toHaveLength(0);
  });

  it("sends git.renameBranch {from, to} when connected, then stores and publishes the new branch", async () => {
    const w = await readyWs();
    const from = (await detail(w.stub)).branch;
    expect(codeOf(await w.stub.renameBranch({ branch: "feature/renamed" }))).toBe("OK");
    // 02 tempod protocol: git.renameBranch {from, to}
    expect(w.tempod.requestsOf("git.renameBranch")).toEqual([{ from, to: "feature/renamed" }]);
    expect((await detail(w.stub)).branch).toBe("feature/renamed");
    await waitFor(
      async () => (await d1Row(w.workspaceId))?.["branch"] === "feature/renamed",
      5000,
      "D1 branch",
    );
    // IMPLEMENTATION_NOTES (additive): a second hello updates tempod's branch.
    await waitFor(
      () => w.tempod.hellos.at(-1)?.workspace?.branch === "feature/renamed",
      5000,
      "hello with new branch",
    );
  });

  it("keeps the old branch when tempod fails the rename", async () => {
    const w = await readyWs();
    const before = (await detail(w.stub)).branch;
    w.tempod.fail("git.renameBranch", "INTERNAL", "git branch -m failed");
    expect(codeOf(await w.stub.renameBranch({ branch: "feature/nope" }))).toBe("INTERNAL");
    expect((await detail(w.stub)).branch).toBe(before);
  });
});

describe("setPinned and markViewed", { timeout: 30_000 }, () => {
  it("setPinned writes pinned through the DO and raises summary_rev in D1", async () => {
    const w = await seedHeld();
    const rev0 = (await detail(w.stub)).rev;
    expect(codeOf(await w.stub.setPinned({ pinned: true }))).toBe("OK");
    const d1 = await detail(w.stub);
    expect(d1.pinned).toBe(true);
    expect(d1.rev).toBeGreaterThan(rev0);
    // 02 Write rules: "setPinned ... calls the WorkspaceDO, which writes pinned and publishes the summary."
    await waitFor(
      async () => {
        const r = await d1Row(w.workspaceId);
        return r?.["pinned"] === 1 && r["summary_rev"] === d1.rev;
      },
      5000,
      "D1 pinned",
    );
    expect(codeOf(await w.stub.setPinned({ pinned: false }))).toBe("OK");
    const d2 = await detail(w.stub);
    expect(d2.pinned).toBe(false);
    expect(d2.rev).toBeGreaterThan(d1.rev);
    await waitFor(
      async () => {
        const r = await d1Row(w.workspaceId);
        return r?.["pinned"] === 0 && r["summary_rev"] === d2.rev;
      },
      5000,
      "D1 unpinned",
    );
  });

  it("publishes the summary to the hub even when the D1 write fails", async () => {
    const w = await readyWs();
    const brokenD1 = {
      prepare: () => {
        throw new Error("D1 unavailable");
      },
    };
    await runInDurableObject(w.stub, (i: WorkspaceDO) => {
      const core = internals(i).core as unknown as { env: object; realEnv?: object };
      core.realEnv = core.env;
      core.env = new Proxy(core.env, {
        get: (target, key) => (key === "DB" ? brokenD1 : Reflect.get(target, key)),
      });
    });
    try {
      ok(await w.stub.renameWorkspace({ title: "Renamed while D1 is down" }));
      const rev = (await wsRow(w.stub))["summary_rev"];
      // 02 Hub: "The WorkspaceDO calls UserHubDO.publish(summary) every time it increments summary_rev."
      await waitFor(async () => (await hubRev(w.seeded.userId, w.workspaceId)) === rev, 5000, "hub rev");
      expect((await d1Row(w.workspaceId))!["title"]).not.toBe("Renamed while D1 is down");
    } finally {
      await runInDurableObject(w.stub, (i: WorkspaceDO) => {
        const core = internals(i).core as unknown as { env: object; realEnv?: object };
        core.env = core.realEnv!;
      });
    }
    // The next publish brings D1 up to date.
    ok(await w.stub.setPinned({ pinned: true }));
    await waitFor(
      async () => (await d1Row(w.workspaceId))?.["title"] === "Renamed while D1 is down",
      5000,
      "D1 caught up",
    );
  });

  it("a stale summary write changes nothing in D1", async () => {
    const w = await seedHeld();
    const rev = (await detail(w.stub)).rev;
    await waitFor(async () => (await d1Row(w.workspaceId))?.["summary_rev"] === rev, 5000, "D1 caught up");
    await env.DB.prepare("UPDATE workspaces SET summary_rev = 1000000, title = 'newer write' WHERE id = ?")
      .bind(w.workspaceId)
      .run();
    expect(codeOf(await w.stub.setPinned({ pinned: true }))).toBe("OK");
    const newRev = (await detail(w.stub)).rev;
    // The DO publishes to UserHubDO after its D1 write settles.
    await waitFor(async () => (await hubRev(w.seeded.userId, w.workspaceId)) === newRev, 5000, "hub publish");
    // 02 Write rules: "UPDATE … WHERE id = ? AND summary_rev < ?. A stale write changes nothing."
    expect(await d1Row(w.workspaceId)).toMatchObject({
      summary_rev: 1000000,
      title: "newer write",
      pinned: 0,
    });
  });

  it("markViewed sets last_viewed_at and clears unread attention, raising summary_rev", async () => {
    const w = await readyWs({ prompt: "Write a README" });
    const { sessionId, turnId } = w.first!;
    await endTurn(w, sessionId, turnId);
    // 03 Attention 3: "unread: a turn ended after last_viewed_at"
    await waitFor(async () => (await detail(w.stub)).attention === "unread", 5000, "unread");
    await waitFor(async () => (await d1Row(w.workspaceId))?.["attention"] === "unread", 5000, "D1 unread");
    const before = await detail(w.stub);
    expect(codeOf(await w.stub.markViewed({}))).toBe("OK");
    const after = await detail(w.stub);
    expect(after.attention).toBe("none");
    expect(after.rev).toBeGreaterThan(before.rev);
    const turn = await turnOf(w.stub, turnId);
    expect((await wsRow(w.stub))["last_viewed_at"]).toBeGreaterThanOrEqual(turn!["ended_at"]);
    await waitFor(
      async () => {
        const r = await d1Row(w.workspaceId);
        return r?.["attention"] === "none" && r["summary_rev"] >= after.rev;
      },
      5000,
      "D1 attention none",
    );
  });

  it("returns NOT_FOUND for a workspace that was never created", async () => {
    expect(codeOf(await uninitialised().setPinned({ pinned: true }))).toBe("NOT_FOUND");
    expect(codeOf(await uninitialised().markViewed({}))).toBe("NOT_FOUND");
  });
});

describe("sleepWorkspace and wakeWorkspace", { timeout: 30_000 }, () => {
  it("returns WORKSPACE_BUSY while the workspace is not ready", async () => {
    const w = await seedHeld();
    // 03 Transitions: only `ready` goes to `stopping` via sleepWorkspace; 02: WORKSPACE_BUSY
    expect(codeOf(await w.stub.sleepWorkspace({}))).toBe("WORKSPACE_BUSY");
    expect(await opsOf(w.stub, "sleep")).toHaveLength(0);
  });

  it("runs the sleep op from ready to sleeping, then a second call is a no-op", async () => {
    const w = await readyWs();
    expect(codeOf(await w.stub.sleepWorkspace({}))).toBe("OK");
    expect(await opsOf(w.stub, "sleep")).toHaveLength(1);
    // A sleep op is now pending or running: another call cannot start a second one.
    expect(codeOf(await w.stub.sleepWorkspace({}))).toBe("WORKSPACE_BUSY");
    await driveToState(w.stub, "sleeping");
    // 03 Sleep 4-6: tempod.shutdown, snapshot, destroy, tempod_token = null
    expect(w.tempod.requestsOf("shutdown")).toEqual([{ reason: "sleep" }]);
    expect(w.container.snapshots).toHaveLength(1);
    expect(w.container.destroyed).toBeGreaterThan(0);
    expect((await wsRow(w.stub))["tempod_token"]).toBeNull();
    expect(await rows(w.stub, "SELECT id FROM snapshots")).toHaveLength(1);
    await waitFor(async () => (await d1Row(w.workspaceId))?.["state"] === "sleeping", 5000, "D1 sleeping");
    expect(codeOf(await w.stub.sleepWorkspace({}))).toBe("OK");
    expect(await opsOf(w.stub, "sleep")).toHaveLength(1);
  });

  it("wakeWorkspace on a sleeping workspace inserts a wake op and moves to starting", async () => {
    const w = await readyWs();
    await putToSleep(w);
    hold(w.tempod);
    expect(codeOf(await w.stub.wakeWorkspace({}))).toBe("OK");
    // 03 Transitions: sleeping → starting (wake)
    expect(await stateOf(w.stub)).toBe("starting");
    expect(await opsOf(w.stub, "wake")).toHaveLength(1);
    expect(codeOf(await w.stub.wakeWorkspace({}))).toBe("OK");
    expect(await opsOf(w.stub, "wake")).toHaveLength(1);
  });
});

describe("archiveWorkspace, restoreWorkspace and deleteWorkspace", { timeout: 60_000 }, () => {
  it("archives a sleeping workspace without starting its container", async () => {
    const w = await readyWs();
    await putToSleep(w);
    const starts = w.container.starts.length;
    const requests = w.tempod.requests.length;
    // 03 Step runner: "When the container is not running, archive skips every step that needs it"
    await archiveIt(w);
    expect(w.container.starts).toHaveLength(starts);
    expect(w.tempod.requests).toHaveLength(requests);
    expect((await d1Row(w.workspaceId))!["state"]).toBe("archived");
  });

  it("restoreWorkspace during archiving queues the restore op, which runs after the archive", async () => {
    const w = await readyWs();
    expect(codeOf(await w.stub.archiveWorkspace({}))).toBe("OK");
    expect(await stateOf(w.stub)).toBe("archiving");
    // 03 Archive: "If the archive op is still running, restoreWorkspace queues the restore op. It starts when archive ends."
    expect(codeOf(await w.stub.restoreWorkspace({}))).toBe("OK");
    expect(await opsOf(w.stub, "restore")).toHaveLength(1);
    await driveToState(w.stub, "sleeping");
    expect((await opsOf(w.stub, "archive"))[0]!.status).toBe("done");
    expect((await opsOf(w.stub, "restore"))[0]!.status).toBe("done");
    expect((await detail(w.stub)).archivedAt).toBeNull();
    await waitFor(
      async () => {
        const r = await d1Row(w.workspaceId);
        return r?.["state"] === "sleeping" && r["archived_at"] === null;
      },
      5000,
      "D1 restored",
    );
  });

  it("returns WORKSPACE_BUSY when the state cannot go to archiving", async () => {
    const w = await seedHeld();
    // 03 Transitions: only ready, working, sleeping and error go to archiving
    expect(codeOf(await w.stub.archiveWorkspace({}))).toBe("WORKSPACE_BUSY");
    expect(await stateOf(w.stub)).toBe("starting");
    expect(await opsOf(w.stub, "archive")).toHaveLength(0);
  });

  it("archives a working workspace: cancels the running turn, deletes queued turns, cancels permissions, saves and frees the container", async () => {
    const w = await readyWs({ prompt: "Start the work" });
    const { sessionId, turnId } = w.first!;
    const queued = ok(await prompt(w, sessionId, "Then do more"));
    await emit(w, {
      kind: "permission.requested",
      requestId: "req-1",
      sessionId,
      turnId,
      itemId: "perm-item-1",
      title: "Run npm install",
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    });
    await waitFor(async () => (await detail(w.stub)).attention === "needs_input", 5000, "needs_input");

    expect(codeOf(await w.stub.archiveWorkspace({}))).toBe("OK");
    // 03 Transitions: working → archiving (archive)
    expect(await stateOf(w.stub)).toBe("archiving");
    await driveToState(w.stub, "archived");

    // 03 Archive 1: "cancel the running turn and delete queued turns. Answer pending permission requests as cancelled."
    expect(w.tempod.requestsOf("session.cancel")).toEqual([{ sessionId, turnId }]);
    expect((await turnOf(w.stub, turnId))!["status"]).toBe("cancelled");
    expect(await turnOf(w.stub, queued.id)).toBeUndefined();
    expect(await rows(w.stub, "SELECT id FROM items WHERE turn_id = ?", queued.id)).toHaveLength(0);
    expect(w.tempod.requestsOf("permission.respond")).toEqual([{ requestId: "req-1", optionId: null }]);
    expect((await one(w.stub, "SELECT status FROM permissions WHERE request_id = 'req-1'"))!["status"]).toBe(
      "cancelled",
    );
    // 03 Archive 3: checkpoint, ..., tempod.shutdown, container.snapshot, container.destroy
    expect(w.tempod.requestsOf("git.checkpoint").map((p) => p.reason)).toContain("pre_archive");
    expect(w.tempod.requestsOf("shutdown")).toEqual([{ reason: "archive" }]);
    expect(w.container.destroyed).toBeGreaterThan(0);
    // 03 Archive 5: "Set archived_at = now in the DO and in D1. State archived."
    const d = await detail(w.stub);
    expect(d.archivedAt).not.toBeNull();
    await waitFor(
      async () => {
        const r = await d1Row(w.workspaceId);
        return r?.["state"] === "archived" && r["archived_at"] === d.archivedAt;
      },
      5000,
      "D1 archived",
    );
    expect(d.attention).not.toBe("needs_input");
  });

  it("refuses work on an archived workspace with WORKSPACE_ARCHIVED, and a second archive is a no-op", async () => {
    const w = await readyWs();
    const s = await liveSession(w);
    await archiveIt(w);
    // 02 Sessions and turns: createSession and sendPrompt list WORKSPACE_ARCHIVED; Workspaces: wake/sleep too
    expect(codeOf(await prompt(w, s.id, "hello"))).toBe("WORKSPACE_ARCHIVED");
    expect(codeOf(await w.stub.createSession({ agent: "claude" }))).toBe("WORKSPACE_ARCHIVED");
    expect(codeOf(await w.stub.wakeWorkspace({}))).toBe("WORKSPACE_ARCHIVED");
    expect(codeOf(await w.stub.sleepWorkspace({}))).toBe("WORKSPACE_ARCHIVED");
    expect(await rows(w.stub, "SELECT id FROM turns")).toHaveLength(0);
    expect(await rows(w.stub, "SELECT id FROM sessions")).toHaveLength(1);
    expect(codeOf(await w.stub.archiveWorkspace({}))).toBe("OK");
    expect(await opsOf(w.stub, "archive")).toHaveLength(1);
    expect(await stateOf(w.stub)).toBe("archived");
  });

  it("restores an archived workspace to sleeping and clears archived_at", async () => {
    const w = await readyWs();
    await archiveIt(w);
    expect(codeOf(await w.stub.restoreWorkspace({}))).toBe("OK");
    // 03 Restore 3: "Clear archived_at. State sleeping."
    await driveToState(w.stub, "sleeping");
    expect((await detail(w.stub)).archivedAt).toBeNull();
    await waitFor(
      async () => {
        const r = await d1Row(w.workspaceId);
        return r?.["state"] === "sleeping" && r["archived_at"] === null;
      },
      5000,
      "D1 restored",
    );
  });

  it("restore returns BRANCH_IN_USE when another live workspace took the branch", async () => {
    const w = await readyWs();
    await archiveIt(w);
    const branch = (await detail(w.stub)).branch;
    await insertD1Workspace(w.seeded, { slug: `thief-${++counter}`, branch });
    // 03 Restore 1: "no other non-archived workspace in the project uses the branch ... Else BRANCH_IN_USE."
    expect(codeOf(await w.stub.restoreWorkspace({}))).toBe("BRANCH_IN_USE");
    expect(await stateOf(w.stub)).toBe("archived");
    expect(await opsOf(w.stub, "restore")).toHaveLength(0);
  });

  it("restore gives the workspace a new slug when only the slug is taken, and keeps the branch", async () => {
    const w = await readyWs();
    await archiveIt(w);
    const before = await detail(w.stub);
    await insertD1Workspace(w.seeded, { slug: before.slug, branch: `tempo/other-${++counter}` });
    expect(codeOf(await w.stub.restoreWorkspace({}))).toBe("OK");
    await driveToState(w.stub, "sleeping");
    const after = await detail(w.stub);
    // 03 Restore 1: "If only the slug is taken, give the workspace a new slug; keep the branch."
    expect(after.slug).not.toBe(before.slug);
    expect(after.slug).toMatch(/^[a-z0-9-]+$/);
    expect(after.branch).toBe(before.branch);
    await waitFor(async () => (await d1Row(w.workspaceId))?.["slug"] === after.slug, 5000, "D1 slug");
  });

  it("deleteWorkspace returns WORKSPACE_NOT_ARCHIVED unless archived", async () => {
    const w = await seedHeld();
    // 02 Workspaces: deleteWorkspace (archived only) → WORKSPACE_NOT_ARCHIVED
    expect(codeOf(await w.stub.deleteWorkspace({}))).toBe("WORKSPACE_NOT_ARCHIVED");
    expect(await d1Row(w.workspaceId)).not.toBeNull();
    expect((await detail(w.stub)).state).toBe("starting");
  });

  it("deleteWorkspace deletes the R2 keys, the D1 row, the DO rows and the hub summary", async () => {
    const w = await readyWs();
    await archiveIt(w);
    const id = w.workspaceId;
    const otherId = newId();
    // 02 R2 layout: checkpoints/, homes/, attachments/, logs/ per workspace
    const keys = [
      `checkpoints/${id}/c1.bundle`,
      `homes/${id}/r1.tar.zst`,
      `attachments/${id}/a1/notes.txt`,
      `logs/${id}/run1.log`,
    ];
    for (const k of [...keys, `logs/${otherId}/run1.log`]) await env.DATA.put(k, "x");
    await waitFor(async () => (await hubRev(w.seeded.userId, id)) !== null, 5000, "hub summary");

    expect(codeOf(await w.stub.deleteWorkspace({}))).toBe("OK");
    // 03 Delete: "delete the R2 keys (02, R2 layout), the D1 row, and every row in the DO"; then UserHubDO.remove
    for (const k of keys) expect(await env.DATA.head(k), k).toBeNull();
    expect(await env.DATA.head(`logs/${otherId}/run1.log`)).not.toBeNull();
    expect(await d1Row(id)).toBeNull();
    expect(await hubRev(w.seeded.userId, id)).toBeNull();
    const tables = await runInDurableObject(w.stub, (_i: WorkspaceDO, state: DurableObjectState) =>
      state.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace'")
        .toArray(),
    );
    if (tables.length > 0) expect(await rows(w.stub, "SELECT * FROM workspace")).toHaveLength(0);
    expect(codeOf(await w.stub.getWorkspace({}))).not.toBe("OK");
  });
});

describe("rotatePreviewKey", { timeout: 30_000 }, () => {
  it("makes a new preview key and leaves the preview URLs as they are", async () => {
    const w = await seedHeld();
    await exec(w.stub, "INSERT INTO ports (port, first_seen_at) VALUES (3000, 0)");
    const before = (await wsRow(w.stub))["preview_key"];
    expect(ok(await w.stub.rotatePreviewKey({}))).toEqual({});
    const after = (await wsRow(w.stub))["preview_key"];
    expect(after).toMatch(PREVIEW_KEY);
    expect(after).not.toBe(before);
    expect((await detail(w.stub)).ports).toEqual([
      { port: 3000, url: `https://3000-${w.workspaceId}.previews.test` },
    ]);
  });
});

describe("open previews", { timeout: 30_000 }, () => {
  /** A preview cookie from openPreview and previewEnter, as the Worker gets one (05, Preview access). */
  const cookieFor = async (w: Ws): Promise<string> => {
    await exec(w.stub, "INSERT OR IGNORE INTO ports (port, first_seen_at) VALUES (3000, 0)");
    const { url } = ok(await w.stub.openPreview({ port: 3000 }));
    return (await w.stub.previewEnter(3000, new URL(url).searchParams.get("code")!))!;
  };
  const previewFetch = (w: Ws, cookie: string, init: { upgrade?: boolean } = {}) =>
    w.stub.fetch(`https://3000-${w.workspaceId}.previews.test/live`, {
      headers: {
        "x-tempo-preview": `3000:${cookie}`,
        ...(init.upgrade ? { Upgrade: "websocket" } : {}),
      },
    });

  it("closes preview WebSockets that are already open when the key is reset, and the old cookie stops working", async () => {
    const w = await readyWs();
    const cookie = await cookieFor(w);
    const res = await previewFetch(w, cookie, { upgrade: true });
    expect(res.status).toBe(101);
    const socket = res.webSocket!;
    let closed: number | null = null;
    socket.addEventListener("close", (e) => {
      closed = e.code;
    });
    socket.accept();
    await waitFor(() => w.tempod.proxySockets.length === 1, 3000, "proxied socket");
    ok(await w.stub.rotatePreviewKey({}));
    // 05 Preview access: "rotatePreviewKey makes a new preview_key; every preview cookie for the workspace stops working at once."
    await waitFor(() => closed === 1008, 5000, "browser side closed");
    await waitFor(() => w.tempod.proxySockets[0]!.closed !== null, 5000, "tempod side closed");
    expect((await previewFetch(w, cookie)).status).toBe(404);
  });

  it("leaves open preview WebSockets alone until the key is reset", async () => {
    const w = await readyWs();
    const cookie = await cookieFor(w);
    const socket = (await previewFetch(w, cookie, { upgrade: true })).webSocket!;
    let closed = false;
    socket.addEventListener("close", () => {
      closed = true;
    });
    socket.accept();
    await waitFor(() => w.tempod.proxySockets.length === 1, 3000, "proxied socket");
    ok(await w.stub.renameWorkspace({ title: "Still previewing" }));
    await sleep(200);
    expect(closed).toBe(false);
    expect(w.tempod.proxySockets[0]!.closed).toBeNull();
    socket.close(1000, "done");
  });
});

describe("createSession, renameSession and closeSession", { timeout: 30_000 }, () => {
  it("returns CREDENTIAL_MISSING when the agent has no login, and creates nothing", async () => {
    const w = await seedHeld({ credentials: false });
    // 02 Sessions and turns: createSession → CREDENTIAL_MISSING
    expect(codeOf(await w.stub.createSession({ agent: "claude" }))).toBe("CREDENTIAL_MISSING");
    await env.CREDENTIALS.getByName(w.seeded.userId).putSecret("openrouter.api_key", "sk-or-test");
    expect(codeOf(await w.stub.createSession({ agent: "codex" }))).toBe("CREDENTIAL_MISSING");
    expect(await rows(w.stub, "SELECT id FROM sessions")).toHaveLength(0);
    const s = ok(await w.stub.createSession({ agent: "opencode" }));
    expect(s).toMatchObject({ agent: "opencode", status: "starting" });
  });

  it("inserts the session as starting, then starts it in tempod and marks it idle when the workspace is ready", async () => {
    const w = await readyWs();
    const s = ok(await w.stub.createSession({ agent: "claude", model: "claude-opus-4" }));
    // 01 Start a session 1: "inserts the session row with status starting"
    expect(s).toMatchObject({ agent: "claude", status: "starting", title: "" });
    expect(s.id).toMatch(ULID);
    await waitFor(() => w.tempod.requestsOf("session.start").length === 1, 5000, "session.start");
    // 01 Start a session 2: session.start {sessionId, agent, env, modeId, model, acpSessionId: null};
    // 01 Agents: Claude default mode bypassPermissions
    expect(w.tempod.requestsOf("session.start")[0]).toMatchObject({
      sessionId: s.id,
      agent: "claude",
      modeId: "bypassPermissions",
      model: "claude-opus-4",
      acpSessionId: null,
    });
    await waitFor(async () => (await sessionOf(w.stub, s.id))?.["status"] === "idle", 5000, "idle");
    const row = (await sessionOf(w.stub, s.id))!;
    expect(row["acp_session_id"]).toMatch(/^acp-/);
    expect(JSON.parse(row["modes_json"])).toEqual([{ id: "default", name: "Default" }]);
    const second = ok(await w.stub.createSession({ agent: "claude", modeId: "plan" }));
    expect(second.sortOrder).toBeGreaterThan(s.sortOrder);
    await waitFor(() => w.tempod.requestsOf("session.start").length === 2, 5000, "second session.start");
    expect(w.tempod.requestsOf("session.start")[1]).toMatchObject({
      sessionId: second.id,
      modeId: "plan",
      acpSessionId: null,
    });
  });

  it("is a wake trigger on a sleeping workspace", async () => {
    const w = await readyWs();
    await putToSleep(w);
    hold(w.tempod);
    const s = ok(await w.stub.createSession({ agent: "claude" }));
    expect(s.status).toBe("starting");
    // 03 Wake triggers: createSession
    expect(await opsOf(w.stub, "wake")).toHaveLength(1);
    expect(await stateOf(w.stub)).toBe("starting");
  });

  it("renameSession stores the title; unknown sessions are NOT_FOUND", async () => {
    const w = await seedHeld({ prompt: "Hi" });
    const sessionId = (await one(w.stub, "SELECT id FROM sessions"))!["id"];
    expect(codeOf(await w.stub.renameSession({ sessionId, title: "Billing" }))).toBe("OK");
    expect((await sessionOf(w.stub, sessionId))!["title"]).toBe("Billing");
    expect(codeOf(await w.stub.renameSession({ sessionId: newId(), title: "x" }))).toBe("NOT_FOUND");
  });

  it("closeSession returns SESSION_BUSY while the session has a running turn", async () => {
    const w = await readyWs({ prompt: "Busy work" });
    // 02 Sessions and turns: closeSession → SESSION_BUSY
    expect(codeOf(await w.stub.closeSession({ sessionId: w.first!.sessionId }))).toBe("SESSION_BUSY");
    expect((await sessionOf(w.stub, w.first!.sessionId))!["status"]).toBe("running");
  });

  it("closeSession cancels the session's queued turns and closes it; prompts to it are then refused", async () => {
    const w = await seedHeld({ prompt: "Queued work" });
    const sessionId = (await one(w.stub, "SELECT id FROM sessions"))!["id"];
    const turnId = (await one(w.stub, "SELECT id FROM turns"))!["id"];
    expect(codeOf(await w.stub.closeSession({ sessionId }))).toBe("OK");
    const turn = (await turnOf(w.stub, turnId))!;
    expect(turn["status"]).toBe("cancelled");
    expect(turn["queue_pos"]).toBeNull();
    const s = (await sessionOf(w.stub, sessionId))!;
    expect(s["status"]).toBe("closed");
    expect(s["closed_at"]).not.toBeNull();
    expect((await detail(w.stub)).queue).toEqual([]);
    // 03 sendPrompt 1: "the session is not closed"
    expect(codeOf(await prompt(w, sessionId, "more"))).toBe("VALIDATION_FAILED");
    expect(codeOf(await w.stub.closeSession({ sessionId }))).toBe("OK");
    expect(codeOf(await w.stub.closeSession({ sessionId: newId() }))).toBe("NOT_FOUND");
  });

  it("closeSession sends session.close for a live session", async () => {
    const w = await readyWs();
    const s = await liveSession(w);
    expect(codeOf(await w.stub.closeSession({ sessionId: s.id }))).toBe("OK");
    // 02 tempod protocol: session.close {sessionId}
    expect(w.tempod.requestsOf("session.close")).toEqual([{ sessionId: s.id }]);
    expect((await sessionOf(w.stub, s.id))!["status"]).toBe("closed");
  });
});

describe("sendPrompt", { timeout: 30_000 }, () => {
  it("queues a turn with the next seq and queue_pos, writes its user_message item and marks review comments sent", async () => {
    const w = await seedHeld({ prompt: "First" });
    const sessionId = (await one(w.stub, "SELECT id FROM sessions"))!["id"];
    const first = (await one(w.stub, "SELECT id FROM turns"))!["id"];
    const c1 = ok(await w.stub.addReviewComment({ path: "src/app.ts", lineStart: 4, body: "Use a const" }));
    const c2 = ok(await w.stub.addReviewComment({ path: "src/other.ts", body: "Not sent" }));
    const t2 = ok(
      await prompt(w, sessionId, "Second", { reviewCommentIds: [c1.id], mentions: [{ path: "src/app.ts" }] }),
    );
    // 03 sendPrompt 2: "status = 'queued', next seq, next queue_pos"
    expect(t2).toMatchObject({
      sessionId,
      seq: 2,
      status: "queued",
      queuePos: 2,
      prompt: {
        text: "Second",
        mentions: [{ path: "src/app.ts" }],
        attachmentIds: [],
        reviewCommentIds: [c1.id],
      },
      startedAt: null,
      endedAt: null,
      reverted: false,
    });
    const t3 = ok(await prompt(w, sessionId, "Third"));
    expect(t3).toMatchObject({ seq: 3, queuePos: 3, status: "queued" });
    expect((await detail(w.stub)).queue).toEqual([first, t2.id, t3.id]);
    // 03 sendPrompt 3 + 02 Item model user_message content
    const item = (await one(
      w.stub,
      "SELECT * FROM items WHERE turn_id = ? AND kind = 'user_message'",
      t2.id,
    ))!;
    expect(item["session_id"]).toBe(sessionId);
    expect(JSON.parse(item["content_json"])).toEqual({
      text: "Second",
      mentions: [{ path: "src/app.ts" }],
      attachments: [],
      reviewCommentIds: [c1.id],
    });
    // 03 sendPrompt 3: "Mark the selected draft review comments sent with this turn id."
    const comments = ok(await w.stub.listReviewComments({}));
    expect(comments.find((c: { id: string }) => c.id === c1.id)).toMatchObject({
      status: "sent",
      sentTurnId: t2.id,
    });
    expect(comments.find((c: { id: string }) => c.id === c2.id)).toMatchObject({
      status: "draft",
      sentTurnId: null,
    });
  });

  it("returns VALIDATION_FAILED for review comment ids that do not exist or were already sent, and queues nothing", async () => {
    const w = await seedHeld({ prompt: "First" });
    const sessionId = (await one(w.stub, "SELECT id FROM sessions"))!["id"];
    const c1 = ok(await w.stub.addReviewComment({ path: "src/app.ts", lineStart: 1, body: "Rename" }));
    ok(await prompt(w, sessionId, "Uses c1", { reviewCommentIds: [c1.id] }));
    const count = async () => (await rows(w.stub, "SELECT id FROM turns")).length;
    const before = await count();
    // 02 sendPrompt: VALIDATION_FAILED; 03 sendPrompt 3 marks only draft review comments sent.
    expect(codeOf(await prompt(w, sessionId, "Again", { reviewCommentIds: [c1.id] }))).toBe(
      "VALIDATION_FAILED",
    );
    expect(codeOf(await prompt(w, sessionId, "Ghost", { reviewCommentIds: [newId()] }))).toBe(
      "VALIDATION_FAILED",
    );
    expect(await count()).toBe(before);
    const c2 = ok(await w.stub.addReviewComment({ path: "src/app.ts", body: "Draft" }));
    ok(await prompt(w, sessionId, "Uses c2 twice", { reviewCommentIds: [c2.id, c2.id] }));
    expect(await count()).toBe(before + 1);
  });

  it("broadcasts turn and item.upsert to the workspace channel", async () => {
    const w = await seedHeld({ prompt: "First" });
    const sessionId = (await one(w.stub, "SELECT id FROM sessions"))!["id"];
    const { socket, messages } = await openUi(w);
    const t = ok(await prompt(w, sessionId, "Broadcast me"));
    // 03 sendPrompt 4: "Broadcast turn and item.upsert."
    await waitFor(() => messages.some((m) => m.type === "turn" && m.turn.id === t.id), 5000, "turn message");
    await waitFor(
      () =>
        messages.some(
          (m) =>
            m.type === "item.upsert" &&
            m.item.turnId === t.id &&
            m.item.kind === "user_message" &&
            m.item.content.text === "Broadcast me",
        ),
      5000,
      "item.upsert message",
    );
    const upsert = messages.find((m) => m.type === "item.upsert" && m.item.turnId === t.id);
    expect(upsert.itemsRev).toBe(upsert.item.rev);
    socket.close();
  });

  it("accepts a prompt with only an attachment and returns VALIDATION_FAILED for an unknown attachment", async () => {
    const w = await seedHeld({ prompt: "First" });
    const sessionId = (await one(w.stub, "SELECT id FROM sessions"))!["id"];
    const attId = newId();
    await w.stub.registerAttachment({
      id: attId,
      name: "shot.png",
      mime: "image/png",
      size: 4,
      r2Key: `attachments/${w.workspaceId}/${attId}/shot.png`,
    });
    expect(
      codeOf(
        await w.stub.sendPrompt({
          sessionId,
          text: "",
          mentions: [],
          attachmentIds: [newId()],
          reviewCommentIds: [],
        }),
      ),
    ).toBe("VALIDATION_FAILED");
    const t = ok(
      await w.stub.sendPrompt({
        sessionId,
        text: "",
        mentions: [],
        attachmentIds: [attId],
        reviewCommentIds: [],
      }),
    );
    expect(t.prompt.attachmentIds).toEqual([attId]);
    const item = (await one(w.stub, "SELECT content_json FROM items WHERE turn_id = ?", t.id))!;
    // 02 Item model: user_message attachments: [{id, name, mime}]
    expect(JSON.parse(item["content_json"]).attachments).toEqual([
      { id: attId, name: "shot.png", mime: "image/png" },
    ]);
    expect((await one(w.stub, "SELECT turn_id FROM attachments WHERE id = ?", attId))!["turn_id"]).toBe(t.id);
  });

  it("inserts a wake op when the workspace is in error, and wakeWorkspace retries from error", async () => {
    const w = await readyWs();
    const s = await liveSession(w);
    hold(w.tempod);
    await forceError(w);
    // 03 Attention 2: "error: state is error ..."
    expect(await detail(w.stub)).toMatchObject({
      state: "error",
      attention: "error",
      errorCode: "CONTAINER_START_FAILED",
    });
    ok(await prompt(w, s.id, "Try again"));
    // 03 sendPrompt 5 and Transitions: error → starting (wake)
    expect(await opsOf(w.stub, "wake")).toHaveLength(1);
    expect(await detail(w.stub)).toMatchObject({ state: "starting", errorCode: null });
    expect(codeOf(await w.stub.wakeWorkspace({}))).toBe("OK");
    expect(await opsOf(w.stub, "wake")).toHaveLength(1);
  });

  it("returns VALIDATION_FAILED for an empty message or a closed session, and NOT_FOUND for an unknown session", async () => {
    const w = await seedHeld({ prompt: "First" });
    const sessionId = (await one(w.stub, "SELECT id FROM sessions"))!["id"];
    expect(codeOf(await prompt(w, sessionId, "   "))).toBe("VALIDATION_FAILED");
    expect(codeOf(await prompt(w, newId(), "hi"))).toBe("NOT_FOUND");
    ok(await w.stub.closeSession({ sessionId }));
    expect(codeOf(await prompt(w, sessionId, "hi"))).toBe("VALIDATION_FAILED");
    expect(await rows(w.stub, "SELECT id FROM turns")).toHaveLength(1);
  });

  it("returns CREDENTIAL_MISSING when the session's agent has no login", async () => {
    const w = await seedHeld({ prompt: "First", credentials: false });
    const sessionId = (await one(w.stub, "SELECT id FROM sessions"))!["id"];
    // 03 sendPrompt 1: "the agent's credential is set (else CREDENTIAL_MISSING)"
    expect(codeOf(await prompt(w, sessionId, "Second"))).toBe("CREDENTIAL_MISSING");
    expect(await rows(w.stub, "SELECT id FROM turns")).toHaveLength(1);
  });

  it("starts the turn at once when the workspace is ready and idle", async () => {
    const w = await readyWs();
    const s = await liveSession(w);
    const t = ok(await prompt(w, s.id, "Add a health check"));
    expect(t.status).toBe("queued");
    // 03 Start the turn 3: session.prompt; turn running, session running, state working, queue_pos = null
    await waitFor(() => w.tempod.requestsOf("session.prompt").length === 1, 5000, "session.prompt");
    const req = w.tempod.requestsOf("session.prompt")[0];
    expect(req).toMatchObject({ sessionId: s.id, turnId: t.id });
    expect(req.content.at(-1)).toEqual({ type: "text", text: "Add a health check" });
    await waitFor(async () => (await turnOf(w.stub, t.id))?.["status"] === "running", 5000, "running");
    const row = (await turnOf(w.stub, t.id))!;
    expect(row["queue_pos"]).toBeNull();
    expect(row["started_at"]).not.toBeNull();
    expect((await sessionOf(w.stub, s.id))!["status"]).toBe("running");
    const d = await detail(w.stub);
    expect(d.state).toBe("working");
    expect(d.runningTurnId).toBe(t.id);
  });

  it("inserts a wake op when sleeping, and the turn runs after the wake", async () => {
    const w = await readyWs();
    const s = await liveSession(w);
    const acpId = (await sessionOf(w.stub, s.id))!["acp_session_id"];
    await putToSleep(w);
    hold(w.tempod);
    const t = ok(await prompt(w, s.id, "Wake up and work"));
    // 03 sendPrompt 5: "If the state is sleeping or error, insert a wake op."
    expect(t.status).toBe("queued");
    expect(await opsOf(w.stub, "wake")).toHaveLength(1);
    expect(await stateOf(w.stub)).toBe("starting");
    w.tempod.healthy = true;
    await waitFor(
      () => w.tempod.requestsOf("session.prompt").some((p) => p.turnId === t.id),
      15_000,
      "prompt after wake",
    );
    // 03 Wake 4: sessions.markReload; the next prompt reloads the session with its ACP id (01, Reload)
    expect(w.tempod.requestsOf("session.start").at(-1)).toMatchObject({
      sessionId: s.id,
      acpSessionId: acpId,
    });
  });
});

describe("editQueuedTurn, deleteQueuedTurn and reorderQueue", { timeout: 30_000 }, () => {
  it("editQueuedTurn updates the turn's prompt text and its user_message item", async () => {
    const w = await seedHeld({ prompt: "Original" });
    const turnId = (await one(w.stub, "SELECT id FROM turns"))!["id"];
    const before = (await one(w.stub, "SELECT * FROM items WHERE turn_id = ?", turnId))!;
    const t = ok(await w.stub.editQueuedTurn({ turnId, text: "Edited text" }));
    expect(t).toMatchObject({ id: turnId, status: "queued", prompt: { text: "Edited text" } });
    const item = (await one(w.stub, "SELECT * FROM items WHERE turn_id = ?", turnId))!;
    expect(JSON.parse(item["content_json"]).text).toBe("Edited text");
    expect(item["rev"]).toBeGreaterThan(before["rev"]);
    expect(item["rev"]).toBe((await wsRow(w.stub))["items_rev"]);
  });

  it("returns TURN_NOT_QUEUED for a running or ended turn and NOT_FOUND for an unknown one", async () => {
    const w = await readyWs({ prompt: "Running" });
    const { turnId } = w.first!;
    // 02 Error codes: TURN_NOT_QUEUED = "Edit or delete on a turn that already started"
    expect(codeOf(await w.stub.editQueuedTurn({ turnId, text: "x" }))).toBe("TURN_NOT_QUEUED");
    expect(codeOf(await w.stub.deleteQueuedTurn({ turnId }))).toBe("TURN_NOT_QUEUED");
    await endTurn(w, w.first!.sessionId, turnId);
    expect(codeOf(await w.stub.editQueuedTurn({ turnId, text: "x" }))).toBe("TURN_NOT_QUEUED");
    expect(codeOf(await w.stub.deleteQueuedTurn({ turnId }))).toBe("TURN_NOT_QUEUED");
    expect(codeOf(await w.stub.editQueuedTurn({ turnId: newId(), text: "x" }))).toBe("NOT_FOUND");
    expect(codeOf(await w.stub.deleteQueuedTurn({ turnId: newId() }))).toBe("NOT_FOUND");
  });

  it("deleteQueuedTurn removes the turn and its items and broadcasts turn.deleted", async () => {
    const w = await seedHeld({ prompt: "Keep me" });
    const sessionId = (await one(w.stub, "SELECT id FROM sessions"))!["id"];
    const keep = (await one(w.stub, "SELECT id FROM turns"))!["id"];
    const t2 = ok(await prompt(w, sessionId, "Delete me"));
    const { socket, messages } = await openUi(w);
    expect(codeOf(await w.stub.deleteQueuedTurn({ turnId: t2.id }))).toBe("OK");
    expect(await turnOf(w.stub, t2.id)).toBeUndefined();
    expect(await rows(w.stub, "SELECT id FROM items WHERE turn_id = ?", t2.id)).toHaveLength(0);
    expect((await detail(w.stub)).queue).toEqual([keep]);
    // IMPLEMENTATION_NOTES (additive channel message): turn.deleted {turnId}
    await waitFor(
      () => messages.some((m) => m.type === "turn.deleted" && m.turnId === t2.id),
      5000,
      "turn.deleted",
    );
    socket.close();
  });

  it("deleteQueuedTurn raises items_rev with the deleted items; a refused delete leaves it alone", async () => {
    const w = await seedHeld({ prompt: "Keep me" });
    const sessionId = (await one(w.stub, "SELECT id FROM sessions"))!["id"];
    const t2 = ok(await prompt(w, sessionId, "Delete me"));
    const before = (await wsRow(w.stub))["items_rev"];
    expect(codeOf(await w.stub.deleteQueuedTurn({ turnId: t2.id }))).toBe("OK");
    // 02 Rules: "Every change to items increments workspace.items_rev by 1"
    expect((await wsRow(w.stub))["items_rev"]).toBe(before + 1);
    expect(codeOf(await w.stub.deleteQueuedTurn({ turnId: t2.id }))).toBe("NOT_FOUND");
    expect((await wsRow(w.stub))["items_rev"]).toBe(before + 1);
  });

  it("reorderQueue sets the order of the queued turns", async () => {
    const w = await seedHeld({ prompt: "One" });
    const sessionId = (await one(w.stub, "SELECT id FROM sessions"))!["id"];
    const t1 = (await one(w.stub, "SELECT id FROM turns"))!["id"];
    const t2 = ok(await prompt(w, sessionId, "Two")).id;
    const t3 = ok(await prompt(w, sessionId, "Three")).id;
    expect(codeOf(await w.stub.reorderQueue({ turnIds: [t3, t1, t2] }))).toBe("OK");
    expect((await detail(w.stub)).queue).toEqual([t3, t1, t2]);
    const pos = await rows(w.stub, "SELECT id, queue_pos FROM turns ORDER BY queue_pos");
    expect(pos.map((r) => r["id"])).toEqual([t3, t1, t2]);
  });

  it("reorderQueue returns VALIDATION_FAILED unless turnIds are exactly the queued turns", async () => {
    const w = await seedHeld({ prompt: "One" });
    const sessionId = (await one(w.stub, "SELECT id FROM sessions"))!["id"];
    const t1 = (await one(w.stub, "SELECT id FROM turns"))!["id"];
    const t2 = ok(await prompt(w, sessionId, "Two")).id;
    const t3 = ok(await prompt(w, sessionId, "Three")).id;
    for (const turnIds of [[t1, t2], [t1, t2, t3, newId()], [t1, t1, t2], [t3, t2, newId()], []]) {
      expect(codeOf(await w.stub.reorderQueue({ turnIds })), JSON.stringify(turnIds)).toBe(
        "VALIDATION_FAILED",
      );
    }
    ok(await w.stub.cancelTurn({ turnId: t3 }));
    expect(codeOf(await w.stub.reorderQueue({ turnIds: [t2, t1, t3] }))).toBe("VALIDATION_FAILED");
    expect((await detail(w.stub)).queue).toEqual([t1, t2]);
  });
});

describe("cancelTurn", { timeout: 30_000 }, () => {
  it("cancels a queued turn", async () => {
    const w = await seedHeld({ prompt: "Never mind" });
    const turnId = (await one(w.stub, "SELECT id FROM turns"))!["id"];
    expect(codeOf(await w.stub.cancelTurn({ turnId }))).toBe("OK");
    const t = (await turnOf(w.stub, turnId))!;
    expect(t["status"]).toBe("cancelled");
    expect(t["queue_pos"]).toBeNull();
    expect(t["ended_at"]).not.toBeNull();
    expect((await detail(w.stub)).queue).toEqual([]);
    // 02 Error codes: TURN_NOT_ACTIVE = "Cancel on a turn that is not running or queued"
    expect(codeOf(await w.stub.cancelTurn({ turnId }))).toBe("TURN_NOT_ACTIVE");
    expect(codeOf(await w.stub.cancelTurn({ turnId: newId() }))).toBe("NOT_FOUND");
  });

  it("sends session.cancel for a running turn, which ends cancelled when tempod reports it", async () => {
    const w = await readyWs({ prompt: "Long task" });
    const { sessionId, turnId } = w.first!;
    expect(codeOf(await w.stub.cancelTurn({ turnId }))).toBe("OK");
    // 02 tempod protocol: session.cancel {sessionId, turnId}
    expect(w.tempod.requestsOf("session.cancel")).toEqual([{ sessionId, turnId }]);
    await endTurn(w, sessionId, turnId, "cancelled");
    // 03 turn.ended: stopReason cancelled → cancelled
    expect((await turnOf(w.stub, turnId))!["status"]).toBe("cancelled");
    expect(codeOf(await w.stub.cancelTurn({ turnId }))).toBe("TURN_NOT_ACTIVE");
  });

  it("returns TURN_NOT_ACTIVE for a completed turn", async () => {
    const w = await readyWs({ prompt: "Quick" });
    await endTurn(w, w.first!.sessionId, w.first!.turnId);
    expect((await turnOf(w.stub, w.first!.turnId))!["status"]).toBe("completed");
    expect(codeOf(await w.stub.cancelTurn({ turnId: w.first!.turnId }))).toBe("TURN_NOT_ACTIVE");
    expect(w.tempod.requestsOf("session.cancel")).toHaveLength(0);
  });
});

describe("setSessionMode and setSessionConfig", { timeout: 30_000 }, () => {
  it("return SESSION_BUSY while the session runs a turn", async () => {
    const w = await readyWs({ prompt: "Busy" });
    const { sessionId } = w.first!;
    expect(codeOf(await w.stub.setSessionMode({ sessionId, modeId: "plan" }))).toBe("SESSION_BUSY");
    expect(codeOf(await w.stub.setSessionConfig({ sessionId, configId: "model", value: "x" }))).toBe(
      "SESSION_BUSY",
    );
    expect(w.tempod.requestsOf("session.setMode")).toHaveLength(0);
    expect(w.tempod.requestsOf("session.setConfig")).toHaveLength(0);
  });

  it("store the choice without a tempod request when the session has no live process", async () => {
    const w = await seedHeld({ prompt: "Queued" });
    const sessionId = (await one(w.stub, "SELECT id FROM sessions"))!["id"];
    expect(codeOf(await w.stub.setSessionMode({ sessionId, modeId: "plan" }))).toBe("OK");
    expect(codeOf(await w.stub.setSessionConfig({ sessionId, configId: "effort", value: "high" }))).toBe(
      "OK",
    );
    const s = (await sessionOf(w.stub, sessionId))!;
    expect(s["mode_id"]).toBe("plan");
    // 02 sessions.config_json: {configId: value} chosen by the user
    expect(JSON.parse(s["config_json"])).toEqual({ effort: "high" });
    expect(w.tempod.requestsOf("session.setMode")).toHaveLength(0);
    expect(w.tempod.requestsOf("session.setConfig")).toHaveLength(0);
    expect(codeOf(await w.stub.setSessionMode({ sessionId: newId(), modeId: "plan" }))).toBe("NOT_FOUND");
  });

  it("send session.setMode and session.setConfig to tempod for a live session and store the result", async () => {
    const w = await readyWs();
    const s = await liveSession(w);
    expect(codeOf(await w.stub.setSessionMode({ sessionId: s.id, modeId: "plan" }))).toBe("OK");
    expect(w.tempod.requestsOf("session.setMode")).toEqual([{ sessionId: s.id, modeId: "plan" }]);
    expect((await sessionOf(w.stub, s.id))!["mode_id"]).toBe("plan");
    expect(
      codeOf(await w.stub.setSessionConfig({ sessionId: s.id, configId: "thinking", value: true })),
    ).toBe("OK");
    // 02 tempod protocol: session.setConfig {sessionId, configId, value}
    expect(w.tempod.requestsOf("session.setConfig")).toEqual([
      { sessionId: s.id, configId: "thinking", value: true },
    ]);
    expect(JSON.parse((await sessionOf(w.stub, s.id))!["config_json"])).toMatchObject({ thinking: true });
  });

  it("keep the old mode when tempod fails session.setMode", async () => {
    const w = await readyWs();
    const s = await liveSession(w);
    const before = (await sessionOf(w.stub, s.id))!["mode_id"];
    w.tempod.fail("session.setMode", "INTERNAL", "no such mode");
    expect(codeOf(await w.stub.setSessionMode({ sessionId: s.id, modeId: "nope" }))).toBe("INTERNAL");
    expect((await sessionOf(w.stub, s.id))!["mode_id"]).toBe(before);
  });
});

describe("respondPermission", { timeout: 30_000 }, () => {
  it("returns NOT_FOUND for an unknown request", async () => {
    const w = await seedHeld();
    expect(codeOf(await w.stub.respondPermission({ requestId: "nope", optionId: "allow" }))).toBe(
      "NOT_FOUND",
    );
  });

  it("sends permission.respond, records the answer and clears needs_input", async () => {
    const w = await readyWs({ prompt: "Install deps" });
    const { sessionId, turnId } = w.first!;
    const options = [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ];
    await emit(w, {
      kind: "item.created",
      sessionId,
      turnId,
      item: {
        id: "perm-item",
        kind: "permission",
        status: "pending",
        content: { requestId: "req-9", toolCallId: "tc-1", title: "Run npm i", options },
        createdAt: Date.now(),
      },
    });
    await emit(w, {
      kind: "permission.requested",
      requestId: "req-9",
      sessionId,
      turnId,
      itemId: "perm-item",
      title: "Run npm i",
      options,
    });
    // 03 Attention 1: "needs_input: a permission request is pending"
    await waitFor(async () => (await detail(w.stub)).attention === "needs_input", 5000, "needs_input");
    expect(codeOf(await w.stub.respondPermission({ requestId: "req-9", optionId: "maybe" }))).toBe(
      "VALIDATION_FAILED",
    );
    expect(codeOf(await w.stub.respondPermission({ requestId: "req-9", optionId: "allow" }))).toBe("OK");
    // 02 tempod protocol: permission.respond {requestId, optionId}
    expect(w.tempod.requestsOf("permission.respond")).toEqual([{ requestId: "req-9", optionId: "allow" }]);
    expect(
      await one(w.stub, "SELECT status, chosen_option_id FROM permissions WHERE request_id = 'req-9'"),
    ).toEqual({
      status: "answered",
      chosen_option_id: "allow",
    });
    // 02 Item model: permission content gets chosenOptionId
    const item = (await one(w.stub, "SELECT content_json FROM items WHERE id = 'perm-item'"))!;
    expect(JSON.parse(item["content_json"]).chosenOptionId).toBe("allow");
    expect((await detail(w.stub)).attention).toBe("none");
    expect(codeOf(await w.stub.respondPermission({ requestId: "req-9", optionId: "allow" }))).toBe(
      "NOT_FOUND",
    );
  });
});

describe("review comments", { timeout: 30_000 }, () => {
  it("adds, lists and deletes review comments", async () => {
    const w = await seedHeld();
    expect(ok(await w.stub.listReviewComments({}))).toEqual([]);
    const c1 = ok(
      await w.stub.addReviewComment({
        path: "src/a.ts",
        lineStart: 10,
        lineEnd: 12,
        side: "new",
        body: "Rename this",
      }),
    );
    // 02 Shared types: ReviewComment = id, path, lineStart, lineEnd, side, body, status, sentTurnId, createdAt
    expect(c1).toMatchObject({
      path: "src/a.ts",
      lineStart: 10,
      lineEnd: 12,
      side: "new",
      body: "Rename this",
      status: "draft",
      sentTurnId: null,
    });
    expect(c1.id).toMatch(ULID);
    expect(typeof c1.createdAt).toBe("number");
    const c2 = ok(await w.stub.addReviewComment({ path: "README.md", body: "Whole file" }));
    // 02 review_comments.line_start: "null = whole file"
    expect(c2).toMatchObject({ path: "README.md", lineStart: null, side: null, status: "draft" });
    expect(ok(await w.stub.listReviewComments({})).map((c: { id: string }) => c.id)).toEqual([c1.id, c2.id]);
    expect(codeOf(await w.stub.deleteReviewComment({ commentId: c1.id }))).toBe("OK");
    expect(ok(await w.stub.listReviewComments({})).map((c: { id: string }) => c.id)).toEqual([c2.id]);
    expect(codeOf(await w.stub.deleteReviewComment({ commentId: c1.id }))).toBe("OK");
  });
});

describe("listCheckpoints and revertToCheckpoint", { timeout: 60_000 }, () => {
  const checkpointResult = (p: { checkpointId: string }) => ({
    commit: "1".repeat(40),
    tree: "2".repeat(40),
    parent: "3".repeat(40),
    base: "4".repeat(40),
    bundlePath: `/home/tempo/.tempod/${p.checkpointId}.bundle`,
    bundleBytes: 10,
  });

  it("returns CHECKPOINT_NOT_FOUND for an unknown checkpoint and an empty list at first", async () => {
    const w = await seedHeld();
    expect(ok(await w.stub.listCheckpoints({}))).toEqual([]);
    expect(codeOf(await w.stub.revertToCheckpoint({ checkpointId: newId() }))).toBe("CHECKPOINT_NOT_FOUND");
  });

  it("returns WORKSPACE_BUSY while a turn is queued, and reverts once the queue is empty", async () => {
    const w = await readyWs();
    const s = await liveSession(w);
    const id = newId();
    await exec(
      w.stub,
      "INSERT INTO checkpoints (id, turn_id, reason, commit_sha, tree_sha, parent_sha, base_sha, created_at) VALUES (?, NULL, 'pre_sleep', 'a', 'b', 'c', 'd', 1)",
      id,
    );
    // A failed setup holds the queue (01 Setup script), so the prompt stays queued with no op running.
    await useSettings(w, settingsWith({ scripts: { setup: "exit 1" } }));
    const setup = ok(await w.stub.rerunSetup({}));
    await emit(w, { kind: "script.exited", runId: setup.id, exitCode: 1, signal: null, timedOut: false });
    await waitFor(async () => (await detail(w.stub)).setupStatus === "failed", 5000, "setup failed");
    const t = ok(await prompt(w, s.id, "Waits for setup"));
    expect((await turnOf(w.stub, t.id))!["status"]).toBe("queued");
    expect(ok(await w.stub.listCheckpoints({}))).toEqual([
      { id, turnId: null, turnSeq: null, reason: "pre_sleep", createdAt: 1 },
    ]);
    // 03 Revert 1: "Allowed only when no turn is running or queued. Else WORKSPACE_BUSY."
    expect(codeOf(await w.stub.revertToCheckpoint({ checkpointId: id }))).toBe("WORKSPACE_BUSY");
    expect(await opsOf(w.stub, "revert")).toHaveLength(0);
    ok(await w.stub.deleteQueuedTurn({ turnId: t.id }));
    expect(codeOf(await whileDriving(w.stub, w.stub.revertToCheckpoint({ checkpointId: id })))).toBe("OK");
    expect(w.tempod.requestsOf("git.revert")).toEqual([{ checkpointId: id }]);
  });

  it("lists turn checkpoints, refuses to revert while a turn runs, then reverts and marks the transcript", async () => {
    const w = await readyWs({ prompt: "Turn one" });
    w.tempod.on("git.checkpoint", (p) =>
      p.reason === "turn_end" ? checkpointResult(p) : { unchanged: true },
    );
    const { sessionId, turnId: t1 } = w.first!;
    await endTurn(w, sessionId, t1);
    await waitFor(async () => (await turnOf(w.stub, t1))?.["checkpoint_id"] != null, 5000, "checkpoint 1");
    const c1 = (await turnOf(w.stub, t1))!["checkpoint_id"];
    // 02 Review and git: listCheckpoints → [{id, turnId, turnSeq, reason, createdAt}]
    const list = ok(await w.stub.listCheckpoints({}));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: c1, turnId: t1, turnSeq: 1, reason: "turn_end" });

    const t2 = ok(await prompt(w, sessionId, "Turn two"));
    await waitFor(
      async () => (await turnOf(w.stub, t2.id))?.["status"] === "running",
      5000,
      "turn 2 running",
    );
    expect(codeOf(await w.stub.revertToCheckpoint({ checkpointId: c1 }))).toBe("WORKSPACE_BUSY");
    await endTurn(w, sessionId, t2.id);
    await waitFor(async () => (await turnOf(w.stub, t2.id))?.["checkpoint_id"] != null, 5000, "checkpoint 2");
    await driveToState(w.stub, "ready");
    await exec(w.stub, "UPDATE workspace SET pushed = 1, last_pushed_sha = ?", "9".repeat(40));

    const res = await whileDriving(w.stub, w.stub.revertToCheckpoint({ checkpointId: c1 }));
    expect(codeOf(res)).toBe("OK");
    // 03 Revert 2: safety checkpoint with reason pre_revert; 3: git.revert {checkpointId}
    expect(w.tempod.requestsOf("git.checkpoint").map((p) => p.reason)).toContain("pre_revert");
    expect(w.tempod.requestsOf("git.revert")).toEqual([{ checkpointId: c1 }]);
    // 03 Revert 4: later turns reverted = 1; a revert_marker item
    expect((await turnOf(w.stub, t2.id))!["reverted"]).toBe(1);
    expect((await turnOf(w.stub, t1))!["reverted"]).toBe(0);
    const marker = (await one(w.stub, "SELECT * FROM items WHERE kind = 'revert_marker'"))!;
    expect(JSON.parse(marker["content_json"])).toEqual({ checkpointId: c1, toTurnSeq: 1 });
    // 03 Revert 5: pending_note, exactly
    expect((await sessionOf(w.stub, sessionId))!["pending_note"]).toBe(
      "Note: the user reverted the files to the state after turn 1. Changes made after that point are gone.",
    );
    // 03 Revert 6: HEAD is not last_pushed_sha → next push uses --force-with-lease
    expect((await wsRow(w.stub))["force_push_lease"]).toBe(1);
    // The user starts revert, so the state does not change (03 Step runner).
    expect(await stateOf(w.stub)).toBe("ready");

    const push = await whileDriving(w.stub, w.stub.commitAndPush({ message: "After revert" }));
    expect(ok(push)).toEqual({ commitSha: "f".repeat(40) });
    // 03 Commit and push 3-4: --force-with-lease=<branch>:<last_pushed_sha>, then clear the force flag
    expect(w.tempod.requestsOf("git.commitAndPush")[0]).toMatchObject({ forceWithLeaseSha: "9".repeat(40) });
    expect((await wsRow(w.stub))["force_push_lease"]).toBe(0);
  });
});

describe("commitAndPush", { timeout: 30_000 }, () => {
  it("commits and pushes, then sets pushed and last_pushed_sha", async () => {
    const w = await readyWs();
    const branch = (await detail(w.stub)).branch;
    const res = await whileDriving(w.stub, w.stub.commitAndPush({ message: "Add README" }));
    expect(ok(res)).toEqual({ commitSha: "f".repeat(40) });
    // 02 tempod protocol: git.commitAndPush {message, branch, forceWithLeaseSha?}
    expect(w.tempod.requestsOf("git.commitAndPush")).toHaveLength(1);
    expect(w.tempod.requestsOf("git.commitAndPush")[0]).toMatchObject({ message: "Add README", branch });
    expect(w.tempod.requestsOf("git.commitAndPush")[0].forceWithLeaseSha ?? null).toBeNull();
    // 03 Commit and push 4: "On success, set pushed = 1 and last_pushed_sha."
    const row = await wsRow(w.stub);
    expect(row["pushed"]).toBe(1);
    expect(row["last_pushed_sha"]).toBe("f".repeat(40));
    expect((await detail(w.stub)).pushed).toBe(true);
    expect(await stateOf(w.stub)).toBe("ready");
    // After a push the branch can no longer be renamed (02 BRANCH_ALREADY_PUSHED).
    expect(codeOf(await w.stub.renameBranch({ branch: "feature/late" }))).toBe("BRANCH_ALREADY_PUSHED");
  });

  it("passes PUSH_REJECTED through and leaves pushed and the state alone", async () => {
    const w = await readyWs();
    w.tempod.fail("git.commitAndPush", "PUSH_REJECTED", "! [rejected] (fetch first)");
    const res = await whileDriving(w.stub, w.stub.commitAndPush({ message: "Try" }));
    // 03 Commit and push 5: "A rejected push fails with PUSH_REJECTED"
    expect(codeOf(res)).toBe("PUSH_REJECTED");
    expect((await wsRow(w.stub))["pushed"]).toBe(0);
    expect((await wsRow(w.stub))["last_pushed_sha"]).toBeNull();
    // 03 Step runner: "The user starts revert and commit_push, so they do not change the state"
    expect(await stateOf(w.stub)).toBe("ready");
    expect((await opsOf(w.stub, "commit_push"))[0]!.status).toBe("failed");
  });

  it("passes NOTHING_TO_COMMIT through", async () => {
    const w = await readyWs();
    w.tempod.fail("git.commitAndPush", "NOTHING_TO_COMMIT", "clean");
    const res = await whileDriving(w.stub, w.stub.commitAndPush({ message: "Nothing" }));
    expect(codeOf(res)).toBe("NOTHING_TO_COMMIT");
    expect((await wsRow(w.stub))["pushed"]).toBe(0);
  });
});

describe("commitAndPush behind other ops", { timeout: 30_000 }, () => {
  it("waits as pending behind an op instead of returning WORKSPACE_BUSY, then runs in creation order", async () => {
    const w = await readyWs();
    await runInDurableObject(w.stub, (i: WorkspaceDO) => {
      internals(i).runner.insert("commit_push", { message: "First" }, Date.now() + 300);
    });
    const call = w.stub.commitAndPush({ message: "Second" });
    // 03 Step runner: "Ops wait as pending and start in creation order."
    await waitFor(async () => (await opsOf(w.stub, "commit_push")).length === 2, 3000, "queued op");
    expect((await opsOf(w.stub, "commit_push")).map((o) => o.status)).toEqual(["pending", "pending"]);
    const res = await whileDriving(w.stub, call);
    expect(ok(res)).toEqual({ commitSha: "f".repeat(40) });
    expect(w.tempod.requestsOf("git.commitAndPush").map((r) => r.message)).toEqual(["First", "Second"]);
  });

  it("returns its own op's error code once the queued op runs", async () => {
    const w = await readyWs();
    w.tempod.fail("git.commitAndPush", "PUSH_REJECTED", "! [rejected] (fetch first)");
    await runInDurableObject(w.stub, (i: WorkspaceDO) => {
      internals(i).runner.insert("commit_push", { message: "First" }, Date.now() + 300);
    });
    const res = await whileDriving(w.stub, w.stub.commitAndPush({ message: "Second" }));
    // 02 commitAndPush errors: NOTHING_TO_COMMIT, PUSH_REJECTED.
    expect(codeOf(res)).toBe("PUSH_REJECTED");
    expect(w.tempod.requestsOf("git.commitAndPush").map((r) => r.message)).toEqual(["First", "Second"]);
  });
});

describe("files and changes", { timeout: 30_000 }, () => {
  it("pass through to tempod when the container is ready", async () => {
    const w = await readyWs();
    w.tempod.on("fs.search", () => ({ matches: [{ path: "src/a.ts", line: 3, text: "const foo = 1" }] }));
    w.tempod.on("git.fileDiff", () => ({ diff: "@@ -1 +1 @@\n-a\n+b\n" }));
    // 02 Review and git: getChanges → {files, baseSha, headSha}
    expect(ok(await w.stub.getChanges({ scope: "branch" }))).toEqual({
      files: [],
      baseSha: "c".repeat(40),
      headSha: "d".repeat(40),
    });
    expect(w.tempod.requestsOf("git.changes").at(-1)).toEqual({ scope: "branch" });
    expect(ok(await w.stub.getChanges({ scope: "uncommitted" }))).toMatchObject({ files: [] });
    expect(w.tempod.requestsOf("git.changes").at(-1)).toEqual({ scope: "uncommitted" });
    expect(ok(await w.stub.getFileDiff({ scope: "branch", path: "src/a.ts" }))).toEqual({
      diff: "@@ -1 +1 @@\n-a\n+b\n",
    });
    expect(w.tempod.requestsOf("git.fileDiff")).toEqual([{ scope: "branch", path: "src/a.ts" }]);
    // 02 Files: listFiles → {paths}
    expect(ok(await w.stub.listFiles({}))).toEqual({ paths: ["README.md"] });
    // 02 Files: readFile → {content, encoding, size}; FILE_TOO_LARGE over 1 MiB
    expect(ok(await w.stub.readFile({ path: "README.md" }))).toEqual({
      content: "hello",
      encoding: "utf8",
      size: 5,
    });
    expect(w.tempod.requestsOf("fs.read").at(-1)).toEqual({ path: "README.md", maxBytes: 1024 * 1024 });
    // 02 Files: searchFiles → [{path, line, text}], at most 500
    expect(ok(await w.stub.searchFiles({ query: "foo" }))).toEqual([
      { path: "src/a.ts", line: 3, text: "const foo = 1" },
    ]);
    expect(w.tempod.requestsOf("fs.search")).toEqual([{ query: "foo", regex: false, maxResults: 500 }]);
  });

  it("pass tempod's error codes through", async () => {
    const w = await readyWs();
    w.tempod.fail("fs.read", "FILE_TOO_LARGE", "2 MiB");
    expect(codeOf(await w.stub.readFile({ path: "big.bin" }))).toBe("FILE_TOO_LARGE");
    w.tempod.fail("fs.read", "PATH_OUTSIDE_WORKSPACE", "/etc/passwd");
    expect(codeOf(await w.stub.readFile({ path: "../../etc/passwd" }))).toBe("PATH_OUTSIDE_WORKSPACE");
    w.tempod.fail("git.fileDiff", "NOT_FOUND", "no such file");
    expect(codeOf(await w.stub.getFileDiff({ scope: "branch", path: "missing.ts" }))).toBe("NOT_FOUND");
  });

  it("syncs files before sleep and serves them without waking or contacting tempod", async () => {
    const w = await readyWs();
    w.tempod.on("fs.list", () => ({ paths: ["README.md", "src/a.ts", "bin.dat"] }));
    w.tempod.on("fs.read", ({ path }) =>
      path === "bin.dat"
        ? { content: "AAE=", encoding: "base64", size: 2 }
        : { content: `saved ${path}`, encoding: "utf8", size: 10 },
    );
    await putToSleep(w);
    const before = w.tempod.requests.length;
    expect(ok(await w.stub.listFiles({}))).toEqual({ paths: ["README.md", "bin.dat", "src/a.ts"] });
    expect(ok(await w.stub.readFile({ path: "/workspace/src/a.ts" }))).toMatchObject({
      content: "saved src/a.ts",
    });
    expect(ok(await w.stub.readFile({ path: "bin.dat" }))).toEqual({
      content: "AAE=",
      encoding: "base64",
      size: 2,
    });
    expect(w.tempod.requests).toHaveLength(before);
    expect(await opsOf(w.stub, "wake")).toHaveLength(0);
    expect(await stateOf(w.stub)).toBe("sleeping");
  });

  it("does not wake on a cache miss and rejects paths outside the workspace", async () => {
    const w = await readyWs();
    await putToSleep(w);
    expect(codeOf(await w.stub.readFile({ path: "uncached.ts" }))).toBe("CONTAINER_NOT_READY");
    for (const path of ["../README.md", "/etc/passwd", "/workspace/../etc/passwd"])
      expect(codeOf(await w.stub.readFile({ path }))).toBe("PATH_OUTSIDE_WORKSPACE");
    await runInDurableObject(w.stub, (i: WorkspaceDO) => internals(i).core.setKv("filesSyncedAt", undefined));
    expect(codeOf(await w.stub.listFiles({}))).toBe("CONTAINER_NOT_READY");
    expect(await opsOf(w.stub, "wake")).toHaveLength(0);
    expect(await stateOf(w.stub)).toBe("sleeping");
  });

  it("refreshes changed files, removes deleted files and drops unreadable cached contents", async () => {
    const w = await readyWs();
    const sync = () => runInDurableObject(w.stub, (i: WorkspaceDO) => internals(i).core.files.sync());
    await sync();
    w.tempod.on("fs.list", () => ({ paths: ["src/renamed.ts"] }));
    w.tempod.on("fs.read", () => ({ content: "updated", encoding: "utf8", size: 7 }));
    const seq = await emit(w, {
      kind: "git.changed",
      files: [
        { path: "src/renamed.ts", oldPath: "README.md", status: "renamed", additions: 1, deletions: 1 },
      ],
      additions: 1,
      deletions: 1,
    });
    await waitFor(
      async () => Number((await wsRow(w.stub))["tempod_acked_seq"]) >= seq,
      5000,
      "file event applied",
    );
    await waitFor(
      async () =>
        (await one(w.stub, "SELECT response_json FROM file_cache WHERE path = 'src/renamed.ts'"))?.[
          "response_json"
        ] != null,
      8000,
      "file cache synced",
    );
    expect(await one(w.stub, "SELECT path FROM file_cache WHERE path = 'README.md'")).toBeUndefined();
    expect(
      await runInDurableObject(w.stub, (i: WorkspaceDO) => internals(i).core.files.read("src/renamed.ts")),
    ).toMatchObject({ content: "updated" });
    w.tempod.fail("fs.read", "FILE_TOO_LARGE");
    await putToSleep(w);
    expect(ok(await w.stub.listFiles({}))).toEqual({ paths: ["src/renamed.ts"] });
    expect(codeOf(await w.stub.readFile({ path: "src/renamed.ts" }))).toBe("CONTAINER_NOT_READY");
  });

  it("keeps the previous snapshot and completes sleep when syncing fails", async () => {
    const w = await readyWs();
    await runInDurableObject(w.stub, (i: WorkspaceDO) => internals(i).core.files.sync());
    w.tempod.fail("fs.list", "INTERNAL");
    await putToSleep(w);
    expect(ok(await w.stub.listFiles({}))).toEqual({ paths: ["README.md"] });
    expect(ok(await w.stub.readFile({ path: "README.md" }))).toMatchObject({ content: "hello" });
    expect(await stateOf(w.stub)).toBe("sleeping");
  });

  it("bounds cache storage and excludes files absent from the non-ignored tree", async () => {
    const w = await readyWs();
    await runInDurableObject(w.stub, async (i: WorkspaceDO) => {
      const core = internals(i).core;
      await core.files.sync();
      core.files.rememberFile(".env", { content: "ignored", encoding: "utf8", size: 7 });
      expect(() => core.files.read(".env")).toThrow();
      core.files.rememberList(Array.from({ length: 20 }, (_, n) => `file-${n}.txt`));
      const content = "x".repeat(900_000);
      for (let n = 0; n < 20; n++)
        core.files.rememberFile(`file-${n}.txt`, { content, encoding: "utf8", size: content.length });
    });
    const total = await one(w.stub, "SELECT SUM(bytes) AS bytes FROM file_cache");
    expect(Number(total?.["bytes"])).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(await one(w.stub, "SELECT path FROM file_cache WHERE path = '.env'")).toBeUndefined();
  });

  it("validates file_cache.response_json on read and write (02, Conventions)", async () => {
    const w = await readyWs();
    await runInDurableObject(w.stub, async (i: WorkspaceDO) => {
      const { files } = internals(i).core;
      await files.sync();
      files.rememberFile("README.md", { content: "x", encoding: "latin1", size: 1 } as never);
      expect(() => files.read("README.md")).toThrow();
    });
    expect(await one(w.stub, "SELECT response_json FROM file_cache WHERE path = 'README.md'")).toEqual({
      response_json: null,
    });
    await putToSleep(w);
    await exec(w.stub, "UPDATE file_cache SET response_json = ? WHERE path = 'README.md'", '{"content":5}');
    expect(codeOf(await w.stub.readFile({ path: "README.md" }))).toBe("CONTAINER_NOT_READY");
    expect(await stateOf(w.stub)).toBe("sleeping");
  });

  it("return CONTAINER_NOT_READY while the workspace starts", async () => {
    const w = await seedHeld();
    expect(codeOf(await w.stub.getChanges({ scope: "branch" }))).toBe("CONTAINER_NOT_READY");
    expect(codeOf(await w.stub.listFiles({}))).toBe("CONTAINER_NOT_READY");
    expect(codeOf(await w.stub.readFile({ path: "README.md" }))).toBe("CONTAINER_NOT_READY");
    expect(codeOf(await w.stub.searchFiles({ query: "x" }))).toBe("CONTAINER_NOT_READY");
    expect(w.tempod.requests).toHaveLength(0);
  });

  it("return CONTAINER_NOT_READY and start a wake when sleeping (runScript too)", async () => {
    const w = await readyWs();
    await useSettings(
      w,
      settingsWith({ scripts: { run: { dev: { command: "npm run dev", cwd: "", default: true } } } }),
    );
    await putToSleep(w);
    hold(w.tempod);
    // 03 Wake triggers: "Read calls that need the container (getChanges, getFileDiff, listFiles, readFile,
    // searchFiles) return CONTAINER_NOT_READY and also start a wake. The one exception is sleeping ..."
    // getChanges starts the wake, so listFiles and readFile run in starting. runScript is a wake trigger.
    expect(codeOf(await w.stub.getChanges({ scope: "branch" }))).toBe("CONTAINER_NOT_READY");
    expect(await opsOf(w.stub, "wake")).toHaveLength(1);
    expect(await stateOf(w.stub)).toBe("starting");
    expect(codeOf(await w.stub.getFileDiff({ scope: "branch", path: "a" }))).toBe("CONTAINER_NOT_READY");
    expect(codeOf(await w.stub.listFiles({}))).toBe("CONTAINER_NOT_READY");
    expect(codeOf(await w.stub.readFile({ path: "README.md" }))).toBe("CONTAINER_NOT_READY");
    expect(codeOf(await w.stub.searchFiles({ query: "x" }))).toBe("CONTAINER_NOT_READY");
    expect(codeOf(await w.stub.runScript({ scriptId: "dev" }))).toBe("CONTAINER_NOT_READY");
    expect(await opsOf(w.stub, "wake")).toHaveLength(1);
  });

  it("each read call alone starts a wake from sleeping", async () => {
    const w = await readyWs();
    await putToSleep(w);
    hold(w.tempod);
    expect(codeOf(await w.stub.searchFiles({ query: "x" }))).toBe("CONTAINER_NOT_READY");
    expect(await opsOf(w.stub, "wake")).toHaveLength(1);
    expect(await stateOf(w.stub)).toBe("starting");
  });
});

describe("scripts", { timeout: 30_000 }, () => {
  const runScripts = {
    dev: { command: "npm run dev", cwd: "web", default: true },
    test: { command: "npm test", cwd: "", default: false },
  };

  it("runScript returns NOT_FOUND for an unknown script", async () => {
    const w = await readyWs();
    expect(codeOf(await w.stub.runScript({ scriptId: "dev" }))).toBe("NOT_FOUND");
    expect(w.tempod.requestsOf("script.start")).toHaveLength(0);
  });

  it("runScript starts the run script and listScriptRuns shows it with its log tail and exit", async () => {
    const w = await readyWs();
    await useSettings(w, settingsWith({ scripts: { run: runScripts } }));
    expect(ok(await w.stub.listScriptRuns({}))).toEqual([]);
    const run = ok(await w.stub.runScript({ scriptId: "dev" }));
    // 02 Shared types: ScriptRun = id, kind, scriptId, command, status, exitCode, signal, startedAt, endedAt
    expect(run).toMatchObject({
      kind: "run",
      scriptId: "dev",
      command: "npm run dev",
      status: "running",
      exitCode: null,
      signal: null,
      endedAt: null,
    });
    // 02 tempod protocol: script.start {runId, kind, scriptId, command, cwd, timeoutMs}
    expect(w.tempod.requestsOf("script.start")).toEqual([
      { runId: run.id, kind: "run", scriptId: "dev", command: "npm run dev", cwd: "web", timeoutMs: null },
    ]);
    await emit(w, { kind: "script.output", runId: run.id, stream: "stdout", data: "listening on 3000\n" });
    await waitFor(
      async () => ok(await w.stub.listScriptRuns({}))[0]?.logTail === "listening on 3000\n",
      5000,
      "log tail",
    );
    await emit(w, { kind: "script.exited", runId: run.id, exitCode: 0, signal: null, timedOut: false });
    await waitFor(async () => ok(await w.stub.listScriptRuns({}))[0]?.status === "exited", 5000, "exited");
    expect(ok(await w.stub.listScriptRuns({}))[0]).toMatchObject({
      id: run.id,
      status: "exited",
      exitCode: 0,
    });
  });

  it("with run_mode nonconcurrent, runScript stops the running run scripts first", async () => {
    const w = await readyWs();
    await useSettings(w, settingsWith({ scripts: { run: runScripts, run_mode: "nonconcurrent" } }));
    const dev = ok(await w.stub.runScript({ scriptId: "dev" }));
    const test = ok(await w.stub.runScript({ scriptId: "test" }));
    // 01 Run scripts: "With run_mode = nonconcurrent, starting one stops the others first."
    expect(w.tempod.requestsOf("script.stop")).toEqual([{ runId: dev.id }]);
    const order = w.tempod.requests
      .filter((r) => r.op === "script.stop" || r.op === "script.start")
      .map((r) => `${r.op}:${r.params.runId}`);
    expect(order).toEqual([`script.start:${dev.id}`, `script.stop:${dev.id}`, `script.start:${test.id}`]);
  });

  it("records failed_to_start when tempod refuses the start", async () => {
    const w = await readyWs();
    await useSettings(w, settingsWith({ scripts: { run: runScripts } }));
    w.tempod.fail("script.start", "INTERNAL", "spawn failed");
    const run = ok(await w.stub.runScript({ scriptId: "dev" }));
    // 02 script_runs.status includes failed_to_start
    expect(run.status).toBe("failed_to_start");
    expect(ok(await w.stub.listScriptRuns({}))[0]).toMatchObject({ id: run.id, status: "failed_to_start" });
  });

  it("continueAfterSetupFailure moves setup_status from failed to skipped and lets the queue run", async () => {
    const w = await readyWs();
    const s = await liveSession(w);
    await useSettings(w, settingsWith({ scripts: { setup: "exit 1" } }));
    const setup = ok(await w.stub.rerunSetup({}));
    expect(setup).toMatchObject({ kind: "setup", status: "running" });
    await emit(w, { kind: "script.exited", runId: setup.id, exitCode: 1, signal: null, timedOut: false });
    await waitFor(async () => (await detail(w.stub)).setupStatus === "failed", 5000, "setup failed");
    // 03 Attention 2: "error: ... setup_status is failed"
    expect((await detail(w.stub)).attention).toBe("error");
    // 01 Setup script: on a non-zero exit "The queue waits for one of them."
    const t = ok(await prompt(w, s.id, "After setup"));
    await sleep(200);
    expect(w.tempod.requestsOf("session.prompt")).toHaveLength(0);
    expect((await turnOf(w.stub, t.id))!["status"]).toBe("queued");

    expect(codeOf(await w.stub.continueAfterSetupFailure({}))).toBe("OK");
    // 03 Queue runner: "continueAfterSetupFailure sets it from failed to skipped"
    const d = await detail(w.stub);
    expect(d.setupStatus).toBe("skipped");
    expect(d.attention).toBe("none");
    await waitFor(
      () => w.tempod.requestsOf("session.prompt").some((p) => p.turnId === t.id),
      5000,
      "queued turn starts",
    );
    await waitFor(async () => (await d1Row(w.workspaceId))?.["attention"] !== "error", 5000, "D1 attention");
  });

  it("continueAfterSetupFailure changes nothing when setup did not fail", async () => {
    const w = await seedHeld();
    const rev = (await detail(w.stub)).rev;
    expect(codeOf(await w.stub.continueAfterSetupFailure({}))).toBe("OK");
    const d = await detail(w.stub);
    expect(d.setupStatus).toBe("none");
    expect(d.rev).toBe(rev);
  });
});

describe("internal methods: getEgressConfig and logEgress", { timeout: 30_000 }, () => {
  it("getEgressConfig returns {owner, repo, policy, allowlist} from the project and the effective settings", async () => {
    const w = await readyWs();
    // 02 WorkspaceDO RPC: getEgressConfig() returns {owner, repo, policy, allowlist}
    expect(await w.stub.getEgressConfig()).toEqual({
      owner: "acme",
      repo: "app",
      policy: "open",
      allowlist: [],
    });
    await useSettings(
      w,
      settingsWith({
        environment: { egress_policy: "allowlist", egress_allowlist: ["*.npmjs.org", "example.com"] },
      }),
    );
    expect(await w.stub.getEgressConfig()).toEqual({
      owner: "acme",
      repo: "app",
      policy: "allowlist",
      allowlist: ["*.npmjs.org", "example.com"],
    });
  });

  it("getEgressConfig fails for a workspace that was never created", async () => {
    let error: unknown = null;
    try {
      await uninitialised().getEgressConfig();
    } catch (e) {
      error = e;
    }
    expect(String(error)).toMatch(/not found/i);
  });

  it("logEgress keeps only the newest 10,000 rows on every insert", async () => {
    const w = await seedHeld();
    await exec(
      w.stub,
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000) INSERT INTO egress_log (ts, method, host, path, status, ms, rule) SELECT i, 'GET', 'example.com', '/' || i, 200, 1, 9 FROM n",
    );
    await w.stub.logEgress({ ts: 20_000, method: "GET", host: "x", path: "/", status: 200, ms: 1, rule: 8 });
    // 02 egress_log: "Newest 10,000 rows only."
    expect(await one(w.stub, "SELECT count(*) AS n, min(ts) AS lo, max(ts) AS hi FROM egress_log")).toEqual({
      n: 10_000,
      lo: 2,
      hi: 20_000,
    });
    await w.stub.logEgress({ ts: 20_001, method: "GET", host: "x", path: "/", status: 200, ms: 1, rule: 8 });
    expect((await one(w.stub, "SELECT count(*) AS n, min(ts) AS lo FROM egress_log"))!).toEqual({
      n: 10_000,
      lo: 3,
    });
  });

  it("logEgress appends rows that Diagnostics shows newest first; an unknown workspace ignores it", async () => {
    const w = await seedHeld();
    const a = {
      ts: 1000,
      method: "GET",
      host: "registry.npmjs.org",
      path: "/react",
      status: 200,
      ms: 12,
      rule: 3,
    };
    const b = { ts: 2000, method: "POST", host: "evil.example", path: "/x", status: 403, ms: 1, rule: 10 };
    await w.stub.logEgress(a);
    await w.stub.logEgress(b);
    const rowsNow = await rows(
      w.stub,
      "SELECT ts, method, host, path, status, ms, rule FROM egress_log ORDER BY id",
    );
    expect(rowsNow).toEqual([a, b]);
    // 05 Diagnostics: Egress = the newest 500 egress_log rows
    expect(ok(await w.stub.getDiagnostics({})).egress).toEqual([b, a]);
    await expect(uninitialised().logEgress(a)).resolves.toBeUndefined();
  });
});

describe("getDiagnostics", { timeout: 30_000 }, () => {
  it("returns {ops, container, logs, egress, sessions} as in 05 Observability", async () => {
    const w = await readyWs();
    const s = await liveSession(w);
    await emit(w, { kind: "log", level: "warn", msg: "disk almost full", data: { pct: 91 } });
    await waitFor(
      async () => (await wsRow(w.stub))["tempod_incarnation"] === w.tempod.incarnation,
      5000,
      "incarnation",
    );
    await waitFor(async () => ok(await w.stub.getDiagnostics({})).logs.length === 1, 5000, "log event");
    const diag = ok(await w.stub.getDiagnostics({}));
    expect(Object.keys(diag).sort()).toEqual(["container", "egress", "logs", "ops", "sessions"]);
    // Ops: status, steps, timings and errors (05: timings as {"<step>": <ms>})
    const create = diag.ops.find((o: { kind: string }) => o.kind === "create")!;
    expect(create).toMatchObject({ kind: "create", status: "done", errorCode: null, errorDetail: null });
    expect(Object.keys(create.timings).sort()).toEqual([
      "container.start",
      "repo.clone",
      "settings.read",
      "setup.run",
      "tempod.connect",
    ]);
    // Container: state, instance, image ref, snapshot list, tempod version and incarnation
    expect(diag.container).toMatchObject({
      state: "ready",
      running: true,
      instance: "standard-3",
      imageRef: "registry.example/workspace@sha256:1111",
      snapshots: [],
      tempodVersion: "test",
      incarnation: w.tempod.incarnation,
    });
    // Logs: the newest 200 log events
    expect(diag.logs).toEqual([
      expect.objectContaining({ level: "warn", msg: "disk almost full", data: { pct: 91 } }),
    ]);
    expect(diag.egress).toEqual([]);
    // Sessions: each session's agent, ACP session id, capabilities and live or not
    expect(diag.sessions).toEqual([
      {
        id: s.id,
        agent: "claude",
        acpSessionId: (await sessionOf(w.stub, s.id))!["acp_session_id"],
        capabilities: { promptCapabilities: { image: true } },
        live: true,
      },
    ]);
  });

  it("returns NOT_FOUND for a workspace that was never created", async () => {
    expect(codeOf(await uninitialised().getDiagnostics({}))).toBe("NOT_FOUND");
  });
});

describe("PR title contract", () => {
  it("persists closed and merged titles in refresh and detail even when status does not change", async () => {
    const o = await seedProject();
    const { stub } = await seedWorkspace(o);
    await runInDurableObject(stub, (instance: WorkspaceDO) => {
      const core = internals(instance).core;
      core.updateWs({ prNumber: 17, prState: "closed", checksState: null });
      core.ghToken = { token: "fake", expiresAt: Date.now() + 3600000 };
    });
    const pull = vi.spyOn(github, "getPullRequest");
    const checks = vi.spyOn(github, "listCheckRuns").mockResolvedValue([]);
    try {
      for (const merged of [false, true]) {
        const title = merged ? "Merged title" : "Closed title";
        pull.mockResolvedValue({
          number: 17,
          title,
          state: "closed",
          merged,
          merged_at: merged ? "2026-10-11" : null,
          draft: false,
          head: { sha: "abc" },
        } as never);
        expect(ok(await stub.refreshPullRequest({}))).toMatchObject({
          prTitle: title,
          prState: merged ? "merged" : "closed",
        });
        expect((await detail(stub)).prTitle).toBe(title);
      }
      pull.mockResolvedValue({
        number: 17,
        title: "Renamed merged title",
        state: "closed",
        merged: true,
        merged_at: "2026-10-11",
        draft: false,
        head: { sha: "abc" },
      } as never);
      await stub.refreshPullRequest({});
      expect((await detail(stub)).prTitle).toBe("Renamed merged title");
    } finally {
      pull.mockRestore();
      checks.mockRestore();
    }
  });
});

describe("workspace from a PR (03, Create a workspace)", { timeout: 30_000 }, () => {
  it("init stores the PR number, state and title, and status polling starts", async () => {
    const seeded = await seedProject();
    await seedCredentials(seeded.userId);
    const workspaceId = newId();
    const slug = `pr-${++counter}`;
    const branch = "feature/retries";
    await insertD1Workspace(seeded, { id: workspaceId, slug, branch });
    const stub = env.WORKSPACE.getByName(workspaceId);
    await installFakes(stub);
    const summary = ok(
      await stub.init({
        ...initInput({ workspaceId, seeded, slug, branch }),
        source: { kind: "pr", number: 42 },
        pr: { number: 42, state: "draft", title: "Add retries" },
      }),
    );
    // 03 init 1: "For source.kind = "pr", set pr_number and pr_state, and keep the PR title"
    expect(summary).toMatchObject({ prNumber: 42, prState: "draft" });
    expect(await detail(stub)).toMatchObject({ prNumber: 42, prState: "draft", prTitle: "Add retries" });
    expect(await wsRow(stub)).toMatchObject({ pr_number: 42, pr_state: "draft" });
    await waitFor(async () => (await d1Row(workspaceId))?.["pr_number"] === 42, 5000, "D1 pr_number");
    expect((await d1Row(workspaceId))!["pr_state"]).toBe("draft");

    // 03 Status polling: while a UI socket is open and pr_number is set.
    await runInDurableObject(stub, (i: WorkspaceDO) => {
      internals(i).core.ghToken = { token: "fake", expiresAt: Date.now() + 3_600_000 };
    });
    const pull = vi.spyOn(github, "getPullRequest").mockResolvedValue({
      number: 42,
      title: "Add retries to jobs",
      state: "open",
      merged: false,
      merged_at: null,
      draft: false,
      head: { sha: "abc" },
    } as never);
    const checks = vi.spyOn(github, "listCheckRuns").mockResolvedValue([]);
    try {
      const ui = await openUi({ workspaceId, stub } as Ws);
      await runDurableObjectAlarm(stub);
      await waitFor(() => pull.mock.calls.length > 0, 5000, "PR poll");
      expect(pull.mock.calls[0]![2]).toBe(42);
      await waitFor(async () => (await detail(stub)).prState === "open", 5000, "polled state");
      expect((await detail(stub)).prTitle).toBe("Add retries to jobs");
      ui.socket.close();
    } finally {
      pull.mockRestore();
      checks.mockRestore();
    }
  });

  it("a workspace from a branch or a new branch has no PR", async () => {
    const w = await seedHeld();
    expect(await detail(w.stub)).toMatchObject({ prNumber: null, prState: null, prTitle: null });
  });
});

describe("errored workspaces (03, Transitions: any wake trigger)", { timeout: 30_000 }, () => {
  /** A workspace in `error` with no create or wake op left, as after a step failed for good. */
  const errored = async () => {
    const w = await seedHeld({ prompt: "First" });
    await runInDurableObject(w.stub, (i: WorkspaceDO) => {
      const { core, runner } = internals(i);
      for (const kind of ["create", "wake"] as const) {
        const op = runner.find(kind);
        if (op) runner.cancel(op.id);
      }
      core.setState("error", { code: "CONTAINER_START_FAILED", detail: "test" });
    });
    expect(await stateOf(w.stub)).toBe("error");
    return w;
  };
  const restarted = async (w: Ws) => {
    const wakes = (await opsOf(w.stub, "wake")).filter(
      (o) => o.status === "pending" || o.status === "running",
    );
    expect(wakes).toHaveLength(1);
    expect(await stateOf(w.stub)).toBe("starting");
  };
  const sessionIdOf = async (w: Ws) => (await one(w.stub, "SELECT id FROM sessions"))!["id"] as string;

  const NOT_READY = "CONTAINER_NOT_READY";
  const triggers: Array<[string, string, (w: Ws) => Promise<string>]> = [
    ["sendPrompt", "OK", async (w) => codeOf(await prompt(w, await sessionIdOf(w), "Again"))],
    ["createSession", "OK", async (w) => codeOf(await w.stub.createSession({ agent: "claude" }))],
    ["wakeWorkspace", "OK", async (w) => codeOf(await w.stub.wakeWorkspace({}))],
    ["rerunSetup", NOT_READY, async (w) => codeOf(await w.stub.rerunSetup({}))],
    [
      "runScript",
      NOT_READY,
      async (w) => {
        await runInDurableObject(w.stub, (i: WorkspaceDO) => {
          const run = { dev: { command: "npm run dev", cwd: "", default: true } };
          internals(i).core.updateWs({
            settingsJson: JSON.stringify(settingsWith({ scripts: { run } })),
          });
        });
        return codeOf(await w.stub.runScript({ scriptId: "dev" }));
      },
    ],
    ["getChanges", NOT_READY, async (w) => codeOf(await w.stub.getChanges({ scope: "branch" }))],
    [
      "getFileDiff",
      NOT_READY,
      async (w) => codeOf(await w.stub.getFileDiff({ scope: "branch", path: "README.md" })),
    ],
    ["listFiles", NOT_READY, async (w) => codeOf(await w.stub.listFiles({}))],
    ["readFile", NOT_READY, async (w) => codeOf(await w.stub.readFile({ path: "README.md" }))],
    ["searchFiles", NOT_READY, async (w) => codeOf(await w.stub.searchFiles({ query: "x" }))],
    [
      "a terminal WebSocket",
      "101",
      async (w) => {
        const res = await w.stub.fetch(`https://tempo.test/api/ws/terminal/${w.workspaceId}/t1`, {
          headers: { Upgrade: "websocket" },
        });
        res.webSocket?.accept();
        res.webSocket?.close();
        return String(res.status);
      },
    ],
    [
      "a preview request",
      "200",
      async (w) => {
        const cookie = await runInDurableObject(w.stub, (i: WorkspaceDO) =>
          previewCookie(internals(i).core.ws().previewKey, 3000),
        );
        const res = await w.stub.previewFetch(
          new Request("https://preview.test/", { headers: { Accept: "text/html" } }),
          3000,
          cookie ?? "",
        );
        await res.body?.cancel();
        return String(res.status);
      },
    ],
  ];

  for (const [name, expected, trigger] of triggers) {
    it(`${name} restarts it`, async () => {
      const w = await errored();
      expect(await trigger(w)).toBe(expected);
      await restarted(w);
    });
  }

  // 03 Wake triggers: only `sleeping` answers listFiles and readFile from the file cache.
  const cachedReads: Array<[string, (w: Ws) => Promise<Res>]> = [
    ["listFiles", (w) => w.stub.listFiles({})],
    ["readFile", (w) => w.stub.readFile({ path: "README.md" })],
  ];
  for (const [name, read] of cachedReads) {
    it(`${name} restarts it instead of answering from the file cache`, async () => {
      const w = await errored();
      await runInDurableObject(w.stub, (i: WorkspaceDO) => {
        const { files } = internals(i).core;
        files.rememberList(["README.md"]);
        files.rememberFile("README.md", { content: "cached", encoding: "utf8", size: 6 });
        expect(files.read("README.md")).toMatchObject({ content: "cached" });
      });
      expect(codeOf(await read(w))).toBe(NOT_READY);
      await restarted(w);
    });
  }
});

describe("getDiagnostics egress filters (02, 05 Observability)", { timeout: 30_000 }, () => {
  const seedEgress = async (w: Ws) =>
    runInDurableObject(w.stub, (_i: WorkspaceDO, state: DurableObjectState) => {
      const add = (host: string, status: number, rule: number) =>
        state.storage.sql.exec(
          "INSERT INTO egress_log (ts, method, host, path, status, ms, rule) VALUES (?, 'GET', ?, '/', ?, 1, ?)",
          Date.now(),
          host,
          status,
          rule,
        );
      add("tempo.example.com", 403, 0);
      add("api.github.com", 403, 7);
      add("evil.example.net", 403, 10);
      add("registry.npmjs.org", 404, 8);
      add("openrouter.ai", 502, 4);
      add("cdn.example.org", 301, 9);
      for (let n = 0; n < 700; n++) add("Registry.NPMJS.org", 200, 8);
      for (let n = 0; n < 600; n++) add("api.github.com", 200, 3);
    });
  const egressOf = async (w: Ws, input: Record<string, unknown>) =>
    ok(await w.stub.getDiagnostics(input as never)).egress as Array<{
      host: string;
      status: number;
      rule: number;
    }>;

  it("filters every stored row on the server and returns the newest 500 matches", async () => {
    const w = await seedHeld();
    await seedEgress(w);
    const all = await egressOf(w, {});
    expect(all).toHaveLength(500);
    expect(all.every((r) => r.host === "api.github.com")).toBe(true);
    // The npm rows are older than the newest 500; the filter still finds them.
    const npm = await egressOf(w, { egressHost: "npmjs" });
    expect(npm).toHaveLength(500);
    expect(npm.every((r) => r.host.toLowerCase() === "registry.npmjs.org")).toBe(true);
    expect(npm.at(-1)).toMatchObject({ status: 200 });
    expect(await egressOf(w, { egressHost: "NPMJS", egressStatus: "4xx" })).toEqual([
      expect.objectContaining({ host: "registry.npmjs.org", status: 404 }),
    ]);
    expect(await egressOf(w, { egressHost: "%" })).toEqual([]);
  });

  it("blocked means rule 0, 7 or 10; 2xx to 5xx match the status class", async () => {
    const w = await seedHeld();
    await seedEgress(w);
    const blocked = await egressOf(w, { egressStatus: "blocked" });
    expect(blocked.map((r) => r.rule)).toEqual([10, 7, 0]);
    expect((await egressOf(w, { egressStatus: "3xx" })).map((r) => r.host)).toEqual(["cdn.example.org"]);
    expect((await egressOf(w, { egressStatus: "4xx" })).map((r) => r.status)).toEqual([404, 403, 403, 403]);
    expect((await egressOf(w, { egressStatus: "5xx" })).map((r) => r.host)).toEqual(["openrouter.ai"]);
    expect(await egressOf(w, { egressStatus: "2xx", egressHost: "example" })).toEqual([]);
    expect(await egressOf(w, { egressStatus: "all", egressHost: "example.com" })).toHaveLength(1);
  });
});
