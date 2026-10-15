import type { DeployRolloutWorker } from "@tempo/protocol";
import {
  createWorkerDeployment,
  listWorkerDeployments,
  listWorkerVersions,
  type CloudflareApi,
  type WorkerDeployment,
} from "./cloudflare.ts";

/** 12, Gradual rollout. */
export const ROLLOUT = {
  canaryPercent: 10,
  observeMs: 10 * 60_000,
  smokeTimeoutMs: 10_000,
} as const;

export class RolloutError extends Error {}

export interface CloudflareTarget {
  readonly api: CloudflareApi;
  readonly token: string;
  readonly accountId: string;
}

const majority = (deployment: WorkerDeployment | undefined): string | null =>
  deployment?.versions.toSorted((a, b) => b.percentage - a.percentage)[0]?.version_id ?? null;

export interface Recorded {
  readonly workers: DeployRolloutWorker[];
  /** The first Worker that the tool deployed at 100%, or null. */
  readonly full: string | null;
}

/** Step 1, Record. */
export const recordVersions = async (
  cf: CloudflareTarget,
  names: ReadonlyArray<string>,
  startedAt: number,
): Promise<Recorded> => {
  const workers: DeployRolloutWorker[] = [];
  let full: string | null = null;

  for (const name of names) {
    const deployments = await listWorkerDeployments(cf.api, cf.token, cf.accountId, name);
    const live = deployments[0];
    const before = deployments.find((d) => Date.parse(d.created_on) < startedAt);

    if (
      live &&
      Date.parse(live.created_on) >= startedAt &&
      live.versions.length === 1 &&
      live.versions[0]!.percentage === 100
    ) {
      full ??= name;
      workers.push({
        name,
        versionId: live.versions[0]!.version_id,
        previousVersionId: majority(before),
        percentage: 100,
        cloudflareDeploymentId: live.id,
      });
      continue;
    }

    const versions = await listWorkerVersions(cf.api, cf.token, cf.accountId, name);
    const uploaded = versions.find((v) => Date.parse(v.createdOn) >= startedAt);

    if (!uploaded)
      throw new RolloutError(
        `No new version of ${name} was uploaded. Pass TEMPO_DEPLOY_TRAFFIC to version.traffic.`,
      );

    workers.push({
      name,
      versionId: uploaded.id,
      previousVersionId: majority(live),
      percentage: 0,
      cloudflareDeploymentId: null,
    });
  }

  return { workers, full };
};

/** Gives the new version `percentage` and the previous version the rest. */
export const moveTraffic = async (
  cf: CloudflareTarget,
  worker: DeployRolloutWorker,
  percentage: number,
  message: string,
): Promise<DeployRolloutWorker> => {
  const split =
    percentage === 100 || worker.previousVersionId === null
      ? [{ versionId: worker.versionId, percentage: 100 }]
      : [
          { versionId: worker.versionId, percentage },
          { versionId: worker.previousVersionId, percentage: 100 - percentage },
        ];

  const created = await createWorkerDeployment(cf.api, cf.token, cf.accountId, worker.name, {
    split,
    message,
  });

  return { ...worker, percentage: split[0]!.percentage, cloudflareDeploymentId: created.id };
};

export type Restored =
  | { readonly ok: true; readonly worker: DeployRolloutWorker }
  | { readonly ok: false; readonly error: string };

/** The previous version back at 100%. */
export const restorePrevious = async (
  cf: CloudflareTarget,
  worker: DeployRolloutWorker,
  message: string,
): Promise<Restored> => {
  if (worker.previousVersionId === null)
    return { ok: false, error: `${worker.name} has no previous version` };

  try {
    const created = await createWorkerDeployment(cf.api, cf.token, cf.accountId, worker.name, {
      split: [{ versionId: worker.previousVersionId, percentage: 100 }],
      message,
    });

    return { ok: true, worker: { ...worker, percentage: 0, cloudflareDeploymentId: created.id } };
  } catch (e) {
    return { ok: false, error: `${worker.name}: ${e instanceof Error ? e.message : "Cloudflare refused"}` };
  }
};

/** Step 3. Returns null when every URL answers below 500, else the reason. */
export const smokeTest = async (
  fetcher: (request: Request) => Promise<Response>,
  urls: ReadonlyArray<string>,
  worker: DeployRolloutWorker,
): Promise<string | null> => {
  for (const url of urls) {
    try {
      const res = await fetcher(
        new Request(url, {
          redirect: "manual",
          headers: { "cloudflare-workers-version-overrides": `${worker.name}="${worker.versionId}"` },
          signal: AbortSignal.timeout(ROLLOUT.smokeTimeoutMs),
        }),
      );

      await res.body?.cancel();

      if (res.status >= 500) return `smoke test ${url} answered ${res.status}`;
    } catch {
      return `smoke test ${url} did not answer`;
    }
  }

  return null;
};
