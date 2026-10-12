// Builds and deploys the Worker with wrangler (called by alchemy.run.ts). Writes the deploy
// config from the same shape as apps/tempo/wrangler.jsonc (01, Worker config), then runs
// `vite build` and `wrangler deploy` with the secrets in a temporary 0600 file.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const env = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`missing env ${key}`);
  return value;
};

const root = path.resolve(import.meta.dirname, "..");
const app = path.join(root, "apps/tempo");
const versions = JSON.parse(fs.readFileSync(path.join(root, "container/versions.json"), "utf8")) as {
  base_image: string;
  base_image_digest: string | null;
  build_args: Record<string, string>;
};
const version =
  (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: string }).version ??
  "0.1.0";

const run = (cmd: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}) => {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...extraEnv } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}`);
};

// One build id for the Worker and tempod, so the DO can warn when they differ (05, Upgrades).
const git = (args: string[]): string =>
  spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout?.trim() ?? "";
const sha = git(["rev-parse", "--short=12", "HEAD"]);
const buildId = sha ? `${version}+${sha}${git(["status", "--porcelain"]) ? ".dirty" : ""}` : version;

// 1. tempod binary and the image check.
run("bun", ["run", "build:tempod"], root, { TEMPO_BUILD_ID: buildId });
run("bun", ["container/check-versions.ts"], root);
if (!versions.base_image_digest && spawnSync("docker", ["buildx", "version"]).status === 0) {
  run("bun", ["container/pin-base.ts"], root);
}
const pinned = JSON.parse(
  fs.readFileSync(path.join(root, "container/versions.json"), "utf8"),
) as typeof versions;
const baseImage = pinned.base_image_digest
  ? `${pinned.base_image}@${pinned.base_image_digest}`
  : pinned.base_image;

// 2. The deploy config. No `migrations` array: it conflicts with `exports` (01).
const DO = { type: "durable-object", storage: "sqlite" } as const;
const config = {
  name: "tempo",
  main: "./src/worker.ts",
  compatibility_date: "2026-10-10",
  compatibility_flags: ["nodejs_compat"],
  // Invocation logs record request URLs, which hold preview tokens and the setup token (05, Observability).
  observability: { enabled: true, logs: { enabled: true, invocation_logs: false } },
  vars: {
    APP_HOST: env("APP_HOST"),
    PREVIEW_DOMAIN: env("PREVIEW_DOMAIN"),
    TEMPO_OWNER_GITHUB_ID: env("TEMPO_OWNER_GITHUB_ID"),
    TEMPO_VERSION: buildId,
  },
  containers: [
    {
      class_name: "WorkspaceDO",
      scheduling_policy: "durable_object",
      images: {
        workspace: {
          dockerfile: "../../container/Dockerfile",
          build_context: "../..",
          build_vars: { ...pinned.build_args, BASE_IMAGE: baseImage },
        },
      },
    },
  ],
  durable_objects: {
    bindings: [
      { name: "WORKSPACE", class_name: "WorkspaceDO" },
      { name: "USER_HUB", class_name: "UserHubDO" },
      { name: "CREDENTIALS", class_name: "CredentialDO" },
    ],
  },
  exports: { WorkspaceDO: DO, UserHubDO: DO, CredentialDO: DO },
  d1_databases: [
    { binding: "DB", database_name: env("TEMPO_D1_DATABASE_NAME"), database_id: env("TEMPO_D1_DATABASE_ID") },
  ],
  r2_buckets: [{ binding: "DATA", bucket_name: env("TEMPO_R2_BUCKET_NAME") }],
  routes: [
    { pattern: env("APP_HOST"), custom_domain: true },
    { pattern: `*.${env("PREVIEW_DOMAIN")}/*`, zone_name: env("PREVIEW_DOMAIN") },
  ],
};
const configPath = path.join(app, "wrangler.deploy.jsonc");
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
if (process.argv.includes("--prepare")) {
  console.log("Prepared apps/tempo/wrangler.deploy.jsonc; no cloud resources were changed.");
  process.exit(0);
}

// 3. Build and deploy. The Vite plugin writes .wrangler/deploy/config.json under apps/tempo.
const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "tempo-"));
const secretsFile = path.join(secretsDir, "secrets.json");
fs.writeFileSync(
  secretsFile,
  JSON.stringify({
    TEMPO_ENCRYPTION_KEY: env("TEMPO_ENCRYPTION_KEY"),
    BETTER_AUTH_SECRET: env("BETTER_AUTH_SECRET"),
    TEMPO_SETUP_TOKEN: env("TEMPO_SETUP_TOKEN"),
  }),
  { mode: 0o600 },
);
try {
  run("bunx", ["vite", "build"], app, { TEMPO_WRANGLER_CONFIG: "./wrangler.deploy.jsonc" });
  run("bunx", ["wrangler", "deploy", "--secrets-file", secretsFile], app);
} finally {
  fs.rmSync(secretsDir, { recursive: true, force: true });
}
console.log(
  `Open https://${env("APP_HOST")}/setup/github?token=${env("TEMPO_SETUP_TOKEN")} to create the GitHub App.`,
);
