import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ChangedFile, CheckpointResult } from "@tempo/protocol";
import { TempodDb } from "../src/db.ts";
import { Git } from "../src/git.ts";
import {
  cleanupDirs,
  DoClient,
  git,
  makeOrigin,
  startTempod,
  testConfig,
  tmpDir,
  writeFile,
  type Harness,
} from "./helpers.ts";

afterAll(cleanupDirs);

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const x of harnesses.splice(0)) await x.close();
});

const T = 60_000;
const BRANCH = "tempo/lisbon";
const author = { name: "Ada Lovelace", email: "1+ada@users.noreply.github.com" };

type Origin = Awaited<ReturnType<typeof makeOrigin>>;

const boot = async (origin?: Origin) => {
  const o = origin ?? (await makeOrigin());
  const h = startTempod();
  harnesses.push(h);
  const c = new DoClient(h.base);
  await c.hello();
  await c.waitEvent("incarnation.changed");
  const ws = h.config.workspace;
  const clone = (extra: Record<string, unknown> = {}) =>
    c.ok<{ headSha: string; remoteHeadSha: string | null }>(
      "repo.clone",
      {
        url: o.url,
        branch: BRANCH,
        baseBranch: "main",
        source: { kind: "new" },
        author,
        mode: "create",
        ...extra,
      },
      60_000,
    );
  const g = (...args: string[]) => git(ws, ...args);
  return { origin: o, h, c, ws, clone, g };
};

/** Pushes a commit to `branch` on origin from the seed clone. */
const pushToOrigin = async (
  o: Origin,
  branch: string,
  file: string,
  content: string,
  from = "main",
): Promise<string> => {
  await git(o.seed, "fetch", "-q", "origin");
  await git(o.seed, "checkout", "-q", "-B", branch, `origin/${from}`);
  writeFileSync(join(o.seed, file), content);
  await git(o.seed, "add", "-A");
  await git(o.seed, "commit", "-q", "-m", `seed ${file}`);
  await git(o.seed, "push", "-q", "-f", "origin", `${branch}:${branch}`);
  return git(o.seed, "rev-parse", "HEAD");
};

const byPath = (files: ReadonlyArray<ChangedFile>) => Object.fromEntries(files.map((f) => [f.path, f]));

