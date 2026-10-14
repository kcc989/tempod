import { TempoError, unwrap, type FnInput, type FnOutput } from "@tempo/protocol";
import type { CiRunQuery } from "../../do/repository-ci.ts";
import type { ProjectNeed } from "../../auth/access.ts";
import type { HandlerCtx } from "../run.ts";
import { requireProject } from "./common.ts";

/** 10, API: every function needs an Artifacts project; 11 sets the role. */
const coordinator = async ({ env, user }: HandlerCtx, projectId: string, need: ProjectNeed) => {
  const project = await requireProject(env, user, projectId, need);

  if (project.provider !== "artifacts")
    throw new TempoError("VALIDATION_FAILED", undefined, "Project CI is only for Tempo-hosted repositories.");

  return env.REPOSITORY_CI.getByName(project.id);
};

export const getCiPipeline = async (
  ctx: HandlerCtx,
  { projectId }: FnInput<"getCiPipeline">,
): Promise<FnOutput<"getCiPipeline">> =>
  unwrap(await (await coordinator(ctx, projectId, "read")).getPipeline());

export const updateCiPipeline = async (
  ctx: HandlerCtx,
  { projectId, source, revision }: FnInput<"updateCiPipeline">,
): Promise<FnOutput<"updateCiPipeline">> =>
  unwrap(await (await coordinator(ctx, projectId, "admin")).updatePipeline({ source, revision }));

export const listCiRuns = async (
  ctx: HandlerCtx,
  { projectId, branch, offset }: FnInput<"listCiRuns">,
): Promise<FnOutput<"listCiRuns">> => {
  let query: CiRunQuery = {};

  if (branch !== undefined) query = { ...query, branch };

  if (offset !== undefined) query = { ...query, offset };

  return unwrap(await (await coordinator(ctx, projectId, "read")).listRuns(query));
};

export const getCiRun = async (
  ctx: HandlerCtx,
  { projectId, runId }: FnInput<"getCiRun">,
): Promise<FnOutput<"getCiRun">> => unwrap(await (await coordinator(ctx, projectId, "read")).getRun(runId));

export const startCiRun = async (
  ctx: HandlerCtx,
  { projectId, branch }: FnInput<"startCiRun">,
): Promise<FnOutput<"startCiRun">> =>
  unwrap(await (await coordinator(ctx, projectId, "write")).startRun(branch));

export const rerunCiRun = async (
  ctx: HandlerCtx,
  { projectId, runId }: FnInput<"rerunCiRun">,
): Promise<FnOutput<"rerunCiRun">> => unwrap(await (await coordinator(ctx, projectId, "write")).rerun(runId));

export const cancelCiRun = async (
  ctx: HandlerCtx,
  { projectId, runId }: FnInput<"cancelCiRun">,
): Promise<FnOutput<"cancelCiRun">> =>
  unwrap(await (await coordinator(ctx, projectId, "write")).cancel(runId));

export const getCiJobLog = async (
  ctx: HandlerCtx,
  { projectId, runId, job }: FnInput<"getCiJobLog">,
): Promise<FnOutput<"getCiJobLog">> =>
  unwrap(await (await coordinator(ctx, projectId, "read")).jobLog(runId, job));
