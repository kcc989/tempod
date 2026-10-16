import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { Schema } from "effect";
import { describe, it } from "vitest";
import { capture, newId, unwrap, type Deployment, type ToolReq, type ToolRes } from "@tempo/protocol";
import { eq } from "drizzle-orm";
import { runs, sessions } from "../../src/db/workspace-do.ts";
import type { AppDeployDO, DeployRunner } from "../../src/do/app-deploy.ts";
import type { RepositoryCiDO } from "../../src/do/repository-ci.ts";
import type { WorkspaceDO } from "../../src/do/workspace/index.ts";
import {
  DEPLOY_ACCOUNT_KEY,
  DEPLOY_MASTER_KEY,
  deployRunnerName,
  deployTokenKey,
  type DeployJobResult,
  type DeployJobStart,
} from "../../src/deploy/types.ts";
import { decide, type EgressConfig } from "../../src/egress/rules.ts";
import type { Env } from "../../src/env.ts";
import * as deploy from "../../src/server/handlers/deploy.ts";
import type { HandlerCtx } from "../../src/server/run.ts";
import { artifactMetadata, fakeArtifactRepo, fakeArtifacts } from "./artifacts-fake.ts";
import { FakeTempod, emitEvent, installFakes, internals, seedProject, waitFor } from "./fakes.ts";
import { seedReadyWorkspace } from "./ready-fixture.ts";
import { withWorkspaceInit } from "./workspace-environment.ts";
import type { InitInput } from "../../src/do/workspace/index.ts";
import type { WorkspaceSummary } from "@tempo/protocol";

const REMOTE = `https://${"a".repeat(32)}.artifacts.cloudflare.net/git/tempo-repos/app.git`;

const ACCOUNT = "0123456789abcdef0123456789abcdef";

const sha = (c: string) => c.repeat(40);

const CONFIG = [
  "version: 1",
  "tool: alchemy",
  "root: apps/web",
  "permissions: [d1, routes]",
  "timeout_minutes: 10",
  "targets:",
  "  production:",
  "    branch: main",
  "    auto: true",
  "  preview:",
  "    stage: pr",
  "    agent: true",
].join("\n");

const GROUPS = [
  { id: "g-scripts", name: "Workers Scripts Write", scopes: ["com.cloudflare.api.account"] },
  { id: "g-settings", name: "Account Settings Read", scopes: ["com.cloudflare.api.account"] },
  { id: "g-d1", name: "D1 Write", scopes: ["com.cloudflare.api.account"] },
  { id: "g-routes", name: "Workers Routes Write", scopes: ["com.cloudflare.api.account.zone"] },
  { id: "g-dns", name: "DNS Write", scopes: ["com.cloudflare.api.account.zone"] },
  { id: "g-zone", name: "Zone Read", scopes: ["com.cloudflare.api.account.zone"] },
];

const ok = (result: Schema.Json, status = 200) =>
  new Response(JSON.stringify({ success: true, result }), { status });

const failed = (status: number) => new Response(JSON.stringify({ success: false, errors: [] }), { status });

/** A fake Cloudflare API: permission groups, token creation and deletion. */
const fakeCloudflare = () => {
  const created: Array<{ auth: string | null; body: Schema.Json }> = [];
  const deleted: string[] = [];
  const scripts = new Map<string, FakeScript>();
  const state = { created, deleted, deleteFailures: 0, groups: GROUPS, scripts, refuse: new Set<string>() };

  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (
      request.method === "GET" &&
      url.pathname === `/client/v4/accounts/${ACCOUNT}/tokens/permission_groups`
    )
      return request.headers.get("authorization") === "Bearer master" ? ok(state.groups) : failed(403);

    if (request.method === "POST" && url.pathname === `/client/v4/accounts/${ACCOUNT}/tokens`) {
      const body = Schema.decodeUnknownSync(Schema.Json)(await request.json());

      state.created.push({ auth: request.headers.get("authorization"), body });

      return ok({ id: `tok-${state.created.length}`, value: `minted-secret-${state.created.length}` });
    }

    if (request.method === "DELETE" && url.pathname.startsWith(`/client/v4/accounts/${ACCOUNT}/tokens/`)) {
      if (state.deleteFailures-- > 0) return failed(500);
      state.deleted.push(url.pathname.split("/").pop()!);

      return ok({ id: url.pathname.split("/").pop() ?? "" });
    }

    const script = url.pathname.match(
      /^\/client\/v4\/accounts\/[0-9a-f]+\/workers\/scripts\/([^/]+)\/(deployments|versions)$/,
    );

    const worker = script ? state.scripts.get(script[1]!) : undefined;

    if (script && worker && request.method === "GET")
      return script[2] === "deployments"
        ? ok({ deployments: worker.deployments })
        : ok({ items: worker.versions.map((v) => ({ id: v.id, metadata: { created_on: v.createdOn } })) });

    if (script && worker && request.method === "POST" && script[2] === "deployments") {
      if (state.refuse.has(script[1]!)) return failed(409);

      const body = Schema.decodeUnknownSync(
        Schema.Struct({
          versions: Schema.Array(Schema.Struct({ version_id: Schema.String, percentage: Schema.Number })),
        }),
      )(await request.json());

      const created = {
        id: `cfdep-${script[1]}-${worker.deployments.length + 1}`,
        created_on: new Date().toISOString(),
        versions: body.versions,
      };

      worker.deployments.unshift(created);
      worker.posts.push({ auth: request.headers.get("authorization"), versions: body.versions });

      return ok(created);
    }

    return failed(404);
  };

  return { state, api: { fetch } };
};

interface FakeScript {
  deployments: Array<{
    id: string;
    created_on: string;
    versions: ReadonlyArray<{ version_id: string; percentage: number }>;
  }>;
  versions: Array<{ id: string; createdOn: string }>;
  posts: Array<{ auth: string | null; versions: ReadonlyArray<{ version_id: string; percentage: number }> }>;
}

