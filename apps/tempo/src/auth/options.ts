import { redactPayload } from "@tempo/protocol";
import type { BetterAuthOptions } from "better-auth/minimal";
import { bearer } from "better-auth/plugins/bearer";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { ERROR_MESSAGES } from "@tempo/protocol";
import { errorText, log } from "../log.ts";

/** True when another user row, not the one of this GitHub id, already has the username (11, Identity). */
export type UsernameTaken = (name: string, githubId: string) => Promise<boolean>;

/** Pure Better Auth options, so the `auth` CLI can load them to generate the schema. */
export interface AuthEnv {
  readonly baseURL: string;
  readonly secret: string;
  readonly ownerGithubId: string;
  readonly github: { readonly clientId: string; readonly clientSecret: string } | null;
  readonly usernameTaken: UsernameTaken;
}

/** Every top-level path of the app, so `/:username` never shadows a route (11, Identity). */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  "api",
  "assets",
  "device",
  "downloads",
  "history",
  "login",
  "logout",
  "repositories",
  "settings",
  "setup",
  "w",
  "workspaces",
]);

export const BIO_MAX = 160;

/** The lower-case GitHub login, or `<login>-<githubId>` when that name is reserved or taken (11). */
export const usernameFor = async (taken: UsernameTaken, login: string, githubId: string): Promise<string> => {
  const name = login.toLowerCase();

  if (RESERVED_USERNAMES.has(name) || (await taken(name, githubId))) return `${name}-${githubId}`;

  return name;
};

export const bioFor = (bio: string | null | undefined): string | null => {
  const text = (bio ?? "").trim().slice(0, BIO_MAX);

  return text === "" ? null : text;
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
              username: await usernameFor(env.usernameTaken, profile.login, String(profile.id)),
              bio: bioFor(profile.bio),
            }),
          },
        }
      : {},
    // 11, Identity: the owner cannot set `username` or `bio` by hand.
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
      additionalFields: {
        username: { type: "string", required: false, unique: true, input: false },
        bio: { type: "string", required: false, input: false },
      },
      // Runs before create-user, link-account and every OAuth sign-in (05, owner check).
      validateUserInfo: ({ source }) => {
        if (source.method !== "oauth" || source.oauth?.providerId !== "github") {
          return { error: "forbidden", errorDescription: ERROR_MESSAGES.FORBIDDEN };
        }

        const githubId = source.oauth.profile?.id;

        if (githubId === undefined || String(githubId) !== env.ownerGithubId) {
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
    ],
  }) satisfies BetterAuthOptions;
