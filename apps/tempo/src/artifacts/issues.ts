import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  TempoError,
  newId,
  type FnInput,
  type FnName,
  type FnOutput,
  type RepositoryIssue,
  type RepositoryIssueComment,
  type RepositoryLabel,
} from "@tempo/protocol";
import {
  issueComments,
  issueLabels,
  issues,
  repositoryLabels,
  type IssueRow,
  type ProjectRow,
  type RepositoryLabelRow,
} from "../db/d1.ts";
import type { Env } from "../env.ts";

type Input<K extends FnName> = Omit<FnInput<K>, "projectId">;

const dbOf = (env: Env) => drizzle(env.DB);

const validateNumber = (number: number): void => {
  if (!Number.isSafeInteger(number) || number < 1) throw new TempoError("VALIDATION_FAILED");
};

const validateOffset = (offset = 0): number => {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new TempoError("VALIDATION_FAILED");

  return offset;
};

const validateIssueText = (input: Pick<Input<"updateRepositoryIssue">, "title" | "body">): void => {
  if (input.title !== undefined && (!input.title.trim() || input.title.trim().length > 256))
    throw new TempoError("VALIDATION_FAILED", undefined, "Issue titles must contain 1 to 256 characters.");

  if (input.body !== undefined && input.body.length > 65_536)
    throw new TempoError(
      "VALIDATION_FAILED",
      undefined,
      "Issue bodies must contain at most 65536 characters.",
    );
};

const normalizeComment = (body: string): string => {
  const trimmed = body.trim();

  if (!trimmed || trimmed.length > 65_536)
    throw new TempoError("VALIDATION_FAILED", undefined, "Comments must contain 1 to 65536 characters.");

  return trimmed;
};

const labelToWire = (row: RepositoryLabelRow): RepositoryLabel => ({
  id: row.id,
  projectId: row.projectId,
  name: row.name,
  color: row.color,
  description: row.description,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const issueRowsToWire = async (
  env: Env,
  project: ProjectRow,
  rows: ReadonlyArray<IssueRow>,
): Promise<RepositoryIssue[]> => {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const db = dbOf(env);

  const [linked, counts] = await Promise.all([
    db
      .select({ issueId: issueLabels.issueId, label: repositoryLabels })
      .from(issueLabels)
      .innerJoin(repositoryLabels, eq(issueLabels.labelId, repositoryLabels.id))
      .where(and(inArray(issueLabels.issueId, ids), eq(repositoryLabels.projectId, project.id)))
      .orderBy(asc(repositoryLabels.nameKey))
      .all(),
    db
      .select({ issueId: issueComments.issueId, count: sql<number>`count(*)` })
      .from(issueComments)
      .where(inArray(issueComments.issueId, ids))
      .groupBy(issueComments.issueId)
      .all(),
  ]);

  const labels = new Map<string, RepositoryLabel[]>();

  for (const entry of linked) {
    const values = labels.get(entry.issueId) ?? [];
    values.push(labelToWire(entry.label));
    labels.set(entry.issueId, values);
  }

  const commentCounts = new Map(counts.map((entry) => [entry.issueId, entry.count]));

  return rows.map((row) => ({
    ...row,
    url: `https://${env.APP_HOST}/repositories?project=${encodeURIComponent(project.id)}&tab=issues&issue=${row.number}`,
    labels: labels.get(row.id) ?? [],
    commentCount: commentCounts.get(row.id) ?? 0,
  }));
};

const requireIssue = async (env: Env, project: ProjectRow, number: number): Promise<IssueRow> => {
  validateNumber(number);

  const row = await dbOf(env)
    .select()
    .from(issues)
    .where(and(eq(issues.projectId, project.id), eq(issues.number, number)))
    .get();

  if (!row) throw new TempoError("NOT_FOUND");

  return row;
};

const checkedLabels = async (
  env: Env,
  project: ProjectRow,
  labelIds: ReadonlyArray<string>,
): Promise<string[]> => {
  const ids = [...new Set(labelIds)];

  if (ids.length > 25)
    throw new TempoError("VALIDATION_FAILED", undefined, "An issue may have at most 25 labels.");

  if (ids.length === 0) return ids;

  const found = await dbOf(env)
    .select({ id: repositoryLabels.id })
    .from(repositoryLabels)
    .where(and(eq(repositoryLabels.projectId, project.id), inArray(repositoryLabels.id, ids)))
    .all();

  if (found.length !== ids.length)
    throw new TempoError("VALIDATION_FAILED", undefined, "Every label must belong to this repository.");

  return ids;
};

const labelStatements = (env: Env, issueId: string, labelIds: ReadonlyArray<string>) =>
  labelIds.map((labelId) =>
    env.DB.prepare("INSERT INTO issue_labels (issue_id, label_id) VALUES (?, ?)").bind(issueId, labelId),
  );

export const listArtifactIssues = async (
  env: Env,
  project: ProjectRow,
  { state = "open", query, labelId, offset }: Input<"listRepositoryIssues">,
): Promise<RepositoryIssue[]> => {
  const start = validateOffset(offset);

  if (labelId !== undefined) await checkedLabels(env, project, [labelId]);
  const search = query === undefined ? undefined : `%${query.replace(/[\\%_]/g, "\\$&")}%`;

  const rows = await dbOf(env)
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.projectId, project.id),
        state === "all" ? undefined : eq(issues.state, state),
        search === undefined
          ? undefined
          : sql`(${issues.title} LIKE ${search} ESCAPE '\\' OR ${issues.body} LIKE ${search} ESCAPE '\\')`,
        labelId === undefined
          ? undefined
          : sql`EXISTS (SELECT 1 FROM issue_labels WHERE issue_id = ${issues.id} AND label_id = ${labelId})`,
      ),
    )
    .orderBy(desc(issues.number))
    .limit(50)
    .offset(start)
    .all();

  return issueRowsToWire(env, project, rows);
};

