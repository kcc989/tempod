import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { newId, type FnInput, type FnName, type JsonData } from "@tempo/protocol";
import { d1UsernameTaken } from "../../src/auth/auth.ts";
import { bioFor, usernameFor } from "../../src/auth/options.ts";
import type { Env } from "../../src/env.ts";
import { insertProject } from "../../src/server/handlers/common.ts";
import {
  getPublicProject,
  listProfileProjects,
  setProjectPinned,
  setProjectVisibility,
} from "../../src/server/handlers/profile.ts";
import { linkArtifactRepository } from "../../src/server/handlers/repositories.ts";
import { runFn, type HandlerCtx } from "../../src/server/run.ts";
import { artifactCommit, artifactMetadata, fakeArtifactRepo, fakeArtifacts } from "./artifacts-fake.ts";
import { OWNER_GITHUB_ID, seedProject } from "./fakes.ts";

const BOTH = { allowCookie: true, allowBearer: true };

const unique = () => newId().slice(-10).toLowerCase();

/** A Better Auth session row; its raw token works as a bearer token. */
const signIn = async (userId: string): Promise<Headers> => {
  const token = `t${newId()}${newId()}`;
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(newId(), now + 86_400_000, token, now, now, userId)
    .run();

  return new Headers({ Authorization: `Bearer ${token}` });
};

/** The seeded owner, with a username (11, Identity). */
const seedOwner = async () => {
  const seeded = await seedProject();
  const username = `octo-${unique()}`;
  await env.DB.prepare("UPDATE user SET username = ?, bio = 'Builds things.' WHERE id = ?")
    .bind(username, seeded.userId)
    .run();

  const ctx: HandlerCtx = {
    env,
    user: { id: seeded.userId, name: "Owner", email: "o@example.com", image: null },
  };

  return { seeded, username, ctx };
};

const native = async (ctx: HandlerCtx, name: string) => {
  const info = artifactMetadata(`${name}-${ctx.user.id}`, { lastPushAt: new Date().toISOString() });
  const commit = artifactCommit("a".repeat(40));

  const repo = fakeArtifactRepo(info, {
    log: async () => [commit],
    readTree: async () => [{ name: "README.md", hash: "b".repeat(40), mode: "100644", type: "blob" }],
    readFile: async () => new Blob(["hello"]),
  });

  const testEnv: Env = { ...env, ARTIFACTS: fakeArtifacts(async () => repo) };
  const project = await linkArtifactRepository({ ...ctx, env: testEnv }, { name: info.name });

  return { project, testEnv, info };
};

const run = <K extends FnName>(name: K, e: Env, headers: Headers, input: FnInput<K>) =>
  // SAFETY: FnInput values are JSON-shaped wire inputs.
  runFn(name, e, headers, input as JsonData, BOTH);

