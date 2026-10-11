import type * as P from "../src/index.ts";
import * as w from "./world.ts";

/**
 * Channel sessions for fixtures/channel: what a client receives, in order. A second `hello` is a
 * reconnect. gen-fixtures replays each one through the web stores to get the expected end state.
 */

export interface ChannelSession {
  readonly name: string;
  readonly channel: "hub" | "workspace";
  readonly messages: ReadonlyArray<P.HubServerMessage> | ReadonlyArray<P.WorkspaceServerMessage>;
}

const { uid, at, S1, S2, W2, W3, W4 } = w;

const hubWorkspace = (summary: P.WorkspaceSummary): P.HubServerMessage => ({ type: "workspace", summary });

const lisbon = (rev: number, o: Partial<P.WorkspaceSummary> = {}) => ({ ...w.lisbon, rev, ...o });
const oslo = (rev: number, o: Partial<P.WorkspaceSummary> = {}) => ({ ...w.oslo, rev, ...o });
const nairobi = (rev: number, o: Partial<P.WorkspaceSummary> = {}) =>
  w.summary(W4, { slug: "nairobi", title: "", state: "creating", rev, createdAt: at(900), lastActivityAt: at(900), ...o });

const hubSidebar: ChannelSession = {
  name: "hub-sidebar",
  channel: "hub",
  messages: [
    { type: "hello", v: 1, workspaces: [w.lisbon, w.oslo, w.kyoto] },
    hubWorkspace(lisbon(42, { state: "ready", attention: "unread", lastActivityAt: at(400) })),
    hubWorkspace(lisbon(42, { state: "ready", attention: "unread", lastActivityAt: at(400) })),
    hubWorkspace(oslo(16, { state: "error", attention: "error" })),
    hubWorkspace(oslo(18, { state: "starting", attention: "none" })),
    hubWorkspace(oslo(19, { state: "ready" })),
    hubWorkspace(oslo(20, { state: "working", lastActivityAt: at(500) })),
    hubWorkspace(oslo(21, { state: "working", attention: "needs_input", lastActivityAt: at(510) })),
    { type: "pong" },
    hubWorkspace(nairobi(1)),
    hubWorkspace(nairobi(2, { state: "starting" })),
    hubWorkspace(nairobi(3, { state: "error", attention: "error" })),
    { type: "workspace.removed", workspaceId: W3 },
    { type: "workspace.removed", workspaceId: uid(99) },
    hubWorkspace(lisbon(43, { state: "ready", attention: "none", pinned: true })),
    hubWorkspace(oslo(22, { state: "ready", attention: "unread", prState: "merged", checksState: "success" })),
  ],
};

const hubReconnect: ChannelSession = {
  name: "hub-reconnect",
  channel: "hub",
  messages: [
    { type: "hello", v: 1, workspaces: [w.lisbon, w.oslo] },
    hubWorkspace(lisbon(42, { state: "ready", attention: "unread" })),
    { type: "hello", v: 1, workspaces: [lisbon(45, { state: "sleeping" }), w.kyoto] },
    hubWorkspace(lisbon(44, { state: "working" })),
    hubWorkspace(oslo(23, { state: "sleeping" })),
    { type: "workspace.removed", workspaceId: W2 },
    { type: "pong" },
  ],
};

const T1 = uid(101);
const T2 = uid(102);
const T3 = uid(103);
const T4 = uid(104);

const turn1 = w.turn(1, { prompt: { text: "Add a dark mode toggle", mentions: [{ path: "src/app.tsx" }], attachmentIds: [], reviewCommentIds: [] } });
const turn2Running = w.turn(2, {
  status: "running",
  stopReason: null,
  checkpointId: null,
  endedAt: null,
  prompt: { text: "Persist the choice in localStorage", mentions: [], attachmentIds: [], reviewCommentIds: [] },
});
const turn2Done = { ...turn2Running, status: "completed" as const, stopReason: "end_turn", checkpointId: uid(302), endedAt: at(290) };

const runningDetail = w.detail(w.lisbon, { runningTurnId: T2, ports: w.lisbonDetail.ports });
const readyDetail = w.detail({ ...w.lisbon, state: "ready", attention: "unread", rev: 44 }, { ports: w.lisbonDetail.ports, pushed: false });

const user = (n: number, rev: number, seconds: number, turnId: string, text: string) =>
  w.item("user_message", { n, rev, seconds, turnId, content: { text, mentions: [], attachments: [], reviewCommentIds: [] } });
