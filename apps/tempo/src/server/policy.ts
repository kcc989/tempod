import type { FnName, WorkspaceFnName } from "@tempo/protocol";

/** Functions that run without a session (11, Function access, policy `public`). */
export const PUBLIC_FNS = [
  "getProject",
  "listNamespaceProjects",
  "exploreProjects",
  "getRepository",
  "getRepositoryFile",
  "listRepositoryCommits",
  "listBranches",
  "listOpenPullRequests",
  "listRepositoryPullRequests",
  "getRepositoryPullRequest",
  "listRepositoryIssues",
  "getRepositoryIssue",
  "listRepositoryIssueComments",
  "listRepositoryLabels",
] as const satisfies ReadonlyArray<FnName>;

export type PublicFnName = (typeof PUBLIC_FNS)[number];

export const isPublicFn = (name: FnName): name is PublicFnName => PUBLIC_FNS.some((n) => n === name);

/** The GitHub App and its installations belong to the deployment, so only its admin uses them (11). */
export const INSTANCE_ADMIN_FNS: ReadonlySet<FnName> = new Set([
  "linkArtifactRepository",
  "setClaudeToken",
  "listInstallations",
  "listInstallationRepos",
  "linkProject",
]);

/** Workspace functions that need only ownership, so a user who lost `write` can clean up (11). */
export const CLEANUP_WORKSPACE_FNS: ReadonlySet<WorkspaceFnName> = new Set([
  "getWorkspace",
  "markViewed",
  "setPinned",
  "sleepWorkspace",
  "archiveWorkspace",
  "deleteWorkspace",
  "cancelTurn",
  "cancelRun",
  "stopScript",
]);