/** A Worker with one old version live at 100%. */
const liveScript = (name: string): FakeScript => ({
  deployments: [
    {
      id: `cfdep-${name}-0`,
      created_on: "2026-01-01T00:00:00Z",
      versions: [{ version_id: `${name}-v1`, percentage: 100 }],
    },
  ],
  versions: [{ id: `${name}-v1`, createdOn: "2026-01-01T00:00:00Z" }],
  posts: [],
});

const GRADUAL = [
  "version: 1",
  "tool: alchemy",
  "targets:",
  "  production:",
  "    branch: main",
  "    rollout: gradual",
  "    workers: [app-web, app-api]",
  '    smoke: ["https://app.example.com/health"]',
].join("\n");

const nativeProject = async () => {
  const seed = await seedProject();
  await env.DB.prepare(
    "UPDATE projects SET provider='artifacts',installation_id=NULL,repo_id=NULL,artifact_repo_id=?,clone_url=?,repo_owner='tempo' WHERE id=?",
  )
    .bind("repo-app", REMOTE, seed.projectId)
    .run();

  return seed;
};

/** A native project whose coordinator talks to fake runners, fake tips and a fake Cloudflare. */
const deploys = async (opts: { settings?: boolean } = {}) => {
  const seed = await nativeProject();
  const stub = env.APP_DEPLOY.getByName(seed.projectId);
  const starts: DeployJobStart[] = [];
  const cancels: string[] = [];

  const tips = new Map<string, string>([
    ["main", sha("1")],
    ["feature", sha("2")],
  ]);

  const cloudflare = fakeCloudflare();

  const runner: DeployRunner = {
    deployStart: async (job) => {
      starts.push(job);

      return { ok: true, value: {} };
    },
    deployCancel: async (token) => {
      cancels.push(token);
    },
    deployLog: async () => ({ ok: true, value: { text: "live tail", truncated: false } }),
  };

  await runInDurableObject(stub, (instance: AppDeployDO) => {
    instance.runners = { getByName: () => runner };
    instance.cloudflare = cloudflare.api;
    instance.headSha = async (_project, branch) => tips.get(branch) ?? null;
  });

  const creds = env.CREDENTIALS.getByName(seed.userId);

  if (opts.settings !== false) {
    await creds.putSecret(DEPLOY_MASTER_KEY, "master");
    await creds.putSecret(DEPLOY_ACCOUNT_KEY, ACCOUNT);
  }

  const ctx: HandlerCtx = {
    env,
    user: { id: seed.userId, name: "Owner", email: "owner@example.com", image: null },
  };

  const save = async (source: string) => {
    const current = await deploy.getDeployConfig(ctx, { projectId: seed.projectId });

    return deploy.updateDeployConfig(ctx, { projectId: seed.projectId, source, revision: current.revision });
  };

  const finish = (job: DeployJobStart, conclusion: DeployJobResult["conclusion"], exitCode: number | null) =>
    stub.deploymentFinished({
      deploymentId: job.deploymentId,
      token: job.token,
      conclusion,
      exitCode,
      summary: null,
    });

  const get = (deploymentId: string) =>
    deploy.getDeployment(ctx, { projectId: seed.projectId, deploymentId });

  return { ...seed, stub, starts, cancels, tips, cloudflare, creds, ctx, save, finish, get };
};

const code = async <T>(work: () => Promise<T>) => {
  const result = await capture(work);

  return result.ok ? null : { code: result.error.code, detail: result.error.detail };
};

