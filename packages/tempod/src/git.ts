import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  TempoError,
  type ChangedFile,
  type CheckpointResult,
  type DiffScope,
  type Source,
} from "@tempo/protocol";
import { MESSAGE_BUDGET } from "./bounds.ts";
import type { TempodDb } from "./db.ts";
import { ExecError, run, tail, type ExecResult } from "./exec.ts";
import { relativeToWorkspace, resolveWorkspacePath } from "./fs.ts";

export const BIG_FILE_BYTES = 50 * 1024 * 1024;
const CKPT_REF = "refs/tempo/checkpoints/";
const SAFE_ID = /^[0-9A-Za-z_-]{1,128}$/;
const PUSH_REJECTED = /\[rejected\]|\[remote rejected\]|stale info|non-fast-forward|fetch first|rejected/i;
/** Written into .git once `git clone` finished; without it a repo is a partial clone and is cloned again. */
const CLONE_MARKER = "tempo-cloned";

/**
 * Deadline of each git op, a little under its timeout in 02, so tempod answers before the DO gives up.
 * Every git command of the op is killed (with its process group) when the deadline passes.
 */
export const GIT_OP_MS = {
  clone: 10 * 60_000 - 15_000,
  applyCheckpoint: 5 * 60_000 - 10_000,
  checkpoint: 2 * 60_000 - 5_000,
  revert: 2 * 60_000 - 5_000,
  commitAndPush: 5 * 60_000 - 10_000,
  read: 30_000 - 2_000,
  renameBranch: 30_000 - 2_000,
} as const;
const DEFAULT_GIT_MS = 60_000;

const deadlines = new AsyncLocalStorage<number>();

export type CloneMode = "create" | "wake";

export interface GitDeps {
  readonly workspace: string;
  readonly stateDir: string;
  readonly ckptIndex: string;
  readonly ckptBundle: string;
  readonly db: TempodDb;
  /** Env for git children: process env plus CA vars. */
  readonly env: () => Record<string, string>;
  /** Tests: shorter op deadlines. */
  readonly opMs?: Partial<Record<keyof typeof GIT_OP_MS, number>>;
}

export interface Changes {
  files: ChangedFile[];
  baseSha: string;
  headSha: string;
  ahead: number;
  dirty: boolean;
}

interface GitOpts {
  index?: string;
  readOnly?: boolean;
  input?: string;
  extraEnv?: Record<string, string>;
  cwd?: string;
}

export const summarize = (files: ReadonlyArray<ChangedFile>): { additions: number; deletions: number } => ({
  additions: files.reduce((n, f) => n + f.additions, 0),
  deletions: files.reduce((n, f) => n + f.deletions, 0),
});

