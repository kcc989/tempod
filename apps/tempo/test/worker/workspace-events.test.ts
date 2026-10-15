import { INTENT_TEXT } from "../../src/do/workspace/intent.ts";
import { Schema } from "effect";
import type { WorkspaceStub } from "../../src/do/workspace/stub.ts";
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  HANDOFF_FIRST_LINE,
  HANDOFF_MAX_CHARS,
  newId,
  revertNote,
  TURN_SUMMARY_RULE,
  type TempodEvent,
} from "@tempo/protocol";
import { describe, expect as matchers, it } from "vitest";
import type { WorkspaceDO } from "../../src/do/workspace/index.ts";
import { recoverSteering } from "../../src/do/workspace/queue.ts";
import {
  fastRetries,
  DEFAULT_EFFECTIVE,
  FakeTempod,
  internals,
  seedCredentials,
  seedProject,
  seedWorkspace,
  waitFor,
  type Seeded,
} from "./fakes.ts";

// Area: tempod events and the queue runner.
// Spec: 02 "Item model", "Shared types and the workspace channel", "tempod protocol" (Events, Rules);
// 03 "Prompt and turn", "Failure handling"; 01 "Sessions", "Scripts, ports and previews".

const T = 30_000;

type Stub = WorkspaceStub;

type Row = Record<string, SqlStorageValue>;

// ---------- helpers ----------

const sql = async (stub: Stub, query: string, ...binds: unknown[]): Promise<Row[]> =>
  runInDurableObject(stub, (_i: WorkspaceDO, state: DurableObjectState) =>
    state.storage.sql.exec(query, ...binds).toArray(),
  );

const wsRow = async (stub: Stub): Promise<Row> =>
  (await sql(stub, "SELECT * FROM workspace WHERE id = 1"))[0]!;

const turnRow = async (stub: Stub, id: string): Promise<Row | undefined> =>
  (await sql(stub, "SELECT * FROM turns WHERE id = ?", id))[0];

const itemRow = async (stub: Stub, id: string): Promise<Row | undefined> =>
  (await sql(stub, "SELECT * FROM items WHERE id = ?", id))[0];

const sessionRow = async (stub: Stub, id: string): Promise<Row | undefined> =>
  (await sql(stub, "SELECT * FROM sessions WHERE id = ?", id))[0];

const unwrap = <A>(
  res: { ok: true; value: A } | { ok: false; error: { code: string; message: string } },
): A => {
  if (!res.ok) throw new Error(`RPC failed: ${res.error.code} ${res.error.message}`);

  return res.value;
};

const detail = async (stub: Stub): Promise<any> => unwrap(await stub.getWorkspace({}));

/** Waits until the DO has applied (and stored the ack for) the event with this seq. */
const applied = (stub: Stub, seq: number) =>
  waitFor(async () => Number((await wsRow(stub)).tempod_acked_seq) >= seq, 5000, `event ${seq} applied`);

const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

const driveUntil = async (
  stub: Stub,
  done: (state: string) => boolean | Promise<boolean>,
  max = 25,
): Promise<void> => {
  for (let i = 0; i < max; i++) {
    const d = await stub.getWorkspace({});

    if (d.ok && (await done(d.value.state))) return;
    await runDurableObjectAlarm(stub);
    await settle(5);
  }

  const d = await stub.getWorkspace({});
  throw new Error(`workspace never reached the expected state (now ${d.ok ? d.value.state : d.error.code})`);
};

interface Ctx {
  readonly seeded: Seeded;
  readonly workspaceId: string;
  readonly stub: Stub;
  readonly tempod: FakeTempod;
}

interface RunningCtx extends Ctx {
  readonly sessionId: string;
  readonly turnId: string;
}

interface SetupOpts {
  readonly prompt?: string;
  readonly agent?: "claude" | "codex" | "opencode" | "pi";
  readonly effective?: unknown;
  readonly configure?: (tempod: FakeTempod) => void;
}

/** Creates a workspace with fakes and drives the create op until the workspace is ready (or working). */
const readyWorkspace = async (opts: SetupOpts = {}): Promise<Ctx> => {
  const seeded = await seedProject();
  await seedCredentials(seeded.userId);

  const options: Parameters<typeof seedWorkspace>[1] = {};

  if (opts.prompt) options.prompt = opts.prompt;

  if (opts.agent) options.agent = opts.agent;
  const { workspaceId, stub, tempod } = await seedWorkspace(seeded, options);

  if (opts.effective)
    tempod.on("settings.read", () => ({ effective: opts.effective, warnings: [], errors: [], sources: {} }));
  opts.configure?.(tempod);
  await driveUntil(stub, (s) => s === "ready" || s === "working");

  return { seeded, workspaceId, stub, tempod };
};

/** A ready workspace whose first prompt is running. */
const runningTurn = async (opts: SetupOpts = {}): Promise<RunningCtx> => {
  const ctx = await readyWorkspace({ ...opts, prompt: opts.prompt ?? "Fix the bug" });
  await waitFor(() => ctx.tempod.requestsOf("session.prompt").length === 1, 5000, "first prompt");
  const p = ctx.tempod.requestsOf("session.prompt")[0];
  await waitFor(async () => (await turnRow(ctx.stub, p.turnId))?.status === "running", 5000, "turn running");

  return { ...ctx, sessionId: p.sessionId, turnId: p.turnId };
};

// The fake tempod's socket belongs to the DO's I/O context, so events are sent from inside the DO.
const emit = (ctx: Ctx, event: TempodEvent | import("@tempo/protocol").JsonData): Promise<number> =>
  runInDurableObject(ctx.stub, () => ctx.tempod.emit(event));

const emitMany = (
  ctx: Ctx,
  events: (TempodEvent | import("@tempo/protocol").JsonData)[],
): Promise<number[]> => runInDurableObject(ctx.stub, () => events.map((e) => ctx.tempod.emit(e)));

const emitRaw = (
  ctx: Ctx,
  seq: number,
  event: TempodEvent | import("@tempo/protocol").JsonData,
): Promise<void> => runInDurableObject(ctx.stub, () => ctx.tempod.emitRaw(seq, event));

const closeTempod = async (ctx: Ctx): Promise<void> => {
  await fastRetries(ctx.stub);
  await runInDurableObject(ctx.stub, () => ctx.tempod.close(1011));
};

/** Ends a running turn and waits until the DO has finished turn-end processing (the state is ready again). */
const endTurn = async (
  ctx: Ctx,
  sessionId: string,
  turnId: string,
  fields: import("@tempo/protocol").JsonDataFields = { stopReason: "end_turn" },
) => {
  const seq = await emit(ctx, { kind: "turn.ended", sessionId, turnId, ...fields });
  await applied(ctx.stub, seq);
  await waitFor(async () => (await turnRow(ctx.stub, turnId))?.status !== "running", 5000, "turn ended");

  return seq;
};

const waitReady = (ctx: Ctx) =>
  waitFor(async () => (await wsRow(ctx.stub)).state === "ready", 5000, "state ready");

describe.concurrent("live steering", () => {
  const send = (ctx: RunningCtx) =>
    ctx.stub.sendPrompt({
      sessionId: ctx.sessionId,
      text: "Use the smaller change",
      mentions: [],
      attachmentIds: [],
      reviewCommentIds: [],
      delivery: "steer",
    });

  const enable = (ctx: RunningCtx) =>
    sql(
      ctx.stub,
      "UPDATE sessions SET capabilities_json = ? WHERE id = ?",
      JSON.stringify({ steering: true }),
      ctx.sessionId,
    );

  it(
    "delivers to the running turn and moves its durable user message without cancelling",
    async ({ expect }) => {
      const ctx = await runningTurn();
      await enable(ctx);
      ctx.tempod.on("session.steer", () => ({ outcome: "injected" }));
      const result = unwrap(await send(ctx));
      expect(result.id).toBe(ctx.turnId);
      expect(ctx.tempod.requestsOf("session.cancel")).toHaveLength(0);
      expect(ctx.tempod.requestsOf("session.prompt")).toHaveLength(1);
      expect(ctx.tempod.requestsOf("session.steer")[0].turnId).toBe(ctx.turnId);
      const messages = await sql(ctx.stub, "SELECT * FROM items WHERE kind = 'user_message' ORDER BY rev");
      expect(messages).toHaveLength(2);
      expect(messages[1]!.turn_id).toBe(ctx.turnId);
      expect((await detail(ctx.stub)).queue).toEqual([]);
    },
    T,
  );

  it(
    "keeps unsupported and settled steering messages queued",
    async ({ expect }) => {
      const ctx = await runningTurn();
      const unsupported = unwrap(await send(ctx));
      expect(unsupported.status).toBe("queued");
      expect(ctx.tempod.requestsOf("session.steer")).toHaveLength(0);
      await enable(ctx);
      ctx.tempod.on("session.steer", () => ({ outcome: "promptRequired" }));
      const settled = unwrap(await send(ctx));
      expect(settled.status).toBe("queued");
      expect((await turnRow(ctx.stub, settled.id))!.steering_pending).toBe(0);
      expect((await detail(ctx.stub)).queue).toEqual([unsupported.id, settled.id]);
    },
    T,
  );

  it(
    "does not replay a message when steering acknowledgement fails",
    async ({ expect }) => {
      const ctx = await runningTurn();
      await enable(ctx);
      ctx.tempod.on("session.steer", () => {
        throw new Error("lost acknowledgement");
      });
      expect((await send(ctx)).ok).toBe(false);
      const failed = (await sql(ctx.stub, "SELECT * FROM turns WHERE status = 'failed'"))[0]!;
      expect(failed.error_detail).toContain("could not be confirmed");
      expect((await detail(ctx.stub)).queue).toEqual([]);
      expect(ctx.tempod.requestsOf("session.prompt")).toHaveLength(1);
    },
    T,
  );

  it(
    "recovers an interrupted steering attempt as uncertain rather than replaying it",
    async ({ expect }) => {
      const ctx = await runningTurn();
      const queued = unwrap(await send(ctx));
      await sql(ctx.stub, "UPDATE turns SET steering_pending = 1 WHERE id = ?", queued.id);
      await runInDurableObject(ctx.stub, (instance: WorkspaceDO) =>
        recoverSteering(internals(instance).core),
      );
      const recovered = (await turnRow(ctx.stub, queued.id))!;
      expect(recovered.status).toBe("failed");
      expect(recovered.steering_pending).toBe(0);
      expect(recovered.error_detail).toContain("could not be confirmed");

      const notice = (
        await sql(ctx.stub, "SELECT * FROM items WHERE turn_id = ? AND kind = 'notice'", queued.id)
      )[0]!;

      expect(notice.content_json).toContain("could not be confirmed");
      expect((await detail(ctx.stub)).queue).toEqual([]);
    },
    T,
  );
});

/** Sends a prompt and waits until tempod receives it. Returns the turn id. */
const prompt = async (
  ctx: Ctx,
  sessionId: string,
  text: string,
  extra: { mentions?: Array<{ path: string }>; reviewCommentIds?: string[] } = {},
): Promise<string> => {
  const turn = unwrap(
    await ctx.stub.sendPrompt({
      sessionId,
      text,
      mentions: extra.mentions ?? [],
      attachmentIds: [],
      reviewCommentIds: extra.reviewCommentIds ?? [],
    }),
  );

  return turn.id;
};

const promptFor = (tempod: FakeTempod, turnId: string) =>
  tempod.requestsOf("session.prompt").find((p) => p.turnId === turnId);

const waitPrompt = async (ctx: Ctx, turnId: string): Promise<any> => {
  await waitFor(() => promptFor(ctx.tempod, turnId) !== undefined, 5000, `session.prompt for ${turnId}`);
  await waitFor(async () => (await turnRow(ctx.stub, turnId))?.status === "running", 5000, "turn running");

  return promptFor(ctx.tempod, turnId);
};

const itemCreated = (
  sessionId: string,
  turnId: string | null,
  item: { id: string; kind: string; status: string; content: import("@tempo/protocol").JsonDataFields },
): import("@tempo/protocol").JsonDataFields => ({
  kind: "item.created",
  sessionId,
  turnId,
  item: { ...item, createdAt: Date.now() },
});

const agentMessage = (sessionId: string, turnId: string, id: string, text: string, status = "streaming") =>
  itemCreated(sessionId, turnId, { id, kind: "agent_message", status, content: { text } });

const toolCall = (sessionId: string, turnId: string, id: string, title: string, status = "in_progress") =>
  itemCreated(sessionId, turnId, {
    id,
    kind: "tool_call",
    status,
    content: { toolCallId: `call-${id}`, title, toolKind: "read", locations: [], content: [] },
  });

interface UiSocket {
  readonly ws: WebSocket;
  readonly messages: any[];
  close(): void;
}

const openUi = async (ctx: Ctx, sinceRev = 0): Promise<UiSocket> => {
  const res = await ctx.stub.fetch(
    `https://tempo.test/api/ws/workspace/${ctx.workspaceId}?sinceRev=${sinceRev}`,
    {
      headers: { Upgrade: "websocket" },
    },
  );

  const ws = res.webSocket;

  if (!ws) throw new Error(`no websocket (status ${res.status})`);
  const messages: any[] = [];
  ws.addEventListener("message", (e: MessageEvent) => {
    messages.push(JSON.parse(String(e.data)));
  });
  ws.accept();

  return {
    ws,
    messages,
    close: () => {
      try {
        ws.close(1000, "done");
      } catch {
        // already closed
      }
    },
  };
};

const backlogDone = (ui: UiSocket) =>
  waitFor(() => ui.messages.some((m) => m.type === "items" && m.done === true), 5000, "backlog done");

const ofType = (ui: UiSocket, type: string) => ui.messages.filter((m) => m.type === type);

const d1Workspace = async (id: string): Promise<Row | null> =>
  env.DB.prepare("SELECT * FROM workspaces WHERE id = ?").bind(id).first<Row>();

// =============================================================================================
// 02 Item model + Rules: items and items_rev
// =============================================================================================

