import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activateTab,
  closeDialog,
  closeTab,
  confirm,
  CONFIRM_TEXT,
  cycleTab,
  dialogStore,
  focusComposer,
  getLayout,
  getWorkspaceUi,
  insertIntoComposer,
  moveTab,
  openDialog,
  openDiff,
  openFile,
  openTab,
  parseTabRef,
  resetUiState,
  resolveConfirm,
  setPhonePane,
  showBottomTab,
  showRightTab,
  syncChatTabs,
  tabKey,
  tabRef,
  takeInsertions,
  targetChatSession,
  toggleBottom,
  toggleDiffScope,
  toggleRight,
  toggleSidebar,
  type CenterTab,
} from "~/ui/state/workspace-ui";
import { installLocalStorage, removeLocalStorage } from "./storage-stub";

const W = "w1";
const keys = () => getWorkspaceUi(W).tabs.map((t) => t.key);
const active = () => getWorkspaceUi(W).activeKey;

let storage: Map<string, string>;

beforeEach(() => {
  storage = installLocalStorage();
  resetUiState();
});

afterEach(() => {
  resetUiState();
  removeLocalStorage();
});

describe("tab refs", () => {
  const cases: Array<[CenterTab, string]> = [
    [{ kind: "chat", sessionId: "s1" }, "chat:s1"],
    [{ kind: "file", path: "src/a.ts", line: 12 }, "file:src/a.ts:12"],
    [{ kind: "file", path: "src/a.ts", line: null }, "file:src/a.ts:"],
    [{ kind: "diff", path: "README.md" }, "diff:README.md"],
    [{ kind: "diff", path: null }, "diff:"],
    [{ kind: "browser", url: "https://p-1.example.com:3000/x" }, "browser:https://p-1.example.com:3000/x"],
  ];

  it("serializes as chat:<id>, file:<path>:<line?>, diff:<path?>, browser:<url> and parses back", () => {
    for (const [tab, ref] of cases) {
      expect(tabRef(tab)).toBe(ref);
      expect(parseTabRef(ref)).toEqual(tab);
    }
  });

  it("keeps colons inside file paths and rejects bad refs", () => {
    expect(parseTabRef("file:a:b.ts:3")).toEqual({ kind: "file", path: "a:b.ts", line: 3 });
    expect(parseTabRef("file:a.ts:0")).toBeNull();
    expect(parseTabRef("file:a.ts:x")).toBeNull();
    expect(parseTabRef("chat:")).toBeNull();
    expect(parseTabRef("nope:1")).toBeNull();
    expect(parseTabRef("plain")).toBeNull();
  });

  it("uses one key per session, file path, the diff tab and browser URL", () => {
    expect(tabKey({ kind: "file", path: "a.ts", line: 1 })).toBe(
      tabKey({ kind: "file", path: "a.ts", line: 9 }),
    );
    expect(tabKey({ kind: "diff", path: "a" })).toBe(tabKey({ kind: "diff", path: null }));
  });
});

