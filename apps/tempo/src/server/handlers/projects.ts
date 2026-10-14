import { waitUntil } from "cloudflare:workers";
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { TempoError, newId, unwrap, type FnInput, type FnOutput, type Project } from "@tempo/protocol";
import { validateOverrides } from "@tempo/settings";
import { githubInstallations, member, projectMembers, projects, workspaces } from "../../db/d1.ts";
import { atLeast, membershipRole, requireOrganizationAdmin } from "../../auth/access.ts";
import { requireGithubAppConfig } from "../../github/app.ts";
import { getRepoById, listAppInstallations, listInstallationRepos } from "../../github/api.ts";
import { GithubHttpError } from "../../github/client.ts";
import { github } from "../../github/provider.ts";
import { listArtifactBranches } from "../../artifacts/repositories.ts";
import { listArtifactPullRequests } from "../../artifacts/pull-requests.ts";
import type { HandlerCtx, PublicCtx } from "../run.ts";
import {
  d1,
  installationToken,
  namespaceKey,
  projectView,
  projectToken,
  repoOf,
  requireInstallation,
  requireProject,
} from "./common.ts";

/** Syncs D1 with GET /app/installations (05), then lists them. */
export const listInstallations = async ({
  env,
  user,
}: HandlerCtx): Promise<FnOutput<"listInstallations">> => {
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

  const rows = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.userId, user.id))
    .all();

  const live = new Set(remote.map((r) => r.id));

  return rows
    .filter((r) => live.has(r.installationId) && r.suspendedAt === null)
    .map((r) => ({
      installationId: r.installationId,
      accountLogin: r.accountLogin,
      accountType: r.accountType,
    }));
};

export const listInstallationReposFn = async (
  { env, user }: HandlerCtx,
  { installationId }: FnInput<"listInstallationRepos">,
): Promise<FnOutput<"listInstallationRepos">> => {
  await requireInstallation(env, user.id, installationId);
  const repos = await listInstallationRepos(await installationToken(env, installationId));

  return repos.map((r) => ({
    repoId: r.id,
    owner: r.owner.login,
    name: r.name,
    defaultBranch: r.default_branch,
    private: r.private,
  }));
};

export const linkProject = async (
  { env, user }: HandlerCtx,
  { installationId, repoId, organizationId, visibility }: FnInput<"linkProject">,
): Promise<FnOutput<"linkProject">> => {
  await requireInstallation(env, user.id, installationId);

  if (organizationId !== undefined) await requireOrganizationAdmin(env, user.id, organizationId);
  const owner = organizationId ?? null;
  const db = d1(env);

  const exists = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(namespaceKey, owner ?? user.id), eq(projects.repoId, repoId)))
    .get();

  if (exists) throw new TempoError("PROJECT_EXISTS");
  let repo;

  try {
    repo = await getRepoById(await installationToken(env, installationId, repoId), repoId);
  } catch (e) {
    if (e instanceof GithubHttpError && e.status < 500) throw new TempoError("REPO_NOT_ACCESSIBLE");

    if (e instanceof TempoError && e.code === "GITHUB_API_ERROR")
      throw new TempoError("REPO_NOT_ACCESSIBLE", undefined, e.detail);
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
    provider: "github" as const,
    artifactRepoId: null,
    cloneUrl: null,
    repoOwner: repo.owner.login,
    repoName: repo.name,
    defaultBranch: repo.default_branch,
    settingsJson: "{}",
    sortOrder: (max?.m ?? 0) + 1,
    environmentId: null,
    organizationId: owner,
    slug: await freeSlug(env, owner ?? user.id, repo.name, `${repo.owner.login}-${repo.name}`),
    visibility: visibility ?? "private",
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(projects).values(row).run();

  return projectView(env, user, row, "admin");
};

/** The first slug from `candidates` that its namespace does not use yet; else PROJECT_EXISTS. */
const freeSlug = async (env: HandlerCtx["env"], key: string, ...candidates: string[]): Promise<string> => {
  for (const slug of candidates) {
    const used = await d1(env)
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(namespaceKey, key), sql`lower(${projects.slug}) = lower(${slug})`))
      .get();

    if (!used) return slug;
  }

  throw new TempoError("PROJECT_EXISTS");
};

