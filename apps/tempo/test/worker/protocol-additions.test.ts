import { Schema } from "effect";
import type { WorkspaceStub } from "../../src/do/workspace/stub.ts";
import { runInDurableObject } from "cloudflare:test";
import { newId, type Source, type TempodEvent } from "@tempo/protocol";
import { describe, expect, it } from "vitest";
import type { WorkspaceDO } from "../../src/do/workspace/index.ts";
import {
  driveToState,
  emitEvent,
  internals,
  seedCredentials,
  seedProject,
  seedWorkspace,
  sqlRows,
  waitApplied,
  waitFor,
  type FakeTempod,
} from "./fakes.ts";

// The additive protocol changes in docs/IMPLEMENTATION_NOTES.md ("Additive protocol changes" and "Seq numbers"):
// the agent.exited `reason`, the repo.clone `mode`, and incarnation.changed for an incarnation seen before.

const T = 60_000;

type Stub = WorkspaceStub;

type Row = Record<string, SqlStorageValue>;

interface Ctx {
  readonly stub: Stub;
  readonly tempod: FakeTempod;
}

interface RunningCtx extends Ctx {
  readonly sessionId: string;
  readonly turnId: string;
}

const unwrap = <A>(
  res: { ok: true; value: A } | { ok: false; error: { code: string; message: string } },
): A => {
  if (!res.ok) throw new Error(`RPC failed: ${res.error.code} ${res.error.message}`);

  return res.value;
};

const wsRow = async (stub: Stub): Promise<Row> =>
  (await sqlRows(stub, "SELECT * FROM workspace WHERE id = 1"))[0]!;

const turnRow = async (stub: Stub, id: string): Promise<Row | undefined> =>
  (await sqlRows(stub, "SELECT * FROM turns WHERE id = ?", id))[0];

const sessionRow = async (stub: Stub, id: string): Promise<Row | undefined> =>
  (await sqlRows(stub, "SELECT * FROM sessions WHERE id = ?", id))[0];

const notices = async (stub: Stub): Promise<Array<{ level: string; text: string }>> =>
  (await sqlRows(stub, "SELECT content_json FROM items WHERE kind = 'notice' ORDER BY rev")).map((r) =>
    JSON.parse(Schema.decodeUnknownSync(Schema.String)(r.content_json)),
  );

const errorItems = (stub: Stub, turnId: string) =>
  sqlRows(stub, "SELECT * FROM items WHERE turn_id = ? AND kind = 'error'", turnId);

const isLive = (stub: Stub, sessionId: string): Promise<boolean> =>
  runInDurableObject(stub, (i: WorkspaceDO) => internals(i).core.liveSessions.has(sessionId));

const eventSeqs = async (stub: Stub, incarnation: string): Promise<number[]> =>
  (await sqlRows(stub, "SELECT seq FROM events WHERE incarnation = ? ORDER BY seq", incarnation)).map((r) =>
    Number(r.seq),
  );

const emit = (ctx: Ctx, event: TempodEvent): Promise<number> => emitEvent(ctx.stub, ctx.tempod, event);

const closeTempod = (ctx: Ctx): Promise<void> => runInDurableObject(ctx.stub, () => ctx.tempod.close(1011));

const log = (msg: string): TempodEvent => ({ kind: "log", level: "info", msg });

const readyWorkspace = async (opts: { prompt?: string; source?: Source } = {}): Promise<Ctx> => {
  const seeded = await seedProject();
  await seedCredentials(seeded.userId);
  const { stub, tempod } = await seedWorkspace(seeded, opts);
  await driveToState(stub, ["ready", "working"]);

  return { stub, tempod };
};

/** A ready workspace whose first prompt is running. */
const runningTurn = async (): Promise<RunningCtx> => {
  const ctx = await readyWorkspace({ prompt: "Fix the bug" });
  await waitFor(() => ctx.tempod.requestsOf("session.prompt").length === 1, 5000, "first prompt");
  const p = ctx.tempod.requestsOf("session.prompt")[0];
  await waitFor(async () => (await turnRow(ctx.stub, p.turnId))?.status === "running", 5000, "turn running");

  return { ...ctx, sessionId: p.sessionId, turnId: p.turnId };
};