const agent = (n: number, rev: number, seconds: number, turnId: string, text: string, status: P.Item["status"] = "completed") =>
  w.item("agent_message", { n, rev, seconds, turnId, status, content: { text } });
const thought = (n: number, rev: number, seconds: number, turnId: string, text: string) =>
  w.item("agent_thought", { n, rev, seconds, turnId, content: { text } });
const tool = (n: number, rev: number, seconds: number, turnId: string, status: P.Item["status"], title: string) =>
  w.item("tool_call", {
    n,
    rev,
    seconds,
    turnId,
    status,
    content: { toolCallId: `toolu_${n}`, title, toolKind: "execute", locations: [], content: [] },
  });

const permissionItem = (rev: number, chosenOptionId: string | null, status: P.Item["status"]) =>
  w.item("permission", {
    n: 60,
    rev,
    seconds: 240,
    turnId: T2,
    status,
    content: { ...w.permissionContent, requestId: uid(560), toolCallId: "toolu_59", chosenOptionId },
  });

const firstLoad: ChannelSession = {
  name: "workspace-first-load",
  channel: "workspace",
  messages: [
    { type: "hello", v: 1, workspace: runningDetail, sessions: [w.claudeSession, w.codexSession], turns: [turn1, turn2Running], itemsRev: 24 },
    {
      type: "items",
      items: [
        user(11, 1, 100, T1, "Add a dark mode toggle"),
        thought(12, 2, 101, T1, "The header lives in src/app.tsx."),
        w.item("plan", { n: 13, rev: 3, seconds: 102, turnId: T1, content: w.planContent }),
        tool(14, 4, 103, T1, "completed", "Read src/app.tsx"),
        tool(15, 9, 104, T1, "completed", "Edit src/app.tsx"),
        agent(16, 10, 150, T1, "I added a toggle to the header."),
        w.item("notice", { n: 17, rev: 5, seconds: 5, turnId: null, sessionId: S2, content: { level: "info", text: "Codex is starting." } }),
      ],
      itemsRev: 24,
      done: false,
    },
    {
      type: "items",
      items: [
        user(21, 20, 200, T2, "Persist the choice in localStorage"),
        // Older than items already received: inserted by createdAt, not appended.
        thought(18, 21, 120, T1, "Use a context provider."),
        tool(22, 22, 210, T2, "in_progress", "Edit src/theme/toggle.tsx"),
      ],
      itemsRev: 24,
      done: false,
    },
    { type: "items", items: [agent(23, 24, 220, T2, "Saving the theme", "streaming")], itemsRev: 24, done: true },
    { type: "item.delta", itemId: uid(1023), append: { text: " in localStorage" }, itemsRev: 25 },
    { type: "item.delta", itemId: uid(1023), append: { text: " under `theme`." }, itemsRev: 26 },
    // Stale after the backlog: dropped.
    { type: "item.delta", itemId: uid(1023), append: { text: " (repeated)" }, itemsRev: 25 },
    { type: "item.upsert", item: tool(22, 27, 210, T2, "completed", "Edit src/theme/toggle.tsx"), itemsRev: 27 },
    { type: "item.upsert", item: tool(59, 28, 239, T2, "pending", "bun test"), itemsRev: 28 },
    { type: "item.upsert", item: permissionItem(29, null, "pending"), itemsRev: 29 },
    { type: "permission", request: { ...w.permissionRequest, requestId: uid(560), turnId: T2, itemId: uid(1060), title: "Run bun test" } },
    { type: "session", session: { ...w.claudeSession, status: "running" } },
    { type: "item.upsert", item: permissionItem(30, "allow_once", "completed"), itemsRev: 30 },
    // The request again after it was answered: ignored.
    { type: "permission", request: { ...w.permissionRequest, requestId: uid(560), turnId: T2, itemId: uid(1060), title: "Run bun test" } },
    { type: "item.upsert", item: tool(59, 31, 239, T2, "completed", "bun test"), itemsRev: 31 },
    // Stale: lower than 31.
    { type: "item.upsert", item: tool(22, 23, 210, T2, "failed", "Edit src/theme/toggle.tsx"), itemsRev: 23 },
    {
      type: "item.upsert",
      item: agent(23, 32, 220, T2, "Saving the theme in localStorage under `theme`. Tests pass."),
      itemsRev: 32,
    },
    { type: "turn", turn: turn2Done },
    { type: "turn", turn: turn2Done },
    { type: "changes", ...w.changesSummary },
    { type: "workspace", workspace: readyDetail },
    { type: "session", session: w.claudeSession },
    { type: "pong" },
    { type: "credential.invalid", provider: "codex" },
    { type: "credential.invalid", provider: "codex" },
    { type: "error", code: "SETUP_FAILED", message: "Setup failed. See the Setup tab." },
    // Unknown item, and an item with no text: only itemsRev moves.
    { type: "item.delta", itemId: uid(1999), append: { text: "lost" }, itemsRev: 33 },
    { type: "item.delta", itemId: uid(1059), append: { text: "no text field" }, itemsRev: 34 },
    { type: "changes", files: [], additions: 0, deletions: 0 },
  ],
};