describe("repo.clone", () => {
  test(
    "create, new: branches from origin/<base>, sets the author, and is idempotent",
    async () => {
      const { origin, c, ws, clone, g } = await boot();
      const mainSha = await git(origin.bare, "rev-parse", "main");
      const r = await clone();
      expect(r.headSha).toBe(mainSha);
      expect(r.remoteHeadSha).toBeNull();
      expect(await g("symbolic-ref", "--short", "HEAD")).toBe(BRANCH);
      expect(await g("config", "user.name")).toBe(author.name);
      expect(await g("config", "user.email")).toBe(author.email);
      expect(existsSync(join(ws, ".git", "tempo-cloned"))).toBe(true);
      writeFileSync(join(ws, "keep.txt"), "work in progress\n");
      const again = await clone();
      expect(again.headSha).toBe(mainSha);
      expect(readFileSync(join(ws, "keep.txt"), "utf8")).toBe("work in progress\n");
      const changed = await c.waitEvent(
        "git.changed",
        (e) => e.files.some((f) => f.path === "keep.txt"),
        10_000,
      );
      expect(changed.additions).toBe(1);
    },
    T,
  );

  test(
    "create, new: an old branch of the same name on origin is ignored",
    async () => {
      const origin = await makeOrigin();
      await pushToOrigin(origin, BRANCH, "stale.txt", "from an archived workspace\n");
      const { clone, ws } = await boot(origin);
      const mainSha = await git(origin.bare, "rev-parse", "main");
      const r = await clone();
      expect(r.headSha).toBe(mainSha);
      expect(r.remoteHeadSha).not.toBeNull();
      expect(existsSync(join(ws, "stale.txt"))).toBe(false);
    },
    T,
  );

  test(
    "create, branch and pr: track origin/<branch> and report its head; a missing branch fails",
    async () => {
      const origin = await makeOrigin();
      const sha = await pushToOrigin(origin, "feature/x", "feature.txt", "feature\n");
      const a = await boot(origin);
      const r = await a.clone({ branch: "feature/x", source: { kind: "branch" } });
      expect(r.headSha).toBe(sha);
      expect(r.remoteHeadSha).toBe(sha);
      expect(await a.g("rev-parse", "--abbrev-ref", "feature/x@{upstream}")).toBe("origin/feature/x");
      const b = await boot(origin);
      const pr = await b.clone({ branch: "feature/x", source: { kind: "pr", number: 7 } });
      expect(pr.remoteHeadSha).toBe(sha);
      const missing = await (
        await boot(origin)
      ).c.req("repo.clone", {
        url: origin.url,
        branch: "nope",
        baseBranch: "main",
        source: { kind: "branch" },
        author,
        mode: "create",
      });
      expect(missing).toMatchObject({ ok: false, error: { code: "CLONE_FAILED" } });
    },
    T,
  );

  test(
    "wake (and no mode): tracks origin/<branch> when it exists, else branches from the base",
    async () => {
      const origin = await makeOrigin();
      const sha = await pushToOrigin(origin, BRANCH, "pushed.txt", "pushed\n");
      const a = await boot(origin);
      const r = await a.clone({ mode: "wake" });
      expect(r.headSha).toBe(sha);
      expect(r.remoteHeadSha).toBe(sha);
      const b = await boot(origin);
      const noMode = await b.c.ok<{ headSha: string }>("repo.clone", {
        url: origin.url,
        branch: BRANCH,
        baseBranch: "main",
        source: { kind: "new" },
        author,
      });
      expect(noMode.headSha).toBe(sha);
      const c = await boot(origin);
      const fresh = await c.clone({ mode: "wake", branch: "tempo/other" });
      expect(fresh.headSha).toBe(await git(origin.bare, "rev-parse", "main"));
      expect(fresh.remoteHeadSha).toBeNull();
    },
    T,
  );

  test(
    "a partial clone is wiped and cloned again; bad input fails with its code",
    async () => {
      const { ws, clone, c, origin } = await boot();
      await git(ws, "init", "-q");
      writeFileSync(join(ws, "junk.txt"), "left by a failed clone\n");
      const r = await clone();
      expect(r.headSha).toBe(await git(origin.bare, "rev-parse", "main"));
      expect(existsSync(join(ws, "junk.txt"))).toBe(false);
      expect(existsSync(join(ws, "README.md"))).toBe(true);
      expect(c.closed).toBeNull();
      const other = await boot();
      const badUrl = await other.c.req(
        "repo.clone",
        {
          url: "file:///nonexistent/repo.git",
          branch: "tempo/x",
          baseBranch: "main",
          source: { kind: "new" },
          author,
        },
        60_000,
      );
      expect(badUrl).toMatchObject({ ok: false, error: { code: "CLONE_FAILED" } });
      const badName = await other.c.req("repo.clone", {
        url: origin.url,
        branch: "bad..name",
        baseBranch: "main",
        source: { kind: "new" },
        author,
      });
      expect(badName).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    },
    T,
  );
});