const endTurn = async (ctx: RunningCtx): Promise<void> => {
  await waitApplied(
    ctx.stub,
    await emit(ctx, {
      kind: "turn.ended",
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      stopReason: "end_turn",
    }),
  );
  await waitFor(async () => (await wsRow(ctx.stub)).state === "ready", 5000, "state ready");
};

const sendPrompt = async (ctx: RunningCtx, text: string): Promise<string> =>
  unwrap(
    await ctx.stub.sendPrompt({
      sessionId: ctx.sessionId,
      text,
      mentions: [],
      attachmentIds: [],
      reviewCommentIds: [],
    }),
  ).id;

const promptFor = (tempod: FakeTempod, turnId: string) =>
  tempod.requestsOf("session.prompt").find((p) => p.turnId === turnId);

const exited = (
  sessionId: string,
  reason?: "crashed" | "evicted" | "cancelled",
  stderrTail = "",
): TempodEvent => {
  const event: Extract<TempodEvent, { kind: "agent.exited" }> = {
    kind: "agent.exited",
    sessionId,
    code: reason === "crashed" || reason === undefined ? 1 : null,
    signal: reason === "evicted" || reason === "cancelled" ? "SIGTERM" : null,
    stderrTail,
  };

  return reason ? { ...event, reason } : event;
};

// =============================================================================================
// agent.exited reason
// =============================================================================================

