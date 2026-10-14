import { Files } from "@cloudflare/sandbox";
import { seedReadyWorkspace } from "./ready-fixture.ts";
import type { WorkspaceDO } from "../../src/do/workspace/index.ts";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  AgentDefinition,
  AttachmentOptions,
  ClefRequest,
  newId,
  unwrap,
  type Agent,
  type AgentAttachment,
  type AttachmentHook,
  type ClefRequest as Request,
} from "@tempo/protocol";
import { saveDefinition } from "../../src/agents/library.ts";
import { decideHooks, decisionApi, decisionState, type MatchedHook } from "../../src/agents/decisions.ts";
import { internals, waitFor, sqlRows } from "./fakes.ts";

const definition = Schema.decodeUnknownSync(AgentDefinition)({
  handle: "auth-reviewer",
  name: "Auth reviewer",
  baseAgent: "claude",
  outputKind: "review",
});

const agent: Agent = {
  ...definition,
  id: newId(),
  version: 1,
  sha: "a".repeat(64),
  starter: null,
  createdAt: 1,
  updatedAt: 1,
};

const match = (index: number, when: string | null = "Does this affect auth?"): MatchedHook => {
  const attachment: AgentAttachment = {
    id: newId(),
    projectId: newId(),
    agentId: agent.id,
    ...Schema.decodeUnknownSync(AttachmentOptions)({}),
    createdAt: 1,
    updatedAt: 1,
    agent: { ...agent },
  };

  const hook: AttachmentHook = { event: "branch.pushed", when, threshold: 0.5 };

  return { agent, attachment, hook, index };
};

const answer = (request: Request, p: number) => ({
  answers: Object.fromEntries(
    Object.keys(request.questions).map((id) => [id, { type: "noul" as const, noul: p }]),
  ),
});

afterEach(() => vi.restoreAllMocks());

