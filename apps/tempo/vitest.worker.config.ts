import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/** Worker and Durable Object tests, run inside workerd (06, Tooling). */
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: "./test/worker/entry.ts",
      wrangler: { configPath: "./test/wrangler.test.jsonc" },
      miniflare: {
        bindings: {
          TEMPO_ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
          BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-test",
          TEMPO_SETUP_TOKEN: "setup-token-setup-token-setup-tok",
          TEST_MIGRATIONS: await readD1Migrations(
            fileURLToPath(new URL("./src/db/migrations", import.meta.url)),
          ),
        },
      },
    })),
  ],
  resolve: { alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    name: "worker",
    expect: { requireAssertions: true },
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: [
            "effect",
            "effect/Schema",
            "drizzle-orm",
            "drizzle-orm/d1",
            "drizzle-orm/durable-sqlite",
            "drizzle-orm/durable-sqlite/migrator",
            "drizzle-orm/sqlite-core",
          ],
        },
      },
    },
    maxWorkers: 2,
    maxConcurrency: 4,
    silent: "passed-only",
    include: ["test/worker/**/*.test.ts"],
    setupFiles: ["./test/worker/setup.ts"],
  },
});
