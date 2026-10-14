import { Schema } from "effect";
import type { DiffScope } from "@tempo/protocol";
import { readJson, writeJson } from "~/ui/lib/storage";
import { Store } from "~/ui/lib/store";

/**
 * Shared UI state that crosses regions (sidebar, chat, review, processes, dialogs). Framework-free:
 * React reads it through the hooks in ~/ui/hooks/useWorkspaceUi. Documented in ~/ui/CONTRACT.md.
 */
// ---------------------------------------------------------------------------------------------
// Center tabs
export type CenterTab =
  | { readonly kind: "chat"; readonly sessionId: string }
  | { readonly kind: "runTranscript"; readonly sessionId: string }
  | { readonly kind: "file"; readonly path: string; readonly line: number | null }
  | { readonly kind: "diff"; readonly path: string | null }
  | { readonly kind: "guide" }
  | { readonly kind: "browser"; readonly url: string }
  | { readonly kind: "liveView" }
  /** `version` null: the newest version (04, Artifact tab). */
  | { readonly kind: "artifact"; readonly artifactId: string; readonly version: number | null };

export type CenterTabKind = CenterTab["kind"];

/**
 * Identity: one tab per session, one per file path, one diff tab, one per browser URL, one Live View,
 * one per artifact.
 */
export const tabKey = (t: CenterTab): string => {
  switch (t.kind) {
    case "chat":
      return `chat:${t.sessionId}`;
    case "runTranscript":
      return `runTranscript:${t.sessionId}`;
    case "file":
      return `file:${t.path}`;
    case "diff":
      return "diff";
    case "guide":
      return "guide";
    case "browser":
      return `browser:${t.url}`;
    case "liveView":
      return "liveView";
    case "artifact":
      return `artifact:${t.artifactId}`;
  }
};

/**
 * Serialized form: `chat:<sessionId>`, `file:<path>:<line?>`, `diff:<path?>`, `browser:<url>`,
 * `liveView:`, `artifact:<artifactId>:<version?>`.
 */
export const tabRef = (t: CenterTab): string => {
  switch (t.kind) {
    case "chat":
      return `chat:${t.sessionId}`;
    case "runTranscript":
      return `runTranscript:${t.sessionId}`;
    case "file":
      return `file:${t.path}:${t.line ?? ""}`;
    case "diff":
      return `diff:${t.path ?? ""}`;
    case "guide":
      return "guide:";
    case "browser":
      return `browser:${t.url}`;
    case "liveView":
      return "liveView:";
    case "artifact":
      return `artifact:${t.artifactId}:${t.version ?? ""}`;
  }
};

export const parseTabRef = (ref: string): CenterTab | null => {
  const i = ref.indexOf(":");

  if (i < 0) return null;
  const kind = ref.slice(0, i);
  const rest = ref.slice(i + 1);

  switch (kind) {
    case "chat":
      return rest ? { kind: "chat", sessionId: rest } : null;
    case "runTranscript":
      return rest ? { kind: "runTranscript", sessionId: rest } : null;
    case "file": {
      const j = rest.lastIndexOf(":");

      if (j < 0) return rest ? { kind: "file", path: rest, line: null } : null;
      const path = rest.slice(0, j);
      const lineText = rest.slice(j + 1);
      const line = lineText === "" ? null : Number(lineText);

      if (!path || (line !== null && (!Number.isInteger(line) || line < 1))) return null;

      return { kind: "file", path, line };
    }

    case "diff":
      return { kind: "diff", path: rest === "" ? null : rest };
    case "guide":
      return rest === "" ? { kind: "guide" } : null;
    case "browser":
      return rest ? { kind: "browser", url: rest } : null;
    case "liveView":
      return rest === "" ? { kind: "liveView" } : null;
    case "artifact": {
      const [artifactId = "", versionText = "", ...extra] = rest.split(":");
      const version = versionText === "" ? null : Number(versionText);

      if (!/^[0-9a-z]{26}$/.test(artifactId) || extra.length > 0) return null;

      if (version !== null && (!Number.isInteger(version) || version < 1)) return null;

      return { kind: "artifact", artifactId, version };
    }

    default:
      return null;
  }
};