describe("Clef decisions", () => {
  it("batches 65 questions at 64, uses dot IDs and treats the threshold boundary as run", async () => {
    const call = vi
      .spyOn(decisionApi, "call")
      .mockImplementation(async (_env, request) => answer(request, 0.5));

    const hooks = Array.from({ length: 65 }, (_, i) => match(i % 8));
    const rows = await decideHooks(env, "{}", hooks, (t) => t);
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls.map(([, r]) => Object.keys(r.questions).length)).toEqual([64, 1]);
    expect(Object.keys(call.mock.calls[0]![1].questions)[0]).toBe(`${hooks[0]!.attachment.id}.0`);
    expect(rows.every((r) => r.outcome === "run" && r.p === 0.5)).toBe(true);
  });
  it("skips below the threshold, avoids AI for always, and retries missing or invalid answers once", async () => {
    const call = vi
      .spyOn(decisionApi, "call")
      .mockImplementation(async (_env, request) => answer(request, 0.49));

    expect((await decideHooks(env, "{}", [match(0)], (t) => t))[0]?.outcome).toBe("skip");
    call.mockClear();
    expect((await decideHooks(env, "{}", [match(0, null)], (t) => t))[0]?.p).toBeUndefined();
    expect(call).not.toHaveBeenCalled();
    call.mockImplementationOnce(async () => ({ answers: {} }));
    expect((await decideHooks(env, "{}", [match(0)], (t) => t))[0]?.outcome).toBe("skip");
    expect(call).toHaveBeenCalledTimes(2);
    call.mockClear();
    call.mockImplementation(async (_env, request) => answer(request, Number.NaN));
    expect((await decideHooks(env, "{}", [match(0)], (t) => t))[0]?.outcome).toBe("error");
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("ends a hung call after the bounded retry and never defaults a question to run", async () => {
    const call = vi.spyOn(decisionApi, "call").mockImplementation(() => new Promise(() => {}));
    const rows = await decideHooks(env, "{}", [match(0)], (t) => t, 10);
    expect(rows[0]?.outcome).toBe("error");
    expect(call).toHaveBeenCalledTimes(2);
  });
});

const setup = async () => {
  vi.spyOn(Files.prototype, "readFile").mockImplementation(async () => new Response("abc"));
  const w = await seedReadyWorkspace({ credentials: ["claude"] });
  const agent = await saveDefinition(env, w.seeded.userId, definition);
  const session = unwrap(await w.stub.createSession({ agent: "claude" }));
  w.tempod.on("git.checkpoint", () => ({
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    parent: "c".repeat(40),
    base: "d".repeat(40),
    bundlePath: "/checkpoint.bundle",
    bundleBytes: 3,
  }));

  return { ...w, project: w.seeded, agent, sid: session.id };
};

const attach = async (w: Awaited<ReturnType<typeof setup>>, hooks: AttachmentHook[]) => {
  const id = newId();
  await env.DB.prepare(
    "INSERT INTO project_agents(id,project_id,agent_id,hooks_json,created_at,updated_at) VALUES (?,?,?,?,0,0)",
  )
    .bind(id, w.project.projectId, w.agent.id, JSON.stringify(hooks))
    .run();
  unwrap(await w.stub.agentsChanged());

  return id;
};

const appendPush = (w: Awaited<ReturnType<typeof setup>>, key: string, changeId?: string) =>
  runInDurableObject(w.stub, async (i: WorkspaceDO) => {
    const core = internals(i).core;
    core.lifecycle.recordCause({
      type: "tempo.branch.pushed",
      source: "tempo",
      changeId,
      dedupeKey: key,
      payload: { branch: "tempo/auth", commitSha: "a".repeat(40) },
    });
    await core.lifecycle.drain();
  });

describe("workspace decisions", { timeout: 15000 }, () => {
  it("uses a fake AI binding to run one attachment for either hook and deduplicates replay", async () => {
    const w = await setup();

    const attachmentId = await attach(w, [
      { event: "branch.pushed", when: "Auth?", threshold: 0.5 },
      { event: "branch.pushed", when: "Login?", threshold: 0.8 },
    ]);

    const calls: Request[] = [];
    await runInDurableObject(w.stub, (i: WorkspaceDO) =>
      Object.assign(internals(i).core.env, {
        AI: {
          run: async (model: string, input: Request) => {
            expect(model).toBe("@cf/cloudflare/clef-flash");
            calls.push(input);

            return answer(input, 0.75);
          },
        },
      }),
    );
    await appendPush(w, "push:auth");
    await waitFor(async () => unwrap(await w.stub.listRuns({})).length === 1);
    const runs = unwrap(await w.stub.listRuns({}));
    expect(runs[0]?.attachmentId).toBe(attachmentId);
    expect(runs[0]?.decisionP).toBe(0.75);

    const events = unwrap(await w.stub.listLifecycleEvents({})).events.filter(
      (e) => e.event.type === "run.decided",
    );

    expect(
      events.map((e) => (e.event.type === "run.decided" ? e.event.payload.outcome : "unexpected")).sort(),
    ).toEqual(["run", "skip"]);
    expect(calls).toHaveLength(1);
    await waitFor(() => w.tempod.requestsOf("session.prompt").length === 1);
    expect(unwrap(await w.stub.listRuns({}))[0]?.status).toBe("running");
    await appendPush(w, "push:auth");
    expect(unwrap(await w.stub.listRuns({}))).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
  it("keeps state bounded and redacted without reading file contents or env", async () => {
    const w = await setup();
    const token = "sk-ant-oat01-test-token-value";
    w.tempod.on("git.changes", () => ({
      files: Array.from({ length: 700 }, (_, i) => ({
        path: `src/${i}-${token}-` + "x".repeat(100),
        status: "modified",
        additions: 1,
        deletions: 2,
      })),
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    }));
    const reads = w.tempod.requestsOf("fs.read").length;

    const state = await runInDurableObject(w.stub, async (i: WorkspaceDO) => {
      const core = internals(i).core;
      const changeId = newId();

      const event = core.lifecycle.append({
        type: "tempo.change.created",
        source: "tempo",
        changeId,
        sessionId: w.sid,
        dedupeKey: `change:${changeId}:created`,
        payload: { origin: "request", text: token + "😀".repeat(4000) },
      })!;

      return decisionState(core, core.lifecycle.event(event));
    });

    expect(new TextEncoder().encode(state).length).toBeLessThanOrEqual(32768);

    const parsed = Schema.decodeUnknownSync(
      Schema.Struct({
        change: Schema.Struct({ text: Schema.String }),
        files: Schema.Array(Schema.Struct({ path: Schema.String })),
      }),
    )(JSON.parse(state));

    expect(new TextEncoder().encode(parsed.change.text).length).toBeLessThanOrEqual(4096);
    expect(parsed.files.length).toBeLessThanOrEqual(500);
    expect(parsed.files.length).toBeGreaterThan(0);
    expect(state).not.toContain(token);
    expect(state).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(w.tempod.requestsOf("git.fileDiff")).toEqual([]);
    expect(w.tempod.requestsOf("fs.read")).toHaveLength(reads);
    expect(Schema.is(ClefRequest)({ model: "clef-flash", state, questions: {} })).toBe(true);
  });
  it("records a skipped probability, creates one quiet line and admits no run", async () => {
    const w = await setup();
    await attach(w, [{ event: "prompt", when: "Auth?", threshold: 0.6 }]);

    const calls = vi
      .spyOn(decisionApi, "call")
      .mockImplementation(async (_env, request) => answer(request, 0.2));

    const turn = unwrap(
      await w.stub.sendPrompt({
        sessionId: w.sid,
        text: "Docs only",
        mentions: [],
        attachmentIds: [],
        reviewCommentIds: [],
      }),
    );

    await waitFor(async () =>
      unwrap(await w.stub.listLifecycleEvents({})).events.some((e) => e.event.type === "run.decided"),
    );
    expect(unwrap(await w.stub.listRuns({}))).toEqual([]);

    const decisions = unwrap(await w.stub.listLifecycleEvents({})).events.filter(
      (e) => e.event.type === "run.decided",
    );

    expect(decisions[0]?.event.payload).toMatchObject({ outcome: "skip", p: 0.2, threshold: 0.6 });
    const notices = await sqlRows(w.stub, "SELECT content_json FROM items WHERE kind='notice'");
    expect(notices).toHaveLength(1);
    expect(JSON.parse(String(notices[0]!.content_json))).toEqual({
      level: "info",
      text: "@auth-reviewer 20%",
      eventId: decisions[0]!.event.causationId,
    });
    expect(calls).toHaveBeenCalledTimes(1);
    expect(turn.sessionId).toBe(w.sid);
  });
  it("records error after one retry, shows Run anyway and still permits a direct request", async () => {
    const w = await setup();
    await attach(w, [{ event: "prompt", when: "Auth?", threshold: 0.5 }]);
    const call = vi.spyOn(decisionApi, "call").mockRejectedValue(new Error("Unavailable"));
    unwrap(
      await w.stub.sendPrompt({
        sessionId: w.sid,
        text: "Auth",
        mentions: [],
        attachmentIds: [],
        reviewCommentIds: [],
      }),
    );
    await waitFor(async () =>
      unwrap(await w.stub.listLifecycleEvents({})).events.some((e) => e.event.type === "run.decided"),
    );
    expect(call).toHaveBeenCalledTimes(2);
    expect(unwrap(await w.stub.listRuns({}))).toEqual([]);
    const notice = await sqlRows(w.stub, "SELECT content_json FROM items WHERE kind='notice'");
    expect(JSON.parse(String(notice[0]!.content_json))).toMatchObject({
      text: "Auth reviewer was not checked because the decision model did not answer.",
      agentId: w.agent.id,
    });
    const request = unwrap(await w.stub.requestAgent({ agentId: w.agent.id, sessionId: w.sid }));
    expect(unwrap(await w.stub.listRuns({})).find((r) => r.id === request.runId)).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(2);
  });
});
