import { WORKSPACE_FNS, type FnName, type WorkspaceFnName } from "@tempo/protocol";
import * as conversations from "./handlers/conversations.ts";
import * as library from "./handlers/agent-library.ts";
import * as credentials from "./handlers/credentials.ts";
import * as environments from "./handlers/environments.ts";
import * as mcp from "./handlers/mcp.ts";
import * as projects from "./handlers/projects.ts";
import * as repositories from "./handlers/repositories.ts";
import * as issues from "./handlers/issues.ts";
import * as pullRequests from "./handlers/pull-requests.ts";
import {
  createSession,
  createWorkspace,
  listModels,
  listWorkspaces,
  viaWorkspace,
} from "./handlers/workspaces.ts";
import type { Handler } from "./run.ts";

type NonWorkspace = Exclude<FnName, WorkspaceFnName>;

const own = {
  createRepository: repositories.createRepository,
  importRepository: repositories.importRepository,
  linkArtifactRepository: repositories.linkArtifactRepository,
  getRepository: repositories.getRepository,
  getRepositoryFile: repositories.getRepositoryFile,
  listRepositoryCommits: repositories.listRepositoryCommits,
  listRepositoryPullRequests: pullRequests.listRepositoryPullRequests,
  getRepositoryPullRequest: pullRequests.getRepositoryPullRequest,
  createRepositoryPullRequest: pullRequests.createRepositoryPullRequest,
  updateRepositoryPullRequest: pullRequests.updateRepositoryPullRequest,
  listRepositoryIssues: issues.listRepositoryIssues,
  getRepositoryIssue: issues.getRepositoryIssue,
  createRepositoryIssue: issues.createRepositoryIssue,
  updateRepositoryIssue: issues.updateRepositoryIssue,
  listRepositoryIssueComments: issues.listRepositoryIssueComments,
  createRepositoryIssueComment: issues.createRepositoryIssueComment,
  updateRepositoryIssueComment: issues.updateRepositoryIssueComment,
  deleteRepositoryIssueComment: issues.deleteRepositoryIssueComment,
  listRepositoryLabels: issues.listRepositoryLabels,
  createRepositoryLabel: issues.createRepositoryLabel,
  updateRepositoryLabel: issues.updateRepositoryLabel,
  deleteRepositoryLabel: issues.deleteRepositoryLabel,
  listAgents: library.listAgents,
  getAgent: library.getAgent,
  saveAgent: library.saveAgent,
  deleteAgent: library.deleteAgent,
  listProjectAgents: library.listProjectAgents,
  putProjectAgent: library.putProjectAgent,
  deleteProjectAgent: library.deleteProjectAgent,
  listInstallationRepos: projects.listInstallationReposFn,
  listInstallations: projects.listInstallations,
  linkProject: projects.linkProject,
  listProjects: projects.listProjects,
  listProjectConversations: conversations.listProjectConversations,
  getProjectConversation: conversations.getProjectConversation,
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
  listModels,
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
  listMcpServers: mcp.listMcpServers,
  saveMcpServer: mcp.saveMcpServer,
  deleteMcpServer: mcp.deleteMcpServer,
} satisfies { [K in NonWorkspace]: Handler<K> };

/** One handler per function in the API contract (07, One handler per function). */
const workspaceHandlers = Object.fromEntries(WORKSPACE_FNS.map((name) => [name, viaWorkspace(name)]));

// SAFETY: WORKSPACE_FNS is exhaustive; viaWorkspace builds the handler for each selected key.
const workspace = workspaceHandlers as { [K in WorkspaceFnName]: Handler<K> };

export const HANDLERS = {
  ...own,
  ...workspace,
  createSession,
} satisfies { [K in FnName]: Handler<K> };
