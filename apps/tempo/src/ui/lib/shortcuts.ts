/**
 * The keyboard shortcut table from 04 (Keyboard shortcuts). Settings → Shortcuts, the command
 * palette and every key handler read it. Keys match on KeyboardEvent.code; ⌘ is Meta on macOS and
 * Ctrl elsewhere; ⌥ is Alt; ⌃ is Control everywhere.
 */

export interface KeyCombo {
  readonly code: string;
  /** ⌘ on macOS, Ctrl elsewhere. */
  readonly mod?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
  /** ⌃ (Control) on every platform. */
  readonly ctrl?: boolean;
}

export type ShortcutScope = "global" | "composer" | "permission" | "diff";

export type ActionId =
  | "palette"
  | "newWorkspace"
  | "newChat"
  | "closeTab"
  | "nextTab"
  | "prevTab"
  | "workspace1"
  | "workspace2"
  | "workspace3"
  | "workspace4"
  | "workspace5"
  | "workspace6"
  | "workspace7"
  | "workspace8"
  | "workspace9"
  | "nextWorkspace"
  | "prevWorkspace"
  | "nextNeedsYou"
  | "toggleSidebar"
  | "toggleRight"
  | "toggleBottom"
  | "focusComposer"
  | "send"
  | "newLine"
  | "stop"
  | "togglePlan"
  | "modelPicker"
  | "attach"
  | "permissionAllow"
  | "permissionReject"
  | "expandAll"
  | "diffTab"
  | "toggleScope"
  | "nextFile"
  | "prevFile"
  | "markViewed"
  | "openFile"
  | "searchFiles"
  | "commitPush"
  | "createPr"
  | "merge"
  | "archive"
  | "toggleRun"
  | "settings";

export interface Binding {
  readonly id: ActionId;
  readonly key: KeyCombo;
  readonly scope: ShortcutScope;
  /** Label used by the command palette. */
  readonly label: string;
}

export interface ShortcutRow {
  readonly action: string;
  readonly bindings: ReadonlyArray<Binding>;
  /** Shown instead of the formatted keys when the row is not a plain key list. */
  readonly display?: { readonly mac: string; readonly other: string };
  readonly conductor: string;
}

const b = (id: ActionId, label: string, key: KeyCombo, scope: ShortcutScope = "global"): Binding => ({
  id,
  key,
  scope,
  label,
});

