import { WORKSPACE_FNS, type FnName, type WorkspaceFnName } from "@tempo/protocol";
import * as credentials from "./handlers/credentials.ts";
import * as projects from "./handlers/projects.ts";
import { createWorkspace, listModels, listWorkspaces, viaWorkspace } from "./handlers/workspaces.ts";
import type { Handler } from "./run.ts";

type NonWorkspace = Exclude<FnName, WorkspaceFnName>;

const own: { [K in NonWorkspace]: Handler<K> } = {
  listInstallationRepos: projects.listInstallationReposFn,
  listInstallations: projects.listInstallations,
  linkProject: projects.linkProject,
  listProjects: projects.listProjects,
  updateProjectSettings: projects.updateProjectSettings,
  unlinkProject: projects.unlinkProject,
  listBranches: projects.listBranches,
  listOpenPullRequests: projects.listOpenPullRequests,
  createWorkspace,
  listWorkspaces,
  listModels,
  getCredentialStatus: credentials.getCredentialStatus,
  setClaudeToken: credentials.setClaudeToken,
  setCodexAuth: credentials.setCodexAuth,
  setApiKey: credentials.setApiKey,
  deleteCredential: credentials.deleteCredential,
  setProjectSecret: credentials.setProjectSecret,
  deleteProjectSecret: credentials.deleteProjectSecret,
  listProjectSecretNames: credentials.listProjectSecretNames,
};

/** One handler per function in the API contract (07, One handler per function). */
export const HANDLERS = {
  ...own,
  ...Object.fromEntries(WORKSPACE_FNS.map((n) => [n, viaWorkspace(n)])),
} as { [K in FnName]: Handler<K> };
