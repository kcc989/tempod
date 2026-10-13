import type { BetterAuthOptions } from "better-auth/minimal";
import { bearer } from "better-auth/plugins/bearer";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { ERROR_MESSAGES } from "@tempo/protocol";
import { errorText, log } from "../log.ts";

/** Pure Better Auth options, so the `auth` CLI can load them to generate the schema. */
export interface AuthEnv {
  readonly baseURL: string;
  readonly secret: string;
  readonly ownerGithubId: string;
  readonly github: { readonly clientId: string; readonly clientSecret: string } | null;
}

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
    args.length ? { args: args.map((a) => (a instanceof Error ? errorText(a) : a)) } : {},
  );

export const authOptions = (env: AuthEnv) =>
  ({
    appName: "Tempo",
    baseURL: env.baseURL,
    basePath: "/api/auth",
    secret: env.secret,
    trustedOrigins: [env.baseURL],
    socialProviders: env.github
      ? { github: { clientId: env.github.clientId, clientSecret: env.github.clientSecret } }
      : {},
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
