import { DEFAULT_SETTINGS, TempoError, newId, randomToken, type TempodEvent } from "@tempo/protocol";
import { lifecycleRedactor } from "../../agents/secrets.ts";
import {
  CI_LOG_DROPPED,
  ciLogKey,
  ciRunnerName,
  keepTail,
  type CiJobResult,
  type CiJobStart,
} from "../../ci/types.ts";
import { errorText, log } from "../../log.ts";
import { waitHealthy } from "./container.ts";
import type { WorkspaceCore } from "./core.ts";
import { TempodClient, openTempodSocket } from "./tempod-client.ts";

/** 10, Execution: the runner checks its job every 30 seconds. */
export const CI_TICK_MS = 30_000;

/** A job that has not finished by its timeout plus this is stopped (10, Runs and jobs). */
const CI_GRACE_MS = 5 * 60_000;

export interface CiJobState extends CiJobStart {
  readonly phase: "pending" | "running" | "done";
  readonly scriptRunId: string;
  readonly deadline: number;
  readonly result: CiJobResult | null;
  readonly reported: boolean;
}

const job = (core: WorkspaceCore): CiJobState | undefined => core.kv<CiJobState>("ciJob");

const save = (core: WorkspaceCore, next: CiJobState): void => {
  const result = next.result ? { ...next.result } : null;
  core.setKv("ciJob", { ...next, egressAllowlist: [...next.egressAllowlist], result });
};

const tick = (core: WorkspaceCore, at = Date.now() + CI_TICK_MS) => core.ctx.storage.setAlarm(at);

/** Starts one job (10, Execution). Repeating the same token does nothing. */
export const ciStart = async (core: WorkspaceCore, input: CiJobStart): Promise<void> => {
  if (core.ctx.id.name !== ciRunnerName(input.runId, input.jobKey) || core.wsOrNull())
    throw new TempoError("NOT_FOUND");
  const current = job(core);

  if (current?.token === input.token) return;

  if (current && current.phase !== "done") await stopContainer(core);
  core.setKv("ciLog", "");
  core.setKv("ciLogCut", false);
  core.setKv("ciSeq", 0);
  core.setKv("ciIncarnation", null);
  save(core, {
    ...input,
    phase: "pending",
    scriptRunId: newId(),
    deadline: Date.now() + input.timeoutMinutes * 60_000 + CI_GRACE_MS,
    result: null,
    reported: false,
  });
  await tick(core, Date.now());
};

/** Stops the job without a report: the coordinator already recorded the cancel. */
export const ciCancel = async (core: WorkspaceCore, token: string): Promise<void> => {
  const current = job(core);

  if (!current || current.token !== token) return;

  if (current.phase !== "done") save(core, { ...current, phase: "done", reported: true });
  await stopContainer(core);
  await core.ctx.storage.deleteAlarm();
};

/** The live log tail, redacted (10, Logs). */
export const ciLog = async (
  core: WorkspaceCore,
  token: string,
): Promise<{ text: string; truncated: boolean }> => {
  const current = job(core);

  if (!current || current.token !== token) throw new TempoError("NOT_FOUND");
  const cut = core.kv<boolean>("ciLogCut") ?? false;
  const redact = await lifecycleRedactor(core);

  return { text: redact(`${cut ? CI_LOG_DROPPED : ""}${core.kv<string>("ciLog") ?? ""}`), truncated: cut };
};

/** The runner alarm (10, Execution). */
export const ciAlarm = async (core: WorkspaceCore): Promise<void> => {
  const current = job(core);

  if (!current) return;

  if (current.phase === "done") {
    if (!current.reported) await report(core, current);

    if (!job(core)?.reported) await tick(core);

    return;
  }

  if (current.phase === "pending") {
    await launch(core, current);
  } else if (Date.now() > current.deadline) {
    await finish(core, { conclusion: "timed_out", exitCode: null, summary: "The job ran out of time." });
  } else if (!core.tempod?.open) {
    if (core.container?.running) {
      try {
        await connect(core, current);
      } catch (e) {
        log("warn", "ci runner reconnect failed", { runner: core.ctx.id.name, error: errorText(e) });
      }
    } else {
      await finish(core, { conclusion: "failure", exitCode: null, summary: "The CI container stopped." });
    }
  }

  if (job(core)?.phase !== "done" || !job(core)?.reported) await tick(core);
};

