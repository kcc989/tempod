import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { RepositoryPullRequest, capture, newId } from "@tempo/protocol";
import { Schema } from "effect";
import {
  artifactPullRequestToGithub,
  completeArtifactMerge,
  createArtifactPullRequest,
  findArtifactOpenPullRequest,
  getArtifactPullRequest,
  listArtifactPullRequests,
  prepareArtifactMerge,
  updateArtifactPullRequest,
  type ArtifactProject,
} from "../../src/artifacts/pull-requests.ts";
import type { Env } from "../../src/env.ts";
import {
  createRepositoryPullRequest,
  getRepositoryPullRequest,
  listRepositoryPullRequests,
  updateRepositoryPullRequest,
} from "../../src/server/handlers/pull-requests.ts";
import type { HandlerCtx } from "../../src/server/run.ts";
import { seedProject } from "./fakes.ts";

const HEAD = "a".repeat(40);

const BASE = "b".repeat(40);

const MERGED = "c".repeat(40);

const NEXT = "d".repeat(40);

const setup = async () => {
  const seed = await seedProject();
  const project: ArtifactProject = { id: seed.projectId, artifactRepoId: newId(), name: "native-app" };

  const refs = new Map<string, string>([
    ["feature", HEAD],
    ["main", BASE],
  ]);

  const commits = new Map<string, { hash: string; message: string; parents: string[] }>();
  const calls: string[] = [];
  let repositoryId = project.artifactRepoId!;
  let readOnly = false;

  const metadata = (
    hash: string,
    message = "Branch tip",
    parents: string[] = [],
  ): ArtifactsCommitMetadata => ({
    hash,
    message,
    parents,
    treeHash: "e".repeat(40),
    author: { name: "Owner", email: "owner@example.com" },
    committer: { name: "Owner", email: "owner@example.com" },
    authoredAt: 1_791_867_600,
    committedAt: 1_791_867_600,
  });

  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected Artifacts operation");
  };

  const artifacts: Artifacts = {
    create: unexpected,
    import: unexpected,
    list: unexpected,
    delete: unexpected,
    get: async (name: string) => {
      calls.push(`get:${name}`);

      return {
        [Symbol.dispose]() {
          calls.push("dispose");
        },
        info: async () => {
          calls.push("info");

          return {
            id: repositoryId,
            name,
            readOnly,
            description: null,
            defaultBranch: "main",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastPushAt: new Date().toISOString(),
            source: null,
            remote: `https://${"a".repeat(32)}.artifacts.cloudflare.net/git/tempo-repos/native-app.git`,
          };
        },
        log: async ({ ref = "HEAD", limit = 50 } = {}) => {
          calls.push(`log:${ref}:${limit}`);
          const hash = refs.get(ref);

          return hash ? [metadata(hash)] : [];
        },
        readCommit: async (hash: string) => {
          const commit = commits.get(hash);

          return commit ? metadata(commit.hash, commit.message, commit.parents) : null;
        },
        createToken: unexpected,
        listTokens: unexpected,
        revokeToken: unexpected,
        readTree: unexpected,
        readBlob: unexpected,
        readFile: unexpected,
        fork: unexpected,
      };
    },
  };

  const nativeEnv: Env = { ...env, ARTIFACTS: artifacts };
  await env.DB.prepare(`
    UPDATE projects SET provider = 'artifacts', installation_id = NULL, repo_id = NULL,
      artifact_repo_id = ?, clone_url = ?, repo_owner = 'tempo', repo_name = ? WHERE id = ?
  `)
    .bind(
      project.artifactRepoId,
      `https://${"a".repeat(32)}.artifacts.cloudflare.net/git/tempo-repos/native-app.git`,
      project.name,
      project.id,
    )
    .run();

  const ctx: HandlerCtx = {
    env: nativeEnv,
    user: { id: seed.userId, name: "Owner", email: "owner@example.com", image: null },
  };

  const createInput = {
    title: "Native change",
    body: "Review this change.",
    headBranch: "feature",
    baseBranch: "main",
    draft: false,
  };

  return {
    env: nativeEnv,
    ctx,
    project,
    refs,
    commits,
    calls,
    createInput,
    replaceRepository: () => {
      repositoryId = newId();
    },
    makeReadOnly: () => {
      readOnly = true;
    },
  };
};

