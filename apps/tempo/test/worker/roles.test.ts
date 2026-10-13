import { Files } from "@cloudflare/sandbox";
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newId, unwrap, type LifecycleEvent } from "@tempo/protocol";
import { parseRoleFile } from "@tempo/settings";
import { chooseRoleAgent, matchTrigger } from "../../src/roles/match.ts";
import { parseRole, withPrecedence } from "../../src/roles/catalog.ts";
import { cutInput } from "../../src/roles/inputs.ts";
import { syncIdleCredentials } from "../../src/do/workspace/credential-sync.ts";
import {
  DEFAULT_EFFECTIVE,
  driveToState,
  emitEvent,
  internals,
  seedCredentials,
  seedProject,
  seedWorkspace,
  sqlRows,
  waitApplied,
  waitFor,
} from "./fakes.ts";
import * as handlers from "../../src/server/handlers/roles.ts";

const text = (body = "Do the job.", front = "requestable: true\naccess: write") =>
  `---\ndescription: Test job\n${front}\n---\n${body}`;
const save = async (userId: string, name: string, contents: string) => {
  await env.DB.prepare(
    "INSERT INTO user_roles (user_id,name,text,updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id,name) DO UPDATE SET text=excluded.text,updated_at=excluded.updated_at",
  )
    .bind(userId, name, contents, Date.now())
    .run();
};
afterEach(() => vi.restoreAllMocks());
const setup = async () => {
  const project = await seedProject();
  await seedCredentials(project.userId);
  await save(project.userId, "checker", text());
  const w = await seedWorkspace(project);
  vi.spyOn(Files.prototype, "mkdir").mockResolvedValue(undefined);
  w.tempod.on("git.checkpoint", () => ({
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    parent: "c".repeat(40),
    base: "d".repeat(40),
    bundlePath: "/checkpoint.bundle",
    bundleBytes: 3,
  }));
  vi.spyOn(Files.prototype, "readFile").mockImplementation(async (path) =>
    path.includes("/roles/") ? Response.json({ status: "done", summary: "Complete." }) : new Response("abc"),
  );
  await driveToState(w.stub, ["ready"]);
  return { ...w, project };
};
const finish = async (
  w: Awaited<ReturnType<typeof setup>>,
  params: { turnId: string; sessionId: string },
  usage = 10,
) => {
  const seq = await emitEvent(w.stub, w.tempod, {
    kind: "turn.ended",
    sessionId: params.sessionId,
    turnId: params.turnId,
    stopReason: "end_turn",
    usage: { totalTokens: usage, inputTokens: usage, outputTokens: 0 },
  });
  await waitApplied(w.stub, seq);
};
const activePrompt = async (w: Awaited<ReturnType<typeof setup>>, index = 0) => {
  await waitFor(() => w.tempod.requestsOf("session.prompt").length > index);
  return w.tempod.requestsOf("session.prompt")[index] as {
    turnId: string;
    sessionId: string;
    content: Array<{ text: string }>;
  };
};

