import { WORKSPACE_FNS, type FnName, type WorkspaceFnName } from "@tempo/protocol";
import * as conversations from "./handlers/conversations.ts";
import * as library from "./handlers/agent-library.ts";
import * as credentials from "./handlers/credentials.ts";
import * as dotfiles from "./handlers/dotfiles.ts";
import * as environments from "./handlers/environments.ts";
import * as mcp from "./handlers/mcp.ts";
import * as modelList from "./handlers/model-list.ts";
import * as projects from "./handlers/projects.ts";
import * as repositories from "./handlers/repositories.ts";
import * as issues from "./handlers/issues.ts";
import * as pullRequests from "./handlers/pull-requests.ts";
import * as ci from "./handlers/ci.ts";
import * as judge from "./handlers/judge.ts";
import * as loop from "./handlers/loop.ts";
import * as projectProfile from "./handlers/project-profile.ts";
import * as deploy from "./handlers/deploy.ts";
import * as profile from "./handlers/profile.ts";
import {
  createSession,
  createWorkspace,
  listModels,
  listWorkspaces,
  viaWorkspace,
} from "./handlers/workspaces.ts";
import type { VisitorFnName } from "./policy.ts";
import type { Handler, VisitorHandler } from "./run.ts";

type NonWorkspace = Exclude<FnName, WorkspaceFnName | VisitorFnName>;

/** Functions that also run without a session (11, Function access). */
const visitor = {
  getProfile: profile.getProfile,
  listProfileProjects: profile.listProfileProjects,
  getPublicProject: profile.getPublicProject,
  getRepository: repositories.getRepository,
  getRepositoryFile: repositories.getRepositoryFile,
  listRepositoryCommits: repositories.listRepositoryCommits,
  listBranches: projects.listBranches,
} satisfies { [K in VisitorFnName]: VisitorHandler<K> };

const own = {
  createRepository: repositories.createRepository,
  importRepository: repositories.importRepository,
  linkArtifactRepository: repositories.linkArtifactRepository,
  listRepositoryPullRequests: pullRequests.listRepositoryPullRequests,
  getRepositoryPullRequest: pullRequests.getRepositoryPullRequest,
  createRepositoryPullRequest: pullRequests.createRepositoryPullRequest,
  updateRepositoryPullRequest: pullRequests.updateRepositoryPullRequest,
  getCiPipeline: ci.getCiPipeline,
  updateCiPipeline: ci.updateCiPipeline,
  listCiRuns: ci.listCiRuns,
  getCiRun: ci.getCiRun,
  startCiRun: ci.startCiRun,
  rerunCiRun: ci.rerunCiRun,
  cancelCiRun: ci.cancelCiRun,
  getCiJobLog: ci.getCiJobLog,
  getDeploySettings: deploy.getDeploySettings,
  updateDeploySettings: deploy.updateDeploySettings,
  deleteDeploySettings: deploy.deleteDeploySettings,
  getDeployConfig: deploy.getDeployConfig,
  updateDeployConfig: deploy.updateDeployConfig,
  listDeployments: deploy.listDeployments,
  getDeployment: deploy.getDeployment,
  startDeployment: deploy.startDeployment,
  redeploy: deploy.redeploy,
  cancelDeployment: deploy.cancelDeployment,
  rollbackDeployment: deploy.rollbackDeployment,
  getJudgeSettings: judge.getJudgeSettings,
  getLoopReport: loop.getLoopReport,
  getProjectProfile: projectProfile.getProjectProfile,
  updateProjectProfile: projectProfile.updateProjectProfile,
  setJudgeKey: judge.setJudgeKey,
  deleteJudgeKey: judge.deleteJudgeKey,
  listProductionErrors: deploy.listProductionErrors,
  startErrorFix: deploy.startErrorFix,
  getIssuesWebhook: deploy.getIssuesWebhook,
  rotateIssuesWebhook: deploy.rotateIssuesWebhook,
  getDeploymentLog: deploy.getDeploymentLog,
  listRepositoryIssues: issues.listRepositoryIssues,
  getRepositoryIssue: issues.getRepositoryIssue,
  createRepositoryIssue: issues.createRepositoryIssue,
  updateRepositoryIssue: issues.updateRepositoryIssue,
  deleteRepositoryIssue: issues.deleteRepositoryIssue,
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
  listOpenPullRequests: projects.listOpenPullRequests,
  setProjectEnvironment: environments.setProjectEnvironment,
  setProjectVisibility: profile.setProjectVisibility,
  setProjectPinned: profile.setProjectPinned,
  listEnvironments: environments.listEnvironments,
  createEnvironment: environments.createEnvironment,
  updateEnvironment: environments.updateEnvironment,
  deleteEnvironment: environments.deleteEnvironment,
  setEnvironmentSecret: environments.setEnvironmentSecret,
  deleteEnvironmentSecret: environments.deleteEnvironmentSecret,
  getDotfiles: dotfiles.getDotfiles,
  updateDotfiles: dotfiles.updateDotfiles,
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
  getModelList: modelList.getModelList,
  setModelList: modelList.setModelList,
  saveMcpServer: mcp.saveMcpServer,
  deleteMcpServer: mcp.deleteMcpServer,
} satisfies { [K in NonWorkspace]: Handler<K> };

/** One handler per function in the API contract (07, One handler per function). */
const workspaceHandlers = Object.fromEntries(WORKSPACE_FNS.map((name) => [name, viaWorkspace(name)]));

// SAFETY: WORKSPACE_FNS is exhaustive; viaWorkspace builds the handler for each selected key.
const workspace = workspaceHandlers as { [K in WorkspaceFnName]: Handler<K> };

export const HANDLERS = {
  ...visitor,
  ...own,
  ...workspace,
  createSession,
} satisfies { [K in FnName]: Handler<K> };