describe("app deploy coordinator (12)", () => {
  it.concurrent("validates owner settings and configuration, and enforces start rules", async ({
    expect,
  }) => {
    const w = await deploys({ settings: false });
    const original = deploy.settingsCloudflare.fetch;

    try {
      deploy.settingsCloudflare.fetch = w.cloudflare.api.fetch;
      expect(await deploy.getDeploySettings(w.ctx)).toEqual({
        accountId: null,
        tokenSet: false,
        updatedAt: null,
      });
      expect(
        await code(() => deploy.updateDeploySettings(w.ctx, { accountId: ACCOUNT, token: "wrong" })),
      ).toMatchObject({ code: "DEPLOY_TOKEN_INVALID" });
      expect(
        await code(() => deploy.updateDeploySettings(w.ctx, { accountId: "ACME", token: "master" })),
      ).toMatchObject({ code: "VALIDATION_FAILED" });
      expect(await w.creds.getSecret(DEPLOY_MASTER_KEY)).toBeNull();
    } finally {
      deploy.settingsCloudflare.fetch = original;
    }

    expect(await code(() => w.save("version: 1\ntool: alchemy\ntargets:\n  a:\n    auto: true\n"))).toEqual({
      code: "DEPLOY_CONFIG_INVALID",
      detail: "targets.a.auto: needs branch",
    });
    expect(
      await code(() => deploy.startDeployment(w.ctx, { projectId: w.projectId, target: "preview" })),
    ).toMatchObject({
      code: "DEPLOY_NOT_CONFIGURED",
    });
    expect(await w.save(CONFIG)).toMatchObject({
      revision: 1,
      enabled: true,
      tool: "alchemy",
      root: "apps/web",
      permissions: ["workers", "d1", "routes"],
      targets: [
        { key: "production", stage: "production", branch: "main", auto: true, agent: false },
        { key: "preview", stage: "pr", branch: null, auto: false, agent: true },
      ],
    });
    expect(
      await code(() =>
        deploy.updateDeployConfig(w.ctx, { projectId: w.projectId, source: CONFIG, revision: 0 }),
      ),
    ).toMatchObject({ code: "DEPLOY_CONFIG_CHANGED" });
    expect(
      await code(() => deploy.startDeployment(w.ctx, { projectId: w.projectId, target: "production" })),
    ).toMatchObject({ code: "DEPLOY_ACCOUNT_NOT_SET" });

    await w.creds.putSecret(DEPLOY_MASTER_KEY, "master");
    await w.creds.putSecret(DEPLOY_ACCOUNT_KEY, ACCOUNT);
    expect(await deploy.getDeploySettings(w.ctx)).toMatchObject({ accountId: ACCOUNT, tokenSet: true });
    expect(
      await code(() =>
        deploy.startDeployment(w.ctx, { projectId: w.projectId, target: "production", branch: "feature" }),
      ),
    ).toEqual({ code: "VALIDATION_FAILED", detail: "Target production deploys only branch main." });
    expect(
      await code(() => deploy.startDeployment(w.ctx, { projectId: w.projectId, target: "preview" })),
    ).toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(
      await code(() => deploy.startDeployment(w.ctx, { projectId: w.projectId, target: "nope" })),
    ).toMatchObject({
      code: "NOT_FOUND",
    });
    expect(
      await code(() =>
        deploy.startDeployment(w.ctx, { projectId: w.projectId, target: "preview", branch: "gone" }),
      ),
    ).toMatchObject({ code: "NOT_FOUND" });
    expect(
      await code(async () => unwrap(await w.stub.start({ target: "production", trigger: "agent" }))),
    ).toEqual({
      code: "FORBIDDEN",
      detail: "Target production is not open to agents.",
    });
  }, 30_000);

  it.concurrent("runs one deployment at a time with a scoped minted token and revokes it at the end", async ({
    expect,
  }) => {
    const w = await deploys();
    await w.save(CONFIG);
    const first = await deploy.startDeployment(w.ctx, { projectId: w.projectId, target: "production" });

    const second = await deploy.startDeployment(w.ctx, {
      projectId: w.projectId,
      target: "preview",
      branch: "feature",
    });

    expect(first).toMatchObject({
      number: 1,
      status: "running",
      trigger: "manual",
      branch: "main",
      sha: sha("1"),
    });
    expect(second).toMatchObject({ number: 2, status: "queued", stage: "pr" });
    expect(w.starts).toHaveLength(1);
    expect(w.cloudflare.state.created[0]).toEqual({
      auth: "Bearer master",
      body: {
        name: `tempo-deploy-${w.projectId}-1`,
        expires_on: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
        policies: [
          {
            effect: "allow",
            resources: { [`com.cloudflare.api.account.${ACCOUNT}`]: "*" },
            permission_groups: [{ id: "g-scripts" }, { id: "g-settings" }, { id: "g-d1" }],
          },
          {
            effect: "allow",
            resources: {
              [`com.cloudflare.api.account.${ACCOUNT}`]: { "com.cloudflare.api.account.zone.*": "*" },
            },
            permission_groups: [{ id: "g-routes" }, { id: "g-dns" }, { id: "g-zone" }],
          },
        ],
      },
    });
    expect(await w.creds.getSecret(deployTokenKey(first.id))).toBe("minted-secret-1");

    const job = w.starts[0]!;
    expect(job).toMatchObject({
      deploymentId: first.id,
      cloneUrl: REMOTE,
      branch: "main",
      sha: sha("1"),
      timeoutMinutes: 10,
      accountId: ACCOUNT,
    });
    expect(job.command).toContain(
      `export CLOUDFLARE_ACCOUNT_ID=${ACCOUNT} CLOUDFLARE_API_TOKEN=tempo-placeholder`,
    );
    expect(job.command).toContain("cd apps/web\nif [ ! -f alchemy.run.ts ]");
    expect(job.command.endsWith("npx --no -- alchemy deploy --stage production --yes")).toBe(true);
    expect(job.command).not.toContain("minted-secret");

    await w.stub.deploymentFinished({
      deploymentId: first.id,
      token: "stale",
      conclusion: "success",
      exitCode: 0,
      summary: null,
    });
    expect(await w.get(first.id)).toMatchObject({ status: "running" });
    await w.finish(job, "success", 0);

    expect(await w.get(first.id)).toMatchObject({ status: "completed", conclusion: "success", exitCode: 0 });
    expect(await w.creds.getSecret(deployTokenKey(first.id))).toBeNull();
    expect(w.cloudflare.state.deleted).toEqual(["tok-1"]);
    expect(w.starts.map((s) => s.deploymentId)).toEqual([first.id, second.id]);
    expect(w.starts[1]!.command).toContain("--stage pr --yes");

    w.cloudflare.state.deleteFailures = 1;
    expect(
      await deploy.cancelDeployment(w.ctx, { projectId: w.projectId, deploymentId: second.id }),
    ).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
    });
    expect(w.cancels).toEqual([w.starts[1]!.token]);
    expect(await w.creds.getSecret(deployTokenKey(second.id))).toBeNull();
    expect(w.cloudflare.state.deleted).toEqual(["tok-1"]);
    await runDurableObjectAlarm(w.stub);
    expect(w.cloudflare.state.deleted).toEqual(["tok-1", "tok-2"]);

    expect(
      await code(() => deploy.redeploy(w.ctx, { projectId: w.projectId, deploymentId: second.id })),
    ).toBeNull();
    const list = await deploy.listDeployments(w.ctx, { projectId: w.projectId, target: "preview" });
    expect(list.map((d) => [d.number, d.trigger, d.branch])).toEqual([
      [3, "redeploy", "feature"],
      [2, "manual", "feature"],
    ]);
  }, 30_000);

  it.concurrent("supersedes queued deployments, times out lost runners and fails on missing groups", async ({
    expect,
  }) => {
    const w = await deploys();
    await w.save(CONFIG);
    const running = await deploy.startDeployment(w.ctx, { projectId: w.projectId, target: "production" });

    const older = await deploy.startDeployment(w.ctx, {
      projectId: w.projectId,
      target: "preview",
      branch: "feature",
    });

    const newer = await deploy.startDeployment(w.ctx, {
      projectId: w.projectId,
      target: "preview",
      branch: "main",
    });

    expect(await w.get(older.id)).toMatchObject({ status: "completed", conclusion: "cancelled" });
    expect(await w.get(newer.id)).toMatchObject({ status: "queued" });
    expect(await w.get(running.id)).toMatchObject({ status: "running" });
    expect(
      await code(() => deploy.redeploy(w.ctx, { projectId: w.projectId, deploymentId: running.id })),
    ).toMatchObject({
      code: "WORKSPACE_BUSY",
    });

    await runInDurableObject(w.stub, (_instance: AppDeployDO, state: DurableObjectState) => {
      state.storage.sql.exec(
        "UPDATE deployments SET started_at = ? WHERE id = ?",
        Date.now() - 60 * 60_000,
        running.id,
      );
    });
    await runDurableObjectAlarm(w.stub);
    expect(await w.get(running.id)).toMatchObject({
      status: "completed",
      conclusion: "timed_out",
      summary: "The deployment ran out of time.",
    });
    expect(w.cancels).toContain(w.starts[0]!.token);

    w.cloudflare.state.groups = GROUPS.filter((g) => g.name !== "Zone Read");
    await w.finish(w.starts[1]!, "failure", 1);
    const failed = await deploy.startDeployment(w.ctx, { projectId: w.projectId, target: "production" });
    expect(await w.get(failed.id)).toMatchObject({
      status: "completed",
      conclusion: "failure",
      summary: 'Cloudflare has no permission group "Zone Read".',
    });
    expect(w.starts).toHaveLength(2);

    await env.DATA.put(`deploy/${w.projectId}/${running.id}.log`, "done\n");
    expect(
      await deploy.getDeploymentLog(w.ctx, { projectId: w.projectId, deploymentId: running.id }),
    ).toEqual({
      text: "done\n",
      truncated: false,
    });
    await w.stub.destroy();
    expect(await env.DATA.get(`deploy/${w.projectId}/${running.id}.log`)).toBeNull();
    expect(unwrap(await w.stub.getConfig())).toMatchObject({ revision: 0, enabled: false });
  }, 30_000);

  it.concurrent("auto deploys after CI success or a push without CI, once per commit", async ({ expect }) => {
    const w = await deploys();
    await w.save(CONFIG);
    const ci = env.REPOSITORY_CI.getByName(w.projectId);
    const autos: Array<{ branch: string; sha: string }> = [];

    await runInDurableObject(ci, (instance: RepositoryCiDO) => {
      const real = instance.deploys;
      instance.deploys = () => ({
        autoDeploy: async (input) => {
          autos.push(input);
          await real().autoDeploy(input);
        },
      });
      instance.runners = {
        getByName: () => ({
          ciStart: async () => ({ ok: true, value: {} }),
          ciCancel: async () => undefined,
          ciLog: async () => ({ ok: true, value: { text: "", truncated: false } }),
          ciChanged: async () => undefined,
        }),
      };
    });

    await ci.ingest({ branch: "feature", sha: sha("3") });
    await ci.ingest({ branch: "main", sha: sha("4") });
    await ci.ingest({ branch: "main", sha: sha("4") });
    expect(autos).toHaveLength(3);
    const list = await deploy.listDeployments(w.ctx, { projectId: w.projectId });
    expect(list.map((d): [string, string, string] => [d.target, d.sha, d.trigger])).toEqual([
      ["production", sha("4"), "auto"],
    ]);

    await runInDurableObject(ci, async (instance: RepositoryCiDO) => {
      unwrap(await instance.updatePipeline({ source: "version: 1\njobs:\n  t:\n    run: x\n", revision: 0 }));
    });
    await ci.ingest({ branch: "main", sha: sha("5") });
    expect(autos).toHaveLength(3);

    const job = await runInDurableObject(ci, (_instance: RepositoryCiDO, state: DurableObjectState) =>
      state.storage.sql
        .exec<{ run_id: string; token: string }>("SELECT run_id, token FROM jobs WHERE status = 'running'")
        .one(),
    );

    await ci.jobFinished({
      runId: job.run_id,
      jobKey: "t",
      token: job.token,
      conclusion: "success",
      exitCode: 0,
      summary: null,
    });
    await expect.poll(() => autos.length).toBe(4);
    expect(autos[3]).toEqual({ branch: "main", sha: sha("5") });
    await expect
      .poll(async () =>
        (await deploy.listDeployments(w.ctx, { projectId: w.projectId })).map((d: Deployment) => d.sha),
      )
      .toEqual([sha("5"), sha("4")]);
  }, 30_000);
});

