import { describe, expect, it } from "vitest";
import {
  applyHubMessage,
  emptyHubState,
  notifyEvents,
  sidebarSections,
  type HubState,
} from "~/ui/stores/hub-state";
import { HubStore } from "~/ui/stores/hub-store";
import { summary } from "./fixtures";

const hello = (...ws: ReturnType<typeof summary>[]): HubState =>
  applyHubMessage(emptyHubState, { type: "hello", v: 1, workspaces: ws });

describe("hub channel state", () => {
  it("hello replaces every summary", () => {
    let s = hello(summary({ id: "a" }), summary({ id: "b" }));
    s = applyHubMessage(s, { type: "hello", v: 1, workspaces: [summary({ id: "c" })] });
    expect(Object.keys(s.workspaces)).toEqual(["c"]);
    expect(s.ready).toBe(true);
  });

  it("ignores a summary whose rev is not newer", () => {
    let s = hello(summary({ id: "a", rev: 5, title: "five" }));
    s = applyHubMessage(s, { type: "workspace", summary: summary({ id: "a", rev: 5, title: "again" }) });
    s = applyHubMessage(s, { type: "workspace", summary: summary({ id: "a", rev: 4, title: "old" }) });
    expect(s.workspaces["a"]?.title).toBe("five");
    s = applyHubMessage(s, { type: "workspace", summary: summary({ id: "a", rev: 6, title: "six" }) });
    expect(s.workspaces["a"]?.title).toBe("six");
  });

  it("removes workspaces", () => {
    let s = hello(summary({ id: "a" }));
    s = applyHubMessage(s, { type: "workspace.removed", workspaceId: "a" });
    expect(s.workspaces).toEqual({});
    expect(applyHubMessage(s, { type: "workspace.removed", workspaceId: "zz" })).toBe(s);
  });

  it("raises notification events on the 04 transitions", () => {
    const prev = hello(
      summary({ id: "a", state: "working" }),
      summary({ id: "b" }),
      summary({ id: "c" }),
    );
    const next = [
      summary({ id: "a", state: "ready", attention: "unread", rev: 2 }),
      summary({ id: "b", attention: "needs_input", rev: 2 }),
      summary({ id: "c", state: "error", attention: "error", rev: 2 }),
    ].reduce((s, w) => applyHubMessage(s, { type: "workspace", summary: w }), prev);
    expect(notifyEvents(prev, next).map((e) => [e.workspace.id, e.kind])).toEqual([
      ["a", "finished"],
      ["b", "needs_input"],
      ["c", "error"],
    ]);
    expect(notifyEvents(emptyHubState, prev)).toEqual([]);
  });

  it("builds sidebar sections: pinned first, projects in sort order, archived hidden", () => {
    const ws = hello(
      summary({ id: "a", projectId: "p1", lastActivityAt: 1 }),
      summary({ id: "b", projectId: "p1", lastActivityAt: 3 }),
      summary({ id: "c", projectId: "p2", pinned: true }),
      summary({ id: "d", projectId: "p2", archivedAt: 5, state: "archived" }),
    ).workspaces;
    const sections = sidebarSections(
      ws,
      [
        { id: "p2", sortOrder: 0 },
        { id: "p1", sortOrder: 1 },
      ],
      "activity",
    );
    expect(sections.map((s) => [s.key, s.workspaces.map((w) => w.id)])).toEqual([
      ["pinned", ["c"]],
      ["p2", []],
      ["p1", ["b", "a"]],
    ]);
  });

  it("the store decodes frames and drops invalid ones", () => {
    const store = new HubStore();
    store.receive(JSON.stringify({ type: "hello", v: 1, workspaces: [summary({ id: "a" })] }));
    expect(Object.keys(store.getSnapshot().workspaces)).toEqual(["a"]);
    store.receive(JSON.stringify({ type: "workspace", summary: { id: "broken" } }));
    store.receive("not json");
    expect(Object.keys(store.getSnapshot().workspaces)).toEqual(["a"]);
  });
});