describe("center tabs", () => {
  it("opens, re-opens in place with a new seq, and activates", () => {
    openTab(W, { kind: "chat", sessionId: "s1" });
    const first = openFile(W, "a.ts", 3);
    const seq = getWorkspaceUi(W).tabs[1]!.seq;
    expect(keys()).toEqual(["chat:s1", "file:a.ts"]);
    expect(active()).toBe(first);
    activateTab(W, "chat:s1");
    openFile(W, "a.ts", 40);
    const again = getWorkspaceUi(W).tabs[1]!;
    expect(keys()).toEqual(["chat:s1", "file:a.ts"]);
    expect(again.tab).toEqual({ kind: "file", path: "a.ts", line: 40 });
    expect(again.seq).toBeGreaterThan(seq);
    expect(active()).toBe("file:a.ts");
  });

  it("can open without activating, except when nothing is active", () => {
    openDiff(W, null);
    expect(active()).toBe("diff");
    openFile(W, "b.ts");
    openTab(W, { kind: "browser", url: "https://x" }, { activate: false });
    expect(active()).toBe("file:b.ts");
  });

  it("closing the active tab activates its neighbor", () => {
    openTab(W, { kind: "chat", sessionId: "s1" });
    openFile(W, "a.ts");
    openFile(W, "b.ts");
    activateTab(W, "file:a.ts");
    closeTab(W, "file:a.ts");
    expect(active()).toBe("file:b.ts");
    closeTab(W, "file:b.ts");
    expect(active()).toBe("chat:s1");
    closeTab(W, "chat:s1");
    expect(active()).toBeNull();
    expect(getWorkspaceUi(W).lastChatSessionId).toBeNull();
  });

  it("cycles with wrap-around (⌥] and ⌥[)", () => {
    openTab(W, { kind: "chat", sessionId: "s1" });
    openFile(W, "a.ts");
    openDiff(W);
    cycleTab(W, 1);
    expect(active()).toBe("chat:s1");
    cycleTab(W, -1);
    expect(active()).toBe("diff");
  });

  it("moves tabs", () => {
    openTab(W, { kind: "chat", sessionId: "s1" });
    openFile(W, "a.ts");
    openDiff(W);
    moveTab(W, "diff", 0);
    expect(keys()).toEqual(["diff", "chat:s1", "file:a.ts"]);
    moveTab(W, "diff", 99);
    expect(keys()).toEqual(["chat:s1", "file:a.ts", "diff"]);
  });

  it("syncs chat tabs with open sessions, keeping other tabs", () => {
    openFile(W, "a.ts");
    syncChatTabs(W, ["s1", "s2"]);
    expect(keys()).toEqual(["chat:s1", "chat:s2", "file:a.ts"]);
    expect(active()).toBe("file:a.ts");
    activateTab(W, "chat:s2");
    syncChatTabs(W, ["s1", "s3"]);
    expect(keys()).toEqual(["chat:s1", "chat:s3", "file:a.ts"]);
    expect(active()).toBe("chat:s1");
    const before = getWorkspaceUi(W);
    syncChatTabs(W, ["s1", "s3"]);
    expect(getWorkspaceUi(W)).toBe(before);
  });

  it("activates the first chat when nothing is active", () => {
    syncChatTabs(W, ["s1", "s2"]);
    expect(active()).toBe("chat:s1");
  });
});

describe("composer insertions", () => {
  it("go to the active chat, or the chat shown last, and show it", () => {
    syncChatTabs(W, ["s1", "s2"]);
    activateTab(W, "chat:s2");
    openDiff(W, "a.ts");
    expect(targetChatSession(getWorkspaceUi(W))).toBe("s2");
    insertIntoComposer(W, { kind: "reviewComments", commentIds: ["c1", "c2"] });
    expect(active()).toBe("chat:s2");
    expect(getWorkspaceUi(W).composerFocusSeq).toBe(1);
    expect(takeInsertions(W, "s1")).toEqual([]);
    const taken = takeInsertions(W, "s2");
    expect(taken.map((p) => p.insertion)).toEqual([{ kind: "reviewComments", commentIds: ["c1", "c2"] }]);
    expect(getWorkspaceUi(W).insertions).toEqual([]);
  });

  it("untargeted insertions go to whichever composer takes them", () => {
    insertIntoComposer(W, { kind: "mention", path: "src/a.ts" });
    expect(getWorkspaceUi(W).insertions[0]!.sessionId).toBeNull();
    expect(takeInsertions(W, "s9")).toHaveLength(1);
  });

  it("explicit session wins", () => {
    syncChatTabs(W, ["s1", "s2"]);
    insertIntoComposer(W, { kind: "text", text: "hi" }, "s2");
    expect(active()).toBe("chat:s2");
    expect(takeInsertions(W, "s2")).toHaveLength(1);
  });

  it("⌥L focuses the target chat", () => {
    syncChatTabs(W, ["s1"]);
    openFile(W, "a.ts");
    focusComposer(W);
    expect(active()).toBe("chat:s1");
    expect(getWorkspaceUi(W).composerFocusSeq).toBe(1);
  });
});