describe.concurrent("item events update items and items_rev", () => {
  it(
    "item.created, item.delta and item.updated each bump items_rev by exactly 1 and set items.rev to it",
    async ({ expect }) => {
      // 02 WorkspaceDO schema, Rules: "Every change to items increments workspace.items_rev by 1 and sets
      // items.rev to the new value, in the same transaction."
      const ctx = await runningTurn();
      const r0 = Number((await wsRow(ctx.stub)).items_rev);
      const id = newId();

      await applied(ctx.stub, await emit(ctx, agentMessage(ctx.sessionId, ctx.turnId, id, "Hel")));
      let it1 = (await itemRow(ctx.stub, id))!;
      expect(it1).toMatchObject({
        session_id: ctx.sessionId,
        turn_id: ctx.turnId,
        kind: "agent_message",
        status: "streaming",
      });
      expect(JSON.parse(Schema.decodeUnknownSync(Schema.String)(it1.content_json))).toEqual({ text: "Hel" });
      expect(Number((await wsRow(ctx.stub)).items_rev)).toBe(r0 + 1);
      expect(it1.rev).toBe(r0 + 1);

      await applied(
        ctx.stub,
        await emit(ctx, { kind: "item.delta", sessionId: ctx.sessionId, itemId: id, append: { text: "lo" } }),
      );
      it1 = (await itemRow(ctx.stub, id))!;
      expect(JSON.parse(Schema.decodeUnknownSync(Schema.String)(it1.content_json))).toEqual({
        text: "Hello",
      });
      expect(Number((await wsRow(ctx.stub)).items_rev)).toBe(r0 + 2);
      expect(it1.rev).toBe(r0 + 2);

      await applied(
        ctx.stub,
        await emit(ctx, {
          kind: "item.updated",
          sessionId: ctx.sessionId,
          itemId: id,
          patch: { status: "completed" },
        }),
      );
      it1 = (await itemRow(ctx.stub, id))!;
      expect(it1.status).toBe("completed");
      expect(JSON.parse(Schema.decodeUnknownSync(Schema.String)(it1.content_json))).toEqual({
        text: "Hello",
      });
      expect(Number((await wsRow(ctx.stub)).items_rev)).toBe(r0 + 3);
      expect(it1.rev).toBe(r0 + 3);
    },
    T,
  );

  it(
    "item.updated merges a tool_call status and replaces its content",
    async ({ expect }) => {
      // 02 Item model: tool_call_update "Update that item: merge title, status, locations; replace content when it is sent."
      // tool_call status copies the ACP status: pending, in_progress, completed, failed.
      const ctx = await runningTurn();
      const id = newId();
      await applied(
        ctx.stub,
        await emit(ctx, toolCall(ctx.sessionId, ctx.turnId, id, "Read file", "pending")),
      );
      const before = Number((await wsRow(ctx.stub)).items_rev);

      const content = {
        toolCallId: `call-${id}`,
        title: "Read src/a.ts",
        toolKind: "read",
        locations: [{ path: "src/a.ts", line: 3 }],
        content: [{ type: "content", content: { type: "text", text: "ok" } }],
      };

      await applied(
        ctx.stub,
        await emit(ctx, {
          kind: "item.updated",
          sessionId: ctx.sessionId,
          itemId: id,
          patch: { status: "failed", content },
        }),
      );
      const row = (await itemRow(ctx.stub, id))!;
      expect(row.status).toBe("failed");
      expect(JSON.parse(Schema.decodeUnknownSync(Schema.String)(row.content_json))).toEqual(content);
      expect(row.rev).toBe(before + 1);
      expect(Number((await wsRow(ctx.stub)).items_rev)).toBe(before + 1);
    },
    T,
  );

  it(
    "a delta or update for an unknown item changes nothing and does not bump items_rev",
    async ({ expect }) => {
      // 02 Rules: items_rev counts changes to items; an event that changes no item is not a change.
      const ctx = await runningTurn();
      const before = Number((await wsRow(ctx.stub)).items_rev);
      await emit(ctx, {
        kind: "item.delta",
        sessionId: ctx.sessionId,
        itemId: newId(),
        append: { text: "x" },
      });

      const seq = await emit(ctx, {
        kind: "item.updated",
        sessionId: ctx.sessionId,
        itemId: newId(),
        patch: { status: "completed" },
      });

      await applied(ctx.stub, seq);
      expect(Number((await wsRow(ctx.stub)).items_rev)).toBe(before);
      // Later events still apply.
      const id = newId();
      await applied(ctx.stub, await emit(ctx, agentMessage(ctx.sessionId, ctx.turnId, id, "after")));
      expect(await itemRow(ctx.stub, id)).toBeDefined();
      expect(Number((await wsRow(ctx.stub)).items_rev)).toBe(before + 1);
    },
    T,
  );

  it(
    "session.updated applies mode, commands, usage and title to the session",
    async ({ expect }) => {
      // 02 Item model: current_mode_update → sessions.mode_id; available_commands_update → commands_json;
      // usage_update → usage_json; session_info_update → sessions.title (03 While it runs: "Apply session.updated").
      const ctx = await runningTurn();
      const ui = await openUi(ctx);
      await backlogDone(ui);

      const seq = await emit(ctx, {
        kind: "session.updated",
        sessionId: ctx.sessionId,
        patch: {
          modeId: "plan",
          commands: [{ name: "review", description: "Review the diff" }],
          usage: { used: 1200, size: 200000 },
          title: "Fix login bug",
        },
      });

      await applied(ctx.stub, seq);
      const s = (await sessionRow(ctx.stub, ctx.sessionId))!;
      expect(s.mode_id).toBe("plan");
      expect(s.title).toBe("Fix login bug");
      expect(JSON.parse(Schema.decodeUnknownSync(Schema.String)(s.commands_json))).toEqual([
        { name: "review", description: "Review the diff" },
      ]);
      expect(JSON.parse(Schema.decodeUnknownSync(Schema.String)(s.usage_json))).toEqual({
        used: 1200,
        size: 200000,
      });
      await waitFor(
        () => ofType(ui, "session").some((m) => m.session.title === "Fix login bug"),
        3000,
        "session message",
      );
      ui.close();
    },
    T,
  );
});

// =============================================================================================
// 02 Workspace channel
// =============================================================================================

describe.concurrent("workspace channel", () => {
  it(
    "sends hello first, then the item backlog with done:true, then live item.upsert and item.delta",
    async ({ expect }) => {
      // 02 Workspace channel: hello {v: 1, workspace, sessions, turns, itemsRev} is the first message;
      // items {items, itemsRev, done} is the backlog with rev > sinceRev, done:true on the last;
      // item.upsert {item, itemsRev} when an item was created or changed; item.delta {itemId, append, itemsRev} live only.
      const ctx = await runningTurn({ prompt: "Add a README" });
      const ui = await openUi(ctx, 0);
      await backlogDone(ui);
      const row = await wsRow(ctx.stub);

      const hello = ui.messages[0];
      expect(hello.type).toBe("hello");
      expect(hello.v).toBe(1);
      expect(hello.workspace.id).toBe(ctx.workspaceId);
      expect(hello.itemsRev).toBe(Number(row.items_rev));
      expect(hello.sessions.map((s: any) => s.id)).toEqual([ctx.sessionId]);
      expect(hello.turns.map((t: any) => t.id)).toEqual([ctx.turnId]);
      expect(hello.turns[0].status).toBe("running");

      const pages = ofType(ui, "items");
      expect(pages).toHaveLength(1);
      expect(pages[0].done).toBe(true);
      expect(pages[0].itemsRev).toBe(Number(row.items_rev));
      const user = pages[0].items.find((i: any) => i.kind === "user_message");
      expect(user).toMatchObject({ sessionId: ctx.sessionId, turnId: ctx.turnId, status: "completed" });
      expect(user.content.text).toBe("Add a README");

      const id = newId();
      await emit(ctx, agentMessage(ctx.sessionId, ctx.turnId, id, "Sure"));
      await waitFor(() => ofType(ui, "item.upsert").some((m) => m.item.id === id), 3000, "item.upsert");
      const upsert = ofType(ui, "item.upsert").find((m) => m.item.id === id);
      const stored = (await itemRow(ctx.stub, id))!;
      expect(upsert.item).toMatchObject({
        id,
        kind: "agent_message",
        status: "streaming",
        content: { text: "Sure" },
        rev: stored.rev,
      });
      expect(upsert.itemsRev).toBe(stored.rev);

      await emit(ctx, {
        kind: "item.delta",
        sessionId: ctx.sessionId,
        itemId: id,
        append: { text: ", on it." },
      });
      await waitFor(() => ofType(ui, "item.delta").length === 1, 3000, "item.delta");
      const delta = ofType(ui, "item.delta")[0];
      expect(delta).toEqual({
        type: "item.delta",
        itemId: id,
        append: { text: ", on it." },
        itemsRev: upsert.itemsRev + 1,
      });
      expect(Number((await wsRow(ctx.stub)).items_rev)).toBe(delta.itemsRev);

      await emit(ctx, {
        kind: "item.updated",
        sessionId: ctx.sessionId,
        itemId: id,
        patch: { status: "completed" },
      });
      await waitFor(
        () => ofType(ui, "item.upsert").some((m) => m.item.id === id && m.item.status === "completed"),
        3000,
        "upsert after update",
      );

      const updated = ofType(ui, "item.upsert").find(
        (m) => m.item.id === id && m.item.status === "completed",
      );

      expect(updated.item.content).toEqual({ text: "Sure, on it." });
      expect(updated.itemsRev).toBe(delta.itemsRev + 1);
      expect(updated.item.rev).toBe(delta.itemsRev + 1);
      ui.close();
    },
    T,
  );

  it(
    "a reconnect with sinceRev gets only newer items, and gets streamed items in full (no deltas)",
    async ({ expect }) => {
      // 02 Workspace channel: "sinceRev is the highest item rev the client has"; Rules: "item.delta is sent only to
      // live sockets. A client that reconnects gets the full item in the backlog."
      const ctx = await runningTurn();
      const a = newId();
      const b = newId();
      await applied(
        ctx.stub,
        await emit(ctx, agentMessage(ctx.sessionId, ctx.turnId, a, "first", "completed")),
      );
      const sinceRev = Number((await itemRow(ctx.stub, a))!.rev);
      await emit(ctx, agentMessage(ctx.sessionId, ctx.turnId, b, "str"));

      const seq = await emit(ctx, {
        kind: "item.delta",
        sessionId: ctx.sessionId,
        itemId: b,
        append: { text: "eamed" },
      });

      await applied(ctx.stub, seq);

      const ui = await openUi(ctx, sinceRev);
      await backlogDone(ui);
      const items = ofType(ui, "items").flatMap((m) => m.items);
      expect(items.map((i: any) => i.id)).toEqual([b]);
      expect(items[0].content.text).toBe("streamed");
      expect(items.every((i: any) => i.rev > sinceRev)).toBe(true);
      expect(ofType(ui, "item.delta")).toHaveLength(0);

      const latest = await openUi(ctx, Number((await wsRow(ctx.stub)).items_rev));
      await backlogDone(latest);
      expect(ofType(latest, "items")).toEqual([
        { type: "items", items: [], itemsRev: Number((await wsRow(ctx.stub)).items_rev), done: true },
      ]);
      ui.close();
      latest.close();
    },
    T,
  );

  it(
    "sends the backlog in pages of at most 500 items, ordered by rev, done only on the last",
    async ({ expect }) => {
      // 02 Workspace channel: items "Backlog with rev > sinceRev, 500 per message; done: true on the last".
      const ctx = await readyWorkspace();
      await runInDurableObject(ctx.stub, (instance: WorkspaceDO) => {
        const core = internals(instance).core;

        for (let i = 0; i < 1100; i++) {
          core.insertItem({
            sessionId: "s-bulk",
            turnId: null,
            kind: "notice",
            status: "completed",
            content: { level: "info", text: `n${i}` },
          });
        }
      });
      const total = Number((await wsRow(ctx.stub)).items_rev);
      expect(total).toBe(1100);

      const ui = await openUi(ctx, 0);
      await backlogDone(ui);
      const pages = ofType(ui, "items");
      expect(pages.map((p) => p.items.length)).toEqual([500, 500, 100]);
      expect(pages.map((p) => p.done)).toEqual([false, false, true]);
      const revs = pages.flatMap((p) => p.items.map((i: any) => i.rev));
      expect(revs).toEqual(Array.from({ length: 1100 }, (_, i) => i + 1));
      expect(pages.every((p) => p.itemsRev === total)).toBe(true);
      expect(ui.messages[0].type).toBe("hello");

      const later = await openUi(ctx, 650);
      await backlogDone(later);
      const laterPages = ofType(later, "items");
      expect(laterPages).toHaveLength(1);
      expect(laterPages[0].items).toHaveLength(450);
      expect(laterPages[0].items[0].rev).toBe(651);
      ui.close();
      later.close();
    },
    T,
  );
});

// =============================================================================================
// 02 tempod protocol: ordering, dedupe, acks, incarnation
// =============================================================================================

