import { Schema } from "effect";
import { readContainerVersions } from "../container/versions.ts";
// Builds and deploys the Worker with cf (called by alchemy.run.ts). apps/tempo/cloudflare.config.ts
// holds the config (01, Worker config); this script passes the deploy values in the environment
// and runs `cf deploy` with the secrets in a temporary 0600 file.
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

process.env.XDG_CONFIG_HOME = path.join(root, ".alchemy", "xdg");

fs.mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true, mode: 0o700 });

const versions = readContainerVersions(fs.readFileSync(path.join(root, "container/versions.json"), "utf8"));

const version =
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ version: Schema.optional(Schema.String) })))(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  ).version ?? "0.1.0";

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

const pinned = readContainerVersions(fs.readFileSync(path.join(root, "container/versions.json"), "utf8"));

const baseImage = pinned.base_image_digest
  ? `${pinned.base_image}@${pinned.base_image_digest}`
  : pinned.base_image;

// 2. The workspace image. Without TEMPO_BUILD_CA, cf builds it from container/Dockerfile.
let workspaceImage: string | undefined;

if (process.env.TEMPO_BUILD_CA && !process.argv.includes("--prepare")) {
  // Wrangler beta's Docker builder cannot pass BuildKit secrets. Build with CA trust here.
  const tag = "tempo-workspace:production";
  run(
    "docker",
    [
      "build",
      "--platform",
      "linux/amd64",
      "-f",
      "container/Dockerfile",
      "--secret",
      `id=proxy_ca,src=${process.env.TEMPO_BUILD_CA}`,
      "-t",
      tag,
      ...Object.entries({ ...pinned.build_args, BASE_IMAGE: baseImage }).flatMap(([key, value]) => [
        "--build-arg",
        `${key}=${value}`,
      ]),
      ".",
    ],
    root,
  );

  const inspected = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", tag], {
    encoding: "utf8",
  });

  const digest = inspected.stdout?.trim();

  if (inspected.status !== 0 || !/^sha256:[a-f0-9]{64}$/.test(digest ?? ""))
    throw new Error("Cannot identify the built production image.");
  const immutableTag = `tempo-workspace:${digest.slice(7)}`;
  run("docker", ["tag", tag, immutableTag], root);
  run("bunx", ["wrangler", "containers", "push", immutableTag], app);

  const remote = spawnSync("docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", tag], {
    encoding: "utf8",
  });

  const prefix = `registry.cloudflare.com/${env("CLOUDFLARE_ACCOUNT_ID")}/tempo-workspace@sha256:`;
  const references: string[] = remote.status === 0 ? JSON.parse(remote.stdout) : [];

  const reference = references.find(
    (value) => value.startsWith(prefix) && /^[a-f0-9]{64}$/.test(value.slice(prefix.length)),
  );

  if (!reference) throw new Error("Cannot identify the pushed managed-registry image digest.");
  workspaceImage = reference;
}

// Values that apps/tempo/cloudflare.config.ts reads when TEMPO_DEPLOY=1.
// An empty TEMPO_WORKSPACE_IMAGE makes cf build the image itself.
const deployEnv = { TEMPO_DEPLOY: "1", TEMPO_VERSION: buildId, TEMPO_WORKSPACE_IMAGE: workspaceImage ?? "" };

if (process.argv.includes("--prepare")) {
  run("bunx", ["vite", "build"], app, deployEnv);
  console.log("Built apps/tempo with the deploy config; no cloud resources were changed.");
  process.exit(0);
}

// 3. Build and deploy. cf runs the Vite build, then deploys .cloudflare/output under apps/tempo.
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
  run("bunx", ["cf", "deploy", "--secrets-file", secretsFile], app, deployEnv);
} finally {
  fs.rmSync(secretsDir, { recursive: true, force: true });
}

const setupLink = path.join(root, ".alchemy", "tempo-setup-link.txt");

fs.mkdirSync(path.dirname(setupLink), { recursive: true, mode: 0o700 });

fs.writeFileSync(setupLink, `https://${env("APP_HOST")}/setup/github?token=${env("TEMPO_SETUP_TOKEN")}\n`, {
  mode: 0o600,
});

fs.chmodSync(setupLink, 0o600);

console.log("Private setup link saved to .alchemy/tempo-setup-link.txt; open it locally. Do not publish it.");