export interface OpenTab {
  readonly key: string;
  readonly tab: CenterTab;
  /** Increments every time the tab is opened again, so a view can scroll to the new line or path. */
  readonly seq: number;
}

export type RightTab = "changes" | "files" | "checks" | "artifacts" | "activity";

export type BottomTab = "setup" | "run" | "terminal";

export type UtilityTab = RightTab | BottomTab;

export type ComposerInsertion =
  | { readonly kind: "mention"; readonly path: string }
  | { readonly kind: "reviewComments"; readonly commentIds: ReadonlyArray<string> }
  | { readonly kind: "text"; readonly text: string };

export interface PendingInsertion {
  readonly id: number;
  /** The session whose composer takes it; null means whichever chat is shown. */
  readonly sessionId: string | null;
  readonly insertion: ComposerInsertion;
}

export interface WorkspaceUiState {
  readonly tabs: ReadonlyArray<OpenTab>;
  readonly activeKey: string | null;
  /** The chat tab shown most recently; insertions and ⌥L go to it. */
  readonly lastChatSessionId: string | null;
  readonly insertions: ReadonlyArray<PendingInsertion>;
  /** Increments when something asks the composer to take focus. */
  readonly composerFocusSeq: number;
  readonly diffScope: DiffScope;
  readonly infoOpen: boolean;
  readonly toolTabs: ReadonlyArray<UtilityTab>;
  readonly activeToolKey: string | null;
  readonly rightTab: RightTab;
  readonly bottomTab: BottomTab;
  /** Sleeping, or no changes and no PR: the right side starts closed (04, Right and bottom panels). */
  readonly rightQuiet: boolean;
  /** The user opened the right side while quiet. Not kept. */
  readonly rightPinned: boolean;
}

const emptyWorkspaceUi: WorkspaceUiState = {
  tabs: [],
  activeKey: null,
  lastChatSessionId: null,
  insertions: [],
  composerFocusSeq: 0,
  diffScope: "branch",
  infoOpen: true,
  toolTabs: ["changes"],
  activeToolKey: "changes",
  rightTab: "changes",
  bottomTab: "setup",
  rightQuiet: false,
  rightPinned: false,
};

const workspaceStores = new Map<string, Store<WorkspaceUiState>>();

export const workspaceUiStore = (workspaceId: string): Store<WorkspaceUiState> => {
  let s = workspaceStores.get(workspaceId);

  if (!s) {
    s = new Store(emptyWorkspaceUi);
    workspaceStores.set(workspaceId, s);
  }

  return s;
};

export const getWorkspaceUi = (workspaceId: string): WorkspaceUiState =>
  workspaceUiStore(workspaceId).getSnapshot();

const update = (workspaceId: string, f: (s: WorkspaceUiState) => WorkspaceUiState): void =>
  workspaceUiStore(workspaceId).set(f);

const withActive = (s: WorkspaceUiState, key: string | null): WorkspaceUiState => {
  const open = key === null ? undefined : s.tabs.find((t) => t.key === key);
  const lastChatSessionId = open?.tab.kind === "chat" ? open.tab.sessionId : s.lastChatSessionId;

  if (s.activeKey === key && s.lastChatSessionId === lastChatSessionId) return s;

  return {
    ...s,
    activeKey: key,
    lastChatSessionId,
    activeToolKey: open && open.tab.kind !== "chat" ? key : s.activeToolKey,
    infoOpen: open && open.tab.kind !== "chat" ? false : s.infoOpen,
  };
};

let tabSeq = 0;