describe.concurrent("event delivery: dedupe, acks and incarnation", () => {
  it(
    "drops an event whose seq was already applied and stores each (incarnation, seq) once",
    async ({ expect }) => {
      // 02 tempod protocol, Rules: "The DO MUST apply events in seq order and drop any (incarnation, seq) it has already stored."
      const ctx = await runningTurn();
      const a = newId();
      const dup = newId();
      const c = newId();
      const s1 = await emit(ctx, agentMessage(ctx.sessionId, ctx.turnId, a, "A", "completed"));
      await applied(ctx.stub, s1);
      const revAfterA = Number((await wsRow(ctx.stub)).items_rev);
      await emitRaw(ctx, s1, agentMessage(ctx.sessionId, ctx.turnId, dup, "duplicate", "completed"));
      const s2 = await emit(ctx, agentMessage(ctx.sessionId, ctx.turnId, c, "C", "completed"));
      await applied(ctx.stub, s2);

      expect(await itemRow(ctx.stub, a)).toBeDefined();
      expect(await itemRow(ctx.stub, dup)).toBeUndefined();
      expect(await itemRow(ctx.stub, c)).toBeDefined();
      expect(Number((await wsRow(ctx.stub)).items_rev)).toBe(revAfterA + 1);
      const rows = await sql(ctx.stub, "SELECT seq, kind, incarnation FROM events WHERE seq = ?", s1);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.incarnation).toBe(ctx.tempod.incarnation);
      expect(
        JSON.parse(
          Schema.decodeUnknownSync(Schema.String)(
            (await sql(ctx.stub, "SELECT payload_json FROM events WHERE seq = ?", s1))[0]!.payload_json,
          ),
        ).item.id,
      ).toBe(a);
    },
    T,
  );

  it(
    "acks applied events in batches and stores the acked seq",
    async ({ expect }) => {
      // 02 tempod protocol: "The DO acks events in batches: at most every 250 ms or every 100 events."
      const ctx = await runningTurn();
      const acksBefore = ctx.tempod.acks.length;

      const seqs = await emitMany(
        ctx,
        Array.from({ length: 250 }, (_, i): TempodEvent => ({ kind: "log", level: "info", msg: `m${i}` })),
      );

      const last = seqs.at(-1)!;
      await applied(ctx.stub, last);
      await waitFor(() => ctx.tempod.acks.at(-1) === last, 3000, "final ack");
      const acks = ctx.tempod.acks.slice(acksBefore);
      expect(acks.length).toBeGreaterThan(0);
      expect(acks.length).toBeLessThan(25);

      for (let i = 1; i < acks.length; i++) expect(acks[i]!).toBeGreaterThanOrEqual(acks[i - 1]!);
      expect(Number((await wsRow(ctx.stub)).tempod_acked_seq)).toBe(last);
    },
    T,
  );

  it(
    "reconnects with the stored incarnation and acked seq; incarnation.changed resets the acked seq",
    async ({ expect }) => {
      // 03 Wake step 2: "send hello with the stored incarnation and tempod_acked_seq".
      // 01 tempod, Outbox: "If it does not match, send incarnation.changed and start from seq 1."
      const ctx = await runningTurn();
      await endTurn(ctx, ctx.sessionId, ctx.turnId);
      await waitReady(ctx);
      let last = 0;

      for (let i = 0; i < 4; i++) last = await emit(ctx, { kind: "log", level: "info", msg: `m${i}` });
      await applied(ctx.stub, last);
      const oldIncarnation = ctx.tempod.incarnation;
      expect((await wsRow(ctx.stub)).tempod_incarnation).toBe(oldIncarnation);

      // tempod's database is new: a new incarnation, its seq restarts at 1.
      ctx.tempod.incarnation = newId();
      await closeTempod(ctx);
      await waitFor(() => ctx.tempod.hellos.length === 2, 8000, "second hello");
      expect(ctx.tempod.hellos[1]).toMatchObject({
        type: "hello",
        v: 1,
        incarnation: oldIncarnation,
        lastAckedSeq: last,
      });
      await waitFor(
        async () => (await wsRow(ctx.stub)).tempod_incarnation === ctx.tempod.incarnation,
        5000,
        "new incarnation",
      );
      expect(Number((await wsRow(ctx.stub)).tempod_acked_seq)).toBe(1);

      // seq 2 of the new incarnation is applied even though it is below the old acked seq.
      const id = newId();

      const seq = await emit(
        ctx,
        itemCreated(ctx.sessionId, null, {
          id,
          kind: "notice",
          status: "completed",
          content: { level: "info", text: "hi" },
        }),
      );

      expect(seq).toBeLessThan(last);
      await applied(ctx.stub, seq);
      await waitFor(async () => (await itemRow(ctx.stub, id)) !== undefined, 3000, "item applied");
      expect(Number((await wsRow(ctx.stub)).tempod_acked_seq)).toBe(seq);
      const rows = await sql(ctx.stub, "SELECT incarnation FROM events WHERE seq = ? ORDER BY id", seq);
      expect(rows.map((r) => r.incarnation)).toContain(ctx.tempod.incarnation);
    },
    T,
  );

  it(
    "a reconnect with the same incarnation does not reset the acked seq",
    async ({ expect }) => {
      // 01 tempod, Outbox: "if the incarnation matches, resend every event with seq > lastAckedSeq".
      const ctx = await runningTurn();
      const last = await emit(ctx, { kind: "log", level: "info", msg: "x" });
      await applied(ctx.stub, last);
      await closeTempod(ctx);
      await waitFor(() => ctx.tempod.hellos.length === 2, 8000, "second hello");
      expect(ctx.tempod.hellos[1]).toMatchObject({ incarnation: ctx.tempod.incarnation, lastAckedSeq: last });
      await settle();
      expect(Number((await wsRow(ctx.stub)).tempod_acked_seq)).toBe(last);
      // A resend of an already-applied event is dropped.
      const dup = newId();
      await emitRaw(
        ctx,
        last,
        itemCreated(ctx.sessionId, null, {
          id: dup,
          kind: "notice",
          status: "completed",
          content: { level: "info", text: "dup" },
        }),
      );
      const next = await emit(ctx, { kind: "log", level: "info", msg: "y" });
      await applied(ctx.stub, next);
      expect(await itemRow(ctx.stub, dup)).toBeUndefined();
    },
    T,
  );
});

// =============================================================================================
// 03 Prompt and turn: turn.ended
// =============================================================================================

const openItems = async (ctx: RunningCtx) => {
  const ids = { message: newId(), thought: newId(), running: newId(), pending: newId(), done: newId() };
  await emit(ctx, agentMessage(ctx.sessionId, ctx.turnId, ids.message, "Working"));
  await emit(
    ctx,
    itemCreated(ctx.sessionId, ctx.turnId, {
      id: ids.thought,
      kind: "agent_thought",
      status: "streaming",
      content: { text: "hmm" },
    }),
  );
  await emit(ctx, toolCall(ctx.sessionId, ctx.turnId, ids.running, "Run tests", "in_progress"));
  await emit(ctx, toolCall(ctx.sessionId, ctx.turnId, ids.pending, "Edit file", "pending"));
  const seq = await emit(ctx, toolCall(ctx.sessionId, ctx.turnId, ids.done, "Read file", "completed"));
  await applied(ctx.stub, seq);

  return ids;
};

describe.concurrent("turn.ended", () => {
  // The Worker stores every non-cancel stop reason the same way; one other than end_turn proves it is not fixed.
  it.for(["end_turn", "refusal"])(
    "stopReason %s → completed with the reason stored; streaming items become completed",
    { timeout: T },
    async (stopReason, { expect }) => {
      // 03 turn.ended table: end_turn, max_tokens, max_turn_requests, refusal → completed (the reason is stored).
      // 02 Item model, Status: agent_message and agent_thought are streaming until the turn ends, then completed.
      const ctx = await runningTurn();
      const ids = await openItems(ctx);
      await endTurn(ctx, ctx.sessionId, ctx.turnId, { stopReason });
      const turn = (await turnRow(ctx.stub, ctx.turnId))!;
      expect(turn.status).toBe("completed");
      expect(turn.stop_reason).toBe(stopReason);
      expect(turn.error_code).toBeNull();
      expect(turn.ended_at).toEqual(expect.any(Number));
      expect((await itemRow(ctx.stub, ids.message))!.status).toBe("completed");
      expect((await itemRow(ctx.stub, ids.thought))!.status).toBe("completed");
      expect((await itemRow(ctx.stub, ids.done))!.status).toBe("completed");
      // 03 turn.ended step 1: "Set the session idle."
      expect((await sessionRow(ctx.stub, ctx.sessionId))!.status).toBe("idle");
      expect(
        await sql(ctx.stub, "SELECT id FROM items WHERE turn_id = ? AND kind = 'error'", ctx.turnId),
      ).toHaveLength(0);
    },
  );

  it(
    "usage from the prompt response is stored on the turn and sent on the wire; bad counts are dropped",
    async ({ expect }) => {
      // 02 turns.usage_json and Turn.usage; 04 Transcript: "if the agent sends usage, tokens".
      const ctx = await runningTurn();
      await endTurn(ctx, ctx.sessionId, ctx.turnId, {
        stopReason: "end_turn",
        usage: { totalTokens: 1500, inputTokens: 1200, outputTokens: 300, thoughtTokens: -5 },
      });
      const row = (await turnRow(ctx.stub, ctx.turnId))!;
      expect(JSON.parse(String(row.usage_json))).toEqual({
        totalTokens: 1500,
        inputTokens: 1200,
        outputTokens: 300,
      });

      const wire = await runInDurableObject(ctx.stub, (i: WorkspaceDO) => {
        const core = internals(i).core;

        return core.turnToWire(core.turnRow(ctx.turnId));
      });

      expect(wire.usage).toEqual({ totalTokens: 1500, inputTokens: 1200, outputTokens: 300 });
    },
    T,
  );

  it(
    "a turn without usage has no usage field",
    async ({ expect }) => {
      const ctx = await runningTurn();
      await endTurn(ctx, ctx.sessionId, ctx.turnId);

      const wire = await runInDurableObject(ctx.stub, (i: WorkspaceDO) => {
        const core = internals(i).core;

        return core.turnToWire(core.turnRow(ctx.turnId));
      });

      expect("usage" in wire).toBe(false);
      expect((await turnRow(ctx.stub, ctx.turnId))!.usage_json).toBeNull();
    },
    T,
  );

  it(
    "interrupted:true wins over the stop reason → interrupted, open items cancelled",
    async ({ expect }) => {
      // 03 turn.ended table: "turn.ended carries interrupted: true (check this first) → interrupted".
      // 02 Status: "When a turn ends as cancelled, failed or interrupted, every open item in it becomes cancelled."
      const ctx = await runningTurn();
      const ids = await openItems(ctx);
      await endTurn(ctx, ctx.sessionId, ctx.turnId, { stopReason: "end_turn", interrupted: true });
      const turn = (await turnRow(ctx.stub, ctx.turnId))!;
      expect(turn.status).toBe("interrupted");

      for (const id of [ids.message, ids.thought, ids.running, ids.pending])
        expect((await itemRow(ctx.stub, id))!.status).toBe("cancelled");
      expect((await itemRow(ctx.stub, ids.done))!.status).toBe("completed");
      expect((await sessionRow(ctx.stub, ctx.sessionId))!.status).toBe("idle");
    },
    T,
  );

  it(
    "stopReason cancelled → cancelled, open items cancelled",
    async ({ expect }) => {
      // 03 turn.ended table: cancelled → cancelled. 02 Status: open items become cancelled.
      const ctx = await runningTurn();
      const ids = await openItems(ctx);
      await endTurn(ctx, ctx.sessionId, ctx.turnId, { stopReason: "cancelled" });
      const turn = (await turnRow(ctx.stub, ctx.turnId))!;
      expect(turn.status).toBe("cancelled");
      expect(turn.stop_reason).toBe("cancelled");

      for (const id of [ids.message, ids.thought, ids.running, ids.pending])
        expect((await itemRow(ctx.stub, id))!.status).toBe("cancelled");
      expect((await itemRow(ctx.stub, ids.done))!.status).toBe("completed");
    },
    T,
  );

  it(
    "an error → failed with an error item; open items cancelled; attention error",
    async ({ expect }) => {
      // 03 turn.ended table: "turn.ended carries error → failed". 02 Item model: error item content {code, detail}.
      // 03 Attention: "error: ... the newest turn ended failed".
      const ctx = await runningTurn();
      const ids = await openItems(ctx);
      await endTurn(ctx, ctx.sessionId, ctx.turnId, {
        stopReason: null,
        error: { code: "INTERNAL", message: "adapter blew up" },
      });
      const turn = (await turnRow(ctx.stub, ctx.turnId))!;
      expect(turn.status).toBe("failed");
      expect(turn.error_code).toEqual(expect.any(String));

      for (const id of [ids.message, ids.thought, ids.running, ids.pending])
        expect((await itemRow(ctx.stub, id))!.status).toBe("cancelled");

      const errors = await sql(
        ctx.stub,
        "SELECT * FROM items WHERE turn_id = ? AND kind = 'error'",
        ctx.turnId,
      );

      expect(errors).toHaveLength(1);
      const content = JSON.parse(Schema.decodeUnknownSync(Schema.String)(errors[0]!.content_json));
      expect(content.code).toBe(turn.error_code);
      expect(String(content.detail)).toContain("adapter blew up");
      await waitFor(async () => (await wsRow(ctx.stub)).attention === "error", 3000, "attention error");
      await waitFor(
        async () => (await d1Workspace(ctx.workspaceId))?.attention === "error",
        3000,
        "D1 attention error",
      );
    },
    T,
  );

  it(
    "a rejected credential → failed / CREDENTIAL_INVALID, and credential.invalid reaches the UI",
    async ({ expect }) => {
      // 03 Failure handling: "Credential rejected | turn.ended error, or credential.invalid | Turn failed / CREDENTIAL_INVALID; banner in the UI".
      // 02 Workspace channel: credential.invalid {provider}.
      const ctx = await runningTurn();
      const ui = await openUi(ctx);
      await backlogDone(ui);
      await emit(ctx, { kind: "credential.invalid", provider: "claude" });
      await endTurn(ctx, ctx.sessionId, ctx.turnId, {
        stopReason: null,
        error: { code: "CREDENTIAL_INVALID", message: "401 token expired" },
      });
      const turn = (await turnRow(ctx.stub, ctx.turnId))!;
      expect(turn.status).toBe("failed");
      expect(turn.error_code).toBe("CREDENTIAL_INVALID");
      await waitFor(() => ofType(ui, "credential.invalid").length === 1, 3000, "credential.invalid message");
      expect(ofType(ui, "credential.invalid")[0]).toEqual({ type: "credential.invalid", provider: "claude" });
      ui.close();
    },
    T,
  );

  it(
    "a codex turn error that mentions 401 → CREDENTIAL_INVALID",
    async ({ expect }) => {
      // 01 Codex auth.json sync step 7: a codex turn that fails with an error containing 401 or refresh_token is a
      // rejected credential; 03 Failure handling: "Turn failed / CREDENTIAL_INVALID".
      const ctx = await runningTurn({ agent: "codex" });
      await endTurn(ctx, ctx.sessionId, ctx.turnId, {
        stopReason: null,
        error: { code: "INTERNAL", message: "unexpected status 401 Unauthorized" },
      });
      const turn = (await turnRow(ctx.stub, ctx.turnId))!;
      expect(turn.status).toBe("failed");
      expect(turn.error_code).toBe("CREDENTIAL_INVALID");
    },
    T,
  );

  it(
    "a turn.ended for a turn that is not running is ignored",
    async ({ expect }) => {
      // 03 turn.ended applies to the running turn; a stray end (unknown or already-ended turn) changes nothing.
      const ctx = await runningTurn();

      const seq = await emit(ctx, {
        kind: "turn.ended",
        sessionId: ctx.sessionId,
        turnId: newId(),
        stopReason: "end_turn",
      });

      await applied(ctx.stub, seq);
      expect((await turnRow(ctx.stub, ctx.turnId))!.status).toBe("running");
      await endTurn(ctx, ctx.sessionId, ctx.turnId, { stopReason: "end_turn" });

      const again = await emit(ctx, {
        kind: "turn.ended",
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        stopReason: null,
        error: { code: "INTERNAL", message: "late" },
      });

      await applied(ctx.stub, again);
      expect((await turnRow(ctx.stub, ctx.turnId))!.status).toBe("completed");
    },
    T,
  );
});

