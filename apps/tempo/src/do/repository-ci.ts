import { DurableObject } from "cloudflare:workers";
import { and, asc, desc, eq, inArray, isNull, lt, ne } from "drizzle-orm";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { Schema } from "effect";
import {
  TempoError,
  capture,
  newId,
  type CheckRun,
  type CiJob,
  type CiJobConclusion,
  type CiPipeline,
  type CiRun,
  type CiRunConclusion,
  type CiRunDetail,
  type CiTrigger,
  type Result,
} from "@tempo/protocol";
import { parseCiPipeline, type CiPipelineSpec } from "@tempo/settings";
import { artifactBranchTips, artifactHeadSha, validateArtifactBranch } from "../artifacts/repositories.ts";
import { ciLogKey, ciRunnerName, type CiJobResult, type CiJobStart } from "../ci/types.ts";
import { projects, workspaces } from "../db/d1.ts";
import { REPOSITORY_CI_MIGRATIONS, runMigrations } from "../db/do-migrations.ts";
import { ciBranches, ciJobs, ciKv, ciRuns, pipelines, repositoryCiSchema } from "../db/repository-ci-do.ts";
import type { Env } from "../env.ts";
import { errorText, log } from "../log.ts";

/** 10, Runs and jobs and Ingestion. */
export const CI = {
  parallelJobs: 2,
  keptRuns: 200,
  keptRevisions: 20,
  pageSize: 50,
  reconcileMs: 2 * 60_000,
  graceMs: 5 * 60_000,
  tickMs: 30_000,
} as const;

type RunRow = typeof ciRuns.$inferSelect;

type JobRow = typeof ciJobs.$inferSelect;

export interface ProjectInfo {
  readonly id: string;
  readonly userId: string;
  readonly repoName: string;
  readonly artifactRepoId: string;
  readonly cloneUrl: string;
}

export interface CiRunQuery {
  readonly branch?: string;
  readonly offset?: number;
}

/** The WorkspaceDO methods the coordinator calls: a runner's job, or a workspace's checks. */
export interface CiRunner {
  ciStart(job: CiJobStart): Promise<Result<Record<string, never>>>;
  ciCancel(token: string): Promise<void>;
  ciLog(token: string): Promise<Result<{ text: string; truncated: boolean }>>;
  ciChanged(): Promise<void>;
}

export interface CiRunnerNamespace {
  getByName(name: string): CiRunner;
}

const Strings = Schema.Array(Schema.String);

const strings = (text: string): string[] => [
  ...Schema.decodeUnknownSync(Schema.fromJsonString(Strings))(text),
];

const SHA = /^[0-9a-f]{40}$/;

/**
 * The CI coordinator of one native project (10, Components). Named by the project id. Owns
 * pipeline revisions, runs, jobs and branch baselines in its own SQLite; reads D1 only.
 */
