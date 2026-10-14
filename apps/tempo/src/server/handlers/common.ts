import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { SettingsLayer, TempoError, type Project } from "@tempo/protocol";
import type { AuthedUser } from "../../auth/auth.ts";
import { Option, Schema } from "effect";
import * as schema from "../../db/d1.ts";
import type { Env } from "../../env.ts";
import { requireGithubAppConfig } from "../../github/app.ts";
import { mintInstallationToken } from "../../github/api.ts";
import { artifactToken } from "../../artifacts/repositories.ts";

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
    name: r.repoName,
    defaultBranch: r.defaultBranch,
    settings: Option.isSome(settings) ? settings.value : {},
    sortOrder: r.sortOrder,
    environmentId: r.environmentId,
    slug: r.slug,
    visibility: r.visibility,
    pinned: r.pinnedAt !== null,
  };
};

export const safeJson = (text: string): Schema.Json => {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
};

export const requireProject = async (
  env: Env,
  userId: string,
  projectId: string,
): Promise<schema.ProjectRow> => {
  const row = await d1(env)
    .select()
    .from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), eq(schema.projects.userId, userId)))
    .get();

  if (!row) throw new TempoError("NOT_FOUND", undefined, "project not found");

  return row;
};

/** The user's username, or null before their first sign-in with this tab (11, Identity). */
export const usernameOf = async (env: Env, userId: string): Promise<string | null> =>
  (
    await d1(env)
      .select({ username: schema.user.username })
      .from(schema.user)
      .where(eq(schema.user.id, userId))
      .get()
  )?.username ?? null;

/**
 * A project for a `visitor` function (11, Function access): the caller's own project, or a public
 * one. Anything else is NOT_FOUND, so a private project's existence is not shown.
 */
export const requireReadableProject = async (
  env: Env,
  viewer: AuthedUser | null,
  projectId: string,
): Promise<schema.ProjectRow> => {
  const row = await d1(env).select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();

  if (!row || (row.userId !== viewer?.id && row.visibility !== "public"))
    throw new TempoError("NOT_FOUND", undefined, "project not found");

  return row;
};

export type NewProjectRow = Omit<schema.ProjectRow, "slug" | "visibility" | "pinnedAt">;

/** The slug choices of 11, Projects, in order. The last one holds the unique id, so it is always free. */
export const slugCandidates = (row: NewProjectRow): string[] => [
  row.repoName,
  `${row.repoOwner}-${row.repoName}`,
  `${row.repoOwner}-${row.repoName}-${row.id}`,
];

/**
 * Inserts a new project with the first slug the user does not have yet (11, Projects). Returns the
 * stored row, or null when another unique key (the same repository) already exists.
 */
export const insertProject = async (env: Env, row: NewProjectRow): Promise<schema.ProjectRow | null> => {
  const db = d1(env);
  const candidates = slugCandidates(row);

  const used = new Set(
    (
      await db
        .select({ slug: sql<string>`lower(${schema.projects.slug})` })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.userId, row.userId),
            inArray(
              sql`lower(${schema.projects.slug})`,
              candidates.map((c) => c.toLowerCase()),
            ),
          ),
        )
        .all()
    ).map((r) => r.slug),
  );

  for (const slug of candidates.filter((c) => !used.has(c.toLowerCase()))) {
    const stored: schema.ProjectRow = { ...row, slug, visibility: "private", pinnedAt: null };
    const res = await db.insert(schema.projects).values(stored).onConflictDoNothing().run();

    if (res.meta.changes > 0) return stored;
  }

  return null;
};

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
