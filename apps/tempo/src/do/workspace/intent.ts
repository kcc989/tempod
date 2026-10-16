import { Schema } from "effect";
import { eq } from "drizzle-orm";
import { TempoError, newId, type IntentContent } from "@tempo/protocol";
import { EMPTY_PROMPT, json } from "../../db/json.ts";
import { intents, turns, type IntentRow, type SessionRow, type TurnRow } from "../../db/workspace-do.ts";
import { judgeIntent, ownerJudge, type Judge, type Judgement } from "../../judge/jev.ts";
import { requireTempod } from "./container.ts";
import type { WorkspaceCore } from "./core.ts";

/** 13, L-ADR-1: exact texts. */
export const INTENT_TEXT = {
  rule: "Before you change any file, call the tempo tool propose_intent with the goal, your approach and what you will not do, in at most 5 lines in total. Then end your turn. Do not change files until Tempo confirms the intent.",
  confirmed: "Intent confirmed. Do the work.",
  byJudge: "Tempo confirmed the intent. End your turn; Tempo starts the work next.",
  byOwner: "The owner will confirm or correct the intent. End your turn now.",
  tooLong: "Intent must be at most 5 lines.",
  lineTooLong: "Each line must be at most 160 characters.",
  noTask: "There is no task waiting for an intent.",
  off: "The owner turned the intent check off for this chat. Do the work.",
} as const;

const LIMITS = { lines: 5, lineChars: 160 } as const;

const NonEmpty = Schema.String.check(Schema.isMinLength(1));

const ProposeInput = Schema.Struct({ goal: NonEmpty, approach: NonEmpty, notDoing: NonEmpty });

/** Tests replace the judge; the default reads the owner's TypeSafe AI key. */
export const intentJudge = {
  for: (core: WorkspaceCore): Promise<Judge | null> => ownerJudge(core.env, core.ws().userId),
};

const row = (core: WorkspaceCore, sessionId: string): IntentRow | undefined =>
  core.db.select().from(intents).where(eq(intents.sessionId, sessionId)).get();

export const pendingIntent = (core: WorkspaceCore): boolean =>
  core.db.select({ id: intents.id }).from(intents).where(eq(intents.status, "proposed")).all().length > 0;

const setMode = async (core: WorkspaceCore, session: SessionRow, modeId: string): Promise<void> => {
  if (session.modeId === modeId) return;

  if (core.liveSessions.has(session.id))
    await requireTempod(core).request("session.setMode", { sessionId: session.id, modeId });
  core.updateSession(session.id, { modeId });
};

/** Before a turn's prompt is built: starts the check on the first prompt of a chat while the owner's control is on (13, Exact rules). */
export const intentBeforeTurn = (core: WorkspaceCore, session: SessionRow, turn: TurnRow): void => {
  if (
    session.runId ||
    session.intentCheck === 0 ||
    turn.origin !== "user" ||
    !turn.changeId ||
    row(core, session.id)
  )
    return;
  const now = Date.now();

  core.db
    .insert(intents)
    .values({
      id: newId(),
      sessionId: session.id,
      changeId: turn.changeId,
      itemId: null,
      status: "awaiting",
      goal: "",
      approach: "",
      notDoing: "",
      decidedBy: null,
      judgeJson: null,
      priorModeId: null,
      enforced: 0,
      createdAt: now,
      decidedAt: null,
    })
    .onConflictDoNothing()
    .run();
  core.setKv(`intentRule:${turn.id}`, true);
};

/** Whether buildContent adds the intent rule to this turn. Kept until the agent proposes, so a retried send keeps it. */
export const intentRuleDue = (core: WorkspaceCore, turnId: string): boolean =>
  core.kv<boolean>(`intentRule:${turnId}`) === true;

const content = (r: IntentRow, judgement: Judgement | null): IntentContent => ({
  intentId: r.id,
  status: r.status,
  goal: r.goal,
  approach: r.approach,
  notDoing: r.notDoing,
  decidedBy: r.decidedBy,
  reasons: [...(judgement?.reasons ?? [])],
  enforced: r.enforced === 1,
});

