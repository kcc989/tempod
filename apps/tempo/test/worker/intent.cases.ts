import { Schema } from "effect";
import { runInDurableObject } from "cloudflare:test";
import { describe, it } from "vitest";
import { IntentContent, newId, unwrap, type ToolRes } from "@tempo/protocol";
import { INTENT_TEXT, intentJudge } from "../../src/do/workspace/intent.ts";
import { jevClient, type Judge } from "../../src/judge/jev.ts";
import { emitEvent, seedProject, sqlRows, waitApplied, waitFor } from "./fakes.ts";
import * as judge from "../../src/server/handlers/judge.ts";
import * as projectProfile from "../../src/server/handlers/project-profile.ts";
import { PROFILE_HEADER } from "../../src/do/workspace/queue.ts";
import type { HandlerCtx } from "../../src/server/run.ts";
import { env } from "cloudflare:test";
import { seedReadyWorkspace } from "./ready-fixture.ts";

/** A judge that answers every question with the given risk. */
const judgeWith = (high: boolean): Judge =>
  jevClient("test-key", async () =>
    Response.json({
      model: "jev-1.14.0",
      usage: { input_tokens: 1, output_tokens: 1 },
      answers: {
        new_access: { type: "noul", noul: high ? 0.9 : 0.1 },
        security_risk: { type: "noul", noul: 0.1 },
        hard_rollback: { type: "score", score: 0.2, confidence: 1, legend: {}, probabilities: {} },
      },
    }),
  );

const setup = async (high: boolean) => {
  const w = await seedReadyWorkspace({ credentials: ["claude"] });

  w.tempod.on("session.start", () => ({
    acpSessionId: `acp-${newId()}`,
    modes: [
      { id: "auto", name: "Auto" },
      { id: "plan", name: "Plan" },
    ],
    modeId: "auto",
    configOptions: [],
    availableCommands: [],
    capabilities: { promptCapabilities: { image: true } },
    reloaded: false,
    handoff: false,
  }));
  await runInDurableObject(w.stub, () => {
    intentJudge.for = async () => judgeWith(high);
  });

  const session = unwrap(await w.stub.createSession({ agent: "claude" }));

  const prompt = (text: string) =>
    w.stub.sendPrompt({ sessionId: session.id, text, mentions: [], attachmentIds: [], reviewCommentIds: [] });

  const sent = async (index: number) => {
    await waitFor(() => w.tempod.requestsOf("session.prompt").length > index);

    return Schema.decodeUnknownSync(
      Schema.Struct({
        turnId: Schema.String,
        sessionId: Schema.String,
        content: Schema.Array(Schema.Struct({ text: Schema.String })),
      }),
    )(w.tempod.requestsOf("session.prompt")[index]);
  };

  const end = async (turn: { turnId: string; sessionId: string }) =>
    waitApplied(
      w.stub,
      await emitEvent(w.stub, w.tempod, {
        kind: "turn.ended",
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        stopReason: "end_turn",
      }),
    );

  const propose = (params: Schema.Json) =>
    runInDurableObject(w.stub, () => w.tempod.tool({ op: "propose_intent", sessionId: session.id, params }));

  const card = async () => {
    const [row] = await sqlRows(w.stub, "SELECT status, content_json FROM items WHERE kind = 'intent'");

    return row
      ? {
          status: row["status"],
          content: Schema.decodeUnknownSync(IntentContent)(JSON.parse(String(row["content_json"]))),
        }
      : null;
  };

  const modes = () => w.tempod.requestsOf("session.setMode").map((r) => r.modeId);

  return { ...w, sid: session.id, prompt, sent, end, propose, card, modes };
};

const text = (reply: ToolRes) => (reply.ok ? reply.result : `error: ${reply.error.message}`);

const INTENT = {
  goal: "Add due dates",
  approach: "A nullable column and a picker",
  notDoing: "No reminders",
};