export const getArtifactIssue = async (
  env: Env,
  project: ProjectRow,
  number: number,
): Promise<RepositoryIssue> => {
  const row = await requireIssue(env, project, number);

  return (await issueRowsToWire(env, project, [row]))[0]!;
};

export const createArtifactIssue = async (
  env: Env,
  project: ProjectRow,
  authorId: string,
  input: Input<"createRepositoryIssue">,
): Promise<RepositoryIssue> => {
  validateIssueText(input);
  const labels = await checkedLabels(env, project, input.labelIds ?? []);
  const id = newId();
  const now = Date.now();

  const insert = env.DB.prepare(`
    INSERT INTO issues (id, project_id, number, title, body, state, author_id, created_at, updated_at)
    SELECT ?, ?, COALESCE((SELECT MAX(number) FROM issues WHERE project_id = ?), 0) + 1,
      ?, ?, 'open', ?, ?, ?
  `).bind(id, project.id, project.id, input.title.trim(), input.body ?? "", authorId, now, now);

  await env.DB.batch([insert, ...labelStatements(env, id, labels)]);

  const row = await dbOf(env)
    .select()
    .from(issues)
    .where(and(eq(issues.id, id), eq(issues.projectId, project.id)))
    .get();

  if (!row) throw new TempoError("NOT_FOUND");

  return (await issueRowsToWire(env, project, [row]))[0]!;
};

export const updateArtifactIssue = async (
  env: Env,
  project: ProjectRow,
  input: Input<"updateRepositoryIssue">,
): Promise<RepositoryIssue> => {
  validateIssueText(input);
  const issue = await requireIssue(env, project, input.number);
  const labels = input.labelIds === undefined ? undefined : await checkedLabels(env, project, input.labelIds);
  const now = Date.now();

  const update = env.DB.prepare(`
    UPDATE issues SET title = COALESCE(?, title), body = COALESCE(?, body),
      state = COALESCE(?, state), updated_at = MAX(updated_at + 1, ?),
      closed_at = CASE WHEN ? = 'closed' THEN COALESCE(closed_at, ?)
        WHEN ? = 'open' THEN NULL ELSE closed_at END
    WHERE id = ? AND project_id = ?
  `).bind(
    input.title?.trim() ?? null,
    input.body ?? null,
    input.state ?? null,
    now,
    input.state ?? null,
    now,
    input.state ?? null,
    issue.id,
    project.id,
  );

  const statements = [update];

  if (labels !== undefined) {
    statements.push(env.DB.prepare("DELETE FROM issue_labels WHERE issue_id = ?").bind(issue.id));
    statements.push(...labelStatements(env, issue.id, labels));
  }

  await env.DB.batch(statements);

  return getArtifactIssue(env, project, input.number);
};