export class Git {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: GitDeps) {}

  /** Serializes the operations that change the repo. */
  private locked<A>(f: () => Promise<A>): Promise<A> {
    const next = this.chain.then(f, f);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Runs one op under its deadline; the deadline starts now, so time spent waiting for the lock counts. */
  private op<A>(kind: keyof typeof GIT_OP_MS, lock: boolean, f: () => Promise<A>): Promise<A> {
    const deadline = Date.now() + (this.deps.opMs?.[kind] ?? GIT_OP_MS[kind]);
    const body = () =>
      deadlines.run(deadline, async () => {
        if (Date.now() >= deadline)
          throw new TempoError("INTERNAL", "Timed out waiting for another git operation.");
        return f();
      });
    return lock ? this.locked(body) : body();
  }

  private env(opts: GitOpts): Record<string, string> {
    const env: Record<string, string> = { ...this.deps.env(), GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
    if (opts.index) env["GIT_INDEX_FILE"] = opts.index;
    if (opts.readOnly) env["GIT_OPTIONAL_LOCKS"] = "0";
    return { ...env, ...opts.extraEnv };
  }

  async git(args: ReadonlyArray<string>, opts: GitOpts = {}): Promise<ExecResult> {
    const deadline = deadlines.getStore();
    const timeoutMs = deadline === undefined ? DEFAULT_GIT_MS : deadline - Date.now();
    if (timeoutMs <= 0) throw new TempoError("INTERNAL", `git ${args[0] ?? ""} timed out`);
    const r = await run(["git", ...args], {
      cwd: opts.cwd ?? this.deps.workspace,
      env: this.env(opts),
      input: opts.input,
      timeoutMs,
    });
    if (r.timedOut) throw new TempoError("INTERNAL", `git ${args[0] ?? ""} timed out`);
    return r;
  }

  async gitOk(args: ReadonlyArray<string>, opts: GitOpts = {}): Promise<string> {
    const r = await this.git(args, opts);
    if (r.code !== 0) throw new ExecError(["git", ...args], r);
    return r.stdout;
  }

  private async revParse(ref: string): Promise<string | null> {
    const r = await this.git(["rev-parse", "-q", "--verify", `${ref}^{commit}`], { readOnly: true });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async headSha(): Promise<string> {
    const sha = await this.revParse("HEAD");
    if (!sha) throw new TempoError("INTERNAL", "The repository has no commits.");
    return sha;
  }

  async currentBranch(): Promise<string | null> {
    const r = await this.git(["symbolic-ref", "--short", "-q", "HEAD"], { readOnly: true });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async validBranch(name: string): Promise<boolean> {
    const r = await this.git(["check-ref-format", "--branch", name], { readOnly: true });
    return r.code === 0 && !name.startsWith("-");
  }

  private get cloneMarker(): string {
    return join(this.deps.workspace, ".git", CLONE_MARKER);
  }

  /** True when a clone finished here: the marker exists and HEAD resolves. */
  private async cloned(): Promise<boolean> {
    if (!existsSync(this.cloneMarker)) return false;
    const r = await this.git(["rev-parse", "--verify", "-q", "HEAD"], { readOnly: true });
    return r.code === 0;
  }

  /**
   * `repo.clone` (03). A finished clone is kept, so the step can be retried. `create` checks out per
   * source; `wake` (and no mode) tracks origin/<branch> when it exists, else branches from the base.
   */
  clone(p: {
    url: string;
    branch: string;
    baseBranch: string;
    source: Source;
    author: { name: string; email: string };
    mode?: CloneMode | undefined;
  }): Promise<{ headSha: string; remoteHeadSha: string | null }> {
    return this.op("clone", true, async () => {
      const ws = this.deps.workspace;
      if (!(await this.validBranch(p.branch)) || !(await this.validBranch(p.baseBranch))) {
        throw new TempoError("VALIDATION_FAILED", "Branch name is not valid.");
      }
      try {
        if (!(await this.cloned())) {
          mkdirSync(this.deps.stateDir, { recursive: true });
          mkdirSync(ws, { recursive: true });
          if (ws !== "/" && ws !== "") {
            for (const entry of readdirSync(ws)) rmSync(join(ws, entry), { recursive: true, force: true });
          }
          const r = await this.git(["clone", "--filter=blob:none", "--", p.url, ws], {
            cwd: this.deps.stateDir,
          });
          if (r.code !== 0) throw new ExecError(["git", "clone"], r);
          writeFileSync(this.cloneMarker, `${new Date().toISOString()}\n`);
        }
        await this.gitOk(["config", "user.name", p.author.name]);
        await this.gitOk(["config", "user.email", p.author.email]);
        if ((await this.currentBranch()) !== p.branch) await this.checkoutBranch(p, p.mode ?? "wake");
        return {
          headSha: await this.headSha(),
          remoteHeadSha: await this.revParse(`refs/remotes/origin/${p.branch}`),
        };
      } catch (e) {
        if (e instanceof TempoError && e.code === "CLONE_FAILED") throw e;
        const detail =
          e instanceof ExecError
            ? tail(e.result.stderr || e.result.stdout, 2000)
            : e instanceof Error
              ? e.message
              : String(e);
        throw new TempoError("CLONE_FAILED", detail || "Could not clone the repo.");
      }
    });
  }

  private async checkoutBranch(
    p: { branch: string; baseBranch: string; source: Source },
    mode: CloneMode,
  ): Promise<void> {
    if (await this.revParse(`refs/heads/${p.branch}`)) {
      await this.gitOk(["checkout", p.branch]);
      return;
    }
    const remote = await this.revParse(`refs/remotes/origin/${p.branch}`);
    const track = mode === "create" ? p.source.kind !== "new" : remote !== null;
    if (track) {
      if (!remote) throw new TempoError("CLONE_FAILED", `The branch ${p.branch} is not on origin.`);
      await this.gitOk(["checkout", "-b", p.branch, "--track", `origin/${p.branch}`]);
      return;
    }
    if (!(await this.revParse(`refs/remotes/origin/${p.baseBranch}`))) {
      throw new TempoError("CLONE_FAILED", `The base branch ${p.baseBranch} is not on origin.`);
    }
    await this.gitOk(["checkout", "-b", p.branch, `origin/${p.baseBranch}`]);
  }

  applyCheckpoint(p: {
    bundlePath: string;
    checkpointId: string;
    branch: string;
  }): Promise<{ headSha: string }> {
    return this.op("applyCheckpoint", true, async () => {
      if (!SAFE_ID.test(p.checkpointId)) throw new TempoError("VALIDATION_FAILED", "Bad checkpoint id.");
      if (!(await this.validBranch(p.branch))) throw new TempoError("BRANCH_INVALID");
      if (!existsSync(p.bundlePath))
        throw new TempoError("CHECKPOINT_NOT_FOUND", "The bundle file does not exist.");
      const ref = CKPT_REF + p.checkpointId;
      const fetched = await this.git(["fetch", "--no-tags", p.bundlePath, `${ref}:${ref}`]);
      if (fetched.code !== 0) {
        throw new TempoError(
          "CHECKPOINT_NOT_FOUND",
          tail(fetched.stderr, 1000) || "Could not read the bundle.",
        );
      }
      await this.wrap(async () => {
        await this.gitOk(["checkout", "-B", p.branch, `${ref}^1`]);
        await this.gitOk(["read-tree", "-u", "--reset", ref]);
        await this.gitOk(["reset", "-q"]);
      });
      return { headSha: await this.headSha() };
    });
  }

  private async wrap<A>(f: () => Promise<A>): Promise<A> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof ExecError)
        throw new TempoError("INTERNAL", tail(e.result.stderr || e.result.stdout, 2000));
      throw e;
    }
  }

  /** Base of the branch diff: merge-base of HEAD and origin/<base>, else HEAD. */
  private async branchBase(baseBranch: string, head: string): Promise<string> {
    const r = await this.git(["merge-base", "HEAD", `refs/remotes/origin/${baseBranch}`], { readOnly: true });
    return r.code === 0 ? r.stdout.trim() : head;
  }

  private async untracked(index?: string): Promise<string[]> {
    const out = await this.gitOk(["ls-files", "-o", "--exclude-standard", "-z"], {
      readOnly: true,
      ...(index ? { index } : {}),
    });
    return out.split("\0").filter((p) => p !== "");
  }

  /** Runs `f` with a copy of the index in which untracked files are intent-to-add, so diffs include them. */
  private async withDiffIndex<A>(f: (index: string) => Promise<A>): Promise<A> {
    mkdirSync(this.deps.stateDir, { recursive: true });
    const index = join(
      this.deps.stateDir,
      `diff-${process.pid}-${Math.random().toString(36).slice(2)}.index`,
    );
    try {
      const real = (await this.gitOk(["rev-parse", "--git-path", "index"], { readOnly: true })).trim();
      const realPath = real.startsWith("/") ? real : join(this.deps.workspace, real);
      if (existsSync(realPath)) await copyFile(realPath, index);
      else await this.gitOk(["read-tree", "HEAD"], { index });
      const untracked = await this.untracked();
      if (untracked.length > 0) {
        await this.gitOk(["add", "-N", "--pathspec-from-file=-", "--pathspec-file-nul"], {
          index,
          input: untracked.join("\0"),
        });
      }
      return await f(index);
    } finally {
      await rm(index, { force: true });
    }
  }

  private async diffFiles(base: string, index: string): Promise<ChangedFile[]> {
    const common = ["diff", "-z", "-M", "--no-ext-diff", "--no-textconv", base];
    const [numstat, names] = await Promise.all([
      this.gitOk([...common, "--numstat"], { index, readOnly: true }),
      this.gitOk([...common, "--name-status"], { index, readOnly: true }),
    ]);
    const counts = new Map<string, { additions: number; deletions: number }>();
    const nf = numstat.split("\0");
    for (let i = 0; i < nf.length; i++) {
      const field = nf[i]!;
      if (field === "") continue;
      const [a, d, path] = field.split("\t");
      const toNum = (s: string | undefined) => (s === undefined || s === "-" ? 0 : Number(s) || 0);
      if (path === "" || path === undefined) {
        const newPath = nf[i + 2] ?? "";
        counts.set(newPath, { additions: toNum(a), deletions: toNum(d) });
        i += 2;
      } else {
        counts.set(path, { additions: toNum(a), deletions: toNum(d) });
      }
    }
    const files: ChangedFile[] = [];
    const sf = names.split("\0");
    for (let i = 0; i < sf.length; i++) {
      const code = sf[i]!;
      if (code === "") continue;
      const letter = code[0]!;
      if (letter === "R" || letter === "C") {
        const oldPath = sf[i + 1] ?? "";
        const path = sf[i + 2] ?? "";
        i += 2;
        const c = counts.get(path) ?? { additions: 0, deletions: 0 };
        files.push(letter === "R" ? { path, oldPath, status: "R", ...c } : { path, status: "A", ...c });
      } else {
        const path = sf[i + 1] ?? "";
        i += 1;
        const c = counts.get(path) ?? { additions: 0, deletions: 0 };
        files.push({ path, status: letter === "T" ? "M" : letter, ...c });
      }
    }
    return files;
  }

  /** Commits on HEAD that origin/<branch> lacks; when the branch is not on origin, commits since origin/<base>. */
  private async ahead(baseBranch: string): Promise<number> {
    const branch = await this.currentBranch();
    const remote = branch ? await this.revParse(`refs/remotes/origin/${branch}`) : null;
    const baseRemote = remote ? null : await this.revParse(`refs/remotes/origin/${baseBranch}`);
    const range = remote ? `${remote}..HEAD` : baseRemote ? `${baseRemote}..HEAD` : "HEAD";
    const r = await this.git(["rev-list", "--count", range], { readOnly: true });
    return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
  }

  changes(scope: DiffScope, baseBranch: string): Promise<Changes> {
    return this.op("read", false, () => this.readChanges(scope, baseBranch));
  }

  private async readChanges(scope: DiffScope, baseBranch: string): Promise<Changes> {
    const headSha = await this.headSha();
    const baseSha = scope === "uncommitted" ? headSha : await this.branchBase(baseBranch, headSha);
    const files = await this.withDiffIndex((index) => this.diffFiles(baseSha, index));
    const status = await this.gitOk(["status", "--porcelain", "-z"], { readOnly: true });
    return { files, baseSha, headSha, ahead: await this.ahead(baseBranch), dirty: status.length > 0 };
  }

  fileDiff(scope: DiffScope, path: string, baseBranch: string): Promise<{ diff: string }> {
    return this.op("read", false, () => this.readFileDiff(scope, path, baseBranch));
  }

  private async readFileDiff(scope: DiffScope, path: string, baseBranch: string): Promise<{ diff: string }> {
    const abs = resolveWorkspacePath(this.deps.workspace, path);
    const rel = relativeToWorkspace(this.deps.workspace, abs);
    const headSha = await this.headSha();
    const base = scope === "uncommitted" ? headSha : await this.branchBase(baseBranch, headSha);
    return this.withDiffIndex(async (index) => {
      const files = await this.diffFiles(base, index);
      const file = files.find((f) => f.path === rel || f.oldPath === rel);
      if (!file) {
        const inBase = await this.git(["cat-file", "-e", `${base}:${rel}`], { readOnly: true });
        if (!existsSync(abs) && inBase.code !== 0) throw new TempoError("NOT_FOUND");
        return { diff: "" };
      }
      const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
      const diff = await this.gitOk(
        ["--literal-pathspecs", "diff", "-M", "-U3", "--no-color", "--no-ext-diff", base, "--", ...paths],
        { index, readOnly: true },
      );
      if (Buffer.byteLength(JSON.stringify(diff)) > MESSAGE_BUDGET) throw new TempoError("FILE_TOO_LARGE");
      return { diff };
    });
  }

  private async identityEnv(): Promise<Record<string, string>> {
    const r = await this.git(["config", "user.email"], { readOnly: true });
    if (r.code === 0 && r.stdout.trim()) return {};
    return {
      GIT_AUTHOR_NAME: "Tempo",
      GIT_AUTHOR_EMAIL: "tempo@localhost",
      GIT_COMMITTER_NAME: "Tempo",
      GIT_COMMITTER_EMAIL: "tempo@localhost",
    };
  }

  /** The checkpoint script of 01 (Durability), with its own index file. */
  checkpoint(
    p: { checkpointId: string; turnId: string | null },
    baseBranch: string,
  ): Promise<CheckpointResult> {
    return this.op("checkpoint", true, () =>
      this.wrap(async () => {
        if (!SAFE_ID.test(p.checkpointId)) throw new TempoError("VALIDATION_FAILED", "Bad checkpoint id.");
        const index = this.deps.ckptIndex;
        mkdirSync(this.deps.stateDir, { recursive: true });
        await this.headSha();
        await this.gitOk(["read-tree", "HEAD"], { index });
        // Untracked relative to the checkpoint index (HEAD), not the user's index.
        const excludes: string[] = [];
        for (const path of await this.untracked(index)) {
          try {
            if (statSync(join(this.deps.workspace, path)).size > BIG_FILE_BYTES)
              excludes.push(`:(exclude,literal)${path}`);
          } catch {
            // vanished
          }
        }
        await this.gitOk(["add", "-A", "--", ".", ...excludes], { index });
        const tree = (await this.gitOk(["write-tree"], { index })).trim();
        const parent = await this.headSha();
        const last = this.deps.db.getMeta("ckpt.last");
        if (last) {
          const prev = JSON.parse(last) as { tree?: string; parent?: string };
          if (prev.tree === tree && prev.parent === parent) return { unchanged: true as const };
        }
        const msg = `tempo checkpoint ${p.checkpointId} turn ${p.turnId || "none"}`;
        const commit = (
          await this.gitOk(["commit-tree", tree, "-p", parent, "-m", msg], {
            index,
            extraEnv: await this.identityEnv(),
          })
        ).trim();
        const ref = CKPT_REF + p.checkpointId;
        await this.gitOk(["update-ref", ref, commit]);
        const base = await this.checkpointBase(parent, baseBranch);
        const bundle = this.deps.ckptBundle;
        await rm(bundle, { force: true });
        await this.gitOk(["bundle", "create", bundle, ref, ...(base.exclude ? [`^${base.sha}`] : [])]);
        const bundleBytes = statSync(bundle).size;
        this.deps.db.setMeta("ckpt.last", JSON.stringify({ tree, parent }));
        return { commit, tree, parent, base: base.sha, bundlePath: bundle, bundleBytes };
      }),
    );
  }

  /**
   * merge-base with origin/<base>; else with origin/<current branch>; else the root commit, and the
   * bundle then holds the whole history so it is valid on any clone.
   */
  private async checkpointBase(
    parent: string,
    baseBranch: string,
  ): Promise<{ sha: string; exclude: boolean }> {
    const candidates = [`refs/remotes/origin/${baseBranch}`];
    const branch = await this.currentBranch();
    if (branch) candidates.push(`refs/remotes/origin/${branch}`);
    for (const ref of candidates) {
      const r = await this.git(["merge-base", parent, ref], { readOnly: true });
      if (r.code === 0 && r.stdout.trim()) return { sha: r.stdout.trim(), exclude: true };
    }
    const roots = (await this.gitOk(["rev-list", "--max-parents=0", parent], { readOnly: true }))
      .trim()
      .split("\n");
    return { sha: roots[roots.length - 1] ?? parent, exclude: false };
  }

  revert(p: { checkpointId: string }): Promise<{ headSha: string }> {
    return this.op("revert", true, async () => {
      if (!SAFE_ID.test(p.checkpointId)) throw new TempoError("CHECKPOINT_NOT_FOUND");
      const ref = CKPT_REF + p.checkpointId;
      if (!(await this.revParse(ref))) throw new TempoError("CHECKPOINT_NOT_FOUND");
      return this.wrap(async () => {
        await this.gitOk(["clean", "-fd"]);
        await this.gitOk(["reset", "--hard", `${ref}^1`]);
        await this.gitOk(["read-tree", "-u", "--reset", ref]);
        await this.gitOk(["reset", "-q"]);
        return { headSha: await this.headSha() };
      });
    });
  }

  commitAndPush(
    p: { message: string; branch: string; forceWithLeaseSha?: string | null | undefined },
    baseBranch: string,
  ): Promise<{ commitSha: string }> {
    return this.op("commitAndPush", true, async () => {
      if (!(await this.validBranch(p.branch))) throw new TempoError("BRANCH_INVALID");
      const lease = p.forceWithLeaseSha ?? null;
      if (lease !== null && !/^[0-9a-f]{4,64}$/i.test(lease))
        throw new TempoError("VALIDATION_FAILED", "Bad lease sha.");
      await this.wrap(() => this.gitOk(["add", "-A"]));
      const staged = await this.git(["diff", "--cached", "--quiet"]);
      let committed = false;
      if (staged.code === 1) {
        await this.wrap(() => this.gitOk(["commit", "-q", "-m", p.message]));
        committed = true;
      }
      const head = await this.headSha();
      if (!committed) {
        const remote = await this.revParse(`refs/remotes/origin/${p.branch}`);
        let needed: boolean;
        if (lease !== null) needed = remote !== head;
        else if (remote) {
          const r = await this.git(["rev-list", "--count", `${remote}..HEAD`], { readOnly: true });
          needed = (Number(r.stdout.trim()) || 0) > 0;
        } else needed = (await this.ahead(baseBranch)) > 0;
        if (!needed) throw new TempoError("NOTHING_TO_COMMIT");
      }
      const args = [
        "push",
        "-u",
        ...(lease !== null ? [`--force-with-lease=${p.branch}:${lease}`] : []),
        "origin",
        p.branch,
      ];
      const r = await this.git(args);
      if (r.code !== 0) {
        const msg = tail(r.stderr || r.stdout, 2000);
        throw new TempoError(PUSH_REJECTED.test(msg) ? "PUSH_REJECTED" : "INTERNAL", msg);
      }
      return { commitSha: head };
    });
  }

  renameBranch(p: { from: string; to: string }): Promise<Record<string, never>> {
    return this.op("renameBranch", true, async () => {
      if (!(await this.validBranch(p.to))) throw new TempoError("BRANCH_INVALID");
      const from = await this.revParse(`refs/heads/${p.from}`);
      const to = await this.revParse(`refs/heads/${p.to}`);
      if (!from) {
        if (to) return {};
        throw new TempoError("NOT_FOUND", "The branch does not exist.");
      }
      if (p.from === p.to) return {};
      await this.wrap(() => this.gitOk(["branch", "-m", p.from, p.to]));
      return {};
    });
  }
}