const digits = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export const SHORTCUT_ROWS: ReadonlyArray<ShortcutRow> = [
  { action: "Command palette", bindings: [b("palette", "Command palette", { code: "KeyK", mod: true })], conductor: "⌘K" },
  { action: "New workspace", bindings: [b("newWorkspace", "New workspace", { code: "KeyN", alt: true })], conductor: "⌘N" },
  { action: "New chat tab", bindings: [b("newChat", "New chat tab", { code: "KeyT", alt: true })], conductor: "⌘T" },
  { action: "Close tab", bindings: [b("closeTab", "Close tab", { code: "KeyW", alt: true })], conductor: "⌘W" },
  {
    action: "Next or previous center tab",
    bindings: [
      b("nextTab", "Next tab", { code: "BracketRight", alt: true }),
      b("prevTab", "Previous tab", { code: "BracketLeft", alt: true }),
    ],
    conductor: "⌃Tab or ⌃⇧Tab",
  },
  {
    action: "Switch to workspace 1 to 9",
    bindings: digits.map((n) =>
      b(`workspace${n}` as ActionId, `Switch to workspace ${n}`, { code: `Digit${n}`, alt: true }),
    ),
    display: { mac: "⌥1 to ⌥9", other: "Alt+1 to Alt+9" },
    conductor: "⌘1 to ⌘9",
  },
  {
    action: "Next or previous workspace",
    bindings: [
      b("nextWorkspace", "Next workspace", { code: "ArrowDown", alt: true }),
      b("prevWorkspace", "Previous workspace", { code: "ArrowUp", alt: true }),
    ],
    conductor: "⌘⌥↓ or ⌘⌥↑",
  },
  {
    action: "Next workspace that needs you",
    bindings: [b("nextNeedsYou", "Next workspace that needs you", { code: "KeyG", alt: true })],
    conductor: "⌘⌥L",
  },
  { action: "Toggle sidebar", bindings: [b("toggleSidebar", "Toggle sidebar", { code: "KeyB", mod: true })], conductor: "⌘B" },
  {
    action: "Toggle right side",
    bindings: [b("toggleRight", "Toggle right side", { code: "KeyB", mod: true, alt: true })],
    conductor: "⌘⌥B",
  },
  {
    action: "Toggle bottom panel",
    bindings: [b("toggleBottom", "Toggle bottom panel", { code: "KeyJ", alt: true })],
    conductor: "⌘J",
  },
  { action: "Focus composer", bindings: [b("focusComposer", "Focus composer", { code: "KeyL", alt: true })], conductor: "⌘L" },
  { action: "Send", bindings: [b("send", "Send", { code: "Enter" }, "composer")], conductor: "Enter" },
  { action: "New line", bindings: [b("newLine", "New line", { code: "Enter", shift: true }, "composer")], conductor: "⇧Enter" },
  {
    action: "Stop the turn",
    bindings: [b("stop", "Stop the turn", { code: "Escape" }, "composer")],
    display: { mac: "Esc in the composer", other: "Esc in the composer" },
    conductor: "Esc or ⌘⇧⌫",
  },
  {
    action: "Toggle plan mode",
    bindings: [b("togglePlan", "Toggle plan mode", { code: "Tab", shift: true }, "composer")],
    display: { mac: "⇧Tab in the composer", other: "Shift+Tab in the composer" },
    conductor: "⇧Tab",
  },
  { action: "Model picker", bindings: [b("modelPicker", "Model picker", { code: "Slash", mod: true })], conductor: "⌘/" },
  { action: "Attach a file", bindings: [b("attach", "Attach a file", { code: "KeyU", mod: true })], conductor: "⌘U" },
  {
    action: "Approve or deny a permission",
    bindings: [
      b("permissionAllow", "Approve", { code: "Enter" }, "permission"),
      b("permissionReject", "Deny", { code: "Backspace" }, "permission"),
    ],
    display: { mac: "Enter or ⌫ on the focused card", other: "Enter or Backspace on the focused card" },
    conductor: "Enter or ⌫",
  },
  { action: "Expand all tool calls", bindings: [b("expandAll", "Expand all tool calls", { code: "KeyO", ctrl: true })], conductor: "⌃O" },
  { action: "Diff tab", bindings: [b("diffTab", "Diff tab", { code: "KeyD", alt: true })], conductor: "⌘⇧D" },
  {
    action: "Branch or uncommitted scope",
    bindings: [b("toggleScope", "Branch or uncommitted scope", { code: "KeyU", alt: true })],
    conductor: "⌘⌥U",
  },
  {
    action: "Next or previous file in the diff",
    bindings: [
      b("nextFile", "Next file", { code: "KeyJ" }, "diff"),
      b("prevFile", "Previous file", { code: "KeyK" }, "diff"),
    ],
    conductor: "↓ or ↑",
  },
  { action: "Mark file viewed", bindings: [b("markViewed", "Mark file viewed", { code: "KeyV", ctrl: true }, "diff")], conductor: "⌃V" },
  { action: "Open file", bindings: [b("openFile", "Open file", { code: "KeyP", mod: true })], conductor: "⌘P" },
  { action: "Search files", bindings: [b("searchFiles", "Search files", { code: "KeyF", mod: true, shift: true })], conductor: "⌘⇧F" },
  { action: "Commit and push", bindings: [b("commitPush", "Commit and push", { code: "KeyY", alt: true })], conductor: "⌘⇧Y" },
  { action: "Create PR", bindings: [b("createPr", "Create PR", { code: "KeyP", alt: true })], conductor: "⌘⇧P" },
  { action: "Merge", bindings: [b("merge", "Merge", { code: "KeyM", alt: true })], conductor: "⌘⇧M" },
  { action: "Archive", bindings: [b("archive", "Archive", { code: "KeyA", alt: true })], conductor: "⌘⇧A" },
  {
    action: "Start or stop the default run script",
    bindings: [b("toggleRun", "Start or stop the default run script", { code: "KeyR", alt: true })],
    conductor: "⌘R",
  },
  { action: "Settings", bindings: [b("settings", "Settings", { code: "Comma", alt: true })], conductor: "⌘," },
];

