import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TempoError } from "@tempo/protocol";
import {
  artifactBranchExists,
  artifactHeadSha,
  artifactToken,
  assertArtifactRemote,
  assertArtifactRepositoryIdentity,
  listArtifactBranches,
} from "../../src/artifacts/repositories.ts";
import type { Env } from "../../src/env.ts";
import {
  createRepository,
  getRepository,
  getRepositoryFile,
  importRepository,
  linkArtifactRepository,
  listRepositoryCommits,
} from "../../src/server/handlers/repositories.ts";
import type { HandlerCtx } from "../../src/server/run.ts";
import { seedProject } from "./fakes.ts";

const REMOTE = "https://0123456789abcdef0123456789abcdef.artifacts.cloudflare.net/git/tempo-repos";

const SHA = "a".repeat(40);

const ROOT = "b".repeat(40);

const SRC = "c".repeat(40);

const TOKEN = "art_v1_0123456789abcdef0123456789abcdef01234567?expires=9999999999";

const INITIAL_TOKEN = "art_v1_fedcba9876543210fedcba9876543210fedcba98?expires=9999999999";

const COMMIT: ArtifactsCommitMetadata = {
  hash: SHA,
  treeHash: ROOT,
  message: "Initial project",
  author: { name: "Owner", email: "owner@example.com" },
  committer: { name: "Owner", email: "owner@example.com" },
  parents: [],
  authoredAt: 1_791_867_600,
  committedAt: 1_791_867_601,
};

const nativeError = (code: ArtifactsErrorCode, message = "upstream failure") =>
  Object.assign(new Error(message), { name: "ArtifactsError", code });

const fakeRepo = (name: string, overrides: Partial<ArtifactsRepoInfo> = {}) => {
  const metadata: ArtifactsRepoInfo = {
    id: `repo-${name}`,
    name,
    description: null,
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastPushAt: null,
    source: null,
    readOnly: false,
    remote: `${REMOTE}/${name}.git`,
    ...overrides,
  };

  const commits = new Map<string, ArtifactsCommitMetadata[]>();
  const trees = new Map<string, ArtifactsTreeEntry[]>();
  const files = new Map<string, Blob>();

  const repo = {
    info: vi.fn(async () => metadata),
    createToken: vi.fn(async (scope: "read" | "write" = "write", ttl = 86400) => ({
      id: "token-1",
      plaintext: TOKEN,
      scope,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    })),
    listTokens: vi.fn(async () => ({ total: 0, tokens: [] })),
    revokeToken: vi.fn(async () => true),
    log: vi.fn(async (opts: { ref?: string; limit?: number; offset?: number } = {}) =>
      (commits.get(opts.ref ?? "HEAD") ?? []).slice(
        opts.offset ?? 0,
        (opts.offset ?? 0) + (opts.limit ?? 50),
      ),
    ),
    readTree: vi.fn(async (hash: string) => trees.get(hash) ?? null),
    readCommit: vi.fn(async (hash: string) => (hash === SHA ? COMMIT : null)),
    readBlob: vi.fn(async () => null),
    readFile: vi.fn(
      async ({ ref, path }: { ref: string; path: string }) => files.get(`${ref}:${path}`) ?? null,
    ),
    fork: vi.fn(async () => {
      throw new Error("unexpected fork");
    }),
    [Symbol.dispose]: vi.fn(),
  } satisfies ArtifactsRepo;

  return { repo, metadata, commits, trees, files };
};