/** Opens (or re-opens) a tab. An existing tab with the same key is updated in place. */
export const openTab = (
  workspaceId: string,
  tab: CenterTab,
  opts: { readonly activate?: boolean } = {},
): string => {
  const key = tabKey(tab);
  const activate = opts.activate ?? true;
  update(workspaceId, (s) => {
    const i = s.tabs.findIndex((t) => t.key === key);
    const entry: OpenTab = { key, tab, seq: ++tabSeq };
    const tabs = i < 0 ? [...s.tabs, entry] : s.tabs.map((t, k) => (k === i ? entry : t));
    const next = { ...s, tabs };

    return activate || s.activeKey === null ? withActive(next, key) : next;
  });

  if (tab.kind !== "chat" && activate) {
    pinRight(workspaceId);
    setLayout({ rightOpen: true });
  }

  return key;
};

export const closeTab = (workspaceId: string, key: string): void =>
  update(workspaceId, (s) => {
    const i = s.tabs.findIndex((t) => t.key === key);

    if (i < 0) return s;
    const tabs = s.tabs.filter((t) => t.key !== key);

    let next: WorkspaceUiState = {
      ...s,
      tabs,
      activeToolKey: s.activeToolKey === key ? null : s.activeToolKey,
    };

    if (s.activeKey === key) {
      const neighbor = tabs[Math.min(i, tabs.length - 1)];
      next = withActive({ ...next, activeKey: null }, neighbor?.key ?? null);
    }

    const closed = s.tabs[i]!.tab;

    if (closed.kind === "chat" && next.lastChatSessionId === closed.sessionId) {
      const chat = tabs.find((t) => t.tab.kind === "chat");
      next = { ...next, lastChatSessionId: chat?.tab.kind === "chat" ? chat.tab.sessionId : null };
    }

    if (s.activeToolKey === key) next = { ...next, activeToolKey: null };

    return next;
  });

export const activateTab = (workspaceId: string, key: string): void =>
  update(workspaceId, (s) => (s.tabs.some((t) => t.key === key) ? withActive(s, key) : s));

/** ⌥] and ⌥[: the next or previous tab, wrapping around. */
export const cycleTab = (workspaceId: string, delta: 1 | -1, chatOnly = false): void =>
  update(workspaceId, (s) => {
    const tabs = chatOnly ? s.tabs.filter((t) => t.tab.kind === "chat") : s.tabs;

    if (tabs.length === 0) return s;

    const active =
      chatOnly && !s.activeKey?.startsWith("chat:") ? `chat:${s.lastChatSessionId}` : s.activeKey;

    const i = tabs.findIndex((t) => t.key === active);
    const j = i < 0 ? 0 : (i + delta + tabs.length) % tabs.length;

    return withActive(s, tabs[j]!.key);
  });

export const moveTab = (workspaceId: string, key: string, toIndex: number): void =>
  update(workspaceId, (s) => {
    const i = s.tabs.findIndex((t) => t.key === key);

    if (i < 0) return s;
    const tabs = s.tabs.slice();
    const [moved] = tabs.splice(i, 1);
    tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, moved!);

    return { ...s, tabs };
  });

/**
 * Keeps one chat tab per open session: new sessions get a tab after the last chat tab, and chat
 * tabs of sessions not in the list are removed. Other tabs keep their places. When the active tab
 * goes away (or nothing is active) the first chat becomes active.
 */