/** A deploy runner instance with a fake container, coordinator and repository. */
const runner = async () => {
  const seed = await seedProject();
  const deploymentId = newId();
  const stub = env.WORKSPACE.getByName(deployRunnerName(deploymentId));
  const tempod = new FakeTempod();
  tempod.on("ci.checkout", ({ sha: commit }: { sha: string }) => ({ sha: commit }));
  const { container } = await installFakes(stub, tempod);
  const results: DeployJobResult[] = [];

  const artifacts = fakeArtifacts(async () =>
    fakeArtifactRepo(artifactMetadata("app", { id: "repo-app", remote: REMOTE }), {
      async createToken(scope = "write") {
        return {
          id: newId(),
          scope,
          plaintext: `${scope}-token`,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        };
      },
    }),
  );

  await runInDurableObject(stub, (instance: WorkspaceDO) => {
    const core = internals(instance).core;
    const bindings: { env: Env } = core;
    core.deployCoordinator = () => ({
      deploymentFinished: async (result) => {
        results.push(result);
      },
    });
    bindings.env = { ...bindings.env, ARTIFACTS: artifacts };
  });

  const job: DeployJobStart = {
    projectId: seed.projectId,
    deploymentId,
    token: newId(),
    userId: seed.userId,
    repoName: "app",
    artifactRepoId: "repo-app",
    cloneUrl: REMOTE,
    branch: "main",
    sha: sha("1"),
    command: "npx --no -- cf deploy --mode production",
    timeoutMinutes: 5,
    egressAllowlist: ["pkg.example.com"],
    accountId: ACCOUNT,
  };

  return { ...seed, stub, tempod, container, results, job, deploymentId };
};

