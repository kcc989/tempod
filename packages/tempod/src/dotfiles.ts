import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isDotfilePath, TempoError } from "@tempo/protocol";
import { Exit, Schema } from "effect";
import { run, tail, type ExecResult } from "./exec.ts";
import { errorText, type Logger } from "./log.ts";

/** A little under the 2 min request timeout (02), so tempod answers first. */
export const DOTFILES_APPLY_MS = 2 * 60_000 - 5_000;

export interface DotfilesDeps {
  readonly home: string;
  readonly stateDir: string;
  /** `/etc/tempo/home-defaults` in the image. */
  readonly defaultsDir: string;
  readonly env: () => Record<string, string>;
  readonly log: Logger;
  readonly opMs?: number;
}

export interface DotfilesSource {
  readonly url: string;
  readonly sha: string;
}

export interface DotfilesResult {
  applied: string[];
  restored: string[];
}

const decodeRecord = Schema.decodeUnknownExit(
  Schema.fromJsonString(Schema.Struct({ paths: Schema.Array(Schema.String) })),
);

const lstatOrNull = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

/** 01, Shell and dotfiles: copies the owner's shell files from a commit into the home folder. */
export class Dotfiles {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: DotfilesDeps) {}
  private get repo(): string {
    return join(this.deps.stateDir, "dotfiles");
  }
  private get recordPath(): string {
    return join(this.deps.stateDir, "dotfiles.json");
  }
  apply(source: DotfilesSource | null): Promise<DotfilesResult> {
    const next = this.chain.then(
      () => this.applyNow(source),
      () => this.applyNow(source),
    );

    this.chain = next.catch(() => undefined);

    return next;
  }
  private async applyNow(source: DotfilesSource | null): Promise<DotfilesResult> {
    if (source && !/^[0-9a-f]{40}$/.test(source.sha))
      throw new TempoError("VALIDATION_FAILED", "Commit is not valid.");
    const deadline = Date.now() + (this.deps.opMs ?? DOTFILES_APPLY_MS);
    const previous = this.readRecord();
    const applied = source ? await this.copyCommit(source, deadline) : [];
    const restored: string[] = [];

    for (const path of previous) {
      if (applied.includes(path)) continue;

      if (this.restore(path)) restored.push(path);
    }

    if (source) {
      mkdirSync(this.deps.stateDir, { recursive: true });
      writeFileSync(this.recordPath, `${JSON.stringify({ paths: applied })}\n`);
    } else {
      rmSync(this.recordPath, { force: true });
    }

    return { applied, restored };
  }
  private readRecord(): string[] {
    let text: string;

    try {
      text = readFileSync(this.recordPath, "utf8");
    } catch {
      return [];
    }

    const exit = decodeRecord(text);

    return Exit.isSuccess(exit) ? exit.value.paths.filter(isDotfilePath) : [];
  }
  private async git(args: ReadonlyArray<string>, deadline: number): Promise<ExecResult> {
    const timeoutMs = deadline - Date.now();

    if (timeoutMs <= 0) throw new TempoError("INTERNAL", "Applying the shell files timed out.");

    const r = await run(["git", ...args], {
      cwd: this.repo,
      env: { ...this.deps.env(), GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      timeoutMs,
    });

    if (r.timedOut) throw new TempoError("INTERNAL", "Applying the shell files timed out.");

    return r;
  }
  private async hasCommit(sha: string, deadline: number): Promise<boolean> {
    return (await this.git(["cat-file", "-e", `${sha}^{commit}`], deadline)).code === 0;
  }
  /** Fetches the commit read-only, checks it out detached, and copies its regular files into the home folder. */
  private async copyCommit(source: DotfilesSource, deadline: number): Promise<string[]> {
    if (!existsSync(join(this.repo, ".git"))) {
      rmSync(this.repo, { recursive: true, force: true });
      mkdirSync(this.repo, { recursive: true });
      const init = await this.git(["init", "--quiet"], deadline);

      if (init.code !== 0)
        throw new TempoError("INTERNAL", `Could not prepare the shell files: ${tail(init.stderr, 500)}`);
    }

    if (!(await this.hasCommit(source.sha, deadline))) {
      const heads = await this.git(
        ["fetch", "--quiet", "--no-tags", "--", source.url, "+refs/heads/*:refs/remotes/origin/*"],
        deadline,
      );

      if (!(await this.hasCommit(source.sha, deadline))) {
        const exact = await this.git(
          ["fetch", "--quiet", "--no-tags", "--", source.url, source.sha],
          deadline,
        );

        if (!(await this.hasCommit(source.sha, deadline)))
          throw new TempoError(
            "INTERNAL",
            `Could not fetch the shell files: ${tail(exact.stderr || heads.stderr, 1000) || "the commit is missing"}`,
          );
      }
    }

    const checkout = await this.git(["checkout", "--quiet", "--detach", "--force", source.sha], deadline);

    if (checkout.code !== 0)
      throw new TempoError("INTERNAL", `Could not check out the shell files: ${tail(checkout.stderr, 1000)}`);
    const tree = await this.git(["ls-tree", "-r", "-z", "--full-tree", source.sha], deadline);

    if (tree.code !== 0) throw new TempoError("INTERNAL", "Could not list the shell files.");
    const applied: string[] = [];
    const skipped: string[] = [];

    for (const entry of tree.stdout.split("\0")) {
      const tab = entry.indexOf("\t");

      if (tab < 0) continue;
      const [mode, type] = entry.slice(0, tab).split(" ");
      const path = entry.slice(tab + 1);

      if (type !== "blob" || (mode !== "100644" && mode !== "100755") || !isDotfilePath(path)) {
        skipped.push(path);
        continue;
      }

      if (this.place(path, join(this.repo, path), mode === "100755" ? 0o755 : 0o644)) applied.push(path);
      else skipped.push(path);
    }

    if (skipped.length > 0) this.deps.log.warn("shell files skipped", { count: skipped.length });

    return applied.sort();
  }
  /** Creates the parent folders of `path` under home; false when one of them is not a plain folder. */
  private parentReady(path: string): boolean {
    const segments = path.split("/").slice(0, -1);
    let dir = this.deps.home;

    for (const segment of segments) {
      dir = join(dir, segment);
      const st = lstatOrNull(dir);

      if (st === null) mkdirSync(dir);
      else if (!st.isDirectory()) return false;
    }

    return true;
  }
  /** Writes a copy of `from` at home/`path`, replacing a file or a symlink but never following one. */
  private place(path: string, from: string, mode: number): boolean {
    const target = join(this.deps.home, path);
    const tmp = `${target}.tempod-tmp`;

    try {
      if (!this.parentReady(path) || lstatOrNull(target)?.isDirectory()) return false;
      rmSync(tmp, { force: true });
      writeFileSync(tmp, readFileSync(from));
      chmodSync(tmp, mode);
      renameSync(tmp, target);

      return true;
    } catch (e) {
      rmSync(tmp, { force: true });
      this.deps.log.warn("shell file not written", { error: errorText(e) });

      return false;
    }
  }
  /** Restores home/`path` from the image defaults, or deletes it when there is no default. */
  private restore(path: string): boolean {
    const fallback = join(this.deps.defaultsDir, path);
    const st = lstatOrNull(fallback);

    if (st?.isFile()) return this.place(path, fallback, st.mode & 0o777);
    let dir = this.deps.home;

    for (const segment of path.split("/").slice(0, -1)) {
      dir = join(dir, segment);
      const parent = lstatOrNull(dir);

      if (parent === null) return true;

      if (!parent.isDirectory()) return false;
    }

    const target = join(this.deps.home, path);
    const current = lstatOrNull(target);

    if (current === null) return true;

    if (current.isDirectory()) return false;

    try {
      unlinkSync(target);

      return true;
    } catch (e) {
      this.deps.log.warn("shell file not removed", { error: errorText(e) });

      return false;
    }
  }
}