export const syncChatTabs = (workspaceId: string, sessionIds: ReadonlyArray<string>): void =>
  update(workspaceId, (s) => {
    const wanted = new Set(sessionIds);
    const kept = s.tabs.filter((t) => t.tab.kind !== "chat" || wanted.has(t.tab.sessionId));
    const have = new Set(kept.filter((t) => t.tab.kind === "chat").map((t) => t.key));
    const added: OpenTab[] = [];

    for (const id of sessionIds) {
      const key = `chat:${id}`;

      if (!have.has(key)) added.push({ key, tab: { kind: "chat", sessionId: id }, seq: ++tabSeq });
    }

    if (added.length === 0 && kept.length === s.tabs.length) {
      return s.activeKey === null && kept.length > 0 ? withActive(s, kept[0]!.key) : s;
    }

    const lastChat = kept.reduce((acc, t, k) => (t.tab.kind === "chat" ? k : acc), -1);
    const tabs = [...kept.slice(0, lastChat + 1), ...added, ...kept.slice(lastChat + 1)];
    let next: WorkspaceUiState = { ...s, tabs };

    if (!tabs.some((t) => t.key === s.activeKey)) {
      const firstChat = tabs.find((t) => t.tab.kind === "chat") ?? tabs[0];
      next = withActive({ ...next, activeKey: null }, firstChat?.key ?? null);
    }

    if (next.lastChatSessionId !== null && !wanted.has(next.lastChatSessionId)) {
      next = { ...next, lastChatSessionId: sessionIds[0] ?? null };
    }

    return next;
  });

export const openFile = (workspaceId: string, path: string, line: number | null = null): string =>
  openTab(workspaceId, { kind: "file", path, line });

export const openDiff = (workspaceId: string, path: string | null = null): string =>
  openTab(workspaceId, { kind: "diff", path });

export const openGuide = (workspaceId: string): string => openTab(workspaceId, { kind: "guide" });

export const openBrowser = (workspaceId: string, url: string): string =>
  openTab(workspaceId, { kind: "browser", url });

export const openArtifactTab = (
  workspaceId: string,
  artifactId: string,
  version: number | null = null,
): string => openTab(workspaceId, { kind: "artifact", artifactId, version });

/** The tab holds no link: a Live View link is a secret, so the tab asks for its own (04, Browser tabs). */
export const openLiveView = (workspaceId: string): string => openTab(workspaceId, { kind: "liveView" });

/** The session of the active chat tab, else of the chat shown most recently. */
export const targetChatSession = (s: WorkspaceUiState): string | null => {
  const active = s.tabs.find((t) => t.key === s.activeKey);

  if (active?.tab.kind === "chat") return active.tab.sessionId;

  return s.lastChatSessionId;
};

let insertionSeq = 0;

/**
 * Queues a chip or text for a composer and shows that chat. The composer takes it with
 * takeInsertions. Without a sessionId it goes to the target chat (see targetChatSession).
 */
export const insertIntoComposer = (
  workspaceId: string,
  insertion: ComposerInsertion,
  sessionId?: string,
): void =>
  update(workspaceId, (s) => {
    const target = sessionId ?? targetChatSession(s);

    let next: WorkspaceUiState = {
      ...s,
      insertions: [...s.insertions, { id: ++insertionSeq, sessionId: target, insertion }],
      composerFocusSeq: s.composerFocusSeq + 1,
    };

    if (target !== null && next.tabs.some((t) => t.key === `chat:${target}`))
      next = withActive(next, `chat:${target}`);

    return next;
  });

/** Removes and returns the insertions for this session's composer (and untargeted ones). */
export const takeInsertions = (workspaceId: string, sessionId: string): PendingInsertion[] => {
  const s = getWorkspaceUi(workspaceId);
  const mine = s.insertions.filter((p) => p.sessionId === sessionId || p.sessionId === null);

  if (mine.length > 0) {
    update(workspaceId, (cur) => ({
      ...cur,
      insertions: cur.insertions.filter((p) => !mine.some((m) => m.id === p.id)),
    }));
  }

  return mine;
};

/** ⌥L: shows the target chat and asks its composer to take focus. */
export const focusComposer = (workspaceId: string): void =>
  update(workspaceId, (s) => {
    const target = targetChatSession(s);
    const next = { ...s, composerFocusSeq: s.composerFocusSeq + 1 };

    return target !== null ? withActive(next, `chat:${target}`) : next;
  });

