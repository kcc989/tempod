import type { RunScript, ScriptKind, ScriptRun, Settings, SetupStatus } from "@tempo/protocol";
import { formatDuration } from "~/ui/lib/format";

/**
 * Pure helpers for the Setup and Run tabs (04, Bottom panel tabs). Runs come from listScriptRuns
 * (history after a reload) and from live `script.run` messages.
 */

const ended = (r: ScriptRun): boolean => r.status !== "running";

/** One list of runs, newest first. A run that ended wins over a copy that still says running. */
export const mergeRuns = (
  listed: ReadonlyArray<ScriptRun>,
  live: Readonly<Record<string, ScriptRun>>,
): ScriptRun[] => {
  const byId = new Map<string, ScriptRun>();
  for (const r of listed) byId.set(r.id, r);
  for (const r of Object.values(live)) {
    const prev = byId.get(r.id);
    if (!prev || !ended(prev) || ended(r)) byId.set(r.id, r);
  }
  return [...byId.values()].sort(
    (a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
};

export const runsOf = (
  runs: ReadonlyArray<ScriptRun>,
  kind: ScriptKind,
  scriptId?: string | null,
): ScriptRun[] =>
  runs.filter((r) => r.kind === kind && (scriptId === undefined || r.scriptId === scriptId));

export const newestRun = (
  runs: ReadonlyArray<ScriptRun>,
  kind: ScriptKind,
  scriptId?: string | null,
): ScriptRun | null => runsOf(runs, kind, scriptId)[0] ?? null;

export const isRunning = (r: ScriptRun | null | undefined): boolean => r?.status === "running";

export type RunTone = "running" | "ok" | "failed" | "muted";

export const runTone = (r: ScriptRun): RunTone => {
  switch (r.status) {
    case "running":
      return "running";
    case "exited":
      return r.exitCode === 0 ? "ok" : "failed";
    case "killed":
      return "muted";
    case "failed_to_start":
    case "timed_out":
      return "failed";
  }
};

export const runStatusText = (r: ScriptRun): string => {
  switch (r.status) {
    case "running":
      return "Running";
    case "exited":
      return r.exitCode === 0 ? "Finished" : `Exited with code ${r.exitCode ?? "?"}`;
    case "killed":
      return r.signal ? `Stopped (${r.signal})` : "Stopped";
    case "failed_to_start":
      return "Did not start";
    case "timed_out":
      return "Timed out";
  }
};

/** `Finished · 12 s`, or the status alone while running. */
export const runSummary = (r: ScriptRun): string =>
  r.endedAt === null
    ? runStatusText(r)
    : `${runStatusText(r)} · ${formatDuration(Math.max(0, r.endedAt - r.startedAt))}`;

export const SETUP_STATUS_TEXT: Record<SetupStatus, string> = {
  none: "No setup script",
  running: "Running setup",
  succeeded: "Setup finished",
  failed: "Setup failed.",
  skipped: "Setup failed. Continued anyway.",
};

export interface RunScriptEntry extends RunScript {
  readonly id: string;
}

/** Run scripts in file order. */
export const runScriptEntries = (settings: Settings | null | undefined): RunScriptEntry[] =>
  Object.entries(settings?.scripts.run ?? {}).map(([id, s]) => ({ id, ...s }));

/** The script marked `default = true` (01, Project settings file). */
export const defaultRunScriptId = (settings: Settings | null | undefined): string | null =>
  runScriptEntries(settings).find((s) => s.default)?.id ?? null;

/**
 * The script the Run menu shows: the one picked, while it still exists, else the default, else
 * the first.
 */
export const selectedRunScriptId = (
  settings: Settings | null | undefined,
  picked: string | null,
): string | null => {
  const entries = runScriptEntries(settings);
  if (picked !== null && entries.some((s) => s.id === picked)) return picked;
  return defaultRunScriptId(settings) ?? entries[0]?.id ?? null;
};

export type RunToggle =
  | { readonly kind: "start"; readonly scriptId: string }
  | { readonly kind: "stop"; readonly runId: string };

/** What Start/Stop (and ⌥R for the default script) does for one script right now. */
export const runToggle = (runs: ReadonlyArray<ScriptRun>, scriptId: string | null): RunToggle | null => {
  if (scriptId === null) return null;
  const running = runsOf(runs, "run", scriptId).find(isRunning);
  return running ? { kind: "stop", runId: running.id } : { kind: "start", scriptId };
};

/** ⌥R: the script marked default, else the first run script. */
export const toggleRunTarget = (
  settings: Settings | null | undefined,
  runs: ReadonlyArray<ScriptRun>,
): RunToggle | null => runToggle(runs, selectedRunScriptId(settings, null));