describe("role matching and inputs", () => {
  it("matches exact role, result status and default user session", () => {
    const event = {
      id: newId(),
      workspaceId: newId(),
      occurredAt: 1,
      source: "agent",
      type: "agent.turn.ended",
      roleRunId: newId(),
      dedupeKey: "test",
      payload: { status: "completed", stopReason: null },
    } as LifecycleEvent;
    expect(matchTrigger({ event: "agent.turn.ended" }, event)).toBe(false);
    expect(matchTrigger({ event: "agent.turn.ended", session: "role", status: "completed" }, event)).toBe(
      true,
    );
    const completed = {
      ...event,
      source: "role",
      type: "role.run.completed",
      payload: { role: "coder", round: 1, result: { status: "done", summary: "" } },
    } as LifecycleEvent;
    expect(matchTrigger({ event: "role.run.completed", role: "coder", status: "done" }, completed)).toBe(
      true,
    );
    expect(matchTrigger({ event: "role.run.completed", role: "reviewer" }, completed)).toBe(false);
  });
  it("chooses other from credentialed agents with models", () => {
    const file = parseRoleFile("checker", text("", "requestable: true\nagent: other")).file;
    const event = { agent: "claude" } as LifecycleEvent;
    expect(chooseRoleAgent(file, event, DEFAULT_EFFECTIVE, () => true)).toBe("codex");
    expect(chooseRoleAgent(file, event, DEFAULT_EFFECTIVE, (a) => a === "pi")).toBeNull();
    expect(
      chooseRoleAgent(
        file,
        event,
        {
          ...DEFAULT_EFFECTIVE,
          agent: { ...DEFAULT_EFFECTIVE.agent, models: { ...DEFAULT_EFFECTIVE.agent.models, pi: "model" } },
        },
        (a) => a === "pi",
      ),
    ).toBe("pi");
  });
  it("shadows even invalid higher-precedence files and hashes exact text", async () => {
    const builtin = await parseRole("checker", "builtin", text());
    const user = await parseRole("checker", "user", text("User"));
    const repo = await parseRole("checker", "repo", "invalid");
    const rows = withPrecedence([builtin, user, repo]);
    expect(rows[0]!.info.shadowedBy).toBe("repo");
    expect(rows[1]!.info.shadowedBy).toBe("repo");
    expect(rows[2]!.info.error).toBeDefined();
    expect(user.info.sha).not.toBe(builtin.info.sha);
  });
  it("caps Unicode input bytes and adds the exact cut marker", () => {
    const cut = cutInput("é".repeat(100), 41);
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(41);
    expect(cut.endsWith("[cut by Tempo]")).toBe(true);
  });
});

