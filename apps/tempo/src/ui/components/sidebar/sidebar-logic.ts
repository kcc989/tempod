import type { Attention, ChecksState, PrState, WorkspaceSummary } from "@tempo/protocol";
import type { SidebarSection, SortMode } from "~/ui/stores/hub-state";

/** localStorage keys (prefixed with "tempo:" by the storage helper). */
export const SORT_KEY = "sidebar:sort";
export const COLLAPSED_KEY = "sidebar:collapsed";

export const DEFAULT_SORT: SortMode = "activity";
export const NO_COLLAPSED: ReadonlyArray<string> = [];

export const isSortMode = (u: unknown): u is SortMode => u === "activity" || u === "created";

export const isStringList = (u: unknown): u is ReadonlyArray<string> =>
  Array.isArray(u) && u.every((x) => typeof x === "string");

export const SORT_LABELS: Record<SortMode, string> = {
  activity: "Last activity",
  created: "Created",
};

export const toggleCollapsed = (list: ReadonlyArray<string>, key: string): ReadonlyArray<string> =>
  list.includes(key) ? list.filter((k) => k !== key) : [...list, key];

/** Rows in sidebar order, leaving out collapsed sections. ⌥1–⌥9 and ⌥↑/⌥↓ follow it. */
export const visibleOrder = (
  sections: ReadonlyArray<SidebarSection>,
  collapsed: ReadonlyArray<string>,
): WorkspaceSummary[] => sections.flatMap((s) => (collapsed.includes(s.key) ? [] : s.workspaces));

/** Every row in sidebar order, collapsed sections included. */
export const fullOrder = (sections: ReadonlyArray<SidebarSection>): WorkspaceSummary[] =>
  sections.flatMap((s) => s.workspaces);

/** ⌥↓ / ⌥↑: the next or previous id, wrapping. With no current row, the first or the last. */
export const stepWorkspace = (
  ids: ReadonlyArray<string>,
  current: string | null,
  delta: 1 | -1,
): string | null => {
  if (ids.length === 0) return null;
  const i = current === null ? -1 : ids.indexOf(current);
  if (i < 0) return delta === 1 ? ids[0]! : ids[ids.length - 1]!;
  return ids[(i + delta + ids.length) % ids.length]!;
};

const needsYouRank = (a: Attention): number => {
  if (a === "needs_input" || a === "error") return 2;
  if (a === "unread") return 1;
  return 0;
};

/**
 * ⌥G: the next row after the current one (wrapping) that needs you. Waiting for input and errors
 * come before unread activity.
 */
export const nextNeedingYou = (
  order: ReadonlyArray<Pick<WorkspaceSummary, "id" | "attention">>,
  current: string | null,
): string | null => {
  let best = 0;
  for (const w of order) if (w.id !== current) best = Math.max(best, needsYouRank(w.attention));
  if (best === 0) return null;
  const start = current === null ? -1 : order.findIndex((w) => w.id === current);
  for (let k = 1; k <= order.length; k++) {
    const w = order[(start + k + order.length) % order.length]!;
    if (w.id !== current && needsYouRank(w.attention) === best) return w.id;
  }
  return null;
};

export type PrBadgeVariant = "success" | "muted" | "merged" | "danger";

/** 04: open green, draft grey, merged purple, closed red. */
export const prBadgeVariant = (s: PrState | null): PrBadgeVariant => {
  switch (s) {
    case "open":
      return "success";
    case "merged":
      return "merged";
    case "closed":
      return "danger";
    default:
      return "muted";
  }
};

export const PR_STATE_LABELS: Record<PrState, string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

/** 04: pending amber, success green, failure red. */
export const CHECKS_DOT_CLASS: Record<ChecksState, string> = {
  pending: "bg-warning",
  success: "bg-success",
  failure: "bg-destructive",
};

export const CHECKS_LABELS: Record<ChecksState, string> = {
  pending: "Checks running",
  success: "Checks passed",
  failure: "Checks failed",
};

export const isBold = (w: Pick<WorkspaceSummary, "attention">): boolean =>
  w.attention === "unread" || w.attention === "needs_input";

export const projectLabel = (p: { readonly owner: string; readonly name: string }): string =>
  `${p.owner}/${p.name}`;