describe("deploy runner and egress (12, Execution and Egress)", () => {
  it.concurrent("runs a deployment in a deploy-mode container and stores a log without the minted token", async ({
    expect,
  }) => {
    const r = await runner();
    await env.CREDENTIALS.getByName(r.userId).putSecret(deployTokenKey(r.deploymentId), "minted-value");
    expect(await r.stub.getDeployToken()).toBeNull();
    unwrap(await r.stub.deployStart(r.job));
    await runDurableObjectAlarm(r.stub);
    await waitFor(() => r.tempod.requestsOf("script.start").length === 1, 5000, "script start");

    expect(r.container.starts[0]).toMatchObject({ enableInternet: false, labels: { purpose: "deploy" } });
    expect(Object.keys(r.container.starts[0].env).sort()).toEqual([
      "TEMPOD_PORT",
      "TEMPOD_TOKEN",
      "TEMPO_WORKSPACE_ID",
    ]);
    expect(r.tempod.hellos[0]).toMatchObject({ env: {}, workspace: { slug: "deploy", branch: "main" } });
    expect(r.tempod.requestsOf("ci.checkout")).toEqual([{ url: REMOTE, branch: "main", sha: sha("1") }]);
    expect(r.tempod.requestsOf("script.start")[0]).toMatchObject({
      scriptId: "deploy",
      command: r.job.command,
      timeoutMs: 300_000,
    });
    expect(await r.stub.getEgressConfig()).toEqual({
      owner: "tempo",
      repo: "app",
      provider: "artifacts",
      cloneUrl: REMOTE,
      policy: "allowlist",
      allowlist: ["pkg.example.com"],
      mcp: [],
      deploy: true,
    });
    expect(await r.stub.getDeployToken()).toBe("minted-value");
    expect(await r.stub.getRepositoryToken()).toBe("read-token");

    const runId = r.tempod.requestsOf("script.start")[0].runId;
    await emitEvent(r.stub, r.tempod, {
      kind: "script.output",
      runId,
      stream: "stderr",
      data: "token minted-value\n",
    });
    await emitEvent(r.stub, r.tempod, {
      kind: "script.exited",
      runId,
      exitCode: 1,
      signal: null,
      timedOut: false,
    });
    await waitFor(() => r.results.length === 1, 5000, "result");
    expect(r.results[0]).toEqual({
      deploymentId: r.deploymentId,
      token: r.job.token,
      conclusion: "failure",
      exitCode: 1,
      summary: null,
    });
    expect(await (await env.DATA.get(`deploy/${r.projectId}/${r.deploymentId}.log`))?.text()).toBe(
      "token [redacted]\n",
    );
    expect(r.container.running).toBe(false);
  });

  it("swaps the placeholder only for api.cloudflare.com and keeps the repository read-only", ({ expect }) => {
    const config: EgressConfig = {
      owner: "tempo",
      repo: "app",
      provider: "artifacts",
      cloneUrl: REMOTE,
      policy: "allowlist",
      allowlist: ["pkg.example.com"],
      mcp: [],
      deploy: true,
    };

    const at = (url: string, headers: Record<string, string> = {}, c = config) =>
      decide(new URL(url), new Headers(headers), "tempo.test", c);

    const bearer = { authorization: "Bearer tempo-placeholder" };

    expect(at("https://api.cloudflare.com/client/v4/accounts/x/workers/scripts/a", bearer)).toEqual({
      rule: 3,
      action: "forward",
      set: { name: "authorization", value: "deploy-bearer" },
    });
    expect(at("https://api.cloudflare.com/client/v4/x", { authorization: "Bearer upload-jwt" })).toEqual({
      rule: 9,
      action: "forward",
    });
    expect(
      at("https://api.cloudflare.com/client/v4/x", { ...bearer, "x-extra": "tempo-placeholder" }),
    ).toMatchObject({
      rule: 7,
      action: "block",
    });
    expect(at("http://api.cloudflare.com/client/v4/x", bearer)).toMatchObject({ action: "block" });
    expect(at("https://evil.example/x", bearer)).toMatchObject({ rule: 7, action: "block" });
    expect(at("https://store.example.workers.dev/state")).toEqual({ rule: 9, action: "forward" });
    expect(at("https://pkg.example.com/x")).toEqual({ rule: 9, action: "forward" });
    expect(at("https://other.test/x")).toMatchObject({ rule: 10, action: "block" });
    expect(at(`${REMOTE}/git-upload-pack`)).toMatchObject({ set: { value: "artifact-bearer" } });
    expect(at(`${REMOTE}/git-receive-pack`)).toMatchObject({ rule: 2, action: "block" });
    expect(
      at("https://api.cloudflare.com/client/v4/x", bearer, { ...config, deploy: false, ci: true }),
    ).toMatchObject({
      rule: 7,
    });
  });
});

const makeRun = (stub: DurableObjectStub<WorkspaceDO>, sid: string, access: "read-only" | "write") =>
  runInDurableObject(stub, (instance: WorkspaceDO) => {
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
        sessionId: sid,
        access,
        outputKind: "note",
        status: "running",
        createdAt: Date.now(),
      })
      .run();
    core.db.update(sessions).set({ runId: id }).where(eq(sessions.id, sid)).run();

    return id;
  });

