import { eq } from "drizzle-orm";
import { refreshProjectEnv } from "./credentials.ts";
import { Schema } from "effect";
import { TempoError, unwrap, type DeploySettings, type FnInput, type FnOutput } from "@tempo/protocol";
import type { DeploymentQuery } from "../../do/app-deploy.ts";
import { permissionGroups, type CloudflareApi } from "../../deploy/cloudflare.ts";
import { ISSUES, issuesSecretKey, issuesWebhookPath, parseIssue } from "../../deploy/issues.ts";
import { ACCOUNT_ID, DEPLOY_ACCOUNT_KEY, DEPLOY_MASTER_KEY } from "../../deploy/types.ts";
import { user as users } from "../../db/auth-schema.ts";
import { projects } from "../../db/d1.ts";
import type { Env } from "../../env.ts";
import { bytesToBase64Url, timingSafeEqual } from "../../lib/crypto.ts";
import { errorText, log } from "../../log.ts";
import { createWorkspace } from "./workspaces.ts";
import type { HandlerCtx } from "../run.ts";
import { d1, requireProject } from "./common.ts";

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
): Promise<FnOutput<"updateDeployConfig">> => {
  const config = unwrap(await (await coordinator(ctx, projectId)).updateConfig({ source, revision }));
  await refreshProjectEnv(ctx, projectId);

  return config;
};

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

export const rollbackDeployment = async (
  ctx: HandlerCtx,
  { projectId, deploymentId }: FnInput<"rollbackDeployment">,
): Promise<FnOutput<"rollbackDeployment">> =>
  unwrap(await (await coordinator(ctx, projectId)).rollbackDeployment(deploymentId));

export const getDeploymentLog = async (
  ctx: HandlerCtx,
  { projectId, deploymentId }: FnInput<"getDeploymentLog">,
): Promise<FnOutput<"getDeploymentLog">> =>
  unwrap(await (await coordinator(ctx, projectId)).log(deploymentId));

// ---------- production errors (12, Production errors) ----------
export const listProductionErrors = async (
  ctx: HandlerCtx,
  { projectId }: FnInput<"listProductionErrors">,
): Promise<FnOutput<"listProductionErrors">> =>
  unwrap(await (await coordinator(ctx, projectId)).listErrors());

/** Creates the fix workspace once; shared by Start fix and auto_fix. */
const startFix = async (ctx: HandlerCtx, projectId: string, errorId: string): Promise<string> => {
  const stub = await coordinator(ctx, projectId);
  const fix = unwrap(await stub.fixContext(errorId));

  if (fix.kind === "existing") return fix.workspaceId;

  if (fix.kind === "busy") throw new TempoError("WORKSPACE_BUSY");
  const project = await requireProject(ctx.env, ctx.user.id, projectId);

  try {
    const workspace = await createWorkspace(ctx, {
      projectId,
      source: { kind: "new", baseBranch: fix.baseBranch ?? project.defaultBranch },
      prompt: { text: fix.prompt },
    });

    await stub.setFixWorkspace(errorId, workspace.id);

    return workspace.id;
  } catch (e) {
    await stub.setFixWorkspace(errorId, null);
    throw e;
  }
};

export const startErrorFix = async (
  ctx: HandlerCtx,
  { projectId, errorId }: FnInput<"startErrorFix">,
): Promise<FnOutput<"startErrorFix">> => ({ workspaceId: await startFix(ctx, projectId, errorId) });

const webhookUrl = (env: Env, projectId: string) => `https://${env.APP_HOST}${issuesWebhookPath(projectId)}`;

export const getIssuesWebhook = async (
  ctx: HandlerCtx,
  { projectId }: FnInput<"getIssuesWebhook">,
): Promise<FnOutput<"getIssuesWebhook">> => {
  await coordinator(ctx, projectId);

  return {
    url: webhookUrl(ctx.env, projectId),
    secretSet: (await creds(ctx).getSecret(issuesSecretKey(projectId))) !== null,
  };
};

export const rotateIssuesWebhook = async (
  ctx: HandlerCtx,
  { projectId }: FnInput<"rotateIssuesWebhook">,
): Promise<FnOutput<"rotateIssuesWebhook">> => {
  await coordinator(ctx, projectId);
  const secret = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  await creds(ctx).putSecret(issuesSecretKey(projectId), secret);

  return { url: webhookUrl(ctx.env, projectId), secret };
};

const WEBHOOK = /^\/api\/hooks\/cloudflare-issues\/([0-9a-hjkmnp-tv-z]{26})$/;

/** `POST /api/hooks/cloudflare-issues/<projectId>`, with no session (12, Production errors). */
export const handleIssuesWebhook = async (
  request: Request,
  env: Env,
  url: URL,
  waitUntil: (work: Promise<unknown>) => void,
): Promise<Response | null> => {
  const match = WEBHOOK.exec(url.pathname);

  if (!match) return null;
  const notFound = new Response("Not found", { status: 404 });

  if (request.method !== "POST") return notFound;
  const projectId = match[1]!;
  const project = await d1(env).select().from(projects).where(eq(projects.id, projectId)).get();

  if (!project || project.provider !== "artifacts") return notFound;
  const secret = await env.CREDENTIALS.getByName(project.userId).getSecret(issuesSecretKey(projectId));
  const given = request.headers.get("cf-webhook-auth");

  if (!secret || given === null || !timingSafeEqual(given, secret)) return notFound;
  const body = await request.arrayBuffer();

  if (body.byteLength > ISSUES.bodyBytes) return new Response("Too large", { status: 413 });
  let json: Schema.Json;

  try {
    json = Schema.decodeUnknownSync(Schema.Json)(JSON.parse(new TextDecoder().decode(body)));
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const issue = await parseIssue(json);

  if (!issue) return new Response("Bad request", { status: 400 });
  const result = await env.APP_DEPLOY.getByName(projectId).ingestIssue(issue);

  if (result.autoFix) waitUntil(startFixAsOwner(env, project.userId, projectId, result.errorId));

  return new Response(null, { status: 204 });
};

const startFixAsOwner = async (env: Env, userId: string, projectId: string, errorId: string) => {
  try {
    const owner = await d1(env).select().from(users).where(eq(users.id, userId)).get();

    if (!owner) return;
    await startFix(
      { env, user: { id: owner.id, name: owner.name, email: owner.email, image: owner.image ?? null } },
      projectId,
      errorId,
    );
  } catch (e) {
    log("warn", "auto fix failed", { projectId, error: errorText(e) });
  }
};
