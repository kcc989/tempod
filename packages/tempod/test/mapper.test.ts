import { describe, expect, test } from "bun:test";
import { TempodEvent, type TempodEventOf } from "@tempo/protocol";
import { Schema } from "effect";
import { SessionMapper } from "../src/acp/mapper.ts";
import { quietLogger, sleep } from "./helpers.ts";

const validate = Schema.decodeUnknownSync(TempodEvent);

const setup = (opts: { mergeMs?: number; maxBytes?: number } = {}) => {
  const events: TempodEvent[] = [];
  let n = 0;
  const log = quietLogger();
  const mapper = new SessionMapper("s1", {
    emit: (e) => events.push(validate(e)),
    log,
    newId: () => `item${++n}`,
    now: () => 1000,
    mergeMs: opts.mergeMs ?? 50,
    maxBytes: opts.maxBytes ?? 8 * 1024,
  });
  const of = <K extends TempodEvent["kind"]>(k: K) =>
    events.filter((e) => e.kind === k) as Array<TempodEventOf<K>>;
  return { mapper, events, of, log };
};

const text = (sessionUpdate: string, t: string) => ({ sessionUpdate, content: { type: "text", text: t } });

describe("ACP update to items", () => {
  test("message chunks: one item, deltas coalesced per interval", async () => {
    const { mapper, events, of } = setup({ mergeMs: 40 });
    mapper.startTurn("t1");
    mapper.handle(text("agent_message_chunk", "Hel"));
    mapper.handle(text("agent_message_chunk", "lo"));
    mapper.handle(text("agent_message_chunk", " world"));
    expect(of("item.created")).toHaveLength(1);
    expect(of("item.created")[0]!.item).toEqual({
      id: "item1",
      kind: "agent_message",
      status: "streaming",
      content: { text: "Hel" },
      createdAt: 1000,
    });
    expect(of("item.created")[0]!.turnId).toBe("t1");
    expect(of("item.delta")).toHaveLength(0);
    await sleep(80);
    expect(of("item.delta")).toEqual([
      { kind: "item.delta", sessionId: "s1", itemId: "item1", append: { text: "lo world" } },
    ]);
    mapper.handle(text("agent_message_chunk", "!"));
    mapper.endTurn("completed");
    expect(events.slice(-2)).toEqual([
      { kind: "item.delta", sessionId: "s1", itemId: "item1", append: { text: "!" } },
      { kind: "item.updated", sessionId: "s1", itemId: "item1", patch: { status: "completed" } },
    ]);
  });

  test("8 KB of pending text flushes at once", () => {
    const { mapper, of } = setup({ mergeMs: 10_000, maxBytes: 8 * 1024 });
    mapper.startTurn("t1");
    mapper.handle(text("agent_message_chunk", "start"));
    mapper.handle(text("agent_message_chunk", "x".repeat(5000)));
    expect(of("item.delta")).toHaveLength(0);
    mapper.handle(text("agent_message_chunk", "y".repeat(4000)));
    expect(of("item.delta")).toHaveLength(1);
    expect(of("item.delta")[0]!.append.text.length).toBe(9000);
    mapper.endTurn("completed");
  });

  test("other updates flush pending deltas first and a new item completes the streaming one", () => {
    const { mapper, events } = setup({ mergeMs: 10_000 });
    mapper.startTurn("t1");
    mapper.handle(text("agent_thought_chunk", "think"));
    mapper.handle(text("agent_thought_chunk", "ing"));
    mapper.handle({
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Read a.ts",
      kind: "read",
      status: "pending",
      locations: [{ path: "/w/a.ts", line: 3 }],
    });
    expect(events.map((e) => e.kind)).toEqual(["item.created", "item.delta", "item.updated", "item.created"]);
    expect(events[2]).toEqual({
      kind: "item.updated",
      sessionId: "s1",
      itemId: "item1",
      patch: { status: "completed" },
    });
    const tool = events[3] as TempodEventOf<"item.created">;
    expect(tool.item.kind).toBe("tool_call");
    expect(tool.item.status).toBe("pending");
    expect(tool.item.content).toEqual({
      toolCallId: "tc1",
      title: "Read a.ts",
      toolKind: "read",
      locations: [{ path: "/w/a.ts", line: 3 }],
      content: [],
    });
    mapper.endTurn("completed");
  });

  test("tool_call_update merges title, status and locations and replaces content", () => {
    const { mapper, of } = setup();
    mapper.startTurn("t1");
    mapper.handle({
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Run",
      kind: "execute",
      status: "pending",
      content: [{ type: "content", content: { type: "text", text: "a" } }],
    });
    mapper.handle({ sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "in_progress" });
    mapper.handle({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc1",
      title: "Run tests",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "ok" } }],
      rawOutput: { code: 0 },
    });
    const updates = of("item.updated");
    expect(updates[0]!.patch.status).toBe("in_progress");
    expect(updates[1]!.patch).toEqual({
      status: "completed",
      content: {
        toolCallId: "tc1",
        title: "Run tests",
        toolKind: "execute",
        locations: [],
        content: [{ type: "content", content: { type: "text", text: "ok" } }],
        rawOutput: { code: 0 },
      },
    });
    mapper.endTurn("completed");
  });

  test("chunks after a tool call start a new message item", () => {
    const { mapper, of } = setup();
    mapper.startTurn("t1");
    mapper.handle(text("agent_message_chunk", "a"));
    mapper.handle({ sessionUpdate: "tool_call", toolCallId: "tc1", title: "x" });
    mapper.handle({ sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "completed" });
    mapper.handle(text("agent_message_chunk", "b"));
    expect(of("item.created").map((e) => e.item.kind)).toEqual([
      "agent_message",
      "tool_call",
      "agent_message",
    ]);
    mapper.endTurn("completed");
  });

  test("plan is created once, then its entries are replaced", () => {
    const { mapper, of } = setup();
    mapper.startTurn("t1");
    mapper.handle({
      sessionUpdate: "plan",
      entries: [{ content: "a", priority: "high", status: "pending" }],
    });
    mapper.handle({
      sessionUpdate: "plan",
      entries: [{ content: "a", priority: "high", status: "completed" }],
    });
    expect(of("item.created")[0]!.item.kind).toBe("plan");
    expect(of("item.updated")[0]!.patch).toEqual({
      status: "completed",
      content: { entries: [{ content: "a", priority: "high", status: "completed" }] },
    });
    mapper.endTurn("completed");
  });

  test("session-level updates become session.updated", () => {
    const { mapper, of } = setup();
    mapper.handle({
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "review", description: "Review", _meta: { x: 1 } }],
    });
    mapper.handle({ sessionUpdate: "current_mode_update", currentModeId: "plan" });
    mapper.handle({
      sessionUpdate: "config_option_update",
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          category: "model",
          currentValue: "m2",
          options: [{ value: "m2", name: "M2" }],
        },
      ],
    });
    mapper.handle({ sessionUpdate: "session_info_update", title: "My chat" });
    mapper.handle({ sessionUpdate: "session_info_update", updatedAt: "2026-01-01T00:00:00Z" });
    mapper.handle({
      sessionUpdate: "usage_update",
      used: 5,
      size: 100,
      cost: { amount: 0.1, currency: "USD" },
    });
    expect(of("session.updated").map((e) => e.patch)).toEqual([
      { commands: [{ name: "review", description: "Review" }] },
      { modeId: "plan" },
      {
        configOptions: [
          {
            id: "model",
            name: "Model",
            type: "select",
            category: "model",
            currentValue: "m2",
            options: [{ value: "m2", name: "M2" }],
          },
        ],
      },
      { title: "My chat" },
      { usage: { used: 5, size: 100, cost: { amount: 0.1, currency: "USD" } } },
    ]);
    expect(mapper.state.modeId).toBe("plan");
  });

  test("notice becomes a notice item; user chunks are ignored; unknown updates are logged and dropped", () => {
    const { mapper, events, log } = setup();
    mapper.startTurn("t1");
    mapper.handle(text("user_message_chunk", "hi"));
    mapper.handle({
      sessionUpdate: "notice",
      severity: "warning",
      title: "Rate limited",
      description: "retrying",
    });
    mapper.handle({ sessionUpdate: "subagent_update", whatever: 1 });
    expect(events).toHaveLength(1);
    const created = events[0] as TempodEventOf<"item.created">;
    expect(created.item.kind).toBe("notice");
    expect(created.item.content).toEqual({ level: "warning", text: "Rate limited\nretrying" });
    expect(log.lines.some((l) => l.includes('"level":"warn"') && l.includes("subagent_update"))).toBe(true);
    mapper.endTurn("completed");
  });

  test("non-text message content goes into blocks", () => {
    const { mapper, of } = setup();
    mapper.startTurn("t1");
    mapper.handle(text("agent_message_chunk", "see"));
    mapper.handle({
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", data: "AAAA", mimeType: "image/png" },
    });
    expect(of("item.updated")[0]!.patch.content).toEqual({
      text: "see",
      blocks: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    });
    mapper.endTurn("completed");
  });

  test("a cancelled turn cancels every open item", () => {
    const { mapper, of } = setup();
    mapper.startTurn("t1");
    mapper.handle({ sessionUpdate: "tool_call", toolCallId: "a", title: "done", status: "completed" });
    mapper.handle({ sessionUpdate: "tool_call", toolCallId: "b", title: "running", status: "in_progress" });
    mapper.handle(text("agent_message_chunk", "partial"));
    mapper.endTurn("cancelled");
    const statuses = of("item.updated").map((e) => [e.itemId, e.patch.status]);
    expect(statuses).toEqual([
      ["item2", "cancelled"],
      ["item3", "cancelled"],
    ]);
  });

  test("permission item: created pending, then answered", () => {
    const { mapper, of } = setup();
    mapper.startTurn("t1");
    mapper.handle({ sessionUpdate: "tool_call", toolCallId: "tc1", title: "Delete files" });
    const p = mapper.addPermission("req1", { toolCallId: "tc1" }, [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ]);
    expect(p.title).toBe("Delete files");
    const created = of("item.created")[1]!;
    expect(created.item).toMatchObject({ kind: "permission", status: "pending" });
    expect(created.item.content).toEqual({
      requestId: "req1",
      toolCallId: "tc1",
      title: "Delete files",
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    });
    mapper.resolvePermission(p.itemId, "allow");
    expect(of("item.updated").at(-1)!.patch).toMatchObject({
      status: "completed",
      content: { chosenOptionId: "allow" },
    });
    mapper.endTurn("completed");
  });

  test("updates outside a turn that make items are dropped", () => {
    const { mapper, events } = setup();
    mapper.handle(text("agent_message_chunk", "stray"));
    expect(events).toHaveLength(0);
  });
});

describe("mode config updates", () => {
  test("refreshes modes and current selection, including grouped choices and replay", () => {
    const { mapper, of } = setup();
    const update = {
      sessionUpdate: "config_option_update",
      configOptions: [
        {
          id: "agent",
          name: "Agent",
          category: "mode",
          type: "select",
          currentValue: "plan",
          options: [
            {
              group: "modes",
              name: "Modes",
              options: [
                { value: "build", name: "Build" },
                { value: "plan", name: "Plan" },
              ],
            },
          ],
        },
      ],
    };
    mapper.captureState(update);
    expect(of("session.updated")).toHaveLength(0);
    expect(mapper.state.modeId).toBe("plan");
    mapper.handle({ ...update, configOptions: [{ ...update.configOptions[0], currentValue: "build" }] });
    expect(of("session.updated")[0]?.patch).toMatchObject({
      modeId: "build",
      modes: [
        { id: "build", name: "Build" },
        { id: "plan", name: "Plan" },
      ],
    });
  });
});
