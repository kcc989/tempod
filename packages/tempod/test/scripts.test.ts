import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TRUNCATED_LINE } from "../src/scripts.ts";
import { cleanupDirs, DoClient, isAlive, sleep, startTempod, testConfig, type Harness } from "./helpers.ts";

afterAll(cleanupDirs);

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const T = 20_000;

const setup = async (limits: Record<string, number> = {}) => {
  h = startTempod(testConfig({ limits: { killGraceMs: 300, ...limits } }));
  const c = new DoClient(h.base);
  await c.hello({ env: { TEMPO_WORKSPACE_ID: "01ws", TEMPO_PORT: "3000", PROJECT_VAR: "from-project" } });
  await c.waitEvent("incarnation.changed");
  const start = (runId: string, command: string, extra: Record<string, unknown> = {}) =>
    c.ok<{ pid: number }>("script.start", { runId, kind: "run", scriptId: "dev", command, cwd: "", timeoutMs: null, ...extra });
  const exited = (runId: string, timeoutMs = 10_000) => c.waitEvent("script.exited", (e) => e.runId === runId, timeoutMs);
  const output = (runId: string, stream?: "stdout" | "stderr") =>
    c
      .of("script.output")
      .filter((e) => e.runId === runId && (!stream || e.stream === stream))
      .map((e) => e.data)
      .join("");
  return { c, h: h!, start, exited, output };
};

const alive = isAlive;