// =============================================================================================
// 03 turn.ended steps 2–6
// =============================================================================================

const CKPT = (n: number) => ({
  commit: "1".repeat(39) + n,
  tree: "2".repeat(39) + n,
  parent: "3".repeat(39) + n,
  base: "4".repeat(40),
  bundlePath: "/home/tempo/.tempod/ckpt.bundle",
  bundleBytes: 2048,
});

describe.concurrent("after a turn ends", () => {
  it(
    "requests git.checkpoint turn_end, then git.changes branch, broadcasts changes, updates activity and attention",
    async ({ expect }) => {
      // 03 turn.ended steps 2, 4, 5: git.checkpoint {reason: "turn_end"}; git.changes {scope: "branch"} and broadcast
      // changes; last_activity_at = now, recompute attention, publish. 03 Attention: "unread: a turn ended after last_viewed_at".
      const files = [
        { path: "src/a.ts", status: "modified", additions: 3, deletions: 1 },
        { path: "src/b.ts", status: "added", additions: 10, deletions: 0 },
      ];

      const ctx = await runningTurn({
        configure: (t) =>
          t.on("git.changes", () => ({
            files,
            baseSha: "c".repeat(40),
            headSha: "d".repeat(40),
            ahead: 0,
            dirty: true,
          })),
      });

      const ui = await openUi(ctx);
      await backlogDone(ui);
      const before = await wsRow(ctx.stub);
      expect(before.attention).toBe("none");
      await settle(5);
      await endTurn(ctx, ctx.sessionId, ctx.turnId);

      await waitFor(() => ctx.tempod.requestsOf("git.checkpoint").length === 1, 3000, "git.checkpoint");
      const ck = ctx.tempod.requestsOf("git.checkpoint")[0];
      expect(ck).toEqual({
        checkpointId: expect.stringMatching(/^[0-9a-hjkmnp-tv-z]{26}$/),
        turnId: ctx.turnId,
        reason: "turn_end",
      });

      await waitFor(
        () => ctx.tempod.requestsOf("git.changes").some((p) => p.scope === "branch"),
        5000,
        "git.changes",
      );
      await waitFor(() => ofType(ui, "changes").length > 0, 5000, "changes message");
      expect(ofType(ui, "changes").at(-1)).toEqual({ type: "changes", files, additions: 13, deletions: 1 });

      await waitReady(ctx);
      expect(ofType(ui, "turn").some((m) => m.turn.id === ctx.turnId && m.turn.status === "completed")).toBe(
        true,
      );
      const after = await wsRow(ctx.stub);
      const turn = (await turnRow(ctx.stub, ctx.turnId))!;
      expect(after.last_activity_at).toBeGreaterThan(
        Schema.decodeUnknownSync(Schema.Number)(before.last_activity_at),
      );
      expect(after.last_activity_at).toBeGreaterThanOrEqual(
        Schema.decodeUnknownSync(Schema.Number)(turn.ended_at),
      );
      expect(after.attention).toBe("unread");
      await waitFor(
        async () => (await d1Workspace(ctx.workspaceId))?.attention === "unread",
        3000,
        "D1 unread",
      );
      expect((await d1Workspace(ctx.workspaceId))!.last_activity_at).toBe(after.last_activity_at);

      // markViewed after the turn ended clears unread (03 Viewed).
      unwrap(await ctx.stub.markViewed({}));
      expect((await wsRow(ctx.stub)).attention).toBe("none");
      ui.close();
    },
    T,
  );

  it(
    "a checkpoint result inserts a row and sets turns.checkpoint_id; unchanged reuses the newest checkpoint",
    async ({ expect }) => {
      // 03 turn.ended step 2: "On a result, insert the checkpoint row, upload the bundle, and set turns.checkpoint_id to
      // the new id. On {unchanged: true}, insert no row and set turns.checkpoint_id to the newest existing checkpoint."
      const ctx = await runningTurn({ configure: (t) => t.on("git.checkpoint", () => CKPT(1)) });
      await endTurn(ctx, ctx.sessionId, ctx.turnId);
      await waitFor(
        async () => (await turnRow(ctx.stub, ctx.turnId))?.checkpoint_id !== null,
        3000,
        "checkpoint id",
      );
      const sent = ctx.tempod.requestsOf("git.checkpoint")[0];
      const t1 = (await turnRow(ctx.stub, ctx.turnId))!;
      expect(t1.checkpoint_id).toBe(sent.checkpointId);
      const rows = await sql(ctx.stub, "SELECT * FROM checkpoints");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: sent.checkpointId,
        turn_id: ctx.turnId,
        reason: "turn_end",
        commit_sha: CKPT(1).commit,
        tree_sha: CKPT(1).tree,
        parent_sha: CKPT(1).parent,
        base_sha: CKPT(1).base,
        bundle_bytes: 2048,
      });
      await waitReady(ctx);

      ctx.tempod.on("git.checkpoint", () => ({ unchanged: true }));
      const turn2 = await prompt(ctx, ctx.sessionId, "Again");
      await waitPrompt(ctx, turn2);
      await endTurn(ctx, ctx.sessionId, turn2);
      await waitFor(
        () => ctx.tempod.requestsOf("git.checkpoint").length === 2,
        3000,
        "second checkpoint request",
      );
      await waitFor(
        async () => (await turnRow(ctx.stub, turn2))?.checkpoint_id !== null,
        3000,
        "checkpoint id 2",
      );
      expect((await turnRow(ctx.stub, turn2))!.checkpoint_id).toBe(sent.checkpointId);
      expect(await sql(ctx.stub, "SELECT id FROM checkpoints")).toHaveLength(1);
      await waitReady(ctx);

      // "The newest existing checkpoint", whatever made it (here a pre_revert safety checkpoint).
      const newer = newId();
      await sql(
        ctx.stub,
        "INSERT INTO checkpoints (id, turn_id, reason, commit_sha, tree_sha, parent_sha, base_sha, local_only, created_at) VALUES (?, NULL, 'pre_revert', ?, ?, ?, ?, 1, ?)",
        newer,
        "5".repeat(40),
        "6".repeat(40),
        "7".repeat(40),
        "4".repeat(40),
        Date.now() + 1000,
      );
      const turn3 = await prompt(ctx, ctx.sessionId, "Once more");
      await waitPrompt(ctx, turn3);
      await endTurn(ctx, ctx.sessionId, turn3);
      await waitFor(
        async () => (await turnRow(ctx.stub, turn3))?.checkpoint_id !== null,
        3000,
        "checkpoint id 3",
      );
      expect((await turnRow(ctx.stub, turn3))!.checkpoint_id).toBe(newer);
      expect(await sql(ctx.stub, "SELECT id FROM checkpoints")).toHaveLength(2);
    },
    T,
  );

  it(
    "a bundle that cannot be uploaded is marked local_only after 3 attempts",
    async ({ expect }) => {
      // 03 Failure handling: "Checkpoint bundle upload fails | bundle.upload | 3 attempts, then local_only".
      // (The fake container cannot read files, so every upload attempt fails.)
      const ctx = await runningTurn({ configure: (t) => t.on("git.checkpoint", () => CKPT(2)) });
      await fastRetries(ctx.stub);
      await endTurn(ctx, ctx.sessionId, ctx.turnId);
      await waitFor(
        async () => (await sql(ctx.stub, "SELECT local_only FROM checkpoints"))[0]?.local_only === 1,
        5000,
        "local_only",
      );
      const row = (await sql(ctx.stub, "SELECT * FROM checkpoints"))[0]!;
      expect(row.r2_key).toBeNull();
      // The upload runs in the background: changes are still refreshed afterwards (step 4).
      await waitFor(() => ctx.tempod.requestsOf("git.changes").length > 0, 5000, "git.changes");
    },
    T,
  );

  it(
    "unchanged with no earlier checkpoint inserts no row and leaves checkpoint_id null",
    async ({ expect }) => {
      // 03 turn.ended step 2: unchanged → no row; checkpoint_id = the newest existing checkpoint (there is none).
      const ctx = await runningTurn();
      await endTurn(ctx, ctx.sessionId, ctx.turnId);
      await waitFor(() => ctx.tempod.requestsOf("git.checkpoint").length === 1, 3000, "git.checkpoint");
      await waitReady(ctx);
      expect((await turnRow(ctx.stub, ctx.turnId))!.checkpoint_id).toBeNull();
      expect(await sql(ctx.stub, "SELECT id FROM checkpoints")).toHaveLength(0);
    },
    T,
  );

  it(
    "a failed git.checkpoint does not block the turn end or the next queued turn",
    async ({ expect }) => {
      // 03 Step limits: git.checkpoint "Skip; log warn". 03 turn.ended: steps 2-4 "MUST NOT block the next queued turn
      // longer than the checkpoint request itself".
      const ctx = await runningTurn({
        configure: (t) => t.fail("git.checkpoint", "INTERNAL", "git exploded"),
      });

      const turn2 = await prompt(ctx, ctx.sessionId, "Next one");
      await endTurn(ctx, ctx.sessionId, ctx.turnId);
      expect((await turnRow(ctx.stub, ctx.turnId))!.status).toBe("completed");
      await waitPrompt(ctx, turn2);
      expect((await turnRow(ctx.stub, ctx.turnId))!.checkpoint_id).toBeNull();
      expect(await sql(ctx.stub, "SELECT id FROM checkpoints")).toHaveLength(0);
    },
    T,
  );

  it(
    "starts the next queued turn; the state stays working, then returns to ready when the queue is empty",
    async ({ expect }) => {
      // 03 turn.ended step 6: "Run the queue runner. If no turn starts, the state goes back to ready."
      // 03 Transitions: working → working when another turn is queued; working → ready when the queue is empty.
      const ctx = await runningTurn();
      const turn2 = await prompt(ctx, ctx.sessionId, "Second");
      const turn3 = await prompt(ctx, ctx.sessionId, "Third");
      await settle();
      // 01 Sessions: "Only one turn runs per workspace at a time."
      expect(ctx.tempod.requestsOf("session.prompt")).toHaveLength(1);
      expect((await turnRow(ctx.stub, turn2))!.status).toBe("queued");
      expect((await detail(ctx.stub)).queue).toEqual([turn2, turn3]);

      await endTurn(ctx, ctx.sessionId, ctx.turnId);
      const p2 = await waitPrompt(ctx, turn2);
      expect(p2.content.at(-1)).toEqual({ type: "text", text: "Second" });
      expect((await wsRow(ctx.stub)).state).toBe("working");
      // 03 Start the turn step 3: turn running, session running, state working, started_at = now, queue_pos = null.
      const started = (await turnRow(ctx.stub, turn2))!;
      expect(started.queue_pos).toBeNull();
      expect(started.started_at).toBeGreaterThanOrEqual(
        Schema.decodeUnknownSync(Schema.Number)((await turnRow(ctx.stub, ctx.turnId))!.ended_at),
      );
      expect((await sessionRow(ctx.stub, ctx.sessionId))!.status).toBe("running");
      expect((await turnRow(ctx.stub, turn3))!.status).toBe("queued");

      await endTurn(ctx, ctx.sessionId, turn2);
      await waitPrompt(ctx, turn3);
      await endTurn(ctx, ctx.sessionId, turn3);
      await waitReady(ctx);
      expect(ctx.tempod.requestsOf("session.prompt")).toHaveLength(3);
      expect((await detail(ctx.stub)).runningTurnId).toBeNull();
    },
    T,
  );
});

// =============================================================================================
// Other events
// =============================================================================================