describe("git.checkpoint and repo.applyCheckpoint", () => {
  test(
    "the 01 script: own index, untracked included, ignored excluded; HEAD, branch and index untouched",
    async () => {
      const { c, ws, clone, g, h } = await boot();
      await clone();
      writeFileSync(join(ws, "a.txt"), "one\nTWO\nthree\n");
      writeFile(join(ws, "src", "new.ts"), "export const x = 1;\n");
      writeFile(join(ws, "ignored", "cache.bin"), "ignored\n");
      writeFileSync(join(ws, "debug.log"), "ignored too\n");
      writeFileSync(join(ws, "staged.txt"), "staged\n");
      await g("add", "staged.txt");
      const head = await g("rev-parse", "HEAD");
      const indexTree = await g("write-tree");
      const status = await g("status", "--porcelain");
      const r = await c.ok<CheckpointResult>("git.checkpoint", {
        checkpointId: "01CKPTA",
        turnId: "t1",
        reason: "turn_end",
      });
      if ("unchanged" in r) throw new Error("expected a checkpoint");
      expect(r.parent).toBe(head);
      expect(r.base).toBe(head);
      expect(r.bundlePath).toBe(h.config.ckptBundle);
      expect(r.bundleBytes).toBe(readFileSync(r.bundlePath).byteLength);
      expect(await g("rev-parse", "HEAD")).toBe(head);
      expect(await g("symbolic-ref", "--short", "HEAD")).toBe(BRANCH);
      expect(await g("write-tree")).toBe(indexTree);
      expect(await g("status", "--porcelain")).toBe(status);
      expect(await g("rev-parse", "refs/tempo/checkpoints/01CKPTA")).toBe(r.commit);
      expect(await g("log", "-1", "--format=%s", r.commit)).toBe("tempo checkpoint 01CKPTA turn t1");
      const files = (await g("ls-tree", "-r", "--name-only", r.commit)).split("\n");
      expect(files).toContain("src/new.ts");
      expect(files).toContain("staged.txt");
      expect(files).not.toContain("debug.log");
      expect(files).not.toContain("ignored/cache.bin");
      expect(await g("show", `${r.commit}:a.txt`)).toBe("one\nTWO\nthree");
      expect(await g("bundle", "verify", r.bundlePath)).toBeDefined();
      const again = await c.ok("git.checkpoint", {
        checkpointId: "01CKPTB",
        turnId: null,
        reason: "pre_sleep",
      });
      expect(again).toEqual({ unchanged: true });
      const bad = await c.req("git.checkpoint", { checkpointId: "../x", turnId: null, reason: "turn_end" });
      expect(bad).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    },
    T,
  );

  test(
    "a checkpoint retry recovers its original bundle without overwriting its tree",
    async () => {
      const { c, ws, clone, g, h } = await boot();
      await clone();
      writeFileSync(join(ws, "a.txt"), "saved tree\n");
      const params = { checkpointId: "01RETRY", turnId: "t1", reason: "turn_end" };
      const first = await c.ok<CheckpointResult>("git.checkpoint", params);
      if ("unchanged" in first) throw new Error("expected checkpoint");
      writeFileSync(join(ws, "a.txt"), "later unsaved edits\n");
      rmSync(h.config.ckptBundle);
      const retried = await c.ok<CheckpointResult>("git.checkpoint", params);
      expect(retried).toEqual(first);
      expect(await g("show", `${first.commit}:a.txt`)).toBe("saved tree");
      expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("later unsaved edits\n");
      expect(await g("bundle", "verify", first.bundlePath)).toBeDefined();
    },
    T,
  );

  test(
    "untracked files over 50 MiB stay out, also when only the user's index has them",
    async () => {
      const { c, ws, clone, g } = await boot();
      await clone();
      const big = join(ws, "big.bin");
      writeFileSync(big, "");
      truncateSync(big, 51 * 1024 * 1024);
      const staged = join(ws, "staged-big.bin");
      writeFileSync(staged, "");
      truncateSync(staged, 51 * 1024 * 1024);
      await g("add", "staged-big.bin");
      writeFileSync(join(ws, "small.txt"), "small\n");
      const r = await c.ok<CheckpointResult>(
        "git.checkpoint",
        { checkpointId: "01BIG", turnId: null, reason: "turn_end" },
        60_000,
      );
      if ("unchanged" in r) throw new Error("expected a checkpoint");
      const files = (await g("ls-tree", "-r", "--name-only", r.commit)).split("\n");
      expect(files).toContain("small.txt");
      expect(files).not.toContain("big.bin");
      expect(files).not.toContain("staged-big.bin");
    },
    T,
  );

  test(
    "applyCheckpoint on a fresh clone brings back HEAD and the working tree",
    async () => {
      const a = await boot();
      await a.clone();
      writeFileSync(join(a.ws, "a.txt"), "committed change\n");
      await a.g("commit", "-q", "-am", "local commit");
      const head = await a.g("rev-parse", "HEAD");
      writeFileSync(join(a.ws, "README.md"), "uncommitted\n");
      writeFile(join(a.ws, "notes", "todo.md"), "untracked\n");
      rmSync(join(a.ws, "gone.txt"));
      const r = await a.c.ok<CheckpointResult>("git.checkpoint", {
        checkpointId: "01APPLY",
        turnId: "t1",
        reason: "pre_sleep",
      });
      if ("unchanged" in r) throw new Error("expected a checkpoint");
      const bundle = join(tmpDir("bundle-"), "restore.bundle");
      copyFileSync(r.bundlePath, bundle);

      const b = await boot(a.origin);
      await b.clone({ mode: "wake" });
      const applied = await b.c.ok<{ headSha: string }>("repo.applyCheckpoint", {
        bundlePath: bundle,
        checkpointId: "01APPLY",
        branch: BRANCH,
      });
      expect(applied.headSha).toBe(head);
      expect(await b.g("symbolic-ref", "--short", "HEAD")).toBe(BRANCH);
      expect(readFileSync(join(b.ws, "a.txt"), "utf8")).toBe("committed change\n");
      expect(readFileSync(join(b.ws, "README.md"), "utf8")).toBe("uncommitted\n");
      expect(readFileSync(join(b.ws, "notes", "todo.md"), "utf8")).toBe("untracked\n");
      expect(existsSync(join(b.ws, "gone.txt"))).toBe(false);
      expect(await b.g("diff", "--cached", "--name-only")).toBe("");
      const status = (await b.g("status", "--porcelain"))
        .split("\n")
        .map((l) => l.trim())
        .sort();
      expect(status).toEqual(["?? notes/", "D gone.txt", "M README.md"]);
      const again = await b.c.ok<{ headSha: string }>("repo.applyCheckpoint", {
        bundlePath: bundle,
        checkpointId: "01APPLY",
        branch: BRANCH,
      });
      expect(again.headSha).toBe(head);
      const missing = await b.c.req("repo.applyCheckpoint", {
        bundlePath: "/nonexistent.bundle",
        checkpointId: "01X",
        branch: BRANCH,
      });
      expect(missing).toMatchObject({ ok: false, error: { code: "CHECKPOINT_NOT_FOUND" } });
    },
    T,
  );
});

