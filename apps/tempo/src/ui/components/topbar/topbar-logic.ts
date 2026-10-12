import type { PrState, WorkspaceDetail, WorkspaceState, WorkspaceSummary } from "@tempo/protocol";
import {
  isContainerUp,
  primaryAction,
  type PrimaryAction,
  type PrimaryActionKind,
} from "~/ui/lib/indicators";
import { githubBranchUrl, githubPullUrl, githubRepoUrl } from "~/ui/lib/links";
import type { ActionId } from "~/ui/lib/shortcuts";

export interface WorkspaceView {
  /** The newest summary fields, from the hub or the workspace channel. */
  readonly w: WorkspaceSummary;
  readonly d: WorkspaceDetail | null;
}

/** Joins the hub summary and the channel detail; whichever has the higher rev wins for summary fields. */
export const workspaceView = (
  summary: WorkspaceSummary | undefined,
  detail: WorkspaceDetail | null | undefined,
): WorkspaceView | null => {
  if (!detail) return summary ? { w: summary, d: null } : null;
  if (!summary || detail.rev >= summary.rev) return { w: detail, d: detail };
  return { w: summary, d: detail };
};

const isGone = (s: WorkspaceState): boolean => s === "archived" || s === "archiving";

const isPrOpen = (w: Pick<WorkspaceSummary, "prNumber" | "prState">): boolean =>
  w.prNumber !== null && (w.prState === "open" || w.prState === "draft");

const pushedOf = (v: WorkspaceView): boolean => v.d?.pushed ?? v.w.prNumber !== null;

/** 04, Primary action. `hasUnpushedCommits` is set by the DO for a dirty tree or local commits. */
export const topPrimary = (v: WorkspaceView): PrimaryAction | null => {
  if (isGone(v.w.state)) return null;
  return primaryAction({
    hasUncommitted: false,
    hasUnpushedCommits: v.d?.hasUnpushedCommits ?? false,
    pushed: pushedOf(v),
    prNumber: v.w.prNumber,
    prState: v.w.prState,
    checksState: v.w.checksState,
  });
};

/** 04, Primary action: View checks has no shortcut. */
export const PRIMARY_SHORTCUT: Record<PrimaryActionKind, ActionId | null> = {
  commitPush: "commitPush",
  createPr: "createPr",
  viewChecks: null,
  merge: "merge",
  archive: "archive",
};

/** The server accepts archive only from these states (otherwise WORKSPACE_BUSY). */
export const canArchive = (s: WorkspaceState): boolean =>
  s === "ready" || s === "working" || s === "sleeping" || s === "error";

export interface ShortcutAvailability {
  readonly commitPush: boolean;
  readonly createPr: boolean;
  readonly merge: boolean;
  readonly archive: boolean;
}

/** ⌥Y, ⌥P, ⌥M and ⌥A work whenever their own row of the primary-action table applies. */
export const shortcutAvailability = (v: WorkspaceView): ShortcutAvailability => {
  const gone = isGone(v.w.state);
  return {
    commitPush: !gone && (v.d?.hasUnpushedCommits ?? false) && isContainerUp(v.w.state),
    createPr: !gone && pushedOf(v) && v.w.prNumber === null,
    merge: !gone && isPrOpen(v.w),
    archive: canArchive(v.w.state),
  };
};

/** Commit and push needs a running container. */
export const primaryEnabled = (a: PrimaryAction, state: WorkspaceState): boolean =>
  a.kind === "commitPush" ? isContainerUp(state) : a.kind === "archive" ? canArchive(state) : true;

export interface PowerAction {
  readonly kind: "wake" | "sleep";
  readonly label: "Wake" | "Sleep";
  readonly enabled: boolean;
}

/** Overflow and hover card: Wake or Sleep. */
export const powerAction = (state: WorkspaceState): PowerAction => {
  switch (state) {
    case "sleeping":
    case "error":
      return { kind: "wake", label: "Wake", enabled: true };
    case "ready":
      return { kind: "sleep", label: "Sleep", enabled: true };
    case "working":
    case "setting_up":
    case "stopping":
      return { kind: "sleep", label: "Sleep", enabled: false };
    default:
      return { kind: "wake", label: "Wake", enabled: false };
  }
};

/** Open on GitHub: the PR, else the branch once pushed, else the repo. */
export const githubUrlFor = (
  project: { readonly owner: string; readonly name: string },
  w: Pick<WorkspaceSummary, "prNumber" | "branch">,
  pushed: boolean | undefined,
): string => {
  if (w.prNumber !== null) return githubPullUrl(project.owner, project.name, w.prNumber);
  if (pushed === false) return githubRepoUrl(project.owner, project.name);
  return githubBranchUrl(project.owner, project.name, w.branch);
};

export interface PrLink {
  readonly label: string;
  readonly url: string;
  readonly className: string;
  readonly ariaLabel: string;
}

const PR_LINK_CLASS: Record<PrState, string> = {
  open: "text-success",
  draft: "text-muted-foreground",
  merged: "text-merged",
  closed: "text-destructive",
};

/** 04 Top bar, left: `#<number> ↗` after the base branch, coloured by prState, to the PR on GitHub. */
export const prLink = (
  project: { readonly owner: string; readonly name: string } | undefined,
  w: Pick<WorkspaceSummary, "prNumber" | "prState">,
): PrLink | null => {
  if (!project || w.prNumber === null) return null;
  return {
    label: `#${w.prNumber} ↗`,
    url: githubPullUrl(project.owner, project.name, w.prNumber),
    className: w.prState ? PR_LINK_CLASS[w.prState] : "text-muted-foreground",
    ariaLabel: `Pull request #${w.prNumber}${w.prState ? `, ${w.prState}` : ""}. Opens on GitHub`,
  };
};

/** The title a rename should save, or null when nothing changes. */
export const renameValue = (next: string, current: string): string | null => {
  const t = next.trim().slice(0, 200);
  return t === "" || t === current ? null : t;
};

/** Branches the picker offers: never the workspace's own branch. */
export const baseBranchOptions = (
  branches: ReadonlyArray<{ readonly name: string }>,
  ownBranch: string,
): string[] => branches.map((b) => b.name).filter((n) => n !== ownBranch);