describe("workspace lifecycle and roles", { timeout: 15000 }, () => {
  it("stores prompt cause and raw turn end exactly once, with no prompt text", async () => {
    const w = await setup();
    const sid = (await sqlRows(w.stub, "SELECT id FROM sessions ORDER BY sort_order"))[0]!.id;
    const turn = unwrap(
      await w.stub.sendPrompt({
        sessionId: sid,
        text: "private prompt",
        mentions: [],
        attachmentIds: [],
        reviewCommentIds: [],
      }),
    );
    const prompt = await activePrompt(w);
    await finish(w, prompt);
    await waitFor(
      async () =>
        (await sqlRows(w.stub, "SELECT * FROM lifecycle_events WHERE type='tempo.change.ended'")).length > 0,
    );
    const event = unwrap(await w.stub.listLifecycleEvents({})).events.find(
      (r) => r.event.type === "agent.turn.ended",
    )!;
    const count = (await sqlRows(w.stub, "SELECT * FROM lifecycle_events")).length;
    const raw = await sqlRows(w.stub, "SELECT seq FROM events WHERE kind='turn.ended'");
    await runInDurableObject(w.stub, () =>
      w.tempod.emitRaw(raw[0]!.seq, {
        kind: "turn.ended",
        turnId: turn.id,
        sessionId: sid,
        stopReason: "end_turn",
      }),
    );
    const trace = unwrap(await w.stub.getTrace({ eventId: event.event.id }));
    expect(trace.chain.map((r) => r.event.type)).toEqual(["tempo.change.created", "agent.turn.ended"]);
    expect(JSON.stringify(unwrap(await w.stub.listLifecycleEvents({})))).not.toContain("private prompt");
    expect((await sqlRows(w.stub, "SELECT * FROM lifecycle_events")).length).toBe(count);
  });
  it("runs a user role, protects its composer, stores a result and ends its change", async () => {
    const w = await setup();
    const requested = unwrap(await w.stub.requestRole({ role: "checker", text: "Focus on auth" }));
    const prompt = await activePrompt(w);
    expect(prompt.content.map((c) => c.text).join("\n")).toContain("You are working as the Tempo role");
    expect(prompt.content.map((c) => c.text).join("\n")).toContain("Focus on auth");
    const send = await w.stub.sendPrompt({
      sessionId: prompt.sessionId,
      text: "interrupt",
      mentions: [],
      attachmentIds: [],
      reviewCommentIds: [],
    });
    expect(send.ok ? "ok" : send.error.code).toBe("SESSION_BUSY");
    await finish(w, prompt);
    await waitFor(async () => unwrap(await w.stub.listRoleRuns({}))[0]?.status === "completed");
    const run = unwrap(await w.stub.listRoleRuns({}))[0]!;
    expect(run.tokens).toBe(10);
    expect(run.result?.summary).toBe("Complete.");
    expect(run.pinCheckpointId).toBeTruthy();
    expect(run.roleSha).toMatch(/^[a-f0-9]{64}$/);
    expect(requested.roleRunId).toBe(run.id);
    await waitFor(async () =>
      unwrap(await w.stub.listLifecycleEvents({ changeId: requested.changeId })).events.some(
        (e) => e.event.type === "tempo.change.ended",
      ),
    );
    expect(w.tempod.requestsOf("session.close")).toContainEqual({ sessionId: prompt.sessionId });
  });
  it("continues the same session without first-prompt blocks then fails at its limit", async () => {
    const w = await setup();
    await save(
      w.project.userId,
      "checker",
      text("Body", "requestable: true\naccess: write\nlimits:\n  continues: 1"),
    );
    await w.stub.rolesChanged();
    vi.mocked(Files.prototype.readFile).mockImplementation(async (path) =>
      path.includes("/roles/") ? new Response(null, { status: 404 }) : new Response("abc"),
    );
    const req = unwrap(await w.stub.requestRole({ role: "checker" }));
    const first = await activePrompt(w);
    await finish(w, first);
    const second = await activePrompt(w, 1);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.content).toHaveLength(1);
    expect(second.content[0]!.text).toContain("Tempo did not find your result");
    await finish(w, second);
    await waitFor(async () => unwrap(await w.stub.listRoleRuns({}))[0]?.status === "failed");
    const run = unwrap(await w.stub.listRoleRuns({ changeId: req.changeId }))[0]!;
    expect(run.errorCode).toBe("ROLE_RESULT_MISSING");
    expect(run.continuesUsed).toBe(1);
    expect(run.tokens).toBe(20);
  });
  it("detects a read-only violation, retains files and offers its pinned Revert", async () => {
    const w = await setup();
    await save(w.project.userId, "checker", text("Read", "requestable: true"));
    await w.stub.rolesChanged();
    w.tempod.on("git.checkpoint", (p) => ({
      commit: "a".repeat(40),
      tree: (p.reason === "turn_end" ? "e" : "b").repeat(40),
      parent: "c".repeat(40),
      base: "d".repeat(40),
      bundlePath: "/checkpoint.bundle",
      bundleBytes: 3,
    }));
    unwrap(await w.stub.requestRole({ role: "checker" }));
    const prompt = await activePrompt(w);
    await finish(w, prompt);
    await waitFor(
      async () => unwrap(await w.stub.listRoleRuns({}))[0]?.errorCode === "ROLE_ACCESS_VIOLATION",
    );
    const notice = (
      await sqlRows(
        w.stub,
        "SELECT content_json FROM items WHERE kind='notice' AND session_id=?",
        prompt.sessionId,
      )
    )
      .map((r) => JSON.parse(r.content_json))
      .find((r) => r.checkpointId);
    expect(notice.checkpointId).toBe(unwrap(await w.stub.listRoleRuns({}))[0]!.pinCheckpointId);
    expect(w.tempod.requestsOf("git.revert")).toHaveLength(0);
  });
  it("serializes write runs and cancels a queued run without sending a turn", async () => {
    const w = await setup();
    const first = unwrap(await w.stub.requestRole({ role: "checker" }));
    await activePrompt(w);
    const second = unwrap(await w.stub.requestRole({ role: "checker" }));
    await runInDurableObject(w.stub, async (i) => await internals(i).core.lifecycle.drain());
    const runs = unwrap(await w.stub.listRoleRuns({}));
    expect(runs.find((r) => r.id === first.roleRunId)?.status).toBe("running");
    expect(runs.find((r) => r.id === second.roleRunId)?.status).toBe("queued");
    expect(unwrap(await w.stub.cancelRoleRun({ roleRunId: second.roleRunId }))).toEqual({});
    expect(unwrap(await w.stub.listRoleRuns({})).find((r) => r.id === second.roleRunId)?.status).toBe(
      "cancelled",
    );
  });
  it("accepts ordinary prompts in the retained chat after a role ends", async () => {
    const w = await setup();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    w.tempod.on("session.close", async () => {
      await blocked;
      return {};
    });
    const requested = unwrap(await w.stub.requestRole({ role: "checker" }));
    const first = await activePrompt(w);
    await finish(w, first);
    await waitFor(async () => unwrap(await w.stub.listRoleRuns({}))[0]?.status === "completed");
    const userTurn = unwrap(
      await w.stub.sendPrompt({
        sessionId: first.sessionId,
        text: "Explain your work",
        mentions: [],
        attachmentIds: [],
        reviewCommentIds: [],
      }),
    );
    await waitFor(async () =>
      runInDurableObject(w.stub, (i) => internals(i).core.startingTurnId === userTurn.id),
    );
    expect(w.tempod.requestsOf("session.start")).toHaveLength(1);
    expect(w.tempod.requestsOf("session.prompt")).toHaveLength(1);
    release();
    const next = await activePrompt(w, 1);
    expect(next.sessionId).toBe(first.sessionId);
    expect(next.content.map((b) => b.text).join("\n")).toContain("Explain your work");
    expect(next.content.map((b) => b.text).join("\n")).not.toContain("You are working as the Tempo role");
    await finish(w, next);
    await waitFor(async () =>
      unwrap(await w.stub.listLifecycleEvents({})).events.some(
        (e) => e.event.type === "agent.turn.ended" && e.event.turnId === next.turnId,
      ),
    );
    const events = unwrap(await w.stub.listLifecycleEvents({})).events;
    const ended = events.find(
      (e) => e.event.type === "agent.turn.ended" && e.event.turnId === next.turnId,
    )!.event;
    expect(ended.roleRunId).toBeUndefined();
    expect(ended.changeId).not.toBe(requested.changeId);
    expect(unwrap(await w.stub.listRoleRuns({}))[0]!.tokens).toBe(10);
  });
  it("timeouts cancel active turns using the single alarm", async () => {
    const w = await setup();
    const req = unwrap(await w.stub.requestRole({ role: "checker" }));
    const prompt = await activePrompt(w);
    await runInDurableObject(w.stub, (_i, state) =>
      state.storage.sql.exec("UPDATE role_runs SET deadline_at=0 WHERE id=?", req.roleRunId),
    );
    await runDurableObjectAlarm(w.stub);
    const run = unwrap(await w.stub.listRoleRuns({}))[0]!;
    expect(run.status).toBe("timed_out");
    expect(run.errorCode).toBe("ROLE_TIMED_OUT");
    expect(w.tempod.requestsOf("session.cancel")).toContainEqual({
      sessionId: prompt.sessionId,
      turnId: prompt.turnId,
    });
    const cancelIndex = w.tempod.requests.findIndex((r) => r.op === "session.cancel");
    const closeIndex = w.tempod.requests.findIndex(
      (r, i) => i > cancelIndex && r.op === "session.close" && r.params.sessionId === prompt.sessionId,
    );
    expect(closeIndex).toBeGreaterThan(cancelIndex);
  });
  it("cancels during adapter startup without deleting the starting turn or sending its prompt", async () => {
    const w = await setup();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const original = w.tempod.handlers.get("session.start")!;
    w.tempod.on("session.start", async (params, op) => {
      await blocked;
      return original(params, op);
    });
    const requested = unwrap(await w.stub.requestRole({ role: "checker" }));
    await waitFor(() => w.tempod.requestsOf("session.start").length > 0);
    unwrap(await w.stub.cancelRoleRun({ roleRunId: requested.roleRunId }));
    release();
    await waitFor(async () => runInDurableObject(w.stub, (i) => !internals(i).core.queueBusy));
    expect(w.tempod.requestsOf("session.prompt")).toHaveLength(0);
    const run = unwrap(await w.stub.listRoleRuns({}))[0]!;
    expect(run.status).toBe("cancelled");
    expect(await sqlRows(w.stub, "SELECT status FROM turns WHERE session_id=?", run.sessionId)).toEqual([
      { status: "cancelled" },
    ]);
    expect(w.tempod.requestsOf("session.close")).toContainEqual({ sessionId: run.sessionId });
  });
  it("defers auth offers and pushes through role checks and keeps the newest pending version", async () => {
    const w = await setup();
    unwrap(await w.stub.requestRole({ role: "checker" }));
    const prompt = await activePrompt(w);
    const auth = JSON.stringify({
      tokens: { access_token: "new-access" },
      last_refresh: new Date().toISOString(),
    });
    const before = await env.CREDENTIALS.getByName(w.project.userId).getCodexAuth();
    const refreshedAt = Date.now();
    for (const [content, lastRefresh] of [
      [auth, refreshedAt],
      ["older-auth", refreshedAt - 1],
    ] as const) {
      await waitApplied(
        w.stub,
        await emitEvent(w.stub, w.tempod, {
          kind: "credential.changed",
          provider: "codex",
          content,
          lastRefresh,
        }),
      );
    }
    await w.stub.pushCodexAuth(auth, 5);
    await w.stub.pushCodexAuth("older-push", 4);
    expect(await env.CREDENTIALS.getByName(w.project.userId).getCodexAuth()).toEqual(before);
    expect(w.tempod.requestsOf("credential.put")).toHaveLength(0);
    await finish(w, prompt);
    await waitFor(() => w.tempod.requestsOf("credential.put").length > 0);
    expect((await env.CREDENTIALS.getByName(w.project.userId).getCodexAuth())?.content).toBe(auth);
    expect(w.tempod.requestsOf("credential.put")).toEqual([{ provider: "codex", content: auth, version: 5 }]);
    expect(unwrap(await w.stub.listRoleRuns({}))[0]!.status).toBe("completed");
  });
  it("retains pending credential pushes after a failed delivery", async () => {
    const w = await setup();
    w.tempod.fail("credential.put", "TEMPOD_UNREACHABLE");
    await runInDurableObject(w.stub, async (i) => {
      const core = internals(i).core;
      core.pendingCodexPush = { content: "pending-auth", version: 3 };
      await expect(syncIdleCredentials(core)).rejects.toThrow();
      expect(core.pendingCodexPush).toEqual({ content: "pending-auth", version: 3 });
    });
    w.tempod.failures.delete("credential.put");
    await runInDurableObject(w.stub, async (i) => {
      const core = internals(i).core;
      await syncIdleCredentials(core);
      expect(core.pendingCodexPush).toBeNull();
    });
  });
  it("waits for idle credential delivery before starting the next role's turn", async () => {
    const w = await setup();
    unwrap(await w.stub.requestRole({ role: "checker" }));
    const first = await activePrompt(w);
    unwrap(await w.stub.requestRole({ role: "checker" }));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    w.tempod.on("credential.put", async () => {
      await blocked;
      return {};
    });
    await w.stub.pushCodexAuth("new-auth", 2);
    await finish(w, first);
    await waitFor(() => w.tempod.requestsOf("credential.put").length > 0);
    await waitFor(
      async () => (await sqlRows(w.stub, "SELECT id FROM turns WHERE status='queued'")).length > 0,
    );
    expect(w.tempod.requestsOf("session.prompt")).toHaveLength(1);
    release();
    await finish(w, await activePrompt(w, 1));
    await waitFor(async () => unwrap(await w.stub.listRoleRuns({})).every((r) => r.status === "completed"));
  });
  it("starts a new change for a matching external trigger and treats ROLE_LIMIT as terminal", async () => {
    const w = await setup();
    await save(
      w.project.userId,
      "checker",
      text(
        "job",
        "on:\n  - event: tempo.branch.pushed\n  - event: role.run.failed\n    role: checker\nlimits:\n  rounds: 1",
      ),
    );
    await w.stub.rolesChanged();
    await runInDurableObject(w.stub, (i) => {
      const core = internals(i).core;
      core.ctx.storage.transactionSync(() =>
        core.lifecycle.recordCause({
          type: "tempo.branch.pushed",
          source: "tempo",
          dedupeKey: "op:test:tempo.branch.pushed",
          payload: { branch: "branch", commitSha: "a".repeat(40) },
        }),
      );
      core.lifecycle.kick();
    });
    const prompt = await activePrompt(w);
    await emitEvent(w.stub, w.tempod, {
      kind: "turn.ended",
      sessionId: prompt.sessionId,
      turnId: prompt.turnId,
      stopReason: "cancelled",
    });
    await waitFor(async () =>
      unwrap(await w.stub.listRoleRuns({})).some((r) => r.errorCode === "ROLE_LIMIT"),
    );
    await runInDurableObject(w.stub, async (i) => await internals(i).core.lifecycle.drain());
    const runs = unwrap(await w.stub.listRoleRuns({}));
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.changeId === runs[0]!.changeId)).toBe(true);
    const events = unwrap(await w.stub.listLifecycleEvents({}));
    expect(
      events.events.some(
        (e) => e.event.type === "tempo.change.created" && e.event.payload.origin === "event",
      ),
    ).toBe(true);
  });
  it("provides paginated events and user role CRUD with workspace refresh", async () => {
    const w = await setup();
    const ctx = {
      env,
      user: { id: w.project.userId, name: "Owner", email: "owner@example.com", image: null },
    };
    const added = await handlers.putUserRole(ctx, { name: "audit", text: text("audit") });
    expect(added.scope).toBe("user");
    expect((await handlers.listRoles(ctx, {})).some((r) => r.name === "audit")).toBe(true);
    expect((await handlers.getRoleText(ctx, { name: "audit", scope: "user" })).text).toContain("audit");
    expect(unwrap(await w.stub.listRoles({})).some((r) => r.name === "audit")).toBe(true);
    await handlers.deleteUserRole(ctx, { name: "audit" });
    expect((await handlers.listRoles(ctx, {})).some((r) => r.name === "audit")).toBe(false);
    await expect(handlers.putUserRole(ctx, { name: "bad", text: "bad" })).rejects.toMatchObject({
      code: "ROLE_INVALID",
    });
    await expect(handlers.deleteUserRole(ctx, { name: "missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    unwrap(await w.stub.requestRole({ role: "checker" }));
    await activePrompt(w);
    const page = unwrap(await w.stub.listLifecycleEvents({ limit: 1 }));
    expect(page.events).toHaveLength(1);
    expect(page.nextBeforeSeq).toBeTruthy();
    const next = unwrap(await w.stub.listLifecycleEvents({ beforeSeq: page.nextBeforeSeq!, limit: 1 }));
    expect(next.events[0]!.seq).toBeLessThan(page.events[0]!.seq);
  });
  it("runs the built-in chain through reviewer on another agent", async () => {
    const w = await setup();
    unwrap(await w.stub.requestRole({ role: "planner", text: "Implement auth" }));
    vi.mocked(Files.prototype.readFile).mockImplementation(async (path) => {
      if (!path.includes("/roles/")) return new Response("abc");
      return Response.json({
        status: w.tempod.requestsOf("session.prompt").length >= 3 ? "pass" : "done",
        summary: "Complete.",
      });
    });
    for (let n = 0; n < 4; n++) {
      const prompt = await activePrompt(w, n);
      await finish(w, prompt);
    }
    await waitFor(
      async () => unwrap(await w.stub.listRoleRuns({})).filter((r) => r.status === "completed").length === 4,
    );
    const runs = unwrap(await w.stub.listRoleRuns({}));
    expect(runs.map((r) => r.roleName)).toEqual(["reviewer", "ci", "coder", "planner"]);
    expect(runs[0]!.agent).toBe("codex");
    expect(runs.map((r) => r.depth)).toEqual([4, 3, 2, 1]);
    await waitFor(async () =>
      unwrap(await w.stub.listLifecycleEvents({})).events.some(
        (e) => e.event.type === "tempo.change.ended" && e.event.payload.status === "done",
      ),
    );
  });
  it.each(["max_chain_depth", "max_runs_per_change"] as const)(
    "enforces project %s before a child starts",
    async (limit) => {
      const w = await setup();
      await runInDurableObject(w.stub, (i) =>
        internals(i).core.updateWs({
          settingsJson: JSON.stringify({
            ...DEFAULT_EFFECTIVE,
            roles: { ...DEFAULT_EFFECTIVE.roles, [limit]: 1 },
          }),
        }),
      );
      unwrap(await w.stub.requestRole({ role: "planner" }));
      await finish(w, await activePrompt(w));
      await waitFor(async () =>
        unwrap(await w.stub.listRoleRuns({})).some((r) => r.errorCode === "ROLE_LIMIT"),
      );
      const run = unwrap(await w.stub.listRoleRuns({})).find((r) => r.errorCode === "ROLE_LIMIT")!;
      expect(run.errorDetail).toBe(`roles.${limit}`);
      expect(w.tempod.requestsOf("session.prompt")).toHaveLength(1);
    },
  );
  it.each(["run", "change"])("enforces the %s token cap before continuing", async (limit) => {
    const w = await setup();
    if (limit === "run") {
      await save(
        w.project.userId,
        "checker",
        text("body", "requestable: true\naccess: write\nlimits:\n  tokens: 5"),
      );
      await w.stub.rolesChanged();
    } else
      await runInDurableObject(w.stub, (i) =>
        internals(i).core.updateWs({
          settingsJson: JSON.stringify({
            ...DEFAULT_EFFECTIVE,
            roles: { ...DEFAULT_EFFECTIVE.roles, max_tokens_per_change: 5 },
          }),
        }),
      );
    vi.mocked(Files.prototype.readFile).mockImplementation(async (path) =>
      path.includes("/roles/") ? new Response(null, { status: 404 }) : new Response("abc"),
    );
    unwrap(await w.stub.requestRole({ role: "checker" }));
    await finish(w, await activePrompt(w), 5);
    await waitFor(async () => unwrap(await w.stub.listRoleRuns({}))[0]?.errorCode === "ROLE_LIMIT");
    expect(unwrap(await w.stub.listRoleRuns({}))[0]!.errorDetail).toBe(
      limit === "run" ? "limits.tokens" : "roles.max_tokens_per_change",
    );
    expect(w.tempod.requestsOf("session.prompt")).toHaveLength(1);
  });
  it("reloads repository roles with precedence and lists invalid files", async () => {
    const w = await setup();
    w.tempod.on("fs.list", () => ({ paths: [".tempo/roles/checker.md", ".tempo/roles/broken.md"] }));
    w.tempod.on("fs.read", (p) => ({
      content: p.path.endsWith("broken.md") ? "invalid" : text("Repo"),
      encoding: "utf8",
      size: 100,
    }));
    const roles = unwrap(await w.stub.reloadRoles({}));
    expect(roles.find((r) => r.name === "checker" && r.scope === "user")?.shadowedBy).toBe("repo");
    expect(roles.find((r) => r.name === "broken")?.error).toBeTruthy();
    expect(unwrap(await w.stub.getRoleText({ name: "checker", scope: "repo" })).text).toContain("Repo");
    unwrap(await w.stub.requestRole({ role: "checker" }));
    expect((await activePrompt(w)).content.some((c) => c.text === "Repo")).toBe(true);
  });
  it("redacts credential values in request events and structured results", async () => {
    const w = await setup();
    const secret = 'quoted-"secret\nvalue';
    await env.CREDENTIALS.getByName(w.project.userId).putSecret("project:test.api", secret);
    vi.mocked(Files.prototype.readFile).mockImplementation(async (path) =>
      path.includes("/roles/")
        ? Response.json({
            status: "done",
            summary: secret,
            findings: [{ path: "file", text: secret, blocking: false }],
          })
        : new Response("abc"),
    );
    unwrap(await w.stub.requestRole({ role: "checker", text: secret }));
    await finish(w, await activePrompt(w));
    await waitFor(async () => unwrap(await w.stub.listRoleRuns({}))[0]?.status === "completed");
    expect(unwrap(await w.stub.listRoleRuns({}))[0]!.result?.summary).toBe("[redacted]");
    const stored = JSON.stringify(await sqlRows(w.stub, "SELECT payload_json FROM lifecycle_events"));
    expect(stored).not.toContain("quoted-");
    expect(stored).toContain("[redacted]");
  });
  it("rejects login-file changes even for a write role", async () => {
    const w = await setup();
    unwrap(await w.stub.requestRole({ role: "checker" }));
    const prompt = await activePrompt(w);
    vi.mocked(Files.prototype.readFile).mockImplementation(
      async (path) => new Response(path.endsWith("auth.json") ? "changed auth" : "abc"),
    );
    await finish(w, prompt);
    await waitFor(
      async () => unwrap(await w.stub.listRoleRuns({}))[0]?.errorCode === "ROLE_ACCESS_VIOLATION",
    );
    expect(unwrap(await w.stub.listRoleRuns({}))[0]!.errorDetail).toContain("Protected login");
  });
  it("recovers a committed turn outcome without counting tokens twice", async () => {
    const w = await setup();
    unwrap(await w.stub.requestRole({ role: "checker" }));
    const prompt = await activePrompt(w);
    await runInDurableObject(w.stub, (i) => {
      const core = internals(i).core;
      core.ctx.storage.sql.exec(
        "UPDATE turns SET status='completed',usage_json=?,ended_at=?,checkpoint_id=(SELECT pin_checkpoint_id FROM role_runs WHERE session_id=?) WHERE id=?",
        JSON.stringify({ totalTokens: 8, inputTokens: 8, outputTokens: 0 }),
        Date.now(),
        prompt.sessionId,
        prompt.turnId,
      );
      core.ctx.storage.sql.exec("UPDATE sessions SET status='idle' WHERE id=?", prompt.sessionId);
      core.lifecycle.kick();
    });
    await waitFor(async () => unwrap(await w.stub.listRoleRuns({}))[0]?.status === "completed");
    await runInDurableObject(w.stub, async (i) => await internals(i).core.lifecycle.runs.recover());
    expect(unwrap(await w.stub.listRoleRuns({}))[0]!.tokens).toBe(8);
  });
  it("preserves lifecycle rows across incarnation changes and replays dispatch once", async () => {
    const w = await setup();
    unwrap(await w.stub.requestRole({ role: "checker" }));
    await activePrompt(w);
    const before = unwrap(await w.stub.listLifecycleEvents({})).events.map((e) => e.event.id);
    const seq = await emitEvent(w.stub, w.tempod, { kind: "incarnation.changed", incarnation: newId() });
    await waitApplied(w.stub, seq);
    await runInDurableObject(w.stub, (i) => {
      const core = internals(i).core;
      core.ctx.storage.sql.exec("UPDATE lifecycle_events SET dispatched_at=NULL");
      core.lifecycle.kick();
    });
    await runInDurableObject(w.stub, async (i) => await internals(i).core.lifecycle.drain());
    expect(unwrap(await w.stub.listRoleRuns({}))).toHaveLength(1);
    expect(unwrap(await w.stub.listLifecycleEvents({})).events.map((e) => e.event.id)).toEqual(before);
  });
  it("rejects disabled requests and unrequestable roles, and records no-agent failures", async () => {
    const w = await setup();
    expect((await w.stub.requestRole({ role: "missing" })).ok).toBe(false);
    const coder = await w.stub.requestRole({ role: "coder" });
    expect(coder.ok ? "OK" : coder.error.code).toBe("ROLE_NOT_REQUESTABLE");
    await save(w.project.userId, "checker", text("body", "requestable: true\nagent: pi"));
    await w.stub.rolesChanged();
    unwrap(await w.stub.requestRole({ role: "checker" }));
    await waitFor(async () => unwrap(await w.stub.listRoleRuns({}))[0]?.errorCode === "ROLE_NO_AGENT");
    await runInDurableObject(w.stub, (i) =>
      internals(i).core.updateWs({
        settingsJson: JSON.stringify({
          ...DEFAULT_EFFECTIVE,
          roles: { ...DEFAULT_EFFECTIVE.roles, enabled: false },
        }),
      }),
    );
    const disabled = await w.stub.requestRole({ role: "checker" });
    expect(disabled.ok ? "OK" : disabled.error.code).toBe("ROLE_LIMIT");
  });
});
