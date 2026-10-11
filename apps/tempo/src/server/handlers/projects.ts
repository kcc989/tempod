import { waitUntil } from "cloudflare:workers";
import { and, eq, isNull, sql } from "drizzle-orm";
import { TempoError, newId, type FnInput, type FnOutput } from "@tempo/protocol";
import { validateOverrides } from "@tempo/settings";
import { githubInstallations, projects, workspaces } from "../../db/d1.ts";
import { requireGithubAppConfig } from "../../github/app.ts";
import { getRepoById, listAppInstallations, listInstallationRepos } from "../../github/api.ts";
import { GithubHttpError } from "../../github/client.ts";
import { github } from "../../github/provider.ts";
import { log } from "../../log.ts";
import type { HandlerCtx } from "../run.ts";
import { d1, installationToken, projectToWire, projectToken, repoOf, requireInstallation, requireProject } from "./common.ts";

/** Syncs D1 with GET /app/installations (05), then lists them. */
export const listInstallations = async ({ env, user }: HandlerCtx): Promise<FnOutput<"listInstallations">> => {
  const config = await requireGithubAppConfig(env);
  const remote = await listAppInstallations(config);
  const db = d1(env);
  const now = Date.now();
  for (const inst of remote) {
    const accountType = inst.account?.type === "Organization" ? "Organization" : "User";
    const suspendedAt = inst.suspended_at ? Date.parse(inst.suspended_at) : null;
    await db
      .insert(githubInstallations)
      .values({
        id: newId(),
        userId: user.id,
        installationId: inst.id,
        accountLogin: inst.account?.login ?? String(inst.id),
        accountType,
        suspendedAt,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: githubInstallations.installationId,
        set: { accountLogin: inst.account?.login ?? String(inst.id), accountType, suspendedAt },
      })
      .run();
  }
  const rows = await db.select().from(githubInstallations).where(eq(githubInstallations.userId, user.id)).all();
  const live = new Set(remote.map((r) => r.id));
  return rows
    .filter((r) => live.has(r.installationId) && r.suspendedAt === null)
    .map((r) => ({ installationId: r.installationId, accountLogin: r.accountLogin, accountType: r.accountType }));
};

export const listInstallationReposFn = async (
  { env, user }: HandlerCtx,
  { installationId }: FnInput<"listInstallationRepos">,
): Promise<FnOutput<"listInstallationRepos">> => {
  await requireInstallation(env, user.id, installationId);
  const repos = await listInstallationRepos(await installationToken(env, installationId));
  return repos.map((r) => ({ repoId: r.id, owner: r.owner.login, name: r.name, defaultBranch: r.default_branch, private: r.private }));
};

export const linkProject = async ({ env, user }: HandlerCtx, { installationId, repoId }: FnInput<"linkProject">): Promise<FnOutput<"linkProject">> => {
  await requireInstallation(env, user.id, installationId);
  const db = d1(env);
  const exists = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.userId, user.id), eq(projects.repoId, repoId)))
    .get();
  if (exists) throw new TempoError("PROJECT_EXISTS");
  let repo;
  try {
    repo = await getRepoById(await installationToken(env, installationId, repoId), repoId);
  } catch (e) {
    if (e instanceof GithubHttpError && e.status < 500) throw new TempoError("REPO_NOT_ACCESSIBLE");
    if (e instanceof TempoError && e.code === "GITHUB_API_ERROR") throw new TempoError("REPO_NOT_ACCESSIBLE", undefined, e.detail);
    throw e;
  }
  const max = await db
    .select({ m: sql<number>`coalesce(max(${projects.sortOrder}), 0)` })
    .from(projects)
    .where(eq(projects.userId, user.id))
    .get();
  const now = Date.now();
  const row = {
    id: newId(),
    userId: user.id,
    installationId,
    repoId,
    repoOwner: repo.owner.login,
    repoName: repo.name,
    defaultBranch: repo.default_branch,
    settingsJson: "{}",
    sortOrder: (max?.m ?? 0) + 1,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(projects).values(row).run();
  return projectToWire(row);
};

export const listProjects = async ({ env, user }: HandlerCtx): Promise<FnOutput<"listProjects">> => {
  const rows = await d1(env).select().from(projects).where(eq(projects.userId, user.id)).orderBy(projects.sortOrder).all();
  return rows.map(projectToWire);
};

const activeWorkspaceIds = async (env: HandlerCtx["env"], projectId: string): Promise<string[]> =>
  (
    await d1(env)
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.projectId, projectId), isNull(workspaces.archivedAt)))
      .all()
  ).map((r) => r.id);

export const updateProjectSettings = async (
  { env, user }: HandlerCtx,
  { projectId, settings }: FnInput<"updateProjectSettings">,
): Promise<FnOutput<"updateProjectSettings">> => {
  const row = await requireProject(env, user.id, projectId);
  const valid = validateOverrides(settings);
  if (!valid.ok) throw new TempoError("SETTINGS_INVALID", undefined, valid.error);
  const now = Date.now();
  await d1(env)
    .update(projects)
    .set({ settingsJson: JSON.stringify(valid.value), updatedAt: now })
    .where(eq(projects.id, projectId))
    .run();
  const refresh = Promise.all(
    (await activeWorkspaceIds(env, projectId)).map((id) => env.WORKSPACE.getByName(id).refreshSettings().catch(() => undefined)),
  );
  waitUntil(refresh);
  return projectToWire({ ...row, settingsJson: JSON.stringify(valid.value), updatedAt: now });
};

export const unlinkProject = async ({ env, user }: HandlerCtx, { projectId }: FnInput<"unlinkProject">): Promise<FnOutput<"unlinkProject">> => {
  await requireProject(env, user.id, projectId);
  if ((await activeWorkspaceIds(env, projectId)).length > 0) throw new TempoError("PROJECT_HAS_WORKSPACES");
  const archived = await d1(env).select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.projectId, projectId)).all();
  for (const w of archived) {
    const res = await env.WORKSPACE.getByName(w.id).deleteWorkspace({});
    if (!res.ok) log("warn", "workspace delete during unlink failed", { workspaceId: w.id, code: res.error.code });
  }
  await env.CREDENTIALS.getByName(user.id).deleteProjectEnv(projectId);
  await d1(env).delete(projects).where(eq(projects.id, projectId)).run();
  return {};
};

export const listBranches = async ({ env, user }: HandlerCtx, { projectId, query }: FnInput<"listBranches">): Promise<FnOutput<"listBranches">> => {
  const p = await requireProject(env, user.id, projectId);
  return github.listBranches(await projectToken(env, p), repoOf(p), query);
};

export const listOpenPullRequests = async (
  { env, user }: HandlerCtx,
  { projectId }: FnInput<"listOpenPullRequests">,
): Promise<FnOutput<"listOpenPullRequests">> => {
  const p = await requireProject(env, user.id, projectId);
  return github.listOpenPullRequests(await projectToken(env, p), repoOf(p));
};

