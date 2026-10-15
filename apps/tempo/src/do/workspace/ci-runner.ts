import { ciLogKey, ciRunnerName, type CiJobStart } from "../../ci/types.ts";
import type { WorkspaceCore } from "./core.ts";
import {
  JOB_TICK_MS,
  cancelJob,
  jobAlarm,
  jobLog,
  runnerJob,
  startJob,
  type RunnerKind,
} from "./job-runner.ts";

/** 10, Execution: the runner checks its job every 30 seconds. */
export const CI_TICK_MS = JOB_TICK_MS;

export const CI_RUNNER: RunnerKind<CiJobStart> = {
  key: "ci",
  label: "ci",
  noun: "job",
  name: (job) => ciRunnerName(job.runId, job.jobKey),
  logKey: (job) => ciLogKey(job.projectId, job.runId, job.jobKey),
  report: (core, job, outcome) =>
    core.ciCoordinator(job.projectId).jobFinished({
      runId: job.runId,
      jobKey: job.jobKey,
      token: job.token,
      ...outcome,
    }),
  stopped: "The CI container stopped.",
  notStarted: "The CI container did not start.",
  timedOut: "The job ran out of time.",
};

export const ciJob = (core: WorkspaceCore): CiJobStart | undefined => runnerJob(core, CI_RUNNER);

export const ciStart = (core: WorkspaceCore, input: CiJobStart): Promise<void> =>
  startJob(core, CI_RUNNER, input);

export const ciCancel = (core: WorkspaceCore, token: string): Promise<void> =>
  cancelJob(core, CI_RUNNER, token);

export const ciLog = (core: WorkspaceCore, token: string): Promise<{ text: string; truncated: boolean }> =>
  jobLog(core, CI_RUNNER, token);

export const ciAlarm = (core: WorkspaceCore): Promise<void> => jobAlarm(core, CI_RUNNER);
