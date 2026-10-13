import { existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Subprocess } from "bun";
import { findBinary, run } from "./exec.ts";
import type { Logger } from "./log.ts";
import { SETTINGS_FILE_PATHS } from "./settings.ts";

/** The exclude regex of 01 (its table cell is cut off): skip `.git` and `node_modules` at any depth. */
export const WATCH_EXCLUDE = "(^|/)(\\.git|node_modules)(/|$)";

export const inotifyArgs = (workspace: string): string[] => [
  "-m",
  "-r",
  "-q",
  "-e",
  "create,modify,delete,move",
  "--format",
  "%e %w%f",
  "--exclude",
  WATCH_EXCLUDE,
  workspace,
];

/** Paths in `git status --porcelain -z` output (a rename entry carries a second path). */
export const statusPaths = (out: string): string[] => {
  const parts = out.split("\0");
  const paths: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;

    if (entry.length < 4) continue;
    paths.push(entry.slice(3));

    if (entry[0] === "R" || entry[0] === "C") {
      const old = parts[i + 1];

      if (old) paths.push(old);
      i += 1;
    }
  }

  return paths;
};

const stamp = (path: string): string => {
  try {
    const st = statSync(path);

    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "-";
  }
};

export interface WatcherOpts {
  readonly workspace: string;
  readonly log: Logger;
  readonly debounceMs: number;
  readonly pollMs: number;
  readonly env: () => Record<string, string>;
  /** Called after changes settle. */
  readonly onChange: () => void;
  /** Forces the polling fallback (tests). */
  readonly forcePolling?: boolean;
}

/** File watcher: inotifywait when present, else `git status --porcelain` polling every 2 s. */
export class Watcher {
  private proc: Subprocess<"ignore", "pipe", "ignore"> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private restart: ReturnType<typeof setTimeout> | null = null;
  private lastSignature: string | null = null;
  private polling = false;
  private active = false;

  constructor(private readonly opts: WatcherOpts) {}

  get mode(): "inotify" | "poll" | "off" {
    if (!this.active) return "off";

    return this.poll ? "poll" : "inotify";
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    const bin = this.opts.forcePolling ? null : findBinary("inotifywait");

    if (bin) this.startInotify(bin);
    else this.startPolling();
    this.schedule();
  }

  stop(): void {
    this.active = false;

    if (this.proc) this.proc.kill("SIGTERM");
    this.proc = null;

    if (this.poll) clearInterval(this.poll);
    this.poll = null;

    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;

    if (this.restart) clearTimeout(this.restart);
    this.restart = null;
    this.lastSignature = null;
  }

  private schedule(): void {
    if (!this.active) return;

    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;

      if (this.active) this.opts.onChange();
    }, this.opts.debounceMs);
  }

  private startInotify(bin: string): void {
    if (!existsSync(this.opts.workspace)) {
      this.restart = setTimeout(() => this.active && this.startInotify(bin), 5_000);

      return;
    }

    const proc = Bun.spawn([bin, ...inotifyArgs(this.opts.workspace)], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: this.opts.env(),
    });

    this.proc = proc;
    void (async () => {
      const decoder = new TextDecoder();
      let buf = "";

      try {
        for await (const chunk of proc.stdout) {
          buf += decoder.decode(chunk, { stream: true });
          let i: number;

          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            const space = line.indexOf(" ");
            const path = space >= 0 ? line.slice(space + 1) : line;
            const rel = relative(this.opts.workspace, path);

            if (SETTINGS_FILE_PATHS.includes(rel))
              this.opts.log.debug("settings file changed", { path: rel });
            this.schedule();
          }
        }
      } catch {
        // killed
      }

      const code = await proc.exited;

      if (this.proc === proc) this.proc = null;

      if (!this.active) return;
      this.opts.log.warn("inotifywait exited; restarting", { code });
      this.restart = setTimeout(() => this.active && this.startInotify(bin), 2_000);
    })();
  }

  private startPolling(): void {
    this.poll = setInterval(() => void this.pollOnce(), this.opts.pollMs);
  }

  /** One polling round; exposed for tests. */
  async pollOnce(): Promise<void> {
    if (this.polling || !this.active) return;
    this.polling = true;

    try {
      const ws = this.opts.workspace;

      if (!existsSync(join(ws, ".git"))) return;

      const r = await run(["git", "status", "--porcelain", "-z"], {
        cwd: ws,
        env: { ...this.opts.env(), GIT_OPTIONAL_LOCKS: "0" },
        timeoutMs: 20_000,
      });

      if (r.code !== 0) return;
      const paths = statusPaths(r.stdout);

      const signature = [
        r.stdout,
        ...paths.map((p) => stamp(join(ws, p))),
        ...SETTINGS_FILE_PATHS.map((p) => stamp(join(ws, p))),
      ].join("\n");

      if (signature !== this.lastSignature) {
        const first = this.lastSignature === null;
        this.lastSignature = signature;

        if (!first) this.schedule();
      }
    } finally {
      this.polling = false;
    }
  }
}
