import { Schema } from "effect";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it } from "vitest";
import {
  AgentProfile,
  IssueToolPage,
  IssueCommentToolPage,
  RepositoryIssue,
  RepositoryIssueComment,
  MAX_MESSAGE_BYTES,
  newId,
  unwrap,
  type ToolReq,
  type ToolRes,
} from "@tempo/protocol";
import { eq } from "drizzle-orm";
import { runs, sessions } from "../../src/db/workspace-do.ts";
import type { WorkspaceDO } from "../../src/do/workspace/index.ts";
import { createRepositoryLabel } from "../../src/server/handlers/issues.ts";
import { seedReadyWorkspace } from "./ready-fixture.ts";
import { internals, sqlRows } from "./fakes.ts";

const setup = async () => {
  const w = await seedReadyWorkspace({ credentials: ["claude"] });
  await env.DB.prepare(
    "UPDATE projects SET provider='artifacts', installation_id=NULL, repo_id=NULL, artifact_repo_id=?, clone_url=? WHERE id=?",
  )
    .bind(
      newId(),
      `https://${"a".repeat(32)}.artifacts.cloudflare.net/git/tempo-repos/repo.git`,
      w.seeded.projectId,
    )
    .run();
  const session = unwrap(await w.stub.createSession({ agent: "claude" }));

  return { ...w, sid: session.id };
};

type Fixture = Awaited<ReturnType<typeof setup>>;

const tool = (w: Fixture, op: ToolReq["op"], params: Schema.Json, runId?: string) =>
  runInDurableObject(w.stub, () => w.tempod.tool({ op, sessionId: w.sid, params, runId }));

const value = (reply: ToolRes): Schema.Json => {
  if (!reply.ok) throw new Error(reply.error.code);

  return reply.result;
};

const issue = async (w: Fixture, title = "Fix repository navigation") =>
  Schema.decodeUnknownSync(RepositoryIssue)(
    value(await tool(w, "create_issue", { title, body: "private issue description" })),
  );

const makeRun = async (w: Fixture, access: "read-only" | "write") =>
  runInDurableObject(w.stub, (instance: WorkspaceDO) => {
    const core = internals(instance).core;
    const id = newId();
    core.db
      .insert(runs)
      .values({
        id,
        changeId: newId(),
        handle: "checker",
        agentSha: "a".repeat(64),
        triggerEventId: newId(),
        sessionId: w.sid,
        access,
        outputKind: "note",
        status: "running",
        createdAt: Date.now(),
      })
      .run();
    core.db.update(sessions).set({ runId: id }).where(eq(sessions.id, w.sid)).run();

    return id;
  });