describe("agent.exited reason", () => {
  it(
    "evicted: the session is no longer live, with no notice and no turn change; the next prompt reloads it",
    async () => {
      // IMPLEMENTATION_NOTES: "evicted (LRU close) ... the DO must still learn that a planned exit ended the process,
      // so the next prompt reloads the session. Only crashed makes a crash notice."
      const ctx = await runningTurn();
      await endTurn(ctx);
      const acp = (await sessionRow(ctx.stub, ctx.sessionId))!.acp_session_id;
      expect(await isLive(ctx.stub, ctx.sessionId)).toBe(true);
      const noticesBefore = await notices(ctx.stub);
      const attentionBefore = (await wsRow(ctx.stub)).attention;

      await waitApplied(ctx.stub, await emit(ctx, exited(ctx.sessionId, "evicted", "adapter log line")));

      expect(await isLive(ctx.stub, ctx.sessionId)).toBe(false);
      expect(await notices(ctx.stub)).toEqual(noticesBefore);
      expect((await turnRow(ctx.stub, ctx.turnId))!.status).toBe("completed");
      expect(await errorItems(ctx.stub, ctx.turnId)).toHaveLength(0);
      const ws = await wsRow(ctx.stub);
      expect(ws.state).toBe("ready");
      expect(ws.attention).toBe(attentionBefore);

      const next = await sendPrompt(ctx, "Carry on");
      await waitFor(() => promptFor(ctx.tempod, next) !== undefined, 5000, "second prompt");
      const starts = ctx.tempod.requestsOf("session.start");
      expect(starts).toHaveLength(2);
      expect(starts[1]).toMatchObject({ sessionId: ctx.sessionId, acpSessionId: acp });
    },
    T,
  );

  it(
    "evicted while a turn runs does not fail the turn",
    async () => {
      const ctx = await runningTurn();
      await waitApplied(ctx.stub, await emit(ctx, exited(ctx.sessionId, "evicted")));
      expect(await isLive(ctx.stub, ctx.sessionId)).toBe(false);
      const turn = (await turnRow(ctx.stub, ctx.turnId))!;
      expect(turn.status).toBe("running");
      expect(turn.error_code).toBeNull();
      expect(await errorItems(ctx.stub, ctx.turnId)).toHaveLength(0);
      expect((await notices(ctx.stub)).some((n) => n.text.includes("stopped unexpectedly"))).toBe(false);
    },
    T,
  );

  it(
    "cancelled (killed after the cancel timeout): the turn ends cancelled, not failed, and the queued turn reloads the session",
    async () => {
      // tempod kills an adapter that ignores session/cancel and sends agent.exited (cancelled) before turn.ended.
      const ctx = await runningTurn();
      const acp = (await sessionRow(ctx.stub, ctx.sessionId))!.acp_session_id;
      const queued = await sendPrompt(ctx, "Then this");
      expect((await turnRow(ctx.stub, queued))!.status).toBe("queued");
      unwrap(await ctx.stub.cancelTurn({ turnId: ctx.turnId }));
      expect(ctx.tempod.requestsOf("session.cancel")).toEqual([
        { sessionId: ctx.sessionId, turnId: ctx.turnId },
      ]);

      await waitApplied(
        ctx.stub,
        await emit(ctx, exited(ctx.sessionId, "cancelled", "ignored session/cancel")),
      );
      expect(await isLive(ctx.stub, ctx.sessionId)).toBe(false);
      expect((await turnRow(ctx.stub, ctx.turnId))!.status).toBe("running");

      await waitApplied(
        ctx.stub,
        await emit(ctx, {
          kind: "turn.ended",
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          stopReason: "cancelled",
        }),
      );
      await waitFor(
        async () => (await turnRow(ctx.stub, ctx.turnId))?.status !== "running",
        5000,
        "turn ended",
      );
      const turn = (await turnRow(ctx.stub, ctx.turnId))!;
      expect(turn.status).toBe("cancelled");
      expect(turn.error_code).toBeNull();
      expect(await errorItems(ctx.stub, ctx.turnId)).toHaveLength(0);
      expect(
        (await notices(ctx.stub)).some((n) => n.level === "error" || n.text.includes("stopped unexpectedly")),
      ).toBe(false);

      await waitFor(() => promptFor(ctx.tempod, queued) !== undefined, 5000, "queued prompt");
      const ops = ctx.tempod.requests.map((r) => r.op);
      const starts = ctx.tempod.requestsOf("session.start");
      expect(starts).toHaveLength(2);
      expect(starts[1]).toMatchObject({ sessionId: ctx.sessionId, acpSessionId: acp });
      expect(ops.lastIndexOf("session.start")).toBeLessThan(ops.lastIndexOf("session.prompt"));
    },
    T,
  );

  for (const reason of ["crashed", undefined] as const) {
    it(
      `${reason ?? "no reason"}: a running turn fails with AGENT_CRASHED and a notice carries the stderr tail`,
      async () => {
        // 03 Failure handling: "Adapter exits during a turn | agent.exited | Turn failed / AGENT_CRASHED; notice with stderrTail".
        const ctx = await runningTurn();
        await waitApplied(ctx.stub, await emit(ctx, exited(ctx.sessionId, reason, "Error: adapter blew up")));
        await waitFor(
          async () => (await turnRow(ctx.stub, ctx.turnId))?.status === "failed",
          5000,
          "turn failed",
        );
        expect((await turnRow(ctx.stub, ctx.turnId))!.error_code).toBe("AGENT_CRASHED");
        const errors = await errorItems(ctx.stub, ctx.turnId);
        expect(errors).toHaveLength(1);
        expect(JSON.parse(Schema.decodeUnknownSync(Schema.String)(errors[0]!.content_json)).code).toBe(
          "AGENT_CRASHED",
        );
        const crash = (await notices(ctx.stub)).filter((n) => n.text.includes("stopped unexpectedly"));
        expect(crash).toHaveLength(1);
        expect(crash[0]).toMatchObject({ level: "error" });
        expect(crash[0]!.text).toContain("Error: adapter blew up");
        expect(await isLive(ctx.stub, ctx.sessionId)).toBe(false);
      },
      T,
    );
  }
});

// =============================================================================================
// repo.clone mode
// =============================================================================================

