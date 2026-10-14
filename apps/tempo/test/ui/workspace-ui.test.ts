import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activateTab,
  selectTool,
  closeTool,
  closeWorkspaceInfo,
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
  isRightOpen,
  moveTab,
  newTerminal,
  openDialog,
  openDiff,
  openFile,
  openLiveView,
  openTab,
  parseTabRef,
  resetUiState,
  resolveConfirm,
  setLayout,
  setPhonePane,
  setRightQuiet,
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
    [{ kind: "guide" }, "guide:"],
    [{ kind: "browser", url: "https://p-1.example.com:3000/x" }, "browser:https://p-1.example.com:3000/x"],
    [{ kind: "liveView" }, "liveView:"],
  ];

  it("serializes as chat:<id>, file:<path>:<line?>, diff:<path?>, browser:<url>, liveView: and parses back", () => {
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
    expect(parseTabRef("liveView:https://live.example.com/x")).toBeNull();
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

  it("keeps one Live View tab, which holds no link (04, Browser tabs)", () => {
    openTab(W, { kind: "chat", sessionId: "s1" });
    const key = openLiveView(W);
    const seq = getWorkspaceUi(W).tabs[1]!.seq;
    activateTab(W, "chat:s1");
    expect(openLiveView(W)).toBe(key);
    expect(keys()).toEqual(["chat:s1", "liveView"]);
    expect(getWorkspaceUi(W).tabs[1]!.tab).toEqual({ kind: "liveView" });
    expect(getWorkspaceUi(W).tabs[1]!.seq).toBeGreaterThan(seq);
    expect(active()).toBe("liveView");
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

  it("⌥J opens a terminal tab when none is open, then returns to the launcher", () => {
    setLayout({ lastWorkspaceId: W });
    toggleRight();
    toggleBottom();
    expect(getWorkspaceUi(W)).toMatchObject({ activeToolKey: "t1", toolTabs: ["t1"] });
    expect(getLayout()).toMatchObject({ rightOpen: true, bottomOpen: true });
    toggleBottom();
    expect(getWorkspaceUi(W)).toMatchObject({ activeToolKey: null, toolTabs: ["t1"] });
    expect(getLayout()).toMatchObject({ rightOpen: true, bottomOpen: false });
  });

  it("⌥J selects the most recently used terminal tab", () => {
    setLayout({ lastWorkspaceId: W });
    newTerminal(W);
    newTerminal(W);
    newTerminal(W);
    selectTool(W, "t2");
    selectTool(W, "changes");
    toggleBottom();
    expect(getWorkspaceUi(W).activeToolKey).toBe("t2");
    closeTool(W, "t2");
    toggleBottom();
    expect(getWorkspaceUi(W).activeToolKey).toBe("t3");
    expect(getWorkspaceUi(W).toolTabs).toEqual(["t1", "t3", "changes"]);
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

  it("at phone width the Setup output opens as its own pane", () => {
    setPhonePane("chat");
    showBottomTab(W, "run");
    expect(getLayout().phonePane).toBe("chat");
    showBottomTab(W, "setup");
    expect(getLayout().phonePane).toBe("setup");
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
    const first = confirm(CONFIRM_TEXT.resetPreviewAccess());
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
    expect(CONFIRM_TEXT.resetPreviewAccess().description).toBe(
      "Open previews will stop working. Open them again from Tempo.",
    );
  });
});

describe("right side starts closed (04, Right and bottom panels)", () => {
  it("stays closed while quiet until the user opens it for that workspace", () => {
    setLayout({ lastWorkspaceId: W });
    setRightQuiet(W, true);
    expect(isRightOpen(getLayout(), getWorkspaceUi(W))).toBe(false);
    toggleRight();
    expect(isRightOpen(getLayout(), getWorkspaceUi(W))).toBe(true);
    expect(isRightOpen(getLayout(), getWorkspaceUi("w2"))).toBe(false);
    closeWorkspaceInfo("w2");
    expect(isRightOpen(getLayout(), getWorkspaceUi("w2"))).toBe(true);
    setRightQuiet("w2", true);
    expect(isRightOpen(getLayout(), getWorkspaceUi("w2"))).toBe(false);
    toggleRight();
    expect(getLayout().rightOpen).toBe(false);
  });

  it("keeps Info visible when the workspace stops being quiet, then reveals tools when Info closes", () => {
    setRightQuiet(W, true);
    setRightQuiet(W, false);
    expect(getWorkspaceUi(W).infoOpen).toBe(true);
    expect(isRightOpen(getLayout(), getWorkspaceUi(W))).toBe(false);
    closeWorkspaceInfo(W);
    expect(isRightOpen(getLayout(), getWorkspaceUi(W))).toBe(true);
  });

  it("⌥J and showing a tab pin it open", () => {
    setLayout({ lastWorkspaceId: W });
    setRightQuiet(W, true);
    toggleBottom();
    expect(getWorkspaceUi(W).rightPinned).toBe(true);
    expect(getLayout()).toMatchObject({ rightOpen: true, bottomOpen: true });
    setRightQuiet("w2", true);
    showRightTab("w2", "changes");
    expect(isRightOpen(getLayout(), getWorkspaceUi("w2"))).toBe(true);
  });
});

describe("independent tools", () => {
  it("keeps the target chat while opening documents and selecting tools", () => {
    syncChatTabs(W, ["s1", "s2"]);
    activateTab(W, "chat:s2");
    setLayout({ rightOpen: false });
    openFile(W, "README.md", 3);
    expect(getWorkspaceUi(W).activeToolKey).toBe("file:README.md");
    expect(getLayout().rightOpen).toBe(true);
    selectTool(W, "terminal");
    expect(targetChatSession(getWorkspaceUi(W))).toBe("s2");
    expect(getWorkspaceUi(W).activeToolKey).toBe("t1");
    activateTab(W, "chat:s1");
    expect(getWorkspaceUi(W).activeToolKey).toBe("t1");
    expect(targetChatSession(getWorkspaceUi(W))).toBe("s1");
    closeTool(W, "t1");
    expect(getWorkspaceUi(W).activeToolKey).toBeNull();
    expect(keys()).toContain("file:README.md");
  });

  it("opens each terminal as its own tab with the lowest free id, up to nine", () => {
    newTerminal(W);
    newTerminal(W);
    expect(getWorkspaceUi(W)).toMatchObject({ toolTabs: ["t1", "t2"], activeToolKey: "t2" });

    for (let i = 0; i < 8; i++) newTerminal(W);
    expect(getWorkspaceUi(W).toolTabs).toEqual(["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"]);
    expect(getWorkspaceUi(W).activeToolKey).toBe("t9");
    closeTool(W, "t4");
    expect(getWorkspaceUi(W).activeToolKey).toBe("t9");
    newTerminal(W);
    expect(getWorkspaceUi(W).activeToolKey).toBe("t4");
    expect(getWorkspaceUi(W).toolTabs).toHaveLength(9);
  });
});
