import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "./test-env.ts";
import { describe, it } from "vitest";
import { newId, unwrap } from "@tempo/protocol";
import { ciRunnerName, type CiJobResult, type CiJobStart } from "../../src/ci/types.ts";
import type { WorkspaceDO } from "../../src/do/workspace/index.ts";
import type { Env } from "../../src/env.ts";
import { artifactMetadata, fakeArtifactRepo, fakeArtifacts } from "./artifacts-fake.ts";
import { FakeTempod, emitEvent, installFakes, internals, seedProject, waitFor } from "./fakes.ts";

const REMOTE = `https://${"a".repeat(32)}.artifacts.cloudflare.net/git/tempo-repos/app.git`;

const SHA = "1".repeat(40);

/** A CI runner instance with a fake container, a fake coordinator and a fake repository. */
const runner = async (opts: { reportFailures?: number } = {}) => {
  const seed = await seedProject();
  const runId = newId();
  const stub = env.WORKSPACE.getByName(ciRunnerName(runId, "test"));
  const tempod = new FakeTempod();
  tempod.on("ci.checkout", ({ sha }: { sha: string }) => ({ sha }));
  const { container } = await installFakes(stub, tempod);
  const results: CiJobResult[] = [];
  const scopes: string[] = [];
  let failures = opts.reportFailures ?? 0;

  const coordinator = {
    jobFinished: async (result: CiJobResult) => {
      if (failures-- > 0) throw new Error("coordinator unavailable");
      results.push(result);
    },
  };

  const artifacts = fakeArtifacts(async () =>
    fakeArtifactRepo(artifactMetadata("app", { id: "repo-app", remote: REMOTE }), {
      async createToken(scope = "write") {
        scopes.push(scope);

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
    core.ciCoordinator = () => coordinator;
    bindings.env = { ...bindings.env, ARTIFACTS: artifacts };
  });

  const job: CiJobStart = {
    projectId: seed.projectId,
    runId,
    jobKey: "test",
    token: newId(),
    userId: seed.userId,
    repoName: "app",
    artifactRepoId: "repo-app",
    cloneUrl: REMOTE,
    branch: "feature/ci",
    sha: SHA,
    command: "bun test",
    timeoutMinutes: 5,
    egressAllowlist: ["*.example.com"],
  };

  return { ...seed, stub, tempod, container, results, scopes, job };
};

const launched = async (r: Awaited<ReturnType<typeof runner>>) => {
  unwrap(await r.stub.ciStart(r.job));
  await runDurableObjectAlarm(r.stub);
  await waitFor(() => r.tempod.requestsOf("script.start").length === 1, 5000, "script start");
};

describe("CI runner (10, Execution)", () => {
  it.concurrent("runs one job in an isolated container and reports a redacted log", async ({ expect }) => {
    const r = await runner();
    await env.CREDENTIALS.getByName(r.userId).putSecret("claude.oauth_token", "sk-owner-secret");
    await launched(r);
    unwrap(await r.stub.ciStart(r.job));

    expect(r.container.starts).toHaveLength(1);
    expect(r.container.starts[0]).toMatchObject({ enableInternet: false, labels: { purpose: "ci" } });
    expect(Object.keys(r.container.starts[0].env).sort()).toEqual([
      "TEMPOD_PORT",
      "TEMPOD_TOKEN",
      "TEMPO_WORKSPACE_ID",
    ]);
    expect(r.container.intercepts).toEqual(["all", "https:*"]);
    expect(r.tempod.hellos[0]).toMatchObject({ env: {}, workspace: { slug: "ci", branch: "feature/ci" } });
    expect(r.tempod.requestsOf("ci.checkout")).toEqual([{ url: REMOTE, branch: "feature/ci", sha: SHA }]);
    expect(r.tempod.requestsOf("script.start")[0]).toMatchObject({
      kind: "run",
      scriptId: "ci",
      command: "bun test",
      cwd: "",
      timeoutMs: 300_000,
    });
    expect(await r.stub.getEgressConfig()).toEqual({
      owner: "tempo",
      repo: "app",
      provider: "artifacts",
      cloneUrl: REMOTE,
      policy: "allowlist",
      allowlist: ["*.example.com"],
      mcp: [],
      ci: true,
    });
    expect(await r.stub.getRepositoryToken()).toBe("read-token");
    expect(r.scopes).toEqual(["read"]);

    const runId = r.tempod.requestsOf("script.start")[0].runId;
    await emitEvent(r.stub, r.tempod, {
      kind: "script.output",
      runId: "other",
      stream: "stdout",
      data: "not this job\n",
    });
    await emitEvent(r.stub, r.tempod, {
      kind: "script.output",
      runId,
      stream: "stdout",
      data: "using sk-owner-secret\n",
    });
    expect(unwrap(await r.stub.ciLog(r.job.token))).toEqual({ text: "using [redacted]\n", truncated: false });
    await emitEvent(r.stub, r.tempod, {
      kind: "script.exited",
      runId,
      exitCode: 0,
      signal: null,
      timedOut: false,
    });

    await waitFor(() => r.results.length === 1, 5000, "result");
    expect(r.results[0]).toEqual({
      runId: r.job.runId,
      jobKey: "test",
      token: r.job.token,
      conclusion: "success",
      exitCode: 0,
      summary: null,
    });
    expect(await (await env.DATA.get(`ci/${r.projectId}/${r.job.runId}/test.log`))?.text()).toBe(
      "using [redacted]\n",
    );
    expect(r.container.running).toBe(false);
  });

  it.concurrent("reports checkout failures and timeouts, and retries a lost report", async ({ expect }) => {
    const missing = await runner();
    missing.tempod.fail("ci.checkout", "CLONE_FAILED", "The commit is not on the branch.");
    unwrap(await missing.stub.ciStart(missing.job));
    await runDurableObjectAlarm(missing.stub);
    await waitFor(() => missing.results.length === 1, 5000, "checkout result");
    expect(missing.results[0]).toMatchObject({
      conclusion: "failure",
      summary: "Could not check out 1111111: The commit is not on the branch.",
    });
    expect(missing.tempod.requestsOf("script.start")).toEqual([]);

    const slow = await runner({ reportFailures: 1 });
    await launched(slow);
    const runId = slow.tempod.requestsOf("script.start")[0].runId;
    await emitEvent(slow.stub, slow.tempod, {
      kind: "script.exited",
      runId,
      exitCode: null,
      signal: "SIGKILL",
      timedOut: true,
    });
    await waitFor(() => slow.container.running === false, 5000, "container stop");
    expect(slow.results).toEqual([]);
    await runDurableObjectAlarm(slow.stub);
    expect(slow.results).toMatchObject([{ conclusion: "timed_out", summary: "The job ran out of time." }]);
  });

  it.concurrent("fails a job whose container stops and ignores a cancelled job's late exit", async ({
    expect,
  }) => {
    const lost = await runner();
    await launched(lost);
    await runInDurableObject(lost.stub, () => lost.container.destroy());
    await runDurableObjectAlarm(lost.stub);
    expect(lost.results).toMatchObject([{ conclusion: "failure", summary: "The CI container stopped." }]);

    const cancelled = await runner();
    await launched(cancelled);
    const runId = cancelled.tempod.requestsOf("script.start")[0].runId;
    await cancelled.stub.ciCancel("another-token");
    expect(cancelled.container.running).toBe(true);
    await cancelled.stub.ciCancel(cancelled.job.token);
    expect(cancelled.container.running).toBe(false);
    await emitEvent(cancelled.stub, cancelled.tempod, {
      kind: "script.exited",
      runId,
      exitCode: 0,
      signal: null,
      timedOut: false,
    });
    await runDurableObjectAlarm(cancelled.stub);
    expect(cancelled.results).toEqual([]);
    expect(await cancelled.stub.getEgressConfig()).toMatchObject({ ci: true });
  });
});
