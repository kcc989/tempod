import { and, eq, sql } from "drizzle-orm";
import {
  TempoError,
  newId,
  type FnInput,
  type FnOutput,
  type Project,
  type ProjectVisibility,
} from "@tempo/protocol";
import {
  artifactCall,
  artifactErrorCode,
  assertArtifactRemote,
  assertArtifactRepositoryIdentity,
  repoInfo,
  requireArtifacts,
  validateArtifactBranch,
  validateArtifactName,
  validateArtifactRef,
  withArtifactRepository,
} from "../../artifacts/repositories.ts";
import { requireOrganizationAdmin } from "../../auth/access.ts";
import { projects, type ProjectRow } from "../../db/d1.ts";
import { bytesToBase64, sha256Hex } from "../../lib/crypto.ts";
import type { HandlerCtx, PublicCtx } from "../run.ts";
import { d1, namespaceKey, projectView, requireProject } from "./common.ts";

const MAX_FILE_BYTES = 1024 * 1024;

/** Who a new project belongs to (11, Function access). */
interface NewOwner {
  readonly organizationId: string | null;
  readonly key: string;
  readonly visibility: ProjectVisibility;
}

const newOwner = async (
  { env, user }: HandlerCtx,
  organizationId: string | undefined,
  visibility: ProjectVisibility | undefined,
): Promise<NewOwner> => {
  if (organizationId !== undefined) await requireOrganizationAdmin(env, user.id, organizationId);

  return {
    organizationId: organizationId ?? null,
    key: organizationId ?? user.id,
    visibility: visibility ?? "private",
  };
};

const MAX_SLUG = 100;

/** `t<hash>-<slug>`: the flat Artifacts namespace name of a new project (11, Artifacts storage names). */
export const artifactStorageName = async (key: string, slug: string): Promise<string> =>
  `t${(await sha256Hex(key)).slice(0, 12)}-${slug}`;

const validateSlug = (slug: string): void => {
  validateArtifactName(slug);

  if (slug.length > MAX_SLUG)
    throw new TempoError(
      "VALIDATION_FAILED",
      undefined,
      `Repository names are at most ${MAX_SLUG} characters.`,
    );
};

const existingRepository = async (
  env: HandlerCtx["env"],
  key: string,
  slug: string,
): Promise<ProjectRow | undefined> =>
  d1(env)
    .select()
    .from(projects)
    .where(and(eq(namespaceKey, key), sql`lower(${projects.slug}) = lower(${slug})`))
    .get();

