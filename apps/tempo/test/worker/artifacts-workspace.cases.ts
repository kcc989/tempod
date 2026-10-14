import { createExecutionContext, env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newId } from "@tempo/protocol";
import type { Env } from "../../src/env.ts";
import type { WorkspaceDO } from "../../src/do/workspace/index.ts";
import { WORKSPACE_MIGRATIONS, runMigrations } from "../../src/db/do-migrations.ts";
import { TempoOutbound, type OutboundProps } from "../../src/egress/outbound.ts";
import { driveToState, internals, seedProject, seedWorkspace } from "./fakes.ts";
import { artifactMetadata, fakeArtifactRepo, fakeArtifacts } from "./artifacts-fake.ts";

const REMOTE = `https://${"a".repeat(32)}.artifacts.cloudflare.net/git/tempo-repos/app.git`;

afterEach(() => vi.restoreAllMocks());

const nativeWorkspace = async () => {
  const seed = await seedProject();
  const repositoryId = newId();
  await env.DB.prepare(
    "UPDATE projects SET provider='artifacts',installation_id=NULL,repo_id=NULL,artifact_repo_id=?,clone_url=?,repo_owner='tempo' WHERE id=?",
  )
    .bind(repositoryId, REMOTE, seed.projectId)
    .run();
  const w = await seedWorkspace(seed);

  const binding = fakeArtifacts(async () =>
    fakeArtifactRepo(artifactMetadata("app", { id: repositoryId, remote: REMOTE }), {
      async createToken(scope = "write") {
        return {
          id: newId(),
          scope,
          plaintext: "native-repository-token",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        };
      },
    }),
  );

  await runInDurableObject(w.stub, (instance: WorkspaceDO) => {
    const core: { env: Env } = internals(instance).core;
    core.env = { ...core.env, ARTIFACTS: binding };
  });
  await driveToState(w.stub, ["ready"]);

  return { ...w, ...seed, repositoryId };
};

const enableDeletion = async (w: Awaited<ReturnType<typeof nativeWorkspace>>, branch?: string) => {
  await runInDurableObject(w.stub, (instance: WorkspaceDO) => {
    const core = internals(instance).core;
    const settings = core.settings();

    const patch: Parameters<typeof core.updateWs>[0] = {
      pushed: 1,
      lastPushedSha: "a".repeat(40),
      settingsJson: JSON.stringify({ ...settings, git: { ...settings.git, delete_branch_on_archive: true } }),
    };

    if (branch !== undefined) patch.branch = branch;
    core.updateWs(patch);
  });
  w.tempod.on("git.deleteBranch", () => ({}));
};