describe("git.revert", () => {
  test(
    "the 03 script: HEAD back to the checkpoint's parent, working tree = checkpoint, nothing staged",
    async () => {
      const { c, ws, clone, g } = await boot();
      await clone();
      writeFileSync(join(ws, "a.txt"), "turn one\n");
      writeFileSync(join(ws, "u1.txt"), "untracked in turn one\n");
      const head1 = await g("rev-parse", "HEAD");
      const ck = await c.ok<CheckpointResult>("git.checkpoint", {
        checkpointId: "01REV1",
        turnId: "t1",
        reason: "turn_end",
      });
      if ("unchanged" in ck) throw new Error("expected a checkpoint");
      writeFileSync(join(ws, "a.txt"), "turn two\n");
      await g("commit", "-q", "-am", "turn two commit");
      writeFileSync(join(ws, "u2.txt"), "untracked in turn two\n");
      writeFileSync(join(ws, "debug.log"), "ignored stays\n");
      const r = await c.ok<{ headSha: string }>("git.revert", { checkpointId: "01REV1" });
      expect(r.headSha).toBe(head1);
      expect(await g("rev-parse", "HEAD")).toBe(head1);
      expect(await g("symbolic-ref", "--short", "HEAD")).toBe(BRANCH);
      expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("turn one\n");
      expect(readFileSync(join(ws, "u1.txt"), "utf8")).toBe("untracked in turn one\n");
      expect(existsSync(join(ws, "u2.txt"))).toBe(false);
      expect(existsSync(join(ws, "debug.log"))).toBe(true);
      expect(await g("diff", "--cached", "--name-only")).toBe("");
      const missing = await c.req("git.revert", { checkpointId: "01NOPE" });
      expect(missing).toMatchObject({ ok: false, error: { code: "CHECKPOINT_NOT_FOUND" } });
    },
    T,
  );
});