const launch = async (core: WorkspaceCore, current: CiJobState): Promise<void> => {
  const container = core.container;

  if (!container) {
    await finish(core, { conclusion: "failure", exitCode: null, summary: "The CI container did not start." });

    return;
  }

  try {
    if (container.running) await container.destroy();
    core.setKv("ciToken", randomToken(32));
    container.start({
      image: container.images["workspace"] ?? "workspace",
      instance: DEFAULT_SETTINGS.environment.instance,
      enableInternet: false,
      env: {
        TEMPOD_TOKEN: core.kv<string>("ciToken")!,
        TEMPOD_PORT: "7070",
        TEMPO_WORKSPACE_ID: core.ctx.id.name!,
      },
      labels: { purpose: "ci" },
    });

    const outbound = core.ctx.exports.TempoOutbound({
      props: { workspaceId: core.ctx.id.name!, userId: current.userId, ci: true },
    });

    await container.interceptAllOutboundHttp(outbound);
    await container.interceptOutboundHttps("*", outbound);
    await container.setInactivityTimeout(current.timeoutMinutes * 60_000 + 2 * CI_GRACE_MS);
    await waitHealthy(core, AbortSignal.timeout(90_000));
  } catch (e) {
    log("warn", "ci container start failed", { runner: core.ctx.id.name, error: errorText(e) });
    await finish(core, { conclusion: "failure", exitCode: null, summary: "The CI container did not start." });

    return;
  }

  try {
    const client = await connect(core, current);
    await client.request("ci.checkout", { url: current.cloneUrl, branch: current.branch, sha: current.sha });
    await client.request("script.start", {
      runId: current.scriptRunId,
      kind: "run",
      scriptId: "ci",
      command: current.command,
      cwd: "",
      timeoutMs: current.timeoutMinutes * 60_000,
    });
    const latest = job(core);

    if (latest?.token === current.token && latest.phase === "pending")
      save(core, { ...latest, phase: "running" });
  } catch (e) {
    const detail = e instanceof TempoError ? (e.detail ?? e.message) : "tempod did not answer.";

    const summary =
      e instanceof TempoError && e.code === "CLONE_FAILED"
        ? `Could not check out ${current.sha.slice(0, 7)}: ${detail.slice(0, 300)}`
        : `The job did not start: ${detail.slice(0, 300)}`;

    await finish(core, { conclusion: "failure", exitCode: null, summary });
  }
};

const connect = async (core: WorkspaceCore, current: CiJobState): Promise<TempodClient> => {
  const socket = await openTempodSocket(core);

  const client = new TempodClient(
    core,
    socket,
    () => undefined,
    (c) => {
      if (core.tempod === c) core.tempod = null;
    },
    { onEvent: (event, seq) => onEvent(core, event, seq), appliedSeq: () => core.kv<number>("ciSeq") ?? 0 },
  );

  core.tempod = client;
  client.sendHello({
    type: "hello",
    v: 1,
    incarnation: core.kv<string | null>("ciIncarnation") ?? null,
    lastAckedSeq: core.kv<number>("ciSeq") ?? 0,
    workspace: {
      id: core.ctx.id.name!,
      slug: "ci",
      branch: current.branch,
      baseBranch: current.branch,
      repo: { owner: "tempo", name: current.repoName },
    },
    env: {},
  });

  return client;
};

const onEvent = (core: WorkspaceCore, event: TempodEvent, seq: number): void => {
  const current = job(core);

  if (event.kind === "incarnation.changed") core.setKv("ciIncarnation", event.incarnation);

  if (seq > (core.kv<number>("ciSeq") ?? 0)) core.setKv("ciSeq", seq);

  if (!current || current.phase === "done") return;

  if (event.kind === "script.output" && event.runId === current.scriptRunId) {
    const next = keepTail(`${core.kv<string>("ciLog") ?? ""}${event.data}`);
    core.setKv("ciLog", next.text);

    if (next.cut) core.setKv("ciLogCut", true);
  } else if (event.kind === "script.exited" && event.runId === current.scriptRunId) {
    const outcome: Omit<CiJobResult, "runId" | "jobKey" | "token"> = event.timedOut
      ? { conclusion: "timed_out", exitCode: event.exitCode, summary: "The job ran out of time." }
      : event.exitCode === 0
        ? { conclusion: "success", exitCode: 0, summary: null }
        : {
            conclusion: "failure",
            exitCode: event.exitCode,
            summary: event.exitCode === null ? `Stopped by ${event.signal ?? "a signal"}.` : null,
          };

    core.ctx.waitUntil(finish(core, outcome));
  }
};

/** Records the result once, stores the log, reports it, then stops the container. */
const finish = async (
  core: WorkspaceCore,
  outcome: Omit<CiJobResult, "runId" | "jobKey" | "token">,
): Promise<void> => {
  const current = job(core);

  if (!current || current.phase === "done") return;

  const result: CiJobResult = {
    runId: current.runId,
    jobKey: current.jobKey,
    token: current.token,
    ...outcome,
  };

  save(core, { ...current, phase: "done", result });

  try {
    const { text } = await ciLog(core, current.token);
    await core.env.DATA.put(ciLogKey(current.projectId, current.runId, current.jobKey), text, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
    });
  } catch (e) {
    log("warn", "ci log upload failed", { runner: core.ctx.id.name, error: errorText(e) });
  }

  await stopContainer(core);
  await report(core, job(core)!);
};

const report = async (core: WorkspaceCore, current: CiJobState): Promise<void> => {
  if (!current.result) return;

  try {
    await core.ciCoordinator(current.projectId).jobFinished(current.result);
    save(core, { ...current, reported: true });
    await core.ctx.storage.deleteAlarm();
  } catch (e) {
    log("warn", "ci result report failed", { runner: core.ctx.id.name, error: errorText(e) });
    await tick(core);
  }
};

const stopContainer = async (core: WorkspaceCore): Promise<void> => {
  core.tempod?.close();
  core.tempod = null;
  core.setKv("ciToken", null);

  try {
    if (core.container?.running) await core.container.destroy();
  } catch (e) {
    log("warn", "ci container stop failed", { runner: core.ctx.id.name, error: errorText(e) });
  }
};