// Each case drives a full workspace; the CI runner needs more than the 5 s default (docs/CI.md).
describe("project-scoped agent issue tools", { timeout: 30_000 }, () => {
  it.concurrent("creates, reads, edits, comments and deletes through tool frames, preserving labels and numbering", async ({
    expect,
  }) => {
    const w = await setup();
    await runInDurableObject(w.stub, (instance: WorkspaceDO) =>
      internals(instance).core.credentials().putSecret("project.test.env.PRIVATE", "agent-test-secret"),
    );

    const first = Schema.decodeUnknownSync(RepositoryIssue)(
      value(
        await tool(w, "create_issue", {
          title: "Fix repository navigation",
          body: "Trace agent-test-secret",
        }),
      ),
    );

    expect(first.body).toBe("Trace [redacted]");
    expect(await env.DB.prepare("SELECT body FROM issues WHERE id=?").bind(first.id).first("body")).toBe(
      "Trace [redacted]",
    );
    const labels = value(await tool(w, "list_issue_labels", {}));
    expect(labels).toEqual([]);

    const label = await createRepositoryLabel(
      { env, user: { id: w.seeded.userId, name: "Owner", email: "owner@example.com", image: null } },
      { projectId: w.seeded.projectId, name: "bug", color: "ff0000" },
    );

    const edited = Schema.decodeUnknownSync(RepositoryIssue)(
      value(
        await tool(w, "update_issue", {
          number: first.number,
          title: "Updated title",
          state: "closed",
          labelIds: [label.id],
        }),
      ),
    );

    expect(edited).toMatchObject({ title: "Updated title", state: "closed", labels: [{ id: label.id }] });

    const list = Schema.decodeUnknownSync(IssueToolPage)(
      value(await tool(w, "list_issues", { state: "all" })),
    );

    expect(list.items.map((item) => item.number)).toEqual([1]);
    expect(list.nextOffset).toBeNull();
    expect(
      Schema.decodeUnknownSync(RepositoryIssue)(value(await tool(w, "get_issue", { number: 1 }))),
    ).toEqual(edited);

    const comment = Schema.decodeUnknownSync(RepositoryIssueComment)(
      value(await tool(w, "comment_on_issue", { number: 1, body: "  private reply  " })),
    );

    expect(comment).toMatchObject({ body: "private reply", authorId: w.seeded.userId });
    expect(
      Schema.decodeUnknownSync(RepositoryIssueComment)(
        value(
          await tool(w, "update_issue_comment", { number: 1, commentId: comment.id, body: "Changed reply" }),
        ),
      ).body,
    ).toBe("Changed reply");
    expect(
      Schema.decodeUnknownSync(IssueCommentToolPage)(
        value(await tool(w, "list_issue_comments", { number: 1 })),
      ).items,
    ).toHaveLength(1);
    expect(value(await tool(w, "delete_issue_comment", { number: 1, commentId: comment.id }))).toEqual({});
    await tool(w, "comment_on_issue", { number: 1, body: "Deleted with issue" });
    expect(value(await tool(w, "delete_issue", { number: 1 }))).toEqual({});
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM issue_comments WHERE issue_id=?")
        .bind(first.id)
        .first("n"),
    ).toBe(0);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM issue_labels WHERE issue_id=?")
        .bind(first.id)
        .first("n"),
    ).toBe(0);
    expect(value(await tool(w, "list_issue_labels", {}))).toMatchObject([{ id: label.id }]);
    expect(await tool(w, "get_issue", { number: 1 })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(await tool(w, "delete_issue", { number: 1 })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect((await issue(w, "Next issue")).number).toBe(2);
    expect(await sqlRows(w.stub, "SELECT * FROM events WHERE kind LIKE '%issue%'")).toEqual([]);
    expect(
      await sqlRows(
        w.stub,
        "SELECT * FROM lifecycle_events WHERE payload_json LIKE '%private issue%' OR payload_json LIKE '%private reply%'",
      ),
    ).toEqual([]);
  });

  it.concurrent("rejects foreign project/author overrides, cross-issue comments and closed sessions without changing records", async ({
    expect,
  }) => {
    const w = await setup();
    const other = await setup();
    const first = await issue(w);
    const second = await issue(w, "Another issue");
    const foreign = await issue(other);

    const comment = Schema.decodeUnknownSync(RepositoryIssueComment)(
      value(await tool(w, "comment_on_issue", { number: first.number, body: "Original" })),
    );

    expect(
      await tool(w, "create_issue", { title: "Spoof", projectId: other.seeded.projectId }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(
      await tool(w, "comment_on_issue", { number: 1, body: "Spoof", authorId: other.seeded.userId }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(
      await tool(w, "delete_issue_comment", { number: second.number, commentId: comment.id }),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(
      Schema.decodeUnknownSync(RepositoryIssue)(value(await tool(other, "get_issue", { number: 1 }))),
    ).toEqual(foreign);
    await w.stub.closeSession({ sessionId: w.sid });
    expect(await tool(w, "delete_issue", { number: first.number })).toMatchObject({
      ok: false,
      error: { code: "RUN_NOT_RUNNING" },
    });
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM issues WHERE project_id=?")
        .bind(w.seeded.projectId)
        .first("n"),
    ).toBe(2);
  });

  it.concurrent("permits write runs while restricting read-only, stale and mismatched run requests", async ({
    expect,
  }) => {
    const w = await setup();
    const first = await issue(w);
    const runId = await makeRun(w, "read-only");
    expect(
      Schema.decodeUnknownSync(RepositoryIssue)(
        value(await tool(w, "get_issue", { number: first.number }, runId)),
      ).id,
    ).toBe(first.id);
    expect(await tool(w, "create_issue", { title: "Blocked" }, runId)).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(await tool(w, "delete_issue", { number: 1 }, runId)).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(await tool(w, "comment_on_issue", { number: 1, body: "Blocked" }, runId)).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(await tool(w, "get_issue", { number: 1 }, newId())).toMatchObject({
      ok: false,
      error: { code: "RUN_NOT_RUNNING" },
    });
    expect(await tool(w, "get_issue", { number: 1 })).toMatchObject({
      ok: false,
      error: { code: "RUN_NOT_RUNNING" },
    });
    await runInDurableObject(w.stub, (instance: WorkspaceDO) =>
      internals(instance).core.db.update(runs).set({ access: "write" }).where(eq(runs.id, runId)).run(),
    );
    expect((await issueRun(w, runId)).number).toBe(2);
    await runInDurableObject(w.stub, (instance: WorkspaceDO) =>
      internals(instance).core.db.update(runs).set({ status: "completed" }).where(eq(runs.id, runId)).run(),
    );
    expect(await tool(w, "list_issues", {}, runId)).toMatchObject({
      ok: false,
      error: { code: "RUN_NOT_RUNNING" },
    });
  });

  it.concurrent("enforces frozen allow/deny patterns and bounds large comment pages with a usable next offset", async ({
    expect,
  }) => {
    const w = await setup();
    await issue(w);

    const profile = Schema.decodeUnknownSync(AgentProfile)({
      systemPrompt: "",
      toolsAllow: ["mcp__tempo__*"],
      toolsDeny: ["tempo.delete_*"],
      playwright: true,
      mcpServers: [],
      thoughtLevel: "",
    });

    await runInDurableObject(w.stub, (instance: WorkspaceDO) =>
      internals(instance)
        .core.db.update(sessions)
        .set({ profileJson: JSON.stringify(profile) })
        .where(eq(sessions.id, w.sid))
        .run(),
    );
    expect(await tool(w, "delete_issue", { number: 1 })).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });

    for (let i = 0; i < 4; i++)
      value(await tool(w, "comment_on_issue", { number: 1, body: "\u0000".repeat(65000) }));
    const reply = await tool(w, "list_issue_comments", { number: 1 });
    expect(new TextEncoder().encode(JSON.stringify(reply)).length).toBeLessThan(MAX_MESSAGE_BYTES);
    const first = Schema.decodeUnknownSync(IssueCommentToolPage)(value(reply));
    expect(first.items).toHaveLength(2);
    expect(first.nextOffset).toBe(2);

    const second = Schema.decodeUnknownSync(IssueCommentToolPage)(
      value(await tool(w, "list_issue_comments", { number: 1, offset: first.nextOffset })),
    );

    expect(second.items).toHaveLength(2);
    expect(second.nextOffset).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(4);
    await runInDurableObject(w.stub, (instance: WorkspaceDO) =>
      internals(instance)
        .core.db.update(sessions)
        .set({ profileJson: JSON.stringify({ ...profile, toolsAllow: ["get_issue"] }) })
        .where(eq(sessions.id, w.sid))
        .run(),
    );
    expect(await tool(w, "list_issues", {})).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(value(await tool(w, "get_issue", { number: 1 }))).toMatchObject({ number: 1 });
  });
});

const issueRun = async (w: Fixture, runId: string) =>
  Schema.decodeUnknownSync(RepositoryIssue)(
    value(await tool(w, "create_issue", { title: "Run issue" }, runId)),
  );
