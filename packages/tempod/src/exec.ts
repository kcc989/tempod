export interface ExecOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly input?: string | Uint8Array;
  readonly timeoutMs?: number;
}

export interface ExecResult {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export class ExecError extends Error {
  constructor(
    readonly cmd: ReadonlyArray<string>,
    readonly result: ExecResult,
  ) {
    super(`${cmd[0]} ${cmd[1] ?? ""} failed (${result.code ?? result.signal}): ${tail(result.stderr || result.stdout, 2000)}`);
  }
}

export const tail = (text: string, max: number): string => {
  const t = text.trimEnd();
  return t.length > max ? t.slice(t.length - max) : t;
};

const which = new Map<string, string | null>();

/** Path of a binary on PATH, cached; null when missing. */
export const findBinary = (name: string): string | null => {
  if (!which.has(name)) which.set(name, Bun.which(name));
  return which.get(name) ?? null;
};

/** Runs a command to completion and captures its output. Never throws for a non-zero exit. */
export const run = async (cmd: ReadonlyArray<string>, opts: ExecOptions = {}): Promise<ExecResult> => {
  const proc = Bun.spawn([...cmd], {
    cwd: opts.cwd,
    env: opts.env as Record<string, string> | undefined,
    stdin: opts.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (opts.input !== undefined && proc.stdin) {
    proc.stdin.write(opts.input);
    await proc.stdin.end();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs) timer = setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  if (timer) clearTimeout(timer);
  return { code: proc.exitCode, signal: proc.signalCode ?? null, stdout, stderr };
};

/** Like `run`, but throws `ExecError` on a non-zero exit. */
export const runOk = async (cmd: ReadonlyArray<string>, opts: ExecOptions = {}): Promise<ExecResult> => {
  const r = await run(cmd, opts);
  if (r.code !== 0) throw new ExecError(cmd, r);
  return r;
};
