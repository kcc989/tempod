import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { TempoError, type FnInput, type FnOutput, type ProjectSummary } from "@tempo/protocol";
import { projects, user as users, type ProjectRow } from "../../db/d1.ts";
import type { Env } from "../../env.ts";
import type { HandlerCtx, VisitorCtx } from "../run.ts";
import { d1, projectToWire, requireProject, usernameOf } from "./common.ts";

export const MAX_PINNED = 6;

const PAGE = 50;

const requireUsername = async (env: Env, username: string) => {
  const row = await d1(env).select().from(users).where(eq(users.username, username.toLowerCase())).get();

  if (!row?.username) throw new TempoError("NOT_FOUND", undefined, "user not found");

  return { ...row, username: row.username };
};

const toSummary = (row: ProjectRow, username: string): ProjectSummary => ({
  id: row.id,
  username,
  slug: row.slug,
  provider: row.provider,
  owner: row.repoOwner,
  name: row.repoName,
  defaultBranch: row.defaultBranch,
  pinned: row.pinnedAt !== null,
  updatedAt: row.updatedAt,
});

export const getProfile = async (
  { env }: VisitorCtx,
  { username }: FnInput<"getProfile">,
): Promise<FnOutput<"getProfile">> => {
  const row = await requireUsername(env, username);

  return { username: row.username, name: row.name, image: row.image ?? null, bio: row.bio ?? null };
};

export const listProfileProjects = async (
  { env }: VisitorCtx,
  { username, offset = 0 }: FnInput<"listProfileProjects">,
): Promise<FnOutput<"listProfileProjects">> => {
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new TempoError("VALIDATION_FAILED", undefined, "Offset must be a nonnegative integer.");
  const owner = await requireUsername(env, username);

  const rows = await d1(env)
    .select()
    .from(projects)
    .where(and(eq(projects.userId, owner.id), eq(projects.visibility, "public")))
    .orderBy(
      sql`${projects.pinnedAt} IS NULL`,
      asc(projects.pinnedAt),
      desc(projects.updatedAt),
      asc(projects.id),
    )
    .limit(PAGE)
    .offset(offset)
    .all();

  return rows.map((row) => toSummary(row, owner.username));
};

export const getPublicProject = async (
  { env }: VisitorCtx,
  { username, slug }: FnInput<"getPublicProject">,
): Promise<FnOutput<"getPublicProject">> => {
  const owner = await requireUsername(env, username);

  const row = await d1(env)
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.userId, owner.id),
        eq(sql`lower(${projects.slug})`, slug.toLowerCase()),
        eq(projects.visibility, "public"),
      ),
    )
    .get();

  if (!row) throw new TempoError("NOT_FOUND", undefined, "project not found");

  return toSummary(row, owner.username);
};

const ownedProject = async ({ env, user }: HandlerCtx, projectId: string) => {
  const row = await requireProject(env, user.id, projectId);

  return { ...projectToWire(row), username: await usernameOf(env, user.id) };
};

export const setProjectVisibility = async (
  ctx: HandlerCtx,
  { projectId, visibility }: FnInput<"setProjectVisibility">,
): Promise<FnOutput<"setProjectVisibility">> => {
  await requireProject(ctx.env, ctx.user.id, projectId);

  const updatedAt = Date.now();

  await d1(ctx.env)
    .update(projects)
    .set(visibility === "private" ? { visibility, updatedAt, pinnedAt: null } : { visibility, updatedAt })
    .where(eq(projects.id, projectId))
    .run();

  return ownedProject(ctx, projectId);
};

export const setProjectPinned = async (
  ctx: HandlerCtx,
  { projectId, pinned }: FnInput<"setProjectPinned">,
): Promise<FnOutput<"setProjectPinned">> => {
  const row = await requireProject(ctx.env, ctx.user.id, projectId);
  const db = d1(ctx.env);
  const now = Date.now();

  if (!pinned || row.pinnedAt !== null) {
    await db
      .update(projects)
      .set(pinned ? { updatedAt: now } : { pinnedAt: null, updatedAt: now })
      .where(eq(projects.id, projectId))
      .run();

    return ownedProject(ctx, projectId);
  }

  if (row.visibility !== "public")
    throw new TempoError("VALIDATION_FAILED", undefined, "Make the repository public before you pin it.");

  // One statement checks the limit and pins, so two concurrent pins cannot pass 6 (11, Projects).
  const pinnedCount = db
    .select({ n: sql<number>`count(*)` })
    .from(projects)
    .where(and(eq(projects.userId, ctx.user.id), isNotNull(projects.pinnedAt)));

  const res = await db
    .update(projects)
    .set({ pinnedAt: now, updatedAt: now })
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.visibility, "public"),
        isNull(projects.pinnedAt),
        sql`(${pinnedCount}) < ${MAX_PINNED}`,
      ),
    )
    .run();

  if (res.meta.changes === 0) {
    const current = await requireProject(ctx.env, ctx.user.id, projectId);

    if (current.pinnedAt === null)
      throw new TempoError("VALIDATION_FAILED", undefined, `You can pin at most ${MAX_PINNED} repositories.`);
  }

  return ownedProject(ctx, projectId);
};
