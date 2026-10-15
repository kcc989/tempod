import { runFn } from "../../src/server/run.ts";
import type { WorkspaceDO } from "../../src/do/workspace/index.ts";
import { Schema } from "effect";
import { Files } from "@cloudflare/sandbox";
import { env, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentDefinition,
  newId,
  unwrap,
  type AgentDefinition as Definition,
  type JsonData,
} from "@tempo/protocol";
import { saveDefinition } from "../../src/agents/library.ts";
import { cutInput, sentResultText } from "../../src/agents/run-inputs.ts";
import { syncIdleCredentials } from "../../src/do/workspace/credential-sync.ts";
import {
  seedProject,
  seedCredentials,
  seedWorkspace,
  driveToState,
  emitEvent,
  waitApplied,
  waitFor,
  internals,
  sqlRows,
} from "./fakes.ts";

afterEach(() => vi.restoreAllMocks());

const setup = async (patch: Partial<Definition> = {}) => {
  const project = await seedProject();
  await seedCredentials(project.userId, ["claude", "codex"]);

  const definition = Schema.decodeUnknownSync(AgentDefinition)({
    handle: "checker",
    name: "Checker",
    access: "write",
    baseAgent: "claude",
    ...patch,
  });

  const agent = await saveDefinition(env, project.userId, definition);
  const w = await seedWorkspace(project);
  w.tempod.on("git.checkpoint", () => ({
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    parent: "c".repeat(40),
    base: "d".repeat(40),
    bundlePath: "/checkpoint.bundle",
    bundleBytes: 3,
  }));
  vi.spyOn(Files.prototype, "readFile").mockImplementation(async () => new Response("abc"));
  await driveToState(w.stub, ["ready"]);

  const sid = Schema.decodeUnknownSync(Schema.String)(
    (await sqlRows(w.stub, "SELECT id FROM sessions ORDER BY sort_order"))[0]!.id,
  );

  return { ...w, project, agent, sid };
};

type Fixture = Awaited<ReturnType<typeof setup>>;

const active = async (w: Fixture, index = 0) => {
  await waitFor(() => w.tempod.requestsOf("session.prompt").length > index);

  return Schema.decodeUnknownSync(
    Schema.Struct({
      turnId: Schema.String,
      sessionId: Schema.String,
      content: Schema.Array(Schema.Struct({ text: Schema.String })),
    }),
  )(w.tempod.requestsOf("session.prompt")[index]);
};

const finish = async (w: Fixture, prompt: Awaited<ReturnType<typeof active>>, usage = 10) => {
  await waitApplied(
    w.stub,
    await emitEvent(w.stub, w.tempod, {
      kind: "turn.ended",
      sessionId: prompt.sessionId,
      turnId: prompt.turnId,
      stopReason: "end_turn",
      usage: { totalTokens: usage, inputTokens: usage, outputTokens: 0 },
    }),
  );
};

const report = (w: Fixture, sessionId: string, runId: string, params: JsonData) =>
  runInDurableObject(w.stub, () =>
    w.tempod.tool({
      op: "report_result",
      sessionId,
      runId,
      params: Schema.decodeUnknownSync(Schema.Json)(params),
    }),
  );

const request = (w: Fixture) =>
  w.stub.requestAgent({ agentId: w.agent.id, sessionId: w.sid, text: "Focus on auth" }).then(unwrap);

const completed = async (w: Fixture) => {
  await waitFor(async () => unwrap(await w.stub.listRuns({}))[0]?.status === "completed");

  return unwrap(await w.stub.listRuns({}))[0]!;
};

describe("run inputs", () => {
  it("caps Unicode bytes and creates the exact send texts", () => {
    const cut = cutInput("é".repeat(100), 41);
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(41);
    expect(cut.endsWith("[cut by Tempo]")).toBe(true);
    expect(
      sentResultText("Planner", "plan", {
        status: "done",
        summary: "Build",
        steps: [{ text: "Migrate" }],
        verify: "Test",
      }),
    ).toBe("Implement this plan from Planner:\nBuild\n1. Migrate\nTest");
    expect(
      sentResultText("Reviewer", "review", {
        status: "fail",
        summary: "Fix auth",
        findings: [
          { path: "auth.ts", line: 3, text: "Validate", blocking: true },
          { path: "x", text: "Optional", blocking: false },
        ],
      }),
    ).toBe("Fix these findings from Reviewer:\nauth.ts:3 Validate\nFix auth");
    expect(sentResultText("Checker", "note", { status: "done", summary: "Done" })).toBe(
      "Result from Checker:\nDone",
    );
  });
});

