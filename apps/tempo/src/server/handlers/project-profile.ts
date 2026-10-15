import { unwrap, type FnInput, type FnOutput } from "@tempo/protocol";
import type { HandlerCtx } from "../run.ts";
import { requireProject } from "./common.ts";

/** 13, L-ADR-3: the profile lives in the project's AppDeployDO, for every kind of project. */
const store = async ({ env, user }: HandlerCtx, projectId: string) =>
  env.APP_DEPLOY.getByName((await requireProject(env, user.id, projectId)).id);

export const getProjectProfile = async (
  ctx: HandlerCtx,
  { projectId }: FnInput<"getProjectProfile">,
): Promise<FnOutput<"getProjectProfile">> => unwrap(await (await store(ctx, projectId)).getProfile());

export const updateProjectProfile = async (
  ctx: HandlerCtx,
  { projectId, source, revision }: FnInput<"updateProjectProfile">,
): Promise<FnOutput<"updateProjectProfile">> =>
  unwrap(await (await store(ctx, projectId)).updateProfile({ source, revision }));
