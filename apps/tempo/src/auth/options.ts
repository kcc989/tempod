import { redactPayload } from "@tempo/protocol";
import type { BetterAuthOptions } from "better-auth/minimal";
import { bearer } from "better-auth/plugins/bearer";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { organization } from "better-auth/plugins/organization";
import { APIError } from "better-auth/api";
import { ERROR_MESSAGES } from "@tempo/protocol";
import { errorText, log } from "../log.ts";

/** D1 lookups for usernames and organization slugs (11, Identity and Organizations). */
export interface AuthNamespaces {
  /** True when an organization, or a user with another GitHub id, already has this name. */
  readonly taken: (name: string, githubId: string | null) => Promise<boolean>;
  readonly organizationHasProjects: (organizationId: string) => Promise<boolean>;
}

/** Pure Better Auth options, so the `auth` CLI can load them to generate the schema. */
export interface AuthEnv {
  readonly baseURL: string;
  readonly secret: string;
  readonly github: { readonly clientId: string; readonly clientSecret: string } | null;
  readonly namespaces: AuthNamespaces;
}

export const NAMESPACE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;

export const RESERVED_NAMESPACES: ReadonlySet<string> = new Set([
  "api",
  "admin",
  "device",
  "downloads",
  "explore",
  "history",
  "login",
  "logout",
  "new",
  "organizations",
  "repositories",
  "settings",
  "setup",
  "stars",
  "w",
  "workspaces",
]);

export const INVITATION_SECONDS = 60 * 60 * 48;

/** The lower-case GitHub login, or `<login>-<githubId>` when that name is reserved or taken (11). */
export const usernameFor = async (
  namespaces: AuthNamespaces,
  login: string,
  githubId: string,
): Promise<string> => {
  const name = login.toLowerCase();

  if (RESERVED_NAMESPACES.has(name) || (await namespaces.taken(name, githubId))) return `${name}-${githubId}`;

  return name;
};

const namespaceTaken = () =>
  new APIError("BAD_REQUEST", { code: "NAMESPACE_TAKEN", message: "That name is already taken." });

/** Organization slugs share one set of names with usernames (11, Organizations). */
export const assertOrganizationSlug = async (namespaces: AuthNamespaces, slug: string): Promise<void> => {
  if (!NAMESPACE.test(slug) || RESERVED_NAMESPACES.has(slug) || (await namespaces.taken(slug, null)))
    throw namespaceTaken();
};

export const MAC_CLIENT_ID = "tempo-mac";

export const SESSION_SECONDS = 60 * 60 * 24 * 30;

/** 05, Secrets: no secret in D1. Sign-in needs only the GitHub profile, so the OAuth tokens are never stored. */
export const withoutOAuthTokens = <T extends object>(account: T): T => ({
  ...account,
  accessToken: null,
  refreshToken: null,
  idToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
});

/** 05, Observability: Better Auth's own log lines pass through the redact helper too. */
export const authLog = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  ...args: unknown[]
): void =>
  log(
    level,
    `auth: ${message}`,
    args.length ? { args: args.map((a) => redactPayload(a instanceof Error ? errorText(a) : a)) } : {},
  );

export const authOptions = (env: AuthEnv) =>
  ({
    appName: "Tempo",
    baseURL: env.baseURL,
    basePath: "/api/auth",
    secret: env.secret,
    trustedOrigins: [env.baseURL],
    socialProviders: env.github
      ? {
          github: {
            clientId: env.github.clientId,
            clientSecret: env.github.clientSecret,
            overrideUserInfoOnSignIn: true,
            mapProfileToUser: async (profile) => ({
              username: await usernameFor(env.namespaces, profile.login, String(profile.id)),
            }),
          },
        }
      : {},
    // 11, Identity: users cannot set their own username.
    disabledPaths: ["/update-user"],
    session: { expiresIn: SESSION_SECONDS, updateAge: 60 * 60 * 24 },
    account: { accountLinking: { enabled: false } },
    databaseHooks: {
      account: {
        create: { before: async (account) => ({ data: withoutOAuthTokens(account) }) },
        update: { before: async (account) => ({ data: withoutOAuthTokens(account) }) },
      },
    },
    logger: { log: authLog },
    advanced: { defaultCookieAttributes: { sameSite: "lax", httpOnly: true, secure: true } },
    user: {
      additionalFields: { username: { type: "string", required: false, unique: true } },
      // Runs before create-user, link-account and every OAuth sign-in: GitHub only (11, Identity).
      validateUserInfo: ({ source }) => {
        if (source.method !== "oauth" || source.oauth?.providerId !== "github") {
          return { error: "forbidden", errorDescription: ERROR_MESSAGES.FORBIDDEN };
        }

        return undefined;
      },
    },
    plugins: [
      bearer(),
      deviceAuthorization({
        verificationUri: "/device",
        expiresIn: "15m",
        interval: "5s",
        validateClient: (clientId) => clientId === MAC_CLIENT_ID,
      }),
      organization({
        teams: { enabled: false },
        invitationExpiresIn: INVITATION_SECONDS,
        organizationHooks: {
          beforeCreateOrganization: async ({ organization: org }) => {
            await assertOrganizationSlug(env.namespaces, org.slug ?? "");
          },
          beforeUpdateOrganization: async ({ organization: org }) => {
            if (org.slug !== undefined) await assertOrganizationSlug(env.namespaces, org.slug);
          },
          beforeDeleteOrganization: async ({ organization: org }) => {
            if (await env.namespaces.organizationHasProjects(org.id))
              throw new APIError("BAD_REQUEST", {
                code: "ORGANIZATION_HAS_PROJECTS",
                message: "Move or unlink this organization's projects first.",
              });
          },
        },
      }),
    ],
  }) satisfies BetterAuthOptions;
