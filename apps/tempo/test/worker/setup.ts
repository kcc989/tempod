import { applyD1Migrations, env } from "cloudflare:test";

if (!env.TEST_MIGRATIONS) throw new Error("Test D1 migrations are not configured");

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
