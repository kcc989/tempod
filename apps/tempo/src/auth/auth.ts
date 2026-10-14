import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { TempoError } from "@tempo/protocol";
import * as schema from "../db/d1.ts";
import type { Env } from "../env.ts";
import { getGithubAppConfig } from "../github/app.ts";
import { authOptions, type AuthNamespaces } from "./options.ts";

/** One shared set of names for users and organizations (11, Namespaces). */
export const d1Namespaces = (env: Env): AuthNamespaces => {
  const db = drizzle(env.DB, { schema });

  return {
    taken: async (name, githubId) => {
      const org = await db
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.slug, name))
        .get();

      if (org) return true;

      const other = await db
        .select({ id: schema.user.id })
        .from(schema.user)
        .leftJoin(
          schema.account,
          and(eq(schema.account.userId, schema.user.id), eq(schema.account.providerId, "github")),
        )
        .where(
          and(
            eq(schema.user.username, name),
            githubId === null
              ? undefined
              : or(ne(schema.account.accountId, githubId), isNull(schema.account.accountId)),
          ),
        )
        .get();

      return other !== undefined;
    },
    organizationHasProjects: async (organizationId) =>
      (await db
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(eq(schema.projects.organizationId, organizationId))
        .get()) !== undefined,
  };
};

const createAuth = (env: Env, github: { clientId: string; clientSecret: string } | null) => {
  const db = drizzle(env.DB, { schema });

  return betterAuth({
    ...authOptions({
      baseURL: `https://${env.APP_HOST}`,
      secret: env.BETTER_AUTH_SECRET,
      github,
      namespaces: d1Namespaces(env),
    }),
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
  });
};

export type Auth = ReturnType<typeof createAuth>;

let cached: { key: string; auth: Auth } | null = null;

/** One Better Auth instance per isolate, rebuilt when the GitHub App's OAuth client changes. */
export const getAuth = async (env: Env): Promise<Auth> => {
  const app = await getGithubAppConfig(env);
  const github = app ? { clientId: app.clientId, clientSecret: app.clientSecret } : null;
  const key = github?.clientId ?? "";

  if (!cached || cached.key !== key) cached = { key, auth: createAuth(env, github) };

  return cached.auth;
};

export interface AuthedUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly image: string | null;
}

const adminCache = new Map<string, boolean>();

/** The instance admin's GitHub account id equals TEMPO_OWNER_GITHUB_ID (11, Identity). */
export const isInstanceAdmin = async (env: Env, userId: string): Promise<boolean> => {
  const hit = adminCache.get(userId);

  if (hit !== undefined) return hit;
  const db = drizzle(env.DB, { schema });

  const row = await db
    .select({ accountId: schema.account.accountId })
    .from(schema.account)
    .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, "github")))
    .get();

  const admin = row?.accountId === env.TEMPO_OWNER_GITHUB_ID;
  adminCache.set(userId, admin);

  return admin;
};

/** Session from the cookie or (with `allowBearer`) an `Authorization: Bearer` token. */
export const getSessionUser = async (
  env: Env,
  headers: Headers,
  { allowCookie = true, allowBearer = true }: { allowCookie?: boolean; allowBearer?: boolean } = {},
): Promise<AuthedUser | null> => {
  const hasBearer = headers.get("authorization")?.toLowerCase().startsWith("bearer ") ?? false;

  if (hasBearer && !allowBearer) return null;

  if (!hasBearer && !allowCookie) return null;
  const forwarded = new Headers(headers);

  if (!allowCookie) forwarded.delete("cookie");
  const auth = await getAuth(env);
  const session = await auth.api.getSession({ headers: forwarded });

  if (!session) return null;
  const u = session.user;

  return { id: u.id, name: u.name, email: u.email, image: u.image ?? null };
};

export const requireUser = async (
  env: Env,
  headers: Headers,
  opts?: { allowCookie?: boolean; allowBearer?: boolean },
): Promise<AuthedUser> => {
  const user = await getSessionUser(env, headers, opts);

  if (!user) throw new TempoError("UNAUTHENTICATED");

  return user;
};

export const requireInstanceAdmin = async (env: Env, userId: string): Promise<void> => {
  if (!(await isInstanceAdmin(env, userId))) throw new TempoError("FORBIDDEN");
};