describe.concurrent("permission.requested", () => {
  it(
    "stores the request, sends a permission message and sets attention needs_input",
    async ({ expect }) => {
      // 03 While it runs: "Store permission.requested in permissions, create a permission item, recompute attention."
      // 02 Workspace channel: permission {request: PermissionRequest}. 03 Attention: "needs_input: a permission request is pending."
      const ctx = await runningTurn();
      const ui = await openUi(ctx);
      await backlogDone(ui);
      const itemId = newId();
      const requestId = `req-${newId()}`;

      const options = [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ];

      await emit(
        ctx,
        itemCreated(ctx.sessionId, ctx.turnId, {
          id: itemId,
          kind: "permission",
          status: "pending",
          content: { requestId, toolCallId: "call-1", title: "Run rm -rf build", options },
        }),
      );

      const seq = await emit(ctx, {
        kind: "permission.requested",
        requestId,
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        itemId,
        title: "Run rm -rf build",
        options,
      });

      await applied(ctx.stub, seq);

      const rows = await sql(ctx.stub, "SELECT * FROM permissions WHERE request_id = ?", requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        session_id: ctx.sessionId,
        turn_id: ctx.turnId,
        item_id: itemId,
        status: "pending",
      });
      expect(JSON.parse(Schema.decodeUnknownSync(Schema.String)(rows[0]!.options_json))).toEqual(options);
      expect((await itemRow(ctx.stub, itemId))!.kind).toBe("permission");

      await waitFor(() => ofType(ui, "permission").length === 1, 3000, "permission message");
      expect(ofType(ui, "permission")[0].request).toEqual({
        requestId,
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        itemId,
        title: "Run rm -rf build",
        options,
      });
      expect((await wsRow(ctx.stub)).attention).toBe("needs_input");
      await waitFor(
        async () => (await d1Workspace(ctx.workspaceId))?.attention === "needs_input",
        3000,
        "D1 needs_input",
      );

      // Answering it clears needs_input.
      unwrap(await ctx.stub.respondPermission({ requestId, optionId: "allow" }));
      expect(ctx.tempod.requestsOf("permission.respond")).toEqual([{ requestId, optionId: "allow" }]);
      expect((await wsRow(ctx.stub)).attention).not.toBe("needs_input");
      ui.close();
    },
    T,
  );

  it(
    "pending permissions of a cancelled turn do not keep needs_input",
    async ({ expect }) => {
      // 01 Permission requests: "If the turn is cancelled first, it answers {outcome: cancelled}". 03 Attention needs_input
      // requires a pending request; the ended turn has none to answer.
      const ctx = await runningTurn();
      const itemId = newId();
      const requestId = `req-${newId()}`;
      const options = [{ optionId: "allow", name: "Allow", kind: "allow_once" }];
      await emit(
        ctx,
        itemCreated(ctx.sessionId, ctx.turnId, {
          id: itemId,
          kind: "permission",
          status: "pending",
          content: { requestId, toolCallId: "c", title: "x", options },
        }),
      );
      await applied(
        ctx.stub,
        await emit(ctx, {
          kind: "permission.requested",
          requestId,
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          itemId,
          title: "x",
          options,
        }),
      );
      expect((await wsRow(ctx.stub)).attention).toBe("needs_input");
      expect((await itemRow(ctx.stub, itemId))!.status).toBe("pending");
      await endTurn(ctx, ctx.sessionId, ctx.turnId, { stopReason: "cancelled" });
      // 02 Status: the open permission item of the cancelled turn becomes cancelled.
      expect((await itemRow(ctx.stub, itemId))!.status).toBe("cancelled");
      // 03 Attention: "needs_input: a permission request is pending." The ended turn's request no longer is.
      expect(
        (await sql(ctx.stub, "SELECT status FROM permissions WHERE request_id = ?", requestId))[0]!.status,
      ).toBe("cancelled");
      await waitReady(ctx);
      await waitFor(
        async () => (await wsRow(ctx.stub)).attention !== "needs_input",
        3000,
        "attention recomputed",
      );
      expect((await wsRow(ctx.stub)).attention).toBe("unread");
      await waitFor(
        async () => (await d1Workspace(ctx.workspaceId))?.attention === "unread",
        3000,
        "D1 unread",
      );
      // 03 Activity: "A permission request is pending" no longer keeps the workspace awake.
      expect(await runInDurableObject(ctx.stub, (i: WorkspaceDO) => internals(i).core.isActive(0))).toBe(
        false,
      );
    },
    T,
  );

  it(
    "a turn that fails while a permission is pending (the agent crashed) shows error, not needs_input",
    async ({ expect }) => {
      // 03 Failure handling: "Adapter exits during a turn | Turn failed / AGENT_CRASHED". 03 Attention: needs_input needs a
      // pending request; then "error: ... the newest turn ended failed".
      const ctx = await runningTurn();
      const itemId = newId();
      const requestId = `req-${newId()}`;
      const options = [{ optionId: "allow", name: "Allow", kind: "allow_once" }];
      await emit(
        ctx,
        itemCreated(ctx.sessionId, ctx.turnId, {
          id: itemId,
          kind: "permission",
          status: "pending",
          content: { requestId, toolCallId: "c", title: "x", options },
        }),
      );
      await applied(
        ctx.stub,
        await emit(ctx, {
          kind: "permission.requested",
          requestId,
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          itemId,
          title: "x",
          options,
        }),
      );
      expect((await wsRow(ctx.stub)).attention).toBe("needs_input");
      await applied(
        ctx.stub,
        await emit(ctx, {
          kind: "agent.exited",
          sessionId: ctx.sessionId,
          code: 1,
          signal: null,
          stderrTail: "boom",
          reason: "crashed",
        }),
      );
      expect((await turnRow(ctx.stub, ctx.turnId))!.status).toBe("failed");
      expect(
        (await sql(ctx.stub, "SELECT status FROM permissions WHERE request_id = ?", requestId))[0]!.status,
      ).toBe("cancelled");
      await waitFor(async () => (await wsRow(ctx.stub)).attention === "error", 3000, "attention error");
      await waitFor(
        async () => (await d1Workspace(ctx.workspaceId))?.attention === "error",
        3000,
        "D1 error",
      );
    },
    T,
  );
});

describe.concurrent("agent.exited", () => {
  it(
    "during a turn: turn failed / AGENT_CRASHED, a notice with the stderr tail, and the next prompt reloads the session",
    async ({ expect }) => {
      // 03 Failure handling: "Adapter exits during a turn | agent.exited | Turn failed / AGENT_CRASHED; notice with
      // stderrTail; next prompt reloads".
      const ctx = await runningTurn();
      const acp = (await sessionRow(ctx.stub, ctx.sessionId))!.acp_session_id;
      await runInDurableObject(ctx.stub, (i: WorkspaceDO) => {
        expect(internals(i).core.liveSessions.has(ctx.sessionId)).toBe(true);
      });

      const seq = await emit(ctx, {
        kind: "agent.exited",
        sessionId: ctx.sessionId,
        code: 1,
        signal: null,
        stderrTail: "Error: segfault in adapter\n    at main (adapter.js:1)",
      });

      await applied(ctx.stub, seq);
      await waitFor(
        async () => (await turnRow(ctx.stub, ctx.turnId))?.status === "failed",
        3000,
        "turn failed",
      );
      expect((await turnRow(ctx.stub, ctx.turnId))!.error_code).toBe("AGENT_CRASHED");

      const errors = await sql(
        ctx.stub,
        "SELECT content_json FROM items WHERE turn_id = ? AND kind = 'error'",
        ctx.turnId,
      );

      expect(errors).toHaveLength(1);
      expect(JSON.parse(Schema.decodeUnknownSync(Schema.String)(errors[0]!.content_json)).code).toBe(
        "AGENT_CRASHED",
      );

      const notices = await sql(
        ctx.stub,
        "SELECT * FROM items WHERE session_id = ? AND kind = 'notice'",
        ctx.sessionId,
      );

      expect(
        notices.some((n) =>
          JSON.parse(Schema.decodeUnknownSync(Schema.String)(n.content_json)).text.includes(
            "Error: segfault in adapter",
          ),
        ),
      ).toBe(true);
      await runInDurableObject(ctx.stub, (i: WorkspaceDO) => {
        expect(internals(i).core.liveSessions.has(ctx.sessionId)).toBe(false);
      });
      await waitReady(ctx);

      const turn2 = await prompt(ctx, ctx.sessionId, "Try again");
      await waitPrompt(ctx, turn2);
      const starts = ctx.tempod.requestsOf("session.start");
      expect(starts).toHaveLength(2);
      // 01 Reload after a restart: the DO asks tempod to load the stored ACP session.
      expect(starts[1]).toMatchObject({ sessionId: ctx.sessionId, acpSessionId: acp });
    },
    T,
  );

  it(
    "with no running turn: no turn fails, but the next prompt reloads the session",
    async ({ expect }) => {
      // 01 Sessions, Crashes: "A running turn ends as failed" — only a running turn. 03: "next prompt reloads".
      const ctx = await runningTurn();
      await endTurn(ctx, ctx.sessionId, ctx.turnId);
      await waitReady(ctx);

      const seq = await emit(ctx, {
        kind: "agent.exited",
        sessionId: ctx.sessionId,
        code: null,
        signal: "SIGKILL",
        stderrTail: "",
      });

      await applied(ctx.stub, seq);
      expect((await turnRow(ctx.stub, ctx.turnId))!.status).toBe("completed");
      expect((await wsRow(ctx.stub)).state).toBe("ready");
      const turn2 = await prompt(ctx, ctx.sessionId, "More");
      await waitPrompt(ctx, turn2);
      expect(ctx.tempod.requestsOf("session.start")).toHaveLength(2);
    },
    T,
  );

  it(
    "for another session does not fail the running turn",
    async ({ expect }) => {
      // 03 Failure handling: the turn fails only when its own adapter exits.
      const ctx = await runningTurn();

      const seq = await emit(ctx, {
        kind: "agent.exited",
        sessionId: newId(),
        code: 1,
        signal: null,
        stderrTail: "x",
      });

      await applied(ctx.stub, seq);
      expect((await turnRow(ctx.stub, ctx.turnId))!.status).toBe("running");
    },
    T,
  );
});

describe.concurrent("script.output", () => {
  const SETUP = { ...DEFAULT_EFFECTIVE, scripts: { ...DEFAULT_EFFECTIVE.scripts, setup: "bun install" } };

  /** A workspace whose setup script is running. */
  const setupRunning = async (opts: { prompt?: string } = {}) => {
    const seeded = await seedProject();
    await seedCredentials(seeded.userId);

    const { workspaceId, stub, tempod } = await seedWorkspace(
      seeded,
      opts.prompt ? { prompt: opts.prompt } : {},
    );

    tempod.on("settings.read", () => ({ effective: SETUP, warnings: [], errors: [], sources: {} }));
    const ctx: Ctx = { seeded, workspaceId, stub, tempod };
    await driveUntil(stub, () => tempod.requestsOf("script.start").length === 1);
    const runId: string = tempod.requestsOf("script.start")[0].runId;
    await waitFor(async () => (await wsRow(stub)).setup_status === "running", 3000, "setup running");

    return { ...ctx, runId };
  };

  it(
    "appends output to the run's log tail and sends script.output to the UI",
    async ({ expect }) => {
      // 01 Scripts, Output: "tempod sends script.output {runId, stream, data} ... The WorkspaceDO keeps the last 1 MiB of
      // each run in SQLite." 02 Workspace channel: script.output {runId, stream, data}.
      const ctx = await setupRunning();
      const ui = await openUi(ctx);
      await backlogDone(ui);
      await emit(ctx, { kind: "script.output", runId: ctx.runId, stream: "stdout", data: "installing\n" });

      const seq = await emit(ctx, {
        kind: "script.output",
        runId: ctx.runId,
        stream: "stderr",
        data: "warn: peer dep\n",
      });

      await applied(ctx.stub, seq);
      const run = (await sql(ctx.stub, "SELECT * FROM script_runs WHERE id = ?", ctx.runId))[0]!;
      expect(run.log_tail).toBe("installing\nwarn: peer dep\n");
      await waitFor(() => ofType(ui, "script.output").length === 2, 3000, "script.output messages");
      expect(ofType(ui, "script.output")).toEqual([
        { type: "script.output", runId: ctx.runId, stream: "stdout", data: "installing\n" },
        { type: "script.output", runId: ctx.runId, stream: "stderr", data: "warn: peer dep\n" },
      ]);
      ui.close();
    },
    T,
  );

  it(
    "keeps only the last 1 MiB of output",
    async ({ expect }) => {
      // 01 Scripts, Output: "keeps the last 1 MiB of each run". 02 script_runs.log_tail: "last 1 MiB".
      const ctx = await setupRunning();
      const chunk = (c: string) => c.repeat(400 * 1024);
      await emit(ctx, { kind: "script.output", runId: ctx.runId, stream: "stdout", data: chunk("a") });
      await emit(ctx, { kind: "script.output", runId: ctx.runId, stream: "stdout", data: chunk("b") });
      await emit(ctx, { kind: "script.output", runId: ctx.runId, stream: "stdout", data: chunk("c") });
      const seq = await emit(ctx, { kind: "script.output", runId: ctx.runId, stream: "stdout", data: "END" });
      await applied(ctx.stub, seq);

      const tail = Schema.decodeUnknownSync(Schema.String)(
        (await sql(ctx.stub, "SELECT log_tail FROM script_runs WHERE id = ?", ctx.runId))[0]!.log_tail,
      );

      expect(new TextEncoder().encode(tail).length).toBe(1024 * 1024);
      expect(tail.endsWith(chunk("c") + "END")).toBe(true);
      expect(tail.startsWith("a")).toBe(true);
      expect(tail).toContain(chunk("b"));
    },
    T,
  );

  // Regression (fixed): appendLog (src/do/workspace/scripts.ts) trims the tail by UTF-16 code units, not bytes, so non-ASCII
  // output keeps up to 2-3 MiB (observed 2,097,149 bytes for 2-byte characters).
  it(
    "keeps at most 1 MiB (bytes) of non-ASCII output",
    async ({ expect }) => {
      // 01 Scripts, Output: "The WorkspaceDO keeps the last 1 MiB of each run in SQLite."
      const ctx = await setupRunning();
      const chunk = "é".repeat(300 * 1024); // 600 KiB of UTF-8 per message

      for (let i = 0; i < 4; i++)
        await emit(ctx, { kind: "script.output", runId: ctx.runId, stream: "stdout", data: chunk });
      const seq = await emit(ctx, { kind: "script.output", runId: ctx.runId, stream: "stdout", data: "END" });
      await applied(ctx.stub, seq);

      const tail = Schema.decodeUnknownSync(Schema.String)(
        (await sql(ctx.stub, "SELECT log_tail FROM script_runs WHERE id = ?", ctx.runId))[0]!.log_tail,
      );

      expect(tail.endsWith("END")).toBe(true);
      expect(new TextEncoder().encode(tail).length).toBeLessThanOrEqual(1024 * 1024);
    },
    T,
  );

  it(
    "output for an unknown run is dropped without creating a run",
    async ({ expect }) => {
      // 01 Scripts, Output: the tail belongs to a run; output for no known run has nowhere to go.
      const ctx = await setupRunning();
      const unknown = newId();
      await emit(ctx, { kind: "script.output", runId: unknown, stream: "stdout", data: "ghost" });

      const seq = await emit(ctx, {
        kind: "script.output",
        runId: ctx.runId,
        stream: "stdout",
        data: "real",
      });

      await applied(ctx.stub, seq);
      expect(await sql(ctx.stub, "SELECT id FROM script_runs WHERE id = ?", unknown)).toHaveLength(0);
      expect(
        (await sql(ctx.stub, "SELECT log_tail FROM script_runs WHERE id = ?", ctx.runId))[0]!.log_tail,
      ).toBe("real");
    },
    T,
  );

  it(
    "prompts queued during setup wait; a successful setup starts them in queue order, one at a time",
    async ({ expect }) => {
      // 01 Setup script: "Prompts sent before setup ends wait in the queue. On exit code 0, the queue continues."
      // 03 Queue runner: state ready, setup_status none/succeeded/skipped, no running turn.
      const ctx = await setupRunning({ prompt: "First prompt" });

      const sessionId = Schema.decodeUnknownSync(Schema.String)(
        (await sql(ctx.stub, "SELECT id FROM sessions"))[0]!.id,
      );

      const first = Schema.decodeUnknownSync(Schema.String)(
        (await sql(ctx.stub, "SELECT id FROM turns WHERE seq = 1"))[0]!.id,
      );

      const second = await prompt(ctx, sessionId, "Second prompt");
      await settle();
      expect((await wsRow(ctx.stub)).state).toBe("setting_up");
      expect(ctx.tempod.requestsOf("session.prompt")).toHaveLength(0);
      expect((await turnRow(ctx.stub, first))!.status).toBe("queued");
      expect((await turnRow(ctx.stub, second))!.status).toBe("queued");

      await emit(ctx, {
        kind: "script.exited",
        runId: ctx.runId,
        exitCode: 0,
        signal: null,
        timedOut: false,
      });
      await driveUntil(ctx.stub, (s) => s === "working");
      const p = await waitPrompt(ctx, first);
      expect(p.content.at(-1)).toEqual({ type: "text", text: "First prompt" });
      expect((await wsRow(ctx.stub)).setup_status).toBe("succeeded");
      await settle();
      expect(ctx.tempod.requestsOf("session.prompt")).toHaveLength(1);
      expect((await turnRow(ctx.stub, second))!.status).toBe("queued");
    },
    T,
  );
});

