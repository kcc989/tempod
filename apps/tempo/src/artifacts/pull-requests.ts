import { and, desc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { TempoError, newId, type RepositoryPullRequest } from "@tempo/protocol";
import { pullRequests, type PullRequestRow } from "../db/d1.ts";
import type { Env } from "../env.ts";
import type { GhPull } from "../github/api.ts";
import { validateArtifactBranch, withArtifactRepository } from "./repositories.ts";

export interface ArtifactProject {
  readonly id: string;
  readonly artifactRepoId: string | null;
  readonly name: string;
}

type CreateInput = Pick<RepositoryPullRequest, "title" | "body" | "headBranch" | "baseBranch"> & {
  readonly draft: boolean;
};

type UpdateInput = {
  readonly number: number;
  readonly title?: string;
  readonly body?: string;
  readonly state?: "open" | "closed";
  readonly draft?: boolean;
};

const dbOf = (env: Env) => drizzle(env.DB);

const activeStates = ["open", "draft"] as const;

const SHA = /^[a-f0-9]{40}$/;

const requireArtifactProject = (project: ArtifactProject): void => {
  if (!project.artifactRepoId)
    throw new TempoError("VALIDATION_FAILED", undefined, "This project does not host a Tempo repository.");
};

const validateNumber = (number: number): void => {
  if (!Number.isSafeInteger(number) || number < 1)
    throw new TempoError("VALIDATION_FAILED", undefined, "Pull request numbers must be positive integers.");
};

const validateText = (input: Pick<UpdateInput, "title" | "body">): void => {
  if (input.title !== undefined && (!input.title.trim() || input.title.length > 256))
    throw new TempoError(
      "VALIDATION_FAILED",
      undefined,
      "Pull request titles must contain 1 to 256 characters.",
    );

  if (input.body !== undefined && input.body.length > 65_536)
    throw new TempoError(
      "VALIDATION_FAILED",
      undefined,
      "Pull request bodies must contain at most 65536 characters.",
    );
};

const toWire = (env: Env, row: PullRequestRow): RepositoryPullRequest => ({
  ...row,
  url: `https://${env.APP_HOST}/repositories?project=${encodeURIComponent(row.projectId)}&tab=pulls&pull=${row.number}`,
});

const branchTips = async (
  env: Env,
  project: ArtifactProject,
  headBranch: string,
  baseBranch: string,
  recoverHeadSha?: string | null,
  requireWrite = false,
): Promise<{ headSha: string; baseSha: string }> => {
  requireArtifactProject(project);
  validateArtifactBranch(headBranch);
  validateArtifactBranch(baseBranch);

  if (headBranch === baseBranch)
    throw new TempoError("PR_NOT_MERGEABLE", undefined, "Head and base branches must be different.");

  return withArtifactRepository(env, project.name, async (repo) => {
    const info = await repo.info();

    if (info.id !== project.artifactRepoId) throw new TempoError("NOT_FOUND");

    if (requireWrite && info.readOnly) throw new TempoError("FORBIDDEN", "This repository is read-only.");

    const [head, base] = await Promise.all([
      repo.log({ ref: headBranch, limit: 1 }),
      repo.log({ ref: baseBranch, limit: 1 }),
    ]);

    const headSha = head[0]?.hash ?? recoverHeadSha;
    const baseSha = base[0]?.hash;

    if (!headSha || !baseSha)
      throw new TempoError("NOT_FOUND", undefined, "Head and base branches must exist on the repository.");

    if (!SHA.test(headSha) || !SHA.test(baseSha)) throw new TempoError("ARTIFACTS_API_ERROR");

    return { headSha, baseSha };
  });
};

export const listArtifactPullRequests = async (
  env: Env,
  project: ArtifactProject,
  state: "open" | "closed" | "all" = "open",
): Promise<RepositoryPullRequest[]> => {
  requireArtifactProject(project);

  const stateFilter =
    state === "all"
      ? undefined
      : inArray(pullRequests.state, state === "open" ? ["open", "draft"] : ["closed", "merged"]);

  const rows = await dbOf(env)
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.projectId, project.id), stateFilter))
    .orderBy(desc(pullRequests.number))
    .all();

  return rows.map((row) => toWire(env, row));
};

export const getArtifactPullRequest = async (
  env: Env,
  project: ArtifactProject,
  number: number,
): Promise<RepositoryPullRequest> => {
  requireArtifactProject(project);
  validateNumber(number);

  const row = await dbOf(env)
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.projectId, project.id), eq(pullRequests.number, number)))
    .get();

  if (!row) throw new TempoError("NOT_FOUND");

  return toWire(env, row);
};