describe("git.changes and git.fileDiff", () => {
  test(
    "added, modified, deleted, renamed and untracked in both scopes, with ahead and dirty",
    async () => {
      const { c, ws, clone, g, origin } = await boot();
      await clone();
      const base = await git(origin.bare, "rev-parse", "main");
      const clean = await c.ok<{
        files: ChangedFile[];
        ahead: number;
        dirty: boolean;
        baseSha: string;
        headSha: string;
      }>("git.changes", { scope: "branch" });
      expect(clean).toMatchObject({ files: [], ahead: 0, dirty: false, baseSha: base, headSha: base });

      writeFileSync(join(ws, "committed.txt"), "c1\nc2\n");
      await g("add", "committed.txt");
      await g("commit", "-q", "-m", "add committed.txt");
      const head = await g("rev-parse", "HEAD");
      writeFileSync(join(ws, "a.txt"), "one\nTWO\nthree\nfour\n");
      rmSync(join(ws, "gone.txt"));
      await g("mv", "old.txt", "renamed.txt");
      writeFile(join(ws, "dir", "untracked.txt"), "u1\nu2\nu3\n");
      writeFileSync(join(ws, "debug.log"), "ignored\n");

      const unc = await c.ok<{
        files: ChangedFile[];
        ahead: number;
        dirty: boolean;
        baseSha: string;
        headSha: string;
      }>("git.changes", { scope: "uncommitted" });
      expect(unc.baseSha).toBe(head);
      expect(unc.headSha).toBe(head);
      expect(unc.ahead).toBe(1);
      expect(unc.dirty).toBe(true);
      const u = byPath(unc.files);
      expect(Object.keys(u).sort()).toEqual(["a.txt", "dir/untracked.txt", "gone.txt", "renamed.txt"]);
      expect(u["a.txt"]).toMatchObject({ status: "M", additions: 2, deletions: 1 });
      expect(u["gone.txt"]).toMatchObject({ status: "D", additions: 0, deletions: 1 });
      expect(u["renamed.txt"]).toMatchObject({ status: "R", oldPath: "old.txt", additions: 0, deletions: 0 });
      expect(u["dir/untracked.txt"]).toMatchObject({ status: "A", additions: 3, deletions: 0 });

      const br = await c.ok<{ files: ChangedFile[]; baseSha: string }>("git.changes", { scope: "branch" });
      expect(br.baseSha).toBe(base);
      const b = byPath(br.files);
      expect(b["committed.txt"]).toMatchObject({ status: "A", additions: 2 });
      expect(b["a.txt"]).toMatchObject({ status: "M" });
      expect(b["renamed.txt"]).toMatchObject({ status: "R", oldPath: "old.txt" });
      expect(b["gone.txt"]).toMatchObject({ status: "D" });
      expect(b["dir/untracked.txt"]).toMatchObject({ status: "A", additions: 3 });
      expect(b["debug.log"]).toBeUndefined();

      const diff = await c.ok<{ diff: string }>("git.fileDiff", { scope: "uncommitted", path: "a.txt" });
      expect(diff.diff).toContain("-two");
      expect(diff.diff).toContain("+TWO");
      expect(diff.diff).toContain("+four");
      const added = await c.ok<{ diff: string }>("git.fileDiff", {
        scope: "uncommitted",
        path: "dir/untracked.txt",
      });
      expect(added.diff).toContain("+u1");
      expect(added.diff).toContain("new file");
      const committed = await c.ok<{ diff: string }>("git.fileDiff", {
        scope: "branch",
        path: "committed.txt",
      });
      expect(committed.diff).toContain("+c2");
      const none = await c.ok<{ diff: string }>("git.fileDiff", { scope: "uncommitted", path: "README.md" });
      expect(none.diff).toBe("");
      expect(await c.req("git.fileDiff", { scope: "uncommitted", path: "nope.txt" })).toMatchObject({
        ok: false,
        error: { code: "NOT_FOUND" },
      });
      expect(await c.req("git.fileDiff", { scope: "uncommitted", path: "../outside.txt" })).toMatchObject({
        ok: false,
        error: { code: "PATH_OUTSIDE_WORKSPACE" },
      });
      writeFileSync(join(ws, "huge.txt"), "line of text\n".repeat(120_000));
      expect(await c.req("git.fileDiff", { scope: "uncommitted", path: "huge.txt" })).toMatchObject({
        ok: false,
        error: { code: "FILE_TOO_LARGE" },
      });
    },
    T,
  );
});

