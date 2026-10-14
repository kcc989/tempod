import { TempoError, type FnInput, type FnOutput } from "@tempo/protocol";
import {
  createArtifactPullRequest,
  getArtifactPullRequest,
  listArtifactPullRequests,
  updateArtifactPullRequest,
  type ArtifactProject,
} from "../../artifacts/pull-requests.ts";
import type { ProjectNeed } from "../../auth/access.ts";
import type { HandlerCtx, PublicCtx } from "../run.ts";
import { requireProject } from "./common.ts";

const repository = async (
  { env, user }: PublicCtx,
  projectId: string,
  need: ProjectNeed,
): Promise<ArtifactProject> => {
  const project = await requireProject(env, user, projectId, need);

  if (project.provider !== "artifacts")
    throw new TempoError(
      "VALIDATION_FAILED",
      undefined,
      "Use GitHub to manage this project's repository pull requests.",
    );

  return { id: project.id, name: project.repoName, artifactRepoId: project.artifactRepoId };
};

const withRepository = async <T>(
  ctx: PublicCtx,
  projectId: string,
  need: ProjectNeed,
  action: (project: ArtifactProject) => Promise<T>,
): Promise<T> => {
  try {
    return await action(await repository(ctx, projectId, need));
  } catch (cause) {
    if (cause instanceof TempoError) throw cause;
    throw new TempoError("INTERNAL");
  }
};

export const listRepositoryPullRequests = async (
  ctx: PublicCtx,
  { projectId, state }: FnInput<"listRepositoryPullRequests">,
): Promise<FnOutput<"listRepositoryPullRequests">> =>
  withRepository(ctx, projectId, "public", (project) => listArtifactPullRequests(ctx.env, project, state));

export const getRepositoryPullRequest = async (
  ctx: PublicCtx,
  { projectId, number }: FnInput<"getRepositoryPullRequest">,
): Promise<FnOutput<"getRepositoryPullRequest">> =>
  withRepository(ctx, projectId, "public", (project) => getArtifactPullRequest(ctx.env, project, number));

export const createRepositoryPullRequest = async (
  ctx: HandlerCtx,
  { projectId, ...input }: FnInput<"createRepositoryPullRequest">,
): Promise<FnOutput<"createRepositoryPullRequest">> =>
  withRepository(ctx, projectId, "write", (project) => createArtifactPullRequest(ctx.env, project, input));

export const updateRepositoryPullRequest = async (
  ctx: HandlerCtx,
  { projectId, ...input }: FnInput<"updateRepositoryPullRequest">,
): Promise<FnOutput<"updateRepositoryPullRequest">> =>
  withRepository(ctx, projectId, "write", (project) => updateArtifactPullRequest(ctx.env, project, input));
