import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import {
  TempoError,
  type FnInput,
  type FnOutput,
  type ProjectMember,
  type ProjectRole,
  type ProjectSummary,
} from "@tempo/protocol";
import { accessOf, requireProjectAccess } from "../../auth/access.ts";
import type { AuthedUser } from "../../auth/auth.ts";
import { organization, projectMembers, projectStars, projects, user, type ProjectRow } from "../../db/d1.ts";
import type { Env } from "../../env.ts";
import type { HandlerCtx, PublicCtx } from "../run.ts";
import { d1, namespaceOf, projectView } from "./common.ts";

const PAGE = 50;

const starCounts = async (env: Env, ids: string[]): Promise<Map<string, number>> => {
  if (ids.length === 0) return new Map();

  const rows = await d1(env)
    .select({ projectId: projectStars.projectId, n: count() })
    .from(projectStars)
    .where(inArray(projectStars.projectId, ids))
    .groupBy(projectStars.projectId)
    .all();

  return new Map(rows.map((r) => [r.projectId, r.n]));
};

const starredBy = async (env: Env, viewer: AuthedUser | null, ids: string[]): Promise<Set<string>> => {
  if (!viewer || ids.length === 0) return new Set();

  const rows = await d1(env)
    .select({ projectId: projectStars.projectId })
    .from(projectStars)
    .where(and(eq(projectStars.userId, viewer.id), inArray(projectStars.projectId, ids)))
    .all();

  return new Set(rows.map((r) => r.projectId));
};

/** Summaries of the rows the viewer can read, in the same order (11, Server functions). */
const summaries = async (
  env: Env,
  viewer: AuthedUser | null,
  rows: ReadonlyArray<ProjectRow>,
): Promise<ProjectSummary[]> => {
  const visible: Array<{ row: ProjectRow; role: ProjectRole }> = [];

  for (const row of rows) {
    const { role } = await accessOf(env, viewer, row);

    if (role !== null) visible.push({ row, role });
  }

  const ids = visible.map((v) => v.row.id);
  const [stars, starred] = await Promise.all([starCounts(env, ids), starredBy(env, viewer, ids)]);

  return Promise.all(
    visible.map(async ({ row, role }) => ({
      id: row.id,
      namespace: await namespaceOf(env, row),
      slug: row.slug,
      organizationId: row.organizationId,
      visibility: row.visibility,
      provider: row.provider,
      defaultBranch: row.defaultBranch,
      stars: stars.get(row.id) ?? 0,
      starred: starred.has(row.id),
      role,
      updatedAt: row.updatedAt,
    })),
  );
};

/** The owner key of a namespace: an organization id or a user id (11, Namespaces). */
const namespaceKeyOf = async (env: Env, namespace: string): Promise<string> => {
  const name = namespace.toLowerCase();

  const org = await d1(env)
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.slug, name))
    .get();

  if (org) return org.id;

  const owner = await d1(env).select({ id: user.id }).from(user).where(eq(user.username, name)).get();

  if (!owner) throw new TempoError("NOT_FOUND", undefined, "namespace not found");

  return owner.id;
};

const inNamespace = (key: string) =>
  sql`(${projects.organizationId} = ${key} OR (${projects.organizationId} IS NULL AND ${projects.userId} = ${key}))`;

export const getProject = async (
  { env, user: viewer }: PublicCtx,
  { namespace, slug }: FnInput<"getProject">,
): Promise<FnOutput<"getProject">> => {
  const key = await namespaceKeyOf(env, namespace);

  const row = await d1(env)
    .select()
    .from(projects)
    .where(and(inNamespace(key), sql`lower(${projects.slug}) = lower(${slug})`))
    .get();

  const [summary] = row ? await summaries(env, viewer, [row]) : [];

  if (!summary) throw new TempoError("NOT_FOUND", undefined, "project not found");

  return summary;
};

export const listNamespaceProjects = async (
  { env, user: viewer }: PublicCtx,
  { namespace, offset }: FnInput<"listNamespaceProjects">,
): Promise<FnOutput<"listNamespaceProjects">> => {
  const key = await namespaceKeyOf(env, namespace);

  const rows = await d1(env)
    .select()
    .from(projects)
    .where(inNamespace(key))
    .orderBy(sql`lower(${projects.slug})`, asc(projects.id))
    .all();

  return (await summaries(env, viewer, rows)).slice(offset ?? 0, (offset ?? 0) + PAGE);
};

export const exploreProjects = async (
  { env, user: viewer }: PublicCtx,
  { offset }: FnInput<"exploreProjects">,
): Promise<FnOutput<"exploreProjects">> => {
  const stars = d1(env)
    .select({ projectId: projectStars.projectId, n: count().as("n") })
    .from(projectStars)
    .groupBy(projectStars.projectId)
    .as("stars");

  const rows = await d1(env)
    .select({ project: projects })
    .from(projects)
    .leftJoin(stars, eq(stars.projectId, projects.id))
    .where(eq(projects.visibility, "public"))
    .orderBy(desc(sql`coalesce(${stars.n}, 0)`), desc(projects.updatedAt), asc(projects.id))
    .limit(PAGE)
    .offset(offset ?? 0)
    .all();

  return summaries(
    env,
    viewer,
    rows.map((r) => r.project),
  );
};