export const findArtifactOpenPullRequest = async (
  env: Env,
  project: ArtifactProject,
  headBranch: string,
): Promise<RepositoryPullRequest | null> => {
  requireArtifactProject(project);

  const row = await dbOf(env)
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.projectId, project.id),
        eq(pullRequests.headBranch, headBranch),
        inArray(pullRequests.state, [...activeStates]),
      ),
    )
    .get();

  return row ? toWire(env, row) : null;
};

const duplicateError = (pullRequest: RepositoryPullRequest) =>
  new TempoError("PR_EXISTS", undefined, `Pull request #${pullRequest.number} already uses this branch.`);

export const createArtifactPullRequest = async (
  env: Env,
  project: ArtifactProject,
  input: CreateInput,
): Promise<RepositoryPullRequest> => {
  requireArtifactProject(project);
  validateText(input);
  validateArtifactBranch(input.headBranch);
  validateArtifactBranch(input.baseBranch);

  if (input.headBranch === input.baseBranch)
    throw new TempoError("PR_NOT_MERGEABLE", undefined, "Head and base branches must be different.");
  const existing = await findArtifactOpenPullRequest(env, project, input.headBranch);

  if (existing) throw duplicateError(existing);
  const tips = await branchTips(env, project, input.headBranch, input.baseBranch, undefined, true);
  const id = newId();
  const now = Date.now();

  // The number and duplicate-head guard share one SQLite statement.
  const inserted = await env.DB.prepare(`
    INSERT INTO pull_requests (
      id, project_id, number, title, body, head_branch, base_branch, state,
      head_sha, base_sha, created_at, updated_at
    )
    SELECT ?, ?, COALESCE((SELECT MAX(number) FROM pull_requests WHERE project_id = ?), 0) + 1,
      ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM pull_requests WHERE project_id = ? AND head_branch = ? AND state IN ('open','draft')
    )
  `)
    .bind(
      id,
      project.id,
      project.id,
      input.title.trim(),
      input.body,
      input.headBranch,
      input.baseBranch,
      input.draft ? "draft" : "open",
      tips.headSha,
      tips.baseSha,
      now,
      now,
      project.id,
      input.headBranch,
    )
    .run();

  if (inserted.meta.changes === 0) {
    const existing = await findArtifactOpenPullRequest(env, project, input.headBranch);

    if (existing) throw duplicateError(existing);
    throw new TempoError("WORKSPACE_BUSY", undefined, "Pull request state changed. Try again.");
  }

  const row = await dbOf(env).select().from(pullRequests).where(eq(pullRequests.id, id)).get();

  if (!row) throw new TempoError("NOT_FOUND");

  return toWire(env, row);
};

export const updateArtifactPullRequest = async (
  env: Env,
  project: ArtifactProject,
  input: UpdateInput,
): Promise<RepositoryPullRequest> => {
  validateText(input);

  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await getArtifactPullRequest(env, project, input.number);

    if (current.state === "merged" && (input.state !== undefined || input.draft !== undefined))
      throw new TempoError(
        "PR_NOT_MERGEABLE",
        undefined,
        "Merged pull requests cannot be reopened or converted to drafts.",
      );
    const values: Partial<PullRequestRow> = { updatedAt: Date.now() };

    if (input.title !== undefined) values.title = input.title.trim();

    if (input.body !== undefined) values.body = input.body;

    if (input.state === "closed") {
      values.state = "closed";
    } else if (input.state === "open" || input.draft !== undefined) {
      if (current.state === "closed" && input.state !== "open")
        throw new TempoError(
          "VALIDATION_FAILED",
          undefined,
          "Reopen this pull request before changing its draft status.",
        );
      values.state = (input.draft ?? current.state === "draft") ? "draft" : "open";
    }

    if (current.state === "closed" && input.state === "open")
      Object.assign(values, await branchTips(env, project, current.headBranch, current.baseBranch));

    try {
      const updated = await dbOf(env)
        .update(pullRequests)
        .set(values)
        .where(
          and(
            eq(pullRequests.id, current.id),
            eq(pullRequests.projectId, project.id),
            eq(pullRequests.state, current.state),
          ),
        )
        .returning()
        .get();

      if (updated) return toWire(env, updated);
    } catch (cause) {
      const existing = await findArtifactOpenPullRequest(env, project, current.headBranch);

      if (existing && existing.id !== current.id) throw duplicateError(existing);
      throw cause;
    }
  }

  throw new TempoError("WORKSPACE_BUSY", undefined, "Pull request state changed. Try again.");
};

