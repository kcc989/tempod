import {
  instanceLabel,
  type Instance,
  type OpProgress,
  type WorkspaceState,
  type WorkspaceSummary,
} from "@tempo/protocol";

export type IndicatorKind = "needs_input" | "error" | "working" | "unread" | "busy" | "sleeping";

export interface Indicator {
  readonly kind: IndicatorKind;
  readonly tooltip: string;
}

/** 04, Indicators: first match wins; attention wins over state. */
export const statusIndicator = (
  s: Pick<WorkspaceSummary, "attention" | "state">,
  op?: OpProgress | null,
): Indicator | null => {
  if (s.attention === "needs_input") return { kind: "needs_input", tooltip: "Waiting for you" };

  if (s.attention === "error") return { kind: "error", tooltip: "Needs attention" };

  if (s.state === "working") return { kind: "working", tooltip: "Working" };

  if (s.attention === "unread") return { kind: "unread", tooltip: "New activity" };

  if (
    s.state === "creating" ||
    s.state === "starting" ||
    s.state === "setting_up" ||
    s.state === "stopping"
  ) {
    return { kind: "busy", tooltip: pillText(s.state, { op: op ?? null }).text };
  }

  if (s.state === "sleeping") return { kind: "sleeping", tooltip: "Sleeping" };

  return null;
};

const STEP_LABELS = {
  "container.start": "Starting container",
  "tempod.connect": "Connecting",
  "repo.clone": "Cloning repo",
  "repo.applyCheckpoint": "Restoring checkpoint",
  "home.restore": "Restoring home",
  "settings.read": "Reading settings",
  "setup.run": "Running setup",
  "sessions.markReload": "Reloading sessions",
  "turns.check": "Checking turns",
  "turns.cancel": "Stopping turns",
  "script.archive": "Running archive script",
  "git.checkpoint": "Saving checkpoint",
  "bundle.upload": "Uploading checkpoint",
  "home.backup": "Backing up home",
  "tempod.shutdown": "Stopping agents",
  "container.snapshot": "Saving snapshot",
  "container.destroy": "Stopping container",
  "github.deleteBranch": "Deleting branch",
  "branch.check": "Checking branch",
  "git.revert": "Reverting files",
  "transcript.mark": "Updating transcript",
  "git.commitAndPush": "Committing and pushing",
  "events.prune": "Pruning events",
  "r2.retention": "Cleaning up storage",
  "egress.trim": "Trimming egress log",
} satisfies Record<string, string>;

export const stepLabel = (step: string): string => {
  const known = Object.entries(STEP_LABELS).find(([key]) => key === step)?.[1];

  if (known) return known;

  const words = step
    .replace(/[._]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();

  return words ? words[0]!.toUpperCase() + words.slice(1) : step;
};

export interface Pill {
  readonly text: string;
  readonly tone: "default" | "muted" | "error" | "busy";
}

/** 04, Container pill. */
export const pillText = (
  state: WorkspaceState,
  ctx: { readonly op: OpProgress | null; readonly instance?: Instance | undefined },
): Pill => {
  switch (state) {
    case "starting": {
      const step = ctx.op?.step ? ` ${stepLabel(ctx.op.step)}` : "";

      return { text: `Starting…${step}`, tone: "busy" };
    }

    case "setting_up":
      return { text: "Running setup", tone: "busy" };
    case "ready":
    case "working":
      return { text: ctx.instance ? `Running · ${instanceLabel(ctx.instance)}` : "Running", tone: "default" };
    case "stopping":
      return { text: "Going to sleep", tone: "busy" };
    case "sleeping":
      return { text: "Sleeping", tone: "muted" };
    case "error":
      return { text: "Error", tone: "error" };
    case "creating":
      return { text: "Creating", tone: "busy" };
    case "archiving":
      return { text: "Archiving", tone: "busy" };
    case "archived":
      return { text: "Archived", tone: "muted" };
  }
};

/** The container is up and answers read calls. */
export const isContainerUp = (state: WorkspaceState): boolean =>
  state === "ready" || state === "working" || state === "setting_up";

export type PrimaryActionKind = "commitPush" | "createPr" | "viewChecks" | "merge" | "archive";

export interface PrimaryAction {
  readonly kind: PrimaryActionKind;
  readonly label: string;
}

export interface PrimaryActionInput {
  readonly hasUncommitted: boolean;
  readonly hasUnpushedCommits: boolean;
  readonly pushed: boolean;
  readonly prNumber: number | null;
  readonly prState: WorkspaceSummary["prState"];
  readonly checksState: WorkspaceSummary["checksState"];
}

/** 04, Primary action: the first row that applies. */
export const primaryAction = (i: PrimaryActionInput): PrimaryAction | null => {
  if (i.hasUncommitted || i.hasUnpushedCommits) return { kind: "commitPush", label: "Commit and push" };
  const prOpen = i.prNumber !== null && (i.prState === "open" || i.prState === "draft");

  if (i.pushed && i.prNumber === null) return { kind: "createPr", label: "Create PR" };

  if (prOpen && i.checksState === "failure") return { kind: "viewChecks", label: "View checks" };

  if (prOpen) return { kind: "merge", label: "Merge" };

  if (i.prNumber !== null && (i.prState === "merged" || i.prState === "closed")) {
    return { kind: "archive", label: "Archive" };
  }

  return null;
};

export const countsForTitle = (summaries: Iterable<Pick<WorkspaceSummary, "attention">>): number => {
  let n = 0;

  for (const s of summaries) if (s.attention !== "none") n++;

  return n;
};

export const titleFor = (n: number): string => (n > 0 ? `(${n}) Tempo` : "Tempo");
