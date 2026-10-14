import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { TempoError, type ProjectRole } from "@tempo/protocol";
import * as schema from "../db/d1.ts";
import type { Env } from "../env.ts";
import type { AuthedUser } from "./auth.ts";

/** What a function needs on its project (11, Function access). */
export type ProjectNeed = "public" | "read" | "write" | "admin";

export interface ProjectAccess {
  readonly project: schema.ProjectRow;
  /** The effective role, including a public grant. */
  readonly role: ProjectRole | null;
  /** The highest membership role; never from a public grant. */
  readonly memberRole: ProjectRole | null;
}

const RANK: Record<ProjectRole, number> = { read: 1, write: 2, admin: 3 };

export const atLeast = (role: ProjectRole | null, need: ProjectRole): boolean =>
  role !== null && RANK[role] >= RANK[need];

const highest = (roles: ReadonlyArray<ProjectRole | null>): ProjectRole | null =>
  roles.reduce<ProjectRole | null>((best, r) => (r && (!best || RANK[r] > RANK[best]) ? r : best), null);

const organizationRole = (role: string | null): ProjectRole | null => {
  if (role === null) return null;
  const roles = role.split(",").map((r) => r.trim());

  return roles.includes("owner") || roles.includes("admin") ? "admin" : "read";
};

/** The membership role from its three sources (11, Project roles). */
export const membershipRole = (
  userId: string,
  project: schema.ProjectRow,
  orgRole: string | null,
  projectRole: ProjectRole | null,
): ProjectRole | null =>
  project.organizationId === null && project.userId === userId
    ? "admin"
    : highest([organizationRole(orgRole), projectRole]);

/** The membership role of `userId` on `project` (11, Project roles). */
export const memberRoleOf = async (
  env: Env,
  userId: string | null,
  project: schema.ProjectRow,
): Promise<ProjectRole | null> => {
  if (userId === null) return null;

  if (project.organizationId === null && project.userId === userId) return "admin";
  const db = drizzle(env.DB, { schema });

  const [org, row] = await Promise.all([
    project.organizationId === null
      ? Promise.resolve(undefined)
      : db
          .select({ role: schema.member.role })
          .from(schema.member)
          .where(
            and(eq(schema.member.organizationId, project.organizationId), eq(schema.member.userId, userId)),
          )
          .get(),
    db
      .select({ role: schema.projectMembers.role })
      .from(schema.projectMembers)
      .where(and(eq(schema.projectMembers.projectId, project.id), eq(schema.projectMembers.userId, userId)))
      .get(),
  ]);

  return membershipRole(userId, project, org?.role ?? null, row?.role ?? null);
};

export const accessOf = async (
  env: Env,
  viewer: AuthedUser | null,
  project: schema.ProjectRow,
): Promise<ProjectAccess> => {
  const memberRole = await memberRoleOf(env, viewer?.id ?? null, project);
  const role = highest([memberRole, project.visibility === "public" ? "read" : null]);

  return { project, role, memberRole };
};

/**
 * Loads a project and checks the caller's role. No role at all gives NOT_FOUND, so a private
 * project's existence is not shown; a role that is too low gives FORBIDDEN (11).
 */
export const requireProjectAccess = async (
  env: Env,
  viewer: AuthedUser | null,
  projectId: string,
  need: ProjectNeed,
): Promise<ProjectAccess> => {
  const project = await drizzle(env.DB, { schema })
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .get();

  if (!project) throw new TempoError("NOT_FOUND", undefined, "project not found");
  const access = await accessOf(env, viewer, project);

  if (access.role === null) throw new TempoError("NOT_FOUND", undefined, "project not found");

  if (need === "public") return access;

  if (!viewer) throw new TempoError("UNAUTHENTICATED");

  if (!atLeast(access.memberRole, need)) throw new TempoError("FORBIDDEN");

  return access;
};

/** The caller must be an organization owner or admin (11, Function access). */
export const requireOrganizationAdmin = async (
  env: Env,
  userId: string,
  organizationId: string,
): Promise<void> => {
  const row = await drizzle(env.DB, { schema })
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, organizationId), eq(schema.member.userId, userId)))
    .get();

  if (!row) throw new TempoError("NOT_FOUND", undefined, "organization not found");

  if (organizationRole(row.role) !== "admin") throw new TempoError("FORBIDDEN");
};
