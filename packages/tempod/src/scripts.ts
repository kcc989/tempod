import { closeSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { TempoError, type ScriptKind, type TempodEvent } from "@tempo/protocol";
import type { Subprocess } from "bun";
import { MAX_TEXT_CHARS, splitText } from "./bounds.ts";
import type { TempodDb } from "./db.ts";
import { killGroup } from "./exec.ts";
import { resolveWorkspacePath } from "./fs.ts";
import type { Logger } from "./log.ts";

const SAFE_RUN_ID = /^[0-9A-Za-z_-]{1,128}$/;

const READ_GRACE_MS = 500;

const LOG_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export const TRUNCATED_LINE = "[tempo: log truncated at 50 MiB]\n";

/** Deletes script logs older than 7 days. */
export const pruneLogs = (dir: string, now = Date.now()): number => {
  let removed = 0;

  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".log")) continue;
      const p = join(dir, name);

      try {
        if (now - statSync(p).mtimeMs > LOG_KEEP_MS) {
          rmSync(p, { force: true });
          removed += 1;
        }
      } catch {
        // vanished
      }
    }
  } catch {
    // no dir yet
  }

  return removed;
};

type Stream = "stdout" | "stderr";

interface Run {
  readonly runId: string;
  readonly proc: Subprocess<"ignore", "pipe", "pipe">;
  readonly pid: number;
  timedOut: boolean;
  stopRequested: boolean;
  killTimer: ReturnType<typeof setTimeout> | null;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  readonly buffers: Record<Stream, string>;
  readonly readers: ReadableStreamDefaultReader<Uint8Array>[];
  logFd: number | null;
  logBytes: number;
  logTruncated: boolean;
  readonly done: Promise<void>;
}

export interface ScriptDeps {
  readonly workspace: string;
  readonly logsDir: string;
  readonly mergeMs: number;
  readonly killGraceMs: number;
  readonly logMaxBytes: number;
  readonly db: TempodDb;
  readonly log: Logger;
  readonly env: () => Record<string, string>;
  readonly emit: (event: TempodEvent) => void;
}

export class ScriptManager {
  private readonly runs = new Map<string, Run>();

  constructor(private readonly deps: ScriptDeps) {}

  logPath(runId: string): string {
    return join(this.deps.logsDir, `${runId}.log`);
  }

  isRunning(runId: string): boolean {
    return this.runs.has(runId);
  }

