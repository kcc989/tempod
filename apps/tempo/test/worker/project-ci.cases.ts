import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, it } from "vitest";
import { capture, newId, unwrap, type CiRun } from "@tempo/protocol";
import type { CiJobStart } from "../../src/ci/types.ts";
import type { CiRunner, RepositoryCiDO } from "../../src/do/repository-ci.ts";
import * as ci from "../../src/server/handlers/ci.ts";
import type { HandlerCtx } from "../../src/server/run.ts";
import { seedProject } from "./fakes.ts";

const REMOTE = `https://${"a".repeat(32)}.artifacts.cloudflare.net/git/tempo-repos/app.git`;

const sha = (c: string) => c.repeat(40);

const PIPELINE = [
  "version: 1",
  "jobs:",
  "  a:",
  "    run: echo a",
  "  b:",
  "    run: echo b",
  "  c:",
  "    needs: [a]",
  "    run: echo c",
  "  d:",
  "    needs: [b]",
  "    run: echo d",
  "required: [c]",
].join("\n");

interface StartHooks {
  onStart: (job: CiJobStart) => void;
  instance: RepositoryCiDO | null;
}

/** A native project whose coordinator talks to fake runners and fake branch tips. */
const nativeCi = async () => {
  const seed = await seedProject();
  await env.DB.prepare(
    "UPDATE projects SET provider='artifacts',installation_id=NULL,repo_id=NULL,artifact_repo_id=?,clone_url=?,repo_owner='tempo' WHERE id=?",
  )
    .bind(newId(), REMOTE, seed.projectId)
    .run();
  const stub = env.REPOSITORY_CI.getByName(seed.projectId);
  const starts: CiJobStart[] = [];
  const cancels: string[] = [];
  const tips = new Map<string, string>([["main", sha("1")]]);

  const hooks: StartHooks = { onStart: () => undefined, instance: null };

  const runner: CiRunner = {
    ciStart: async (job) => {
      starts.push(job);
      hooks.onStart(job);

      return { ok: true, value: {} };
    },
    ciCancel: async (token) => {
      cancels.push(token);
    },
    ciLog: async () => ({ ok: true, value: { text: "live tail", truncated: false } }),
    ciChanged: async () => undefined,
  };

  await runInDurableObject(stub, (instance: RepositoryCiDO) => {
    hooks.instance = instance;
    instance.runners = { getByName: () => runner };
    instance.branchTips = async () => [...tips].map(([name, tip]) => ({ name, sha: tip }));
    instance.headSha = async (_project, branch) => tips.get(branch) ?? null;
  });

  const ctx: HandlerCtx = {
    env,
    user: { id: seed.userId, name: "Owner", email: "owner@example.com", image: null },
  };

  const save = async (source: string) => {
    const current = await ci.getCiPipeline(ctx, { projectId: seed.projectId });

    return ci.updateCiPipeline(ctx, { projectId: seed.projectId, source, revision: current.revision });
  };

  const finish = (
    job: CiJobStart,
    conclusion: "success" | "failure" | "timed_out",
    exitCode: number | null,
  ) =>
    stub.jobFinished({
      runId: job.runId,
      jobKey: job.jobKey,
      token: job.token,
      conclusion,
      exitCode,
      summary: null,
    });

  const detail = (runId: string) => ci.getCiRun(ctx, { projectId: seed.projectId, runId });

  return { ...seed, stub, starts, cancels, tips, ctx, save, finish, detail, hooks };
};

const code = async <T>(work: () => Promise<T>) => {
  const result = await capture(work);

  return result.ok ? null : { code: result.error.code, detail: result.error.detail };
};

