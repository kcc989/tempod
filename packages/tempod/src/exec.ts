export interface ExecOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly input?: string | Uint8Array;
  /** Hard deadline: the whole process group gets SIGTERM, then SIGKILL after `killGraceMs`. */
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
}

export interface ExecResult {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
}

export class ExecError extends Error {
  constructor(
    readonly cmd: ReadonlyArray<string>,
    readonly result: ExecResult,
  ) {
    const why = result.timedOut ? "timed out" : String(result.code ?? result.signal);
    super(`${cmd[0]} ${cmd[1] ?? ""} failed (${why}): ${tail(result.stderr || result.stdout, 2000)}`);
  }
}

export const tail = (text: string, max: number): string => {
  const t = text.trimEnd();

  return t.length > max ? t.slice(t.length - max) : t;
};

/** Signals a whole process group; the leader was started with `detached` (setsid), so pgid = pid. */
export const killGroup = (pid: number, signal: NodeJS.Signals): boolean => {
  try {
    process.kill(-pid, signal);

    return true;
  } catch {
    return false;
  }
};

const which = new Map<string, string | null>();

/** Path of a binary on PATH, cached; null when missing. */
export const findBinary = (name: string): string | null => {
  if (!which.has(name)) which.set(name, Bun.which(name));

  return which.get(name) ?? null;
};

/** After the leader exits, how long to wait for children that still hold the pipes. */
const PIPE_GRACE_MS = 2_000;

/** Reads a stream to the end; `cancel` stops early and keeps what was read. */
const collect = (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  const done = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();

        if (done) break;
        chunks.push(value);
      }
    } catch {
      // cancelled
    }
  })();

  return {
    done,
    cancel: () => reader.cancel().catch(() => undefined),
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
};

/**
 * Runs a command in its own process group and captures its output. Never throws for a non-zero exit.
 * On timeout the whole group is killed and the result comes back without waiting for the pipes.
 */
export const run = async (cmd: ReadonlyArray<string>, opts: ExecOptions = {}): Promise<ExecResult> => {
  const proc = Bun.spawn([...cmd], {
    cwd: opts.cwd,
    env:
      opts.env === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(opts.env).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
          ),
    stdin: opts.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });

  const out = collect(proc.stdout);
  const err = collect(proc.stderr);
  let timedOut = false;

  const timer =
    opts.timeoutMs !== undefined && opts.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          killGroup(proc.pid, "SIGTERM");
          setTimeout(() => killGroup(proc.pid, "SIGKILL"), opts.killGraceMs ?? 2_000);
        }, opts.timeoutMs)
      : undefined;

  if (opts.input !== undefined && proc.stdin) {
    try {
      proc.stdin.write(opts.input);
      await proc.stdin.end();
    } catch {
      // the child exited without reading its input
    }
  }

  await proc.exited;

  if (timer) clearTimeout(timer);

  const drained = await Promise.race([
    Promise.all([out.done, err.done]).then(() => true),
    Bun.sleep(timedOut ? 100 : PIPE_GRACE_MS).then(() => false),
  ]);

  if (!drained) await Promise.all([out.cancel(), err.cancel()]);

  return {
    code: proc.exitCode,
    signal: proc.signalCode ?? null,
    stdout: out.text(),
    stderr: err.text(),
    timedOut,
  };
};

/** Like `run`, but throws `ExecError` on a non-zero exit. */
export const runOk = async (cmd: ReadonlyArray<string>, opts: ExecOptions = {}): Promise<ExecResult> => {
  const r = await run(cmd, opts);

  if (r.code !== 0) throw new ExecError(cmd, r);

  return r;
};