export const BINDINGS: ReadonlyArray<Binding> = SHORTCUT_ROWS.flatMap((r) => r.bindings);

const BY_ID = new Map(BINDINGS.map((x) => [x.id, x]));

export const bindingFor = (id: ActionId): Binding => BY_ID.get(id)!;

export const isMacPlatform = (): boolean => {
  const nav = globalThis.navigator as (Navigator & { userAgentData?: { platform?: string } }) | undefined;
  if (!nav) return false;
  const platform = nav.userAgentData?.platform ?? nav.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(platform) || /Mac OS X/.test(nav.userAgent ?? "");
};

export interface KeyEventLike {
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/** Exact match: every modifier the combo does not name must be up. */
export const matchesCombo = (e: KeyEventLike, k: KeyCombo, mac: boolean): boolean => {
  if (e.code !== k.code) return false;
  if (e.altKey !== Boolean(k.alt) || e.shiftKey !== Boolean(k.shift)) return false;
  if (mac) return e.metaKey === Boolean(k.mod) && e.ctrlKey === Boolean(k.ctrl);
  return e.metaKey === false && e.ctrlKey === Boolean(k.mod || k.ctrl);
};

export const matches = (e: KeyEventLike, id: ActionId, mac: boolean = isMacPlatform()): boolean =>
  matchesCombo(e, bindingFor(id).key, mac);

/** The first global binding the event matches. */
export const matchGlobal = (e: KeyEventLike, mac: boolean): Binding | undefined =>
  BINDINGS.find((x) => x.scope === "global" && matchesCombo(e, x.key, mac));

const CODE_LABELS: Record<string, string> = {
  BracketRight: "]",
  BracketLeft: "[",
  ArrowDown: "↓",
  ArrowUp: "↑",
  Enter: "Enter",
  Escape: "Esc",
  Tab: "Tab",
  Slash: "/",
  Comma: ",",
  Backspace: "⌫",
};

const codeLabel = (code: string): string =>
  CODE_LABELS[code] ?? (code.startsWith("Key") ? code.slice(3) : code.startsWith("Digit") ? code.slice(5) : code);

export const formatCombo = (k: KeyCombo, mac: boolean): string => {
  const key = codeLabel(k.code);
  if (mac) return `${k.ctrl ? "⌃" : ""}${k.mod ? "⌘" : ""}${k.alt ? "⌥" : ""}${k.shift ? "⇧" : ""}${key}`;
  const parts: string[] = [];
  if (k.ctrl || k.mod) parts.push("Ctrl");
  if (k.alt) parts.push("Alt");
  if (k.shift) parts.push("Shift");
  parts.push(key === "⌫" ? "Backspace" : key === "↓" ? "Down" : key === "↑" ? "Up" : key);
  return parts.join("+");
};

export const formatRow = (row: ShortcutRow, mac: boolean): string =>
  row.display ? (mac ? row.display.mac : row.display.other) : row.bindings.map((x) => formatCombo(x.key, mac)).join(" or ");

export const formatBinding = (id: ActionId, mac: boolean = isMacPlatform()): string =>
  formatCombo(bindingFor(id).key, mac);

export const isEditableTarget = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
};

/** True when the combo has no ⌘, ⌥ or ⌃. Such keys never fire from a text field unless allowed. */
export const isPlainCombo = (k: KeyCombo): boolean => !k.mod && !k.alt && !k.ctrl;

/**
 * The first action among `ids` whose binding the event matches. In a text field, plain keys (J, K,
 * Enter, ⇧Tab) are skipped unless `allowPlainInEditable` is set.
 */
export const matchAction = (
  e: KeyEventLike,
  ids: Iterable<ActionId>,
  mac: boolean,
  opts: { readonly editable?: boolean; readonly allowPlainInEditable?: boolean } = {},
): ActionId | undefined => {
  for (const id of ids) {
    const key = bindingFor(id).key;
    if (opts.editable && !opts.allowPlainInEditable && isPlainCombo(key)) continue;
    if (matchesCombo(e, key, mac)) return id;
  }
  return undefined;
};
