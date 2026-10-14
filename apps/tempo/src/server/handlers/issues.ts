import { TempoError, type FnInput, type FnOutput } from "@tempo/protocol";
import {
  createArtifactIssue,
  createArtifactIssueComment,
  createArtifactLabel,
  deleteArtifactIssueComment,
  deleteArtifactIssue,
  deleteArtifactLabel,
  getArtifactIssue,
  listArtifactIssueComments,
  listArtifactIssues,
  listArtifactLabels,
  updateArtifactIssue,
  updateArtifactIssueComment,
  updateArtifactLabel,
} from "../../artifacts/issues.ts";
import { eq } from "drizzle-orm";
import { requireProjectAccess, type ProjectNeed } from "../../auth/access.ts";
import { issueComments, type ProjectRow } from "../../db/d1.ts";
import type { HandlerCtx, PublicCtx } from "../run.ts";
import { d1 } from "./common.ts";

const withRepository = async <T>(
  ctx: PublicCtx,
  projectId: string,
  need: ProjectNeed,
  action: (project: ProjectRow) => Promise<T>,
  commentId?: string,
): Promise<T> => {
  try {
    const { project, memberRole } = await requireProjectAccess(ctx.env, ctx.user, projectId, need);

    // 11, policy `author`: a writer may change only their own comments; an admin may change any.
    if (commentId !== undefined && memberRole !== "admin") {
      const comment = await d1(ctx.env)
        .select({ authorId: issueComments.authorId })
        .from(issueComments)
        .where(eq(issueComments.id, commentId))
        .get();

      if (comment && comment.authorId !== ctx.user?.id) throw new TempoError("FORBIDDEN");
    }

    if (project.provider !== "artifacts" || !project.artifactRepoId)
      throw new TempoError("VALIDATION_FAILED", undefined, "Issues are available for Tempo repositories.");

    return await action(project);
  } catch (cause) {
    if (cause instanceof TempoError) throw cause;
    throw new TempoError("INTERNAL");
  }
};

export const listRepositoryIssues = (
  ctx: PublicCtx,
  { projectId, ...input }: FnInput<"listRepositoryIssues">,
): Promise<FnOutput<"listRepositoryIssues">> =>
  withRepository(ctx, projectId, "public", (project) => listArtifactIssues(ctx.env, project, input));

export const getRepositoryIssue = (
  ctx: PublicCtx,
  { projectId, number }: FnInput<"getRepositoryIssue">,
): Promise<FnOutput<"getRepositoryIssue">> =>
  withRepository(ctx, projectId, "public", (project) => getArtifactIssue(ctx.env, project, number));

export const createRepositoryIssue = (
  ctx: HandlerCtx,
  { projectId, ...input }: FnInput<"createRepositoryIssue">,
): Promise<FnOutput<"createRepositoryIssue">> =>
  withRepository(ctx, projectId, "write", (project) =>
    createArtifactIssue(ctx.env, project, ctx.user.id, input),
  );

export const updateRepositoryIssue = (
  ctx: HandlerCtx,
  { projectId, ...input }: FnInput<"updateRepositoryIssue">,
): Promise<FnOutput<"updateRepositoryIssue">> =>
  withRepository(ctx, projectId, "write", (project) => updateArtifactIssue(ctx.env, project, input));

export const listRepositoryIssueComments = (
  ctx: PublicCtx,
  { projectId, ...input }: FnInput<"listRepositoryIssueComments">,
): Promise<FnOutput<"listRepositoryIssueComments">> =>
  withRepository(ctx, projectId, "public", (project) => listArtifactIssueComments(ctx.env, project, input));

export const createRepositoryIssueComment = (
  ctx: HandlerCtx,
  { projectId, ...input }: FnInput<"createRepositoryIssueComment">,
): Promise<FnOutput<"createRepositoryIssueComment">> =>
  withRepository(ctx, projectId, "write", (project) =>
    createArtifactIssueComment(ctx.env, project, ctx.user.id, input),
  );

export const updateRepositoryIssueComment = (
  ctx: HandlerCtx,
  { projectId, ...input }: FnInput<"updateRepositoryIssueComment">,
): Promise<FnOutput<"updateRepositoryIssueComment">> =>
  withRepository(
    ctx,
    projectId,
    "write",
    (project) => updateArtifactIssueComment(ctx.env, project, input),
    input.commentId,
  );

export const deleteRepositoryIssueComment = (
  ctx: HandlerCtx,
  { projectId, ...input }: FnInput<"deleteRepositoryIssueComment">,
): Promise<FnOutput<"deleteRepositoryIssueComment">> =>
  withRepository(
    ctx,
    projectId,
    "write",
    (project) => deleteArtifactIssueComment(ctx.env, project, input),
    input.commentId,
  );

export const listRepositoryLabels = (
  ctx: PublicCtx,
  { projectId }: FnInput<"listRepositoryLabels">,
): Promise<FnOutput<"listRepositoryLabels">> =>
  withRepository(ctx, projectId, "public", (project) => listArtifactLabels(ctx.env, project));

export const createRepositoryLabel = (
  ctx: HandlerCtx,
  { projectId, ...input }: FnInput<"createRepositoryLabel">,
): Promise<FnOutput<"createRepositoryLabel">> =>
  withRepository(ctx, projectId, "write", (project) => createArtifactLabel(ctx.env, project, input));

export const updateRepositoryLabel = (
  ctx: HandlerCtx,
  { projectId, ...input }: FnInput<"updateRepositoryLabel">,
): Promise<FnOutput<"updateRepositoryLabel">> =>
  withRepository(ctx, projectId, "write", (project) => updateArtifactLabel(ctx.env, project, input));

export const deleteRepositoryLabel = (
  ctx: HandlerCtx,
  { projectId, labelId }: FnInput<"deleteRepositoryLabel">,
): Promise<FnOutput<"deleteRepositoryLabel">> =>
  withRepository(ctx, projectId, "write", (project) => deleteArtifactLabel(ctx.env, project, labelId));

export const deleteRepositoryIssue = (
  ctx: HandlerCtx,
  { projectId, number }: FnInput<"deleteRepositoryIssue">,
): Promise<FnOutput<"deleteRepositoryIssue">> =>
  withRepository(ctx, projectId, "admin", (project) => deleteArtifactIssue(ctx.env, project, number));
