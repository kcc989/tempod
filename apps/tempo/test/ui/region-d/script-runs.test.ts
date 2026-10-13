import { DEFAULT_SETTINGS, type ScriptRun, type Settings } from "@tempo/protocol";
import { describe, expect, it } from "vitest";
import {
  defaultRunScriptId,
  isRunning,
  mergeRuns,
  newestRun,
  runScriptEntries,
  runStatusText,
  runSummary,
  runsOf,
  runToggle,
  runTone,
  selectedRunScriptId,
  SETUP_STATUS_TEXT,
  toggleRunTarget,
} from "~/ui/components/processes/script-runs";

const run = (over: Partial<ScriptRun> = {}): ScriptRun => ({
  id: "r1",
  kind: "run",
  scriptId: "dev",
  command: "bun run dev",
  status: "running",
  exitCode: null,
  signal: null,
  startedAt: 1000,
  endedAt: null,
  ...over,
});

const withRun = (run: Settings["scripts"]["run"]): Settings => ({
  ...DEFAULT_SETTINGS,
  scripts: { ...DEFAULT_SETTINGS.scripts, run },
});

describe("mergeRuns", () => {
  it("joins listed and live runs, newest first", () => {
    const merged = mergeRuns([run({ id: "a", startedAt: 1 }), run({ id: "b", startedAt: 3 })], {
      c: run({ id: "c", startedAt: 2 }),
    });

    expect(merged.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("prefers the live copy unless only the listed copy has ended", () => {
    const listedRunning = run({ id: "a" });
    const liveEnded = run({ id: "a", status: "exited", exitCode: 0, endedAt: 5 });
    expect(mergeRuns([listedRunning], { a: liveEnded })[0]).toEqual(liveEnded);

    const listedEnded = run({ id: "a", status: "killed", endedAt: 5 });
    const liveRunning = run({ id: "a" });
    expect(mergeRuns([listedEnded], { a: liveRunning })[0]).toEqual(listedEnded);
  });

  it("breaks start-time ties by id, newest id first", () => {
    expect(mergeRuns([run({ id: "a" }), run({ id: "b" })], {}).map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("run selection", () => {
  const runs = mergeRuns(
    [
      run({ id: "s1", kind: "setup", scriptId: null, startedAt: 1 }),
      run({ id: "d1", startedAt: 2, status: "exited", exitCode: 1, endedAt: 3 }),
      run({ id: "d2", startedAt: 4 }),
      run({ id: "t1", scriptId: "test", startedAt: 5 }),
    ],
    {},
  );

  it("filters by kind and script", () => {
    expect(runsOf(runs, "run", "dev").map((r) => r.id)).toEqual(["d2", "d1"]);
    expect(runsOf(runs, "run").map((r) => r.id)).toEqual(["t1", "d2", "d1"]);
    expect(newestRun(runs, "setup")?.id).toBe("s1");
    expect(newestRun(runs, "archive")).toBeNull();
  });

  it("toggles to stop while a run of the script is running, else start", () => {
    expect(runToggle(runs, "dev")).toEqual({ kind: "stop", runId: "d2" });
    expect(runToggle(runs, "lint")).toEqual({ kind: "start", scriptId: "lint" });
    expect(runToggle(runs, null)).toBeNull();
    expect(isRunning(runs[0])).toBe(true);
    expect(isRunning(null)).toBe(false);
  });
});

describe("run scripts from settings", () => {
  it("lists scripts in file order and finds the default", () => {
    const s = withRun({
      dev: { command: "bun run dev", cwd: "", default: false },
      web: { command: "bun run web", cwd: "apps/web", default: true },
    });

    expect(runScriptEntries(s).map((e) => e.id)).toEqual(["dev", "web"]);
    expect(defaultRunScriptId(s)).toBe("web");
    expect(runScriptEntries(null)).toEqual([]);
  });

  it("shows the picked script while it exists, else the default, else the first", () => {
    const s = withRun({
      dev: { command: "a", cwd: "", default: false },
      web: { command: "b", cwd: "", default: true },
    });

    expect(selectedRunScriptId(s, "dev")).toBe("dev");
    expect(selectedRunScriptId(s, "gone")).toBe("web");
    expect(selectedRunScriptId(s, null)).toBe("web");
    const noDefault = withRun({ dev: { command: "a", cwd: "", default: false } });
    expect(selectedRunScriptId(noDefault, null)).toBe("dev");
    expect(selectedRunScriptId(DEFAULT_SETTINGS, null)).toBeNull();
  });

  it("⌥R targets the default script, else the first", () => {
    const s = withRun({
      dev: { command: "a", cwd: "", default: false },
      web: { command: "b", cwd: "", default: true },
    });

    expect(toggleRunTarget(s, [])).toEqual({ kind: "start", scriptId: "web" });
    expect(toggleRunTarget(s, [run({ id: "w", scriptId: "web" })])).toEqual({ kind: "stop", runId: "w" });
    expect(toggleRunTarget(withRun({ dev: { command: "a", cwd: "", default: false } }), [])).toEqual({
      kind: "start",
      scriptId: "dev",
    });
    expect(toggleRunTarget(DEFAULT_SETTINGS, [])).toBeNull();
  });
});

describe("status text", () => {
  it("describes each run status", () => {
    expect(runStatusText(run())).toBe("Running");
    expect(runStatusText(run({ status: "exited", exitCode: 0 }))).toBe("Finished");
    expect(runStatusText(run({ status: "exited", exitCode: 2 }))).toBe("Exited with code 2");
    expect(runStatusText(run({ status: "killed", signal: "SIGTERM" }))).toBe("Stopped (SIGTERM)");
    expect(runStatusText(run({ status: "killed" }))).toBe("Stopped");
    expect(runStatusText(run({ status: "failed_to_start" }))).toBe("Did not start");
    expect(runStatusText(run({ status: "timed_out" }))).toBe("Timed out");
  });

  it("adds the duration once a run ended", () => {
    expect(runSummary(run())).toBe("Running");
    expect(runSummary(run({ status: "exited", exitCode: 0, startedAt: 0, endedAt: 12_000 }))).toBe(
      "Finished · 12 s",
    );
  });

  it("gives each run a tone", () => {
    expect(runTone(run())).toBe("running");
    expect(runTone(run({ status: "exited", exitCode: 0 }))).toBe("ok");
    expect(runTone(run({ status: "exited", exitCode: 1 }))).toBe("failed");
    expect(runTone(run({ status: "killed" }))).toBe("muted");
    expect(runTone(run({ status: "timed_out" }))).toBe("failed");
  });

  it("names every setup status, with the 04 text for a failure", () => {
    expect(SETUP_STATUS_TEXT.failed).toBe("Setup failed.");
    expect(Object.keys(SETUP_STATUS_TEXT).sort()).toEqual([
      "failed",
      "none",
      "running",
      "skipped",
      "succeeded",
    ]);
  });
});