describe.concurrent("ports.changed", () => {
  it(
    "updates detail.ports with a preview URL per port and tells the UI",
    async ({ expect }) => {
      // 01 Ports: "Each port P becomes a preview." Preview URL:
      // "https://<P>-<workspaceId lowercase>.<PREVIEW_DOMAIN>". 02 WorkspaceDetail.ports: [{port, url}].
      const ctx = await readyWorkspace();
      const ui = await openUi(ctx);
      await backlogDone(ui);
      const url = (p: number) => `https://${p}-${ctx.workspaceId.toLowerCase()}.previews.test`;

      await applied(ctx.stub, await emit(ctx, { kind: "ports.changed", ports: [5173, 3000] }));
      const ports = [...(await detail(ctx.stub)).ports].sort((a: any, b: any) => a.port - b.port);
      expect(ports).toEqual([
        { port: 3000, url: url(3000) },
        { port: 5173, url: url(5173) },
      ]);
      await waitFor(
        () => ofType(ui, "workspace").some((m) => m.workspace.ports.length === 2),
        3000,
        "workspace message with ports",
      );

      await applied(ctx.stub, await emit(ctx, { kind: "ports.changed", ports: [5173] }));
      expect((await detail(ctx.stub)).ports).toEqual([{ port: 5173, url: url(5173) }]);
      expect((await sql(ctx.stub, "SELECT port FROM ports")).map((r) => r.port)).toEqual([5173]);

      await applied(ctx.stub, await emit(ctx, { kind: "ports.changed", ports: [] }));
      expect((await detail(ctx.stub)).ports).toEqual([]);
      ui.close();
    },
    T,
  );
});

describe.concurrent("settings.changed", () => {
  it(
    "stores the effective settings and issues, and sends env.set with the new env",
    async ({ expect }) => {
      // 02 tempod protocol: "After settings.read, and whenever project env vars or secrets change, the DO sends env.set".
      // 02 WorkspaceDO schema: settings_json = effective settings, last read.
      const ctx = await readyWorkspace();
      await env.CREDENTIALS.getByName(ctx.seeded.userId).putSecret(
        `project.${ctx.seeded.projectId}.env.DB_PASSWORD`,
        "hunter2",
      );
      const envSets = ctx.tempod.requestsOf("env.set").length;

      const effective = {
        ...DEFAULT_EFFECTIVE,
        environment_variables: { API_URL: "http://localhost:4000" },
        scripts: {
          ...DEFAULT_EFFECTIVE.scripts,
          run: { web: { command: "bun dev", cwd: "", default: true } },
        },
      };

      const seq = await emit(ctx, {
        kind: "settings.changed",
        effective,
        warnings: ["unknown key foo"],
        errors: ["bad instance"],
        sources: { "scripts.run": ".tempo" },
      });

      await applied(ctx.stub, seq);
      expect(
        JSON.parse(Schema.decodeUnknownSync(Schema.String)((await wsRow(ctx.stub)).settings_json)),
      ).toEqual(effective);
      const d = await detail(ctx.stub);
      expect(d.settings).toEqual(effective);
      expect(d.settingsWarnings).toEqual(["unknown key foo"]);
      expect(d.settingsErrors).toEqual(["bad instance"]);
      await waitFor(() => ctx.tempod.requestsOf("env.set").length === envSets + 1, 3000, "env.set");
      const sent = ctx.tempod.requestsOf("env.set").at(-1).env;
      // 01 Script env: TEMPO_* vars plus the project's environment_variables and secrets.
      expect(sent).toMatchObject({
        API_URL: "http://localhost:4000",
        DB_PASSWORD: "hunter2",
        TEMPO_WORKSPACE_ID: ctx.workspaceId,
        TEMPO_WORKSPACE_PATH: "/workspace",
        TEMPO_PORT: "3000",
      });

      // The secret never lands in the events table (02 Rules; AGENTS.md rule 9).
      for (const e of await sql(ctx.stub, "SELECT payload_json FROM events"))
        expect(e.payload_json).not.toContain("hunter2");
    },
    T,
  );

  it(
    "an invalid settings.changed is dropped and later events still apply",
    async ({ expect }) => {
      // 01 Project settings: settings must validate; 02 Rules: events still apply in seq order after a bad one.
      const ctx = await readyWorkspace();
      const before = (await wsRow(ctx.stub)).settings_json;
      const envSets = ctx.tempod.requestsOf("env.set").length;
      await emit(ctx, {
        kind: "settings.changed",
        effective: {
          ...DEFAULT_EFFECTIVE,
          environment: { ...DEFAULT_EFFECTIVE.environment, sleep_after_idle_minutes: 1 },
        },
        warnings: [],
        errors: [],
      });
      const seq = await emit(ctx, { kind: "ports.changed", ports: [3000] });
      await applied(ctx.stub, seq);
      expect((await wsRow(ctx.stub)).settings_json).toBe(before);
      expect((await detail(ctx.stub)).ports.map((p: any) => p.port)).toEqual([3000]);
      await settle();
      expect(ctx.tempod.requestsOf("env.set")).toHaveLength(envSets);
    },
    T,
  );
});

describe.concurrent("credential.changed", () => {
  const authJson = (access: string, refresh: string) =>
    JSON.stringify({
      tokens: { access_token: access, refresh_token: refresh },
      last_refresh: new Date().toISOString(),
    });

  it(
    "goes to CredentialDO and is never stored in the events table",
    async ({ expect }) => {
      // 02 tempod protocol, Rules: "credential.changed carries a secret. The DO MUST NOT store it in events; it goes
      // straight to CredentialDO." 01 Codex auth.json sync step 4: offerCodexAuth stores it if lastRefresh is newer.
      const ctx = await readyWorkspace({ agent: "codex" });
      const access = `at-secret-${newId()}`;
      const refresh = `rt-secret-${newId()}`;
      const content = authJson(access, refresh);
      const lastRefresh = Date.now();
      const seq = await emit(ctx, { kind: "credential.changed", provider: "codex", content, lastRefresh });
      await applied(ctx.stub, seq);
      const stored = await env.CREDENTIALS.getByName(ctx.seeded.userId).getCodexAuth();
      expect(stored).toMatchObject({ content, lastRefresh });

      const events = await sql(ctx.stub, "SELECT kind, payload_json FROM events");

      for (const e of events) {
        expect(e.payload_json).not.toContain(access);
        expect(e.payload_json).not.toContain(refresh);
      }

      // An older copy is not stored (01 step 4: "only if lastRefresh is newer").
      const older = authJson(`at-old-${newId()}`, `rt-old-${newId()}`);
      await applied(
        ctx.stub,
        await emit(ctx, {
          kind: "credential.changed",
          provider: "codex",
          content: older,
          lastRefresh: lastRefresh - 60_000,
        }),
      );
      expect((await env.CREDENTIALS.getByName(ctx.seeded.userId).getCodexAuth())?.content).toBe(content);

      for (const e of await sql(ctx.stub, "SELECT payload_json FROM events"))
        expect(e.payload_json).not.toContain("at-old-");
    },
    T,
  );
});

describe.concurrent("git.changed", () => {
  it(
    "broadcasts changes {files, additions, deletions} and keeps them on the workspace detail",
    async ({ expect }) => {
      // 02 Workspace channel: changes {files, additions, deletions} "git.changed from tempod".
      const ctx = await readyWorkspace();
      const ui = await openUi(ctx);
      await backlogDone(ui);

      const files = [
        { path: "README.md", status: "modified", additions: 2, deletions: 2 },
        { path: "src/new.ts", status: "added", additions: 40, deletions: 0 },
        { path: "src/old.ts", status: "deleted", additions: 0, deletions: 7 },
      ];

      await applied(ctx.stub, await emit(ctx, { kind: "git.changed", files, additions: 42, deletions: 9 }));
      await waitFor(() => ofType(ui, "changes").length === 1, 3000, "changes message");
      expect(ofType(ui, "changes")[0]).toEqual({ type: "changes", files, additions: 42, deletions: 9 });
      expect((await detail(ctx.stub)).changes).toEqual({ files, additions: 42, deletions: 9 });
      ui.close();
    },
    T,
  );
});

describe.concurrent("tempod.stopping", () => {
  it(
    "SIGTERM: requests git.checkpoint sigterm, then shutdown; the interrupted turn gets a notice",
    async ({ expect }) => {
      // 03 Failure handling: "tempod gets SIGTERM | tempod | tempod sends tempod.stopping, and the running turn ends
      // interrupted. The DO requests git.checkpoint {reason: "sigterm"}, uploads the bundle, runs home.backup, then sends shutdown."
      const ctx = await runningTurn();
      await emit(ctx, {
        kind: "turn.ended",
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        stopReason: "cancelled",
        interrupted: true,
      });
      await applied(ctx.stub, await emit(ctx, { kind: "tempod.stopping", reason: "sigterm" }));
      await waitFor(() => ctx.tempod.requestsOf("shutdown").length === 1, 5000, "shutdown");
      expect((await turnRow(ctx.stub, ctx.turnId))!.status).toBe("interrupted");
      const ops = ctx.tempod.requests.map((r) => r.op);

      const sigterm = ctx.tempod.requests.findIndex(
        (r) => r.op === "git.checkpoint" && r.params.reason === "sigterm",
      );

      expect(sigterm).toBeGreaterThanOrEqual(0);
      expect(sigterm).toBeLessThan(ops.lastIndexOf("shutdown"));
      expect(ctx.tempod.requestsOf("shutdown")[0]).toEqual({ reason: "sigterm" });

      const notices = await sql(
        ctx.stub,
        "SELECT content_json FROM items WHERE kind = 'notice' AND turn_id = ?",
        ctx.turnId,
      );

      expect(notices.length).toBeGreaterThan(0);
    },
    T,
  );
});

describe.concurrent("outbox.overflow", () => {
  it(
    "adds a warning notice that live events were lost",
    async ({ expect }) => {
      // 03 Failure handling: "Outbox overflow | outbox.overflow | Notice item: some live events were lost; the transcript may have gaps".
      // 02 Item model: notice {level: "info" or "warning" or "error", text}.
      const ctx = await runningTurn();
      const seq = await emit(ctx, { kind: "outbox.overflow", dropped: 42 });
      await applied(ctx.stub, seq);

      const notices = (await sql(ctx.stub, "SELECT * FROM items WHERE kind = 'notice'")).map((n) => ({
        ...n,
        session_id: n.session_id,
        content: JSON.parse(Schema.decodeUnknownSync(Schema.String)(n.content_json)),
      }));

      expect(notices).toHaveLength(1);
      expect(notices[0]!.content.level).toBe("warning");
      expect(notices[0]!.content.text.toLowerCase()).toContain("lost");
      expect(notices[0]!.session_id).toBe(ctx.sessionId);
    },
    T,
  );
});

// =============================================================================================
// Queue runner: content blocks (01 Sessions, Send a prompt) and scheduling (03 Queue runner)
// =============================================================================================

/** 14, Delivery 1: the manifest summary is the first block of a session's first prompt. */
const MANIFEST_BLOCK = {
  type: "text",
  text: matchers.stringMatching(/^Capabilities \(manifest revision \d+\)/),
};