describe("workspace runs", { timeout: 15000 }, () => {
  it("freezes the profile, reports over the socket, shows one origin card and sends in the same change once", async () => {
    const w = await setup({ prompt: "Frozen prompt", outputKind: "plan" });
    const req = await request(w);
    const prompt = await active(w);
    const start = w.tempod.requestsOf("session.start").find((p) => p.sessionId === prompt.sessionId)!;
    expect(start.profile.systemPrompt).toBe("Frozen prompt");
    expect(start.env.TEMPO_RUN_ID).toBe(req.runId);
    expect(start.env.TEMPO_RUN_OUTPUT_KIND).toBe("plan");
    expect(prompt.content.map((b) => b.text).join("\n")).toContain(
      'You are running as the Tempo agent "Checker"',
    );
    await saveDefinition(
      env,
      w.project.userId,
      { ...Schema.decodeUnknownSync(AgentDefinition)(w.agent), prompt: "Changed prompt" },
      w.agent.id,
    );
    const bad = await report(w, prompt.sessionId, req.runId, { status: "pass", summary: "wrong" });
    expect(bad.ok).toBe(false);

    const valid = await report(w, prompt.sessionId, req.runId, {
      status: "done",
      summary: "Build",
      steps: [{ text: "Migrate" }],
      verify: "Test",
    });

    expect(valid.ok).toBe(true);
    await finish(w, prompt);
    const run = await completed(w);
    expect(run.tokens).toBe(10);
    expect(run.result?.steps).toEqual([{ text: "Migrate" }]);
    expect(run.originSessionId).toBe(w.sid);
    expect(await sqlRows(w.stub, "SELECT session_id,content_json FROM items WHERE kind='run'")).toEqual([
      { session_id: w.sid, content_json: JSON.stringify({ runId: req.runId }) },
    ]);
    expect(await sqlRows(w.stub, "SELECT status FROM sessions WHERE id=?", prompt.sessionId)).toEqual([
      { status: "closed" },
    ]);
    const sent = unwrap(await w.stub.sendRunToChat({ runId: req.runId }));
    expect(await sqlRows(w.stub, "SELECT change_id,origin FROM turns WHERE id=?", sent.turnId)).toEqual([
      { change_id: req.changeId, origin: "user" },
    ]);
    expect((await w.stub.sendRunToChat({ runId: req.runId })).ok).toBe(false);
    expect(
      (
        await report(w, prompt.sessionId, req.runId, {
          status: "done",
          summary: "late",
          steps: [{ text: "late" }],
        })
      ).ok,
    ).toBe(false);
    const sentPrompt = await active(w, 1);
    await finish(w, sentPrompt);
    await runInDurableObject(w.stub, async (i: WorkspaceDO) => internals(i).core.lifecycle.drain());
    expect(w.tempod.requestsOf("fs.read").filter((p) => p.path?.startsWith(".tempo/roles/"))).toEqual([]);
  });
  it("sends exactly one follow-up, pins once and fails when both turns omit a report", async () => {
    const w = await setup();
    await request(w);
    const first = await active(w);
    await finish(w, first);
    const next = await active(w, 1);
    expect(next.sessionId).toBe(first.sessionId);
    expect(next.content).toEqual([
      {
        text: "Tempo did not get your result. Finish the work if it is not complete, call the report_result tool, then end your turn.",
      },
    ]);
    await finish(w, next);
    await waitFor(async () => unwrap(await w.stub.listRuns({}))[0]?.status === "failed");
    const run = unwrap(await w.stub.listRuns({}))[0]!;
    expect(run.errorCode).toBe("RUN_RESULT_MISSING");
    expect(run.followUpSent).toBe(true);
    expect(run.tokens).toBe(20);
    expect(w.tempod.requestsOf("git.checkpoint").filter((p) => p.reason === "run_pin")).toHaveLength(1);
  });
  it("replaces a valid report, redacts all result strings and never logs report calls", async () => {
    const w = await setup({ outputKind: "review" });
    const req = await request(w);
    const prompt = await active(w);
    expect((await report(w, prompt.sessionId, req.runId, { status: "pass", summary: "First" })).ok).toBe(
      true,
    );
    expect(
      (
        await report(w, prompt.sessionId, req.runId, {
          status: "pass",
          summary: "Huge",
          findings: [{ path: "x", text: "😀".repeat(20000), blocking: true }],
        })
      ).ok,
    ).toBe(false);
    const token = "sk-ant-oat01-test-token-value";
    expect(
      (
        await report(w, prompt.sessionId, req.runId, {
          status: "fail",
          summary: token,
          findings: [{ path: token, text: token, blocking: true }],
        })
      ).ok,
    ).toBe(true);
    expect(
      (await report(w, prompt.sessionId, req.runId, { status: "pass", summary: "bad", extra: token })).ok,
    ).toBe(false);
    await finish(w, prompt);
    const run = await completed(w);
    expect(run.result?.summary).toBe("[redacted]");
    expect(run.result?.findings?.[0]).toEqual({ path: "[redacted]", text: "[redacted]", blocking: true });
    expect(JSON.stringify(await sqlRows(w.stub, "SELECT * FROM lifecycle_events"))).not.toContain(token);
    expect(JSON.stringify(await sqlRows(w.stub, "SELECT * FROM events"))).not.toContain(token);
    expect(await sqlRows(w.stub, "SELECT * FROM events WHERE kind='report_result'")).toEqual([]);
  });
  it("warns on read-only tree edits and completes the report", async () => {
    const w = await setup({ access: "read-only" });
    const req = await request(w);
    const prompt = await active(w);
    w.tempod.on("git.checkpoint", () => ({
      commit: "a".repeat(40),
      tree: "e".repeat(40),
      parent: "c".repeat(40),
      base: "d".repeat(40),
      bundlePath: "/checkpoint.bundle",
      bundleBytes: 3,
    }));
    await report(w, prompt.sessionId, req.runId, { status: "done", summary: "Done" });
    await finish(w, prompt);
    const run = await completed(w);
    expect(run.warning).toBe("files_changed");
    expect(run.pinCheckpointId).toBeTruthy();
    expect(w.tempod.requestsOf("session.start").find((p) => p.sessionId === prompt.sessionId)?.access).toBe(
      "read-only",
    );
  });
  it("fails even write runs when protected credentials change", async () => {
    const w = await setup();
    const req = await request(w);
    const prompt = await active(w);
    vi.mocked(Files.prototype.readFile).mockImplementation(async () => new Response("changed auth"));
    await report(w, prompt.sessionId, req.runId, { status: "done", summary: "Done" });
    await finish(w, prompt);
    await waitFor(async () => unwrap(await w.stub.listRuns({}))[0]?.status === "failed");
    expect(unwrap(await w.stub.listRuns({}))[0]?.errorCode).toBe("RUN_ACCESS_VIOLATION");
  });
  it("runs when a login file is missing, as for an owner without a Codex login", async () => {
    const w = await setup();
    vi.mocked(Files.prototype.readFile).mockImplementation(async (path: string) => {
      if (path !== "/home/tempo/.codex/auth.json") return new Response("abc");

      throw Object.assign(new Error(`readFile '${path}': No such file or directory (os error 2)`), {
        name: "SandboxFileError",
        code: "ENOENT",
        operation: "readFile",
        path,
        detail: "No such file or directory (os error 2)",
      });
    });
    const req = await request(w);
    const prompt = await active(w);
    await report(w, prompt.sessionId, req.runId, { status: "done", summary: "Done" });
    await finish(w, prompt);
    await waitFor(async () => unwrap(await w.stub.listRuns({}))[0]?.status === "completed");
    expect(unwrap(await w.stub.listRuns({}))[0]?.errorCode).toBeNull();
  });
  it("serializes write runs and cancels a waiting run without prompting it", async () => {
    const w = await setup();
    await request(w);
    await active(w);
    const second = await request(w);
    expect(unwrap(await w.stub.listRuns({})).find((r) => r.id === second.runId)?.status).toBe("queued");
    unwrap(await w.stub.cancelRun({ runId: second.runId }));
    expect(w.tempod.requestsOf("session.prompt")).toHaveLength(1);
    expect(unwrap(await w.stub.listRuns({})).find((r) => r.id === second.runId)?.status).toBe("cancelled");
  });
  it("times out and cancels the prompt before closing its session", async () => {
    const w = await setup();
    const req = await request(w);
    const prompt = await active(w);
    await runInDurableObject(w.stub, (_i, state) =>
      state.storage.sql.exec("UPDATE runs SET deadline_at=0 WHERE id=?", req.runId),
    );
    await runDurableObjectAlarm(w.stub);
    const run = unwrap(await w.stub.listRuns({}))[0]!;
    expect(run.status).toBe("timed_out");
    expect(run.errorCode).toBe("RUN_TIMED_OUT");

    const cancel = w.tempod.requests.findIndex(
      (r) => r.op === "session.cancel" && r.params.turnId === prompt.turnId,
    );

    expect(cancel).toBeGreaterThanOrEqual(0);
    expect(
      w.tempod.requests.findIndex(
        (r, i) => i > cancel && r.op === "session.close" && r.params.sessionId === prompt.sessionId,
      ),
    ).toBeGreaterThan(cancel);
  });
  it("cancels during startup without sending a prompt or deleting its turn", async () => {
    const w = await setup();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const original = w.tempod.handlers.get("session.start")!;
    w.tempod.on("session.start", async (params, op) => {
      await blocked;

      return original(params, op);
    });
    const req = await request(w);
    await waitFor(() => w.tempod.requestsOf("session.start").length > 0);
    unwrap(await w.stub.cancelRun({ runId: req.runId }));
    release();
    await waitFor(async () => runInDurableObject(w.stub, (i: WorkspaceDO) => !internals(i).core.queueBusy));
    expect(w.tempod.requestsOf("session.prompt")).toHaveLength(0);
    const run = unwrap(await w.stub.listRuns({}))[0]!;
    expect(await sqlRows(w.stub, "SELECT status FROM turns WHERE session_id=?", run.sessionId)).toEqual([
      { status: "cancelled" },
    ]);
  });
  it("deduplicates dispatch across incarnation changes and resumes token accounting once", async () => {
    const w = await setup();
    const req = await request(w);
    const prompt = await active(w);
    await report(w, prompt.sessionId, req.runId, { status: "done", summary: "Done" });
    await runInDurableObject(w.stub, (i: WorkspaceDO) => {
      const core = internals(i).core;
      core.ctx.storage.sql.exec(
        "UPDATE turns SET status='completed',usage_json=?,ended_at=?,checkpoint_id=(SELECT pin_checkpoint_id FROM runs WHERE id=?) WHERE id=?",
        JSON.stringify({ totalTokens: 8, inputTokens: 8, outputTokens: 0 }),
        Date.now(),
        req.runId,
        prompt.turnId,
      );
      core.ctx.storage.sql.exec("UPDATE sessions SET status='idle' WHERE id=?", prompt.sessionId);
      core.lifecycle.kick();
    });
    await completed(w);
    await runInDurableObject(w.stub, async (i: WorkspaceDO) => {
      const core = internals(i).core;
      core.ctx.storage.sql.exec("UPDATE lifecycle_events SET dispatched_at=NULL");
      await core.lifecycle.drain();
      await core.lifecycle.runs.recover();
    });
    expect(unwrap(await w.stub.listRuns({}))).toHaveLength(1);
    expect(unwrap(await w.stub.listRuns({}))[0]?.tokens).toBe(8);
    const before = unwrap(await w.stub.listLifecycleEvents({})).events.map((e) => e.event.id);
    await waitApplied(
      w.stub,
      await emitEvent(w.stub, w.tempod, { kind: "incarnation.changed", incarnation: newId() }),
    );
    expect(unwrap(await w.stub.listLifecycleEvents({})).events.map((e) => e.event.id)).toEqual(before);
  });
  it("retains failed credential pushes and applies the newest auth after protected checks", async () => {
    const w = await setup();
    const req = await request(w);
    const prompt = await active(w);
    await w.stub.pushCodexAuth("new-auth", 5);
    await w.stub.pushCodexAuth("older-auth", 4);
    expect(w.tempod.requestsOf("credential.put")).toEqual([]);
    await report(w, prompt.sessionId, req.runId, { status: "done", summary: "Done" });
    await finish(w, prompt);
    await completed(w);
    await waitFor(() => w.tempod.requestsOf("credential.put").length > 0);
    expect(w.tempod.requestsOf("credential.put")).toEqual([
      { provider: "codex", content: "new-auth", version: 5 },
    ]);
    w.tempod.fail("credential.put", "TEMPOD_UNREACHABLE");
    await runInDurableObject(w.stub, async (i: WorkspaceDO) => {
      const core = internals(i).core;
      core.pendingCodexPush = { content: "pending-auth", version: 6 };
      await expect(syncIdleCredentials(core)).rejects.toThrow();
      expect(core.pendingCodexPush).toEqual({ content: "pending-auth", version: 6 });
    });
  });
  it("records no-login failures, rejects wrong-owner requests and preserves prompt privacy", async () => {
    const w = await setup({ baseAgent: "pi" });
    const req = await request(w);
    await waitFor(async () => unwrap(await w.stub.listRuns({}))[0]?.status === "failed");
    expect(unwrap(await w.stub.listRuns({}))[0]?.errorCode).toBe("RUN_NO_AGENT");
    expect((await w.stub.requestAgent({ agentId: newId() })).ok).toBe(false);
    expect((await w.stub.sendRunToChat({ runId: req.runId })).ok).toBe(false);

    const turn = unwrap(
      await w.stub.sendPrompt({
        sessionId: w.sid,
        text: "private prompt",
        mentions: [],
        attachmentIds: [],
        reviewCommentIds: [],
      }),
    );

    expect(
      (await sqlRows(w.stub, "SELECT change_id FROM turns WHERE id=?", turn.id))[0]?.change_id,
    ).toBeTruthy();
    expect(JSON.stringify(unwrap(await w.stub.listLifecycleEvents({})))).not.toContain("private prompt");
  });
});

