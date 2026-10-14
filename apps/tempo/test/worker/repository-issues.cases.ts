import { env } from "./test-env.ts";
import { RepositoryIssue, RepositoryIssueComment, RepositoryLabel, capture, newId } from "@tempo/protocol";
import { Schema } from "effect";
import { describe, it } from "vitest";
import {
  createRepositoryIssue,
  createRepositoryIssueComment,
  createRepositoryLabel,
  deleteRepositoryIssueComment,
  deleteRepositoryIssue,
  deleteRepositoryLabel,
  getRepositoryIssue,
  listRepositoryIssueComments,
  listRepositoryIssues,
  listRepositoryLabels,
  updateRepositoryIssue,
  updateRepositoryIssueComment,
  updateRepositoryLabel,
} from "../../src/server/handlers/issues.ts";
import type { HandlerCtx } from "../../src/server/run.ts";
import type { IssueCommentRow, IssueRow, RepositoryLabelRow } from "../../src/db/d1.ts";
import { seedProject } from "./fakes.ts";

const setup = async () => {
  const seeded = await seedProject();
  const name = `issues-${seeded.projectId}`;
  await env.DB.prepare(`
    UPDATE projects SET provider = 'artifacts', installation_id = NULL, repo_id = NULL,
      artifact_repo_id = ?, clone_url = ?, repo_owner = 'tempo', repo_name = ? WHERE id = ?
  `)
    .bind(
      newId(),
      `https://${"a".repeat(32)}.artifacts.cloudflare.net/git/tempo-repos/${name}.git`,
      name,
      seeded.projectId,
    )
    .run();

  const ctx: HandlerCtx = {
    env: { ...env, ARTIFACTS: undefined },
    user: { id: seeded.userId, name: "Owner", email: `${seeded.userId}@example.com`, image: null },
  };

  return { ctx, projectId: seeded.projectId };
};

type Fixture = Awaited<ReturnType<typeof setup>>;

const seedLabels = async (s: Fixture, count: number): Promise<RepositoryLabelRow[]> => {
  const now = Date.now();

  const rows: RepositoryLabelRow[] = Array.from({ length: count }, (_, i) => ({
    id: newId(),
    projectId: s.projectId,
    name: `label-${String(i).padStart(3, "0")}`,
    nameKey: `label-${String(i).padStart(3, "0")}`,
    color: "123456",
    description: "",
    createdAt: now,
    updatedAt: now,
  }));

  await env.DB.batch(
    rows.map((row) =>
      env.DB.prepare(
        "INSERT INTO labels (id, project_id, name, name_key, color, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        row.id,
        row.projectId,
        row.name,
        row.nameKey,
        row.color,
        row.description,
        row.createdAt,
        row.updatedAt,
      ),
    ),
  );

  return rows;
};