describe.concurrent("prompt content blocks", () => {
  const GENERAL = "Always run the tests before you finish.";
  const withGeneral = { ...DEFAULT_EFFECTIVE, prompts: { general: GENERAL } };

  it(
    "sends the general prompt only on the first prompt of each session",
    async ({ expect }) => {
      // 01 Send a prompt, block 1: "On the first prompt of a session only: a text block with the turn-summary rule (below), then a text block with the project's `prompts.general`, if it is set."
      const ctx = await runningTurn({ prompt: "First", effective: withGeneral });
      const p1 = ctx.tempod.requestsOf("session.prompt")[0];
      expect(p1.content).toEqual([
        MANIFEST_BLOCK,
        { type: "text", text: TURN_SUMMARY_RULE },
        { type: "text", text: GENERAL },
        { type: "text", text: INTENT_TEXT.rule },
        { type: "text", text: "First" },
      ]);
      await endTurn(ctx, ctx.sessionId, ctx.turnId);
      const t2 = await prompt(ctx, ctx.sessionId, "Second");
      expect((await waitPrompt(ctx, t2)).content).toEqual([{ type: "text", text: "Second" }]);
      await endTurn(ctx, ctx.sessionId, t2);
      await waitReady(ctx);

      const session = unwrap(await ctx.stub.createSession({ agent: "claude" }));
      await waitFor(() => ctx.tempod.requestsOf("session.start").length === 2, 3000, "second session.start");
      await waitFor(
        async () => (await sessionRow(ctx.stub, session.id))?.status === "idle",
        3000,
        "session idle",
      );
      const t3 = await prompt(ctx, session.id, "Third");
      expect((await waitPrompt(ctx, t3)).content).toEqual([
        MANIFEST_BLOCK,
        { type: "text", text: TURN_SUMMARY_RULE },
        { type: "text", text: GENERAL },
        { type: "text", text: INTENT_TEXT.rule },
        { type: "text", text: "Third" },
      ]);
    },
    T,
  );

  it(
    "sends only the turn-summary rule when prompts.general is empty",
    async ({ expect }) => {
      // 01 Send a prompt, block 1: "if it is set".
      const ctx = await runningTurn({ prompt: "Only text" });
      expect(ctx.tempod.requestsOf("session.prompt")[0].content).toEqual([
        MANIFEST_BLOCK,
        { type: "text", text: TURN_SUMMARY_RULE },
        { type: "text", text: INTENT_TEXT.rule },
        { type: "text", text: "Only text" },
      ]);
    },
    T,
  );

  /** Turn 1 runs and ends with some transcript; then the adapter dies and the reload hands off. */
  const handoffCase = async (emitTranscript: (ctx: RunningCtx) => Promise<void>) => {
    const ctx = await runningTurn({ prompt: "Fix the login bug" });
    await emitTranscript(ctx);
    await endTurn(ctx, ctx.sessionId, ctx.turnId);
    await waitReady(ctx);
    await applied(
      ctx.stub,
      await emit(ctx, {
        kind: "agent.exited",
        sessionId: ctx.sessionId,
        code: 1,
        signal: null,
        stderrTail: "",
      }),
    );
    const start = ctx.tempod.handlers.get("session.start")!;
    ctx.tempod.on("session.start", async (params, op) => ({
      ...Schema.decodeUnknownSync(
        Schema.StructWithRest(Schema.Struct({}), [Schema.Record(Schema.String, Schema.Json)]),
      )(await start(params, op)),
      handoff: true,
    }));

    return ctx;
  };

  it(
    "after session.start returns handoff:true, sends the handoff block once, then clears handoff_pending",
    async ({ expect }) => {
      // 01 Reload after a restart step 5 (handoff: true → handoff_pending = 1); Send a prompt block 2: "On the first prompt
      // after a handoff only: the handoff text block; then clear handoff_pending."
      // 01 Handoff text: exact first line, then one line per item, "User: <text>", "Agent: <text>" or "Tool: <title>".
      // 02 Item model: handoff item {text}, the exact handoff block that was sent.
      const ctx = await handoffCase(async (c) => {
        await emit(c, agentMessage(c.sessionId, c.turnId, newId(), "Looking at auth.ts", "completed"));
        await emit(
          c,
          itemCreated(c.sessionId, c.turnId, {
            id: newId(),
            kind: "agent_thought",
            status: "completed",
            content: { text: "private thought" },
          }),
        );
        await applied(
          c.stub,
          await emit(c, toolCall(c.sessionId, c.turnId, newId(), "Read src/auth.ts", "completed")),
        );
      });

      const t2 = await prompt(ctx, ctx.sessionId, "Continue please");
      const p2 = await waitPrompt(ctx, t2);

      const expected = [
        HANDOFF_FIRST_LINE,
        "User: Fix the login bug",
        "Agent: Looking at auth.ts",
        "Tool: Read src/auth.ts",
      ].join("\n");

      expect(p2.content).toEqual([
        { type: "text", text: expected },
        { type: "text", text: "Continue please" },
      ]);
      expect((await sessionRow(ctx.stub, ctx.sessionId))!.handoff_pending).toBe(0);
      const handoffs = await sql(ctx.stub, "SELECT * FROM items WHERE kind = 'handoff'");
      expect(handoffs).toHaveLength(1);
      expect(JSON.parse(Schema.decodeUnknownSync(Schema.String)(handoffs[0]!.content_json))).toEqual({
        text: expected,
      });

      await endTurn(ctx, ctx.sessionId, t2);
      const t3 = await prompt(ctx, ctx.sessionId, "And then");
      expect((await waitPrompt(ctx, t3)).content).toEqual([{ type: "text", text: "And then" }]);
    },
    T,
  );

  it(
    "cuts the handoff block from the oldest end to at most 24,000 characters",
    async ({ expect }) => {
      // 01 Handoff text: "Cut from the oldest end so the block is at most 24,000 characters."
      const texts: string[] = [];

      const ctx = await handoffCase(async (c) => {
        for (let i = 0; i < 40; i++) texts.push(`m${String(i).padStart(2, "0")} ${"x".repeat(1000)}`);

        const seqs = await emitMany(
          c,
          texts.map((text) => agentMessage(c.sessionId, c.turnId, newId(), text, "completed")),
        );

        await applied(c.stub, seqs.at(-1)!);
      });

      const t2 = await prompt(ctx, ctx.sessionId, "Go on");
      const block: string = (await waitPrompt(ctx, t2)).content[0].text;
      expect(HANDOFF_MAX_CHARS).toBe(24_000);
      expect(block.length).toBeLessThanOrEqual(24_000);
      const lines = block.split("\n");
      expect(lines[0]).toBe(HANDOFF_FIRST_LINE);
      const full = ["User: Fix the login bug", ...texts.map((t) => `Agent: ${t}`)];
      const kept = lines.slice(1);
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.length).toBeLessThan(full.length);
      expect(kept).toEqual(full.slice(full.length - kept.length));
      expect(kept.at(-1)).toBe(`Agent: ${texts.at(-1)}`);
      expect(block).not.toContain("User: Fix the login bug");
      // Only as much is cut as needed: one more line would not fit.
      expect(`${block}\n${full[full.length - kept.length - 1]}`.length).toBeGreaterThan(24_000);
    },
    T,
  );

  it(
    "sends sessions.pending_note once, then clears it",
    async ({ expect }) => {
      // 01 Send a prompt block 2: "On any prompt: sessions.pending_note, if set (for example, the revert note in 03); then clear it."
      const ctx = await runningTurn();
      await endTurn(ctx, ctx.sessionId, ctx.turnId);
      await waitReady(ctx);
      const note = revertNote(1);
      await sql(ctx.stub, "UPDATE sessions SET pending_note = ? WHERE id = ?", note, ctx.sessionId);
      const t2 = await prompt(ctx, ctx.sessionId, "Carry on");
      expect((await waitPrompt(ctx, t2)).content).toEqual([
        { type: "text", text: note },
        { type: "text", text: "Carry on" },
      ]);
      expect((await sessionRow(ctx.stub, ctx.sessionId))!.pending_note).toBeNull();
      await endTurn(ctx, ctx.sessionId, t2);
      const t3 = await prompt(ctx, ctx.sessionId, "Again");
      expect((await waitPrompt(ctx, t3)).content).toEqual([{ type: "text", text: "Again" }]);
    },
    T,
  );

  it(
    "sends review comments as one block and each @-mention as a resource_link after the user's text",
    async ({ expect }) => {
      // 01 Send a prompt block 3: "Review comments:" followed by one line per comment, "<path>:<line>: <text>";
      // block 4: the user's text; block 5: one resource_link per @-mentioned file, uri file:///workspace/<path>, name = file name.
      // 03 sendPrompt step 3: mark the selected draft review comments sent with this turn id.
      const ctx = await runningTurn();
      await endTurn(ctx, ctx.sessionId, ctx.turnId);
      await waitReady(ctx);

      const c1 = unwrap(
        await ctx.stub.addReviewComment({
          path: "src/auth.ts",
          lineStart: 12,
          body: "Rename this",
        }),
      );

      const c2 = unwrap(
        await ctx.stub.addReviewComment({ path: "README.md", lineStart: 3, body: "Typo here" }),
      );

      const t2 = await prompt(ctx, ctx.sessionId, "Please address these", {
        mentions: [{ path: "src/app.ts" }, { path: "docs/guide.md" }],
        reviewCommentIds: [c1.id, c2.id],
      });

      const p2 = await waitPrompt(ctx, t2);
      expect(p2.content).toEqual([
        { type: "text", text: "Review comments:\nsrc/auth.ts:12: Rename this\nREADME.md:3: Typo here" },
        { type: "text", text: "Please address these" },
        { type: "resource_link", uri: "file:///workspace/src/app.ts", name: "app.ts" },
        { type: "resource_link", uri: "file:///workspace/docs/guide.md", name: "guide.md" },
      ]);

      const comments = await sql(
        ctx.stub,
        "SELECT id, status, sent_turn_id FROM review_comments ORDER BY id",
      );

      expect(comments).toEqual([
        { id: c1.id, status: "sent", sent_turn_id: t2 },
        { id: c2.id, status: "sent", sent_turn_id: t2 },
      ]);
    },
    T,
  );

  it(
    "orders the blocks: general prompt, handoff, pending note, review comments, user text, mentions",
    async ({ expect }) => {
      // 01 Send a prompt: "content is a list of ACP content blocks built in this order" (1 general, 2 handoff then note,
      // 3 review comments, 4 user text, 5 resource links).
      const ctx = await readyWorkspace({
        effective: withGeneral,
        configure: (t) => {
          const start = t.handlers.get("session.start")!;
          t.on("session.start", async (params, op) => ({
            ...Schema.decodeUnknownSync(
              Schema.StructWithRest(Schema.Struct({}), [Schema.Record(Schema.String, Schema.Json)]),
            )(await start(params, op)),
            handoff: true,
          }));
        },
      });

      const session = unwrap(await ctx.stub.createSession({ agent: "claude" }));
      await waitFor(
        async () => (await sessionRow(ctx.stub, session.id))?.handoff_pending === 1,
        3000,
        "handoff pending",
      );
      await waitFor(
        async () => (await sessionRow(ctx.stub, session.id))?.status === "idle",
        3000,
        "session idle",
      );
      const note = revertNote(2);
      await sql(ctx.stub, "UPDATE sessions SET pending_note = ? WHERE id = ?", note, session.id);

      const c = unwrap(await ctx.stub.addReviewComment({ path: "a.ts", lineStart: 1, body: "why" }));

      const turn = await prompt(ctx, session.id, "Do it", {
        mentions: [{ path: "b.ts" }],
        reviewCommentIds: [c.id],
      });

      const p = await waitPrompt(ctx, turn);
      expect(p.content).toEqual([
        MANIFEST_BLOCK,
        { type: "text", text: TURN_SUMMARY_RULE },
        { type: "text", text: GENERAL },
        { type: "text", text: HANDOFF_FIRST_LINE },
        { type: "text", text: note },
        { type: "text", text: "Review comments:\na.ts:1: why" },
        { type: "text", text: INTENT_TEXT.rule },
        { type: "text", text: "Do it" },
        { type: "resource_link", uri: "file:///workspace/b.ts", name: "b.ts" },
      ]);
      expect(ctx.tempod.requestsOf("session.start")).toHaveLength(1);
      const s = (await sessionRow(ctx.stub, session.id))!;
      expect(s).toMatchObject({ handoff_pending: 0, pending_note: null, general_prompt_sent: 1 });
    },
    T,
  );

  /** A session after a handoff (only its first session.start hands off), with a pending note. */
  const handoffSession = async () => {
    const ctx = await readyWorkspace({
      effective: withGeneral,
      configure: (t) => {
        const start = t.handlers.get("session.start")!;
        let starts = 0;
        t.on("session.start", async (params, op) => ({
          ...Schema.decodeUnknownSync(
            Schema.StructWithRest(Schema.Struct({}), [Schema.Record(Schema.String, Schema.Json)]),
          )(await start(params, op)),
          handoff: ++starts === 1,
        }));
      },
    });

    const session = unwrap(await ctx.stub.createSession({ agent: "claude" }));
    await waitFor(
      async () => (await sessionRow(ctx.stub, session.id))?.handoff_pending === 1,
      3000,
      "handoff pending",
    );
    await waitFor(
      async () => (await sessionRow(ctx.stub, session.id))?.status === "idle",
      3000,
      "session idle",
    );
    const note = revertNote(2);
    await sql(ctx.stub, "UPDATE sessions SET pending_note = ? WHERE id = ?", note, session.id);

    return { ctx, sessionId: session.id, note };
  };

  it(
    "a deferred session.prompt keeps the general prompt, handoff and note for the retry",
    async ({ expect }) => {
      // 01 Send a prompt, blocks 1-2: the handoff block, "then clear handoff_pending"; the note, "then clear it".
      // Nothing is cleared until the prompt is sent; a turn deferred while tempod is away sends them when it starts.
      const { ctx, sessionId, note } = await handoffSession();
      ctx.tempod.fail("session.prompt", "TEMPOD_UNREACHABLE", "socket closed");
      const turn = await prompt(ctx, sessionId, "Do it");
      await waitFor(() => ctx.tempod.requestsOf("session.prompt").length >= 1, 3000, "first attempt");
      await settle(100);
      expect((await turnRow(ctx.stub, turn))!.status).toBe("queued");
      expect(await sessionRow(ctx.stub, sessionId)).toMatchObject({
        handoff_pending: 1,
        pending_note: note,
        general_prompt_sent: 0,
      });
      expect(await sql(ctx.stub, "SELECT id FROM items WHERE kind = 'handoff'")).toHaveLength(0);

      ctx.tempod.failures.delete("session.prompt");
      await runInDurableObject(ctx.stub, (i: WorkspaceDO) => internals(i).core.kickQueue());
      await waitFor(async () => (await turnRow(ctx.stub, turn))?.status === "running", 5000, "turn running");
      expect(ctx.tempod.requestsOf("session.prompt").at(-1).content).toEqual([
        MANIFEST_BLOCK,
        { type: "text", text: TURN_SUMMARY_RULE },
        { type: "text", text: GENERAL },
        { type: "text", text: HANDOFF_FIRST_LINE },
        { type: "text", text: note },
        { type: "text", text: INTENT_TEXT.rule },
        { type: "text", text: "Do it" },
      ]);
      expect(await sessionRow(ctx.stub, sessionId)).toMatchObject({
        handoff_pending: 0,
        pending_note: null,
        general_prompt_sent: 1,
      });
      const handoffs = await sql(ctx.stub, "SELECT turn_id, content_json FROM items WHERE kind = 'handoff'");
      expect(handoffs).toEqual([
        { turn_id: turn, content_json: JSON.stringify({ text: HANDOFF_FIRST_LINE }) },
      ]);
    },
    T,
  );

  it(
    "a failed session.prompt keeps the general prompt, handoff and note for the next prompt",
    async ({ expect }) => {
      // 01 Send a prompt, blocks 1-2. The failed turn never reached the agent, so the next prompt still carries them.
      const { ctx, sessionId, note } = await handoffSession();
      ctx.tempod.fail("session.prompt", "INTERNAL", "adapter refused");
      const t1 = await prompt(ctx, sessionId, "First try");
      await waitFor(async () => (await turnRow(ctx.stub, t1))?.status === "failed", 5000, "turn failed");
      expect(await sessionRow(ctx.stub, sessionId)).toMatchObject({
        handoff_pending: 1,
        pending_note: note,
        general_prompt_sent: 0,
      });
      expect(await sql(ctx.stub, "SELECT id FROM items WHERE kind = 'handoff'")).toHaveLength(0);

      ctx.tempod.failures.delete("session.prompt");
      const t2 = await prompt(ctx, sessionId, "Second try");
      expect((await waitPrompt(ctx, t2)).content).toEqual([
        MANIFEST_BLOCK,
        { type: "text", text: TURN_SUMMARY_RULE },
        { type: "text", text: GENERAL },
        { type: "text", text: [HANDOFF_FIRST_LINE, "User: First try"].join("\n") },
        { type: "text", text: note },
        { type: "text", text: "Second try" },
      ]);
      expect(await sessionRow(ctx.stub, sessionId)).toMatchObject({
        handoff_pending: 0,
        pending_note: null,
        general_prompt_sent: 1,
      });
      expect(
        (await sql(ctx.stub, "SELECT turn_id FROM items WHERE kind = 'handoff'")).map((r) => r.turn_id),
      ).toEqual([t2]);
    },
    T,
  );
});