export const listStarredProjects = async (
  { env, user: viewer }: HandlerCtx,
  { offset }: FnInput<"listStarredProjects">,
): Promise<FnOutput<"listStarredProjects">> => {
  const rows = await d1(env)
    .select({ project: projects })
    .from(projectStars)
    .innerJoin(projects, eq(projects.id, projectStars.projectId))
    .where(eq(projectStars.userId, viewer.id))
    .orderBy(desc(projectStars.createdAt), asc(projects.id))
    .all();

  return (
    await summaries(
      env,
      viewer,
      rows.map((r) => r.project),
    )
  ).slice(offset ?? 0, (offset ?? 0) + PAGE);
};

const starState = async (env: Env, userId: string, projectId: string): Promise<FnOutput<"starProject">> => {
  const [stars, mine] = await Promise.all([
    d1(env).select({ n: count() }).from(projectStars).where(eq(projectStars.projectId, projectId)).get(),
    d1(env)
      .select({ projectId: projectStars.projectId })
      .from(projectStars)
      .where(and(eq(projectStars.projectId, projectId), eq(projectStars.userId, userId)))
      .get(),
  ]);

  return { stars: stars?.n ?? 0, starred: mine !== undefined };
};

export const starProject = async (
  { env, user: viewer }: HandlerCtx,
  { projectId }: FnInput<"starProject">,
): Promise<FnOutput<"starProject">> => {
  await requireProjectAccess(env, viewer, projectId, "public");
  await d1(env)
    .insert(projectStars)
    .values({ userId: viewer.id, projectId, createdAt: Date.now() })
    .onConflictDoNothing()
    .run();

  return starState(env, viewer.id, projectId);
};

export const unstarProject = async (
  { env, user: viewer }: HandlerCtx,
  { projectId }: FnInput<"unstarProject">,
): Promise<FnOutput<"unstarProject">> => {
  await requireProjectAccess(env, viewer, projectId, "public");
  await d1(env)
    .delete(projectStars)
    .where(and(eq(projectStars.userId, viewer.id), eq(projectStars.projectId, projectId)))
    .run();

  return starState(env, viewer.id, projectId);
};

export const setProjectVisibility = async (
  { env, user: viewer }: HandlerCtx,
  { projectId, visibility }: FnInput<"setProjectVisibility">,
): Promise<FnOutput<"setProjectVisibility">> => {
  const { project } = await requireProjectAccess(env, viewer, projectId, "admin");
  const now = Date.now();
  await d1(env).update(projects).set({ visibility, updatedAt: now }).where(eq(projects.id, projectId)).run();

  return projectView(env, viewer, { ...project, visibility, updatedAt: now }, "admin");
};

const memberColumns = {
  userId: projectMembers.userId,
  username: user.username,
  name: user.name,
  image: user.image,
  role: projectMembers.role,
};

export const listProjectMembers = async (
  { env, user: viewer }: HandlerCtx,
  { projectId }: FnInput<"listProjectMembers">,
): Promise<FnOutput<"listProjectMembers">> => {
  await requireProjectAccess(env, viewer, projectId, "read");

  return d1(env)
    .select(memberColumns)
    .from(projectMembers)
    .innerJoin(user, eq(user.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId))
    .orderBy(sql`coalesce(${user.username}, ${user.id})`)
    .all();
};

export const putProjectMember = async (
  { env, user: viewer }: HandlerCtx,
  { projectId, username, role }: FnInput<"putProjectMember">,
): Promise<FnOutput<"putProjectMember">> => {
  const { project } = await requireProjectAccess(env, viewer, projectId, "admin");

  const target = await d1(env)
    .select({ id: user.id })
    .from(user)
    .where(eq(user.username, username.toLowerCase()))
    .get();

  if (!target) throw new TempoError("NOT_FOUND", undefined, "user not found");

  if (project.organizationId === null && project.userId === target.id)
    throw new TempoError("VALIDATION_FAILED", undefined, "The owner of a personal project is not a member.");
  const now = Date.now();

  await d1(env)
    .insert(projectMembers)
    .values({ projectId, userId: target.id, role, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [projectMembers.projectId, projectMembers.userId],
      set: { role, updatedAt: now },
    })
    .run();

  const saved: ProjectMember | undefined = await d1(env)
    .select(memberColumns)
    .from(projectMembers)
    .innerJoin(user, eq(user.id, projectMembers.userId))
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, target.id)))
    .get();

  if (!saved) throw new TempoError("INTERNAL");

  return saved;
};

export const deleteProjectMember = async (
  { env, user: viewer }: HandlerCtx,
  { projectId, userId }: FnInput<"deleteProjectMember">,
): Promise<FnOutput<"deleteProjectMember">> => {
  // 11, policy `self`: a member can always leave; only an admin removes someone else.
  await requireProjectAccess(env, viewer, projectId, userId === viewer.id ? "public" : "admin");
  await d1(env)
    .delete(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .run();

  return {};
};
