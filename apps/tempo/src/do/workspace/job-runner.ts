import { Schema } from "effect";
import { DEFAULT_SETTINGS, TempoError, newId, randomToken, type TempodEvent } from "@tempo/protocol";
import { lifecycleRedactor } from "../../agents/secrets.ts";
import { CI_LOG_DROPPED, keepTail } from "../../ci/types.ts";
import { errorText, log } from "../../log.ts";
import { waitHealthy } from "./container.ts";
import type { WorkspaceCore } from "./core.ts";
import { TempodClient, openTempodSocket } from "./tempod-client.ts";

/** 10 and 12, Execution: a runner checks its job every 30 seconds. */
export const JOB_TICK_MS = 30_000;

/** A job that has not finished by its timeout plus this is stopped (10, 12). */
const JOB_GRACE_MS = 5 * 60_000;

/** What every runner job carries: one checkout and one command in one container. */
export interface RunnerJob {
  readonly token: string;
  readonly userId: string;
  readonly projectId: string;
  readonly repoName: string;
  readonly cloneUrl: string;
  readonly branch: string;
  readonly sha: string;
  readonly command: string;
  readonly timeoutMinutes: number;
  readonly egressAllowlist: ReadonlyArray<string>;
}

export interface JobOutcome {
  readonly conclusion: "success" | "failure" | "timed_out";
  readonly exitCode: number | null;
  readonly summary: string | null;
}

/** One kind of runner: a CI job (10) or a deployment (12). */
export interface RunnerKind<J extends RunnerJob> {
  /** Prefix of the runner's DO name and its kv keys. */
  readonly key: "ci" | "deploy";
  readonly label: string;
  readonly noun: "job" | "deployment";
  readonly name: (job: J) => string;
  readonly logKey: (job: J) => string;
  readonly report: (core: WorkspaceCore, job: J, outcome: JobOutcome) => Promise<void>;
  readonly stopped: string;
  readonly notStarted: string;
  readonly timedOut: string;
}

export interface JobState<J extends RunnerJob> {
  readonly job: J;
  readonly phase: "pending" | "running" | "done";
  readonly scriptRunId: string;
  readonly deadline: number;
  readonly result: JobOutcome | null;
  readonly reported: boolean;
}

export const runnerJob = <J extends RunnerJob>(core: WorkspaceCore, kind: RunnerKind<J>): J | undefined =>
  state(core, kind)?.job;

const state = <J extends RunnerJob>(core: WorkspaceCore, kind: RunnerKind<J>): JobState<J> | undefined =>
  core.kv<JobState<J>>(`${kind.key}Runner`);

const toJson = Schema.decodeUnknownSync(Schema.Json);

const save = <J extends RunnerJob>(core: WorkspaceCore, kind: RunnerKind<J>, next: JobState<J>): void => {
  core.setKv(`${kind.key}Runner`, toJson(next));
  core.setKv(`${kind.key}Job`, toJson(next.job));
};

const tick = (core: WorkspaceCore, at = Date.now() + JOB_TICK_MS) => core.ctx.storage.setAlarm(at);

/** Starts one job. Repeating the same token does nothing. */
export const startJob = async <J extends RunnerJob>(
  core: WorkspaceCore,
  kind: RunnerKind<J>,
  input: J,
): Promise<void> => {
  if (core.ctx.id.name !== kind.name(input) || core.wsOrNull()) throw new TempoError("NOT_FOUND");
  const current = state(core, kind);

  if (current?.job.token === input.token) return;

  if (current && current.phase !== "done") await stopContainer(core, kind);
  core.setKv(`${kind.key}Log`, "");
  core.setKv(`${kind.key}LogCut`, false);
  core.setKv(`${kind.key}Seq`, 0);
  core.setKv(`${kind.key}Incarnation`, null);
  save(core, kind, {
    job: input,
    phase: "pending",
    scriptRunId: newId(),
    deadline: Date.now() + input.timeoutMinutes * 60_000 + JOB_GRACE_MS,
    result: null,
    reported: false,
  });
  await tick(core, Date.now());
};

/** Stops the job without a report: the coordinator already recorded the cancel. */
export const cancelJob = async <J extends RunnerJob>(
  core: WorkspaceCore,
  kind: RunnerKind<J>,
  token: string,
): Promise<void> => {
  const current = state(core, kind);

  if (!current || current.job.token !== token) return;

  if (current.phase !== "done") save(core, kind, { ...current, phase: "done", reported: true });
  await stopContainer(core, kind);
  await core.ctx.storage.deleteAlarm();
};