describe("git.commitAndPush and git.renameBranch", () => {
  test(
    "commit and push; NOTHING_TO_COMMIT; PUSH_REJECTED; force-with-lease",
    async () => {
      const { c, ws, clone, g, origin } = await boot();
      await clone();
      const nothing = await c.req("git.commitAndPush", { message: "x", branch: BRANCH });
      expect(nothing).toMatchObject({ ok: false, error: { code: "NOTHING_TO_COMMIT" } });

      writeFileSync(join(ws, "feature.txt"), "feature\n");
      const r = await c.ok<{ commitSha: string }>("git.commitAndPush", {
        message: "Add feature",
        branch: BRANCH,
      });
      expect(await git(origin.bare, "rev-parse", BRANCH)).toBe(r.commitSha);
      expect(await git(origin.bare, "log", "-1", "--format=%s|%an|%ae", BRANCH)).toBe(
        `Add feature|${author.name}|${author.email}`,
      );
      expect(await g("rev-parse", "--abbrev-ref", `${BRANCH}@{upstream}`)).toBe(`origin/${BRANCH}`);
      const again = await c.req("git.commitAndPush", { message: "x", branch: BRANCH });
      expect(again).toMatchObject({ ok: false, error: { code: "NOTHING_TO_COMMIT" } });

      // A local commit that is not pushed yet is pushed without a new commit.
      writeFileSync(join(ws, "local.txt"), "local\n");
      await g("add", "local.txt");
      await g("commit", "-q", "-m", "local only");
      const localHead = await g("rev-parse", "HEAD");
      const pushed = await c.ok<{ commitSha: string }>("git.commitAndPush", {
        message: "unused",
        branch: BRANCH,
      });
      expect(pushed.commitSha).toBe(localHead);

      const theirs = await pushToOrigin(origin, BRANCH, "theirs.txt", "someone else\n", BRANCH);
      writeFileSync(join(ws, "mine.txt"), "mine\n");
      const rejected = await c.req("git.commitAndPush", { message: "Mine", branch: BRANCH });
      expect(rejected).toMatchObject({ ok: false, error: { code: "PUSH_REJECTED" } });
      expect(await git(origin.bare, "rev-parse", BRANCH)).toBe(theirs);

      const stale = await c.req("git.commitAndPush", {
        message: "x",
        branch: BRANCH,
        forceWithLeaseSha: localHead,
      });
      expect(stale).toMatchObject({ ok: false, error: { code: "PUSH_REJECTED" } });
      await g("fetch", "-q", "origin");
      const forced = await c.ok<{ commitSha: string }>("git.commitAndPush", {
        message: "x",
        branch: BRANCH,
        forceWithLeaseSha: theirs,
      });
      expect(await git(origin.bare, "rev-parse", BRANCH)).toBe(forced.commitSha);
      const badLease = await c.req("git.commitAndPush", {
        message: "x",
        branch: BRANCH,
        forceWithLeaseSha: "not-a-sha",
      });
      expect(badLease).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    },
    T,
  );

  test(
    "renameBranch renames the local branch and is idempotent",
    async () => {
      const { c, clone, g, h } = await boot();
      await clone();
      await c.ok("git.renameBranch", { from: BRANCH, to: "tempo/porto" });
      expect(await g("symbolic-ref", "--short", "HEAD")).toBe("tempo/porto");
      expect(h.app.workspaceInfo?.branch).toBe("tempo/porto");
      expect(await c.ok<unknown>("git.renameBranch", { from: BRANCH, to: "tempo/porto" })).toEqual({});
      expect(await c.req("git.renameBranch", { from: "tempo/porto", to: "bad..name" })).toMatchObject({
        ok: false,
        error: { code: "BRANCH_INVALID" },
      });
      expect(await c.req("git.renameBranch", { from: "x/none", to: "y/none" })).toMatchObject({
        ok: false,
        error: { code: "NOT_FOUND" },
      });
    },
    T,
  );
});