const reconnect: ChannelSession = {
  name: "workspace-reconnect",
  channel: "workspace",
  messages: [
    { type: "hello", v: 1, workspace: runningDetail, sessions: [w.claudeSession], turns: [turn1, turn2Running], itemsRev: 6 },
    {
      type: "items",
      items: [
        user(11, 1, 100, T1, "Add a dark mode toggle"),
        agent(16, 2, 150, T1, "I added a toggle to the header."),
        user(21, 3, 200, T2, "Persist the choice in localStorage"),
        tool(22, 6, 210, T2, "in_progress", "Edit src/theme/toggle.tsx"),
      ],
      itemsRev: 6,
      done: true,
    },
    { type: "item.upsert", item: agent(23, 7, 220, T2, "Saving", "streaming"), itemsRev: 7 },
    { type: "item.delta", itemId: uid(1023), append: { text: " the theme" }, itemsRev: 8 },
    { type: "item.delta", itemId: uid(1023), append: { text: " in localStorage" }, itemsRev: 9 },
    // The socket closed with 4008; the client reconnects with sinceRev=9.
    { type: "hello", v: 1, workspace: runningDetail, sessions: [w.claudeSession], turns: [turn1, turn2Running], itemsRev: 12 },
    {
      type: "items",
      items: [tool(22, 10, 210, T2, "completed", "Edit src/theme/toggle.tsx"), agent(23, 11, 220, T2, "Saving the theme in localStorage", "streaming")],
      itemsRev: 12,
      done: false,
    },
    // Live while the backlog is still arriving: lower itemsRev values are not stale yet.
    { type: "item.upsert", item: agent(23, 12, 220, T2, "Saving the theme in localStorage. Done.", "completed"), itemsRev: 12 },
    { type: "item.upsert", item: thought(24, 8, 215, T2, "Check the storage key."), itemsRev: 8 },
    // The per-item rule: rev 11 is older than the rev 12 just applied.
    { type: "items", items: [agent(23, 11, 220, T2, "Saving the theme in localStorage", "streaming")], itemsRev: 12, done: true },
    { type: "item.delta", itemId: uid(1023), append: { text: " (late)" }, itemsRev: 11 },
    { type: "turn", turn: turn2Done },
    { type: "item.upsert", item: agent(25, 13, 300, T2, "Anything else?"), itemsRev: 13 },
  ],
};

const queuedTurn = (n: number, pos: number, text: string): P.Turn =>
  w.turn(n, {
    status: "queued",
    queuePos: pos,
    stopReason: null,
    checkpointId: null,
    startedAt: null,
    endedAt: null,
    queuedAt: at(250 + n),
    prompt: { text, mentions: [], attachmentIds: [], reviewCommentIds: [] },
  });

const setupRun: P.ScriptRun = { ...w.setupRun, id: uid(610), status: "running", exitCode: null, endedAt: null, startedAt: at(320) };