describe("scripts", () => {
  test(
    "bash -lc with the hello env and cwd /workspace; exit code; stdout and stderr apart",
    async () => {
      const { start, exited, output, h } = await setup();
      const r = await start(
        "01run1",
        'shopt -q login_shell && echo login; echo "id=$TEMPO_WORKSPACE_ID var=$PROJECT_VAR"; pwd; echo oops >&2; exit 7',
      );
      expect(r.pid).toBeGreaterThan(0);
      const ev = await exited("01run1");
      expect(ev).toMatchObject({ exitCode: 7, signal: null, timedOut: false });
      expect(output("01run1", "stdout")).toBe(`login\nid=01ws var=from-project\n${h.config.workspace}\n`);
      expect(output("01run1", "stderr")).toBe("oops\n");
    },
    T,
  );

  test(
    "children never see TEMPOD_* vars",
    async () => {
      process.env["TEMPOD_TOKEN"] = "must-not-leak";
      try {
        const { start, exited, output } = await setup();
        await start("01env", 'echo "token=${TEMPOD_TOKEN:-none} port=${TEMPOD_PORT:-none}"');
        await exited("01env");
        expect(output("01env")).toBe("token=none port=none\n");
      } finally {
        delete process.env["TEMPOD_TOKEN"];
      }
    },
    T,
  );

  test(
    "output is merged per interval; the full log is on disk before script.exited",
    async () => {
      const { c, start, exited, output, h } = await setup();
      await start("01merge", "for i in $(seq 1 200); do echo line$i; done; head -c 300000 /dev/zero | tr '\\0' 'x'");
      await exited("01merge");
      const events = c.of("script.output").filter((e) => e.runId === "01merge");
      expect(events.length).toBeLessThanOrEqual(6);
      for (const e of events) expect(e.data.length).toBeLessThanOrEqual(128 * 1024);
      const expected = Array.from({ length: 200 }, (_, i) => `line${i + 1}\n`).join("") + "x".repeat(300_000);
      expect(output("01merge")).toBe(expected);
      expect(readFileSync(join(h.config.logsDir, "01merge.log"), "utf8")).toBe(expected);
    },
    T,
  );

  test(
    "the log stops at its size limit with a marker line",
    async () => {
      const { start, exited, h } = await setup({ scriptLogMaxBytes: 1000 });
      await start("01cap", "head -c 5000 /dev/zero | tr '\\0' 'y'");
      await exited("01cap");
      const log = readFileSync(join(h.config.logsDir, "01cap.log"), "utf8");
      expect(log).toBe("y".repeat(1000) + "\n" + TRUNCATED_LINE);
    },
    T,
  );

  test(
    "a failing log write cuts the log but the output keeps flowing",
    async () => {
      const { start, exited, output, h } = await setup();
      await start("01logfail", "sleep 0.3; for i in $(seq 1 3); do echo after$i; done");
      const run = (h.app.scripts as unknown as { runs: Map<string, { logFd: number | null }> }).runs.get("01logfail")!;
      closeSync(run.logFd!);
      const ev = await exited("01logfail");
      expect(ev.exitCode).toBe(0);
      expect(output("01logfail")).toBe("after1\nafter2\nafter3\n");
      expect(h.log.lines.some((l) => l.includes("script log write failed"))).toBe(true);
    },
    T,
  );

  test(
    "stop kills the whole process group; a script that ignores SIGTERM gets SIGKILL",
    async () => {
      const { c, start, exited, h } = await setup();
      const pidFile = join(h.config.workspace, "bg.pid");
      await start("01stop", `sleep 1000 & echo $! > ${pidFile}; wait`);
      for (let i = 0; i < 50 && !existsSync(pidFile); i++) await sleep(20);
      const bg = Number(readFileSync(pidFile, "utf8"));
      expect(alive(bg)).toBe(true);
      await c.ok("script.stop", { runId: "01stop" });
      const ev = await exited("01stop");
      expect(ev.signal).toBe("SIGTERM");
      for (let i = 0; i < 20 && alive(bg); i++) await sleep(20);
      expect(alive(bg)).toBe(false);

      await start("01stubborn", "trap '' TERM; while true; do sleep 0.05; done");
      await sleep(100);
      const t0 = Date.now();
      await c.ok("script.stop", { runId: "01stubborn" });
      const hard = await exited("01stubborn");
      expect(hard.signal).toBe("SIGKILL");
      expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
      expect(await c.ok<unknown>("script.stop", { runId: "01gone" })).toEqual({});
    },
    T,
  );

  test(
    "timeout ends the script with timedOut: true",
    async () => {
      const { start, exited } = await setup();
      await start("01slow", "sleep 10", { timeoutMs: 200 });
      const ev = await exited("01slow");
      expect(ev.timedOut).toBe(true);
      expect(ev.signal).toBe("SIGTERM");
    },
    T,
  );

  test(
    "cwd, run id checks and an idempotent start",
    async () => {
      const { c, start, exited, output, h } = await setup();
      mkdirSync(join(h.config.workspace, "web"));
      await start("01cwd", "pwd", { cwd: "web" });
      await exited("01cwd");
      expect(output("01cwd")).toBe(`${join(h.config.workspace, "web")}\n`);
      const missing = await c.req("script.start", { runId: "01x", kind: "run", scriptId: null, command: "true", cwd: "nope", timeoutMs: null });
      expect(missing).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
      const outside = await c.req("script.start", { runId: "01y", kind: "run", scriptId: null, command: "true", cwd: "../..", timeoutMs: null });
      expect(outside).toMatchObject({ ok: false, error: { code: "PATH_OUTSIDE_WORKSPACE" } });
      const badId = await c.req("script.start", { runId: "../x", kind: "run", scriptId: null, command: "true", cwd: "", timeoutMs: null });
      expect(badId).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
      const a = await start("01same", "sleep 0.5");
      const b = await start("01same", "sleep 0.5");
      expect(b.pid).toBe(a.pid);
      await exited("01same");
      expect(c.of("script.exited").filter((e) => e.runId === "01same")).toHaveLength(1);
    },
    T,
  );

  test(
    "shutdown stops running scripts and answers after they exit",
    async () => {
      const { c, start, h } = await setup();
      await start("01long", "sleep 1000");
      await c.ok("shutdown", { reason: "sleep" }, 20_000);
      expect(h.app.scripts.size).toBe(0);
      expect(c.of("script.exited").some((e) => e.runId === "01long")).toBe(true);
    },
    T,
  );
});