describe("panels and layout", () => {
  it("toggles the diff scope", () => {
    expect(getWorkspaceUi(W).diffScope).toBe("branch");
    toggleDiffScope(W);
    expect(getWorkspaceUi(W).diffScope).toBe("uncommitted");
  });

  it("keeps panel visibility in localStorage, not the phone pane", () => {
    toggleSidebar();
    toggleRight();
    setPhonePane("changes");
    expect(getLayout()).toMatchObject({
      sidebarOpen: false,
      rightOpen: false,
      bottomOpen: true,
      phonePane: "changes",
    });
    expect(JSON.parse(storage.get("tempo:layout:panels")!)).toEqual({
      sidebarOpen: false,
      rightOpen: false,
      bottomOpen: true,
    });
    resetUiState();
    expect(getLayout()).toMatchObject({ sidebarOpen: false, rightOpen: false, phonePane: "chat" });
  });

  it("⌥J opens the right side when it is closed", () => {
    toggleRight();
    toggleBottom();
    expect(getLayout()).toMatchObject({ rightOpen: true, bottomOpen: true });
    toggleBottom();
    expect(getLayout()).toMatchObject({ rightOpen: true, bottomOpen: false });
  });

  it("showing a panel tab opens its panel", () => {
    toggleRight();
    showRightTab(W, "checks");
    expect(getWorkspaceUi(W).rightTab).toBe("checks");
    expect(getLayout().rightOpen).toBe(true);
    toggleBottom();
    showBottomTab(W, "setup");
    expect(getWorkspaceUi(W).bottomTab).toBe("setup");
    expect(getLayout()).toMatchObject({ rightOpen: true, bottomOpen: true });
  });

  it("falls back to defaults when storage is broken", () => {
    storage.set("tempo:layout:panels", "{bad json");
    resetUiState();
    expect(getLayout()).toMatchObject({ sidebarOpen: true, rightOpen: true, bottomOpen: true });
  });
});

describe("dialogs and confirmations", () => {
  it("opens and closes app dialogs", () => {
    openDialog({ kind: "newWorkspace", projectId: "p1" });
    expect(dialogStore.getSnapshot().dialog).toEqual({ kind: "newWorkspace", projectId: "p1" });
    closeDialog("settings");
    expect(dialogStore.getSnapshot().dialog?.kind).toBe("newWorkspace");
    closeDialog();
    expect(dialogStore.getSnapshot().dialog).toBeNull();
  });

  it("confirm resolves with the answer", async () => {
    const p = confirm(CONFIRM_TEXT.deleteWorkspace("lisbon"));
    const req = dialogStore.getSnapshot().confirm!;
    expect(req).toMatchObject({ typeToConfirm: "lisbon", destructive: true });
    resolveConfirm(req.id, true);
    await expect(p).resolves.toBe(true);
    expect(dialogStore.getSnapshot().confirm).toBeNull();
  });

  it("a newer confirm cancels the older one", async () => {
    const first = confirm(CONFIRM_TEXT.rotatePreview());
    const second = confirm(CONFIRM_TEXT.closeRunningChat());
    await expect(first).resolves.toBe(false);
    expect(dialogStore.getSnapshot().confirm?.title).toBe("Stop the agent and close this chat?");
    resolveConfirm(dialogStore.getSnapshot().confirm!.id, false);
    await expect(second).resolves.toBe(false);
  });

  it("uses the 04 confirmation texts", () => {
    expect(CONFIRM_TEXT.revert(3).description).toBe(
      "Files go back to the end of turn 3. A safety checkpoint is saved first.",
    );
    expect(CONFIRM_TEXT.rotatePreview().description).toBe("Old preview links will stop working.");
  });
});
