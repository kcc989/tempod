import { describe, expect, it } from "vitest";
import {
  PRIMARY_SHORTCUT,
  baseBranchOptions,
  canArchive,
  githubUrlFor,
  powerAction,
  prLink,
  primaryEnabled,
  renameValue,
  shortcutAvailability,
  topPrimary,
  workspaceView,
} from "~/ui/components/topbar/topbar-logic";
import { bindingFor, formatBinding } from "~/ui/lib/shortcuts";
import { detail, summary } from "../fixtures";

const view = (over: Parameters<typeof detail>[0] = {}) => workspaceView(undefined, detail(over))!;

describe("workspaceView", () => {
  it("prefers whichever source has the higher rev for summary fields", () => {
    const s = summary({ rev: 5, title: "hub" });
    const d = detail({ rev: 4, title: "channel" });
    expect(workspaceView(s, d)?.w.title).toBe("hub");
    expect(workspaceView(s, d)?.d).toBe(d);
    expect(workspaceView(summary({ rev: 3 }), detail({ rev: 4, title: "channel" }))?.w.title).toBe("channel");
  });

  it("works with either source alone", () => {
    expect(workspaceView(summary(), null)?.d).toBeNull();
    expect(workspaceView(undefined, detail())?.w.id).toBe("w1");
    expect(workspaceView(undefined, null)).toBeNull();
  });
});

describe("primary action (04 table, first row that applies)", () => {
  it("row 1: uncommitted changes or local commits", () => {
    expect(
      topPrimary(view({ hasUnpushedCommits: true, pushed: true, prNumber: 3, prState: "open" }))?.kind,
    ).toBe("commitPush");
  });

  it("row 2: pushed, no PR", () => {
    expect(topPrimary(view({ pushed: true }))?.kind).toBe("createPr");
  });

  it("row 3: PR open with failing checks", () => {
    expect(
      topPrimary(view({ pushed: true, prNumber: 3, prState: "open", checksState: "failure" }))?.label,
    ).toBe("View checks");
  });

  it("row 4: PR open", () => {
    expect(
      topPrimary(view({ pushed: true, prNumber: 3, prState: "open", checksState: "success" }))?.kind,
    ).toBe("merge");
  });

  it("row 5: PR merged or closed", () => {
    expect(topPrimary(view({ pushed: true, prNumber: 3, prState: "merged" }))?.kind).toBe("archive");
    expect(topPrimary(view({ pushed: true, prNumber: 3, prState: "closed" }))?.kind).toBe("archive");
  });

  it("nothing for a fresh workspace or an archived one", () => {
    expect(topPrimary(view())).toBeNull();
    expect(topPrimary(view({ state: "archived", prNumber: 3, prState: "merged" }))).toBeNull();
  });

  it("without the detail, a PR number counts as pushed", () => {
    const v = workspaceView(summary({ prNumber: 3, prState: "open" }), null)!;
    expect(topPrimary(v)?.kind).toBe("merge");
  });

  it("Commit and push needs a running container", () => {
    const a = { kind: "commitPush", label: "Commit and push" } as const;
    expect(primaryEnabled(a, "ready")).toBe(true);
    expect(primaryEnabled(a, "sleeping")).toBe(false);
    expect(primaryEnabled({ kind: "merge", label: "Merge" }, "sleeping")).toBe(true);
  });

  it("maps buttons to the 04 shortcuts", () => {
    expect(PRIMARY_SHORTCUT.viewChecks).toBeNull();
    expect(formatBinding(PRIMARY_SHORTCUT.commitPush!, true)).toBe("⌥Y");
    expect(formatBinding(PRIMARY_SHORTCUT.createPr!, true)).toBe("⌥P");
    expect(formatBinding(PRIMARY_SHORTCUT.merge!, true)).toBe("⌥M");
    expect(formatBinding(PRIMARY_SHORTCUT.archive!, true)).toBe("⌥A");
    expect(bindingFor("archive").scope).toBe("global");
  });
});

