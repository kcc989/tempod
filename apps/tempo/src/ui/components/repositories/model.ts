import { Match, Schema } from "effect";
import type { CiJob, CiRun, DeployTarget, Deployment, FnInput, RepositoryPullRequest } from "@tempo/protocol";

export const RepositoryTab = Schema.Literals(["code", "commits", "pulls", "issues", "checks", "deploys"]);

export type RepositoryTab = typeof RepositoryTab.Type;

export interface RepositorySearch {
  readonly project?: string;
  readonly ref?: string;
  readonly path?: string;
  readonly file?: string;
  readonly pull?: number;
  readonly issue?: number;
  readonly run?: string;
  readonly job?: string;
  readonly deployment?: string;
  readonly tab?: RepositoryTab;
}

export const isRepositoryTab = Schema.is(RepositoryTab);

export function repositorySearch(search: Schema.JsonObject): RepositorySearch {
  let result: RepositorySearch = {};

  for (const key of ["project", "ref", "path", "file", "run", "job", "deployment"] as const) {
    const value = search[key];

    if (Schema.is(Schema.String)(value) && value) Object.assign(result, { [key]: value });
  }

  for (const key of ["pull", "issue"] as const) {
    const rawNumber = search[key];
    let number = Number.NaN;

    if (Schema.is(Schema.Number)(rawNumber)) number = rawNumber;
    else if (Schema.is(Schema.String)(rawNumber)) number = Number(rawNumber);

    if (Number.isSafeInteger(number) && number > 0) Object.assign(result, { [key]: number });
  }

  if (isRepositoryTab(search["tab"])) result = { ...result, tab: search["tab"] };

  return result;
}

export function repositoryInput(projectId: string, ref?: string, path?: string): FnInput<"getRepository"> {
  let input: FnInput<"getRepository"> = { projectId };

  if (ref) input = { ...input, ref };

  if (path !== undefined) input = { ...input, path };

  return input;
}

export function repositoryCommitsInput(
  projectId: string,
  ref: string | undefined,
  offset: number,
): FnInput<"listRepositoryCommits"> {
  let input: FnInput<"listRepositoryCommits"> = { projectId, offset };

  if (ref) input = { ...input, ref };

  return input;
}

export const parentPath = (path: string): string => path.split("/").slice(0, -1).join("/");

/** 09, Web and Mac: refs to read a PR guide from, in order; the next is tried on NOT_FOUND. */
export function pullRequestGuideRefs(
  pull: Pick<RepositoryPullRequest, "state" | "headBranch" | "headSha">,
): string[] {
  const refs = Match.value(pull.state).pipe(
    Match.when("merged", () => [pull.headSha, pull.headBranch]),
    Match.when("closed", () => [pull.headBranch, pull.headSha]),
    Match.orElse(() => [pull.headBranch]),
  );

  return [...new Set(refs.flatMap((ref) => (ref ? [ref] : [])))];
}

export const repositoryFileSearch = (project: string, ref: string, file: string): RepositorySearch => ({
  project,
  tab: "code",
  ref,
  path: parentPath(file),
  file,
});

export const shortSha = (sha: string): string => sha.slice(0, 7);

export const commitTitle = (message: string): string => message.split("\n")[0] ?? message;

export function importUrlError(value: string): string | null {
  try {
    const url = new URL(value);

    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
      ? null
      : "Use an HTTPS Git URL without credentials.";
  } catch {
    return "Enter a valid HTTPS Git URL.";
  }
}

export const isSubmitShortcut = (
  event: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): boolean => event.code === "Enter" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;

/** A Badge variant. */
export type CiTone = "success" | "danger" | "muted" | "warning";

/** 10, Clients: one label and tone for a run or job; never "passed" before it completed. */
export interface CiStateLabel {
  readonly label: string;
  readonly tone: CiTone;
}

export function ciState(
  item: Pick<CiRun, "status" | "conclusion"> | Pick<CiJob, "status" | "conclusion">,
): CiStateLabel {
  if (item.status === "queued") return { label: "Queued", tone: "muted" };

  if (item.status === "running") return { label: "Running", tone: "warning" };

  switch (item.conclusion) {
    case "success":
      return { label: "Passed", tone: "success" };
    case "failure":
      return { label: "Failed", tone: "danger" };
    case "timed_out":
      return { label: "Timed out", tone: "danger" };
    case "cancelled":
      return { label: "Cancelled", tone: "muted" };
    case "skipped":
      return { label: "Skipped", tone: "muted" };
    default:
      return { label: "Completed", tone: "muted" };
  }
}

/** "1m 05s" from start to end (or now); empty before start. */
export function ciDuration(startedAt: number | null, completedAt: number | null, now = Date.now()): string {
  if (startedAt === null) return "";
  const seconds = Math.max(0, Math.round(((completedAt ?? now) - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);

  return minutes > 0 ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

export function ciRunsInput(projectId: string, branch: string | null, offset: number): FnInput<"listCiRuns"> {
  let input: FnInput<"listCiRuns"> = { projectId, offset };

  if (branch) input = { ...input, branch };

  return input;
}

/** The job whose log to show: the selected one, else the first that started. */
export function selectedJob(jobs: ReadonlyArray<CiJob>, key: string | undefined): CiJob | undefined {
  return jobs.find((job) => job.key === key) ?? jobs.find((job) => job.startedAt !== null) ?? jobs[0];
}

/** 12, Clients: never "succeeded" before the deployment completed. */
export function deployState(
  item: Pick<Deployment, "status" | "conclusion"> & { readonly rollout?: Deployment["rollout"] },
): CiStateLabel {
  if (item.status === "queued") return { label: "Queued", tone: "muted" };

  if (item.status === "running")
    return { label: item.rollout?.phase === "canary" ? "Canary" : "Running", tone: "warning" };

  switch (item.conclusion) {
    case "success":
      return { label: "Succeeded", tone: "success" };
    case "failure":
      return { label: "Failed", tone: "danger" };
    case "timed_out":
      return { label: "Timed out", tone: "danger" };
    case "cancelled":
      return { label: "Cancelled", tone: "muted" };
    default:
      return { label: "Completed", tone: "muted" };
  }
}

/** 12, Gradual rollout. */
export const ROLLOUT_PHASE_LABELS = {
  canary: "Canary at 10%",
  promoted: "Promoted to 100%",
  full: "Deployed at 100%",
  rolled_back: "Rolled back",
} as const;

/** Whether to offer Roll back. The server also checks that it is the target's newest success. */
export function canRollBack(item: Deployment): boolean {
  const rollout = item.rollout;

  return (
    item.status === "completed" &&
    item.conclusion === "success" &&
    rollout !== null &&
    rollout.rolledBackAt === null &&
    rollout.workers.length > 0 &&
    rollout.workers.every((w) => w.previousVersionId !== null)
  );
}

export function deploymentsInput(
  projectId: string,
  target: string | null,
  offset: number,
): FnInput<"listDeployments"> {
  let input: FnInput<"listDeployments"> = { projectId, offset };

  if (target) input = { ...input, target };

  return input;
}

/** A target with its own branch deploys only that branch; any other target needs a picked branch. */
export function deployInput(
  projectId: string,
  target: DeployTarget | undefined,
  branch: string | null,
): FnInput<"startDeployment"> | null {
  if (!target) return null;

  if (target.branch !== null) return { projectId, target: target.key };

  return branch ? { projectId, target: target.key, branch } : null;
}