const judgementOf = (r: IntentRow): Judgement | null =>
  // SAFETY: judge_json is written only by proposeIntent from a Judgement.
  r.judgeJson ? (JSON.parse(r.judgeJson) as Judgement) : null;

const showItem = (core: WorkspaceCore, r: IntentRow, turnId: string | null): void => {
  const status = r.status === "confirmed" ? "completed" : "pending";

  if (r.itemId && core.updateItem(r.itemId, { status, content: content(r, judgementOf(r)) })) return;

  const item = core.insertItem({
    sessionId: r.sessionId,
    turnId,
    kind: "intent",
    status,
    content: content(r, judgementOf(r)),
  });

  core.db.update(intents).set({ itemId: item.id }).where(eq(intents.id, r.id)).run();
};

const lineCount = (input: typeof ProposeInput.Type): string[] =>
  [input.goal, input.approach, input.notDoing].flatMap((t) => t.trim().split("\n"));

/** The `propose_intent` tool. Returns the tool's answer text. */
export const proposeIntent = async (
  core: WorkspaceCore,
  session: SessionRow,
  params: Schema.Json,
): Promise<string> => {
  if (session.intentCheck === 0) return INTENT_TEXT.off;
  const input = Schema.decodeUnknownSync(ProposeInput)(params);
  const lines = lineCount(input);

  if (lines.length > LIMITS.lines) throw new TempoError("VALIDATION_FAILED", INTENT_TEXT.tooLong);

  if (lines.some((l) => l.length > LIMITS.lineChars))
    throw new TempoError("VALIDATION_FAILED", INTENT_TEXT.lineTooLong);
  const current = row(core, session.id);
  const running = core.runningTurn();

  if (!current || running?.sessionId !== session.id)
    throw new TempoError("VALIDATION_FAILED", INTENT_TEXT.noTask);

  core.db
    .update(intents)
    .set({
      status: "proposed",
      goal: input.goal.trim(),
      approach: input.approach.trim(),
      notDoing: input.notDoing.trim(),
      changeId: running.changeId,
      decidedBy: null,
      decidedAt: null,
      judgeJson: null,
    })
    .where(eq(intents.id, current.id))
    .run();

  core.setKv(`intentRule:${running.id}`, undefined);
  let proposed = row(core, session.id)!;
  showItem(core, proposed, running.id);
  core.lifecycle.append({
    type: "loop.intent.proposed",
    source: "agent",
    changeId: running.changeId ?? undefined,
    turnId: running.id,
    sessionId: session.id,
    agent: session.agent,
    dedupeKey: `intent:${proposed.id}:proposed:${newId()}`,
    payload: { intentId: proposed.id, lines: lines.length, enforced: proposed.enforced === 1 },
  });

  const judgement = await judgeIntent(
    await intentJudge.for(core),
    { goal: proposed.goal, approach: proposed.approach, notDoing: proposed.notDoing },
    { branch: core.ws().branch, project: (await core.project()).name },
  );

  core.db
    .update(intents)
    .set({ judgeJson: JSON.stringify(judgement) })
    .where(eq(intents.id, proposed.id))
    .run();
  proposed = row(core, session.id)!;

  if (!judgement.high) {
    await confirm(core, proposed, "judge");

    return INTENT_TEXT.byJudge;
  }

  showItem(core, proposed, running.id);
  core.recomputeAttention();
  core.lifecycle.kick();

  return INTENT_TEXT.byOwner;
};

const queueTurn = (core: WorkspaceCore, r: IntentRow, text: string): void =>
  queueChatTurn(core, r.sessionId, r.changeId, text);

/** Queues Tempo's own message as a user turn of the chat, in the given change. */
export const queueChatTurn = (
  core: WorkspaceCore,
  sessionId: string,
  changeId: string | null,
  text: string,
): void => {
  const turnId = newId();

  core.ctx.storage.transactionSync(() => {
    core.db
      .insert(turns)
      .values({
        id: turnId,
        sessionId: sessionId,
        changeId: changeId,
        origin: "user",
        seq: core.nextTurnSeq(),
        queuePos: core.nextQueuePos(),
        status: "queued",
        promptJson: json.prompt.write({ ...EMPTY_PROMPT, text }),
        reverted: 0,
        queuedAt: Date.now(),
      })
      .run();
    core.insertItem({
      sessionId: sessionId,
      turnId,
      kind: "user_message",
      status: "completed",
      content: { text, mentions: [], attachments: [], reviewCommentIds: [] },
    });
  });
  core.broadcast({ type: "turn", turn: core.turnToWire(core.turnRow(turnId)) });
  core.kickQueue();
};

