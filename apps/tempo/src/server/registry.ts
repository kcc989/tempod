import { WORKSPACE_FNS, type FnName, type WorkspaceFnName } from "@tempo/protocol";
import * as credentials from "./handlers/credentials.ts";
import * as environments from "./handlers/environments.ts";
import * as projects from "./handlers/projects.ts";
import { createWorkspace, listWorkspaces, viaWorkspace } from "./handlers/workspaces.ts";
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
  setProjectEnvironment: environments.setProjectEnvironment,
  listEnvironments: environments.listEnvironments,
  createEnvironment: environments.createEnvironment,
  updateEnvironment: environments.updateEnvironment,
  deleteEnvironment: environments.deleteEnvironment,
  setEnvironmentSecret: environments.setEnvironmentSecret,
  deleteEnvironmentSecret: environments.deleteEnvironmentSecret,
  createWorkspace,
  listWorkspaces,
  getCredentialStatus: credentials.getCredentialStatus,
  setClaudeToken: credentials.setClaudeToken,
  setCodexAuth: credentials.setCodexAuth,
  startCodexLogin: credentials.startCodexLogin,
  pollCodexLogin: credentials.pollCodexLogin,
  cancelCodexLogin: credentials.cancelCodexLogin,
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
