import type { Item, WorkspaceServerMessage } from "@tempo/protocol";
import { describe, expect, it } from "vitest";
import {
  applyWorkspaceMessage,
  emptyWorkspaceState,
  queuedTurns,
  reorderedQueue,
  runningPlan,
  seedScriptOutput,
  transcriptRows,
  type WorkspaceState,
} from "~/ui/stores/workspace-state";
import { agentMessage, detail, session, turn, userMessage } from "./fixtures";

const apply = (state: WorkspaceState, ...msgs: WorkspaceServerMessage[]): WorkspaceState =>
  msgs.reduce((s, m) => applyWorkspaceMessage(s, m).state, state);

const hello = (
  over: Partial<Extract<WorkspaceServerMessage, { type: "hello" }>> = {},
): WorkspaceServerMessage => ({
  type: "hello",
  v: 1,
  workspace: detail(),
  sessions: [session()],
  turns: [turn()],
  itemsRev: 0,
  ...over,
});

const live = (): WorkspaceState =>
  apply(emptyWorkspaceState, hello(), { type: "items", items: [], itemsRev: 0, done: true });

describe("workspace channel state", () => {
  it("hello sets workspace, sessions and turns and starts a backlog", () => {
    const s = apply(emptyWorkspaceState, hello());
    expect(s.ready).toBe(true);
    expect(s.backlogDone).toBe(false);
    expect(s.workspace?.id).toBe("w1");
    expect(Object.keys(s.sessions)).toEqual(["s1"]);
    expect(Object.keys(s.turns)).toEqual(["t1"]);
  });

  it("applies backlog pages and ends the backlog on done", () => {
    let s = apply(emptyWorkspaceState, hello({ itemsRev: 3 }));
    s = apply(s, { type: "items", items: [userMessage("a", "hi", { rev: 1 })], itemsRev: 3, done: false });
    expect(s.backlogDone).toBe(false);
    s = apply(s, {
      type: "items",
      items: [agentMessage("b", "yo", { rev: 3, createdAt: 2000 })],
      itemsRev: 3,
      done: true,
    });
    expect(s.backlogDone).toBe(true);
    expect(s.itemsRev).toBe(3);
    expect(s.order["s1"]).toEqual(["a", "b"]);
  });

  it("keeps items in creation order whatever the arrival order", () => {
    let s = live();
    s = apply(
      s,
      { type: "item.upsert", item: agentMessage("c", "3", { rev: 1, createdAt: 3000 }), itemsRev: 1 },
      { type: "item.upsert", item: agentMessage("a", "1", { rev: 2, createdAt: 1000 }), itemsRev: 2 },
      { type: "item.upsert", item: agentMessage("b", "2", { rev: 3, createdAt: 2000 }), itemsRev: 3 },
    );
    expect(s.order["s1"]).toEqual(["a", "b", "c"]);
  });

  it("appends deltas to the item text", () => {
    let s = live();
    s = apply(s, { type: "item.upsert", item: agentMessage("a", "Hel", { rev: 1 }), itemsRev: 1 });
    s = apply(s, { type: "item.delta", itemId: "a", append: { text: "lo" }, itemsRev: 1 });
    s = apply(s, { type: "item.delta", itemId: "a", append: { text: "!" }, itemsRev: 2 });
    const item = s.items["a"] as Extract<Item, { kind: "agent_message" }>;
    expect(item.content.text).toBe("Hello!");
    expect(s.itemsRev).toBe(2);
  });

  it("drops messages with a lower itemsRev after the backlog", () => {
    let s = live();
    s = apply(s, { type: "item.upsert", item: agentMessage("a", "new", { rev: 5 }), itemsRev: 5 });
    s = apply(s, { type: "item.upsert", item: agentMessage("a", "old", { rev: 4 }), itemsRev: 4 });
    s = apply(s, { type: "item.delta", itemId: "a", append: { text: "x" }, itemsRev: 3 });
    const item = s.items["a"] as Extract<Item, { kind: "agent_message" }>;
    expect(item.content.text).toBe("new");
  });

  it("applies backlog items even when their rev is lower, by per-item rev", () => {
    let s = apply(emptyWorkspaceState, hello());
    s = apply(s, { type: "item.upsert", item: agentMessage("a", "v2", { rev: 9 }), itemsRev: 9 });
    s = apply(s, {
      type: "items",
      items: [agentMessage("a", "v1", { rev: 2 }), userMessage("u", "q", { rev: 3 })],
      itemsRev: 9,
      done: true,
    });
    expect((s.items["a"] as Extract<Item, { kind: "agent_message" }>).content.text).toBe("v2");
    expect(s.items["u"]).toBeDefined();
  });

  it("a reconnect hello restarts the backlog without losing items or itemsRev", () => {
    let s = live();
    s = apply(s, { type: "item.upsert", item: agentMessage("a", "x", { rev: 7 }), itemsRev: 7 });
    s = apply(s, hello({ turns: [], itemsRev: 9 }));
    expect(s.backlogDone).toBe(false);
    expect(s.itemsRev).toBe(7);
    expect(s.items["a"]).toBeDefined();
    expect(s.turns).toEqual({});
  });

  it("emits turnEnded once when a turn ends", () => {
    const s = live();
    const r1 = applyWorkspaceMessage(s, { type: "turn", turn: turn({ status: "completed", endedAt: 5000 }) });
    expect(r1.events).toEqual([{ kind: "turnEnded", turn: expect.objectContaining({ id: "t1" }) }]);
    const r2 = applyWorkspaceMessage(r1.state, {
      type: "turn",
      turn: turn({ status: "completed", endedAt: 5000 }),
    });
    expect(r2.events).toEqual([]);
  });

  it("removes deleted turns", () => {
    const s = apply(live(), { type: "turn.deleted", turnId: "t1" });
    expect(s.turns["t1"]).toBeUndefined();
  });

  it("tracks pending permissions until the item is answered", () => {
    let s = live();
    s = apply(s, {
      type: "permission",
      request: { requestId: "r1", sessionId: "s1", turnId: "t1", itemId: "p1", title: "Run ls", options: [] },
    });
    expect(Object.keys(s.permissions)).toEqual(["r1"]);
    const answered = {
      id: "p1",
      sessionId: "s1",
      turnId: "t1",
      kind: "permission",
      status: "completed",
      content: { requestId: "r1", toolCallId: null, title: "Run ls", options: [], chosenOptionId: "allow" },
      rev: 4,
      createdAt: 1,
      updatedAt: 2,
    } as Item;
    s = apply(s, { type: "item.upsert", item: answered, itemsRev: 4 });
    expect(s.permissions).toEqual({});
  });

  it("collects script output and runs, and caps nothing small", () => {
    let s = live();
    s = apply(
      s,
      { type: "script.output", runId: "r", stream: "stdout", data: "a" },
      { type: "script.output", runId: "r", stream: "stderr", data: "b" },
    );
    expect(s.scriptOutput["r"]).toBe("ab");
  });

  it("seeds script output from the log tail without duplicating live output", () => {
    let s = apply(live(), { type: "script.output", runId: "r", stream: "stdout", data: "line 3\n" });
    s = seedScriptOutput(s, "r", "line 1\nline 2\nline 3\n");
    expect(s.scriptOutput["r"]).toBe("line 1\nline 2\nline 3\n");
    s = seedScriptOutput(s, "x", "tail");
    expect(s.scriptOutput["x"]).toBe("tail");
  });

  it("counts changes messages", () => {
    const s = apply(live(), { type: "changes", files: [], additions: 1, deletions: 2 });
    expect(s.changesSeq).toBe(1);
    expect(s.changes).toEqual({ files: [], additions: 1, deletions: 2 });
  });

  it("records invalid credentials once and emits an event each time", () => {
    const s = live();
    const r1 = applyWorkspaceMessage(s, { type: "credential.invalid", provider: "claude" });
    const r2 = applyWorkspaceMessage(r1.state, { type: "credential.invalid", provider: "claude" });
    expect(r2.state.credentialInvalid).toEqual(["claude"]);
    expect(r2.events).toHaveLength(1);
  });

  it("emits background errors", () => {
    const r = applyWorkspaceMessage(live(), {
      type: "error",
      code: "SETUP_FAILED",
      message: "Setup failed.",
    });
    expect(r.events).toEqual([{ kind: "error", code: "SETUP_FAILED", message: "Setup failed." }]);
  });
});