export class RepositoryCiDO extends DurableObject<Env> {
  private readonly db: DrizzleSqliteDODatabase<typeof repositoryCiSchema>;
  /** The Worker bindings. */
  bindings: Env;
  /** CI runners and workspaces (WorkspaceDO); tests put fakes here. */
  runners: CiRunnerNamespace;
  /** Branch tips and one tip from Artifacts Git (09); tests replace them. */
  branchTips = (p: ProjectInfo) => artifactBranchTips(this.bindings, p.repoName, p.artifactRepoId);
  headSha = (p: ProjectInfo, branch: string) =>
    artifactHeadSha(this.bindings, p.repoName, branch, p.artifactRepoId);
  /** The project's deploy coordinator, for the auto trigger (12, Triggers); tests replace it. */
  deploys = (): { autoDeploy(input: { branch: string; sha: string }): Promise<void> } =>
    this.bindings.APP_DEPLOY.getByName(this.projectId);
  private pumping: Promise<void> | null = null;
  private repump = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.bindings = env;
    this.runners = env.WORKSPACE;
    this.db = drizzle(ctx.storage, { schema: repositoryCiSchema });
    void ctx.blockConcurrencyWhile(() => runMigrations(this.db, REPOSITORY_CI_MIGRATIONS));
  }

  // ---------- owner API (10, API) ----------
  async getPipeline(): Promise<Result<CiPipeline>> {
    return capture(async () => this.pipelineWire());
  }

  async updatePipeline(input: { source: string; revision: number }): Promise<Result<CiPipeline>> {
    return capture(async () => {
      const spec = parseCiPipeline(input.source);
      const current = this.latestRevision();

      if (input.revision !== (current?.revision ?? 0)) throw new TempoError("CI_PIPELINE_CHANGED");
      const wasEnabled = this.spec(current) !== null;
      const revision = (current?.revision ?? 0) + 1;
      this.db
        .insert(pipelines)
        .values({
          revision,
          source: input.source,
          specJson: spec ? JSON.stringify(spec) : null,
          createdAt: Date.now(),
        })
        .run();
      this.db
        .delete(pipelines)
        .where(lt(pipelines.revision, revision - CI.keptRevisions + 1))
        .run();

      if (spec && !wasEnabled) {
        this.db.delete(ciBranches).run();
        await this.reconcile(true).catch((e) =>
          log("warn", "ci baseline failed", { projectId: this.projectId, error: errorText(e) }),
        );
      }

      await this.arm();

      return this.pipelineWire();
    });
  }

  async listRuns(input: CiRunQuery): Promise<Result<CiRun[]>> {
    return capture(async () => {
      const offset = input.offset ?? 0;

      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new TempoError("VALIDATION_FAILED", undefined, "offset must be a nonnegative integer");

      const rows = this.db
        .select()
        .from(ciRuns)
        .where(input.branch === undefined ? undefined : eq(ciRuns.branch, input.branch))
        .orderBy(desc(ciRuns.number))
        .limit(CI.pageSize)
        .offset(offset)
        .all();

      return rows.map((row) => this.runWire(row));
    });
  }

  async getRun(runId: string): Promise<Result<CiRunDetail>> {
    return capture(async () => this.detail(this.requireRun(runId)));
  }

  async startRun(branch: string): Promise<Result<CiRun>> {
    return capture(async () => {
      validateArtifactBranch(branch);
      const spec = this.requireSpec();
      const project = await this.project();
      const sha = await this.headSha(project, branch);

      if (!sha) throw new TempoError("NOT_FOUND", undefined, "branch not found");

      return this.runWire(await this.createRun(branch, sha, "manual", spec));
    });
  }

  async rerun(runId: string): Promise<Result<CiRun>> {
    return capture(async () => {
      const previous = this.requireRun(runId);

      if (previous.status !== "completed") throw new TempoError("WORKSPACE_BUSY");
      const spec = this.requireSpec();

      return this.runWire(await this.createRun(previous.branch, previous.sha, "rerun", spec));
    });
  }

  async cancel(runId: string): Promise<Result<CiRun>> {
    return capture(async () => {
      const run = this.requireRun(runId);

      if (run.status !== "completed") await this.cancelRuns([run]);

      return this.runWire(this.requireRun(runId));
    });
  }

  async jobLog(runId: string, key: string): Promise<Result<{ text: string; truncated: boolean }>> {
    return capture(async () => {
      this.requireRun(runId);

      const job = this.db
        .select()
        .from(ciJobs)
        .where(and(eq(ciJobs.runId, runId), eq(ciJobs.key, key)))
        .get();

      if (!job) throw new TempoError("NOT_FOUND");

      if (job.status === "running" && job.token) {
        const live = await this.runners.getByName(ciRunnerName(runId, key)).ciLog(job.token);

        if (live.ok) return live.value;
      }

      const object = await this.bindings.DATA.get(ciLogKey(this.projectId, runId, key));

      if (!object) return { text: "", truncated: false };
      const text = await object.text();

      return { text, truncated: text.startsWith("[tempo: earlier output dropped]") };
    });
  }

  // ---------- Tempo-internal ----------
  /** A Tempo push or merge (10, Ingestion). Never fails the caller's operation. */
  async ingest(input: { branch: string; sha: string }): Promise<void> {
    try {
      validateArtifactBranch(input.branch);
      const spec = this.spec(this.latestRevision());

      if (!SHA.test(input.sha)) return;

      // Without CI, a Tempo push or merge is the auto deploy trigger (12, Triggers).
      if (!spec) {
        await this.deploys().autoDeploy(input);

        return;
      }

      this.db
        .insert(ciBranches)
        .values({ name: input.branch, sha: input.sha })
        .onConflictDoUpdate({ target: ciBranches.name, set: { sha: input.sha } })
        .run();
      await this.trigger(input.branch, input.sha, spec);
    } catch (e) {
      log("warn", "ci ingest failed", { projectId: this.projectId, error: errorText(e) });
    }
  }

  /** A runner's result; accepted only for the running job and its token (10, Runs and jobs). */
  async jobFinished(result: CiJobResult): Promise<void> {
    const job = this.db
      .select()
      .from(ciJobs)
      .where(and(eq(ciJobs.runId, result.runId), eq(ciJobs.key, result.jobKey)))
      .get();

    if (!job || job.status !== "running" || job.token !== result.token) return;
    this.completeJob(job, result.conclusion, {
      exitCode: result.exitCode,
      summary: result.summary === null ? null : result.summary.slice(0, 1000),
    });
    await this.pump();
  }

  /** Check runs for a workspace's PR head (10, Checks, merge and events). */
  async checksFor(sha: string): Promise<CheckRun[] | null> {
    const run = this.newestRun(sha);

    if (!run) return null;

    return this.jobsOf(run.id).map((job) => {
      const check: CheckRun = {
        name: job.name,
        status: job.status === "running" ? "in_progress" : job.status,
        conclusion: job.conclusion,
        url: this.runUrl(run.id),
      };

      return job.summary ? { ...check, summary: job.summary } : check;
    });
  }

  /** 10, Merge gate. Null means the merge may go on. */
  async mergeBlock(sha: string): Promise<string | null> {
    const spec = this.spec(this.latestRevision());

    if (!spec || spec.required.length === 0) return null;
    const run = this.newestRun(sha);
    const jobs = run ? this.jobsOf(run.id) : [];

    const passed = spec.required.every((key) =>
      jobs.some((job) => job.key === key && job.status === "completed" && job.conclusion === "success"),
    );

    return passed ? null : `Required checks have not passed for ${sha.slice(0, 7)}.`;
  }

  /** The project is unlinked: stop every job and delete all CI data. */
  async destroy(): Promise<void> {
    await this.cancelRuns(this.db.select().from(ciRuns).where(ne(ciRuns.status, "completed")).all());
    await this.deleteLogs(
      this.db
        .select({ id: ciRuns.id })
        .from(ciRuns)
        .all()
        .map((r) => r.id),
    );
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await runMigrations(this.db, REPOSITORY_CI_MIGRATIONS);
  }

  override async alarm(): Promise<void> {
    const spec = this.spec(this.latestRevision());

    if (spec && Date.now() >= (this.kv<number>("nextReconcileAt") ?? 0)) {
      this.setKv("nextReconcileAt", Date.now() + CI.reconcileMs);
      await this.reconcile(false).catch((e) =>
        log("warn", "ci reconcile failed", { projectId: this.projectId, error: errorText(e) }),
      );
    }

    await this.watchdog();
    await this.pump();
    await this.arm();
  }

  // ---------- runs ----------
  private async trigger(branch: string, sha: string, spec: CiPipelineSpec): Promise<void> {
    const revision = this.latestRevision()!.revision;

    const exists = this.db
      .select({ id: ciRuns.id })
      .from(ciRuns)
      .where(and(eq(ciRuns.sha, sha), eq(ciRuns.revision, revision)))
      .get();

    if (exists) return;
    await this.createRun(branch, sha, "push", spec);
  }

  private async createRun(
    branch: string,
    sha: string,
    trigger: CiTrigger,
    spec: CiPipelineSpec,
  ): Promise<RunRow> {
    const revision = this.latestRevision()!.revision;
    const now = Date.now();
    const id = newId();

    const older =
      trigger === "push"
        ? this.db
            .select()
            .from(ciRuns)
            .where(and(eq(ciRuns.branch, branch), ne(ciRuns.sha, sha), ne(ciRuns.status, "completed")))
            .all()
        : [];

    this.ctx.storage.transactionSync(() => {
      const last = this.db.select({ number: ciRuns.number }).from(ciRuns).orderBy(desc(ciRuns.number)).get();

      const attempts = this.db
        .select({ attempt: ciRuns.attempt })
        .from(ciRuns)
        .where(and(eq(ciRuns.sha, sha), eq(ciRuns.revision, revision)))
        .orderBy(desc(ciRuns.attempt))
        .get();

      const number = Math.max(last?.number ?? 0, this.kv<number>("lastNumber") ?? 0) + 1;
      this.db
        .insert(ciRuns)
        .values({
          id,
          number,
          branch,
          sha,
          revision,
          attempt: (attempts?.attempt ?? 0) + 1,
          trigger,
          status: "queued",
          conclusion: null,
          requiredJson: JSON.stringify(spec.required),
          egressJson: JSON.stringify(spec.egressAllowlist),
          createdAt: now,
          startedAt: null,
          completedAt: null,
        })
        .run();
      this.setKv("lastNumber", number);
      spec.jobs.forEach((job, position) =>
        this.db
          .insert(ciJobs)
          .values({
            runId: id,
            key: job.key,
            position,
            name: job.name,
            needsJson: JSON.stringify(job.needs),
            command: job.run,
            timeoutMinutes: job.timeoutMinutes,
            status: "queued",
            conclusion: null,
            exitCode: null,
            summary: null,
            token: null,
            startedAt: null,
            completedAt: null,
          })
          .run(),
      );
    });

    if (older.length) await this.cancelRuns(older);
    await this.prune();
    await this.pump();

    return this.requireRun(id);
  }

  private async cancelRuns(runs: ReadonlyArray<RunRow>): Promise<void> {
    const stops: Array<{ runId: string; key: string; token: string }> = [];

    for (const run of runs) {
      for (const job of this.jobsOf(run.id)) {
        if (job.status === "completed") continue;

        if (job.status === "running" && job.token)
          stops.push({ runId: run.id, key: job.key, token: job.token });
        this.completeJob(job, "cancelled", { exitCode: null, summary: null }, false);
      }

      this.db
        .update(ciRuns)
        .set({ status: "completed", conclusion: "cancelled", completedAt: Date.now() })
        .where(eq(ciRuns.id, run.id))
        .run();
      this.notify(run.branch);
    }

    for (const stop of stops) {
      await this.runners
        .getByName(ciRunnerName(stop.runId, stop.key))
        .ciCancel(stop.token)
        .catch((e) => log("warn", "ci cancel failed", { projectId: this.projectId, error: errorText(e) }));
    }

    await this.pump();
  }

  private completeJob(
    job: JobRow,
    conclusion: CiJobConclusion,
    extra: { exitCode: number | null; summary: string | null },
    finalize = true,
  ): void {
    // Conditional: a job read before an await may have completed since (cancel, result, watchdog).
    const changed = this.db
      .update(ciJobs)
      .set({ status: "completed", conclusion, ...extra, token: null, completedAt: Date.now() })
      .where(and(eq(ciJobs.runId, job.runId), eq(ciJobs.key, job.key), ne(ciJobs.status, "completed")))
      .returning({ key: ciJobs.key })
      .all();

    if (changed.length && finalize) this.finalize(job.runId);
  }

  /** Completes a run whose jobs all completed. */
  private finalize(runId: string): void {
    const run = this.db.select().from(ciRuns).where(eq(ciRuns.id, runId)).get();

    if (!run || run.status === "completed") return;
    const jobs = this.jobsOf(runId);

    if (jobs.some((job) => job.status !== "completed")) return;

    const conclusion: CiRunConclusion = jobs.some(
      (job) => job.conclusion === "failure" || job.conclusion === "timed_out",
    )
      ? "failure"
      : jobs.some((job) => job.conclusion === "cancelled")
        ? "cancelled"
        : "success";

    this.db
      .update(ciRuns)
      .set({ status: "completed", conclusion, completedAt: Date.now() })
      .where(eq(ciRuns.id, runId))
      .run();
    this.notify(run.branch);

    if (conclusion === "success" && run.trigger === "push")
      this.ctx.waitUntil(
        this.deploys()
          .autoDeploy({ branch: run.branch, sha: run.sha })
          .catch((e) =>
            log("warn", "auto deploy trigger failed", { projectId: this.projectId, error: errorText(e) }),
          ),
      );
  }

  /** Admits queued jobs whose needs succeeded, at most CI.parallelJobs at once. */
  private pump(): Promise<void> {
    if (this.pumping) {
      this.repump = true;

      return this.pumping;
    }

    this.pumping = (async () => {
      do {
        this.repump = false;
        await this.pumpOnce();
      } while (this.repump);
    })().finally(() => {
      this.pumping = null;
    });

    return this.pumping;
  }

  private async pumpOnce(): Promise<void> {
    const open = this.db
      .select()
      .from(ciRuns)
      .where(ne(ciRuns.status, "completed"))
      .orderBy(asc(ciRuns.number))
      .all();

    let running = this.db
      .select({ key: ciJobs.key })
      .from(ciJobs)
      .where(eq(ciJobs.status, "running"))
      .all().length;

    for (const run of open) {
      const jobs = this.jobsOf(run.id);

      for (const job of jobs.filter((j) => j.status === "queued")) {
        const needs = strings(job.needsJson).map((key) => jobs.find((j) => j.key === key));

        if (needs.some((need) => need?.status === "completed" && need.conclusion !== "success")) {
          this.completeJob(job, "skipped", { exitCode: null, summary: null });
          continue;
        }

        if (!needs.every((need) => need?.status === "completed") || running >= CI.parallelJobs) continue;

        if (await this.startJob(run, job)) running++;
      }

      this.finalize(run.id);
    }

    await this.arm();
  }

  private async startJob(run: RunRow, job: JobRow): Promise<boolean> {
    const token = newId();
    const now = Date.now();

    const claimed = this.db
      .update(ciJobs)
      .set({ status: "running", token, startedAt: now })
      .where(and(eq(ciJobs.runId, run.id), eq(ciJobs.key, job.key), eq(ciJobs.status, "queued")))
      .returning({ key: ciJobs.key })
      .all();

    if (!claimed.length) return false;

    const begun = this.db
      .update(ciRuns)
      .set({ status: "running", startedAt: now })
      .where(and(eq(ciRuns.id, run.id), eq(ciRuns.status, "queued")))
      .returning({ id: ciRuns.id })
      .all();

    if (begun.length) this.notify(run.branch);

    try {
      const project = await this.project();

      const started = await this.runners.getByName(ciRunnerName(run.id, job.key)).ciStart({
        projectId: project.id,
        runId: run.id,
        jobKey: job.key,
        token,
        userId: project.userId,
        repoName: project.repoName,
        artifactRepoId: project.artifactRepoId,
        cloneUrl: project.cloneUrl,
        branch: run.branch,
        sha: run.sha,
        command: job.command,
        timeoutMinutes: job.timeoutMinutes,
        egressAllowlist: strings(run.egressJson),
      });

      if (!started.ok) throw new TempoError(started.error.code, started.error.message);

      const after = this.db
        .select({ token: ciJobs.token })
        .from(ciJobs)
        .where(and(eq(ciJobs.runId, run.id), eq(ciJobs.key, job.key)))
        .get();

      // A cancel during the start reached the runner before its job did.
      if (after?.token !== token) await this.runners.getByName(ciRunnerName(run.id, job.key)).ciCancel(token);
    } catch (e) {
      log("warn", "ci job start failed", { projectId: this.projectId, error: errorText(e) });

      const current = this.db
        .select()
        .from(ciJobs)
        .where(and(eq(ciJobs.runId, run.id), eq(ciJobs.key, job.key)))
        .get();

      if (current?.status === "running" && current.token === token)
        this.completeJob(current, "failure", { exitCode: null, summary: "The CI container did not start." });
    }

    return true;
  }

  /** Jobs past their timeout plus grace complete as timed out (10, Runs and jobs). */
  private async watchdog(): Promise<void> {
    const now = Date.now();
    const stale = this.db.select().from(ciJobs).where(eq(ciJobs.status, "running")).all();

    for (const job of stale) {
      if ((job.startedAt ?? now) + job.timeoutMinutes * 60_000 + 2 * CI.graceMs > now) continue;
      const token = job.token;
      this.completeJob(job, "timed_out", { exitCode: null, summary: "The job ran out of time." });

      if (token)
        await this.runners
          .getByName(ciRunnerName(job.runId, job.key))
          .ciCancel(token)
          .catch(() => undefined);
    }
  }

  /** Branch tips from Git ref advertisement; a changed or new tip starts a run (10, Ingestion). */
  private async reconcile(baseline: boolean): Promise<void> {
    const project = await this.project();
    const spec = this.spec(this.latestRevision());
    const tips = await this.branchTips(project);

    const known = new Map(
      this.db
        .select()
        .from(ciBranches)
        .all()
        .map((b) => [b.name, b.sha]),
    );

    for (const tip of tips) {
      if (known.get(tip.name) === tip.sha) continue;
      this.db
        .insert(ciBranches)
        .values({ name: tip.name, sha: tip.sha })
        .onConflictDoUpdate({ target: ciBranches.name, set: { sha: tip.sha } })
        .run();

      if (!baseline && spec) await this.trigger(tip.name, tip.sha, spec);
    }

    const live = new Set(tips.map((tip) => tip.name));
    const gone = [...known.keys()].filter((name) => !live.has(name));

    if (gone.length) this.db.delete(ciBranches).where(inArray(ciBranches.name, gone)).run();
  }

  private async prune(): Promise<void> {
    const old = this.db
      .select({ id: ciRuns.id })
      .from(ciRuns)
      .where(eq(ciRuns.status, "completed"))
      .orderBy(desc(ciRuns.number))
      .offset(CI.keptRuns)
      .limit(1000)
      .all()
      .map((row) => row.id);

    if (!old.length) return;
    await this.deleteLogs(old);
    this.db.delete(ciJobs).where(inArray(ciJobs.runId, old)).run();
    this.db.delete(ciRuns).where(inArray(ciRuns.id, old)).run();
  }

  private async deleteLogs(runIds: ReadonlyArray<string>): Promise<void> {
    for (const runId of runIds) {
      const listed = await this.bindings.DATA.list({ prefix: `ci/${this.projectId}/${runId}/` });

      if (listed.objects.length) await this.bindings.DATA.delete(listed.objects.map((o) => o.key));
    }
  }

  /** Tells the project's workspaces on this branch to refresh their checks. */
  private notify(branch: string): void {
    const work = drizzleD1(this.bindings.DB)
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.projectId, this.projectId),
          eq(workspaces.branch, branch),
          isNull(workspaces.archivedAt),
        ),
      )
      .all()
      .then((rows) => Promise.all(rows.map((row) => this.runners.getByName(row.id).ciChanged())))
      .catch((e) => log("warn", "ci notify failed", { projectId: this.projectId, error: errorText(e) }));

    this.ctx.waitUntil(work);
  }

  private async arm(): Promise<void> {
    const at: number[] = [];

    if (this.spec(this.latestRevision()))
      at.push(this.kv<number>("nextReconcileAt") ?? Date.now() + CI.reconcileMs);

    if (this.db.select({ key: ciJobs.key }).from(ciJobs).where(ne(ciJobs.status, "completed")).get())
      at.push(Date.now() + CI.tickMs);

    if (!at.length) {
      await this.ctx.storage.deleteAlarm();

      return;
    }

    const next = Math.max(Date.now(), Math.min(...at));
    const current = await this.ctx.storage.getAlarm();

    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }

  // ---------- reads ----------
  private get projectId(): string {
    const name = this.ctx.id.name;

    if (!name) throw new TempoError("NOT_FOUND");

    return name;
  }

  private async project(): Promise<ProjectInfo> {
    const row = await drizzleD1(this.bindings.DB)
      .select()
      .from(projects)
      .where(eq(projects.id, this.projectId))
      .get();

    if (!row || row.provider !== "artifacts" || !row.artifactRepoId || !row.cloneUrl)
      throw new TempoError("NOT_FOUND", undefined, "project not found");

    return {
      id: row.id,
      userId: row.userId,
      repoName: row.repoName,
      artifactRepoId: row.artifactRepoId,
      cloneUrl: row.cloneUrl,
    };
  }

  private latestRevision() {
    return this.db.select().from(pipelines).orderBy(desc(pipelines.revision)).get();
  }

  private spec(row: typeof pipelines.$inferSelect | undefined): CiPipelineSpec | null {
    if (!row?.specJson) return null;

    // SAFETY: spec_json is written only by updatePipeline from parseCiPipeline's validated result.
    return JSON.parse(row.specJson) as CiPipelineSpec;
  }

  private requireSpec(): CiPipelineSpec {
    const spec = this.spec(this.latestRevision());

    if (!spec) throw new TempoError("CI_NOT_CONFIGURED");

    return spec;
  }

  private pipelineWire(): CiPipeline {
    const row = this.latestRevision();
    const spec = this.spec(row);

    return {
      projectId: this.projectId,
      revision: row?.revision ?? 0,
      source: row?.source ?? "",
      enabled: spec !== null,
      jobs: (spec?.jobs ?? []).map(({ key, name, needs, timeoutMinutes }) => ({
        key,
        name,
        needs,
        timeoutMinutes,
      })),
      required: spec?.required ?? [],
      egressAllowlist: spec?.egressAllowlist ?? [],
      updatedAt: row?.createdAt ?? null,
    };
  }

  /** The newest attempt for this commit under the current revision. */
  private newestRun(sha: string): RunRow | undefined {
    const revision = this.latestRevision();

    if (!revision?.specJson) return undefined;

    return this.db
      .select()
      .from(ciRuns)
      .where(and(eq(ciRuns.sha, sha), eq(ciRuns.revision, revision.revision)))
      .orderBy(desc(ciRuns.attempt))
      .get();
  }

  private requireRun(runId: string): RunRow {
    const run = this.db.select().from(ciRuns).where(eq(ciRuns.id, runId)).get();

    if (!run) throw new TempoError("NOT_FOUND");

    return run;
  }

  private jobsOf(runId: string): JobRow[] {
    return this.db.select().from(ciJobs).where(eq(ciJobs.runId, runId)).orderBy(asc(ciJobs.position)).all();
  }

  private runUrl(runId: string): string {
    return `https://${this.bindings.APP_HOST}/repositories?project=${encodeURIComponent(this.projectId)}&tab=checks&run=${encodeURIComponent(runId)}`;
  }

  private runWire(row: RunRow): CiRun {
    return {
      id: row.id,
      projectId: this.projectId,
      number: row.number,
      branch: row.branch,
      sha: row.sha,
      revision: row.revision,
      attempt: row.attempt,
      trigger: row.trigger,
      status: row.status,
      conclusion: row.conclusion,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      url: this.runUrl(row.id),
    };
  }

  private detail(row: RunRow): CiRunDetail {
    return {
      run: this.runWire(row),
      jobs: this.jobsOf(row.id).map((job): CiJob => ({
        key: job.key,
        name: job.name,
        needs: strings(job.needsJson),
        status: job.status,
        conclusion: job.conclusion,
        exitCode: job.exitCode,
        summary: job.summary,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
      })),
    };
  }

  private kv<T>(key: string): T | undefined {
    const row = this.db.select().from(ciKv).where(eq(ciKv.key, key)).get();

    // SAFETY: each key is written by setKv with one fixed JSON type and read with that type.
    return row ? (JSON.parse(row.valueJson) as T) : undefined;
  }

  private setKv(key: string, value: number | string | boolean | null): void {
    const valueJson = JSON.stringify(value);
    this.db
      .insert(ciKv)
      .values({ key, valueJson })
      .onConflictDoUpdate({ target: ciKv.key, set: { valueJson } })
      .run();
  }
}