describe("Tempo native pull requests (08, Git Forge)", () => {
  it("creates durable metadata from exact branch tips and exposes an owner-only Tempo URL", async () => {
    const s = await setup();

    const pr = await createArtifactPullRequest(s.env, s.project, {
      ...s.createInput,
      title: "  Native change  ",
    });

    expect(Schema.decodeUnknownExit(RepositoryPullRequest)(pr)._tag).toBe("Success");
    expect(pr).toMatchObject({
      projectId: s.project.id,
      number: 1,
      title: "Native change",
      state: "open",
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: null,
      mergedAt: null,
    });
    expect(pr.url).toBe(`https://tempo.test/repositories?project=${s.project.id}&tab=pulls&pull=1`);
    expect(await getArtifactPullRequest(s.env, s.project, 1)).toEqual(pr);
    expect(await findArtifactOpenPullRequest(s.env, s.project, "feature")).toEqual(pr);
    expect(s.calls).toEqual(["get:native-app", "info", "log:feature:1", "log:main:1", "dispose"]);
    expect(artifactPullRequestToGithub(pr, s.project)).toMatchObject({
      state: "open",
      merged: false,
      draft: false,
      head: { ref: "feature", sha: HEAD },
      base: { ref: "main" },
      html_url: pr.url,
    });
  });

  it("allocates distinct sequential numbers atomically for concurrent head branches", async () => {
    const s = await setup();
    const count = 12;

    for (let i = 0; i < count; i++) s.refs.set(`feature-${i}`, HEAD);

    const requests = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        createArtifactPullRequest(s.env, s.project, { ...s.createInput, headBranch: `feature-${i}` }),
      ),
    );

    expect(requests.map((pr) => pr.number).sort((a, b) => a - b)).toEqual(
      Array.from({ length: count }, (_, i) => i + 1),
    );
    expect(new Set(requests.map((pr) => pr.id)).size).toBe(count);
    expect(await listArtifactPullRequests(s.env, s.project, "all")).toHaveLength(count);
  });

  it("recovers duplicate concurrent creation as PR_EXISTS without allocating extra numbers", async () => {
    const s = await setup();

    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, () => createArtifactPullRequest(s.env, s.project, s.createInput)),
    );

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);

    for (const outcome of outcomes) {
      if (outcome.status === "rejected") expect(outcome.reason).toMatchObject({ code: "PR_EXISTS" });
    }

    await expect(createArtifactPullRequest(s.env, s.project, s.createInput)).rejects.toMatchObject({
      code: "PR_EXISTS",
    });
    s.refs.set("next-feature", HEAD);
    expect(
      (await createArtifactPullRequest(s.env, s.project, { ...s.createInput, headBranch: "next-feature" }))
        .number,
    ).toBe(2);
  });

  it("rejects malformed refs, invalid numbers and excessive text before remote work", async () => {
    const s = await setup();

    for (const headBranch of [
      "-feature",
      "HEAD",
      "x..y",
      "feature\n",
      "feature:main",
      "a/.hidden",
      "a.lock/b",
      "@",
      "a".repeat(251),
    ]) {
      await expect(
        createArtifactPullRequest(s.env, s.project, { ...s.createInput, headBranch }),
      ).rejects.toMatchObject({ code: "BRANCH_INVALID" });
    }

    for (const number of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(getArtifactPullRequest(s.env, s.project, number)).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
    }

    for (const title of [" ", "a".repeat(257)]) {
      await expect(
        createArtifactPullRequest(s.env, s.project, { ...s.createInput, title }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }

    await expect(
      createArtifactPullRequest(s.env, s.project, { ...s.createInput, body: "a".repeat(65_537) }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(s.calls).toEqual([]);
  });

  it("requires distinct existing branches and the original linked repository identity", async () => {
    const s = await setup();
    await expect(
      createArtifactPullRequest(s.env, s.project, { ...s.createInput, headBranch: "main" }),
    ).rejects.toMatchObject({ code: "PR_NOT_MERGEABLE" });
    await expect(
      createArtifactPullRequest(s.env, s.project, { ...s.createInput, headBranch: "missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    s.replaceRepository();
    await expect(createArtifactPullRequest(s.env, s.project, s.createInput)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await listArtifactPullRequests(s.env, s.project, "all")).toEqual([]);
  });

  it("edits, closes and reopens PRs without a container and refreshes tips on reopen", async () => {
    const s = await setup();
    const pr = await createArtifactPullRequest(s.env, s.project, { ...s.createInput, draft: true });
    expect((await listArtifactPullRequests(s.env, s.project))[0]?.state).toBe("draft");
    const calls = s.calls.length;

    const edited = await updateArtifactPullRequest(s.env, s.project, {
      number: pr.number,
      title: "Updated title",
      body: "Updated body",
      draft: false,
    });

    expect(edited).toMatchObject({ state: "open", title: "Updated title", body: "Updated body" });
    await updateArtifactPullRequest(s.env, s.project, { number: pr.number, state: "closed" });
    expect(s.calls).toHaveLength(calls);
    expect(await listArtifactPullRequests(s.env, s.project)).toEqual([]);
    expect((await listArtifactPullRequests(s.env, s.project, "closed"))[0]?.state).toBe("closed");
    await expect(
      updateArtifactPullRequest(s.env, s.project, { number: pr.number, draft: true }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    s.refs.set("feature", NEXT);

    const reopened = await updateArtifactPullRequest(s.env, s.project, {
      number: pr.number,
      state: "open",
      draft: true,
    });

    expect(reopened).toMatchObject({ state: "draft", headSha: NEXT, baseSha: BASE });
    expect(s.refs.get("main")).toBe(BASE);
  });

  it("enforces active-head uniqueness when reopening and keeps project queries isolated", async () => {
    const s = await setup();
    const first = await createArtifactPullRequest(s.env, s.project, s.createInput);
    await updateArtifactPullRequest(s.env, s.project, { number: first.number, state: "closed" });
    const second = await createArtifactPullRequest(s.env, s.project, s.createInput);
    await expect(
      updateArtifactPullRequest(s.env, s.project, { number: first.number, state: "open" }),
    ).rejects.toMatchObject({ code: "PR_EXISTS" });
    expect((await getArtifactPullRequest(s.env, s.project, first.number)).state).toBe("closed");
    expect((await findArtifactOpenPullRequest(s.env, s.project, "feature"))?.number).toBe(second.number);
    const otherProject = { ...s.project, id: newId() };
    expect(await listArtifactPullRequests(s.env, otherProject, "all")).toEqual([]);
    await expect(getArtifactPullRequest(s.env, otherProject, first.number)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("prepares only open merges and marks metadata after successful Git completion with stable retries", async () => {
    const s = await setup();
    const pr = await createArtifactPullRequest(s.env, s.project, { ...s.createInput, draft: true });
    await expect(prepareArtifactMerge(s.env, s.project, pr.number)).rejects.toMatchObject({
      code: "PR_NOT_MERGEABLE",
    });
    await updateArtifactPullRequest(s.env, s.project, { number: pr.number, draft: false });
    s.refs.set("feature", NEXT);
    const prepared = await prepareArtifactMerge(s.env, s.project, pr.number);
    expect(prepared).toMatchObject({ headSha: NEXT, baseSha: BASE, operationId: pr.id });
    expect((await getArtifactPullRequest(s.env, s.project, pr.number)).state).toBe("open");
    s.refs.set("main", MERGED);
    expect(await prepareArtifactMerge(s.env, s.project, pr.number)).toMatchObject({
      headSha: NEXT,
      baseSha: MERGED,
      operationId: pr.id,
    });
    s.commits.set(MERGED, {
      hash: MERGED,
      message: `tempo squash feature into main\n\nTempo-Operation: ${pr.id}\nTempo-Base: ${BASE}\nTempo-Head: ${NEXT}\nTempo-Method: squash`,
      parents: [BASE],
    });
    const merged = await completeArtifactMerge(s.env, s.project, pr.number, MERGED);
    expect(merged).toMatchObject({ state: "merged", mergeSha: MERGED, headSha: NEXT, baseSha: BASE });
    expect(merged.mergedAt).toBeTypeOf("number");
    expect(await completeArtifactMerge(s.env, s.project, pr.number, MERGED)).toEqual(merged);
    expect(await prepareArtifactMerge(s.env, s.project, pr.number)).toEqual({
      pullRequest: merged,
      mergeSha: MERGED,
    });
    await expect(completeArtifactMerge(s.env, s.project, pr.number, NEXT)).rejects.toMatchObject({
      code: "PR_NOT_MERGEABLE",
    });
    await expect(
      updateArtifactPullRequest(s.env, s.project, { number: pr.number, state: "open" }),
    ).rejects.toMatchObject({ code: "PR_NOT_MERGEABLE" });
    expect((await listArtifactPullRequests(s.env, s.project, "closed"))[0]?.state).toBe("merged");
    expect(artifactPullRequestToGithub(merged, s.project)).toMatchObject({ state: "closed", merged: true });
  });

  it("allows lost-ack recovery after the head was deleted and rejects invalid merge markers", async () => {
    const s = await setup();
    const pr = await createArtifactPullRequest(s.env, s.project, s.createInput);
    s.refs.set("main", MERGED);
    s.refs.delete("feature");
    expect(await prepareArtifactMerge(s.env, s.project, pr.number)).toMatchObject({
      headSha: HEAD,
      baseSha: MERGED,
      operationId: pr.id,
    });
    s.commits.set(MERGED, {
      hash: MERGED,
      message: `tempo merge feature into main\n\nTempo-Operation: wrong-id\nTempo-Base: ${BASE}\nTempo-Head: ${HEAD}\nTempo-Method: merge`,
      parents: [BASE, HEAD],
    });
    await expect(completeArtifactMerge(s.env, s.project, pr.number, MERGED)).rejects.toMatchObject({
      code: "PR_NOT_MERGEABLE",
    });
    expect((await getArtifactPullRequest(s.env, s.project, pr.number)).state).toBe("open");
    s.commits.set(MERGED, {
      hash: MERGED,
      message: `tempo merge feature into main\n\nTempo-Operation: ${pr.id}\nTempo-Base: ${BASE}\nTempo-Head: ${HEAD}\nTempo-Method: merge`,
      parents: [BASE, HEAD],
    });
    expect(await completeArtifactMerge(s.env, s.project, pr.number, MERGED)).toMatchObject({
      state: "merged",
      mergeSha: MERGED,
      headSha: HEAD,
      baseSha: BASE,
    });
  });

  it("checks ownership and sanitizes metadata failures for repository PR handlers", async ({
    onTestFinished,
  }) => {
    const s = await setup();
    const stranger: HandlerCtx = { ...s.ctx, user: { ...s.ctx.user, id: newId() } };
    const input = { projectId: s.project.id, ...s.createInput };
    await expect(createRepositoryPullRequest(stranger, input)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(listRepositoryPullRequests(stranger, { projectId: s.project.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      getRepositoryPullRequest(stranger, { projectId: s.project.id, number: 1 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      updateRepositoryPullRequest(stranger, { projectId: s.project.id, number: 1, state: "closed" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(s.calls).toEqual([]);
    const pr = await createRepositoryPullRequest(s.ctx, input);
    expect(await getRepositoryPullRequest(s.ctx, { projectId: s.project.id, number: pr.number })).toEqual(pr);
    expect(await listRepositoryPullRequests(s.ctx, { projectId: s.project.id })).toEqual([pr]);
    expect(
      await updateRepositoryPullRequest(s.ctx, {
        projectId: s.project.id,
        number: pr.number,
        state: "closed",
      }),
    ).toMatchObject({ state: "closed" });

    const trigger = `reject_pr_update_${newId()}`;

    await env.DB.exec(
      `CREATE TRIGGER ${trigger} BEFORE UPDATE ON pull_requests WHEN NEW.id = '${pr.id}' BEGIN SELECT RAISE(ABORT, 'private database failure'); END`,
    );
    onTestFinished(async () => {
      await env.DB.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    });
    const privateBody = "private-pr-body-must-not-appear-in-errors";

    const failed = await capture(() =>
      updateRepositoryPullRequest(s.ctx, {
        projectId: s.project.id,
        number: pr.number,
        body: privateBody,
      }),
    );

    expect(failed).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(JSON.stringify(failed)).not.toContain(privateBody);
    expect(JSON.stringify(failed)).not.toContain("private database failure");
    expect(
      await getRepositoryPullRequest(s.ctx, { projectId: s.project.id, number: pr.number }),
    ).toMatchObject({ state: "closed", body: s.createInput.body });
  });

  it("rejects read-only PR creation and merge while permitting metadata edits", async () => {
    const s = await setup();
    const pr = await createArtifactPullRequest(s.env, s.project, s.createInput);
    s.makeReadOnly();
    s.refs.set("other-feature", HEAD);
    await expect(
      createArtifactPullRequest(s.env, s.project, { ...s.createInput, headBranch: "other-feature" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(prepareArtifactMerge(s.env, s.project, pr.number)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(
      await updateArtifactPullRequest(s.env, s.project, {
        number: pr.number,
        title: "Read-only metadata",
        state: "closed",
      }),
    ).toMatchObject({ state: "closed", title: "Read-only metadata" });
  });

  it("uses the existing GitHub workflow for GitHub-linked projects", async () => {
    const s = await setup();
    const githubSeed = await seedProject();
    const ctx = { ...s.ctx, user: { ...s.ctx.user, id: githubSeed.userId } };
    await expect(listRepositoryPullRequests(ctx, { projectId: githubSeed.projectId })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(s.calls).toEqual([]);
  });
});