describe("deploy agent tools (12, Agent tools)", { timeout: 30_000 }, () => {
  it.concurrent("deploys the workspace branch to agent targets only, and refuses read-only runs", async ({
    expect,
  }) => {
    const w = await seedReadyWorkspace({ credentials: ["claude"] });
    await env.DB.prepare(
      "UPDATE projects SET provider='artifacts', installation_id=NULL, repo_id=NULL, artifact_repo_id=?, clone_url=? WHERE id=?",
    )
      .bind("repo-app", REMOTE, w.seeded.projectId)
      .run();
    const sid = unwrap(await w.stub.createSession({ agent: "claude" })).id;
    const coordinator = env.APP_DEPLOY.getByName(w.seeded.projectId);
    const starts: DeployJobStart[] = [];
    const cloudflare = fakeCloudflare();

    const branch = await runInDurableObject(
      w.stub,
      (instance: WorkspaceDO) => internals(instance).core.ws().branch,
    );

    await runInDurableObject(coordinator, async (instance: AppDeployDO) => {
      instance.cloudflare = cloudflare.api;
      instance.headSha = async () => sha("9");
      instance.runners = {
        getByName: () => ({
          deployStart: async (job) => {
            starts.push(job);

            return { ok: true, value: {} };
          },
          deployCancel: async () => undefined,
          deployLog: async () => ({ ok: true, value: { text: "x".repeat(70 * 1024), truncated: false } }),
        }),
      };
      unwrap(await instance.updateConfig({ source: CONFIG, revision: 0 }));
    });
    const creds = env.CREDENTIALS.getByName(w.seeded.userId);
    await creds.putSecret(DEPLOY_MASTER_KEY, "master");
    await creds.putSecret(DEPLOY_ACCOUNT_KEY, ACCOUNT);

    const tool = (op: ToolReq["op"], params: Schema.Json, runId?: string): Promise<ToolRes> =>
      runInDurableObject(w.stub, () => w.tempod.tool({ op, sessionId: sid, params, runId }));

    expect(await tool("deploy_app", { target: "production" })).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    const started = await tool("deploy_app", { target: "preview" });
    expect(started).toMatchObject({
      ok: true,
      result: { trigger: "agent", branch, sha: sha("9"), status: "running" },
    });
    expect(starts).toHaveLength(1);

    const log = await tool("get_deployment_log", { deploymentId: starts[0]!.deploymentId });
    expect(log).toMatchObject({ ok: true, result: { truncated: true } });
    expect(log.ok && JSON.stringify(log.result).length).toBeLessThan(66 * 1024);
    expect(await tool("list_deployments", {})).toMatchObject({ ok: true, result: { nextOffset: null } });

    const runId = await makeRun(w.stub, sid, "read-only");
    expect(await tool("deploy_app", { target: "preview" }, runId)).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(await tool("get_deployment", { deploymentId: starts[0]!.deploymentId }, runId)).toMatchObject({
      ok: true,
    });
  });
});