describe("shortcut availability", () => {
  it("enables each git shortcut when its own row applies", () => {
    expect(shortcutAvailability(view({ hasUnpushedCommits: true }))).toEqual({
      commitPush: true,
      createPr: false,
      merge: false,
      archive: true,
    });
    expect(shortcutAvailability(view({ pushed: true, hasUnpushedCommits: true }))).toMatchObject({
      commitPush: true,
      createPr: true,
    });
    expect(shortcutAvailability(view({ pushed: true, prNumber: 4, prState: "draft" }))).toMatchObject({
      createPr: false,
      merge: true,
    });
  });

  it("disables everything while archiving, and commit while sleeping", () => {
    expect(shortcutAvailability(view({ state: "archiving", hasUnpushedCommits: true }))).toEqual({
      commitPush: false,
      createPr: false,
      merge: false,
      archive: false,
    });
    expect(shortcutAvailability(view({ state: "sleeping", hasUnpushedCommits: true })).commitPush).toBe(
      false,
    );
  });
});

describe("workspace power and archive", () => {
  it("offers Wake or Sleep by state", () => {
    expect(powerAction("sleeping")).toEqual({ kind: "wake", label: "Wake", enabled: true });
    expect(powerAction("error")).toMatchObject({ kind: "wake", enabled: true });
    expect(powerAction("ready")).toEqual({ kind: "sleep", label: "Sleep", enabled: true });
    expect(powerAction("working")).toMatchObject({ kind: "sleep", enabled: false });
    expect(powerAction("starting")).toMatchObject({ kind: "wake", enabled: false });
  });

  it("archives only from ready, working, sleeping or error", () => {
    expect((["ready", "working", "sleeping", "error"] as const).every((s) => canArchive(s))).toBe(true);
    expect(
      (["creating", "starting", "setting_up", "stopping", "archiving", "archived"] as const).some((s) =>
        canArchive(s),
      ),
    ).toBe(false);
  });
});

describe("links and inputs", () => {
  const project = { owner: "acme", name: "app" };

  it("opens the PR, else the pushed branch, else the repo", () => {
    expect(githubUrlFor(project, { prNumber: 7, branch: "tempo/x" }, false)).toBe(
      "https://github.com/acme/app/pull/7",
    );
    expect(githubUrlFor(project, { prNumber: null, branch: "tempo/x" }, true)).toBe(
      "https://github.com/acme/app/tree/tempo/x",
    );
    expect(githubUrlFor(project, { prNumber: null, branch: "tempo/x" }, undefined)).toBe(
      "https://github.com/acme/app/tree/tempo/x",
    );
    expect(githubUrlFor(project, { prNumber: null, branch: "tempo/x" }, false)).toBe(
      "https://github.com/acme/app",
    );
  });

  it("links #<number> ↗ to the PR on GitHub, coloured by prState (04, Top bar left)", () => {
    expect(prLink({ owner: "acme", name: "app" }, { prNumber: 12, prState: "open" })).toEqual({
      label: "#12 ↗",
      url: "https://github.com/acme/app/pull/12",
      className: "text-success",
      ariaLabel: "Pull request #12, open. Opens on GitHub",
    });

    const tone = (prState: "open" | "draft" | "merged" | "closed" | null) =>
      prLink({ owner: "acme", name: "app" }, { prNumber: 3, prState })?.className;

    expect(tone("draft")).toBe("text-muted-foreground");
    expect(tone("merged")).toBe("text-merged");
    expect(tone("closed")).toBe("text-destructive");
    expect(tone(null)).toBe("text-muted-foreground");
    expect(prLink({ owner: "acme", name: "app" }, { prNumber: null, prState: null })).toBeNull();
    expect(prLink(undefined, { prNumber: 12, prState: "open" })).toBeNull();
  });

  it("saves a rename only when it changed and is not blank", () => {
    expect(renameValue("  New  ", "Old")).toBe("New");
    expect(renameValue("Old", "Old")).toBeNull();
    expect(renameValue("   ", "Old")).toBeNull();
    expect(renameValue("x".repeat(300), "Old")).toHaveLength(200);
  });

  it("never offers the workspace's own branch as its base", () => {
    expect(baseBranchOptions([{ name: "main" }, { name: "tempo/x" }, { name: "dev" }], "tempo/x")).toEqual([
      "main",
      "dev",
    ]);
  });
});