export const listArtifactIssueComments = async (
  env: Env,
  project: ProjectRow,
  { number, offset }: Input<"listRepositoryIssueComments">,
): Promise<RepositoryIssueComment[]> => {
  const start = validateOffset(offset);
  const issue = await requireIssue(env, project, number);

  return dbOf(env)
    .select()
    .from(issueComments)
    .where(eq(issueComments.issueId, issue.id))
    .orderBy(asc(issueComments.createdAt), asc(issueComments.id))
    .limit(50)
    .offset(start)
    .all();
};

// The previous comment write and this touch share a batch; a missing comment must not change activity.
const touchIssue = (env: Env, project: ProjectRow, issueId: string, now: number) =>
  env.DB.prepare(
    "UPDATE issues SET updated_at = MAX(updated_at + 1, ?) WHERE id = ? AND project_id = ? AND changes() = 1",
  ).bind(now, issueId, project.id);

const requireComment = async (
  env: Env,
  issueId: string,
  commentId: string,
): Promise<RepositoryIssueComment> => {
  const comment = await dbOf(env)
    .select()
    .from(issueComments)
    .where(and(eq(issueComments.id, commentId), eq(issueComments.issueId, issueId)))
    .get();

  if (!comment) throw new TempoError("NOT_FOUND");

  return comment;
};

export const createArtifactIssueComment = async (
  env: Env,
  project: ProjectRow,
  authorId: string,
  { number, body }: Input<"createRepositoryIssueComment">,
): Promise<RepositoryIssueComment> => {
  const commentBody = normalizeComment(body);
  const issue = await requireIssue(env, project, number);
  const id = newId();
  const now = Date.now();

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO issue_comments (id, issue_id, author_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, issue.id, authorId, commentBody, now, now),
    touchIssue(env, project, issue.id, now),
  ]);

  return requireComment(env, issue.id, id);
};

export const updateArtifactIssueComment = async (
  env: Env,
  project: ProjectRow,
  { number, commentId, body }: Input<"updateRepositoryIssueComment">,
): Promise<RepositoryIssueComment> => {
  const commentBody = normalizeComment(body);
  const issue = await requireIssue(env, project, number);
  const now = Date.now();

  const result = await env.DB.batch([
    env.DB.prepare(
      "UPDATE issue_comments SET body = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ? AND issue_id = ?",
    ).bind(commentBody, now, commentId, issue.id),
    touchIssue(env, project, issue.id, now),
  ]);

  if (result[0]?.meta.changes !== 1) throw new TempoError("NOT_FOUND");

  return requireComment(env, issue.id, commentId);
};

export const deleteArtifactIssueComment = async (
  env: Env,
  project: ProjectRow,
  { number, commentId }: Input<"deleteRepositoryIssueComment">,
): Promise<FnOutput<"deleteRepositoryIssueComment">> => {
  const issue = await requireIssue(env, project, number);

  const result = await env.DB.batch([
    env.DB.prepare("DELETE FROM issue_comments WHERE id = ? AND issue_id = ?").bind(commentId, issue.id),
    touchIssue(env, project, issue.id, Date.now()),
  ]);

  if (result[0]?.meta.changes !== 1) throw new TempoError("NOT_FOUND");

  return {};
};

const validateLabelText = (
  input: Pick<Input<"updateRepositoryLabel">, "name" | "color" | "description">,
): void => {
  if (input.name !== undefined && (!input.name.trim() || input.name.trim().length > 64))
    throw new TempoError("VALIDATION_FAILED", undefined, "Label names must contain 1 to 64 characters.");

  if (input.color !== undefined && !/^[a-fA-F0-9]{6}$/.test(input.color))
    throw new TempoError("VALIDATION_FAILED", undefined, "Label colors must contain six hexadecimal digits.");

  if (input.description !== undefined && input.description.length > 256)
    throw new TempoError(
      "VALIDATION_FAILED",
      undefined,
      "Label descriptions must contain at most 256 characters.",
    );
};