export const artifactPullRequestToGithub = (
  pullRequest: RepositoryPullRequest,
  _project: ArtifactProject,
): GhPull => ({
  number: pullRequest.number,
  title: pullRequest.title,
  state: pullRequest.state === "closed" || pullRequest.state === "merged" ? "closed" : "open",
  draft: pullRequest.state === "draft",
  merged: pullRequest.state === "merged",
  merged_at: pullRequest.mergedAt === null ? null : new Date(pullRequest.mergedAt).toISOString(),
  html_url: pullRequest.url,
  head: { ref: pullRequest.headBranch, sha: pullRequest.headSha ?? "", repo: null },
  base: { ref: pullRequest.baseBranch },
});

export const prepareArtifactMerge = async (
  env: Env,
  project: ArtifactProject,
  number: number,
): Promise<
  | { pullRequest: RepositoryPullRequest; mergeSha: string }
  | { pullRequest: RepositoryPullRequest; headSha: string; baseSha: string; operationId: string }
> => {
  const pullRequest = await getArtifactPullRequest(env, project, number);

  if (pullRequest.state === "merged" && pullRequest.mergeSha)
    return { pullRequest, mergeSha: pullRequest.mergeSha };

  if (pullRequest.state !== "open") throw new TempoError("PR_NOT_MERGEABLE");

  const tips = await branchTips(
    env,
    project,
    pullRequest.headBranch,
    pullRequest.baseBranch,
    pullRequest.headSha,
    true,
  );

  const updated = await dbOf(env)
    .update(pullRequests)
    .set({ ...tips, updatedAt: Date.now() })
    .where(
      and(
        eq(pullRequests.id, pullRequest.id),
        eq(pullRequests.projectId, project.id),
        eq(pullRequests.state, "open"),
      ),
    )
    .returning()
    .get();

  if (!updated) {
    const latest = await getArtifactPullRequest(env, project, number);

    if (latest.state === "merged" && latest.mergeSha)
      return { pullRequest: latest, mergeSha: latest.mergeSha };
    throw new TempoError("PR_NOT_MERGEABLE");
  }

  return { pullRequest: toWire(env, updated), ...tips, operationId: pullRequest.id };
};

export const completeArtifactMerge = async (
  env: Env,
  project: ArtifactProject,
  number: number,
  commitSha: string,
): Promise<RepositoryPullRequest> => {
  if (!SHA.test(commitSha)) throw new TempoError("PR_NOT_MERGEABLE");
  const pullRequest = await getArtifactPullRequest(env, project, number);

  if (pullRequest.state === "merged") {
    if (pullRequest.mergeSha !== commitSha) throw new TempoError("PR_NOT_MERGEABLE");

    return pullRequest;
  }

  const tips = await withArtifactRepository(env, project.name, async (repo) => {
    const info = await repo.info();

    if (info.id !== project.artifactRepoId) throw new TempoError("NOT_FOUND");
    const commit = await repo.readCommit(commitSha);

    if (!commit || commit.hash !== commitSha) throw new TempoError("ARTIFACTS_API_ERROR");
    const lines = commit.message.split("\n");
    const baseSha = lines[3]?.slice("Tempo-Base: ".length) ?? "";
    const headSha = lines[4]?.slice("Tempo-Head: ".length) ?? "";
    const method = lines[5]?.slice("Tempo-Method: ".length);

    if (!SHA.test(baseSha) || !SHA.test(headSha) || (method !== "merge" && method !== "squash"))
      throw new TempoError("PR_NOT_MERGEABLE");
    const expectedMessage = `tempo ${method} ${pullRequest.headBranch} into ${pullRequest.baseBranch}\n\nTempo-Operation: ${pullRequest.id}\nTempo-Base: ${baseSha}\nTempo-Head: ${headSha}\nTempo-Method: ${method}`;
    const parents = method === "merge" ? [baseSha, headSha] : [baseSha];

    if (commit.message !== expectedMessage || commit.parents.join(" ") !== parents.join(" "))
      throw new TempoError("PR_NOT_MERGEABLE");

    return { headSha, baseSha };
  });

  const now = Date.now();

  const updated = await dbOf(env)
    .update(pullRequests)
    .set({ ...tips, state: "merged", mergeSha: commitSha, mergedAt: now, updatedAt: now })
    .where(
      and(
        eq(pullRequests.id, pullRequest.id),
        eq(pullRequests.projectId, project.id),
        inArray(pullRequests.state, ["open", "draft", "closed"]),
      ),
    )
    .returning()
    .get();

  if (updated) return toWire(env, updated);
  const latest = await getArtifactPullRequest(env, project, number);

  if (latest.state === "merged" && latest.mergeSha === commitSha) return latest;
  throw new TempoError("PR_NOT_MERGEABLE");
};
