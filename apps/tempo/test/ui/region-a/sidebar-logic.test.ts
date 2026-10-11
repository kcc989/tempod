import { describe, expect, it } from "vitest";
import {
  CHECKS_DOT_CLASS,
  CHECKS_LABELS,
  NO_COLLAPSED,
  fullOrder,
  isBold,
  isSortMode,
  isStringList,
  nextNeedingYou,
  prBadgeVariant,
  projectLabel,
  stepWorkspace,
  toggleCollapsed,
  visibleOrder,
} from "~/ui/components/sidebar/sidebar-logic";
import { sidebarSections } from "~/ui/stores/hub-state";
import { summary } from "../fixtures";

const projects = [
  { id: "p2", sortOrder: 2 },
  { id: "p1", sortOrder: 1 },
];

const workspaces = {
  a: summary({ id: "a", projectId: "p1", lastActivityAt: 10, createdAt: 3 }),
  b: summary({ id: "b", projectId: "p1", lastActivityAt: 30, createdAt: 1 }),
  c: summary({ id: "c", projectId: "p2", lastActivityAt: 20, createdAt: 2 }),
  d: summary({ id: "d", projectId: "p2", pinned: true, lastActivityAt: 5 }),
  gone: summary({ id: "gone", projectId: "p1", state: "archived", archivedAt: 9 }),
};

const ids = (ws: ReadonlyArray<{ id: string }>) => ws.map((w) => w.id);

describe("sidebar order", () => {
  it("lists pinned first, then projects in sort_order, newest activity first", () => {
    const sections = sidebarSections(workspaces, projects, "activity");
    expect(ids(fullOrder(sections))).toEqual(["d", "b", "a", "c"]);
  });

  it("can sort by created_at", () => {
    const sections = sidebarSections(workspaces, projects, "created");
    expect(ids(fullOrder(sections))).toEqual(["d", "a", "b", "c"]);
  });

  it("leaves collapsed sections out of the visible order", () => {
    const sections = sidebarSections(workspaces, projects, "activity");
    expect(ids(visibleOrder(sections, ["p1"]))).toEqual(["d", "c"]);
    expect(ids(visibleOrder(sections, ["pinned", "p2"]))).toEqual(["b", "a"]);
    expect(ids(visibleOrder(sections, NO_COLLAPSED))).toEqual(["d", "b", "a", "c"]);
  });

  it("toggles a collapsed key", () => {
    expect(toggleCollapsed([], "p1")).toEqual(["p1"]);
    expect(toggleCollapsed(["p1", "p2"], "p1")).toEqual(["p2"]);
  });

  it("guards the stored values", () => {
    expect(isSortMode("activity")).toBe(true);
    expect(isSortMode("created")).toBe(true);
    expect(isSortMode("title")).toBe(false);
    expect(isStringList(["a", "b"])).toBe(true);
    expect(isStringList(["a", 1])).toBe(false);
    expect(isStringList("a")).toBe(false);
  });
});

describe("workspace switching", () => {
  const list = ["a", "b", "c"];

  it("steps with wrap-around", () => {
    expect(stepWorkspace(list, "a", 1)).toBe("b");
    expect(stepWorkspace(list, "c", 1)).toBe("a");
    expect(stepWorkspace(list, "a", -1)).toBe("c");
  });

  it("starts at an end when no workspace is open or the open one is not listed", () => {
    expect(stepWorkspace(list, null, 1)).toBe("a");
    expect(stepWorkspace(list, null, -1)).toBe("c");
    expect(stepWorkspace(list, "zz", 1)).toBe("a");
    expect(stepWorkspace([], null, 1)).toBeNull();
  });

  it("finds the next workspace that needs you, waiting and errors before unread", () => {
    const order = [
      { id: "a", attention: "unread" as const },
      { id: "b", attention: "none" as const },
      { id: "c", attention: "needs_input" as const },
      { id: "d", attention: "error" as const },
    ];
    expect(nextNeedingYou(order, null)).toBe("c");
    expect(nextNeedingYou(order, "c")).toBe("d");
    expect(nextNeedingYou(order, "d")).toBe("c");
    expect(nextNeedingYou([order[0]!, order[1]!], "b")).toBe("a");
  });

  it("skips the open workspace and returns null when nothing needs you", () => {
    expect(nextNeedingYou([{ id: "a", attention: "needs_input" }], "a")).toBeNull();
    expect(nextNeedingYou([{ id: "a", attention: "none" }], null)).toBeNull();
    expect(nextNeedingYou([], null)).toBeNull();
  });
});

describe("row indicators", () => {
  it("colours the PR badge by pr_state (04)", () => {
    expect(prBadgeVariant("open")).toBe("success");
    expect(prBadgeVariant("draft")).toBe("muted");
    expect(prBadgeVariant("merged")).toBe("merged");
    expect(prBadgeVariant("closed")).toBe("danger");
    expect(prBadgeVariant(null)).toBe("muted");
  });

  it("colours the checks dot (04)", () => {
    expect(CHECKS_DOT_CLASS).toEqual({
      pending: "bg-warning",
      success: "bg-success",
      failure: "bg-destructive",
    });
    expect(Object.keys(CHECKS_LABELS).sort()).toEqual(["failure", "pending", "success"]);
  });

  it("bolds the title for unread and needs_input only", () => {
    expect(isBold({ attention: "unread" })).toBe(true);
    expect(isBold({ attention: "needs_input" })).toBe(true);
    expect(isBold({ attention: "error" })).toBe(false);
    expect(isBold({ attention: "none" })).toBe(false);
  });

  it("names projects owner/name", () => {
    expect(projectLabel({ owner: "acme", name: "app" })).toBe("acme/app");
  });
});