const requireLabel = async (env: Env, project: ProjectRow, labelId: string): Promise<RepositoryLabelRow> => {
  const label = await dbOf(env)
    .select()
    .from(repositoryLabels)
    .where(and(eq(repositoryLabels.id, labelId), eq(repositoryLabels.projectId, project.id)))
    .get();

  if (!label) throw new TempoError("NOT_FOUND");

  return label;
};

export const listArtifactLabels = async (env: Env, project: ProjectRow): Promise<RepositoryLabel[]> => {
  const rows = await dbOf(env)
    .select()
    .from(repositoryLabels)
    .where(eq(repositoryLabels.projectId, project.id))
    .orderBy(asc(repositoryLabels.nameKey))
    .limit(100)
    .all();

  return rows.map(labelToWire);
};

export const createArtifactLabel = async (
  env: Env,
  project: ProjectRow,
  input: Input<"createRepositoryLabel">,
): Promise<RepositoryLabel> => {
  validateLabelText(input);
  const id = newId();
  const now = Date.now();
  const name = input.name.trim();

  const result = await env.DB.prepare(`
    INSERT INTO labels (id, project_id, name, name_key, color, description, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?
    WHERE (SELECT COUNT(*) FROM labels WHERE project_id = ?) < 100
      AND NOT EXISTS (SELECT 1 FROM labels WHERE project_id = ? AND name_key = ?)
  `)
    .bind(
      id,
      project.id,
      name,
      name.toLowerCase(),
      input.color.toLowerCase(),
      input.description ?? "",
      now,
      now,
      project.id,
      project.id,
      name.toLowerCase(),
    )
    .run();

  if (result.meta.changes !== 1)
    throw new TempoError(
      "VALIDATION_FAILED",
      undefined,
      "A label with this name already exists, or the repository has 100 labels.",
    );

  return labelToWire(await requireLabel(env, project, id));
};

export const updateArtifactLabel = async (
  env: Env,
  project: ProjectRow,
  input: Input<"updateRepositoryLabel">,
): Promise<RepositoryLabel> => {
  validateLabelText(input);
  const current = await requireLabel(env, project, input.labelId);
  const name = input.name?.trim();

  const existing =
    name === undefined
      ? undefined
      : await dbOf(env)
          .select({ id: repositoryLabels.id })
          .from(repositoryLabels)
          .where(
            and(
              eq(repositoryLabels.projectId, project.id),
              eq(repositoryLabels.nameKey, name.toLowerCase()),
              ne(repositoryLabels.id, current.id),
            ),
          )
          .get();

  if (existing)
    throw new TempoError("VALIDATION_FAILED", undefined, "A label with this name already exists.");

  try {
    const changed = await dbOf(env)
      .update(repositoryLabels)
      .set({
        name: sql`COALESCE(${name ?? null}, ${repositoryLabels.name})`,
        nameKey: sql`COALESCE(${name?.toLowerCase() ?? null}, ${repositoryLabels.nameKey})`,
        color: sql`COALESCE(${input.color?.toLowerCase() ?? null}, ${repositoryLabels.color})`,
        description: sql`COALESCE(${input.description ?? null}, ${repositoryLabels.description})`,
        updatedAt: sql`MAX(${repositoryLabels.updatedAt} + 1, ${Date.now()})`,
      })
      .where(and(eq(repositoryLabels.id, current.id), eq(repositoryLabels.projectId, project.id)))
      .returning()
      .get();

    if (!changed) throw new TempoError("NOT_FOUND");

    return labelToWire(changed);
  } catch (cause) {
    if (cause instanceof TempoError) throw cause;
    throw new TempoError("VALIDATION_FAILED", undefined, "The label could not be saved.");
  }
};

export const deleteArtifactLabel = async (
  env: Env,
  project: ProjectRow,
  labelId: string,
): Promise<FnOutput<"deleteRepositoryLabel">> => {
  const removed = await dbOf(env)
    .delete(repositoryLabels)
    .where(and(eq(repositoryLabels.id, labelId), eq(repositoryLabels.projectId, project.id)))
    .returning()
    .get();

  if (!removed) throw new TempoError("NOT_FOUND");

  return {};
};
