import { TempoError, type FnInput, type FnOutput } from "@tempo/protocol";
import {
  createArtifactIssue,
  createArtifactIssueComment,
  createArtifactLabel,
  deleteArtifactIssueComment,
  deleteArtifactLabel,
  getArtifactIssue,
  listArtifactIssueComments,
  listArtifactIssues,
  listArtifactLabels,
  updateArtifactIssue,
  updateArtifactIssueComment,
  updateArtifactLabel,
} from "../../artifacts/issues.ts";
import type { ProjectRow } from "../../db/d1.ts";
import type { HandlerCtx } from "../run.ts";
import { requireProject } from "./common.ts";

const withOwnedRepository = async <T>(
  ctx: HandlerCtx,
  projectId: string,
  action: (project: ProjectRow) => Promise<T>,
): Promise<T> => {
  try {
    const project = await requireProject(ctx.env, ctx.user.id, projectId);

    if (project.provider !== "artifacts" || !project.artifactRepoId)
      throw new TempoError("VALIDATION_FAILED", undefined, "Issues are available for Tempo repositories.");

    return await action(project);
  } catch (cause) {
    if (cause instanceof TempoError) throw cause;
    throw new TempoError("INTERNAL");
  }
};

export const listRepositoryIssues = (
  ctx: HandlerCtx,
  { projectId, ...input }: FnInput<"listRepositoryIssues">,
): Promise<FnOutput<"listRepositoryIssues">> =>
  withOwnedRepository(ctx, projectId, (project) => listArtifactIssues(ctx.env, project, input));

export const getRepositoryIssue = (
  ctx: HandlerCtx,
  { projectId, number }: FnInput<"getRepositoryIssue">,
): Promise<FnOutput<"getRepositoryIssue">> =>
  withOwnedRepository(ctx, projectId, (project) => getArtifactIssue(ctx.env, project, number));

export const createRepositoryIssue = (
  ctx: HandlerCtx,
  { projectId, ...input }: FnInput<"createRepositoryIssue">,
): Promise<FnOutput<"createRepositoryIssue">> =>
  withOwnedRepository(ctx, projectId, (project) => createArtifactIssue(ctx.env, project, ctx.user.id, input));

export const updateRepositoryIssue = (
  ctx: HandlerCtx,
  { projectId, ...input }: FnInput<"updateRepositoryIssue">,
): Promise<FnOutput<"updateRepositoryIssue">> =>
  withOwnedRepository(ctx, projectId, (project) => updateArtifactIssue(ctx.env, project, input));

export const listRepositoryIssueComments = (
  ctx: HandlerCtx,
  { projectId, ...input }: FnInput<"listRepositoryIssueComments">,
): Promise<FnOutput<"listRepositoryIssueComments">> =>
  withOwnedRepository(ctx, projectId, (project) => listArtifactIssueComments(ctx.env, project, input));

export const createRepositoryIssueComment = (
  ctx: HandlerCtx,
  { projectId, ...input }: FnInput<"createRepositoryIssueComment">,
): Promise<FnOutput<"createRepositoryIssueComment">> =>
  withOwnedRepository(ctx, projectId, (project) =>
    createArtifactIssueComment(ctx.env, project, ctx.user.id, input),
  );

export const updateRepositoryIssueComment = (
  ctx: HandlerCtx,
  { projectId, ...input }: FnInput<"updateRepositoryIssueComment">,
): Promise<FnOutput<"updateRepositoryIssueComment">> =>
  withOwnedRepository(ctx, projectId, (project) => updateArtifactIssueComment(ctx.env, project, input));

export const deleteRepositoryIssueComment = (
  ctx: HandlerCtx,
  { projectId, ...input }: FnInput<"deleteRepositoryIssueComment">,
): Promise<FnOutput<"deleteRepositoryIssueComment">> =>
  withOwnedRepository(ctx, projectId, (project) => deleteArtifactIssueComment(ctx.env, project, input));

export const listRepositoryLabels = (
  ctx: HandlerCtx,
  { projectId }: FnInput<"listRepositoryLabels">,
): Promise<FnOutput<"listRepositoryLabels">> =>
  withOwnedRepository(ctx, projectId, (project) => listArtifactLabels(ctx.env, project));

export const createRepositoryLabel = (
  ctx: HandlerCtx,
  { projectId, ...input }: FnInput<"createRepositoryLabel">,
): Promise<FnOutput<"createRepositoryLabel">> =>
  withOwnedRepository(ctx, projectId, (project) => createArtifactLabel(ctx.env, project, input));

export const updateRepositoryLabel = (
  ctx: HandlerCtx,
  { projectId, ...input }: FnInput<"updateRepositoryLabel">,
): Promise<FnOutput<"updateRepositoryLabel">> =>
  withOwnedRepository(ctx, projectId, (project) => updateArtifactLabel(ctx.env, project, input));

export const deleteRepositoryLabel = (
  ctx: HandlerCtx,
  { projectId, labelId }: FnInput<"deleteRepositoryLabel">,
): Promise<FnOutput<"deleteRepositoryLabel">> =>
  withOwnedRepository(ctx, projectId, (project) => deleteArtifactLabel(ctx.env, project, labelId));