describe("deadlines", () => {
  test(
    "a hung commit hook is killed at the op deadline and the lock is released",
    async () => {
      const origin = await makeOrigin();
      const config = testConfig();
      const db = new TempodDb(join(config.stateDir, "tempod.db"));
      const gitOps = new Git({
        workspace: config.workspace,
        stateDir: config.stateDir,
        ckptIndex: config.ckptIndex,
        ckptBundle: config.ckptBundle,
        db,
        env: () => ({ ...(process.env as Record<string, string>) }),
        opMs: { commitAndPush: 1_500 },
      });
      try {
        await gitOps.clone({
          url: origin.url,
          branch: BRANCH,
          baseBranch: "main",
          source: { kind: "new" },
          author,
          mode: "create",
        });
        const hooks = join(config.workspace, ".git", "hooks");
        mkdirSync(hooks, { recursive: true });
        writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nsleep 30 &\nsleep 30\n");
        chmodSync(join(hooks, "pre-commit"), 0o755);
        writeFileSync(join(config.workspace, "x.txt"), "x\n");
        const started = Date.now();
        await expect(gitOps.commitAndPush({ message: "m", branch: BRANCH }, "main")).rejects.toThrow(
          /timed out/,
        );
        expect(Date.now() - started).toBeLessThan(6_000);
        const ck = await gitOps.checkpoint({ checkpointId: "01AFTER", turnId: null }, "main");
        expect("commit" in ck).toBe(true);
      } finally {
        db.close();
      }
    },
    T,
  );
});

describe("git.readFile (02)", () => {
  test(
    "returns a file as it is in a commit: text as utf8, binary as base64; missing paths and big files fail",
    async () => {
      const { c, ws, clone, g } = await boot();
      const { headSha } = await clone();
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
      writeFileSync(join(ws, "logo.png"), png);
      await g("add", "logo.png");
      await g("commit", "-q", "-m", "logo");
      const head = await g("rev-parse", "HEAD");
      writeFileSync(join(ws, "a.txt"), "changed\n");

      const text = await c.ok<{ content: string; encoding: string; size: number }>("git.readFile", {
        sha: headSha,
        path: "a.txt",
        maxBytes: 1024,
      });
      expect(text).toEqual({ content: "one\ntwo\nthree\n", encoding: "utf8", size: 14 });
      const bin = await c.ok<{ content: string; encoding: string; size: number }>("git.readFile", {
        sha: head,
        path: `${ws}/logo.png`,
        maxBytes: 1024,
      });
      expect(bin).toEqual({ content: png.toString("base64"), encoding: "base64", size: png.length });
      expect(await c.req("git.readFile", { sha: headSha, path: "logo.png", maxBytes: 1024 })).toMatchObject({
        ok: false,
        error: { code: "NOT_FOUND" },
      });
      expect(await c.req("git.readFile", { sha: head, path: "logo.png", maxBytes: 4 })).toMatchObject({
        ok: false,
        error: { code: "FILE_TOO_LARGE" },
      });
      expect(await c.req("git.readFile", { sha: "--help", path: "a.txt", maxBytes: 9 })).toMatchObject({
        ok: false,
        error: { code: "NOT_FOUND" },
      });
      expect(await c.req("git.readFile", { sha: head, path: "/etc/passwd", maxBytes: 9 })).toMatchObject({
        ok: false,
        error: { code: "PATH_OUTSIDE_WORKSPACE" },
      });
    },
    T,
  );
});