describe("project CI pipeline", () => {
  it.concurrent("saves validated revisions, rejects stale edits and only baselines existing tips", async ({
    expect,
  }) => {
    const w = await nativeCi();

    expect(await code(() => w.save("version: 1\njobs:\n  a:\n    needs: [a]\n    run: x\n"))).toEqual({
      code: "CI_PIPELINE_INVALID",
      detail: "jobs.a.needs: a job cannot need itself",
    });

    const saved = await w.save(PIPELINE);
    expect(saved).toMatchObject({ revision: 1, enabled: true, required: ["c"], egressAllowlist: [] });
    expect(saved.jobs.map((j) => [j.key, j.needs, j.timeoutMinutes])).toEqual([
      ["a", [], 20],
      ["b", [], 20],
      ["c", ["a"], 20],
      ["d", ["b"], 20],
    ]);
    expect(
      await code(() => ci.updateCiPipeline(w.ctx, { projectId: w.projectId, source: PIPELINE, revision: 0 })),
    ).toMatchObject({ code: "CI_PIPELINE_CHANGED" });
    expect(await ci.listCiRuns(w.ctx, { projectId: w.projectId })).toEqual([]);

    w.tips.set("main", sha("2"));
    await runInDurableObject(w.stub, (instance: RepositoryCiDO) => {
      instance["setKv"]("nextReconcileAt", 0);
    });
    await runDurableObjectAlarm(w.stub);
    const runs = await ci.listCiRuns(w.ctx, { projectId: w.projectId });
    expect(runs.map((r) => [r.branch, r.sha, r.trigger, r.attempt])).toEqual([["main", sha("2"), "push", 1]]);

    expect(await w.save("  ")).toMatchObject({ revision: 2, enabled: false, jobs: [] });
    expect(await code(() => ci.startCiRun(w.ctx, { projectId: w.projectId, branch: "main" }))).toMatchObject({
      code: "CI_NOT_CONFIGURED",
    });

    const github = await seedProject();
    const githubCtx = { ...w.ctx, user: { ...w.ctx.user, id: github.userId } };
    expect(await code(() => ci.getCiPipeline(githubCtx, { projectId: github.projectId }))).toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(await code(() => ci.getCiPipeline(githubCtx, { projectId: w.projectId }))).toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it.concurrent("orders jobs by needs, runs two at a time, skips after failures and ignores stale results", async ({
    expect,
  }) => {
    const w = await nativeCi();
    await w.save(PIPELINE);
    await w.stub.ingest({ branch: "feature", sha: sha("3") });
    await w.stub.ingest({ branch: "feature", sha: sha("3") });
    const [run] = await ci.listCiRuns(w.ctx, { projectId: w.projectId });
    expect(w.starts.map((s) => s.jobKey)).toEqual(["a", "b"]);
    expect(w.starts[0]).toMatchObject({
      branch: "feature",
      sha: sha("3"),
      cloneUrl: REMOTE,
      command: "echo a",
    });

    await w.stub.jobFinished({
      ...w.starts[0]!,
      token: "stale",
      conclusion: "success",
      exitCode: 0,
      summary: null,
    });
    expect(w.starts).toHaveLength(2);

    await w.finish(w.starts[0]!, "success", 0);
    expect(w.starts.map((s) => s.jobKey)).toEqual(["a", "b", "c"]);
    await w.finish(w.starts[1]!, "failure", 1);
    await w.finish(w.starts[0]!, "success", 0);
    await w.finish(w.starts[2]!, "success", 0);

    const done = await w.detail(run!.id);
    expect(done.run).toMatchObject({ status: "completed", conclusion: "failure", number: 1 });
    expect(done.jobs.map((j) => [j.key, j.conclusion, j.exitCode])).toEqual([
      ["a", "success", 0],
      ["b", "failure", 1],
      ["c", "success", 0],
      ["d", "skipped", null],
    ]);
    expect(await ci.listCiRuns(w.ctx, { projectId: w.projectId })).toHaveLength(1);
  });

  it.concurrent("supersedes older pushes, cancels runners and reruns with a new attempt", async ({
    expect,
  }) => {
    const w = await nativeCi();
    await w.save(PIPELINE);
    await w.stub.ingest({ branch: "feature", sha: sha("4") });
    const first = w.starts.slice();
    await w.stub.ingest({ branch: "feature", sha: sha("5") });
    const runs = await ci.listCiRuns(w.ctx, { projectId: w.projectId });
    expect(runs.map((r) => [r.sha, r.status, r.conclusion])).toEqual([
      [sha("5"), "running", null],
      [sha("4"), "completed", "cancelled"],
    ]);
    expect(w.cancels).toEqual(first.map((s) => s.token));

    await w.finish(first[0]!, "success", 0);
    expect((await w.detail(runs[1]!.id)).jobs[0]).toMatchObject({ conclusion: "cancelled" });

    expect(
      await code(() => ci.rerunCiRun(w.ctx, { projectId: w.projectId, runId: runs[0]!.id })),
    ).toMatchObject({
      code: "WORKSPACE_BUSY",
    });
    const cancelled: CiRun = await ci.cancelCiRun(w.ctx, { projectId: w.projectId, runId: runs[0]!.id });
    expect(cancelled).toMatchObject({ status: "completed", conclusion: "cancelled" });

    const rerun = await ci.rerunCiRun(w.ctx, { projectId: w.projectId, runId: runs[0]!.id });
    expect(rerun).toMatchObject({ sha: sha("5"), attempt: 2, trigger: "rerun", number: 3 });
    const manual = await ci.startCiRun(w.ctx, { projectId: w.projectId, branch: "main" });
    expect(manual).toMatchObject({ sha: sha("1"), attempt: 1, trigger: "manual", branch: "main" });
    expect(await code(() => ci.startCiRun(w.ctx, { projectId: w.projectId, branch: "gone" }))).toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await code(() => ci.startCiRun(w.ctx, { projectId: w.projectId, branch: "a..b" }))).toMatchObject({
      code: "BRANCH_INVALID",
    });
  });

  it.concurrent("stops a runner whose start raced a cancel", async ({ expect }) => {
    const w = await nativeCi();
    await w.save("version: 1\njobs:\n  only:\n    run: x\n");
    let runId = "";

    // The cancel's state change is synchronous; its runner stop waits for this start to return.
    w.hooks.onStart = (job) => {
      runId = job.runId;
      void w.hooks.instance!.cancel(job.runId);
    };

    await w.stub.ingest({ branch: "main", sha: sha("7") });
    expect((await w.detail(runId)).run).toMatchObject({ status: "completed", conclusion: "cancelled" });
    // One stop from the cancel itself (which may reach the runner first) and one after the start returned.
    await expect.poll(() => w.cancels.filter((token) => token === w.starts[0]!.token).length).toBe(2);
  });

  it.concurrent("gates merges on required jobs of the current revision, reports checks and cleans up", async ({
    expect,
  }) => {
    const w = await nativeCi();
    const head = sha("6");
    expect(await w.stub.mergeBlock(head)).toBeNull();
    await w.save(PIPELINE);
    expect(await w.stub.mergeBlock(head)).toBe(`Required checks have not passed for ${head.slice(0, 7)}.`);

    await w.stub.ingest({ branch: "feature", sha: head });
    expect((await w.stub.checksFor(head))?.map((c) => [c.name, c.status, c.conclusion])).toEqual([
      ["a", "in_progress", null],
      ["b", "in_progress", null],
      ["c", "queued", null],
      ["d", "queued", null],
    ]);
    await w.finish(w.starts[0]!, "success", 0);
    await w.finish(w.starts[2]!, "success", 0);
    expect(await w.stub.mergeBlock(head)).toBeNull();
    const [run] = await ci.listCiRuns(w.ctx, { projectId: w.projectId });
    expect((await w.stub.checksFor(head))?.[0]).toMatchObject({
      status: "completed",
      conclusion: "success",
      url: `https://${env.APP_HOST}/repositories?project=${w.projectId}&tab=checks&run=${run!.id}`,
    });

    await env.DATA.put(`ci/${w.projectId}/${run!.id}/a.log`, "[tempo: earlier output dropped]\nok\n");
    expect(await ci.getCiJobLog(w.ctx, { projectId: w.projectId, runId: run!.id, job: "a" })).toEqual({
      text: "[tempo: earlier output dropped]\nok\n",
      truncated: true,
    });
    expect(await ci.getCiJobLog(w.ctx, { projectId: w.projectId, runId: run!.id, job: "b" })).toEqual({
      text: "live tail",
      truncated: false,
    });

    await w.save(`${PIPELINE}\n`);
    expect(await w.stub.mergeBlock(head)).not.toBeNull();
    expect(await w.stub.checksFor(head)).toBeNull();
    await w.save(PIPELINE.replace("required: [c]", "required: []"));
    expect(await w.stub.mergeBlock(head)).toBeNull();

    await w.stub.destroy();
    expect(await env.DATA.get(`ci/${w.projectId}/${run!.id}/a.log`)).toBeNull();
    expect(unwrap(await w.stub.getPipeline())).toMatchObject({ revision: 0, enabled: false });
  });
});
