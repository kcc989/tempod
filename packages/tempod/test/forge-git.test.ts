import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TempodParams } from "@tempo/protocol";
import { Git } from "../src/git.ts";
import { cleanupDirs, DoClient, git, makeOrigin, startTempod, tmpDir, type Harness } from "./helpers.ts";

afterAll(cleanupDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

const T = 60_000;

const BRANCH = "tempo/lisbon";

const author = { name: "Ada", email: "ada@example.com" };

type Origin = Awaited<ReturnType<typeof makeOrigin>>;

const emptyOrigin = async (): Promise<Origin> => {
  const root = tmpDir("empty-origin-");
  const bare = join(root, "origin.git");
  const seed = join(root, "seed");
  await git(root, "init", "-q", "--bare", "-b", "main", bare);
  mkdirSync(seed);

  return { bare, seed, url: `file://${bare}` };
};

const boot = async (origin: Origin) => {
  const h = startTempod();
  harnesses.push(h);
  const c = new DoClient(h.base);
  await c.hello();
  await c.waitEvent("incarnation.changed");

  const clone = (extra: Partial<TempodParams<"repo.clone">> = {}) =>
    c.ok("repo.clone", {
      url: origin.url,
      branch: BRANCH,
      baseBranch: "main",
      source: { kind: "new" },
      author,
      mode: "create",
      ...extra,
    });

  const g = (...args: string[]) => git(h.config.workspace, ...args);

  return { h, c, clone, g, ws: h.config.workspace };
};

const push = async (origin: Origin, branch: string, file: string, text: string): Promise<string> => {
  await git(origin.seed, "fetch", "-q", "origin");
  await git(origin.seed, "checkout", "-q", "-B", branch, "origin/main");
  writeFileSync(join(origin.seed, file), text);
  await git(origin.seed, "add", "-A");
  await git(origin.seed, "commit", "-q", "-m", `change ${file}`);
  await git(origin.seed, "push", "-q", "origin", `${branch}:${branch}`);

  return git(origin.bare, "rev-parse", branch);
};

const params = (
  baseSha: string,
  headSha: string,
  operationId: string,
  method: "merge" | "squash" = "merge",
): TempodParams<"git.merge"> => ({
  baseBranch: "main",
  headBranch: "feature/one",
  method,
  baseSha,
  headSha,
  operationId,
});

describe("native empty repository", () => {
  test(
    "initializes the base, creates the workspace branch and keeps files on retry",
    async () => {
      const origin = await emptyOrigin();
      const a = await boot(origin);
      const first = await a.clone({ initializeEmpty: true });
      expect(first.headSha).toBe(await git(origin.bare, "rev-parse", "main"));
      expect(await git(origin.bare, "rev-list", "--count", "main")).toBe("1");
      expect(await git(origin.bare, "ls-tree", "-r", "--name-only", "main")).toBe("");
      expect(await a.g("symbolic-ref", "--short", "HEAD")).toBe(BRANCH);
      writeFileSync(join(a.ws, "keep.txt"), "in progress\n");
      expect(await a.clone({ initializeEmpty: true })).toEqual(first);
      expect(readFileSync(join(a.ws, "keep.txt"), "utf8")).toBe("in progress\n");
      expect(await git(origin.bare, "rev-list", "--count", "main")).toBe("1");
    },
    T,
  );

  test(
    "requires native initialization and preserves branch and PR source errors",
    async () => {
      for (const source of [{ kind: "new" }, { kind: "branch" }, { kind: "pr", number: 1 }]) {
        const origin = await emptyOrigin();
        const a = await boot(origin);

        const r = await a.c.req("repo.clone", {
          url: origin.url,
          branch: BRANCH,
          baseBranch: "main",
          source,
          author,
          mode: "create",
          initializeEmpty: source.kind !== "new",
        });

        expect(r).toMatchObject({
          ok: false,
          error: {
            code: "CLONE_FAILED",
            message:
              source.kind === "new"
                ? "The base branch main is not on origin."
                : `The branch ${BRANCH} is not on origin.`,
          },
        });
        expect(await git(origin.bare, "show-ref", "--head").catch(() => "")).toBe("");
      }

      const origin = await makeOrigin();
      const a = await boot(origin);
      await expect(a.clone({ initializeEmpty: true, baseBranch: "missing" })).rejects.toThrow(
        "The base branch missing is not on origin.",
      );
      expect(await git(origin.bare, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe(
        "refs/heads/main",
      );
    },
    T,
  );

  test(
    "fetches a concurrent initializer after its absent-base lease is rejected",
    async () => {
      const origin = await emptyOrigin();
      const a = await boot(origin);
      const b = await boot(origin);
      const original = a.h.app.git.git.bind(a.h.app.git);
      let concurrentSha = "";
      a.h.app.git.git = async (args, opts) => {
        if (args[0] === "push" && concurrentSha === "") {
          concurrentSha = (
            await b.clone({
              initializeEmpty: true,
              author: { name: "Other initializer", email: "other@example.com" },
            })
          ).headSha;
        }

        return original(args, opts);
      };

      expect((await a.clone({ initializeEmpty: true })).headSha).toBe(concurrentSha);
      expect(await git(origin.bare, "rev-list", "--count", "main")).toBe("1");
    },
    T,
  );
});

describe("native pull request Git operations", () => {
  for (const method of ["merge", "squash"] as const) {
    test(
      `${method} preserves both sides of the tree and a dirty workspace, and recovers retries`,
      async () => {
        const origin = await makeOrigin();
        const headSha = await push(origin, "feature/one", "feature.txt", "from feature\n");
        const baseSha = await push(origin, "main", "base.txt", "from base\n");
        const a = await boot(origin);
        await a.clone();
        writeFileSync(join(a.ws, "a.txt"), "unfinished\n");
        writeFileSync(join(a.ws, "staged.txt"), "staged\n");
        await a.g("add", "staged.txt");
        writeFileSync(join(a.ws, "untracked.txt"), "untracked\n");
        const index = readFileSync(join(a.ws, ".git", "index"));
        const status = await a.g("status", "--porcelain");
        const localHead = await a.g("rev-parse", "HEAD");
        const p = params(baseSha, headSha, `01${method}`, method);
        const merged = await a.c.ok("git.merge", p);
        expect(await git(origin.bare, "rev-parse", "main")).toBe(merged.commitSha);
        expect(await git(origin.bare, "show", "main:feature.txt")).toBe("from feature");
        expect(await git(origin.bare, "show", "main:base.txt")).toBe("from base");
        expect(await git(origin.bare, "show", "-s", "--format=%P", "main")).toBe(
          method === "merge" ? `${baseSha} ${headSha}` : baseSha,
        );
        expect(await a.g("rev-parse", "HEAD")).toBe(localHead);
        expect(await a.g("symbolic-ref", "--short", "HEAD")).toBe(BRANCH);
        expect(readFileSync(join(a.ws, ".git", "index"))).toEqual(index);
        expect(await a.g("status", "--porcelain")).toBe(status);
        expect(readFileSync(join(a.ws, "a.txt"), "utf8")).toBe("unfinished\n");
        expect(await a.c.ok("git.merge", p)).toEqual(merged);
        const advanced = await push(origin, "main", "later.txt", "later\n");
        const b = await boot(origin);
        await b.clone();
        expect(await b.c.ok("git.merge", { ...p, baseSha: advanced })).toEqual(merged);
        expect(await git(origin.bare, "rev-parse", "main")).toBe(advanced);
        expect(await git(origin.bare, "rev-list", "--first-parent", "--count", "main")).toBe("4");
      },
      T,
    );
  }

  test(
    "rejects conflicting and stale branch snapshots without changing origin",
    async () => {
      const origin = await makeOrigin();
      const initial = await git(origin.bare, "rev-parse", "main");
      const head = await push(origin, "feature/one", "a.txt", "feature version\n");
      const base = await push(origin, "main", "a.txt", "base version\n");
      const a = await boot(origin);
      await a.clone();
      const conflict = await a.c.req("git.merge", params(base, head, "01conflict"));
      expect(conflict).toMatchObject({ ok: false, error: { code: "PR_NOT_MERGEABLE" } });

      for (const p of [params(initial, head, "01staleBase"), params(base, initial, "01staleHead")]) {
        expect(await a.c.req("git.merge", p)).toMatchObject({
          ok: false,
          error: { code: "PR_NOT_MERGEABLE" },
        });
      }

      expect(await git(origin.bare, "rev-parse", "main")).toBe(base);
      expect(
        await a.c.req("git.merge", { ...params(base, head, "01bad"), headBranch: "bad..ref" }),
      ).toMatchObject({
        ok: false,
        error: { code: "BRANCH_INVALID" },
      });
      expect(
        await a.c.req("git.merge", { ...params(base, head, "01bad"), operationId: "../escape" }),
      ).toMatchObject({
        ok: false,
        error: { code: "VALIDATION_FAILED" },
      });
    },
    T,
  );

  test(
    "a concurrent base update rejects the lease; a later valid retry replaces the unpushed candidate",
    async () => {
      const origin = await makeOrigin();
      const head = await push(origin, "feature/one", "feature.txt", "feature\n");
      const base = await git(origin.bare, "rev-parse", "main");
      const a = await boot(origin);
      await a.clone();
      const original = a.h.app.git.git.bind(a.h.app.git);
      let advanced = "";
      a.h.app.git.git = async (args, opts) => {
        if (args[0] === "push" && advanced === "") {
          advanced = await push(origin, "main", "concurrent.txt", "concurrent\n");
        }

        return original(args, opts);
      };

      const p = params(base, head, "01cas");
      expect(await a.c.req("git.merge", p)).toMatchObject({
        ok: false,
        error: { code: "PR_NOT_MERGEABLE" },
      });
      expect(await git(origin.bare, "rev-parse", "main")).toBe(advanced);
      const merged = await a.c.ok("git.merge", { ...p, baseSha: advanced });
      expect(await git(origin.bare, "rev-parse", "main")).toBe(merged.commitSha);
      expect(await git(origin.bare, "show", "main:concurrent.txt")).toBe("concurrent");
      expect(await git(origin.bare, "show", "main:feature.txt")).toBe("feature");
    },
    T,
  );

  test(
    "rejects a published operation marker whose tree does not contain the claimed merge",
    async () => {
      const origin = await makeOrigin();
      const head = await push(origin, "feature/one", "feature.txt", "feature\n");
      const base = await git(origin.bare, "rev-parse", "main");
      const a = await boot(origin);
      await a.clone();
      const p = params(base, head, "01forged");
      const tree = await a.g("rev-parse", `${base}^{tree}`);
      const message = `tempo merge feature/one into main\n\nTempo-Operation: 01forged\nTempo-Base: ${base}\nTempo-Head: ${head}\nTempo-Method: merge`;
      const forged = await a.g("commit-tree", tree, "-p", base, "-p", head, "-m", message);
      await a.g("push", "origin", `${forged}:refs/heads/main`);
      expect(await a.c.req("git.merge", p)).toMatchObject({
        ok: false,
        error: { code: "PR_NOT_MERGEABLE" },
      });
      expect(await git(origin.bare, "rev-parse", "main")).toBe(forged);
    },
    T,
  );

  test(
    "recovers a push whose success response was lost",
    async () => {
      const origin = await makeOrigin();
      const head = await push(origin, "feature/one", "feature.txt", "feature\n");
      const base = await git(origin.bare, "rev-parse", "main");
      const a = await boot(origin);
      await a.clone();
      const original = a.h.app.git.git.bind(a.h.app.git);
      let dropped = false;
      a.h.app.git.git = async (args, opts) => {
        const r = await original(args, opts);

        if (args[0] === "push" && r.code === 0 && !dropped) {
          dropped = true;

          return { ...r, code: 1, stderr: "connection closed before acknowledgement" };
        }

        return r;
      };

      const p = params(base, head, "01lostAck");
      const merged = await a.c.ok("git.merge", p);
      expect(dropped).toBe(true);
      expect(await git(origin.bare, "rev-parse", "main")).toBe(merged.commitSha);
      expect(await a.c.ok("git.merge", p)).toEqual(merged);
      expect(await git(origin.bare, "rev-list", "--first-parent", "--count", "main")).toBe("2");
    },
    T,
  );

  test(
    "deletes only the remote branch and is idempotent",
    async () => {
      const origin = await makeOrigin();
      await push(origin, "feature/one", "feature.txt", "feature\n");
      const a = await boot(origin);
      await a.clone({ branch: "feature/one", source: { kind: "branch" } });
      writeFileSync(join(a.ws, "keep.txt"), "working\n");
      const head = await a.g("rev-parse", "HEAD");
      expect(await a.c.ok("git.deleteBranch", { branch: "feature/one" })).toEqual({});
      expect(await a.c.ok("git.deleteBranch", { branch: "feature/one" })).toEqual({});
      expect(await git(origin.bare, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe(
        "refs/heads/main",
      );
      expect(await a.g("rev-parse", "HEAD")).toBe(head);
      expect(readFileSync(join(a.ws, "keep.txt"), "utf8")).toBe("working\n");
      expect(await a.c.req("git.deleteBranch", { branch: "bad..ref" })).toMatchObject({
        ok: false,
        error: { code: "BRANCH_INVALID" },
      });
    },
    T,
  );

  test(
    "a hung pre-push hook respects the merge deadline and retry releases the operation lock",
    async () => {
      const origin = await makeOrigin();
      const head = await push(origin, "feature/one", "feature.txt", "feature\n");
      const base = await git(origin.bare, "rev-parse", "main");
      const a = await boot(origin);
      await a.clone();
      const cfg = a.h.config;

      const ops = new Git({
        workspace: cfg.workspace,
        stateDir: cfg.stateDir,
        ckptIndex: cfg.ckptIndex,
        ckptBundle: cfg.ckptBundle,
        db: a.h.app.db,
        env: () => a.h.app.baseEnv(),
        opMs: { merge: 1_500 },
      });

      const hook = join(a.ws, ".git", "hooks", "pre-push");
      writeFileSync(hook, "#!/bin/sh\nsleep 30 &\nsleep 30\n");
      chmodSync(hook, 0o755);
      const p = params(base, head, "01deadline");
      const started = Date.now();
      await expect(ops.merge(p)).rejects.toThrow(/timed out/);
      expect(Date.now() - started).toBeLessThan(6_000);
      expect(await git(origin.bare, "rev-parse", "main")).toBe(base);
      rmSync(hook);
      const merged = await ops.merge(p);
      expect(await git(origin.bare, "rev-parse", "main")).toBe(merged.commitSha);
      expect(await git(origin.bare, "rev-list", "--first-parent", "--count", "main")).toBe("2");
    },
    T,
  );
});