describe("intent check (13, L-ADR-1)", { timeout: 30_000 }, () => {
  it("starts a chat read-only with the rule, waits for the owner on a risky intent, and confirms with one action", async ({
    expect,
  }) => {
    const w = await setup(true);
    unwrap(await w.prompt("Add due dates to todos"));
    const first = await w.sent(0);

    expect(first.content.map((c) => c.text)).toEqual([
      expect.any(String),
      expect.any(String),
      INTENT_TEXT.rule,
      "Add due dates to todos",
    ]);
    expect(w.modes()).toEqual(["plan"]);

    expect(text(await w.propose({ ...INTENT, goal: "a\nb\nc\nd\ne\nf" }))).toBe(
      `error: ${INTENT_TEXT.tooLong}`,
    );
    expect(text(await w.propose(INTENT))).toBe(INTENT_TEXT.byOwner);
    expect(await w.card()).toMatchObject({
      status: "pending",
      content: {
        status: "proposed",
        goal: "Add due dates",
        decidedBy: null,
        reasons: ["new_access"],
        enforced: true,
      },
    });
    expect(unwrap(await w.stub.getWorkspace({})).attention).toBe("needs_input");

    await w.end(first);
    const intentId = (await w.card())!.content.intentId;
    unwrap(await w.stub.confirmIntent({ intentId }));
    unwrap(await w.stub.confirmIntent({ intentId }));

    const next = await w.sent(1);
    expect(next.content.map((c) => c.text)).toEqual([INTENT_TEXT.confirmed]);
    expect(w.modes()).toEqual(["plan", "auto"]);
    expect(await w.card()).toMatchObject({
      status: "completed",
      content: { status: "confirmed", decidedBy: "owner" },
    });

    const events = await sqlRows(
      w.stub,
      "SELECT type FROM lifecycle_events WHERE type LIKE 'loop.intent.%' ORDER BY seq",
    );

    expect(events.map((e) => e["type"])).toEqual(["loop.intent.proposed", "loop.intent.confirmed"]);

    await w.end(next);
    unwrap(await w.prompt("Also sort by due date"));
    const later = await w.sent(2);
    expect(later.content.map((c) => c.text)).toEqual(["Also sort by due date"]);
  });

  it("lets a low-risk intent go on by the judge, and the owner's switch turns the check off", async ({
    expect,
  }) => {
    const w = await setup(false);
    unwrap(await w.prompt("Add due dates to todos"));
    const first = await w.sent(0);

    expect(text(await w.propose(INTENT))).toBe(INTENT_TEXT.byJudge);
    expect(await w.card()).toMatchObject({ content: { status: "confirmed", decidedBy: "judge" } });
    await w.end(first);
    expect((await w.sent(1)).content.map((c) => c.text)).toEqual([INTENT_TEXT.confirmed]);

    const other = await setup(true);
    unwrap(await other.stub.setIntentCheck({ sessionId: other.sid, enabled: false }));
    unwrap(await other.prompt("/go fix the typo in the footer"));
    const off = await other.sent(0);

    expect(off.content.map((c) => c.text)).toEqual([
      expect.any(String),
      expect.any(String),
      "/go fix the typo in the footer",
    ]);
    expect(other.modes()).toEqual([]);
    expect(text(await other.propose(INTENT))).toBe(INTENT_TEXT.off);
  });

  it("checks the TypeSafe AI key before it saves it, and removes it (13, L-ADR-9)", async ({ expect }) => {
    const seed = await seedProject();

    const ctx: HandlerCtx = {
      env,
      user: { id: seed.userId, name: "Owner", email: "o@example.com", image: null },
    };

    const original = judge.judgeCheck.fetch;
    const status = { value: 401 };

    try {
      judge.judgeCheck.fetch = async () =>
        status.value === 200
          ? Response.json({ model: "jev-1.14.0", answers: { ok: { type: "noul", noul: 1 } }, usage: {} })
          : Response.json({ detail: "bad key" }, { status: status.value });

      expect(await judge.getJudgeSettings(ctx)).toEqual({ keySet: false, updatedAt: null });
      await expect(judge.setJudgeKey(ctx, { key: "bad" })).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        detail: "TypeSafe AI did not accept the key.",
      });
      status.value = 200;
      expect(await judge.setJudgeKey(ctx, { key: " good " })).toMatchObject({ keySet: true });
      expect(await env.CREDENTIALS.getByName(seed.userId).getSecret("typesafe.api_key")).toBe("good");
      expect(await judge.deleteJudgeKey(ctx)).toEqual({ keySet: false, updatedAt: null });
    } finally {
      judge.judgeCheck.fetch = original;
    }
  });

  it("stores profile revisions, gives the profile to each new chat and to the get_project_profile tool (13, L-ADR-3)", async ({
    expect,
  }) => {
    const w = await setup(false);

    const ctx: HandlerCtx = {
      env,
      user: { id: w.seeded.userId, name: "Owner", email: "o@example.com", image: null },
    };

    const projectId = w.seeded.projectId;
    const source = "version: 1\nstack:\n  runtime: bun 1.3\nnotes: Use Effect for errors.\n";

    expect(await projectProfile.getProjectProfile(ctx, { projectId })).toMatchObject({
      revision: 0,
      source: "",
    });
    await expect(
      projectProfile.updateProjectProfile(ctx, { projectId, source: "version: 2\n", revision: 0 }),
    ).rejects.toMatchObject({ code: "PROFILE_INVALID", detail: "version: must be 1" });
    expect(await projectProfile.updateProjectProfile(ctx, { projectId, source, revision: 0 })).toMatchObject({
      revision: 1,
      source,
    });
    await expect(
      projectProfile.updateProjectProfile(ctx, { projectId, source, revision: 0 }),
    ).rejects.toMatchObject({
      code: "PROFILE_CHANGED",
    });

    unwrap(await w.prompt("/go add a footer"));
    const first = await w.sent(0);
    expect(first.content.map((c) => c.text)).toContain(`${PROFILE_HEADER(1)}\n${source}`);

    const reply = await runInDurableObject(w.stub, () =>
      w.tempod.tool({ op: "get_project_profile", sessionId: w.sid, params: {} }),
    );

    expect(reply).toMatchObject({ ok: true, result: { revision: 1, source } });
  });

  it("keeps the chat read-only while the intent waits, and the owner's switch decides it", async ({
    expect,
  }) => {
    const w = await setup(true);
    unwrap(await w.prompt("Add due dates to todos"));
    const first = await w.sent(0);
    expect(w.modes()).toEqual(["plan"]);

    await waitApplied(
      w.stub,
      await emitEvent(w.stub, w.tempod, {
        kind: "session.updated",
        sessionId: w.sid,
        patch: { modeId: "auto" },
      }),
    );
    await waitFor(() => w.modes().length === 2);
    expect(w.modes()).toEqual(["plan", "plan"]);
    const notices = await sqlRows(w.stub, "SELECT content_json FROM items WHERE kind = 'notice'");
    expect(notices.map((n) => JSON.parse(String(n["content_json"])).text)).toContain(INTENT_TEXT.modeKept);

    expect(text(await w.propose(INTENT))).toBe(INTENT_TEXT.byOwner);
    await w.end(first);
    const session = unwrap(await w.stub.getWorkspace({}));
    expect(session.attention).toBe("needs_input");
    unwrap(await w.stub.setIntentCheck({ sessionId: w.sid, enabled: false }));

    expect((await w.sent(1)).content.map((c) => c.text)).toEqual([INTENT_TEXT.confirmed]);
    expect(await w.card()).toMatchObject({ content: { status: "confirmed", decidedBy: "owner" } });
    expect(w.modes().at(-1)).toBe("auto");
  });
});
