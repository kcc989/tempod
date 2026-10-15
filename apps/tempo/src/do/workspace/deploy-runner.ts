import { deployLogKey, deployRunnerName, type DeployJobStart } from "../../deploy/types.ts";
import type { WorkspaceCore } from "./core.ts";
import { cancelJob, jobAlarm, jobLog, runnerJob, startJob, type RunnerKind } from "./job-runner.ts";

/** 12, Execution: a deployment runs like a CI job. */
export const DEPLOY_RUNNER: RunnerKind<DeployJobStart> = {
  key: "deploy",
  label: "deploy",
  noun: "deployment",
  name: (job) => deployRunnerName(job.deploymentId),
  logKey: (job) => deployLogKey(job.projectId, job.deploymentId),
  report: (core, job, outcome) =>
    core.deployCoordinator(job.projectId).deploymentFinished({
      deploymentId: job.deploymentId,
      token: job.token,
      ...outcome,
    }),
  stopped: "The deploy container stopped.",
  notStarted: "The deploy container did not start.",
  timedOut: "The deployment ran out of time.",
};

export const deployJob = (core: WorkspaceCore): DeployJobStart | undefined => runnerJob(core, DEPLOY_RUNNER);

export const deployStart = (core: WorkspaceCore, input: DeployJobStart): Promise<void> =>
  startJob(core, DEPLOY_RUNNER, input);

export const deployCancel = (core: WorkspaceCore, token: string): Promise<void> =>
  cancelJob(core, DEPLOY_RUNNER, token);

export const deployLog = (
  core: WorkspaceCore,
  token: string,
): Promise<{ text: string; truncated: boolean }> => jobLog(core, DEPLOY_RUNNER, token);

export const deployAlarm = (core: WorkspaceCore): Promise<void> => jobAlarm(core, DEPLOY_RUNNER);
