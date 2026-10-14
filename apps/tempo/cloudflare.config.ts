import { readFileSync } from "node:fs";
import { bindings, defineConfig, defineContainer, exports, triggers } from "cf/config";
import { readContainerVersions } from "../../container/versions.ts";

// One config for local development and deploys (01, Worker config). scripts/deploy-worker.ts
// sets TEMPO_DEPLOY=1 and the deploy values in the environment of `cf deploy`.
const deploying = process.env["TEMPO_DEPLOY"] === "1";

const env = (key: string, local: string): string => {
  if (!deploying) return local;
  const value = process.env[key];

  if (!value) throw new Error(`missing env ${key}`);

  return value;
};

const versions = readContainerVersions(
  readFileSync(new URL("../../container/versions.json", import.meta.url), "utf8"),
);

const baseImage = versions.base_image_digest
  ? `${versions.base_image}@${versions.base_image_digest}`
  : versions.base_image;

const appHost = env("APP_HOST", "localhost:5173");

const previewDomain = env("PREVIEW_DOMAIN", "previews.localhost");

const reference = deploying ? process.env["TEMPO_WORKSPACE_IMAGE"] : undefined;

// The name wrangler derived from `tempo` and `WorkspaceDO`; keep it so deploys update the same application.
const workspace = defineContainer({
  name: "tempo-workspacedo",
  schedulingPolicy: "durable-object",
  images: {
    workspace: reference
      ? { reference }
      : {
          dockerfile: "../../container/Dockerfile",
          buildContext: "../..",
          buildVars: { ...versions.build_args, BASE_IMAGE: baseImage },
        },
  },
});

export default defineConfig({
  containers: [workspace],
  worker: {
    name: "tempo",
    entrypoint: "./src/worker.ts",
    compatibilityDate: "2026-10-10",
    compatibilityFlags: ["nodejs_compat"],
    // Request URLs can contain setup and preview tokens.
    observability: {
      enabled: true,
      redactQueryString: true,
      logs: { enabled: true, invocationLogs: false },
    },
    env: {
      APP_HOST: bindings.text(appHost),
      PREVIEW_DOMAIN: bindings.text(previewDomain),
      TEMPO_OWNER_GITHUB_ID: bindings.text(env("TEMPO_OWNER_GITHUB_ID", "0")),
      TEMPO_VERSION: deploying && bindings.text(env("TEMPO_VERSION", "")),
      USER_HUB: bindings.durableObject({ worker: "tempo", exportName: "UserHubDO" }),
      REPOSITORY_CI: bindings.durableObject({ worker: "tempo", exportName: "RepositoryCiDO" }),
      CREDENTIALS: bindings.durableObject({ worker: "tempo", exportName: "CredentialDO" }),
      DB: bindings.d1({
        name: env("TEMPO_D1_DATABASE_NAME", "tempo"),
        id: env("TEMPO_D1_DATABASE_ID", "local"),
      }),
      DATA: bindings.r2({ name: env("TEMPO_R2_BUCKET_NAME", "tempo-data") }),
      BROWSER: bindings.browser(),
      AI: bindings.ai(),
      LOADER: bindings.workerLoader(),
      ARTIFACTS: bindings.artifacts({
        namespace: (deploying && process.env["TEMPO_ARTIFACTS_NAMESPACE"]) || "tempo-repos",
        dev: { remote: true },
      }),
    },
    // WorkspaceDO has no env binding: wrangler rejects a container on a DO bound with script_name.
    // Code reaches it through ctx.exports (src/env.ts).
    exports: {
      WorkspaceDO: exports.durableObject({ storage: "sqlite", container: workspace }),
      UserHubDO: exports.durableObject({ storage: "sqlite" }),
      CredentialDO: exports.durableObject({ storage: "sqlite" }),
      RepositoryCiDO: exports.durableObject({ storage: "sqlite" }),
    },
    domains: deploying ? [appHost] : [],
    triggers: deploying ? [triggers.fetch({ pattern: `*.${previewDomain}/*`, zone: previewDomain })] : [],
  },
});
