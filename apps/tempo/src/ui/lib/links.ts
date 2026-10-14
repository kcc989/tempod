import type { Project } from "@tempo/protocol";

/** URLs the UI builds. */

export const workspacePath = (workspaceId: string): string => `/w/${encodeURIComponent(workspaceId)}`;

/** Overflow menu → Copy workspace link. */
export const workspaceUrl = (workspaceId: string): string =>
  `${globalThis.location?.origin ?? ""}${workspacePath(workspaceId)}`;

/** 07: Open in Tempo for Mac. */
export const macWorkspaceUrl = (workspaceId: string): string =>
  `tempo://workspace/${encodeURIComponent(workspaceId)}`;

const gh = (owner: string, name: string) =>
  `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

export const githubRepoUrl = (owner: string, name: string): string => gh(owner, name);

export const githubBranchUrl = (owner: string, name: string, branch: string): string =>
  `${gh(owner, name)}/tree/${branch.split("/").map(encodeURIComponent).join("/")}`;

export const githubPullUrl = (owner: string, name: string, prNumber: number): string =>
  `${gh(owner, name)}/pull/${prNumber}`;

export const githubChecksUrl = (owner: string, name: string, prNumber: number): string =>
  `${githubPullUrl(owner, name, prNumber)}/checks`;

export const repositoryPath = (projectId: string, options: { ref?: string; pull?: number } = {}): string => {
  const search = new URLSearchParams({ project: projectId });

  if (options.ref) search.set("ref", options.ref);

  if (options.pull !== undefined) {
    search.set("tab", "pulls");
    search.set("pull", String(options.pull));
  }

  return `/repositories?${search}`;
};

export const projectPullUrl = (project: Project, number: number): string =>
  project.provider === "artifacts"
    ? repositoryPath(project.id, { pull: number })
    : githubPullUrl(project.owner, project.name, number);

export const projectChecksUrl = (project: Project, number: number): string =>
  project.provider === "artifacts"
    ? repositoryPath(project.id, { pull: number })
    : githubChecksUrl(project.owner, project.name, number);
