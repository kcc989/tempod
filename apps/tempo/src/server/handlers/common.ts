import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { SettingsLayer, TempoError, type Project } from "@tempo/protocol";
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