describe("public profile (11)", () => {
  it("lets visitors read a public project's code only, and hides private projects", async () => {
    const { seeded, ctx } = await seedOwner();
    const { project, testEnv, info } = await native(ctx, "site");
    const anonymous = new Headers();
    const ownerHeaders = await signIn(seeded.userId);
    const read = { projectId: project.id };

    expect(await run("getRepository", testEnv, anonymous, read)).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    await setProjectVisibility(ctx, { projectId: project.id, visibility: "public" });

    expect(await run("getRepository", testEnv, anonymous, read)).toMatchObject({
      ok: true,
      value: { remote: "", entries: [{ path: "README.md" }] },
    });
    expect(await run("getRepository", testEnv, ownerHeaders, read)).toMatchObject({
      ok: true,
      value: { remote: info.remote },
    });
    expect(
      await run("getRepositoryFile", testEnv, anonymous, { ...read, ref: "main", path: "README.md" }),
    ).toMatchObject({ ok: true, value: { content: "hello" } });
    expect(await run("listRepositoryCommits", testEnv, anonymous, read)).toMatchObject({
      ok: true,
      value: [{ hash: "a".repeat(40) }],
    });

    // Issues, pull requests and checks stay owner-only, also for a public project.
    for (const name of ["listRepositoryIssues", "listRepositoryPullRequests", "getCiPipeline"] as const)
      expect(await run(name, testEnv, anonymous, read)).toMatchObject({
        ok: false,
        error: { code: "UNAUTHENTICATED" },
      });

    // A session that is not the owner's is a visitor for visitor functions, and FORBIDDEN elsewhere.
    const stranger = `user-${newId()}`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'S', ?, 1, 1, 1)",
      ).bind(stranger, `${stranger}@example.com`),
      env.DB.prepare(
        "INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES (?, '9999', 'github', ?, 1, 1)",
      ).bind(`acc-${stranger}`, stranger),
    ]);
    const strangerHeaders = await signIn(stranger);
    expect(await run("getRepository", testEnv, strangerHeaders, read)).toMatchObject({
      ok: true,
      value: { remote: "" },
    });
    expect(await run("listRepositoryIssues", testEnv, strangerHeaders, read)).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });

    // A public GitHub-linked project never makes visitors call GitHub.
    await setProjectVisibility(ctx, { projectId: seeded.projectId, visibility: "public" });
    expect(await run("listBranches", env, anonymous, { projectId: seeded.projectId })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });

  it("pins at most six public projects and orders the profile pinned first", async () => {
    const { seeded, username, ctx } = await seedOwner();

    await expect(setProjectPinned(ctx, { projectId: seeded.projectId, pinned: true })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });

    const ids: string[] = [];

    for (let i = 0; i < 7; i++) {
      const row = await insertProject(env, {
        id: newId(),
        userId: seeded.userId,
        installationId: seeded.installationId,
        repoId: seeded.repoId + 1000 + i,
        provider: "github",
        artifactRepoId: null,
        cloneUrl: null,
        repoOwner: "acme",
        repoName: `repo-${i}`,
        defaultBranch: "main",
        settingsJson: "{}",
        sortOrder: 2 + i,
        environmentId: null,
        createdAt: i,
        updatedAt: i,
      });

      await setProjectVisibility(ctx, { projectId: row!.id, visibility: "public" });
      ids.push(row!.id);
    }

    for (const id of ids.slice(0, 6).reverse())
      expect(await setProjectPinned(ctx, { projectId: id, pinned: true })).toMatchObject({
        pinned: true,
        username,
      });
    await expect(setProjectPinned(ctx, { projectId: ids[6]!, pinned: true })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });

    const before = await env.DB.prepare("SELECT pinned_at FROM projects WHERE id = ?").bind(ids[5]).first();
    await setProjectPinned(ctx, { projectId: ids[5]!, pinned: true });
    expect(await env.DB.prepare("SELECT pinned_at FROM projects WHERE id = ?").bind(ids[5]).first()).toEqual(
      before,
    );

    // Making a project private unpins it and takes it off the profile; then the 7th fits.
    expect(await setProjectVisibility(ctx, { projectId: ids[0]!, visibility: "private" })).toMatchObject({
      visibility: "private",
      pinned: false,
    });
    await setProjectPinned(ctx, { projectId: ids[6]!, pinned: true });
    await setProjectPinned(ctx, { projectId: ids[1]!, pinned: false });

    // Pins in one millisecond tie, so give them distinct times to check the order.
    for (const [i, at] of [
      [5, 10],
      [4, 20],
      [3, 30],
      [2, 40],
      [6, 50],
    ] as const)
      await env.DB.prepare("UPDATE projects SET pinned_at = ? WHERE id = ?").bind(at, ids[i]).run();

    const profile = await listProfileProjects({ env, user: null }, { username: username.toUpperCase() });
    expect(profile.map((p) => [p.slug, p.pinned])).toEqual([
      ["repo-5", true],
      ["repo-4", true],
      ["repo-3", true],
      ["repo-2", true],
      ["repo-6", true],
      ["repo-1", false],
    ]);
    await expect(
      getPublicProject({ env, user: ctx.user }, { username, slug: "REPO-0" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await getPublicProject({ env, user: null }, { username, slug: "REPO-1" })).toMatchObject({
      id: ids[1],
      username,
      slug: "repo-1",
      owner: "acme",
      name: "repo-1",
    });
    expect(await run("getProfile", env, new Headers(), { username })).toEqual({
      ok: true,
      value: { username, name: "Owner", image: null, bio: "Builds things." },
    });
    expect(await run("getProfile", env, new Headers(), { username: "nobody-here" })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(await run("listProfileProjects", env, new Headers(), { username, offset: -1 })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
  });

  it("gives each new project the first free slug, and refuses a repository linked twice", async () => {
    const { seeded } = await seedOwner();

    const base = {
      userId: seeded.userId,
      installationId: seeded.installationId,
      provider: "github" as const,
      artifactRepoId: null,
      cloneUrl: null,
      defaultBranch: "main",
      settingsJson: "{}",
      sortOrder: 2,
      environmentId: null,
      createdAt: 1,
      updatedAt: 1,
    };

    const fork = await insertProject(env, {
      ...base,
      id: `fork-${unique()}`,
      repoId: seeded.repoId + 1,
      repoOwner: "fork",
      repoName: "APP",
    });

    const third = await insertProject(env, {
      ...base,
      id: `x${unique()}`,
      repoId: seeded.repoId + 2,
      repoOwner: "fork",
      repoName: "app",
    });

    expect(fork?.slug).toBe("fork-APP");
    expect(third?.slug).toBe(`fork-app-${third?.id}`);
    expect(
      await insertProject(env, {
        ...base,
        id: newId(),
        repoId: seeded.repoId,
        repoOwner: "x",
        repoName: "y",
      }),
    ).toBeNull();
  });

  it("derives usernames and bios from the GitHub profile", async () => {
    const taken = d1UsernameTaken(env);
    const { username } = await seedOwner();

    expect(await usernameFor(taken, "Octo-Cat", "1")).toBe("octo-cat");
    expect(await usernameFor(taken, "Settings", "77")).toBe("settings-77");
    // The owner's own GitHub id keeps the name; another account gets `<login>-<id>`.
    expect(await usernameFor(taken, username, OWNER_GITHUB_ID)).toBe(username);
    expect(await usernameFor(taken, username, "555")).toBe(`${username}-555`);
    expect(bioFor("  Builds things.  ")).toBe("Builds things.");
    expect(bioFor("   ")).toBeNull();
    expect(bioFor(null)).toBeNull();
    expect(bioFor("x".repeat(200))).toHaveLength(160);
  });
});