/** The live log tail, redacted (10 and 12, Logs). */
export const jobLog = async <J extends RunnerJob>(
  core: WorkspaceCore,
  kind: RunnerKind<J>,
  token: string,
): Promise<{ text: string; truncated: boolean }> => {
  const current = state(core, kind);

  if (!current || current.job.token !== token) throw new TempoError("NOT_FOUND");
  const cut = core.kv<boolean>(`${kind.key}LogCut`) ?? false;
  const redact = await lifecycleRedactor(core);

  return {
    text: redact(`${cut ? CI_LOG_DROPPED : ""}${core.kv<string>(`${kind.key}Log`) ?? ""}`),
    truncated: cut,
  };
};

/** The runner alarm (10 and 12, Execution). */
export const jobAlarm = async <J extends RunnerJob>(
  core: WorkspaceCore,
  kind: RunnerKind<J>,
): Promise<void> => {
  const current = state(core, kind);

  if (!current) return;

  if (current.phase === "done") {
    if (!current.reported) await report(core, kind, current);

    if (!state(core, kind)?.reported) await tick(core);

    return;
  }

  if (current.phase === "pending") {
    await launch(core, kind, current);
  } else if (Date.now() > current.deadline) {
    await finish(core, kind, { conclusion: "timed_out", exitCode: null, summary: kind.timedOut });
  } else if (!core.tempod?.open) {
    if (core.container?.running) {
      try {
        await connect(core, kind, current);
      } catch (e) {
        log("warn", `${kind.label} runner reconnect failed`, {
          runner: core.ctx.id.name,
          error: errorText(e),
        });
      }
    } else {
      await finish(core, kind, { conclusion: "failure", exitCode: null, summary: kind.stopped });
    }
  }

  const latest = state(core, kind);

  if (latest?.phase !== "done" || !latest.reported) await tick(core);
};

const launch = async <J extends RunnerJob>(
  core: WorkspaceCore,
  kind: RunnerKind<J>,
  current: JobState<J>,
): Promise<void> => {
  const container = core.container;
  const { job } = current;

  if (!container) {
    await finish(core, kind, { conclusion: "failure", exitCode: null, summary: kind.notStarted });

    return;
  }

  try {
    if (container.running) await container.destroy();
    core.setKv(`${kind.key}Token`, randomToken(32));
    container.start({
      image: container.images["workspace"] ?? "workspace",
      instance: DEFAULT_SETTINGS.environment.instance,
      enableInternet: false,
      env: {
        TEMPOD_TOKEN: core.kv<string>(`${kind.key}Token`)!,
        TEMPOD_PORT: "7070",
        TEMPO_WORKSPACE_ID: core.ctx.id.name!,
      },
      labels: { purpose: kind.key },
    });

    const outbound = core.ctx.exports.TempoOutbound({
      props: {
        workspaceId: core.ctx.id.name!,
        userId: job.userId,
        ...(kind.key === "ci" ? { ci: true } : { deploy: true }),
      },
    });

    await container.interceptAllOutboundHttp(outbound);
    await container.interceptOutboundHttps("*", outbound);
    await container.setInactivityTimeout(job.timeoutMinutes * 60_000 + 2 * JOB_GRACE_MS);
    await waitHealthy(core, AbortSignal.timeout(90_000));
  } catch (e) {
    log("warn", `${kind.label} container start failed`, { runner: core.ctx.id.name, error: errorText(e) });
    await finish(core, kind, { conclusion: "failure", exitCode: null, summary: kind.notStarted });

    return;
  }

  try {
    const client = await connect(core, kind, current);
    await client.request("ci.checkout", { url: job.cloneUrl, branch: job.branch, sha: job.sha });
    await client.request("script.start", {
      runId: current.scriptRunId,
      kind: "run",
      scriptId: kind.key,
      command: job.command,
      cwd: "",
      timeoutMs: job.timeoutMinutes * 60_000,
    });
    const latest = state(core, kind);

    if (latest?.job.token === job.token && latest.phase === "pending")
      save(core, kind, { ...latest, phase: "running" });
  } catch (e) {
    const detail = e instanceof TempoError ? (e.detail ?? e.message) : "tempod did not answer.";

    const summary =
      e instanceof TempoError && e.code === "CLONE_FAILED"
        ? `Could not check out ${job.sha.slice(0, 7)}: ${detail.slice(0, 300)}`
        : `The ${kind.noun} did not start: ${detail.slice(0, 300)}`;

    await finish(core, kind, { conclusion: "failure", exitCode: null, summary });
  }
};