export const setDiffScope = (workspaceId: string, diffScope: DiffScope): void =>
  update(workspaceId, (s) => (s.diffScope === diffScope ? s : { ...s, diffScope }));

/** ⌥U. */
export const toggleDiffScope = (workspaceId: string): void =>
  update(workspaceId, (s) => ({ ...s, diffScope: s.diffScope === "branch" ? "uncommitted" : "branch" }));

export const setRightTab = (workspaceId: string, rightTab: RightTab): void => {
  update(workspaceId, (s) => ({ ...s, rightTab }));
  selectTool(workspaceId, rightTab);
};

export const setBottomTab = (workspaceId: string, bottomTab: BottomTab): void => {
  update(workspaceId, (s) => ({ ...s, bottomTab }));
  selectTool(workspaceId, bottomTab);
};

export const showWorkspaceInfo = (workspaceId: string): void => {
  update(workspaceId, (s) => ({ ...s, infoOpen: true }));
  pinRight(workspaceId);
  setLayout({ rightOpen: true });
};

export const closeWorkspaceInfo = (): void => {
  setLayout({ rightOpen: false, phonePane: "chat" });
};

export const selectTool = (workspaceId: string, key: UtilityTab | null): void => {
  update(workspaceId, (s) => ({
    ...s,
    infoOpen: false,
    toolTabs: key && !s.toolTabs.includes(key) ? [...s.toolTabs, key] : s.toolTabs,
    activeToolKey: key,
  }));
  pinRight(workspaceId);
  setLayout({ rightOpen: true });
};

export const closeTool = (workspaceId: string, key: UtilityTab): void =>
  update(workspaceId, (s) => ({
    ...s,
    toolTabs: s.toolTabs.filter((t) => t !== key),
    activeToolKey: s.activeToolKey === key ? null : s.activeToolKey,
  }));

export const setRightQuiet = (workspaceId: string, rightQuiet: boolean): void =>
  update(workspaceId, (s) => (s.rightQuiet === rightQuiet ? s : { ...s, rightQuiet }));

const pinRight = (workspaceId: string | null): void => {
  if (workspaceId) update(workspaceId, (s) => (s.rightPinned ? s : { ...s, rightPinned: true }));
};

/** Whether the right side shows for this workspace: the layout choice, unless it starts closed. */
export const isRightOpen = (
  layout: Pick<LayoutState, "rightOpen">,
  ui: Pick<WorkspaceUiState, "rightQuiet" | "rightPinned">,
): boolean => layout.rightOpen && (ui.rightPinned || !ui.rightQuiet);

/** Selects a right-panel tab and makes sure the right side is open. */
export const showRightTab = (workspaceId: string, tab: RightTab): void => {
  setRightTab(workspaceId, tab);
  pinRight(workspaceId);
  setLayout({ rightOpen: true });
};

/**
 * Selects a bottom-panel tab and makes sure the right side and the bottom panel are open. At
 * phone width there is no bottom panel, so the Setup output shows as its own pane.
 */
export const showBottomTab = (workspaceId: string, tab: BottomTab): void => {
  setBottomTab(workspaceId, tab);
  pinRight(workspaceId);
  setLayout(
    tab === "setup"
      ? { rightOpen: true, bottomOpen: true, phonePane: "setup" }
      : { rightOpen: true, bottomOpen: true },
  );
};

// ---------------------------------------------------------------------------------------------
// Layout (global, kept in localStorage)
/** `setup` has no bottom-navigation entry; the Setup banners open it. */
export type PhonePane = "chat" | "changes" | "setup" | "tools";

export interface LayoutState {
  readonly sidebarOpen: boolean;
  readonly rightOpen: boolean;
  readonly bottomOpen: boolean;
  /** Phone width: which pane of the open workspace shows. Not kept. */
  readonly phonePane: PhonePane;
  /** The workspace opened most recently, for the phone Chat and Changes buttons. Not kept. */
  readonly lastWorkspaceId: string | null;
}