describe("native workspace Git lifecycle", () => {
  it("clones the trusted remote, enables empty initialization and returns its own credential", async () => {
    const w = await nativeWorkspace();
    expect(w.tempod.requestsOf("repo.clone")[0]).toMatchObject({ url: REMOTE, initializeEmpty: true });
    expect(await w.stub.getGithubToken()).toBeNull();
    expect(await w.stub.getRepositoryToken()).toBe("native-repository-token");
    expect(await w.stub.getEgressConfig()).toMatchObject({ provider: "artifacts", cloneUrl: REMOTE });
  });

  it("strips caller credentials and prevents redirect forwarding of its repository token", async () => {
    const w = await nativeWorkspace();
    const requests: Request[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      requests.push(input instanceof Request ? input : new Request(input, init));

      return new Response(null, { status: 302, headers: { location: "https://evil.test/token" } });
    });

    const status = await runInDurableObject(w.stub, async (instance: WorkspaceDO) => {
      const core = internals(instance).core;

      const context: ExecutionContext<OutboundProps> = {
        ...createExecutionContext(),
        props: { workspaceId: w.workspaceId, userId: w.userId },
        waitUntil: (promise) => core.ctx.waitUntil(promise),
      };

      const outbound = new TempoOutbound(context, core.env);

      const response = await outbound.fetch(
        new Request(`${REMOTE}/git-upload-pack`, {
          method: "POST",
          headers: {
            authorization: "Basic caller-secret",
            "proxy-authorization": "caller-proxy",
            cookie: "caller-cookie",
            "x-api-key": "caller-api-key",
          },
        }),
      );

      return response.status;
    });

    expect(status).toBe(302);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.redirect).toBe("manual");
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer native-repository-token");

    for (const header of ["proxy-authorization", "cookie", "x-api-key"])
      expect(requests[0]!.headers.has(header)).toBe(false);
  });

  it("deletes the native workspace branch before shutdown and container destruction", async () => {
    const w = await nativeWorkspace();
    await enableDeletion(w);
    expect((await w.stub.archiveWorkspace({})).ok).toBe(true);
    await driveToState(w.stub, ["archived"]);
    const sequence = w.tempod.requests.map((r) => r.op);
    expect(sequence.indexOf("git.deleteBranch")).toBeGreaterThan(-1);
    expect(sequence.indexOf("git.deleteBranch")).toBeLessThan(sequence.indexOf("shutdown"));
    expect(await w.stub.getWorkspace({})).toMatchObject({
      ok: true,
      value: { pushed: false, state: "archived" },
    });
  });

  it("protects the head branch of a PR opened outside the workspace", async () => {
    const w = await nativeWorkspace();
    await enableDeletion(w);

    const branch = await runInDurableObject(
      w.stub,
      (instance: WorkspaceDO) => internals(instance).core.ws().branch,
    );

    await env.DB.prepare(
      "INSERT INTO pull_requests (id,project_id,number,title,body,head_branch,base_branch,state,created_at,updated_at) VALUES (?,?,1,'Standalone PR','',?,'main','draft',1,1)",
    )
      .bind(newId(), w.projectId, branch)
      .run();
    expect((await w.stub.archiveWorkspace({})).ok).toBe(true);
    await driveToState(w.stub, ["archived"]);
    expect(w.tempod.requestsOf("git.deleteBranch")).toHaveLength(0);
    expect(await w.stub.getWorkspace({})).toMatchObject({ ok: true, value: { pushed: true } });
  });

  it("requires waking a sleeping workspace before archiving with branch deletion", async () => {
    const w = await nativeWorkspace();
    await enableDeletion(w);
    await runInDurableObject(w.stub, async (instance: WorkspaceDO) => {
      const core = internals(instance).core;
      core.setState("stopping");
      await w.container.destroy();
      core.setState("sleeping");
    });
    expect(await w.stub.archiveWorkspace({})).toMatchObject({ ok: false, error: { code: "WORKSPACE_BUSY" } });
    expect(await w.stub.getWorkspace({})).toMatchObject({ ok: true, value: { state: "sleeping" } });
    expect(w.tempod.requestsOf("git.deleteBranch")).toHaveLength(0);
  });

  it("never deletes the repository's default/base branch", async () => {
    const w = await nativeWorkspace();
    await enableDeletion(w, "main");
    expect((await w.stub.archiveWorkspace({})).ok).toBe(true);
    await driveToState(w.stub, ["archived"]);
    expect(w.tempod.requestsOf("git.deleteBranch")).toHaveLength(0);
  });
});

describe("repository merge operation migration", () => {
  it("preserves old operation rows while adding the new operation kind", async () => {
    const stub = env.WORKSPACE.getByName(newId());
    await runInDurableObject(stub, async (instance: WorkspaceDO, state) => {
      const core = internals(instance).core;
      await state.storage.deleteAll();
      await runMigrations(core.db, WORKSPACE_MIGRATIONS.slice(0, 2));
      state.storage.sql.exec(
        "INSERT INTO ops (id,kind,step,status,attempt,next_run_at,input_json,state_json,error_code,error_detail,created_at,updated_at) VALUES ('old','commit_push','git.commitAndPush','failed',3,4,'{\"message\":\"Preserve\"}','{\"timings\":{\"git.commitAndPush\":10}}','PUSH_REJECTED','Conflict',1,2)",
      );
      const before = state.storage.sql.exec("SELECT * FROM ops").toArray();
      await runMigrations(core.db, WORKSPACE_MIGRATIONS);
      expect(state.storage.sql.exec("SELECT * FROM ops").toArray()).toEqual(before);
      state.storage.sql.exec(
        "INSERT INTO ops (id,kind,step,status,next_run_at,created_at,updated_at) VALUES ('merge','merge_pr','git.merge','done',5,5,5)",
      );
      expect(state.storage.sql.exec("SELECT kind FROM ops WHERE id='merge'").one()).toEqual({
        kind: "merge_pr",
      });
    });
  });
});
