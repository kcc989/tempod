import { Files } from "@cloudflare/sandbox";
import { eq } from "drizzle-orm";
import { TempoError, newId, type ScriptKind, type ScriptRun } from "@tempo/protocol";
import { scriptRuns, type ScriptRunRow } from "../../db/workspace-do.ts";
import { errorText, log } from "../../log.ts";
import { requireTempod } from "./container.ts";
import type { WorkspaceCore } from "./core.ts";

export const LOG_TAIL_BYTES = 1024 * 1024;
export const SETUP_TIMEOUT_MS = 30 * 60_000;
export const ARCHIVE_TIMEOUT_MS = 120_000;
export const scriptLogPath = (runId: string) => `/home/tempo/.tempod/logs/${runId}.log`;
export const scriptLogKey = (workspaceId: string, runId: string) => `logs/${workspaceId}/${runId}.log`;

export const runToWire = (r: ScriptRunRow): ScriptRun => ({
  id: r.id,
  kind: r.kind as ScriptKind,
  scriptId: r.scriptId,
  command: r.command,
  status: r.status as ScriptRun["status"],
  exitCode: r.exitCode,
  signal: r.signal,
  startedAt: r.startedAt,
  endedAt: r.endedAt,
});

export const scriptRun = (core: WorkspaceCore, runId: string): ScriptRunRow | null =>
  core.db.select().from(scriptRuns).where(eq(scriptRuns.id, runId)).get() ?? null;

/** Starts a script in tempod and records the run. A refused start becomes `failed_to_start`. */
export const startScript = async (
  core: WorkspaceCore,
  input: { kind: ScriptKind; scriptId: string | null; command: string; cwd: string; timeoutMs: number | null },
): Promise<ScriptRun> => {
  const runId = newId();
  const now = Date.now();
  core.db
    .insert(scriptRuns)
    .values({
      id: runId,
      kind: input.kind,
      scriptId: input.scriptId,
      command: input.command,
      status: "running",
      exitCode: null,
      signal: null,
      logTail: "",
      r2Key: null,
      startedAt: now,
      endedAt: null,
    })
    .run();
  try {
    await requireTempod(core).request("script.start", {
      runId,
      kind: input.kind,
      scriptId: input.scriptId,
      command: input.command,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
    });
  } catch (e) {
    core.db
      .update(scriptRuns)
      .set({ status: "failed_to_start", endedAt: Date.now(), logTail: `tempo: ${errorText(e)}\n` })
      .where(eq(scriptRuns.id, runId))
      .run();
    const run = runToWire(scriptRun(core, runId)!);
    core.broadcast({ type: "script.run", run });
    if (e instanceof TempoError && (e.code === "CONTAINER_NOT_READY" || e.code === "TEMPOD_UNREACHABLE")) throw e;
    return run;
  }
  const run = runToWire(scriptRun(core, runId)!);
  core.broadcast({ type: "script.run", run });
  core.touchActivity();
  return run;
};

export const appendLog = (core: WorkspaceCore, runId: string, data: string): void => {
  const run = scriptRun(core, runId);
  if (!run) return;
  let tail = run.logTail + data;
  if (tail.length > LOG_TAIL_BYTES / 4) {
    const bytes = new TextEncoder().encode(tail);
    if (bytes.length > LOG_TAIL_BYTES) {
      tail = new TextDecoder().decode(bytes.subarray(bytes.length - LOG_TAIL_BYTES)).replace(/^\uFFFD+/, "");
    }
  }
  core.db.update(scriptRuns).set({ logTail: tail }).where(eq(scriptRuns.id, runId)).run();
};

/** Copies the full log (tempod wrote it before script.exited) to R2 (01, Output). */
export const uploadLog = async (core: WorkspaceCore, runId: string): Promise<void> => {
  try {
    const res = await new Files(core.container!).readFile(scriptLogPath(runId));
    const key = scriptLogKey(core.workspaceId, runId);
    const buf = await res.arrayBuffer();
    await core.env.DATA.put(key, buf, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
    core.db.update(scriptRuns).set({ r2Key: key }).where(eq(scriptRuns.id, runId)).run();
  } catch (e) {
    log("warn", "script log upload failed", { workspaceId: core.workspaceId, runId, error: errorText(e) });
  }
};

export const runningRuns = (core: WorkspaceCore, kind?: ScriptKind): ScriptRunRow[] =>
  core.db
    .select()
    .from(scriptRuns)
    .where(eq(scriptRuns.status, "running"))
    .all()
    .filter((r) => !kind || r.kind === kind);

/** After the container stops, nothing runs: close every open run as killed. */
export const closeOpenRuns = (core: WorkspaceCore): void => {
  for (const r of runningRuns(core)) {
    core.db.update(scriptRuns).set({ status: "killed", endedAt: Date.now() }).where(eq(scriptRuns.id, r.id)).run();
    core.broadcast({ type: "script.run", run: runToWire(scriptRun(core, r.id)!) });
  }
};