const LAYOUT_KEY = "layout:panels";

type StoredLayout = Pick<LayoutState, "sidebarOpen" | "rightOpen" | "bottomOpen">;

const isStoredLayout = Schema.is(
  Schema.Struct({
    sidebarOpen: Schema.Boolean,
    rightOpen: Schema.Boolean,
    bottomOpen: Schema.Boolean,
  }),
);

const defaultLayout: LayoutState = {
  sidebarOpen: true,
  rightOpen: true,
  bottomOpen: true,
  phonePane: "chat",
  lastWorkspaceId: null,
};

let layout: Store<LayoutState> | null = null;

export const layoutStore = (): Store<LayoutState> => {
  if (!layout) {
    const stored = readJson<StoredLayout | null>(LAYOUT_KEY, null, (u): u is StoredLayout =>
      isStoredLayout(u),
    );

    layout = new Store<LayoutState>({ ...defaultLayout, ...stored });
  }

  return layout;
};

export const getLayout = (): LayoutState => layoutStore().getSnapshot();

export const setLayout = (patch: Partial<LayoutState>): void => {
  const store = layoutStore();
  const prev = store.getSnapshot();

  const changed = Object.entries(patch).some(([key, value]) =>
    Object.entries(prev).some(([name, current]) => name === key && value !== current),
  );

  if (!changed) return;
  store.update(patch);
  const next = store.getSnapshot();

  if (
    next.sidebarOpen !== prev.sidebarOpen ||
    next.rightOpen !== prev.rightOpen ||
    next.bottomOpen !== prev.bottomOpen
  ) {
    writeJson(LAYOUT_KEY, {
      sidebarOpen: next.sidebarOpen,
      rightOpen: next.rightOpen,
      bottomOpen: next.bottomOpen,
    });
  }
};

/** ⌘B. */
export const toggleSidebar = (): void => setLayout({ sidebarOpen: !getLayout().sidebarOpen });

const shownRight = (l: LayoutState): boolean =>
  l.lastWorkspaceId ? isRightOpen(l, getWorkspaceUi(l.lastWorkspaceId)) : l.rightOpen;

/** ⌘⌥B. Opening pins the right side for the open workspace; closing is kept as the layout choice. */
export const toggleRight = (): void => {
  const l = getLayout();

  if (shownRight(l)) setLayout({ rightOpen: false });
  else {
    pinRight(l.lastWorkspaceId);
    setLayout({ rightOpen: true });
  }
};

/** ⌥J: Terminal, then the tool launcher. Legacy bottomOpen remains readable in saved layouts. */
export const toggleBottom = (): void => {
  const l = getLayout();

  if (!l.lastWorkspaceId) {
    setLayout({ rightOpen: true, bottomOpen: !l.bottomOpen });

    return;
  }

  const terminalSelected = shownRight(l) && getWorkspaceUi(l.lastWorkspaceId).activeToolKey === "terminal";
  selectTool(l.lastWorkspaceId, terminalSelected ? null : "terminal");
  setLayout({ bottomOpen: !terminalSelected });
};

export const setPhonePane = (phonePane: PhonePane): void => setLayout({ phonePane });

// ---------------------------------------------------------------------------------------------
// App dialogs
export type SettingsTab =
  | "general"
  | "logins"
  | "agents"
  | "environments"
  | "mcp"
  | "project"
  | "appearance"
  | "notifications"
  | "shortcuts"
  | "devices";

export type DialogState =
  | { readonly kind: "newWorkspace"; readonly projectId?: string; readonly prompt?: string }
  | { readonly kind: "addProject" }
  | { readonly kind: "settings"; readonly tab?: SettingsTab; readonly projectId?: string }
  | { readonly kind: "diagnostics"; readonly workspaceId: string }
  | { readonly kind: "environment"; readonly workspaceId: string }
  | { readonly kind: "palette" }
  | { readonly kind: "openFile"; readonly workspaceId: string }
  | { readonly kind: "searchFiles"; readonly workspaceId: string };

