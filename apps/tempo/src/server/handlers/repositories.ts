import { and, eq, sql } from "drizzle-orm";
import { TempoError, newId, type FnInput, type FnOutput } from "@tempo/protocol";
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
import { projects, type ProjectRow } from "../../db/d1.ts";
import { bytesToBase64 } from "../../lib/crypto.ts";
import type { HandlerCtx } from "../run.ts";
import { d1, projectToWire, requireProject } from "./common.ts";

const MAX_FILE_BYTES = 1024 * 1024;

const existingRepository = async ({ env, user }: HandlerCtx, name: string): Promise<ProjectRow | undefined> =>
  d1(env)
    .select()
    .from(projects)
    .where(and(eq(projects.userId, user.id), eq(projects.provider, "artifacts"), eq(projects.repoName, name)))
    .get();

const linkRepository = async (
  ctx: HandlerCtx,
  info: ArtifactsRepoInfo,
): Promise<FnOutput<"createRepository">> => {
  const { env, user } = ctx;
  assertArtifactRemote(info.remote, info.name);
  const db = d1(env);

  const linked = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.userId, user.id),
        eq(projects.provider, "artifacts"),
        eq(projects.artifactRepoId, info.id),
      ),
    )
    .get();

  if (linked) return projectToWire(linked);

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
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(projects).values(row).onConflictDoNothing().run();

  const saved = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.userId, user.id),
        eq(projects.provider, "artifacts"),
        eq(projects.artifactRepoId, info.id),
      ),
    )
    .get();

  if (!saved) throw new TempoError("ARTIFACTS_API_ERROR", undefined, "The repository could not be linked.");

  return projectToWire(saved);
};

const revokeInitialToken = async (env: HandlerCtx["env"], name: string, token: string): Promise<void> => {
  try {
    await withArtifactRepository(env, name, (repo) => repo.revokeToken(token));
  } catch {
    // Imports can return before a disposable repository handle is available.
  }
};

/** 09: `dotfiles-` names hold owners' shell files (01, Shell and dotfiles) and never become projects. */
const validateProjectRepoName = (name: string): void => {
  validateArtifactName(name);

  if (name.toLowerCase().startsWith("dotfiles-"))
    throw new TempoError("VALIDATION_FAILED", undefined, "Names that start with dotfiles- are reserved.");
};

export const createRepository = async (
  ctx: HandlerCtx,
  { name, description, defaultBranch }: FnInput<"createRepository">,
): Promise<FnOutput<"createRepository">> => {
  validateProjectRepoName(name);
  validateArtifactBranch(defaultBranch ?? "main");
  requireArtifacts(ctx.env);
  const linked = await existingRepository(ctx, name);

  if (linked) {
    await assertArtifactRepositoryIdentity(ctx.env, name, linked.artifactRepoId);

    return projectToWire(linked);
  }

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

  return linkRepository(ctx, await repoInfo(ctx.env, name));
};

export const importRepository = async (
  ctx: HandlerCtx,
  { name, url, description }: FnInput<"importRepository">,
): Promise<FnOutput<"importRepository">> => {
  validateProjectRepoName(name);
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
  const linked = await existingRepository(ctx, name);

  if (linked) {
    await assertArtifactRepositoryIdentity(ctx.env, name, linked.artifactRepoId);

    return projectToWire(linked);
  }

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

  return linkRepository(ctx, await repoInfo(ctx.env, name));
};

export const linkArtifactRepository = async (
  ctx: HandlerCtx,
  { name }: FnInput<"linkArtifactRepository">,
): Promise<FnOutput<"linkArtifactRepository">> => {
  validateProjectRepoName(name);

  return linkRepository(ctx, await repoInfo(ctx.env, name));
};

const requireNativeProject = async (ctx: HandlerCtx, projectId: string): Promise<ProjectRow> => {
  const project = await requireProject(ctx.env, ctx.user.id, projectId);

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
  ctx: HandlerCtx,
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
      name: info.name,
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
  ctx: HandlerCtx,
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
  ctx: HandlerCtx,
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