/** Projects where the caller can create workspaces: `write` or higher (11). */
export const listProjects = async ({ env, user }: HandlerCtx): Promise<FnOutput<"listProjects">> => {
  const rows = await d1(env)
    .select({ project: projects, orgRole: member.role, projectRole: projectMembers.role })
    .from(projects)
    .leftJoin(member, and(eq(member.organizationId, projects.organizationId), eq(member.userId, user.id)))
    .leftJoin(
      projectMembers,
      and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, user.id)),
    )
    .where(
      or(
        and(isNull(projects.organizationId), eq(projects.userId, user.id)),
        isNotNull(member.id),
        inArray(projectMembers.role, ["write", "admin"]),
      ),
    )
    .orderBy(projects.sortOrder, projects.id)
    .all();

  const out: Project[] = [];

  for (const { project, orgRole, projectRole } of rows) {
    const role = membershipRole(user.id, project, orgRole, projectRole);

    if (atLeast(role, "write")) out.push(await projectView(env, user, project, role));
  }

  return out;
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
  const row = await requireProject(env, user, projectId, "admin");
  const valid = validateOverrides(settings);

  if (!valid.ok) throw new TempoError("SETTINGS_INVALID", undefined, valid.error);
  const now = Date.now();
  await d1(env)
    .update(projects)
    .set({ settingsJson: JSON.stringify(valid.value), updatedAt: now })
    .where(eq(projects.id, projectId))
    .run();

  const refresh = Promise.all(
    (await activeWorkspaceIds(env, projectId)).map((id) =>
      env.WORKSPACE.getByName(id)
        .refreshSettings()
        .catch(() => undefined),
    ),
  );

  waitUntil(refresh);

  return projectView(
    env,
    user,
    { ...row, settingsJson: JSON.stringify(valid.value), updatedAt: now },
    "admin",
  );
};

export const unlinkProject = async (
  { env, user }: HandlerCtx,
  { projectId }: FnInput<"unlinkProject">,
): Promise<FnOutput<"unlinkProject">> => {
  const project = await requireProject(env, user, projectId, "admin");

  if ((await activeWorkspaceIds(env, projectId)).length > 0) throw new TempoError("PROJECT_HAS_WORKSPACES");

  const archived = await d1(env)
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.projectId, projectId))
    .all();

  for (const w of archived) {
    const res = await env.WORKSPACE.getByName(w.id).deleteWorkspace({});
    unwrap(res);
  }

  // 11, Shared project configuration: project secrets live with the project holder.
  await env.CREDENTIALS.getByName(project.userId).deleteProjectEnv(projectId);

  if (project.provider === "artifacts") await env.REPOSITORY_CI.getByName(projectId).destroy();
  await d1(env).delete(projects).where(eq(projects.id, projectId)).run();

  return {};
};

export const listBranches = async (
  { env, user }: PublicCtx,
  { projectId, query }: FnInput<"listBranches">,
): Promise<FnOutput<"listBranches">> => {
  const p = await requireProject(env, user, projectId, "public");

  if (p.provider === "artifacts") {
    if (!p.artifactRepoId) throw new TempoError("REPO_NOT_ACCESSIBLE");

    return listArtifactBranches(env, p.repoName, query, p.artifactRepoId);
  }

  return github.listBranches(await projectToken(env, p), repoOf(p), query);
};

export const listOpenPullRequests = async (
  { env, user }: PublicCtx,
  { projectId }: FnInput<"listOpenPullRequests">,
): Promise<FnOutput<"listOpenPullRequests">> => {
  const p = await requireProject(env, user, projectId, "public");

  if (p.provider === "artifacts") {
    const pulls = await listArtifactPullRequests(env, { ...p, name: p.repoName });

    return pulls.map((pr) => ({ number: pr.number, title: pr.title, headBranch: pr.headBranch }));
  }

  return github.listOpenPullRequests(await projectToken(env, p), repoOf(p));
};
