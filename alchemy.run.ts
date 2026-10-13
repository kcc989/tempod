// Tempo deploy (05, Deployment and configuration). Run with `bun run deploy`.
//
// Alchemy v2 owns the D1 database and its migrations, the R2 bucket and the three generated
// secrets. It cannot emit a Worker with `exports` or a `durable_object` container with named
// `images`, so scripts/deploy-worker.ts deploys the Worker with wrangler (risk R2 in 00).
//
// Needs: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, APP_HOST, PREVIEW_DOMAIN, TEMPO_OWNER_GITHUB_ID.
import fs from "node:fs";
import path from "node:path";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import * as Output from "alchemy/Output";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const required = (name: string): string => {
  const value = process.env[name];

  if (!value) throw new Error(`${name} must be set`);

  return value;
};

const APP_HOST = required("APP_HOST");

const PREVIEW_DOMAIN = required("PREVIEW_DOMAIN");

const TEMPO_OWNER_GITHUB_ID = required("TEMPO_OWNER_GITHUB_ID");

if (PREVIEW_DOMAIN === APP_HOST || APP_HOST.endsWith(`.${PREVIEW_DOMAIN}`)) {
  throw new Error("PREVIEW_DOMAIN must not be APP_HOST or a parent of it (05, Preview access)");
}

// Alchemy reads plain .sql files; drizzle-kit 0.31 also writes meta/, which Alchemy rejects.
const MIGRATIONS = "apps/tempo/src/db/migrations";

const migrationsDir = (() => {
  const flat = ".alchemy/d1-migrations";
  fs.rmSync(flat, { recursive: true, force: true });
  fs.mkdirSync(flat, { recursive: true });

  for (const file of fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    fs.copyFileSync(path.join(MIGRATIONS, file), path.join(flat, file));
  }

  return flat;
})();

const hexToBase64 = (r: Redacted.Redacted<string>) =>
  Redacted.make(Buffer.from(Redacted.value(r), "hex").toString("base64"));

export default Alchemy.Stack(
  "tempo",
  {
    providers: Cloudflare.providers(),
    // Remote state keeps the generated secrets stable across machines and CI runs.
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const db = yield* Cloudflare.D1.Database("DB", { name: "tempo", migrations: migrationsDir }).pipe(
      RemovalPolicy.retain(),
    );

    const data = yield* Cloudflare.R2.Bucket("DATA", { name: "tempo-data" }).pipe(RemovalPolicy.retain());
    // Minted on the first deploy, then reused from state.
    const encryptionKey = yield* Alchemy.Random("TempoEncryptionKey", { bytes: 32 });
    const authSecret = yield* Alchemy.Random("BetterAuthSecret", { bytes: 32 });
    const setupToken = yield* Alchemy.Random("TempoSetupToken", { bytes: 16 });
    yield* Command.Exec("WranglerDeploy", {
      command: "bun scripts/deploy-worker.ts",
      memo: false,
      timeout: "45 minutes",
      env: {
        APP_HOST,
        PREVIEW_DOMAIN,
        TEMPO_OWNER_GITHUB_ID,
        TEMPO_D1_DATABASE_ID: db.databaseId,
        TEMPO_D1_DATABASE_NAME: db.databaseName,
        TEMPO_R2_BUCKET_NAME: data.bucketName,
        TEMPO_ENCRYPTION_KEY: encryptionKey.text.pipe(Output.map(hexToBase64)),
        BETTER_AUTH_SECRET: authSecret.text,
        TEMPO_SETUP_TOKEN: setupToken.text,
      },
    });

    return {
      d1DatabaseId: db.databaseId,
      appUrl: `https://${APP_HOST}`,
    };
  }),
);