export type DialogKind = DialogState["kind"];

export type DialogOf<K extends DialogKind> = Extract<DialogState, { kind: K }>;

export interface ConfirmOptions {
  readonly title: string;
  readonly description?: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly destructive?: boolean;
  /** The user must type this text (for example the slug) before confirming. */
  readonly typeToConfirm?: string;
}

export interface ConfirmRequest extends ConfirmOptions {
  readonly id: number;
}

export interface DialogStoreState {
  readonly dialog: DialogState | null;
  readonly confirm: ConfirmRequest | null;
}

export const dialogStore = new Store<DialogStoreState>({ dialog: null, confirm: null });

export const settingsStore = new Store<DialogOf<"settings"> | null>(null);

export const openDialog = (dialog: DialogState): void => {
  if (dialog.kind === "settings") {
    settingsStore.set(dialog);
    dialogStore.update({ dialog: null });
  } else dialogStore.update({ dialog });
};

/** Closes the open dialog; with a kind, only when that dialog is the open one. */
export const closeDialog = (kind?: DialogKind): void => {
  if (kind === "settings") {
    settingsStore.set(null);

    return;
  }

  const cur = dialogStore.getSnapshot().dialog;

  if (cur && (kind === undefined || cur.kind === kind)) dialogStore.update({ dialog: null });
};

let confirmSeq = 0;

const confirmResolvers = new Map<number, (ok: boolean) => void>();

/** Shows the confirmation dialog (dialogs/Confirm.tsx). A newer request cancels an older one. */
export const confirm = (opts: ConfirmOptions): Promise<boolean> => {
  const prev = dialogStore.getSnapshot().confirm;

  if (prev) resolveConfirm(prev.id, false);
  const id = ++confirmSeq;

  return new Promise<boolean>((resolve) => {
    confirmResolvers.set(id, resolve);
    dialogStore.update({ confirm: { ...opts, id } });
  });
};

export const resolveConfirm = (id: number, ok: boolean): void => {
  const resolve = confirmResolvers.get(id);
  confirmResolvers.delete(id);

  if (dialogStore.getSnapshot().confirm?.id === id) dialogStore.update({ confirm: null });
  resolve?.(ok);
};

/** Confirmation texts from 04, Confirmations. */
export const CONFIRM_TEXT = {
  revert: (turnSeq: number): ConfirmOptions => ({
    title: "Revert files?",
    description: `Files go back to the end of turn ${turnSeq}. A safety checkpoint is saved first.`,
    confirmLabel: "Revert",
    destructive: true,
  }),
  closeRunningChat: (): ConfirmOptions => ({
    title: "Stop the agent and close this chat?",
    confirmLabel: "Stop and close",
    destructive: true,
  }),
  resetPreviewAccess: (): ConfirmOptions => ({
    title: "Reset preview access?",
    description: "Open previews will stop working. Open them again from Tempo.",
    confirmLabel: "Reset",
    destructive: true,
  }),
  deleteWorkspace: (slug: string): ConfirmOptions => ({
    title: "Delete this workspace?",
    description: `Saved conversations will remain in project history. Type ${slug} to confirm.`,
    confirmLabel: "Delete",
    destructive: true,
    typeToConfirm: slug,
  }),
  deleteAgent: (name: string): ConfirmOptions => ({
    title: `Delete ${name}? Open chats keep using it.`,
    confirmLabel: "Delete",
    destructive: true,
  }),
} as const;

/** Clears every store. Tests only. */
export const resetUiState = (): void => {
  workspaceStores.clear();
  layout = null;

  for (const resolve of confirmResolvers.values()) resolve(false);
  confirmResolvers.clear();
  dialogStore.set({ dialog: null, confirm: null });
  settingsStore.set(null);
};
