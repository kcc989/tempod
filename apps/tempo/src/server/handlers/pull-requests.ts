import { TempoError, type FnInput, type FnOutput } from "@tempo/protocol";
import {
  createArtifactPullRequest,
  getArtifactPullRequest,
  listArtifactPullRequests,
  updateArtifactPullRequest,
  type ArtifactProject,
} from "../../artifacts/pull-requests.ts";
import type { HandlerCtx } from "../run.ts";
import { requireProject } from "./common.ts";

const ownedRepository = async ({ env, user }: HandlerCtx, projectId: string): Promise<ArtifactProject> => {
  const project = await requireProject(env, user.id, projectId);

  if (project.provider !== "artifacts")
    throw new TempoError(
      "VALIDATION_FAILED",
      undefined,
      "Use GitHub to manage this project's repository pull requests.",
    );

  return { id: project.id, name: project.repoName, artifactRepoId: project.artifactRepoId };
};

const withOwnedRepository = async <T>(
  ctx: HandlerCtx,
  projectId: string,
  action: (project: ArtifactProject) => Promise<T>,
): Promise<T> => {
  try {
    return await action(await ownedRepository(ctx, projectId));
  } catch (cause) {
    if (cause instanceof TempoError) throw cause;
    throw new TempoError("INTERNAL");
  }
};

export const listRepositoryPullRequests = async (
  ctx: HandlerCtx,
  { projectId, state }: FnInput<"listRepositoryPullRequests">,
): Promise<FnOutput<"listRepositoryPullRequests">> =>
  withOwnedRepository(ctx, projectId, (project) => listArtifactPullRequests(ctx.env, project, state));

export const getRepositoryPullRequest = async (
  ctx: HandlerCtx,
  { projectId, number }: FnInput<"getRepositoryPullRequest">,
): Promise<FnOutput<"getRepositoryPullRequest">> =>
  withOwnedRepository(ctx, projectId, (project) => getArtifactPullRequest(ctx.env, project, number));

export const createRepositoryPullRequest = async (
  ctx: HandlerCtx,
  { projectId, ...input }: FnInput<"createRepositoryPullRequest">,
): Promise<FnOutput<"createRepositoryPullRequest">> =>
  withOwnedRepository(ctx, projectId, (project) => createArtifactPullRequest(ctx.env, project, input));

export const updateRepositoryPullRequest = async (
  ctx: HandlerCtx,
  { projectId, ...input }: FnInput<"updateRepositoryPullRequest">,
): Promise<FnOutput<"updateRepositoryPullRequest">> =>
  withOwnedRepository(ctx, projectId, (project) => updateArtifactPullRequest(ctx.env, project, input));
