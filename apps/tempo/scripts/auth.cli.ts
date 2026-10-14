// Used only by `bun run auth:generate` to write src/db/auth-schema.ts (Better Auth CLI).
import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { authOptions } from "../src/auth/options.ts";

export const auth = betterAuth({
  ...authOptions({
    baseURL: "http://localhost:5173",
    secret: "cli-only-cli-only-cli-only-cli-only",
    ownerGithubId: "0",
    github: { clientId: "x", clientSecret: "x" },
    usernameTaken: async () => false,
  }),
  database: drizzleAdapter({}, { provider: "sqlite" }),
});