  start(p: {
    runId: string;
    kind: ScriptKind;
    scriptId: string | null;
    command: string;
    cwd: string;
    timeoutMs: number | null;
  }) {
    if (!SAFE_RUN_ID.test(p.runId)) throw new TempoError("VALIDATION_FAILED", "Bad run id.");
    const existing = this.runs.get(p.runId);

    if (existing) return { pid: existing.pid } satisfies { pid: number };
    const cwd = resolveWorkspacePath(this.deps.workspace, p.cwd === "" ? "." : p.cwd);

    try {
      if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new TempoError("NOT_FOUND", `The script folder does not exist: ${p.cwd || "."}`);
    }

    mkdirSync(this.deps.logsDir, { recursive: true });
    const logFd = openSync(this.logPath(p.runId), "w", 0o644);
    let proc: Subprocess<"ignore", "pipe", "pipe">;

    try {
      proc = Bun.spawn(["bash", "-lc", p.command], {
        cwd,
        env: this.deps.env(),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      });
    } catch (e) {
      closeSync(logFd);
      throw new TempoError(
        "INTERNAL",
        `The script did not start: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    let resolveDone!: () => void;

    const run: Run = {
      runId: p.runId,
      proc,
      pid: proc.pid,
      timedOut: false,
      stopRequested: false,
      killTimer: null,
      timeoutTimer: null,
      flushTimer: null,
      buffers: { stdout: "", stderr: "" },
      readers: [],
      logFd,
      logBytes: 0,
      logTruncated: false,
      done: new Promise<void>((r) => (resolveDone = r)),
    };

    this.runs.set(p.runId, run);
    this.deps.db.addProcess(p.runId, "script", proc.pid);
    this.deps.log.info("script started", {
      runId: p.runId,
      kind: p.kind,
      scriptId: p.scriptId,
      pid: proc.pid,
    });

    if (p.timeoutMs !== null && p.timeoutMs > 0) {
      run.timeoutTimer = setTimeout(() => {
        run.timedOut = true;
        this.terminate(run);
      }, p.timeoutMs);
    }

    const readers = [this.read(run, "stdout", proc.stdout), this.read(run, "stderr", proc.stderr)];
    void this.finish(run, readers).finally(resolveDone);

    return { pid: proc.pid } satisfies { pid: number };
  }

  private async read(run: Run, stream: Stream, body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    run.readers.push(reader);

    try {
      for (;;) {
        const { value, done } = await reader.read();

        if (done) break;
        this.writeLog(run, value);
        this.buffer(run, stream, decoder.decode(value, { stream: true }));
      }
    } catch {
      // cancelled after exit
    } finally {
      this.buffer(run, stream, decoder.decode());
      reader.releaseLock();
    }
  }

  /** Appends to the full log. A write error (a full disk) ends the log but never the output stream. */
  private writeLog(run: Run, chunk: Uint8Array): void {
    if (run.logFd === null || run.logTruncated) return;

    try {
      const room = this.deps.logMaxBytes - run.logBytes;
      const part = chunk.byteLength > room ? chunk.subarray(0, Math.max(0, room)) : chunk;

      if (part.byteLength > 0) {
        writeSync(run.logFd, part);
        run.logBytes += part.byteLength;
      }

      if (chunk.byteLength > room) {
        writeSync(
          run.logFd,
          (part.byteLength > 0 && part[part.byteLength - 1] !== 10 ? "\n" : "") + TRUNCATED_LINE,
        );
        run.logTruncated = true;
      }
    } catch (e) {
      run.logTruncated = true;

      try {
        closeSync(run.logFd);
      } catch {
        // already closed
      }

      run.logFd = null;
      this.deps.log.warn("script log write failed; the log is cut here", {
        runId: run.runId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private buffer(run: Run, stream: Stream, text: string): void {
    if (text === "") return;
    run.buffers[stream] += text;

    if (run.buffers[stream].length >= MAX_TEXT_CHARS) {
      this.flush(run);

      return;
    }

    if (!run.flushTimer) run.flushTimer = setTimeout(() => this.flush(run), this.deps.mergeMs);
  }

  private flush(run: Run): void {
    if (run.flushTimer) clearTimeout(run.flushTimer);
    run.flushTimer = null;

    for (const stream of ["stdout", "stderr"] as const) {
      const data = run.buffers[stream];

      if (data === "") continue;
      run.buffers[stream] = "";

      for (const piece of splitText(data))
        this.deps.emit({ kind: "script.output", runId: run.runId, stream, data: piece });
    }
  }

  private async finish(run: Run, readers: Promise<void>[]): Promise<void> {
    await run.proc.exited;
    const drained = Promise.all(readers);

    const timedOut = await Promise.race([
      drained.then(() => false),
      Bun.sleep(READ_GRACE_MS).then(() => true),
    ]);

    if (timedOut) {
      // A process left in the group still holds the pipes; the run is over for Tempo anyway.
      await Promise.allSettled(run.readers.map((r) => r.cancel()));
      await Promise.race([drained, Bun.sleep(100)]);
    }

    this.flush(run);

    if (run.logFd !== null) {
      closeSync(run.logFd);
      run.logFd = null;
    }

    if (run.timeoutTimer) clearTimeout(run.timeoutTimer);

    if (!run.stopRequested && run.killTimer) clearTimeout(run.killTimer);
    this.runs.delete(run.runId);
    this.deps.db.removeProcess(run.runId);
    const exitCode = run.proc.exitCode;
    const signal = run.proc.signalCode ?? null;
    this.deps.log.info("script exited", { runId: run.runId, exitCode, signal, timedOut: run.timedOut });
    this.deps.emit({ kind: "script.exited", runId: run.runId, exitCode, signal, timedOut: run.timedOut });
  }

  /** SIGTERM to the process group, SIGKILL after the grace period. */
  private terminate(run: Run): void {
    if (run.stopRequested) return;
    run.stopRequested = true;
    killGroup(run.pid, "SIGTERM");
    run.killTimer = setTimeout(() => {
      run.killTimer = null;
      killGroup(run.pid, "SIGKILL");
    }, this.deps.killGraceMs);
  }

  async stop(runId: string): Promise<void> {
    const run = this.runs.get(runId);

    if (!run) return;
    this.terminate(run);
    await Promise.race([run.done, Bun.sleep(this.deps.killGraceMs + 3_000)]);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.runs.keys()].map((id) => this.stop(id)));
  }

  get size(): number {
    return this.runs.size;
  }
}