describe.concurrent("queue runner scheduling", () => {
  it(
    "runs only one turn at a time across sessions",
    async ({ expect }) => {
      // 01 Sessions: "Only one turn runs per workspace at a time, across all its sessions. Other prompts wait in the queue."
      const ctx = await runningTurn();
      const b = unwrap(await ctx.stub.createSession({ agent: "claude" }));
      await waitFor(
        async () => (await sessionRow(ctx.stub, b.id))?.status === "idle",
        3000,
        "session B idle",
      );
      const tb = await prompt(ctx, b.id, "Work in B");
      await settle();
      expect(ctx.tempod.requestsOf("session.prompt")).toHaveLength(1);
      expect((await turnRow(ctx.stub, tb))!.status).toBe("queued");
      expect((await detail(ctx.stub)).runningTurnId).toBe(ctx.turnId);

      await endTurn(ctx, ctx.sessionId, ctx.turnId);
      const pb = await waitPrompt(ctx, tb);
      expect(pb.sessionId).toBe(b.id);
      expect((await sessionRow(ctx.stub, b.id))!.status).toBe("running");
      expect((await sessionRow(ctx.stub, ctx.sessionId))!.status).toBe("idle");
    },
    T,
  );

  it(
    "a pending op other than housekeeping holds the queue; housekeeping does not",
    async ({ expect }) => {
      // 03 Queue runner: "No op is pending or running, except housekeeping."
      const ctx = await runningTurn();
      expect(
        await sql(ctx.stub, "SELECT id FROM ops WHERE kind = 'housekeeping' AND status = 'pending'"),
      ).toHaveLength(1);
      const turn2 = await prompt(ctx, ctx.sessionId, "Blocked for now");

      const opId = await runInDurableObject(
        ctx.stub,
        (i: WorkspaceDO) =>
          internals(i).runner.insert("commit_push", { message: "x" }, Date.now() + 60 * 60_000).id,
      );

      await endTurn(ctx, ctx.sessionId, ctx.turnId);
      await waitFor(() => ctx.tempod.requestsOf("git.checkpoint").length === 1, 3000, "turn end processed");
      await settle();
      expect((await turnRow(ctx.stub, turn2))!.status).toBe("queued");
      expect(ctx.tempod.requestsOf("session.prompt")).toHaveLength(1);

      await sql(ctx.stub, "UPDATE ops SET status = 'cancelled' WHERE id = ?", opId);
      await runInDurableObject(ctx.stub, (i: WorkspaceDO) => internals(i).core.kickQueue());
      await waitPrompt(ctx, turn2);
    },
    T,
  );

  it(
    "a turn whose session.start fails ends failed / AGENT_START_FAILED and the queue moves on",
    async ({ expect }) => {
      // 02 Error codes: AGENT_START_FAILED "session.start failed" (tempod answers session.start with that code).
      // 03 Queue runner runs after any change to turns.
      const ctx = await readyWorkspace({
        prompt: "Will not start",
        configure: (t) => t.fail("session.start", "AGENT_START_FAILED", "adapter missing"),
      });

      const first = (await sql(ctx.stub, "SELECT id, session_id FROM turns WHERE seq = 1"))[0]!;
      await waitFor(
        async () =>
          (await turnRow(ctx.stub, Schema.decodeUnknownSync(Schema.String)(first.id)))?.status === "failed",
        5000,
        "turn failed",
      );
      expect((await turnRow(ctx.stub, Schema.decodeUnknownSync(Schema.String)(first.id)))!.error_code).toBe(
        "AGENT_START_FAILED",
      );

      const errors = await sql(
        ctx.stub,
        "SELECT content_json FROM items WHERE turn_id = ? AND kind = 'error'",
        first.id,
      );

      expect(
        errors.map((e) => JSON.parse(Schema.decodeUnknownSync(Schema.String)(e.content_json)).code),
      ).toEqual(["AGENT_START_FAILED"]);
      expect(ctx.tempod.requestsOf("session.prompt")).toHaveLength(0);
      expect((await wsRow(ctx.stub)).state).toBe("ready");
      // 03 Attention: "Recompute it after every change"; the newest turn ended failed.
      await waitFor(async () => (await wsRow(ctx.stub)).attention === "error", 3000, "attention error");
      await waitFor(
        async () => (await d1Workspace(ctx.workspaceId))?.attention === "error",
        3000,
        "D1 attention error",
      );

      ctx.tempod.failures.delete("session.start");
      const t2 = await prompt(ctx, Schema.decodeUnknownSync(Schema.String)(first.session_id), "Now start");
      await waitPrompt(ctx, t2);
    },
    T,
  );

  it(
    "an OpenCode turn with an empty agent.models.opencode fails with MODEL_REQUIRED before session.start",
    async ({ expect }) => {
      // 01 Start a session 2: "For opencode and pi an empty model fails the session with MODEL_REQUIRED before
      // anything is sent, and the turn that waited for it fails with the same code." 06 AT-40.
      const ctx = await readyWorkspace({ prompt: "Start OpenCode", agent: "opencode" });
      const first = (await sql(ctx.stub, "SELECT id, session_id FROM turns WHERE seq = 1"))[0]!;
      await waitFor(
        async () =>
          (await turnRow(ctx.stub, Schema.decodeUnknownSync(Schema.String)(first.id)))?.status === "failed",
        5000,
        "turn failed",
      );
      expect((await turnRow(ctx.stub, Schema.decodeUnknownSync(Schema.String)(first.id)))!.error_code).toBe(
        "MODEL_REQUIRED",
      );

      const errors = await sql(
        ctx.stub,
        "SELECT content_json FROM items WHERE turn_id = ? AND kind = 'error'",
        first.id,
      );

      expect(
        errors.map((e) => JSON.parse(Schema.decodeUnknownSync(Schema.String)(e.content_json)).code),
      ).toEqual(["MODEL_REQUIRED"]);
      expect(ctx.tempod.requestsOf("session.start")).toHaveLength(0);
      expect(ctx.tempod.requestsOf("session.prompt")).toHaveLength(0);
      expect(
        (await sessionRow(ctx.stub, Schema.decodeUnknownSync(Schema.String)(first.session_id)))!.status,
      ).toBe("idle");
      await waitFor(async () => (await wsRow(ctx.stub)).state === "ready", 3000, "state ready");

      const effective = {
        ...DEFAULT_EFFECTIVE,
        agent: {
          ...DEFAULT_EFFECTIVE.agent,
          models: { ...DEFAULT_EFFECTIVE.agent.models, opencode: "openrouter/oc" },
        },
      };

      await sql(ctx.stub, "UPDATE workspace SET settings_json = ? WHERE id = 1", JSON.stringify(effective));

      const t2 = await prompt(
        ctx,
        Schema.decodeUnknownSync(Schema.String)(first.session_id),
        "Now with a model",
      );

      await waitPrompt(ctx, t2);
      expect(ctx.tempod.requestsOf("session.start")[0]).toMatchObject({
        agent: "opencode",
        model: "openrouter/oc",
      });
    },
    T,
  );

  it(
    "session.start carries agent.models.<agent> of the session's agent, and no model when it is empty",
    async ({ expect }) => {
      // 01 Start a session 2: "model is agent.models.<agent> from the effective settings, or absent when empty."
      const models = { claude: "", codex: "gpt-5-codex", opencode: "", pi: "openrouter/pi" };

      const ctx = await readyWorkspace({
        prompt: "Start Pi",
        agent: "pi",
        effective: { ...DEFAULT_EFFECTIVE, agent: { default: "codex", models } },
      });

      await waitFor(() => ctx.tempod.requestsOf("session.start").length === 1, 5000, "pi session.start");
      expect(ctx.tempod.requestsOf("session.start")[0]).toMatchObject({
        agent: "pi",
        model: "openrouter/pi",
      });

      const claude = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
        unwrap(await ctx.stub.createSession({ agent: "claude" })),
      );

      await waitFor(() => ctx.tempod.requestsOf("session.start").length === 2, 5000, "claude session.start");
      const start = ctx.tempod.requestsOf("session.start")[1];
      expect(start).toMatchObject({ sessionId: claude.id, agent: "claude" });
      expect(start).not.toHaveProperty("model");
    },
    T,
  );

  it(
    "a model chosen for the session itself wins over agent.models, so OpenCode starts without a default",
    async ({ expect }) => {
      // 02 createSession takes model?; agent.models.<agent> is the agent's default model (01, Project settings file).
      const ctx = await readyWorkspace();

      const s = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
        unwrap(await ctx.stub.createSession({ agent: "opencode", model: "openrouter/own" })),
      );

      await waitFor(() => ctx.tempod.requestsOf("session.start").length === 1, 5000, "session.start");
      expect(ctx.tempod.requestsOf("session.start")[0]).toMatchObject({
        sessionId: s.id,
        agent: "opencode",
        model: "openrouter/own",
      });
    },
    T,
  );

  it(
    "createSession for Pi with no model ends the start with a MODEL_REQUIRED notice and sends nothing",
    async ({ expect }) => {
      const ctx = await readyWorkspace();

      const s = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
        unwrap(await ctx.stub.createSession({ agent: "pi" })),
      );

      await waitFor(
        async () => (await sessionRow(ctx.stub, s.id))?.status === "idle",
        5000,
        "session start ended",
      );

      const notices = await sql(
        ctx.stub,
        "SELECT content_json FROM items WHERE session_id = ? AND kind = 'notice'",
        s.id,
      );

      expect(
        notices.map((n) => JSON.parse(Schema.decodeUnknownSync(Schema.String)(n.content_json)).text),
      ).toEqual(["Set a default model for this agent in Settings → Project."]);
      expect(ctx.tempod.requestsOf("session.start")).toHaveLength(0);
    },
    T,
  );

  it(
    "a turn deferred while the tempod socket is down starts once tempod reconnects",
    async ({ expect, onTestFinished }) => {
      // 03 Queue runner: "It runs after any change to state, turns, sessions or setup_status"; tempod coming back is
      // what the deferred turn waited for. 03 Failure handling: the socket closes, the DO reconnects.
      const ctx = await readyWorkspace();
      const session = unwrap(await ctx.stub.createSession({ agent: "claude" }));
      await waitFor(
        async () => (await sessionRow(ctx.stub, session.id))?.status === "idle",
        3000,
        "session idle",
      );
      let reconnect!: ReturnType<FakeTempod["holdConnect"]>;
      await runInDurableObject(ctx.stub, () => {
        reconnect = ctx.tempod.holdConnect();
      });
      onTestFinished(() => runInDurableObject(ctx.stub, reconnect.release));
      await closeTempod(ctx);
      await waitFor(
        async () =>
          !(await runInDurableObject(ctx.stub, (i: WorkspaceDO) => internals(i).core.tempod?.open ?? false)),
        3000,
        "socket closed",
      );
      const turn = await prompt(ctx, session.id, "While away");
      await runInDurableObject(ctx.stub, () => reconnect.entered);
      expect((await turnRow(ctx.stub, turn))!.status).toBe("queued");
      expect(ctx.tempod.requestsOf("session.prompt")).toHaveLength(0);
      await runInDurableObject(ctx.stub, reconnect.release);
      await waitPrompt(ctx, turn);
      expect(ctx.tempod.hellos).toHaveLength(2);
      expect((await wsRow(ctx.stub)).state).toBe("working");
    },
    T,
  );

  it(
    "after a turn ends, the state goes back to ready when the next queued turn cannot start yet",
    async ({ expect }) => {
      // 03 turn.ended step 6: "Run the queue runner. If no turn starts, the state goes back to ready."
      // 03 Queue runner: setup_status must be none, succeeded or skipped.
      const ctx = await runningTurn();
      const t2 = await prompt(ctx, ctx.sessionId, "Waits for setup");
      await sql(ctx.stub, "UPDATE workspace SET setup_status = 'running'");
      await endTurn(ctx, ctx.sessionId, ctx.turnId);
      await waitReady(ctx);
      expect((await turnRow(ctx.stub, t2))!.status).toBe("queued");
      expect((await detail(ctx.stub)).runningTurnId).toBeNull();

      await sql(ctx.stub, "UPDATE workspace SET setup_status = 'succeeded'");
      await runInDurableObject(ctx.stub, (i: WorkspaceDO) => internals(i).core.kickQueue());
      await waitPrompt(ctx, t2);
      expect((await wsRow(ctx.stub)).state).toBe("working");
    },
    T,
  );
});

// =============================================================================================
// Sequential cases from other areas share this file's workerd startup and balance the four Worker
// files (docs/CI.md). Each module loads inside its own describe, so its hooks stay scoped to it.
// =============================================================================================

describe("server", async () => {
  await import("./server.cases.ts");
});
