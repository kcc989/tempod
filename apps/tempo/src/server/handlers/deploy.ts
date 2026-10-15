import { TempoError, unwrap, type DeploySettings, type FnInput, type FnOutput } from "@tempo/protocol";
import type { DeploymentQuery } from "../../do/app-deploy.ts";
import { permissionGroups, type CloudflareApi } from "../../deploy/cloudflare.ts";
import { ACCOUNT_ID, DEPLOY_ACCOUNT_KEY, DEPLOY_MASTER_KEY } from "../../deploy/types.ts";
import type { HandlerCtx } from "../run.ts";
import { requireProject } from "./common.ts";

/** The Cloudflare API for the token check on save (12, Owner settings); tests replace `fetch`. */
export const settingsCloudflare: CloudflareApi = { fetch: (request) => fetch(request) };

const creds = (c: HandlerCtx) => c.env.CREDENTIALS.getByName(c.user.id);

const settings = async (c: HandlerCtx): Promise<DeploySettings> => {
  const rows = await creds(c).status();
  const token = rows.find((r) => r.key === DEPLOY_MASTER_KEY);
  const accountId = token ? await creds(c).getSecret(DEPLOY_ACCOUNT_KEY) : null;

  return { accountId, tokenSet: token !== undefined, updatedAt: token?.updatedAt ?? null };
};

export const getDeploySettings = async (c: HandlerCtx): Promise<FnOutput<"getDeploySettings">> => settings(c);

export const updateDeploySettings = async (
  c: HandlerCtx,
  { accountId, token }: FnInput<"updateDeploySettings">,
): Promise<FnOutput<"updateDeploySettings">> => {
  const id = accountId.trim();
  const value = token.trim();

  if (!ACCOUNT_ID.test(id))
    throw new TempoError("VALIDATION_FAILED", undefined, "The account ID is 32 lowercase hex characters.");

  if (value.length < 1 || value.length > 512)
    throw new TempoError("VALIDATION_FAILED", undefined, "The token is 1 to 512 characters.");

  try {
    await permissionGroups(settingsCloudflare, value, id);
  } catch {
    throw new TempoError("DEPLOY_TOKEN_INVALID");
  }

  await creds(c).putSecret(DEPLOY_ACCOUNT_KEY, id);
  await creds(c).putSecret(DEPLOY_MASTER_KEY, value);

  return settings(c);
};

export const deleteDeploySettings = async (c: HandlerCtx): Promise<FnOutput<"deleteDeploySettings">> => {
  await creds(c).deleteSecret(DEPLOY_MASTER_KEY);
  await creds(c).deleteSecret(DEPLOY_ACCOUNT_KEY);

  return settings(c);
};

/** 12, API: every project function needs an owned Artifacts project. */
const coordinator = async ({ env, user }: HandlerCtx, projectId: string) => {
  const project = await requireProject(env, user.id, projectId);

  if (project.provider !== "artifacts")
    throw new TempoError(
      "VALIDATION_FAILED",
      undefined,
      "App deploys are only for Tempo-hosted repositories.",
    );

  return env.APP_DEPLOY.getByName(project.id);
};

export const getDeployConfig = async (
  ctx: HandlerCtx,
  { projectId }: FnInput<"getDeployConfig">,
): Promise<FnOutput<"getDeployConfig">> => unwrap(await (await coordinator(ctx, projectId)).getConfig());

export const updateDeployConfig = async (
  ctx: HandlerCtx,
  { projectId, source, revision }: FnInput<"updateDeployConfig">,
): Promise<FnOutput<"updateDeployConfig">> =>
  unwrap(await (await coordinator(ctx, projectId)).updateConfig({ source, revision }));

export const listDeployments = async (
  ctx: HandlerCtx,
  { projectId, target, offset }: FnInput<"listDeployments">,
): Promise<FnOutput<"listDeployments">> => {
  let query: DeploymentQuery = {};

  if (target !== undefined) query = { ...query, target };

  if (offset !== undefined) query = { ...query, offset };

  return unwrap(await (await coordinator(ctx, projectId)).list(query));
};

export const getDeployment = async (
  ctx: HandlerCtx,
  { projectId, deploymentId }: FnInput<"getDeployment">,
): Promise<FnOutput<"getDeployment">> => unwrap(await (await coordinator(ctx, projectId)).get(deploymentId));

export const startDeployment = async (
  ctx: HandlerCtx,
  { projectId, target, branch }: FnInput<"startDeployment">,
): Promise<FnOutput<"startDeployment">> =>
  unwrap(
    await (
      await coordinator(ctx, projectId)
    ).start(branch === undefined ? { target, trigger: "manual" } : { target, branch, trigger: "manual" }),
  );

export const redeploy = async (
  ctx: HandlerCtx,
  { projectId, deploymentId }: FnInput<"redeploy">,
): Promise<FnOutput<"redeploy">> => unwrap(await (await coordinator(ctx, projectId)).redeploy(deploymentId));

export const cancelDeployment = async (
  ctx: HandlerCtx,
  { projectId, deploymentId }: FnInput<"cancelDeployment">,
): Promise<FnOutput<"cancelDeployment">> =>
  unwrap(await (await coordinator(ctx, projectId)).cancel(deploymentId));

export const getDeploymentLog = async (
  ctx: HandlerCtx,
  { projectId, deploymentId }: FnInput<"getDeploymentLog">,
): Promise<FnOutput<"getDeploymentLog">> =>
  unwrap(await (await coordinator(ctx, projectId)).log(deploymentId));