describe("attachment run dispatch", { timeout: 15000 }, () => {
  it("runs an always hook once, auto-sends in the same change, and makes the exhausted budget terminal", async () => {
    const w = await setup();
    const attachmentId = newId();
    await env.DB.prepare(
      "INSERT INTO project_agents(id,project_id,agent_id,hooks_json,auto_send,max_runs,timeout,created_at,updated_at) VALUES (?,?,?, ?,1,1,'20m',0,0)",
    )
      .bind(
        attachmentId,
        w.project.projectId,
        w.agent.id,
        JSON.stringify([{ event: "turn.ended", when: null, threshold: 0.5 }]),
      )
      .run();
    unwrap(await w.stub.agentsChanged());

    const user = unwrap(
      await w.stub.sendPrompt({
        sessionId: w.sid,
        text: "Fix auth",
        mentions: [],
        attachmentIds: [],
        reviewCommentIds: [],
      }),
    );

    const first = await active(w);
    expect(first.turnId).toBe(user.id);
    await finish(w, first);
    const agentPrompt = await active(w, 1);
    const run = unwrap(await w.stub.listRuns({}))[0]!;
    expect(run.attachmentId).toBe(attachmentId);
    await report(w, agentPrompt.sessionId, run.id, { status: "done", summary: "Fixed" });
    await finish(w, agentPrompt);
    const done = await completed(w);
    expect(done.sentTurnId).toBeTruthy();
    const sent = await active(w, 2);
    expect(sent.turnId).toBe(done.sentTurnId);
    expect((await sqlRows(w.stub, "SELECT change_id FROM turns WHERE id=?", sent.turnId))[0]?.change_id).toBe(
      run.changeId,
    );
    await finish(w, sent);
    await waitFor(async () => unwrap(await w.stub.listRuns({})).some((r) => r.errorCode === "RUN_LIMIT"));
    const rows = unwrap(await w.stub.listRuns({}));
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === "completed")).toHaveLength(1);
    expect(w.tempod.requestsOf("session.prompt")).toHaveLength(3);
    await runInDurableObject(w.stub, async (i: WorkspaceDO) => internals(i).core.lifecycle.drain());
    expect(unwrap(await w.stub.listRuns({}))).toHaveLength(2);
  });
  it("allows manual unattached requests but cannot send their result without an origin chat", async () => {
    const w = await setup();
    const req = unwrap(await w.stub.requestAgent({ agentId: w.agent.id }));
    const prompt = await active(w);
    await report(w, prompt.sessionId, req.runId, { status: "done", summary: "Done" });
    await finish(w, prompt);
    const run = await completed(w);
    expect(run.originSessionId).toBeNull();
    expect(run.attachmentId).toBeNull();
    const sent = await w.stub.sendRunToChat({ runId: run.id });
    expect(sent.ok ? "OK" : sent.error.code).toBe("RUN_NO_CHAT");
  });
});

it("enforces workspace ownership for every new run API", async () => {
  const w = await setup();
  const other = await seedProject();
  const token = newId();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO session(id,expires_at,token,created_at,updated_at,user_id) VALUES (?,?,?,?,?,?)",
  )
    .bind(newId(), now + 86400000, token, now, now, other.userId)
    .run();

  for (const [name, input] of [
    ["requestAgent", { workspaceId: w.workspaceId, agentId: w.agent.id }],
    ["cancelRun", { workspaceId: w.workspaceId, runId: newId() }],
    ["listRuns", { workspaceId: w.workspaceId }],
    ["sendRunToChat", { workspaceId: w.workspaceId, runId: newId() }],
  ] as const) {
    const result = await runFn(name, env, new Headers({ Authorization: `Bearer ${token}` }), input, {
      allowBearer: true,
      allowCookie: false,
    });

    expect(result.ok ? "OK" : result.error.code).toBe("NOT_FOUND");
  }
});
