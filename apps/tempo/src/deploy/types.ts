import { PLACEHOLDER, type DeployPermission } from "@tempo/protocol";
import type { DeploySpec } from "@tempo/settings";
import type { JobOutcome, RunnerJob } from "../do/workspace/job-runner.ts";

/** What AppDeployDO sends a runner to start one deployment (12, Execution). */
export interface DeployJobStart extends RunnerJob {
  readonly deploymentId: string;
  readonly artifactRepoId: string;
  readonly accountId: string;
}

/** A runner's result; accepted only with the token it was started with. */
export interface DeployJobResult extends JobOutcome {
  readonly deploymentId: string;
  readonly token: string;
}

/** The coordinator methods a runner calls (12, Execution). */
export interface DeployCoordinator {
  deploymentFinished(result: DeployJobResult): Promise<void>;
}

export const deployRunnerName = (deploymentId: string): string => `deploy:${deploymentId}`;

export const deployLogKey = (projectId: string, deploymentId: string): string =>
  `deploy/${projectId}/${deploymentId}.log`;

/** The CredentialDO key of a deployment's minted token (12, Tokens). */
export const deployTokenKey = (deploymentId: string): string => `deploy.${deploymentId}.token`;

/** 13, L-ADR-8: the workspace's minted Cloudflare API token. */
export const agentCloudflareTokenKey = (workspaceId: string): string =>
  `agent.${workspaceId}.cloudflare_token`;

/** The owner's CredentialDO keys of 12, Owner settings. */
export const DEPLOY_MASTER_KEY = "cloudflare.deploy_token";

export const DEPLOY_ACCOUNT_KEY = "cloudflare.account_id";

export const ACCOUNT_ID = /^[0-9a-f]{32}$/;

/** 12, Permissions. */
export const PERMISSION_GROUPS: Readonly<
  Record<DeployPermission, { readonly scope: "account" | "zone"; readonly groups: ReadonlyArray<string> }>
> = {
  workers: { scope: "account", groups: ["Workers Scripts Write", "Account Settings Read"] },
  kv: { scope: "account", groups: ["Workers KV Storage Write"] },
  d1: { scope: "account", groups: ["D1 Write"] },
  r2: { scope: "account", groups: ["Workers R2 Storage Write"] },
  queues: { scope: "account", groups: ["Queues Write"] },
  vectorize: { scope: "account", groups: ["Vectorize Write"] },
  hyperdrive: { scope: "account", groups: ["Hyperdrive Write"] },
  secrets_store: { scope: "account", groups: ["Secrets Store Write"] },
  routes: { scope: "zone", groups: ["Workers Routes Write", "DNS Write", "Zone Read"] },
};

/** The frozen values a deployment runs with (12, Deploy configuration). */
export type DeployPlan = Pick<DeploySpec, "tool" | "root" | "install" | "build" | "permissions"> & {
  readonly stage: string;
  readonly target: string;
  /** 12, Gradual rollout. Absent in plans stored before it. */
  readonly rollout?: "full" | "gradual";
  readonly workers?: ReadonlyArray<string>;
  readonly smoke?: ReadonlyArray<string>;
};

const TOOLS = {
  alchemy: {
    file: "alchemy.run.ts",
    deploy: (stage: string) => `npx --no -- alchemy deploy --stage ${stage} --yes`,
  },
  "cloudflare-config": {
    file: "cloudflare.config.ts",
    deploy: (stage: string) => `npx --no -- cf deploy --mode ${stage}`,
  },
} as const;

/**
 * The deploy command (12, Tools and Execution). `root`, `stage` and `target` are validated by the
 * parser, so they need no quoting; `install` and `build` are the owner's own commands.
 */
export const deployCommand = (plan: DeployPlan, accountId: string): string => {
  const tool = TOOLS[plan.tool];
  const where = plan.root === "" ? "the repository root" : plan.root;

  const install =
    plan.install ??
    [
      "if [ -f bun.lock ] || [ -f bun.lockb ]; then bun install --frozen-lockfile",
      "elif [ -f package-lock.json ]; then npm ci",
      "else echo 'No lockfile found. Set install in the deploy configuration.' >&2; exit 2; fi",
    ].join("; ");

  return [
    "set -e",
    "export CI=1 CF_SEND_TELEMETRY=false DO_NOT_TRACK=1",
    `export CLOUDFLARE_ACCOUNT_ID=${accountId} CLOUDFLARE_API_TOKEN=${PLACEHOLDER}`,
    `export TEMPO_DEPLOY_TARGET=${plan.target} TEMPO_DEPLOY_STAGE=${plan.stage}`,
    plan.rollout === "gradual" ? "export TEMPO_DEPLOY_TRAFFIC=0" : null,
    plan.root === "" ? null : `cd ${plan.root}`,
    `if [ ! -f ${tool.file} ]; then echo '${tool.file} was not found in ${where}.' >&2; exit 2; fi`,
    install,
    plan.build,
    tool.deploy(plan.stage),
  ]
    .filter((line) => line !== null)
    .join("\n");
};