describe("repository issues (09, Git Forge)", () => {
  it.concurrent("guards issue deletion by ownership and rolls back counter allocation when creation fails", async ({
    expect,
    onTestFinished,
  }) => {
    const s = await setup();
    const other = await setup();

    const first = await createRepositoryIssue(s.ctx, {
      projectId: s.projectId,
      title: "Preserve until authorized",
    });

    await expect(
      deleteRepositoryIssue(other.ctx, { projectId: s.projectId, number: first.number }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(deleteRepositoryIssue(s.ctx, { projectId: s.projectId, number: 0 })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(await getRepositoryIssue(s.ctx, { projectId: s.projectId, number: first.number })).toEqual(first);
    const trigger = `reject_issue_create_${newId()}`;
    await env.DB.exec(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON issues WHEN NEW.project_id = '${s.projectId}' BEGIN SELECT RAISE(ABORT, 'private trigger body'); END`,
    );
    onTestFinished(async () => {
      await env.DB.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    });

    const rejected = await capture(() =>
      createRepositoryIssue(s.ctx, { projectId: s.projectId, title: "Rejected", body: "private issue body" }),
    );

    expect(rejected).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(JSON.stringify(rejected)).not.toContain("private");
    expect(
      await env.DB.prepare("SELECT last_number FROM issue_numbers WHERE project_id=?")
        .bind(s.projectId)
        .first("last_number"),
    ).toBe(1);
    await env.DB.exec(`DROP TRIGGER ${trigger}`);
    expect(await deleteRepositoryIssue(s.ctx, { projectId: s.projectId, number: first.number })).toEqual({});

    const created = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        createRepositoryIssue(s.ctx, { projectId: s.projectId, title: `Concurrent ${i}` }),
      ),
    );

    expect(created.map((row) => row.number).sort((a, b) => a - b)).toEqual([2, 3, 4, 5]);
  });

  it.concurrent("creates, edits, closes and reopens owner metadata without Artifacts or a container", async ({
    expect,
  }) => {
    const s = await setup();

    const label = await createRepositoryLabel(s.ctx, {
      projectId: s.projectId,
      name: "bug",
      color: "b60205",
      description: "Something is broken",
    });

    expect(Schema.decodeUnknownSync(RepositoryLabel)(label)).toEqual(label);

    const issue = await createRepositoryIssue(s.ctx, {
      projectId: s.projectId,
      title: "  Fix startup  ",
      labelIds: [label.id, label.id],
    });

    expect(Schema.decodeUnknownSync(RepositoryIssue)(issue)).toEqual(issue);
    expect(issue).toMatchObject({
      projectId: s.projectId,
      number: 1,
      title: "Fix startup",
      body: "",
      state: "open",
      authorId: s.ctx.user.id,
      closedAt: null,
      commentCount: 0,
      labels: [label],
    });
    expect(issue.url).toBe(`https://tempo.test/repositories?project=${s.projectId}&tab=issues&issue=1`);
    expect(await getRepositoryIssue(s.ctx, { projectId: s.projectId, number: issue.number })).toEqual(issue);

    const edited = await updateRepositoryIssue(s.ctx, {
      projectId: s.projectId,
      number: issue.number,
      title: "Startup failure",
      body: "Reproduce from a fresh repository.",
      labelIds: [],
    });

    expect(edited).toMatchObject({
      title: "Startup failure",
      body: "Reproduce from a fresh repository.",
      labels: [],
    });
    expect(edited.authorId).toBe(s.ctx.user.id);

    const closed = await updateRepositoryIssue(s.ctx, {
      projectId: s.projectId,
      number: issue.number,
      state: "closed",
    });

    expect(closed.state).toBe("closed");
    expect(closed.closedAt).toBeTypeOf("number");
    expect(await listRepositoryIssues(s.ctx, { projectId: s.projectId })).toEqual([]);
    expect(await listRepositoryIssues(s.ctx, { projectId: s.projectId, state: "closed" })).toEqual([closed]);

    const reopened = await updateRepositoryIssue(s.ctx, {
      projectId: s.projectId,
      number: issue.number,
      state: "open",
    });

    expect(reopened).toMatchObject({ state: "open", closedAt: null });
    expect(await listRepositoryIssues(s.ctx, { projectId: s.projectId })).toEqual([reopened]);

    const deletedRemote = async (): Promise<never> => {
      throw new Error("Artifacts repository deleted");
    };

    const artifacts: Artifacts = {
      create: deletedRemote,
      import: deletedRemote,
      list: deletedRemote,
      delete: deletedRemote,
      get: deletedRemote,
    };

    const ctx = { ...s.ctx, env: { ...s.ctx.env, ARTIFACTS: artifacts } };

    const retained = await updateRepositoryIssue(ctx, {
      projectId: s.projectId,
      number: issue.number,
      title: "After remote deletion",
    });

    expect(retained.title).toBe("After remote deletion");
    expect(await getRepositoryIssue(s.ctx, { projectId: s.projectId, number: issue.number })).toEqual(
      retained,
    );
  });

  it.concurrent("keeps comment authors, counts and issue timestamps correct across create, edit and delete", async ({
    expect,
  }) => {
    const s = await setup();
    const issue = await createRepositoryIssue(s.ctx, { projectId: s.projectId, title: "Comments" });
    const input = { projectId: s.projectId, number: issue.number };

    const comment = await createRepositoryIssueComment(s.ctx, {
      ...input,
      body: " \n First reproduction \n ",
    });

    expect(Schema.decodeUnknownSync(RepositoryIssueComment)(comment)).toEqual(comment);
    expect(comment).toMatchObject({ issueId: issue.id, authorId: s.ctx.user.id, body: "First reproduction" });
    const afterCreate = await getRepositoryIssue(s.ctx, input);
    expect(afterCreate.commentCount).toBe(1);
    expect(afterCreate.updatedAt).toBeGreaterThan(issue.updatedAt);

    const edited = await updateRepositoryIssueComment(s.ctx, {
      ...input,
      commentId: comment.id,
      body: " \n Corrected reproduction \n ",
    });

    expect(edited).toMatchObject({
      id: comment.id,
      authorId: s.ctx.user.id,
      body: "Corrected reproduction",
      createdAt: comment.createdAt,
    });
    const afterEdit = await getRepositoryIssue(s.ctx, input);
    expect(afterEdit.commentCount).toBe(1);
    expect(afterEdit.updatedAt).toBeGreaterThan(afterCreate.updatedAt);
    expect(await listRepositoryIssueComments(s.ctx, input)).toEqual([edited]);

    expect(await deleteRepositoryIssueComment(s.ctx, { ...input, commentId: comment.id })).toEqual({});
    const afterDelete = await getRepositoryIssue(s.ctx, input);
    expect(afterDelete.commentCount).toBe(0);
    expect(afterDelete.updatedAt).toBeGreaterThan(afterEdit.updatedAt);
    expect(await listRepositoryIssueComments(s.ctx, input)).toEqual([]);
    expect((await listRepositoryIssues(s.ctx, { projectId: s.projectId }))[0]?.commentCount).toBe(0);
    await expect(
      updateRepositoryIssueComment(s.ctx, { ...input, commentId: comment.id, body: "Deleted" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it.concurrent("checks ownership for every issue, comment and label handler and scopes child records to their issue", async ({
    expect,
  }) => {
    const s = await setup();
    const stranger = await setup();

    const label = await createRepositoryLabel(s.ctx, {
      projectId: s.projectId,
      name: "bug",
      color: "123456",
    });

    const issue = await createRepositoryIssue(s.ctx, {
      projectId: s.projectId,
      title: "Private",
      labelIds: [label.id],
    });

    const input = { projectId: s.projectId, number: issue.number };
    const comment = await createRepositoryIssueComment(s.ctx, { ...input, body: "Private comment" });
    const labelInput = { projectId: s.projectId, labelId: label.id };
    const commentInput = { ...input, commentId: comment.id };

    const actions = [
      () => listRepositoryIssues(stranger.ctx, { projectId: s.projectId }),
      () => getRepositoryIssue(stranger.ctx, input),
      () => createRepositoryIssue(stranger.ctx, { projectId: s.projectId, title: "Intrusion" }),
      () => updateRepositoryIssue(stranger.ctx, { ...input, title: "Intrusion" }),
      () => listRepositoryIssueComments(stranger.ctx, input),
      () => createRepositoryIssueComment(stranger.ctx, { ...input, body: "Intrusion" }),
      () => updateRepositoryIssueComment(stranger.ctx, { ...commentInput, body: "Intrusion" }),
      () => deleteRepositoryIssueComment(stranger.ctx, commentInput),
      () => listRepositoryLabels(stranger.ctx, { projectId: s.projectId }),
      () =>
        createRepositoryLabel(stranger.ctx, { projectId: s.projectId, name: "intrusion", color: "123456" }),
      () => updateRepositoryLabel(stranger.ctx, { ...labelInput, name: "Intrusion" }),
      () => deleteRepositoryLabel(stranger.ctx, labelInput),
    ];

    for (const action of actions) await expect(action()).rejects.toMatchObject({ code: "NOT_FOUND" });

    const second = await createRepositoryIssue(s.ctx, { projectId: s.projectId, title: "Another issue" });
    const otherInput = { projectId: s.projectId, number: second.number, commentId: comment.id };
    await expect(
      updateRepositoryIssueComment(s.ctx, { ...otherInput, body: "Wrong issue" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(deleteRepositoryIssueComment(s.ctx, otherInput)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await listRepositoryIssueComments(s.ctx, input)).toEqual([comment]);
    expect((await getRepositoryIssue(s.ctx, input)).title).toBe("Private");
    expect(await listRepositoryLabels(s.ctx, { projectId: s.projectId })).toEqual([label]);
    expect(await listRepositoryIssues(stranger.ctx, { projectId: stranger.projectId })).toEqual([]);
  });

  it.concurrent("allocates issue numbers atomically per project for concurrent creation", async ({
    expect,
  }) => {
    const s = await setup();
    const other = await setup();

    const issues = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        createRepositoryIssue(s.ctx, { projectId: s.projectId, title: `Concurrent ${i}` }),
      ),
    );

    expect(issues.map((issue) => issue.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(new Set(issues.map((issue) => issue.id)).size).toBe(4);
    expect((await createRepositoryIssue(s.ctx, { projectId: s.projectId, title: "Next" })).number).toBe(5);
    expect(
      (await createRepositoryIssue(other.ctx, { projectId: other.projectId, title: "Separate project" }))
        .number,
    ).toBe(1);
  });

  it.concurrent("replaces distinct labels with issue edits atomically and rejects foreign labels", async ({
    expect,
    onTestFinished,
  }) => {
    const s = await setup();
    const other = await setup();
    const labels = await seedLabels(s, 26);

    const foreign = await createRepositoryLabel(other.ctx, {
      projectId: other.projectId,
      name: "foreign",
      color: "123456",
    });

    const labelIds = labels.slice(0, 25).map((label) => label.id);

    const issue = await createRepositoryIssue(s.ctx, {
      projectId: s.projectId,
      title: "Original",
      labelIds: [...labelIds, labelIds[0]!],
    });

    const input = { projectId: s.projectId, number: issue.number };
    expect(issue.labels).toHaveLength(25);
    await expect(
      createRepositoryIssue(s.ctx, {
        projectId: s.projectId,
        title: "Too many",
        labelIds: labels.map((label) => label.id),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      updateRepositoryIssue(s.ctx, {
        ...input,
        title: "Too many",
        labelIds: labels.map((label) => label.id),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      updateRepositoryIssue(s.ctx, { ...input, title: "Foreign", labelIds: [foreign.id] }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await getRepositoryIssue(s.ctx, input)).toEqual(issue);

    const trigger = `reject_issue_labels_${newId()}`;
    await env.DB.exec(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON issue_labels WHEN NEW.issue_id = '${issue.id}' BEGIN SELECT RAISE(ABORT, 'test label failure'); END`,
    );
    onTestFinished(async () => {
      await env.DB.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    });
    const privateBody = "private-body-must-not-appear-in-errors";

    const rejected = await capture(() =>
      updateRepositoryIssue(s.ctx, {
        ...input,
        title: "Should roll back",
        body: privateBody,
        labelIds: [labels[25]!.id],
      }),
    );

    expect(rejected).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(JSON.stringify(rejected)).not.toContain(privateBody);
    expect(JSON.stringify(rejected)).not.toContain("test label failure");
    expect(await getRepositoryIssue(s.ctx, input)).toEqual(issue);
    await env.DB.exec(`DROP TRIGGER ${trigger}`);

    const updated = await updateRepositoryIssue(s.ctx, {
      ...input,
      title: "Updated",
      labelIds: [labels[25]!.id, labels[25]!.id],
    });

    expect(updated.title).toBe("Updated");
    expect(updated.labels.map((label) => label.id)).toEqual([labels[25]!.id]);
    expect(await listRepositoryIssues(s.ctx, { projectId: s.projectId, labelId: labelIds[0]! })).toEqual([]);
    expect(await listRepositoryIssues(s.ctx, { projectId: s.projectId, labelId: labels[25]!.id })).toEqual([
      updated,
    ]);
  });

  it.concurrent("normalizes label names and colors, rejects name collisions and removes deleted associations", async ({
    expect,
  }) => {
    const s = await setup();
    const other = await setup();

    const label = await createRepositoryLabel(s.ctx, {
      projectId: s.projectId,
      name: "  Bug  ",
      color: "A0b1C2",
    });

    expect(label).toMatchObject({ name: "Bug", color: "a0b1c2", description: "" });
    await expect(
      createRepositoryLabel(s.ctx, { projectId: s.projectId, name: "bUG", color: "123456" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const feature = await createRepositoryLabel(s.ctx, {
      projectId: s.projectId,
      name: "feature",
      color: "123456",
    });

    await expect(
      updateRepositoryLabel(s.ctx, { projectId: s.projectId, labelId: feature.id, name: "BUG" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await listRepositoryLabels(s.ctx, { projectId: s.projectId })).toHaveLength(2);

    const separate = await createRepositoryLabel(other.ctx, {
      projectId: other.projectId,
      name: "BUG",
      color: "123456",
    });

    await expect(
      updateRepositoryLabel(s.ctx, { projectId: s.projectId, labelId: separate.id, name: "Foreign" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      deleteRepositoryLabel(s.ctx, { projectId: s.projectId, labelId: separate.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const edited = await updateRepositoryLabel(s.ctx, {
      projectId: s.projectId,
      labelId: label.id,
      name: "Defect",
      color: "00AAff",
      description: "User-visible problem",
    });

    await Promise.all([
      updateRepositoryLabel(s.ctx, { projectId: s.projectId, labelId: edited.id, name: "Resolved" }),
      updateRepositoryLabel(s.ctx, {
        projectId: s.projectId,
        labelId: edited.id,
        description: "Concurrent description",
      }),
    ]);

    const retained = (await listRepositoryLabels(s.ctx, { projectId: s.projectId })).find(
      (entry) => entry.id === edited.id,
    );

    expect(retained).toMatchObject({
      name: "Resolved",
      description: "Concurrent description",
      color: "00aaff",
    });

    const issue = await createRepositoryIssue(s.ctx, {
      projectId: s.projectId,
      title: "Label cleanup",
      labelIds: [edited.id],
    });

    expect(issue.labels).toEqual([retained]);
    expect(await deleteRepositoryLabel(s.ctx, { projectId: s.projectId, labelId: edited.id })).toEqual({});
    expect(
      (await getRepositoryIssue(s.ctx, { projectId: s.projectId, number: issue.number })).labels,
    ).toEqual([]);
    expect(await listRepositoryLabels(s.ctx, { projectId: s.projectId })).toEqual([feature]);
    expect(await listRepositoryLabels(other.ctx, { projectId: other.projectId })).toEqual([separate]);
  });

  it.concurrent("pages issues newest-number first and comments oldest first with literal substring filtering", async ({
    expect,
  }) => {
    const s = await setup();
    const now = Date.now();

    const rows: IssueRow[] = Array.from({ length: 53 }, (_, i) => ({
      id: newId(),
      projectId: s.projectId,
      number: i + 1,
      title: `Issue ${i + 1}`,
      body: "",
      state: "open",
      authorId: s.ctx.user.id,
      createdAt: now + i,
      updatedAt: now + i,
      closedAt: null,
    }));

    rows[0]!.title = "Literal 100%_ done";
    rows[1]!.title = "Literal 100xx done";
    rows[2]!.body = "MiXeD case body";
    rows[3]!.state = "closed";
    rows[3]!.closedAt = now;
    await env.DB.batch(
      rows.map((row) =>
        env.DB.prepare(
          "INSERT INTO issues (id, project_id, number, title, body, state, author_id, created_at, updated_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(
          row.id,
          row.projectId,
          row.number,
          row.title,
          row.body,
          row.state,
          row.authorId,
          row.createdAt,
          row.updatedAt,
          row.closedAt,
        ),
      ),
    );
    const first = await listRepositoryIssues(s.ctx, { projectId: s.projectId, state: "all" });
    expect(first.map((issue) => issue.number)).toEqual(Array.from({ length: 50 }, (_, i) => 53 - i));
    expect(
      (await listRepositoryIssues(s.ctx, { projectId: s.projectId, state: "all", offset: 50 })).map(
        (issue) => issue.number,
      ),
    ).toEqual([3, 2, 1]);
    expect(await listRepositoryIssues(s.ctx, { projectId: s.projectId, offset: 100 })).toEqual([]);
    expect(
      (await listRepositoryIssues(s.ctx, { projectId: s.projectId, query: "%_" })).map(
        (issue) => issue.number,
      ),
    ).toEqual([1]);
    expect(
      (await listRepositoryIssues(s.ctx, { projectId: s.projectId, query: "mixed CASE" })).map(
        (issue) => issue.number,
      ),
    ).toEqual([3]);
    expect(
      (await listRepositoryIssues(s.ctx, { projectId: s.projectId, state: "closed" })).map(
        (issue) => issue.number,
      ),
    ).toEqual([4]);

    const issue = rows[0]!;

    const comments: IssueCommentRow[] = Array.from({ length: 53 }, (_, i) => ({
      id: newId(),
      issueId: issue.id,
      authorId: s.ctx.user.id,
      body: `Comment ${i + 1}`,
      createdAt: now + i,
      updatedAt: now + i,
    }));

    await env.DB.batch(
      comments
        .toReversed()
        .map((comment) =>
          env.DB.prepare(
            "INSERT INTO issue_comments (id, issue_id, author_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          ).bind(
            comment.id,
            comment.issueId,
            comment.authorId,
            comment.body,
            comment.createdAt,
            comment.updatedAt,
          ),
        ),
    );
    const input = { projectId: s.projectId, number: issue.number };
    expect(await listRepositoryIssueComments(s.ctx, input)).toEqual(comments.slice(0, 50));
    expect(await listRepositoryIssueComments(s.ctx, { ...input, offset: 50 })).toEqual(comments.slice(50));
    expect(await listRepositoryIssueComments(s.ctx, { ...input, offset: 100 })).toEqual([]);
    expect((await getRepositoryIssue(s.ctx, input)).commentCount).toBe(53);
    expect(
      (await listRepositoryIssues(s.ctx, { projectId: s.projectId, query: "%_" }))[0]?.commentCount,
    ).toBe(53);
  });

  it.concurrent("rejects invalid text, color and pagination while retaining existing metadata", async ({
    expect,
  }) => {
    const s = await setup();
    const issue = await createRepositoryIssue(s.ctx, { projectId: s.projectId, title: "Valid" });
    const input = { projectId: s.projectId, number: issue.number };

    for (const title of [" ", "a".repeat(257)]) {
      await expect(createRepositoryIssue(s.ctx, { projectId: s.projectId, title })).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
      await expect(updateRepositoryIssue(s.ctx, { ...input, title })).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
    }

    await expect(updateRepositoryIssue(s.ctx, { ...input, body: "a".repeat(65_537) })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    const comment = await createRepositoryIssueComment(s.ctx, { ...input, body: "Valid" });

    for (const body of [" \n ", "a".repeat(65_537)]) {
      await expect(createRepositoryIssueComment(s.ctx, { ...input, body })).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
      await expect(
        updateRepositoryIssueComment(s.ctx, { ...input, commentId: comment.id, body }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }

    for (const name of [" ", "a".repeat(65)])
      await expect(
        createRepositoryLabel(s.ctx, { projectId: s.projectId, name, color: "123456" }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    for (const color of ["#123456", "12345", "1234567", "GGGGGG"])
      await expect(
        createRepositoryLabel(s.ctx, { projectId: s.projectId, name: "invalid", color }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      createRepositoryLabel(s.ctx, {
        projectId: s.projectId,
        name: "invalid",
        color: "123456",
        description: "a".repeat(257),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    for (const offset of [-1, 0.5, Infinity]) {
      await expect(listRepositoryIssues(s.ctx, { projectId: s.projectId, offset })).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
      await expect(listRepositoryIssueComments(s.ctx, { ...input, offset })).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
    }

    for (const number of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      await expect(getRepositoryIssue(s.ctx, { projectId: s.projectId, number })).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
    expect((await getRepositoryIssue(s.ctx, input)).title).toBe("Valid");
    expect(await listRepositoryIssueComments(s.ctx, input)).toEqual([comment]);
    expect(await listRepositoryLabels(s.ctx, { projectId: s.projectId })).toEqual([]);
  });

  it.concurrent("enforces the repository label cap atomically and frees capacity when a label is deleted", async ({
    expect,
  }) => {
    const s = await setup();
    const seeded = await seedLabels(s, 99);

    const outcomes = await Promise.allSettled([
      createRepositoryLabel(s.ctx, { projectId: s.projectId, name: "Final A", color: "123456" }),
      createRepositoryLabel(s.ctx, { projectId: s.projectId, name: "Final B", color: "123456" }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toMatchObject([
      { reason: { code: "VALIDATION_FAILED" } },
    ]);
    expect(await listRepositoryLabels(s.ctx, { projectId: s.projectId })).toHaveLength(100);
    await expect(
      createRepositoryLabel(s.ctx, { projectId: s.projectId, name: "Overflow", color: "123456" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await deleteRepositoryLabel(s.ctx, { projectId: s.projectId, labelId: seeded[0]!.id });
    expect(
      (await createRepositoryLabel(s.ctx, { projectId: s.projectId, name: "Replacement", color: "123456" }))
        .name,
    ).toBe("Replacement");
    expect(await listRepositoryLabels(s.ctx, { projectId: s.projectId })).toHaveLength(100);
  });
});
