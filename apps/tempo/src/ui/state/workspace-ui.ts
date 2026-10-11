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
  | { readonly kind: "file"; readonly path: string; readonly line: number | null }
  | { readonly kind: "diff"; readonly path: string | null }
  | { readonly kind: "browser"; readonly url: string };

export type CenterTabKind = CenterTab["kind"];

/** Identity: one tab per session, one per file path, one diff tab, one per browser URL. */
export const tabKey = (t: CenterTab): string => {
  switch (t.kind) {
    case "chat":
      return `chat:${t.sessionId}`;
    case "file":
      return `file:${t.path}`;
    case "diff":
      return "diff";
    case "browser":
      return `browser:${t.url}`;
  }
};

/** Serialized form: `chat:<sessionId>`, `file:<path>:<line?>`, `diff:<path?>`, `browser:<url>`. */
export const tabRef = (t: CenterTab): string => {
  switch (t.kind) {
    case "chat":
      return `chat:${t.sessionId}`;
    case "file":
      return `file:${t.path}:${t.line ?? ""}`;
    case "diff":
      return `diff:${t.path ?? ""}`;
    case "browser":
      return `browser:${t.url}`;
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
    case "browser":
      return rest ? { kind: "browser", url: rest } : null;
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

export type RightTab = "changes" | "files" | "checks";
export type BottomTab = "setup" | "run" | "terminal";

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
  readonly rightTab: RightTab;
  readonly bottomTab: BottomTab;
}

const emptyWorkspaceUi: WorkspaceUiState = {
  tabs: [],
  activeKey: null,
  lastChatSessionId: null,
  insertions: [],
  composerFocusSeq: 0,
  diffScope: "branch",
  rightTab: "changes",
  bottomTab: "setup",
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

export const getWorkspaceUi = (workspaceId: string): WorkspaceUiState => workspaceUiStore(workspaceId).getSnapshot();

const update = (workspaceId: string, f: (s: WorkspaceUiState) => WorkspaceUiState): void =>
  workspaceUiStore(workspaceId).set(f);

const withActive = (s: WorkspaceUiState, key: string | null): WorkspaceUiState => {
  const open = key === null ? undefined : s.tabs.find((t) => t.key === key);
  const lastChatSessionId = open?.tab.kind === "chat" ? open.tab.sessionId : s.lastChatSessionId;
  if (s.activeKey === key && s.lastChatSessionId === lastChatSessionId) return s;
  return { ...s, activeKey: key, lastChatSessionId };
};

let tabSeq = 0;

/** Opens (or re-opens) a tab. An existing tab with the same key is updated in place. */
export const openTab = (workspaceId: string, tab: CenterTab, opts: { readonly activate?: boolean } = {}): string => {
  const key = tabKey(tab);
  const activate = opts.activate ?? true;
  update(workspaceId, (s) => {
    const i = s.tabs.findIndex((t) => t.key === key);
    const entry: OpenTab = { key, tab, seq: ++tabSeq };
    const tabs = i < 0 ? [...s.tabs, entry] : s.tabs.map((t, k) => (k === i ? entry : t));
    const next = { ...s, tabs };
    return activate || s.activeKey === null ? withActive(next, key) : next;
  });
  return key;
};

export const closeTab = (workspaceId: string, key: string): void =>
  update(workspaceId, (s) => {
    const i = s.tabs.findIndex((t) => t.key === key);
    if (i < 0) return s;
    const tabs = s.tabs.filter((t) => t.key !== key);
    let next: WorkspaceUiState = { ...s, tabs };
    if (s.activeKey === key) {
      const neighbor = tabs[Math.min(i, tabs.length - 1)];
      next = withActive({ ...next, activeKey: null }, neighbor?.key ?? null);
    }
    const closed = s.tabs[i]!.tab;
    if (closed.kind === "chat" && next.lastChatSessionId === closed.sessionId) {
      const chat = tabs.find((t) => t.tab.kind === "chat");
      next = { ...next, lastChatSessionId: chat?.tab.kind === "chat" ? chat.tab.sessionId : null };
    }
    return next;
  });

export const activateTab = (workspaceId: string, key: string): void =>
  update(workspaceId, (s) => (s.tabs.some((t) => t.key === key) ? withActive(s, key) : s));

/** ⌥] and ⌥[: the next or previous tab, wrapping around. */
export const cycleTab = (workspaceId: string, delta: 1 | -1): void =>
  update(workspaceId, (s) => {
    if (s.tabs.length === 0) return s;
    const i = s.tabs.findIndex((t) => t.key === s.activeKey);
    const j = i < 0 ? 0 : (i + delta + s.tabs.length) % s.tabs.length;
    return withActive(s, s.tabs[j]!.key);
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

export const openBrowser = (workspaceId: string, url: string): string => openTab(workspaceId, { kind: "browser", url });

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
export const insertIntoComposer = (workspaceId: string, insertion: ComposerInsertion, sessionId?: string): void =>
  update(workspaceId, (s) => {
    const target = sessionId ?? targetChatSession(s);
    let next: WorkspaceUiState = {
      ...s,
      insertions: [...s.insertions, { id: ++insertionSeq, sessionId: target, insertion }],
      composerFocusSeq: s.composerFocusSeq + 1,
    };
    if (target !== null && next.tabs.some((t) => t.key === `chat:${target}`)) next = withActive(next, `chat:${target}`);
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

export const setRightTab = (workspaceId: string, rightTab: RightTab): void =>
  update(workspaceId, (s) => (s.rightTab === rightTab ? s : { ...s, rightTab }));

export const setBottomTab = (workspaceId: string, bottomTab: BottomTab): void =>
  update(workspaceId, (s) => (s.bottomTab === bottomTab ? s : { ...s, bottomTab }));

/** Selects a right-panel tab and makes sure the right side is open. */
export const showRightTab = (workspaceId: string, tab: RightTab): void => {
  setRightTab(workspaceId, tab);
  setLayout({ rightOpen: true });
};

/** Selects a bottom-panel tab and makes sure the right side and the bottom panel are open. */
export const showBottomTab = (workspaceId: string, tab: BottomTab): void => {
  setBottomTab(workspaceId, tab);
  setLayout({ rightOpen: true, bottomOpen: true });
};

// ---------------------------------------------------------------------------------------------
// Layout (global, kept in localStorage)

export type PhonePane = "chat" | "changes";

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

const isStoredLayout = (u: unknown): u is StoredLayout =>
  typeof u === "object" &&
  u !== null &&
  typeof (u as StoredLayout).sidebarOpen === "boolean" &&
  typeof (u as StoredLayout).rightOpen === "boolean" &&
  typeof (u as StoredLayout).bottomOpen === "boolean";

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
    const stored = readJson<StoredLayout | null>(LAYOUT_KEY, null, (u): u is StoredLayout => isStoredLayout(u));
    layout = new Store<LayoutState>({ ...defaultLayout, ...stored });
  }
  return layout;
};

export const getLayout = (): LayoutState => layoutStore().getSnapshot();

export const setLayout = (patch: Partial<LayoutState>): void => {
  const store = layoutStore();
  const prev = store.getSnapshot();
  const changed = (Object.keys(patch) as Array<keyof LayoutState>).some((k) => patch[k] !== prev[k]);
  if (!changed) return;
  store.update(patch);
  const next = store.getSnapshot();
  if (next.sidebarOpen !== prev.sidebarOpen || next.rightOpen !== prev.rightOpen || next.bottomOpen !== prev.bottomOpen) {
    writeJson(LAYOUT_KEY, { sidebarOpen: next.sidebarOpen, rightOpen: next.rightOpen, bottomOpen: next.bottomOpen });
  }
};

/** ⌘B. */
export const toggleSidebar = (): void => setLayout({ sidebarOpen: !getLayout().sidebarOpen });

/** ⌘⌥B. */
export const toggleRight = (): void => setLayout({ rightOpen: !getLayout().rightOpen });

/** ⌥J. The bottom panel lives in the right side, so opening it also opens the right side. */
export const toggleBottom = (): void => {
  const l = getLayout();
  if (!l.rightOpen) setLayout({ rightOpen: true, bottomOpen: true });
  else setLayout({ bottomOpen: !l.bottomOpen });
};

export const setPhonePane = (phonePane: PhonePane): void => setLayout({ phonePane });

// ---------------------------------------------------------------------------------------------
// App dialogs

export type SettingsTab = "logins" | "project" | "appearance" | "notifications" | "shortcuts" | "devices";

export type DialogState =
  | { readonly kind: "newWorkspace"; readonly projectId?: string; readonly prompt?: string }
  | { readonly kind: "addProject" }
  | { readonly kind: "settings"; readonly tab?: SettingsTab; readonly projectId?: string }
  | { readonly kind: "diagnostics"; readonly workspaceId: string }
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

export const openDialog = (dialog: DialogState): void => dialogStore.update({ dialog });

/** Closes the open dialog; with a kind, only when that dialog is the open one. */
export const closeDialog = (kind?: DialogKind): void => {
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
  rotatePreview: (): ConfirmOptions => ({
    title: "Rotate preview link?",
    description: "Old preview links will stop working.",
    confirmLabel: "Rotate",
    destructive: true,
  }),
  deleteWorkspace: (slug: string): ConfirmOptions => ({
    title: "Delete this workspace?",
    description: `Type ${slug} to confirm.`,
    confirmLabel: "Delete",
    destructive: true,
    typeToConfirm: slug,
  }),
} as const;

/** Clears every store. Tests only. */
export const resetUiState = (): void => {
  workspaceStores.clear();
  layout = null;
  for (const resolve of confirmResolvers.values()) resolve(false);
  confirmResolvers.clear();
  dialogStore.set({ dialog: null, confirm: null });
};