const confirm = async (core: WorkspaceCore, r: IntentRow, by: "owner" | "judge"): Promise<void> => {
  const done = core.db
    .update(intents)
    .set({ status: "confirmed", decidedBy: by, decidedAt: Date.now() })
    .where(eq(intents.id, r.id))
    .returning({ id: intents.id })
    .all();

  if (!done.length) return;
  const session = core.sessionRow(r.sessionId);

  if (r.priorModeId && session.status !== "closed") await setMode(core, session, r.priorModeId);
  const confirmed = core.db.select().from(intents).where(eq(intents.id, r.id)).get()!;
  showItem(core, confirmed, null);
  core.lifecycle.append({
    type: "loop.intent.confirmed",
    source: "tempo",
    changeId: r.changeId ?? undefined,
    sessionId: r.sessionId,
    dedupeKey: `intent:${r.id}:confirmed:${newId()}`,
    payload: { intentId: r.id, by, reasons: [...(judgementOf(confirmed)?.reasons ?? [])] },
  });
  queueTurn(core, confirmed, INTENT_TEXT.confirmed);
  core.recomputeAttention();
  core.lifecycle.kick();
};

const proposed = (core: WorkspaceCore, intentId: string): IntentRow | null => {
  const r = core.db.select().from(intents).where(eq(intents.id, intentId)).get();

  if (!r) throw new TempoError("NOT_FOUND");

  return r.status === "proposed" ? r : null;
};

/** `confirmIntent`. A repeat, or an intent that is not proposed, does nothing. */
export const confirmIntent = async (core: WorkspaceCore, intentId: string): Promise<void> => {
  const r = proposed(core, intentId);

  if (r) await confirm(core, r, "owner");
};

/** `correctIntent`: the owner's text goes to the agent as a turn of the same change. */
export const correctIntent = (core: WorkspaceCore, intentId: string, text: string): void => {
  const r = proposed(core, intentId);

  if (!r) return;
  core.db
    .update(intents)
    .set({ status: "corrected", decidedAt: Date.now() })
    .where(eq(intents.id, r.id))
    .run();
  const corrected = core.db.select().from(intents).where(eq(intents.id, r.id)).get()!;
  showItem(core, corrected, null);
  core.lifecycle.append({
    type: "loop.intent.corrected",
    source: "tempo",
    changeId: r.changeId ?? undefined,
    sessionId: r.sessionId,
    dedupeKey: `intent:${r.id}:corrected:${newId()}`,
    payload: { intentId: r.id },
  });
  queueTurn(core, corrected, text);
  core.recomputeAttention();
  core.lifecycle.kick();
};

/** `setIntentCheck`: the owner's control. Turning it off decides a waiting intent as the owner. */
export const setIntentCheck = async (
  core: WorkspaceCore,
  sessionId: string,
  enabled: boolean,
): Promise<void> => {
  const session = core.sessionRow(sessionId);

  if (session.runId) throw new TempoError("VALIDATION_FAILED", undefined, "Runs have no intent check.");
  core.updateSession(sessionId, { intentCheck: enabled ? 1 : 0 });
  const r = row(core, sessionId);

  if (enabled || !r) return;

  if (r.status === "proposed") {
    await confirm(core, r, "owner");

    return;
  }

  if (r.status !== "awaiting") return;
  core.db
    .update(intents)
    .set({ status: "confirmed", decidedBy: "owner", decidedAt: Date.now() })
    .where(eq(intents.id, r.id))
    .run();
  const running = core.runningTurn();

  if (running?.sessionId === sessionId) core.setKv(`intentRule:${running.id}`, undefined);

  if (r.priorModeId && session.status !== "closed")
    await setMode(core, core.sessionRow(sessionId), r.priorModeId);
  showItem(core, core.db.select().from(intents).where(eq(intents.id, r.id)).get()!, null);
  core.recomputeAttention();
};