const fakeArtifacts = () => {
  const repos = new Map<string, ReturnType<typeof fakeRepo>>();

  const binding = {
    create: vi.fn(async (name: string, opts?: { description?: string; setDefaultBranch?: string }) => {
      if (repos.has(name)) throw nativeError("ALREADY_EXISTS");

      const repo = fakeRepo(name, {
        description: opts?.description ?? null,
        defaultBranch: opts?.setDefaultBranch ?? "main",
      });

      repos.set(name, repo);

      return {
        id: repo.metadata.id,
        name,
        description: repo.metadata.description,
        defaultBranch: repo.metadata.defaultBranch,
        remote: repo.metadata.remote,
        token: INITIAL_TOKEN,
      };
    }),
    get: vi.fn(async (name: string) => {
      const repo = repos.get(name);

      if (!repo) throw nativeError("NOT_FOUND");

      return repo.repo;
    }),
    import: vi.fn(async (params: Parameters<Artifacts["import"]>[0]) => {
      if (repos.has(params.target.name)) throw nativeError("ALREADY_EXISTS");

      const repo = fakeRepo(params.target.name, {
        description: params.target.opts?.description ?? null,
        source: params.source.url,
      });

      repos.set(params.target.name, repo);

      return {
        id: repo.metadata.id,
        name: repo.metadata.name,
        description: repo.metadata.description,
        defaultBranch: repo.metadata.defaultBranch,
        remote: repo.metadata.remote,
        token: INITIAL_TOKEN,
      };
    }),
    list: vi.fn(async () => ({ repos: [], total: 0 })),
    delete: vi.fn(async () => false),
  } satisfies Artifacts;

  return { binding, repos };
};

const fixture = async () => {
  const seeded = await seedProject();
  const artifacts = fakeArtifacts();
  const testEnv: Env = { ...env, ARTIFACTS: artifacts.binding };

  const ctx: HandlerCtx = {
    env: testEnv,
    user: { id: seeded.userId, name: "Owner", email: "owner@example.com", image: null },
  };

  return { ctx, seeded, artifacts };
};

const populated = async () => {
  const f = await fixture();
  const repo = fakeRepo("demo", { lastPushAt: new Date().toISOString(), description: "Demo repo" });
  repo.commits.set("main", [COMMIT]);
  repo.commits.set("refs/heads/main", [COMMIT]);
  repo.trees.set(ROOT, [
    { name: "src", hash: SRC, mode: "40000", type: "tree" },
    { name: "README.md", hash: "d".repeat(40), mode: "100644", type: "blob" },
    { name: "link", hash: "e".repeat(40), mode: "120000", type: "symlink" },
    { name: "dependency", hash: "f".repeat(40), mode: "160000", type: "gitlink" },
  ]);
  repo.trees.set(SRC, [{ name: "index.ts", hash: "1".repeat(40), mode: "100644", type: "blob" }]);
  repo.files.set("main:README.md", new Blob(["Hello 🌍"]));
  f.artifacts.repos.set("demo", repo);
  const project = await linkArtifactRepository(f.ctx, { name: "demo" });

  return { ...f, repo, project };
};

const packet = (text: string): string =>
  (new TextEncoder().encode(text).length + 4).toString(16).padStart(4, "0") + text;

const advertisement = (refs: string[]): Response =>
  new Response(packet("# service=git-upload-pack\n") + "0000" + refs.map(packet).join("") + "0000", {
    headers: { "Content-Type": "application/x-git-upload-pack-advertisement" },
  });

afterEach(() => vi.unstubAllGlobals());