const connect = async <J extends RunnerJob>(
  core: WorkspaceCore,
  kind: RunnerKind<J>,
  current: JobState<J>,
): Promise<TempodClient> => {
  const socket = await openTempodSocket(core);

  const client = new TempodClient(
    core,
    socket,
    () => undefined,
    (c) => {
      if (core.tempod === c) core.tempod = null;
    },
    {
      onEvent: (event, seq) => onEvent(core, kind, event, seq),
      appliedSeq: () => core.kv<number>(`${kind.key}Seq`) ?? 0,
    },
  );

  core.tempod = client;
  client.sendHello({
    type: "hello",
    v: 1,
    incarnation: core.kv<string | null>(`${kind.key}Incarnation`) ?? null,
    lastAckedSeq: core.kv<number>(`${kind.key}Seq`) ?? 0,
    workspace: {
      id: core.ctx.id.name!,
      slug: kind.key,
      branch: current.job.branch,
      baseBranch: current.job.branch,
      repo: { owner: "tempo", name: current.job.repoName },
    },
    env: {},
  });

  return client;
};

const onEvent = <J extends RunnerJob>(
  core: WorkspaceCore,
  kind: RunnerKind<J>,
  event: TempodEvent,
  seq: number,
): void => {
  const current = state(core, kind);

  if (event.kind === "incarnation.changed") core.setKv(`${kind.key}Incarnation`, event.incarnation);

  if (seq > (core.kv<number>(`${kind.key}Seq`) ?? 0)) core.setKv(`${kind.key}Seq`, seq);

  if (!current || current.phase === "done") return;

  if (event.kind === "script.output" && event.runId === current.scriptRunId) {
    const next = keepTail(`${core.kv<string>(`${kind.key}Log`) ?? ""}${event.data}`);
    core.setKv(`${kind.key}Log`, next.text);

    if (next.cut) core.setKv(`${kind.key}LogCut`, true);
  } else if (event.kind === "script.exited" && event.runId === current.scriptRunId) {
    const outcome: JobOutcome = event.timedOut
      ? { conclusion: "timed_out", exitCode: event.exitCode, summary: kind.timedOut }
      : event.exitCode === 0
        ? { conclusion: "success", exitCode: 0, summary: null }
        : {
            conclusion: "failure",
            exitCode: event.exitCode,
            summary: event.exitCode === null ? `Stopped by ${event.signal ?? "a signal"}.` : null,
          };

    core.ctx.waitUntil(finish(core, kind, outcome));
  }
};

/** Records the result once, stores the log, reports it, then stops the container. */
const finish = async <J extends RunnerJob>(
  core: WorkspaceCore,
  kind: RunnerKind<J>,
  outcome: JobOutcome,
): Promise<void> => {
  const current = state(core, kind);

  if (!current || current.phase === "done") return;
  save(core, kind, { ...current, phase: "done", result: outcome });

  try {
    const { text } = await jobLog(core, kind, current.job.token);
    await core.env.DATA.put(kind.logKey(current.job), text, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
    });
  } catch (e) {
    log("warn", `${kind.label} log upload failed`, { runner: core.ctx.id.name, error: errorText(e) });
  }

  await stopContainer(core, kind);
  await report(core, kind, state(core, kind)!);
};

const report = async <J extends RunnerJob>(
  core: WorkspaceCore,
  kind: RunnerKind<J>,
  current: JobState<J>,
): Promise<void> => {
  if (!current.result) return;

  try {
    await kind.report(core, current.job, current.result);
    save(core, kind, { ...current, reported: true });
    await core.ctx.storage.deleteAlarm();
  } catch (e) {
    log("warn", `${kind.label} result report failed`, { runner: core.ctx.id.name, error: errorText(e) });
    await tick(core);
  }
};

const stopContainer = async <J extends RunnerJob>(
  core: WorkspaceCore,
  kind: RunnerKind<J>,
): Promise<void> => {
  core.tempod?.close();
  core.tempod = null;
  core.setKv(`${kind.key}Token`, null);

  try {
    if (core.container?.running) await core.container.destroy();
  } catch (e) {
    log("warn", `${kind.label} container stop failed`, { runner: core.ctx.id.name, error: errorText(e) });
  }
};
