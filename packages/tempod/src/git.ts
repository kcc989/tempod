import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  TempoError,
  type ChangedFile,
  type CheckpointResult,
  type DiffScope,
  type Source,
} from "@tempo/protocol";
import type { TempodDb } from "./db.ts";
import { ExecError, run, tail, type ExecResult } from "./exec.ts";
import { relativeToWorkspace, resolveWorkspacePath } from "./fs.ts";

export const BIG_FILE_BYTES = 50 * 1024 * 1024;
const CKPT_REF = "refs/tempo/checkpoints/";
const SAFE_ID = /^[0-9A-Za-z_-]{1,128}$/;
const PUSH_REJECTED = /\[rejected\]|\[remote rejected\]|stale info|non-fast-forward|fetch first|rejected/i;

export interface GitDeps {
  readonly workspace: string;
  readonly stateDir: string;
  readonly ckptIndex: string;
  readonly ckptBundle: string;
  readonly db: TempodDb;
  /** Env for git children: process env plus CA vars. */
  readonly env: () => Record<string, string>;
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

  private env(opts: GitOpts): Record<string, string> {
    const env: Record<string, string> = { ...this.deps.env(), GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
    if (opts.index) env["GIT_INDEX_FILE"] = opts.index;
    if (opts.readOnly) env["GIT_OPTIONAL_LOCKS"] = "0";
    return { ...env, ...opts.extraEnv };
  }

  git(args: ReadonlyArray<string>, opts: GitOpts = {}): Promise<ExecResult> {
    return run(["git", ...args], { cwd: opts.cwd ?? this.deps.workspace, env: this.env(opts), input: opts.input });
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

  private async isRepo(): Promise<boolean> {
    if (!existsSync(join(this.deps.workspace, ".git"))) return false;
    const r = await this.git(["rev-parse", "--verify", "-q", "HEAD"], { readOnly: true });
    return r.code === 0;
  }

  clone(p: {
    url: string;
    branch: string;
    baseBranch: string;
    source: Source;
    author: { name: string; email: string };
  }): Promise<{ headSha: string; remoteHeadSha: string | null }> {
    return this.locked(async () => {
      const ws = this.deps.workspace;
      if (!(await this.validBranch(p.branch)) || !(await this.validBranch(p.baseBranch))) {
        throw new TempoError("VALIDATION_FAILED", "Branch name is not valid.");
      }
      const fail = (e: unknown): never => {
        const detail = e instanceof ExecError ? tail(e.result.stderr || e.result.stdout, 2000) : String(e);
        throw new TempoError("CLONE_FAILED", detail || "Could not clone the repo.");
      };
      if (!(await this.isRepo())) {
        try {
          mkdirSync(this.deps.stateDir, { recursive: true });
          mkdirSync(ws, { recursive: true });
          if (ws !== "/" && ws !== "") {
            for (const entry of readdirSync(ws)) rmSync(join(ws, entry), { recursive: true, force: true });
          }
        } catch (e) {
          fail(e);
        }
        const r = await run(["git", "clone", "--filter=blob:none", "--", p.url, ws], {
          env: this.env({}),
          cwd: this.deps.stateDir,
        });
        if (r.code !== 0) fail(new ExecError(["git", "clone"], r));
      }
      try {
        await this.gitOk(["config", "user.name", p.author.name]);
        await this.gitOk(["config", "user.email", p.author.email]);
        const current = await this.currentBranch();
        if (current !== p.branch) {
          if (await this.revParse(`refs/heads/${p.branch}`)) {
            await this.gitOk(["checkout", p.branch]);
          } else if (await this.revParse(`refs/remotes/origin/${p.branch}`)) {
            await this.gitOk(["checkout", "-b", p.branch, "--track", `origin/${p.branch}`]);
          } else {
            await this.gitOk(["checkout", "-b", p.branch, `origin/${p.baseBranch}`]);
          }
        }
        return {
          headSha: await this.headSha(),
          remoteHeadSha: await this.revParse(`refs/remotes/origin/${p.branch}`),
        };
      } catch (e) {
        if (e instanceof TempoError) throw e;
        return fail(e);
      }
    });
  }

  applyCheckpoint(p: { bundlePath: string; checkpointId: string; branch: string }): Promise<{ headSha: string }> {
    return this.locked(async () => {
      if (!SAFE_ID.test(p.checkpointId)) throw new TempoError("VALIDATION_FAILED", "Bad checkpoint id.");
      if (!(await this.validBranch(p.branch))) throw new TempoError("BRANCH_INVALID");
      if (!existsSync(p.bundlePath)) throw new TempoError("CHECKPOINT_NOT_FOUND", "The bundle file does not exist.");
      const ref = CKPT_REF + p.checkpointId;
      const fetched = await this.git(["fetch", "--no-tags", p.bundlePath, `${ref}:${ref}`]);
      if (fetched.code !== 0) {
        throw new TempoError("CHECKPOINT_NOT_FOUND", tail(fetched.stderr, 1000) || "Could not read the bundle.");
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
      if (e instanceof ExecError) throw new TempoError("INTERNAL", tail(e.result.stderr || e.result.stdout, 2000));
      throw e;
    }
  }

  /** Base of the branch diff: merge-base of HEAD and origin/<base>, else HEAD. */
  private async branchBase(baseBranch: string, head: string): Promise<string> {
    const r = await this.git(["merge-base", "HEAD", `refs/remotes/origin/${baseBranch}`], { readOnly: true });
    return r.code === 0 ? r.stdout.trim() : head;
  }

  private async untracked(): Promise<string[]> {
    const out = await this.gitOk(["ls-files", "-o", "--exclude-standard", "-z"], { readOnly: true });
    return out.split("\0").filter((p) => p !== "");
  }

  /** Runs `f` with a copy of the index in which untracked files are intent-to-add, so diffs include them. */
  private async withDiffIndex<A>(f: (index: string) => Promise<A>): Promise<A> {
    mkdirSync(this.deps.stateDir, { recursive: true });
    const index = join(this.deps.stateDir, `diff-${process.pid}-${Math.random().toString(36).slice(2)}.index`);
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

  async changes(scope: DiffScope, baseBranch: string): Promise<Changes> {
    const headSha = await this.headSha();
    const baseSha = scope === "uncommitted" ? headSha : await this.branchBase(baseBranch, headSha);
    const files = await this.withDiffIndex((index) => this.diffFiles(baseSha, index));
    const status = await this.gitOk(["status", "--porcelain", "-z"], { readOnly: true });
    return { files, baseSha, headSha, ahead: await this.ahead(baseBranch), dirty: status.length > 0 };
  }

  async fileDiff(scope: DiffScope, path: string, baseBranch: string): Promise<{ diff: string }> {
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
    return this.locked(() =>
      this.wrap(async () => {
        if (!SAFE_ID.test(p.checkpointId)) throw new TempoError("VALIDATION_FAILED", "Bad checkpoint id.");
        const index = this.deps.ckptIndex;
        mkdirSync(this.deps.stateDir, { recursive: true });
        await this.headSha();
        const excludes: string[] = [];
        for (const path of await this.untracked()) {
          try {
            if (statSync(join(this.deps.workspace, path)).size > BIG_FILE_BYTES) excludes.push(`:(exclude,literal)${path}`);
          } catch {
            // vanished
          }
        }
        await this.gitOk(["read-tree", "HEAD"], { index });
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
          await this.gitOk(["commit-tree", tree, "-p", parent, "-m", msg], { index, extraEnv: await this.identityEnv() })
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
  private async checkpointBase(parent: string, baseBranch: string): Promise<{ sha: string; exclude: boolean }> {
    const candidates = [`refs/remotes/origin/${baseBranch}`];
    const branch = await this.currentBranch();
    if (branch) candidates.push(`refs/remotes/origin/${branch}`);
    for (const ref of candidates) {
      const r = await this.git(["merge-base", parent, ref], { readOnly: true });
      if (r.code === 0 && r.stdout.trim()) return { sha: r.stdout.trim(), exclude: true };
    }
    const roots = (await this.gitOk(["rev-list", "--max-parents=0", parent], { readOnly: true })).trim().split("\n");
    return { sha: roots[roots.length - 1] ?? parent, exclude: false };
  }

  revert(p: { checkpointId: string }): Promise<{ headSha: string }> {
    return this.locked(async () => {
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
    return this.locked(async () => {
      if (!(await this.validBranch(p.branch))) throw new TempoError("BRANCH_INVALID");
      const lease = p.forceWithLeaseSha ?? null;
      if (lease !== null && !/^[0-9a-f]{4,64}$/i.test(lease)) throw new TempoError("VALIDATION_FAILED", "Bad lease sha.");
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
      const args = ["push", "-u", ...(lease !== null ? [`--force-with-lease=${p.branch}:${lease}`] : []), "origin", p.branch];
      const r = await this.git(args);
      if (r.code !== 0) {
        const msg = tail(r.stderr || r.stdout, 2000);
        throw new TempoError(PUSH_REJECTED.test(msg) ? "PUSH_REJECTED" : "INTERNAL", msg);
      }
      return { commitSha: head };
    });
  }

  renameBranch(p: { from: string; to: string }): Promise<Record<string, never>> {
    return this.locked(async () => {
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
