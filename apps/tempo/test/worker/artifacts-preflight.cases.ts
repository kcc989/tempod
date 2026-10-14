import { runInDurableObject } from "cloudflare:test";
import { env } from "./test-env.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newId } from "@tempo/protocol";
import type { Env } from "../../src/env.ts";
import type { WorkspaceDO } from "../../src/do/workspace/index.ts";
import { createWorkspace } from "../../src/server/handlers/workspaces.ts";
import { listBranches, listOpenPullRequests } from "../../src/server/handlers/projects.ts";
import type { HandlerCtx } from "../../src/server/run.ts";
import { driveToState, installFakes, internals, seedCredentials, seedProject } from "./fakes.ts";
import { artifactMetadata, fakeArtifactRepo, fakeArtifacts } from "./artifacts-fake.ts";
import { withWorkspaceInit } from "./workspace-environment.ts";

afterEach(() => vi.restoreAllMocks());

const REMOTE = `https://${"a".repeat(32)}.artifacts.cloudflare.net/git/tempo-repos/app.git`;

const setup = async (readOnly = false, replaced = false) => {
  const seed = await seedProject();
  const id = newId();
  const tokenScopes: string[] = [];
  await env.DB.prepare(
    "UPDATE projects SET provider='artifacts',installation_id=NULL,repo_id=NULL,artifact_repo_id=?,clone_url=?,repo_owner='tempo' WHERE id=?",
  )
    .bind(id, REMOTE, seed.projectId)
    .run();

  const binding = fakeArtifacts(async () =>
    fakeArtifactRepo(artifactMetadata("app", { id: replaced ? newId() : id, remote: REMOTE, readOnly }), {
      async createToken(scope = "write") {
        tokenScopes.push(scope);

        return {
          id: newId(),
          scope,
          plaintext: "read-repository-token",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        };
      },
    }),
  );

  const context: HandlerCtx = {
    env: { ...env, ARTIFACTS: binding },
    user: { id: seed.userId, name: "Native Owner", email: "native-owner@example.com", image: null },
  };

  return { ...seed, context, tokenScopes };
};

describe("native workspace preflight", () => {
  it("rejects read-only repositories before inserting a workspace", async () => {
    const c = await setup(true);
    await expect(
      createWorkspace(c.context, { projectId: c.projectId, source: { kind: "new", baseBranch: "main" } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "This repository is read-only." });
    expect(
      await env.DB.prepare("SELECT count(*) AS count FROM workspaces WHERE project_id=?")
        .bind(c.projectId)
        .first("count"),
    ).toBe(0);
  });

  it("rejects a repository recreated under the same name", async () => {
    const c = await setup(false, true);
    await expect(
      createWorkspace(c.context, { projectId: c.projectId, source: { kind: "new", baseBranch: "main" } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      await env.DB.prepare("SELECT count(*) AS count FROM workspaces WHERE project_id=?")
        .bind(c.projectId)
        .first("count"),
    ).toBe(0);
  });

  it("uses the owner's native commit identity without making GitHub requests", async () => {
    const c = await setup();
    await seedCredentials(c.userId);
    const inputs: Array<{ author: { name: string; email: string } }> = [];
    const nativeEnv = c.context.env;
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected outbound request"));
    c.context = {
      ...c.context,
      env: withWorkspaceInit(nativeEnv, async (stub, input) => {
        inputs.push(input);
        await installFakes(stub);
        await runInDurableObject(stub, (instance: WorkspaceDO) => {
          const core: { env: Env } = internals(instance).core;
          core.env = nativeEnv;
        });
        const result = await stub.init(input);
        await driveToState(stub, ["ready"]);

        return result;
      }),
    };
    await createWorkspace(c.context, { projectId: c.projectId, source: { kind: "new", baseBranch: "main" } });
    expect(inputs[0]?.author).toEqual({ name: "Native Owner", email: "native-owner@example.com" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lists native branches through read-only scoped transport and filters the query", async () => {
    const c = await setup();

    const packet = (line: string) =>
      (new TextEncoder().encode(line).length + 4).toString(16).padStart(4, "0") + line;

    const response =
      packet("# service=git-upload-pack\n") +
      "0000" +
      ["HEAD\0multi_ack", "refs/heads/main", "refs/heads/feature/sidebar", "refs/tags/v1"]
        .map((ref) => packet(`${"a".repeat(40)} ${ref}\n`))
        .join("") +
      "0000";

    const fetchUrl = `${REMOTE}/info/refs?service=git-upload-pack`;
    const originalFetch = globalThis.fetch;
    const transportRequests: Array<{ url: string; headers: Headers }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);

      if (url !== fetchUrl) return originalFetch(input, init);
      transportRequests.push({ url, headers: new Headers(init?.headers) });

      return new Response(response, {
        headers: { "Content-Type": "application/x-git-upload-pack-advertisement" },
      });
    });
    expect(await listBranches(c.context, { projectId: c.projectId, query: "feature" })).toEqual([
      { name: "feature/sidebar" },
    ]);
    expect(c.tokenScopes).toEqual(["read"]);
    expect(transportRequests).toHaveLength(1);
    expect(transportRequests[0]!.url).toBe(fetchUrl);
    expect(transportRequests[0]!.headers.get("authorization")).toBe("Bearer read-repository-token");
  });

  it("lists native draft PRs and enforces project ownership before transport", async () => {
    const c = await setup();
    await env.DB.prepare(
      "INSERT INTO pull_requests (id,project_id,number,title,body,head_branch,base_branch,state,created_at,updated_at) VALUES (?,?,1,'Native PR','','feature/sidebar','main','draft',1,1)",
    )
      .bind(newId(), c.projectId)
      .run();
    expect(await listOpenPullRequests(c.context, { projectId: c.projectId })).toEqual([
      { number: 1, title: "Native PR", headBranch: "feature/sidebar" },
    ]);
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected outbound request"));
    await expect(
      listBranches(
        { ...c.context, user: { ...c.context.user, id: "another-owner" } },
        { projectId: c.projectId },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