describe("selectors", () => {
  it("builds transcript rows with turn footers and reverted flags", () => {
    let s = live();
    s = apply(
      s,
      { type: "turn", turn: turn({ id: "t1", status: "completed", endedAt: 2000, reverted: true }) },
      { type: "turn", turn: turn({ id: "t2", seq: 2, status: "running" }) },
      { type: "item.upsert", item: userMessage("a", "1", { turnId: "t1", createdAt: 1 }), itemsRev: 1 },
      { type: "item.upsert", item: agentMessage("b", "2", { turnId: "t1", createdAt: 2 }), itemsRev: 2 },
      { type: "item.upsert", item: userMessage("c", "3", { turnId: "t2", createdAt: 3 }), itemsRev: 3 },
    );
    const rows = transcriptRows(s.order["s1"]!, s.items, s.turns);
    expect(rows.map((r) => r.key)).toEqual(["a", "b", "footer:t1", "c"]);
    expect(rows[0]).toMatchObject({ reverted: true });
    expect(rows[3]).toMatchObject({ reverted: false });
  });

  it("reorders a session's queued turns inside the workspace queue", () => {
    let s = live();
    s = apply(
      s,
      { type: "turn", turn: turn({ id: "q1", status: "queued", queuePos: 1 }) },
      { type: "turn", turn: turn({ id: "x", sessionId: "s2", status: "queued", queuePos: 2 }) },
      { type: "turn", turn: turn({ id: "q2", status: "queued", queuePos: 3 }) },
    );
    expect(queuedTurns(s).map((t) => t.id)).toEqual(["q1", "x", "q2"]);
    expect(reorderedQueue(s, "s1", "q2", 0)).toEqual(["q2", "x", "q1"]);
  });

  it("reports the running plan progress", () => {
    let s = live();
    const plan = {
      id: "p",
      sessionId: "s1",
      turnId: "t1",
      kind: "plan",
      status: "in_progress",
      content: {
        entries: [
          { content: "a", priority: "high", status: "completed" },
          { content: "b", priority: "high", status: "completed" },
          { content: "c", priority: "high", status: "in_progress" },
          { content: "d", priority: "high", status: "pending" },
        ],
      },
      rev: 1,
      createdAt: 1,
      updatedAt: 1,
    } as Item;
    s = apply(s, { type: "item.upsert", item: plan, itemsRev: 1 });
    expect(runningPlan(s, "s1")).toEqual({ done: 2, total: 4 });
  });
});
