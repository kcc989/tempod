import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { SettingsLayer, TempoError, type Project, type ProjectRole } from "@tempo/protocol";
import { Option, Schema } from "effect";
import * as schema from "../../db/d1.ts";
import type { Env } from "../../env.ts";
import { requireGithubAppConfig } from "../../github/app.ts";
import { mintInstallationToken } from "../../github/api.ts";
import { artifactToken } from "../../artifacts/repositories.ts";
import { accessOf, requireProjectAccess, type ProjectNeed } from "../../auth/access.ts";
import type { AuthedUser } from "../../auth/auth.ts";

export const d1 = (env: Env) => drizzle(env.DB, { schema });

const decodeLayer = Schema.decodeUnknownOption(SettingsLayer);

export const projectToWire = (r: schema.ProjectRow): Project => {
  const settings = decodeLayer(safeJson(r.settingsJson));

  return {
    id: r.id,
    installationId: r.installationId,
    repoId: r.repoId,
    provider: r.provider,
    artifactRepoId: r.artifactRepoId,
    cloneUrl: r.cloneUrl,
    owner: r.repoOwner,
    // 11, Artifacts storage names: a native project shows its slug, not its storage name.
    name: r.provider === "artifacts" ? r.slug : r.repoName,
    defaultBranch: r.defaultBranch,
    settings: Option.isSome(settings) ? settings.value : {},
    sortOrder: r.sortOrder,
    environmentId: r.environmentId,
    organizationId: r.organizationId,
    slug: r.slug,
    visibility: r.visibility,
  };
};

/** The namespace of a project: its organization slug, else its owner's username (11). */
export const namespaceOf = async (env: Env, r: schema.ProjectRow): Promise<string> => {
  if (r.organizationId !== null) {
    const org = await d1(env)
      .select({ slug: schema.organization.slug })
      .from(schema.organization)
      .where(eq(schema.organization.id, r.organizationId))
      .get();

    return org?.slug ?? r.organizationId;
  }

  const owner = await d1(env)
    .select({ username: schema.user.username })
    .from(schema.user)
    .where(eq(schema.user.id, r.userId))
    .get();

  return owner?.username ?? r.userId;
};

/** `Project` with the namespace and the caller's role (11, Server functions). */
export const projectView = async (
  env: Env,
  viewer: AuthedUser | null,
  r: schema.ProjectRow,
  role?: ProjectRole | null,
): Promise<Project> => ({
  ...projectToWire(r),
  namespace: await namespaceOf(env, r),
  role: role !== undefined ? role : (await accessOf(env, viewer, r)).memberRole,
});

/** The owner key of a project's namespace: its organization id, else its owner's user id (11). */
export const namespaceKey = sql<string>`coalesce(${schema.projects.organizationId}, ${schema.projects.userId})`;

/** Ids of the projects `userId` holds, as a subquery (11, Shared project configuration). */
export const heldProjectIds = (env: Env, userId: string) =>
  d1(env).select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.userId, userId));

export const safeJson = (text: string): Schema.Json => {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
};

/** The project, after the caller's role passes `need` (11, Function access). */
export const requireProject = async (
  env: Env,
  viewer: AuthedUser | null,
  projectId: string,
  need: ProjectNeed,
): Promise<schema.ProjectRow> => (await requireProjectAccess(env, viewer, projectId, need)).project;

export const requireInstallation = async (
  env: Env,
  userId: string,
  installationId: number,
): Promise<schema.InstallationRow> => {
  const row = await d1(env)
    .select()
    .from(schema.githubInstallations)
    .where(
      and(
        eq(schema.githubInstallations.installationId, installationId),
        eq(schema.githubInstallations.userId, userId),
      ),
    )
    .get();

  if (!row) throw new TempoError("NOT_FOUND", undefined, "installation not found");

  return row;
};

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Installation token for the Worker's own GitHub calls, scoped to one repo when given. */
export const installationToken = async (
  env: Env,
  installationId: number,
  repoId?: number,
): Promise<string> => {
  const key = `${installationId}:${repoId ?? "*"}`;
  const hit = tokenCache.get(key);

  if (hit && hit.expiresAt - 5 * 60_000 > Date.now()) return hit.token;

  const token = await mintInstallationToken(
    await requireGithubAppConfig(env),
    installationId,
    repoId ? [repoId] : undefined,
  );

  tokenCache.set(key, token);

  return token.token;
};

export const projectToken = (env: Env, p: schema.ProjectRow) => {
  if (p.provider === "artifacts") {
    if (!p.artifactRepoId) throw new TempoError("REPO_NOT_ACCESSIBLE");

    return artifactToken(env, p.repoName, "write", p.artifactRepoId);
  }

  if (p.installationId === null || p.repoId === null) throw new TempoError("REPO_NOT_ACCESSIBLE");

  return installationToken(env, p.installationId, p.repoId);
};

export const repoOf = (p: schema.ProjectRow) => ({ owner: p.repoOwner, name: p.repoName });