const queue: ChannelSession = {
  name: "workspace-queue-and-scripts",
  channel: "workspace",
  messages: [
    {
      type: "hello",
      v: 1,
      workspace: { ...runningDetail, queue: [T3, T4] },
      sessions: [w.claudeSession],
      turns: [turn1, turn2Running, queuedTurn(3, 0, "Add tests"), queuedTurn(4, 1, "Update the README")],
      itemsRev: 3,
    },
    {
      type: "items",
      items: [user(11, 1, 100, T1, "Add a dark mode toggle"), agent(16, 2, 150, T1, "Done."), user(21, 3, 200, T2, "Persist it")],
      itemsRev: 3,
      done: true,
    },
    { type: "turn", turn: queuedTurn(4, 0, "Update the README") },
    { type: "turn", turn: queuedTurn(3, 1, "Add tests") },
    { type: "workspace", workspace: { ...runningDetail, queue: [T4, T3] } },
    { type: "turn.deleted", turnId: T3 },
    { type: "turn.deleted", turnId: uid(199) },
    { type: "workspace", workspace: { ...runningDetail, queue: [T4] } },
    { type: "turn", turn: { ...turn2Running, status: "cancelled", stopReason: "cancelled", endedAt: at(300) } },
    {
      type: "turn",
      turn: { ...queuedTurn(4, 0, "Update the README"), status: "running", queuePos: null, startedAt: at(301) },
    },
    { type: "item.upsert", item: user(31, 4, 301, T4, "Update the README"), itemsRev: 4 },
    { type: "session", session: { ...w.claudeSession, status: "running", modeId: "plan" } },
    { type: "session", session: w.codexSession },
    { type: "script.run", run: setupRun },
    { type: "script.output", runId: uid(610), stream: "stdout", data: "bun install v1.4.2\n" },
    { type: "script.output", runId: uid(610), stream: "stderr", data: "warn: lockfile is out of date\n" },
    { type: "script.output", runId: uid(610), stream: "stdout", data: "installed 412 packages in 3.1s\n" },
    { type: "script.run", run: { ...setupRun, status: "exited", exitCode: 0, endedAt: at(324) } },
    { type: "script.output", runId: uid(611), stream: "stdout", data: "  VITE ready in 412 ms\n" },
    {
      type: "item.upsert",
      item: w.item("revert_marker", { n: 32, rev: 5, seconds: 330, turnId: null, content: { checkpointId: uid(301), toTurnSeq: 1 } }),
      itemsRev: 5,
    },
    { type: "turn", turn: { ...turn1, reverted: true } },
    { type: "workspace", workspace: { ...readyDetail, queue: [], runningTurnId: T4, state: "working" } },
    { type: "item.upsert", item: w.item("error", { n: 33, rev: 6, seconds: 340, turnId: T4, status: "failed", content: { code: "AGENT_CRASHED" } }), itemsRev: 6 },
    { type: "turn", turn: { ...queuedTurn(4, 0, "Update the README"), status: "failed", queuePos: null, errorCode: "AGENT_CRASHED", startedAt: at(301), endedAt: at(340) } },
  ],
};

/** A backlog of full 500-item pages, as the WorkspaceDO sends it. */
const backlog = (): ChannelSession => {
  const items: P.Item[] = [];
  let rev = 0;
  for (let t = 0; t < 40; t++) {
    const turnId = uid(2000 + t);
    const sessionId = t % 4 === 3 ? S2 : S1;
    for (let k = 0; k < 16; k++) {
      rev++;
      const n = 10_000 + rev;
      const seconds = 1000 + t * 60 + k;
      const kind = k === 0 ? "user" : k % 5 === 0 ? "tool" : k % 7 === 0 ? "thought" : "agent";
      const it =
        kind === "user"
          ? user(n, rev, seconds, turnId, `Step ${t + 1}`)
          : kind === "tool"
            ? tool(n, rev, seconds, turnId, "completed", `Run step ${t + 1}.${k}`)
            : kind === "thought"
              ? thought(n, rev, seconds, turnId, `Thinking about ${t + 1}.${k}`)
              : agent(n, rev, seconds, turnId, `Part ${k} of step ${t + 1}.`);
      items.push({ ...it, sessionId });
    }
  }
  const itemsRev = rev;
  const pages: P.WorkspaceServerMessage[] = [];
  for (let i = 0; i < items.length; i += 500) {
    pages.push({ type: "items", items: items.slice(i, i + 500), itemsRev, done: i + 500 >= items.length });
  }
  const turns = Array.from({ length: 40 }, (_, t) =>
    w.turn(t + 1, { id: uid(2000 + t), sessionId: t % 4 === 3 ? S2 : S1, queuedAt: at(1000 + t * 60), startedAt: at(1000 + t * 60), endedAt: at(1015 + t * 60) }),
  );
  return {
    name: "workspace-backlog",
    channel: "workspace",
    messages: [
      { type: "hello", v: 1, workspace: readyDetail, sessions: [w.claudeSession, w.codexSession], turns, itemsRev },
      ...pages,
      { type: "item.upsert", item: agent(10_000 + itemsRev + 1, itemsRev + 1, 4000, uid(2039), "One more thing."), itemsRev: itemsRev + 1 },
    ],
  };
};

export const CHANNEL_SESSIONS: ReadonlyArray<ChannelSession> = [hubSidebar, hubReconnect, firstLoad, reconnect, queue, backlog()];