describe("Artifacts repository lifecycle", () => {
  it("creates a native project, revokes the transient token, and returns the same project on retry", async () => {
    const { ctx, artifacts } = await fixture();

    const project = await createRepository(ctx, {
      name: "demo",
      description: "Demo",
      defaultBranch: "trunk",
    });

    expect(project).toMatchObject({
      provider: "artifacts",
      installationId: null,
      repoId: null,
      artifactRepoId: "repo-demo",
      owner: "tempo",
      name: "demo",
      defaultBranch: "trunk",
      cloneUrl: `${REMOTE}/demo.git`,
    });
    expect(await createRepository(ctx, { name: "demo" })).toEqual(project);
    expect(artifacts.binding.create).toHaveBeenCalledTimes(1);
    expect(artifacts.repos.get("demo")!.repo.revokeToken).toHaveBeenCalledWith(INITIAL_TOKEN);
    expect(artifacts.repos.get("demo")!.repo[Symbol.dispose]).toHaveBeenCalled();
    const stored = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(project.id).first();
    expect(JSON.stringify([project, stored])).not.toContain(INITIAL_TOKEN);
    expect(artifacts.binding.delete).not.toHaveBeenCalled();
  });

  it("recovers a create whose service acknowledgement was lost without overwriting its contents", async () => {
    const { ctx, artifacts } = await fixture();
    artifacts.binding.create.mockImplementationOnce(async () => {
      artifacts.repos.set("recover", fakeRepo("recover", { description: "Existing contents" }));
      throw new Error(`lost response ${INITIAL_TOKEN}`);
    });

    try {
      await createRepository(ctx, { name: "recover" });
      throw new Error("expected failure");
    } catch (cause) {
      expect(cause).toBeInstanceOf(TempoError);

      if (!(cause instanceof TempoError)) throw cause;
      expect(cause.code).toBe("ARTIFACTS_API_ERROR");
      expect(JSON.stringify(cause.toBody())).not.toContain(INITIAL_TOKEN);
    }

    const project = await createRepository(ctx, { name: "recover", description: "Replacement" });
    expect(project.artifactRepoId).toBe("repo-recover");
    expect(artifacts.repos.get("recover")!.metadata.description).toBe("Existing contents");
    expect(artifacts.binding.delete).not.toHaveBeenCalled();
  });

  it("imports a public HTTPS remote and recovers an existing import", async () => {
    const { ctx, artifacts } = await fixture();

    const repo = await importRepository(ctx, {
      name: "imported",
      url: "https://github.com/example/project.git",
      description: "Baseline",
    });

    expect(artifacts.binding.import).toHaveBeenCalledWith({
      source: { url: "https://github.com/example/project.git" },
      target: { name: "imported", opts: { description: "Baseline" } },
    });
    expect(artifacts.repos.get("imported")!.repo.revokeToken).toHaveBeenCalledWith(INITIAL_TOKEN);
    expect(JSON.stringify(repo)).not.toContain(INITIAL_TOKEN);
    const imported = fakeRepo("already-imported");
    artifacts.repos.set("already-imported", imported);
    expect(
      (
        await importRepository(ctx, {
          name: "already-imported",
          url: "https://github.com/example/project.git",
        })
      ).artifactRepoId,
    ).toBe(imported.metadata.id);
  });

  it("links an existing repository idempotently without creating or deleting it", async () => {
    const { ctx, artifacts } = await fixture();
    artifacts.repos.set("existing", fakeRepo("existing"));
    const project = await linkArtifactRepository(ctx, { name: "existing" });
    expect(await linkArtifactRepository(ctx, { name: "existing" })).toEqual(project);
    expect(artifacts.binding.create).not.toHaveBeenCalled();
    expect(artifacts.binding.delete).not.toHaveBeenCalled();
  });

  it("converges concurrent creates on one project and tolerates initial token revocation failures", async () => {
    const { ctx, artifacts } = await fixture();
    const repo = fakeRepo("concurrent");
    repo.repo.revokeToken.mockRejectedValue(nativeError("INTERNAL_ERROR", INITIAL_TOKEN));
    artifacts.binding.create.mockImplementationOnce(async () => {
      artifacts.repos.set("concurrent", repo);

      return {
        id: repo.metadata.id,
        name: "concurrent",
        description: null,
        defaultBranch: "main",
        remote: repo.metadata.remote,
        token: INITIAL_TOKEN,
      };
    });

    const results = await Promise.all([
      createRepository(ctx, { name: "concurrent" }),
      createRepository(ctx, { name: "concurrent" }),
    ]);

    expect(results[0]?.id).toBe(results[1]?.id);
    expect(JSON.stringify(results)).not.toContain(INITIAL_TOKEN);

    const rows = await env.DB.prepare("SELECT id FROM projects WHERE user_id = ? AND artifact_repo_id = ?")
      .bind(ctx.user.id, "repo-concurrent")
      .all();

    expect(rows.results).toHaveLength(1);
  });

  it("rejects invalid names, branches, credential-bearing imports, and absent bindings", async () => {
    const { ctx, artifacts } = await fixture();
    await expect(createRepository(ctx, { name: "../escape" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(
      createRepository(ctx, { name: "valid", defaultBranch: "bad..branch" }),
    ).rejects.toMatchObject({ code: "BRANCH_INVALID" });

    for (const url of [
      "http://github.com/example/repo",
      "https://secret@github.com/example/repo",
      "https://x:secret@github.com/example/repo",
      "https://github.com/example/repo?token=secret",
      "https://github.com/example/repo#main",
      "not-a-url",
    ]) {
      await expect(importRepository(ctx, { name: "valid", url })).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
    }

    expect(artifacts.binding.create).not.toHaveBeenCalled();
    expect(artifacts.binding.import).not.toHaveBeenCalled();
    await expect(
      createRepository({ ...ctx, env: { ...ctx.env, ARTIFACTS: undefined } }, { name: "demo" }),
    ).rejects.toMatchObject({ code: "ARTIFACTS_NOT_CONFIGURED" });
  });

  it("does not treat stale linked metadata as a successful create or import retry", async () => {
    const { ctx, artifacts } = await fixture();
    await createRepository(ctx, { name: "stale" });
    artifacts.repos.set("stale", fakeRepo("stale", { id: "recreated-stale" }));
    await expect(createRepository(ctx, { name: "stale" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      importRepository(ctx, { name: "stale", url: "https://github.com/example/repo.git" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(artifacts.binding.create).toHaveBeenCalledTimes(1);
    expect(artifacts.binding.import).not.toHaveBeenCalled();
  });
});

describe("Artifacts repository browsing", () => {
  it("walks immutable tree hashes and exposes symlinks and submodules without following them", async () => {
    const { ctx, repo, project } = await populated();
    const root = await getRepository(ctx, { projectId: project.id });
    expect(root).toMatchObject({
      name: "demo",
      description: "Demo repo",
      ref: "main",
      empty: false,
      commit: COMMIT,
    });
    expect(root.entries.map((entry) => entry.type)).toEqual(["tree", "blob", "symlink", "gitlink"]);
    const directory = await getRepository(ctx, { projectId: project.id, path: "src" });
    expect(directory.entries[0]?.path).toBe("src/index.ts");
    expect(repo.repo.readTree).toHaveBeenCalledWith(SRC);
    await expect(getRepository(ctx, { projectId: project.id, path: "link" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(getRepository(ctx, { projectId: project.id, path: "dependency" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(repo.repo.readTree).not.toHaveBeenCalledWith("e".repeat(40));
    expect(repo.repo.readTree).not.toHaveBeenCalledWith("f".repeat(40));
  });

  it("represents a new empty default branch and rejects explicit missing refs", async () => {
    const { ctx, artifacts } = await fixture();
    artifacts.repos.set("empty", fakeRepo("empty"));
    const project = await linkArtifactRepository(ctx, { name: "empty" });
    expect(await getRepository(ctx, { projectId: project.id })).toMatchObject({
      empty: true,
      commit: null,
      entries: [],
      ref: "main",
    });
    await expect(getRepository(ctx, { projectId: project.id, ref: "missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(getRepository(ctx, { projectId: project.id, path: "missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("checks ownership, provider and stable repository identity before reading content", async () => {
    const { ctx, artifacts, repo, project, seeded } = await populated();
    artifacts.binding.get.mockClear();
    await expect(
      getRepository({ ...ctx, user: { ...ctx.user, id: "stranger" } }, { projectId: project.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getRepository(ctx, { projectId: seeded.projectId })).rejects.toMatchObject({
      code: "ARTIFACTS_API_ERROR",
    });
    expect(artifacts.binding.get).not.toHaveBeenCalled();
    repo.metadata.id = "recreated-repo";
    repo.repo.log.mockClear();
    await expect(getRepository(ctx, { projectId: project.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(repo.repo.log).not.toHaveBeenCalled();
  });

  it("rejects unsafe paths before resolving repository content", async () => {
    const { ctx, artifacts, project } = await populated();
    artifacts.binding.get.mockClear();

    for (const path of [
      "/etc/passwd",
      "../secret",
      "src/../secret",
      "src/./index.ts",
      "src//index.ts",
      "src\\index.ts",
      "src/\0bad",
    ]) {
      await expect(
        getRepositoryFile(ctx, { projectId: project.id, ref: "main", path }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }

    expect(artifacts.binding.get).not.toHaveBeenCalled();
  });

  it("validates bounded branch, tag, and commit references before binding access", async () => {
    const { ctx, artifacts, repo, project } = await populated();
    artifacts.binding.get.mockClear();

    for (const ref of [
      "",
      "main~1",
      "main^",
      "main^{tree}",
      "a b",
      "main\0",
      "refs/remotes/origin/main",
      "a".repeat(251),
    ]) {
      await expect(getRepository(ctx, { projectId: project.id, ref })).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
      await expect(
        getRepositoryFile(ctx, { projectId: project.id, ref, path: "README.md" }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      await expect(listRepositoryCommits(ctx, { projectId: project.id, ref })).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
    }

    expect(artifacts.binding.get).not.toHaveBeenCalled();

    for (const ref of ["HEAD", SHA, "refs/heads/main", "refs/tags/v1", "release/v1"]) {
      repo.commits.set(ref, [COMMIT]);
      expect((await getRepository(ctx, { projectId: project.id, ref })).commit?.hash).toBe(SHA);
    }
  });

  it("returns UTF-8 or base64 by content and caps previews at one MiB", async () => {
    const { ctx, repo, project } = await populated();
    expect(await getRepositoryFile(ctx, { projectId: project.id, ref: "main", path: "README.md" })).toEqual({
      content: "Hello 🌍",
      encoding: "utf8",
      size: 10,
    });
    repo.files.set("main:binary", new Blob([new Uint8Array([255, 0, 128])]));
    expect(await getRepositoryFile(ctx, { projectId: project.id, ref: "main", path: "binary" })).toEqual({
      content: "/wCA",
      encoding: "base64",
      size: 3,
    });
    repo.files.set("main:large", new Blob([new Uint8Array(1024 * 1024 + 1)]));
    await expect(
      getRepositoryFile(ctx, { projectId: project.id, ref: "main", path: "large" }),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await expect(
      getRepositoryFile(ctx, { projectId: project.id, ref: "main", path: "missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("pages first-parent commit history and rejects negative or fractional offsets", async () => {
    const { ctx, repo, project } = await populated();
    repo.commits.set(
      "main",
      Array.from({ length: 60 }, (_, n) => ({ ...COMMIT, message: `Commit ${n}` })),
    );
    const page = await listRepositoryCommits(ctx, { projectId: project.id, offset: 7 });
    expect(page).toHaveLength(50);
    expect(page[0]?.message).toBe("Commit 7");
    expect(repo.repo.log).toHaveBeenLastCalledWith({ ref: "main", limit: 50, offset: 7 });
    expect(await listRepositoryCommits(ctx, { projectId: project.id, offset: 100 })).toEqual([]);
    await expect(listRepositoryCommits(ctx, { projectId: project.id, ref: "missing" })).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );

    for (const offset of [-1, 0.5, Infinity]) {
      await expect(listRepositoryCommits(ctx, { projectId: project.id, offset })).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
    }
  });
});

describe("Artifacts Git refs and scoped tokens", () => {
  it("checks stable repository identity before reusing cached credentials or fetching refs", async () => {
    const { ctx, artifacts, repo } = await populated();
    expect((await assertArtifactRepositoryIdentity(ctx.env, "demo", "repo-demo")).id).toBe("repo-demo");
    await expect(assertArtifactRepositoryIdentity(ctx.env, "demo", null)).rejects.toMatchObject({
      code: "REPO_NOT_ACCESSIBLE",
    });
    await artifactToken(ctx.env, "demo", "write", "repo-demo");
    expect(repo.repo.createToken).toHaveBeenCalledTimes(1);
    const replacement = fakeRepo("demo", { id: "replacement-demo" });
    artifacts.repos.set("demo", replacement);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(assertArtifactRepositoryIdentity(ctx.env, "demo", "repo-demo")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(artifactToken(ctx.env, "demo", "write", "repo-demo")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(artifactBranchExists(ctx.env, "demo", "main", "repo-demo")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(listArtifactBranches(ctx.env, "demo", undefined, "repo-demo")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(replacement.repo.createToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    await artifactToken(ctx.env, "demo", "write", "replacement-demo");
    expect(replacement.repo.createToken).toHaveBeenCalledTimes(1);
  });

  it("rejects replacement between metadata inspection and Git credential minting", async () => {
    const { ctx, artifacts, repo } = await populated();
    const replacement = fakeRepo("demo", { id: "replacement-demo" });
    artifacts.binding.get.mockResolvedValueOnce(repo.repo).mockResolvedValueOnce(replacement.repo);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(listArtifactBranches(ctx.env, "demo", undefined, "repo-demo")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(replacement.repo.createToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("allows scoped read access to read-only repositories and rejects writes before minting", async () => {
    const { ctx, repo } = await populated();
    repo.metadata.readOnly = true;
    await expect(artifactToken(ctx.env, "demo", "write", "repo-demo")).rejects.toMatchObject({
      code: "REPO_NOT_ACCESSIBLE",
    });
    expect(repo.repo.createToken).not.toHaveBeenCalled();
    await expect(artifactToken(ctx.env, "demo", "read", "repo-demo")).resolves.toBe(TOKEN);
    expect(repo.repo.createToken).toHaveBeenCalledWith("read", 600);
  });

  it("uses the documented remote and a scoped Bearer token, exposing branches only", async () => {
    const { ctx, repo } = await populated();

    const fetcher = vi.fn(async (_url: URL, _options: RequestInit) =>
      advertisement([
        `${SHA} HEAD\0multi_ack symref=HEAD:refs/heads/main\n`,
        `${SHA} refs/heads/main\n`,
        `${SHA} refs/heads/feature/work\n`,
        `${SHA} refs/tags/v1\n`,
      ]),
    );

    vi.stubGlobal("fetch", fetcher);
    expect(await listArtifactBranches(ctx.env, "demo")).toEqual([{ name: "feature/work" }, { name: "main" }]);
    expect(await listArtifactBranches(ctx.env, "demo", "WORK")).toEqual([{ name: "feature/work" }]);
    expect(await artifactBranchExists(ctx.env, "demo", "feature/work")).toBe(true);
    expect(await artifactBranchExists(ctx.env, "demo", "absent")).toBe(false);
    expect(repo.repo.createToken).toHaveBeenCalledTimes(1);
    expect(repo.repo.createToken).toHaveBeenCalledWith("read", 600);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url.href).toBe(`${REMOTE}/demo.git/info/refs?service=git-upload-pack`);
    expect(new Headers(options.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(options.redirect).toBe("manual");
    expect(await artifactToken(ctx.env, "demo", "write")).toBe(TOKEN);
    expect(repo.repo.createToken).toHaveBeenLastCalledWith("write", 600);
    expect(await artifactHeadSha(ctx.env, "demo", "main")).toBe(SHA);
    expect(await artifactHeadSha(ctx.env, "demo", "missing")).toBeNull();
    await expect(artifactHeadSha(ctx.env, "demo", "bad..branch")).rejects.toMatchObject({
      code: "BRANCH_INVALID",
    });
  });

  it("does not inject credentials into untrusted or mismatched repository remotes", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const { ctx, repo } = await populated();

    for (const remote of [
      "https://attacker.example/git/tempo-repos/demo.git",
      `${REMOTE}/other.git`,
      `${REMOTE}/demo.git?token=secret`,
      `${REMOTE}/demo.git#fragment`,
      `${REMOTE.replace("https:", "http:")}/demo.git`,
      `${REMOTE.replace("https://", "https://x:secret@")}/demo.git`,
      `${REMOTE}/../tempo-repos/demo.git`,
    ]) {
      repo.metadata.remote = remote;
      await expect(listArtifactBranches(ctx.env, "demo")).rejects.toMatchObject({
        code: "ARTIFACTS_API_ERROR",
      });
    }

    expect(fetcher).not.toHaveBeenCalled();
    expect(repo.repo.createToken).not.toHaveBeenCalled();
    expect(() => assertArtifactRemote(`${REMOTE}/demo.git/info/refs`, "demo")).toThrow(TempoError);
  });

  it("fails safely on malformed, oversized, redirected or denied Git responses", async () => {
    const { ctx } = await populated();

    for (const response of [
      new Response("not git", { headers: { "Content-Type": "text/html" } }),
      new Response("001e# service=git-upload-pack\n00000012truncated", {
        headers: { "Content-Type": "application/x-git-upload-pack-advertisement" },
      }),
      new Response("x".repeat(2 * 1024 * 1024 + 1), {
        headers: { "Content-Type": "application/x-git-upload-pack-advertisement" },
      }),
      new Response(null, { status: 302, headers: { Location: "https://attacker.example" } }),
      new Response("denied", { status: 403 }),
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response),
      );
      await expect(listArtifactBranches(ctx.env, "demo")).rejects.toMatchObject({
        code: "ARTIFACTS_API_ERROR",
      });
    }
  });
});
