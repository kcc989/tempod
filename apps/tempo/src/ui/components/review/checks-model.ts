import type { CheckRun, ChecksState, PrState } from "@tempo/protocol";

/** 04, Checks tab: PR state, the overall checks state and one row per check run. */

export type Tone = "success" | "danger" | "warning" | "muted" | "merged";

export interface StateLabel {
  readonly label: string;
  readonly tone: Tone;
}

export const prStateLabel = (state: PrState | null): StateLabel | null => {
  switch (state) {
    case "open":
      return { label: "Open", tone: "success" };
    case "draft":
      return { label: "Draft", tone: "muted" };
    case "merged":
      return { label: "Merged", tone: "merged" };
    case "closed":
      return { label: "Closed", tone: "danger" };
    default:
      return null;
  }
};

export const checksStateLabel = (state: ChecksState | null): StateLabel | null => {
  switch (state) {
    case "pending":
      return { label: "Checks running", tone: "warning" };
    case "success":
      return { label: "Checks passed", tone: "success" };
    case "failure":
      return { label: "Checks failed", tone: "danger" };
    default:
      return null;
  }
};

export type RunOutcome = "success" | "failure" | "pending" | "neutral";

const FAILED = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure"]);

/** 03, Status polling: queued or in progress is pending; these conclusions are failures. */
export const runOutcome = (run: Pick<CheckRun, "status" | "conclusion">): RunOutcome => {
  if (run.status !== "completed" || run.conclusion === null) return "pending";

  if (FAILED.has(run.conclusion)) return "failure";

  if (run.conclusion === "success") return "success";

  return "neutral";
};

const words = (s: string): string => {
  const t = s.replace(/_/g, " ");

  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** The conclusion, or the status while the run is not done. */
export const runLabel = (run: Pick<CheckRun, "status" | "conclusion">): string =>
  run.status === "completed" && run.conclusion !== null ? words(run.conclusion) : words(run.status);

const ORDER: Record<RunOutcome, number> = { failure: 0, pending: 1, success: 2, neutral: 3 };

/** Failures first, then running checks, then the rest; by name within each. */
export const sortRuns = (runs: ReadonlyArray<CheckRun>): CheckRun[] =>
  [...runs].sort(
    (a, b) => ORDER[runOutcome(a)] - ORDER[runOutcome(b)] || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