describe("gradual rollout (12, Gradual rollout)", { timeout: 30_000 }, () => {
  const ready = async () => {
    const w = await deploys();
    const smoke: Array<{ url: string; override: string | null }> = [];
    const smokeStatus = { value: 200 };

    w.cloudflare.state.scripts.set("app-web", liveScript("app-web"));
    w.cloudflare.state.scripts.set("app-api", liveScript("app-api"));
    await runInDurableObject(w.stub, (instance: AppDeployDO) => {
      instance.smokeFetch = async (request) => {
        smoke.push({
          url: request.url,
          override: request.headers.get("cloudflare-workers-version-overrides"),
        });

        return new Response(null, { status: smokeStatus.value });
      };
    });
    await w.save(GRADUAL);
    const started = await deploy.startDeployment(w.ctx, { projectId: w.projectId, target: "production" });
    const job = w.starts[0]!;

    /** What `alchemy deploy` with version.traffic 0 leaves behind: new versions, no new deployment. */
    const upload = () => {
      for (const name of ["app-web", "app-api"])
        w.cloudflare.state.scripts
          .get(name)!
          .versions.unshift({ id: `${name}-v2`, createdOn: new Date().toISOString() });
    };

    const endCanary = () =>
      runInDurableObject(w.stub, (_i: AppDeployDO, state) => {
        state.storage.sql.exec("UPDATE deployments SET canary_until = 0");
      });

    return { ...w, started, job, upload, smoke, smokeStatus, endCanary };
  };

  it.concurrent("uploads at 0%, moves 10% with a smoke test, promotes to 100%, and the owner can roll back", async ({
    expect,
  }) => {
    const w = await ready();
    expect(w.job.command).toContain("export TEMPO_DEPLOY_TRAFFIC=0");
    w.upload();
    await w.finish(w.job, "success", 0);

    const canary = await w.get(w.started.id);
    expect(canary).toMatchObject({ status: "running", conclusion: null, rollout: { phase: "canary" } });
    expect(canary.rollout!.workers).toEqual([
      {
        name: "app-web",
        versionId: "app-web-v2",
        previousVersionId: "app-web-v1",
        percentage: 10,
        cloudflareDeploymentId: "cfdep-app-web-2",
      },
      {
        name: "app-api",
        versionId: "app-api-v2",
        previousVersionId: "app-api-v1",
        percentage: 10,
        cloudflareDeploymentId: "cfdep-app-api-2",
      },
    ]);
    expect(w.cloudflare.state.scripts.get("app-web")!.posts).toEqual([
      {
        auth: "Bearer minted-secret-1",
        versions: [
          { version_id: "app-web-v2", percentage: 10 },
          { version_id: "app-web-v1", percentage: 90 },
        ],
      },
    ]);
    expect(w.smoke).toEqual([{ url: "https://app.example.com/health", override: 'app-web="app-web-v2"' }]);
    expect(w.cloudflare.state.deleted).toEqual([]);

    await runDurableObjectAlarm(w.stub);
    expect((await w.get(w.started.id)).rollout!.phase).toBe("canary");
    await w.endCanary();
    await runDurableObjectAlarm(w.stub);

    const done = await w.get(w.started.id);
    expect(done).toMatchObject({
      status: "completed",
      conclusion: "success",
      exitCode: 0,
      rollout: { phase: "promoted" },
    });
    expect(done.rollout!.workers.map((x) => x.percentage)).toEqual([100, 100]);
    expect(w.cloudflare.state.scripts.get("app-api")!.posts.at(-1)!.versions).toEqual([
      { version_id: "app-api-v2", percentage: 100 },
    ]);
    expect(w.cloudflare.state.deleted).toEqual(["tok-1"]);
    expect(await w.creds.getSecret(deployTokenKey(w.started.id))).toBeNull();

    const back = await deploy.rollbackDeployment(w.ctx, {
      projectId: w.projectId,
      deploymentId: w.started.id,
    });

    expect(back.rollout).toMatchObject({ phase: "rolled_back", rolledBackAt: expect.any(Number) });
    expect(w.cloudflare.state.scripts.get("app-web")!.posts.at(-1)).toEqual({
      auth: "Bearer minted-secret-2",
      versions: [{ version_id: "app-web-v1", percentage: 100 }],
    });
    expect(w.cloudflare.state.created[1]!.body).toMatchObject({ name: `tempo-rollback-${w.projectId}-1` });
    expect(w.cloudflare.state.deleted).toEqual(["tok-1", "tok-2"]);
    expect(
      await code(() =>
        deploy.rollbackDeployment(w.ctx, { projectId: w.projectId, deploymentId: w.started.id }),
      ),
    ).toEqual({ code: "VALIDATION_FAILED", detail: "Nothing to roll back to." });

    const events = await runInDurableObject(w.stub, (_i: AppDeployDO, state) =>
      state.storage.sql
        .exec<{ type: string }>("SELECT type FROM events ORDER BY at, rowid")
        .toArray()
        .map((e) => e.type),
    );

    expect(events.filter((t) => t === "deploy.version.uploaded")).toHaveLength(2);
    expect(events.filter((t) => t === "deploy.traffic.changed")).toHaveLength(4);
    expect(events.at(-1)).toBe("deploy.rolled_back");
  });

  it.concurrent("rolls back a failed smoke test and fails a deploy that uploaded nothing", async ({
    expect,
  }) => {
    const w = await ready();
    w.smokeStatus.value = 503;
    w.upload();
    await w.finish(w.job, "success", 0);

    const failed = await w.get(w.started.id);
    expect(failed).toMatchObject({
      status: "completed",
      conclusion: "failure",
      summary: "Rolled back: smoke test https://app.example.com/health answered 503.",
      rollout: { phase: "rolled_back" },
    });
    expect(w.cloudflare.state.scripts.get("app-web")!.posts.at(-1)!.versions).toEqual([
      { version_id: "app-web-v1", percentage: 100 },
    ]);
    expect(w.cloudflare.state.deleted).toEqual(["tok-1"]);

    const second = await deploy.startDeployment(w.ctx, { projectId: w.projectId, target: "production" });
    await w.finish(w.starts[1]!, "success", 0);
    expect(await w.get(second.id)).toMatchObject({
      status: "completed",
      conclusion: "failure",
      summary: "No new version of app-web was uploaded. Pass TEMPO_DEPLOY_TRAFFIC to version.traffic.",
      rollout: null,
    });
  });

  it.concurrent("promotes everything at once when the tool deployed a Worker at 100%, and a cancel rolls back a canary", async ({
    expect,
  }) => {
    const w = await ready();
    w.upload();
    const web = w.cloudflare.state.scripts.get("app-web")!;
    web.deployments.unshift({
      id: "cfdep-app-web-migration",
      created_on: new Date().toISOString(),
      versions: [{ version_id: "app-web-v2", percentage: 100 }],
    });
    await w.finish(w.job, "success", 0);

    expect(await w.get(w.started.id)).toMatchObject({
      status: "completed",
      conclusion: "success",
      summary: "app-web deployed at 100% without a gradual rollout.",
      rollout: { phase: "full" },
    });
    expect(web.posts).toEqual([]);
    expect(w.cloudflare.state.scripts.get("app-api")!.posts.at(-1)!.versions).toEqual([
      { version_id: "app-api-v2", percentage: 100 },
    ]);

    const next = await deploy.startDeployment(w.ctx, { projectId: w.projectId, target: "production" });

    for (const name of ["app-web", "app-api"])
      w.cloudflare.state.scripts
        .get(name)!
        .versions.unshift({ id: `${name}-v3`, createdOn: new Date().toISOString() });
    await w.finish(w.starts[1]!, "success", 0);
    expect((await w.get(next.id)).rollout!.phase).toBe("canary");

    const cancelled = await deploy.cancelDeployment(w.ctx, { projectId: w.projectId, deploymentId: next.id });
    expect(cancelled).toMatchObject({
      conclusion: "cancelled",
      summary: "Rolled back: cancelled by the owner.",
      rollout: { phase: "rolled_back" },
    });
    expect(web.posts.at(-1)!.versions).toEqual([{ version_id: "app-web-v2", percentage: 100 }]);
  });

  /** POSTs one Issues webhook the way Cloudflare Notifications does. */
  const webhook = async (
    w: { projectId: string },
    body: Schema.Json,
    secret: string | null,
    environment: Env = env,
  ) => {
    const pending: Array<Promise<unknown>> = [];
    const url = new URL(`https://tempo.example.com/api/hooks/cloudflare-issues/${w.projectId}`);
    const headers = new Headers({ "content-type": "application/json" });

    if (secret !== null) headers.set("cf-webhook-auth", secret);

    const res = await deploy.handleIssuesWebhook(
      new Request(url, { method: "POST", headers, body: JSON.stringify(body) }),
      environment,
      url,
      (work) => pending.push(work),
    );

    await Promise.all(pending);

    return res!.status;
  };

  const issue = (id: string, version: string | null) => ({
    name: "TypeError in app-web",
    text: "TypeError: x is undefined at handler (src/index.ts:42:7) Authorization: Bearer abc.def",
    ts: 1792094736,
    alert_type: "workers_issue",
    alert_correlation_id: `corr-${id}`,
    data: { issue: { issue_id: id }, worker: { script_name: "app-web", version_id: version } },
  });

  it.concurrent("accepts Issues only with the secret, groups occurrences and rolls back a canary", async ({
    expect,
  }) => {
    const w = await ready();
    expect(await webhook(w, issue("i-1", null), "anything")).toBe(404);
    const { url, secret } = await deploy.rotateIssuesWebhook(w.ctx, { projectId: w.projectId });
    expect(url).toBe(`https://${env.APP_HOST}/api/hooks/cloudflare-issues/${w.projectId}`);
    expect(await deploy.getIssuesWebhook(w.ctx, { projectId: w.projectId })).toEqual({
      url,
      secretSet: true,
    });
    expect(await webhook(w, issue("i-1", null), "wrong")).toBe(404);
    expect(await webhook(w, { nope: true }, secret)).toBe(400);

    w.upload();
    await w.finish(w.job, "success", 0);
    expect((await w.get(w.started.id)).rollout!.phase).toBe("canary");
    expect(await webhook(w, issue("i-1", "app-web-v2"), secret)).toBe(204);

    expect(await w.get(w.started.id)).toMatchObject({
      conclusion: "failure",
      summary: "Rolled back: new production error: TypeError in app-web.",
      rollout: { phase: "rolled_back" },
    });

    expect(await webhook(w, issue("i-1", "app-web-v2"), secret)).toBe(204);
    const [error] = await deploy.listProductionErrors(w.ctx, { projectId: w.projectId });

    expect(error).toMatchObject({
      worker: "app-web",
      versionId: "app-web-v2",
      deploymentNumber: 1,
      occurrences: 2,
      title: "TypeError in app-web",
      fixWorkspaceId: null,
    });
    expect(error!.text).toContain("Bearer [redacted]");
    expect(error!.text).not.toContain("abc.def");
  });

  it.concurrent("starts one fix workspace per error, on its own with auto_fix, and marks it fixed after a clean deploy", async ({
    expect,
  }) => {
    const w = await ready();
    const inits: InitInput[] = [];

    const fixEnv = withWorkspaceInit(
      {
        ...env,
        ARTIFACTS: fakeArtifacts(async () =>
          fakeArtifactRepo(artifactMetadata("app", { id: "repo-app", remote: REMOTE, readOnly: false })),
        ),
      },
      async (_stub, input) => {
        inits.push(input);

        // SAFETY: startErrorFix reads only the id of the created workspace.
        return { ok: true, value: { id: input.workspaceId } as WorkspaceSummary };
      },
    );

    const ctx: HandlerCtx = { ...w.ctx, env: fixEnv };
    w.upload();
    await w.finish(w.job, "success", 0);
    await w.endCanary();
    await runDurableObjectAlarm(w.stub);
    const { secret } = await deploy.rotateIssuesWebhook(w.ctx, { projectId: w.projectId });
    expect(await webhook(w, issue("i-2", "app-web-v2"), secret)).toBe(204);
    const [error] = await deploy.listProductionErrors(w.ctx, { projectId: w.projectId });

    const { workspaceId } = await deploy.startErrorFix(ctx, { projectId: w.projectId, errorId: error!.id });
    expect(await deploy.startErrorFix(ctx, { projectId: w.projectId, errorId: error!.id })).toEqual({
      workspaceId,
    });
    expect(inits).toHaveLength(1);
    expect(inits[0]).toMatchObject({ baseBranch: "main", source: { kind: "new" } });
    expect(inits[0]!.prompt!.text).toContain("Fix this production error in app-web.\nTypeError in app-web");
    expect(inits[0]!.prompt!.text).toContain(
      `Deployment #1 (production), version app-web-v2, commits unknown..${sha("1")}.`,
    );

    await w.save(`${GRADUAL}\nauto_fix: true`);
    expect(await webhook(w, issue("i-3", null), secret, fixEnv)).toBe(204);
    expect(inits).toHaveLength(2);

    const next = await deploy.startDeployment(w.ctx, { projectId: w.projectId, target: "production" });

    for (const name of ["app-web", "app-api"])
      w.cloudflare.state.scripts
        .get(name)!
        .versions.unshift({ id: `${name}-v3`, createdOn: new Date().toISOString() });

    await w.finish(w.starts[1]!, "success", 0);
    await w.endCanary();
    await runDurableObjectAlarm(w.stub);
    expect((await w.get(next.id)).conclusion).toBe("success");

    await runInDurableObject(w.stub, (_i: AppDeployDO, state) => {
      state.storage.sql.exec("UPDATE errors SET last_seen_at = 0, fix_check_at = 600002");
    });
    await runDurableObjectAlarm(w.stub);
    const errors = await deploy.listProductionErrors(w.ctx, { projectId: w.projectId });
    expect(errors.map((e) => [e.fixWorkspaceId !== null, e.fixedAt !== null])).toEqual([
      [true, true],
      [true, true],
    ]);
  });
});
