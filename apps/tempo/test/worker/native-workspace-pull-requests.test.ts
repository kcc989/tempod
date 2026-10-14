import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Session, newId, unwrap, type TempodParams } from "@tempo/protocol";
import { Schema } from "effect";
import {
  createArtifactPullRequest,
  getArtifactPullRequest,
  type ArtifactProject,
} from "../../src/artifacts/pull-requests.ts";
import type { WorkspaceDO } from "../../src/do/workspace/index.ts";
import type { Env } from "../../src/env.ts";
import { createWorkspace } from "../../src/server/handlers/workspaces.ts";
import type { HandlerCtx } from "../../src/server/run.ts";
import { artifactCommit, artifactMetadata, fakeArtifactRepo, fakeArtifacts } from "./artifacts-fake.ts";
import { withWorkspaceInit } from "./workspace-environment.ts";
import {
  FakeTempod,
  driveToState,
  installFakes,
  internals,
  seedCredentials,
  seedProject,
  sqlRows,
  waitFor,
} from "./fakes.ts";

const BASE = "b".repeat(40);

const HEAD = "a".repeat(40);

const MERGED = "c".repeat(40);

const REMOTE = `https://${"a".repeat(32)}.artifacts.cloudflare.net/git/tempo-repos/native.git`;

const fixture = async () => {
  const seed = await seedProject();
  await seedCredentials(seed.userId);
  const project: ArtifactProject = { id: seed.projectId, artifactRepoId: newId(), name: "native" };
  await env.DB.prepare(`
    UPDATE projects SET provider = 'artifacts', installation_id = NULL, repo_id = NULL,
      artifact_repo_id = ?, clone_url = ?, repo_owner = 'tempo', repo_name = 'native' WHERE id = ?
  `)
    .bind(project.artifactRepoId, REMOTE, project.id)
    .run();
  const refs = new Map<string, string>();
  const commits = new Map<string, { hash: string; message: string; parents: string[] }>();
  let failMetadataOnce = false;
  let readOnly = false;

  const info = () =>
    artifactMetadata(project.name, { id: project.artifactRepoId!, remote: REMOTE, readOnly });

  const artifacts = fakeArtifacts(async () =>
    fakeArtifactRepo(info(), {
      info: async () => info(),
      log: async ({ ref = "HEAD" } = {}) => {
        const hash = refs.get(ref.replace(/^refs\/heads\//, ""));

        return hash ? [artifactCommit(hash)] : [];
      },
      readCommit: async (hash: string) => {
        if (failMetadataOnce) {
          failMetadataOnce = false;
          readOnly = true;
          throw Object.assign(new Error("metadata unavailable"), { code: "INTERNAL_ERROR" });
        }

        const commit = commits.get(hash);

        return commit
          ? artifactCommit(commit.hash, { message: commit.message, parents: commit.parents })
          : null;
      },
    }),
  );

  const nativeEnv: Env = { ...env, ARTIFACTS: artifacts };
  const tempod = new FakeTempod();
  tempod.on("repo.clone", (params: TempodParams<"repo.clone">) => {
    if (!refs.has(params.baseBranch)) refs.set(params.baseBranch, BASE);

    return { headSha: BASE, remoteHeadSha: null };
  });
  tempod.on("git.commitAndPush", (params: TempodParams<"git.commitAndPush">) => {
    refs.set(params.branch, HEAD);

    return { commitSha: HEAD };
  });
  tempod.on("git.merge", (params: TempodParams<"git.merge">) => {
    if (!commits.has(MERGED)) {
      commits.set(MERGED, {
        hash: MERGED,
        message: `tempo ${params.method} ${params.headBranch} into ${params.baseBranch}\n\nTempo-Operation: ${params.operationId}\nTempo-Base: ${params.baseSha}\nTempo-Head: ${params.headSha}\nTempo-Method: ${params.method}`,
        parents: params.method === "merge" ? [params.baseSha, params.headSha] : [params.baseSha],
      });
      refs.set(params.baseBranch, MERGED);
    }

    return { commitSha: MERGED };
  });
  let stub: DurableObjectStub<WorkspaceDO> | undefined;

  const ctx: HandlerCtx = {
    env: withWorkspaceInit(nativeEnv, async (target, input) => {
      stub = target;
      await installFakes(target, tempod);
      await runInDurableObject(target, (instance: WorkspaceDO) => {
        const core: { env: Env } = internals(instance).core;
        core.env = nativeEnv;
      });

      return target.init(input);
    }),
    user: { id: seed.userId, name: "Owner", email: "owner@example.com", image: null },
  };

  const workspace = await createWorkspace(ctx, {
    projectId: project.id,
    source: { kind: "new", baseBranch: "main" },
  });

  if (!stub) throw new Error("workspace was not initialized");
  await driveToState(stub, ["ready"]);
  await waitFor(
    async () =>
      (
        await sqlRows(
          stub!,
          "SELECT id FROM ops WHERE status IN ('pending','running') AND kind != 'housekeeping'",
        )
      ).length === 0,
  );

  return {
    project,
    workspace,
    stub,
    tempod,
    refs,
    commits,
    env: nativeEnv,
    loseMetadataOnce: () => {
      failMetadataOnce = true;
    },
  };
};

const pushedPullRequest = async () => {
  const f = await fixture();
  unwrap(await f.stub.commitAndPush({ message: "Add native change" }));

  const created = unwrap(
    await f.stub.createPullRequest({ title: "Native change", body: "Review native", draft: false }),
  );

  const pr = await getArtifactPullRequest(f.env, f.project, created.number);

  return { ...f, pr };
};

describe("native workspace pull request lifecycle (08, Git Forge)", () => {
  it("adopts an externally pushed PR and synchronizes its base without discarding local changes", async () => {
    const f = await fixture();
    f.refs.set(f.workspace.branch, HEAD);
    f.refs.set("dev", "d".repeat(40));

    const pr = await createArtifactPullRequest(f.env, f.project, {
      title: "External PR",
      body: "Review on dev",
      headBranch: f.workspace.branch,
      baseBranch: "dev",
      draft: false,
    });

    await runInDurableObject(f.stub, (instance) =>
      internals(instance).core.setKv("hasUnpushedCommits", true),
    );
    const helloCount = f.tempod.hellos.length;
    const adopted = unwrap(await f.stub.createPullRequest({ title: pr.title, body: pr.body, draft: false }));
    expect(adopted.number).toBe(pr.number);
    expect(unwrap(await f.stub.getWorkspace({}))).toMatchObject({
      baseBranch: "dev",
      prNumber: pr.number,
      prState: "open",
      pushed: true,
      hasUnpushedCommits: true,
    });
    expect((await sqlRows(f.stub, "SELECT last_pushed_sha FROM workspace"))[0]?.["last_pushed_sha"]).toBe(
      HEAD,
    );
    await waitFor(() => f.tempod.hellos.length > helloCount);
    expect(f.tempod.hellos.at(-1)).toMatchObject({
      workspace: { baseBranch: "dev" },
      env: { TEMPO_DEFAULT_BRANCH: "dev" },
    });
    await waitFor(
      async () =>
        (await env.DB.prepare("SELECT base_branch FROM workspaces WHERE id=?")
          .bind(f.workspace.id)
          .first("base_branch")) === "dev",
    );
    expect(f.tempod.requestsOf("git.commitAndPush")).toHaveLength(0);
    expect(
      unwrap(await f.stub.createPullRequest({ title: pr.title, body: pr.body, draft: false })).number,
    ).toBe(pr.number);
  });

  it("requires a remote head before adopting local PR metadata into an unpushed workspace", async () => {
    const f = await fixture();
    f.refs.set(f.workspace.branch, HEAD);

    const pr = await createArtifactPullRequest(f.env, f.project, {
      title: "External PR",
      body: "",
      headBranch: f.workspace.branch,
      baseBranch: "main",
      draft: false,
    });

    f.refs.delete(f.workspace.branch);
    expect(await f.stub.createPullRequest({ title: pr.title, body: "", draft: false })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(unwrap(await f.stub.getWorkspace({}))).toMatchObject({ pushed: false, prNumber: null });
  });

  it("does not widen a revert's force-push lease when adopting a branch with external commits", async () => {
    const f = await fixture();
    f.refs.set(f.workspace.branch, HEAD);
    f.refs.set("dev", "d".repeat(40));

    const pr = await createArtifactPullRequest(f.env, f.project, {
      title: "External PR",
      body: "",
      headBranch: f.workspace.branch,
      baseBranch: "dev",
      draft: false,
    });

    await runInDurableObject(f.stub, (instance) => {
      const core = internals(instance).core;
      core.updateWs({ pushed: 1, lastPushedSha: BASE, forcePushLease: 1 });
      core.setKv("hasUnpushedCommits", true);
    });
    const helloCount = f.tempod.hellos.length;
    expect(await f.stub.createPullRequest({ title: pr.title, body: "", draft: false })).toMatchObject({
      ok: false,
      error: { code: "PUSH_REJECTED" },
    });
    expect(unwrap(await f.stub.getWorkspace({}))).toMatchObject({
      baseBranch: "main",
      prNumber: null,
      pushed: true,
      hasUnpushedCommits: true,
    });
    expect((await sqlRows(f.stub, "SELECT last_pushed_sha,force_push_lease FROM workspace"))[0]).toEqual({
      last_pushed_sha: BASE,
      force_push_lease: 1,
    });
    expect(f.tempod.hellos).toHaveLength(helloCount);
  });

  it("creates a native workspace, pushes its branch, creates a PR and merges without GitHub checks", async () => {
    const f = await fixture();
    expect(f.tempod.requestsOf("repo.clone")[0]).toMatchObject({
      url: REMOTE,
      initializeEmpty: true,
      author: { name: "Owner", email: "owner@example.com" },
    });
    expect(await f.stub.createPullRequest({ title: "Native change", body: "", draft: false })).toMatchObject({
      ok: false,
      error: { code: "NOT_PUSHED" },
    });
    unwrap(await f.stub.commitAndPush({ message: "Native commit" }));

    const created = unwrap(
      await f.stub.createPullRequest({ title: "Native change", body: "Native body", draft: false }),
    );

    expect(await f.stub.refreshPullRequest({})).toMatchObject({
      ok: true,
      value: { prState: "open", checksState: null },
    });
    expect(unwrap(await f.stub.listCheckRuns({}))).toEqual([]);
    const pr = await getArtifactPullRequest(f.env, f.project, created.number);
    expect(pr).toMatchObject({ headSha: HEAD, baseSha: BASE, state: "open" });
    unwrap(await f.stub.mergePullRequest({ method: "squash" }));
    expect(f.tempod.requestsOf("git.merge")[0]).toEqual({
      headBranch: f.workspace.branch,
      baseBranch: "main",
      headSha: HEAD,
      baseSha: BASE,
      operationId: pr.id,
      method: "squash",
    });
    expect(f.refs.get("main")).toBe(MERGED);
    expect(await getArtifactPullRequest(f.env, f.project, pr.number)).toMatchObject({
      state: "merged",
      mergeSha: MERGED,
      headSha: HEAD,
      baseSha: BASE,
    });
    expect(unwrap(await f.stub.getWorkspace({}))).toMatchObject({ prState: "merged", checksState: null });
    expect((await sqlRows(f.stub, "SELECT status FROM ops WHERE kind = 'merge_pr'"))[0]?.["status"]).toBe(
      "done",
    );
  });

  it("blocks conflicting Git and archive requests and keeps queued prompts idle while a merge is in progress", async () => {
    const f = await pushedPullRequest();

    const session = Schema.decodeUnknownSync(Session)(
      unwrap(await f.stub.createSession({ agent: "claude" })),
    );

    let release!: () => void;

    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const original = f.tempod.handlers.get("git.merge")!;
    f.tempod.on("git.merge", async (params, op) => {
      await blocked;

      return original(params, op);
    });
    const merging = f.stub.mergePullRequest({ method: "merge" });
    await waitFor(() => f.tempod.requestsOf("git.merge").length === 1);
    expect(await f.stub.commitAndPush({ message: "Conflicting commit" })).toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_BUSY" },
    });
    expect(await f.stub.archiveWorkspace({})).toMatchObject({ ok: false, error: { code: "WORKSPACE_BUSY" } });
    expect(await f.stub.mergePullRequest({ method: "merge" })).toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_BUSY" },
    });

    const prompt = await f.stub.sendPrompt({
      sessionId: session.id,
      text: "After merge",
      mentions: [],
      attachmentIds: [],
      reviewCommentIds: [],
    });

    expect(prompt.ok).toBe(true);
    expect(f.tempod.requestsOf("session.prompt")).toHaveLength(0);
    release();
    unwrap(await merging);
    await waitFor(() => f.tempod.requestsOf("session.prompt").length === 1);
  });

  it("keeps PR metadata open when Git rejects a merge", async () => {
    const f = await pushedPullRequest();
    f.tempod.fail("git.merge", "PR_NOT_MERGEABLE", "The repository tips changed.");
    expect(await f.stub.mergePullRequest({ method: "squash" })).toMatchObject({
      ok: false,
      error: { code: "PR_NOT_MERGEABLE" },
    });
    expect(f.refs.get("main")).toBe(BASE);
    expect(await getArtifactPullRequest(f.env, f.project, f.pr.number)).toMatchObject({
      state: "open",
      mergeSha: null,
    });
    expect(unwrap(await f.stub.getWorkspace({}))).toMatchObject({ prState: "open" });
  });

  it("retries a pushed merge after metadata acknowledgement loss without changing the recorded input tips", async () => {
    const f = await pushedPullRequest();
    f.loseMetadataOnce();
    const merging = f.stub.mergePullRequest({ method: "squash" });
    expect(await merging).toMatchObject({ ok: false, error: { code: "ARTIFACTS_API_ERROR" } });
    expect(f.refs.get("main")).toBe(MERGED);
    expect((await getArtifactPullRequest(f.env, f.project, f.pr.number)).state).toBe("open");

    const saved = (await sqlRows(f.stub, "SELECT state_json FROM ops WHERE kind = 'merge_pr'"))[0]?.[
      "state_json"
    ];

    expect(JSON.parse(String(saved))).toMatchObject({ pushedMergeSha: MERGED });
    unwrap(await f.stub.mergePullRequest({ method: "squash" }));
    expect(f.tempod.requestsOf("git.merge")).toHaveLength(1);
    expect(await getArtifactPullRequest(f.env, f.project, f.pr.number)).toMatchObject({
      state: "merged",
      mergeSha: MERGED,
      baseSha: BASE,
      headSha: HEAD,
    });
  });
});