const linkRepository = async (
  ctx: HandlerCtx,
  info: ArtifactsRepoInfo,
  owner: NewOwner,
  slug: string,
): Promise<FnOutput<"createRepository">> => {
  const { env, user } = ctx;
  assertArtifactRemote(info.remote, info.name);
  const db = d1(env);
  const byRepo = () => db.select().from(projects).where(eq(projects.artifactRepoId, info.id)).get();
  const linked = await byRepo();

  if (linked) {
    if (linked.provider !== "artifacts" || (linked.organizationId ?? linked.userId) !== owner.key)
      throw new TempoError("PROJECT_EXISTS");

    return projectView(env, user, linked);
  }

  const taken = await existingRepository(env, owner.key, slug);

  if (taken) throw new TempoError("PROJECT_EXISTS");

  const max = await db
    .select({ m: sql<number>`coalesce(max(${projects.sortOrder}), 0)` })
    .from(projects)
    .where(eq(projects.userId, user.id))
    .get();

  const now = Date.now();

  const row: ProjectRow = {
    id: newId(),
    userId: user.id,
    provider: "artifacts",
    installationId: null,
    repoId: null,
    artifactRepoId: info.id,
    cloneUrl: info.remote,
    repoOwner: "tempo",
    repoName: info.name,
    defaultBranch: info.defaultBranch,
    settingsJson: "{}",
    sortOrder: (max?.m ?? 0) + 1,
    environmentId: null,
    organizationId: owner.organizationId,
    slug,
    visibility: owner.visibility,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(projects).values(row).onConflictDoNothing().run();
  const saved = await byRepo();

  if (!saved) throw new TempoError("ARTIFACTS_API_ERROR", undefined, "The repository could not be linked.");

  if ((saved.organizationId ?? saved.userId) !== owner.key) throw new TempoError("PROJECT_EXISTS");

  return projectView(env, user, saved);
};

/** A retry finds the project it already linked, if its Artifacts repository is the same (09). */
const recovered = async (ctx: HandlerCtx, owner: NewOwner, slug: string): Promise<Project | null> => {
  const linked = await existingRepository(ctx.env, owner.key, slug);

  if (!linked) return null;

  if (linked.provider !== "artifacts") throw new TempoError("PROJECT_EXISTS");
  await assertArtifactRepositoryIdentity(ctx.env, linked.repoName, linked.artifactRepoId);

  return projectView(ctx.env, ctx.user, linked);
};

const revokeInitialToken = async (env: HandlerCtx["env"], name: string, token: string): Promise<void> => {
  try {
    await withArtifactRepository(env, name, (repo) => repo.revokeToken(token));
  } catch {
    // Imports can return before a disposable repository handle is available.
  }
};

export const createRepository = async (
  ctx: HandlerCtx,
  { name: slug, description, defaultBranch, organizationId, visibility }: FnInput<"createRepository">,
): Promise<FnOutput<"createRepository">> => {
  validateSlug(slug);
  validateArtifactBranch(defaultBranch ?? "main");
  requireArtifacts(ctx.env);
  const owner = await newOwner(ctx, organizationId, visibility);
  const linked = await recovered(ctx, owner, slug);

  if (linked) return linked;
  const name = await artifactStorageName(owner.key, slug);

  await artifactCall(async () => {
    try {
      const options: NonNullable<Parameters<Artifacts["create"]>[1]> = {
        setDefaultBranch: defaultBranch ?? "main",
      };

      if (description !== undefined) options.description = description;
      const created = await requireArtifacts(ctx.env).create(name, options);

      await revokeInitialToken(ctx.env, name, created.token);
    } catch (cause) {
      if (artifactErrorCode(cause) !== "ALREADY_EXISTS") throw cause;
    }
  });

  return linkRepository(ctx, await repoInfo(ctx.env, name), owner, slug);
};

export const importRepository = async (
  ctx: HandlerCtx,
  { name: slug, url, description, organizationId, visibility }: FnInput<"importRepository">,
): Promise<FnOutput<"importRepository">> => {
  validateSlug(slug);
  let remote: URL;

  try {
    remote = new URL(url);
  } catch {
    throw new TempoError("VALIDATION_FAILED", undefined, "Use a public HTTPS Git remote.");
  }

  if (remote.protocol !== "https:" || remote.username || remote.password || remote.search || remote.hash)
    throw new TempoError(
      "VALIDATION_FAILED",
      undefined,
      "Use a public HTTPS Git remote without credentials.",
    );
  requireArtifacts(ctx.env);
  const owner = await newOwner(ctx, organizationId, visibility);
  const linked = await recovered(ctx, owner, slug);

  if (linked) return linked;
  const name = await artifactStorageName(owner.key, slug);

  await artifactCall(async () => {
    try {
      const target: Parameters<Artifacts["import"]>[0]["target"] = { name };

      if (description !== undefined) target.opts = { description };

      const imported = await requireArtifacts(ctx.env).import({
        source: { url: remote.href },
        target,
      });

      await revokeInitialToken(ctx.env, name, imported.token);
    } catch (cause) {
      if (artifactErrorCode(cause) !== "ALREADY_EXISTS") throw cause;
    }
  });

  return linkRepository(ctx, await repoInfo(ctx.env, name), owner, slug);
};

/** Instance admin only (11): links an Artifacts repository into the caller's own namespace. */
export const linkArtifactRepository = async (
  ctx: HandlerCtx,
  { name }: FnInput<"linkArtifactRepository">,
): Promise<FnOutput<"linkArtifactRepository">> => {
  validateSlug(name);

  return linkRepository(
    ctx,
    await repoInfo(ctx.env, name),
    { organizationId: null, key: ctx.user.id, visibility: "private" },
    name,
  );
};

const requireNativeProject = async (ctx: PublicCtx, projectId: string): Promise<ProjectRow> => {
  const project = await requireProject(ctx.env, ctx.user, projectId, "public");

  if (project.provider !== "artifacts" || !project.artifactRepoId)
    throw new TempoError(
      "ARTIFACTS_API_ERROR",
      undefined,
      "Open GitHub repositories on GitHub to browse their contents.",
    );

  return project;
};

const repositoryPath = (path: string, allowRoot = false): string[] => {
  if (allowRoot && path === "") return [];
  const parts = path.split("/");

  if (
    path.includes("\\") ||
    [...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    parts.some((part) => part === "" || part === "." || part === "..")
  )
    throw new TempoError("VALIDATION_FAILED", undefined, "Use a repository-relative path.");

  return parts;
};

const requireRepositoryIdentity = async (
  repo: ArtifactsRepo,
  project: ProjectRow,
): Promise<ArtifactsRepoInfo> => {
  const info = await repo.info();
  assertArtifactRemote(info.remote, project.repoName);

  if (info.id !== project.artifactRepoId)
    throw new TempoError("NOT_FOUND", undefined, "The linked repository no longer exists.");

  return info;
};

export const getRepository = async (
  ctx: PublicCtx,
  { projectId, ref, path = "" }: FnInput<"getRepository">,
): Promise<FnOutput<"getRepository">> => {
  const project = await requireNativeProject(ctx, projectId);
  const parts = repositoryPath(path, true);

  if (ref !== undefined) validateArtifactRef(ref);

  return withArtifactRepository(ctx.env, project.repoName, async (repo) => {
    const info = await requireRepositoryIdentity(repo, project);
    const resolvedRef = ref ?? info.defaultBranch;
    const commit = (await repo.log({ ref: resolvedRef, limit: 1 }))[0] ?? null;

    if (!commit && (ref !== undefined || info.lastPushAt !== null)) throw new TempoError("NOT_FOUND");
    let entries: ArtifactsTreeEntry[] = [];

    if (commit) {
      let tree = await repo.readTree(commit.treeHash);

      if (tree === null) throw new TempoError("NOT_FOUND");

      for (const part of parts) {
        const directory = tree.find((entry) => entry.name === part && entry.type === "tree");

        if (!directory) throw new TempoError("NOT_FOUND");
        tree = await repo.readTree(directory.hash);

        if (tree === null) throw new TempoError("NOT_FOUND");
      }

      entries = tree;
    } else if (parts.length > 0) throw new TempoError("NOT_FOUND");

    return {
      projectId,
      name: project.slug,
      description: info.description,
      defaultBranch: info.defaultBranch,
      remote: info.remote,
      readOnly: info.readOnly,
      ref: resolvedRef,
      empty: commit === null,
      entries: entries.map((entry) => ({
        name: entry.name,
        path: [...parts, entry.name].join("/"),
        hash: entry.hash,
        type: entry.type,
      })),
      commit,
    };
  });
};

export const getRepositoryFile = async (
  ctx: PublicCtx,
  { projectId, ref, path }: FnInput<"getRepositoryFile">,
): Promise<FnOutput<"getRepositoryFile">> => {
  const project = await requireNativeProject(ctx, projectId);
  repositoryPath(path);
  validateArtifactRef(ref);

  return withArtifactRepository(ctx.env, project.repoName, async (repo) => {
    await requireRepositoryIdentity(repo, project);
    const file = await repo.readFile({ ref, path });

    if (file === null) throw new TempoError("NOT_FOUND");

    if (file.size > MAX_FILE_BYTES) throw new TempoError("FILE_TOO_LARGE");
    const bytes = new Uint8Array(await file.arrayBuffer());

    try {
      return {
        content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        encoding: "utf8",
        size: bytes.length,
      };
    } catch {
      return { content: bytesToBase64(bytes), encoding: "base64", size: bytes.length };
    }
  });
};

export const listRepositoryCommits = async (
  ctx: PublicCtx,
  { projectId, ref, offset }: FnInput<"listRepositoryCommits">,
): Promise<FnOutput<"listRepositoryCommits">> => {
  const project = await requireNativeProject(ctx, projectId);

  if (ref !== undefined) validateArtifactRef(ref);

  if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0))
    throw new TempoError("VALIDATION_FAILED", undefined, "History offset must be a nonnegative integer.");

  return withArtifactRepository(ctx.env, project.repoName, async (repo) => {
    const info = await requireRepositoryIdentity(repo, project);
    const resolvedRef = ref ?? info.defaultBranch;
    const page = await repo.log({ ref: resolvedRef, limit: 50, offset: offset ?? 0 });

    if (page.length === 0 && (ref !== undefined || info.lastPushAt !== null)) {
      const exists = (offset ?? 0) > 0 && (await repo.log({ ref: resolvedRef, limit: 1 })).length > 0;

      if (!exists) throw new TempoError("NOT_FOUND");
    }

    return page;
  });
};