describe("repo.clone mode", () => {
  for (const source of [{ kind: "new" }, { kind: "branch" }] as const satisfies ReadonlyArray<Source>) {
    it(
      `a create op sends mode "create" (source ${source.kind})`,
      async () => {
        // IMPLEMENTATION_NOTES: "repo.clone params | mode: create or wake | On create, 03's checkout per source applies".
        const ctx = await readyWorkspace({ source });
        const clones = ctx.tempod.requestsOf("repo.clone");
        expect(clones).toHaveLength(1);
        expect(clones[0]).toMatchObject({ mode: "create", source, baseBranch: "main" });
      },
      T,
    );
  }

  it(
    'a wake on a fresh disk sends mode "wake" with the workspace branch',
    async () => {
      // IMPLEMENTATION_NOTES: "On a fresh-disk wake, the branch is tracked from origin when it exists."
      const ctx = await readyWorkspace();
      const branch = (await wsRow(ctx.stub)).branch;
      expect(unwrap(await ctx.stub.sleepWorkspace({}))).toBeDefined();
      await driveToState(ctx.stub, ["sleeping"]);
      // No usable snapshot: the wake starts from the image, so the disk is fresh.
      await runInDurableObject(ctx.stub, (_i: WorkspaceDO, state: DurableObjectState) => {
        state.storage.sql.exec("DELETE FROM snapshots");
      });
      unwrap(await ctx.stub.wakeWorkspace({}));
      await driveToState(ctx.stub, ["ready"]);
      const clones = ctx.tempod.requestsOf("repo.clone");
      expect(clones.map((c) => c.mode)).toEqual(["create", "wake"]);
      expect(clones[1]).toMatchObject({ branch, baseBranch: "main", source: { kind: "new" } });
    },
    T,
  );
});

// =============================================================================================
// incarnation.changed for an incarnation seen before
// =============================================================================================

describe("incarnation.changed", () => {
  it(
    "for an incarnation with stored events deletes those rows first, so its restarted seqs are applied",
    async () => {
      // IMPLEMENTATION_NOTES, Seq numbers: "When the incarnation is one the DO saw before (a disk restored from an older
      // snapshot), the DO deletes its stored events for that incarnation first, so the restarted seqs cannot collide."
      const ctx = await readyWorkspace();
      const a = ctx.tempod.incarnation;
      expect((await wsRow(ctx.stub)).tempod_incarnation).toBe(a);
      const seqsA: number[] = [];

      for (let i = 0; i < 4; i++) seqsA.push(await emit(ctx, log(`a${i}`)));
      await waitApplied(ctx.stub, seqsA.at(-1)!);
      expect(await eventSeqs(ctx.stub, a)).toEqual(seqsA);

      // A new tempod database: incarnation B. A's rows stay.
      const b = newId();
      ctx.tempod.incarnation = b;
      await closeTempod(ctx);
      await waitFor(async () => (await wsRow(ctx.stub)).tempod_incarnation === b, 8000, "incarnation B");
      expect(ctx.tempod.hellos.at(-1)).toMatchObject({ incarnation: a, lastAckedSeq: seqsA.at(-1) });
      const seqsB = [await emit(ctx, log("b0")), await emit(ctx, log("b1"))];
      await waitApplied(ctx.stub, seqsB.at(-1)!);
      expect(await eventSeqs(ctx.stub, a)).toEqual(seqsA);
      expect(await eventSeqs(ctx.stub, b)).toEqual(seqsB);

      // The disk comes back from an older snapshot: incarnation A again, seq restarts at 1.
      ctx.tempod.incarnation = a;
      await closeTempod(ctx);
      await waitFor(
        async () => (await wsRow(ctx.stub)).tempod_incarnation === a,
        8000,
        "incarnation A again",
      );
      expect(ctx.tempod.hellos.at(-1)).toMatchObject({ incarnation: b, lastAckedSeq: seqsB.at(-1) });
      expect(Number((await wsRow(ctx.stub)).tempod_acked_seq)).toBe(1);
      expect(await eventSeqs(ctx.stub, a)).toEqual([]);
      expect(await eventSeqs(ctx.stub, b)).toEqual(seqsB);

      // seq 2 of A collided with a kept row before; now it is applied.
      const seq = await emit(ctx, { kind: "ports.changed", ports: [5173] });
      expect(seq).toBe(seqsA[0]);
      await waitApplied(ctx.stub, seq);
      expect((await sqlRows(ctx.stub, "SELECT port FROM ports")).map((r) => r.port)).toEqual([5173]);
      const rows = await sqlRows(ctx.stub, "SELECT seq, kind FROM events WHERE incarnation = ?", a);
      expect(rows).toEqual([{ seq, kind: "ports.changed" }]);
      await waitFor(() => ctx.tempod.acks.at(-1) === seq, 3000, "ack");
    },
    T,
  );
});
