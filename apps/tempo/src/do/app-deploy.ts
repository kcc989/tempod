import { DurableObject } from "cloudflare:workers";
import { and, asc, desc, eq, inArray, lt, ne } from "drizzle-orm";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import {
  TempoError,
  capture,
  newId,
  type DeployConclusion,
  type DeployConfig,
  type DeployTrigger,
  type Deployment,
  type Result,
} from "@tempo/protocol";
import { parseDeployConfig, type DeploySpec } from "@tempo/settings";
import { artifactHeadSha, validateArtifactBranch } from "../artifacts/repositories.ts";
import { appDeploySchema, deployConfigs, deployKv, deployments } from "../db/app-deploy-do.ts";
import { projects } from "../db/d1.ts";
import { APP_DEPLOY_MIGRATIONS, runMigrations } from "../db/do-migrations.ts";
import {
  createToken,
  deleteToken,
  permissionGroups,
  tokenPolicies,
  type CloudflareApi,
} from "../deploy/cloudflare.ts";
import {
  DEPLOY_ACCOUNT_KEY,
  DEPLOY_MASTER_KEY,
  deployCommand,
  deployLogKey,
  deployRunnerName,
  deployTokenKey,
  type DeployJobResult,
  type DeployJobStart,
  type DeployPlan,
} from "../deploy/types.ts";
import type { Env } from "../env.ts";
import { errorText, log } from "../log.ts";
import type { ProjectInfo } from "./repository-ci.ts";

/** 12, Deployments and Tokens. */
export const DEPLOY = {
  keptDeployments: 200,
  keptRevisions: 20,
  pageSize: 50,
  graceMs: 5 * 60_000,
  tokenSlackMs: 15 * 60_000,
  tickMs: 30_000,
} as const;

type Row = typeof deployments.$inferSelect;

export interface DeploymentQuery {
  readonly target?: string;
  readonly offset?: number;
}

/** The WorkspaceDO methods the coordinator calls on a deploy runner. */
export interface DeployRunner {
  deployStart(job: DeployJobStart): Promise<Result<Record<string, never>>>;
  deployCancel(token: string): Promise<void>;
  deployLog(token: string): Promise<Result<{ text: string; truncated: boolean }>>;
}

export interface DeployRunnerNamespace {
  getByName(name: string): DeployRunner;
}

const SHA = /^[0-9a-f]{40}$/;

const isBranch = (branch: string): boolean => {
  try {
    validateArtifactBranch(branch);

    return true;
  } catch {
    return false;
  }
};

/**
 * The deploy coordinator of one native project (12, Components). Named by the project id. Owns
 * configuration revisions and deployments in its own SQLite; reads D1 only.
 */
export class AppDeployDO extends DurableObject<Env> {
  private readonly db: DrizzleSqliteDODatabase<typeof appDeploySchema>;
  /** The Worker bindings. */
  bindings: Env;
  /** Deploy runners (WorkspaceDO); tests put fakes here. */
  runners: DeployRunnerNamespace;
  /** The Cloudflare API (12, Tokens); tests replace it. */
  cloudflare: CloudflareApi = { fetch: (request) => fetch(request) };
  /** One branch tip from Artifacts Git (09); tests replace it. */
  headSha = (p: ProjectInfo, branch: string) =>
    artifactHeadSha(this.bindings, p.repoName, branch, p.artifactRepoId);
  private pumping: Promise<void> | null = null;
  private repump = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.bindings = env;
    this.runners = env.WORKSPACE;
    this.db = drizzle(ctx.storage, { schema: appDeploySchema });
    void ctx.blockConcurrencyWhile(() => runMigrations(this.db, APP_DEPLOY_MIGRATIONS));
  }

  // ---------- owner API (12, API) ----------
  async getConfig(): Promise<Result<DeployConfig>> {
    return capture(async () => this.configWire());
  }

  async updateConfig(input: { source: string; revision: number }): Promise<Result<DeployConfig>> {
    return capture(async () => {
      const spec = parseDeployConfig(input.source, isBranch);
      const current = this.latestRevision();

      if (input.revision !== (current?.revision ?? 0)) throw new TempoError("DEPLOY_CONFIG_CHANGED");
      const revision = (current?.revision ?? 0) + 1;
      this.db
        .insert(deployConfigs)
        .values({
          revision,
          source: input.source,
          specJson: spec ? JSON.stringify(spec) : null,
          createdAt: Date.now(),
        })
        .run();
      this.db
        .delete(deployConfigs)
        .where(lt(deployConfigs.revision, revision - DEPLOY.keptRevisions + 1))
        .run();

      return this.configWire();
    });
  }

  async list(input: DeploymentQuery): Promise<Result<Deployment[]>> {
    return capture(async () => {
      const offset = input.offset ?? 0;

      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new TempoError("VALIDATION_FAILED", undefined, "offset must be a nonnegative integer");

      return this.db
        .select()
        .from(deployments)
        .where(input.target === undefined ? undefined : eq(deployments.target, input.target))
        .orderBy(desc(deployments.number))
        .limit(DEPLOY.pageSize)
        .offset(offset)
        .all()
        .map((row) => this.wire(row));
    });
  }

  async get(deploymentId: string): Promise<Result<Deployment>> {
    return capture(async () => this.wire(this.require(deploymentId)));
  }

  /** Owner (`manual`) and agent (`agent`) starts (12, Triggers). */
  async start(input: {
    target: string;
    branch?: string;
    trigger: "manual" | "agent";
    workspaceId?: string;
  }): Promise<Result<Deployment>> {
    return capture(async () => {
      const spec = this.requireSpec();
      const target = spec.targets.find((t) => t.key === input.target);

      if (!target) throw new TempoError("NOT_FOUND", undefined, "target not found");

      if (input.trigger === "agent" && !target.agent)
        throw new TempoError("FORBIDDEN", undefined, `Target ${target.key} is not open to agents.`);

      if (target.branch !== null && input.branch !== undefined && input.branch !== target.branch)
        throw new TempoError(
          "VALIDATION_FAILED",
          undefined,
          `Target ${target.key} deploys only branch ${target.branch}.`,
        );
      const branch = target.branch ?? input.branch;

      if (branch === undefined)
        throw new TempoError("VALIDATION_FAILED", undefined, `Choose a branch for target ${target.key}.`);
      validateArtifactBranch(branch);
      const project = await this.project();
      await this.requireSettings(project.userId);
      const sha = await this.headSha(project, branch);

      if (!sha) throw new TempoError("NOT_FOUND", undefined, "branch not found");

      return this.wire(
        await this.create(target.key, branch, sha, input.trigger, spec, input.workspaceId ?? null),
      );
    });
  }

  async redeploy(deploymentId: string): Promise<Result<Deployment>> {
    return capture(async () => {
      const previous = this.require(deploymentId);

      if (previous.status !== "completed") throw new TempoError("WORKSPACE_BUSY");
      const spec = this.requireSpec();

      if (!spec.targets.some((t) => t.key === previous.target))
        throw new TempoError("NOT_FOUND", undefined, "target not found");
      await this.requireSettings((await this.project()).userId);

      return this.wire(
        await this.create(previous.target, previous.branch, previous.sha, "redeploy", spec, null),
      );
    });
  }

  async cancel(deploymentId: string): Promise<Result<Deployment>> {
    return capture(async () => {
      const row = this.require(deploymentId);

      if (row.status !== "completed") await this.stop(row, "cancelled", { exitCode: null, summary: null });

      return this.wire(this.require(deploymentId));
    });
  }

  async log(deploymentId: string): Promise<Result<{ text: string; truncated: boolean }>> {
    return capture(async () => {
      const row = this.require(deploymentId);

      if (row.status === "running" && row.token) {
        const live = await this.runners.getByName(deployRunnerName(row.id)).deployLog(row.token);

        if (live.ok) return live.value;
      }

      const object = await this.bindings.DATA.get(deployLogKey(this.projectId, row.id));

      if (!object) return { text: "", truncated: false };
      const text = await object.text();

      return { text, truncated: text.startsWith("[tempo: earlier output dropped]") };
    });
  }

  // ---------- Tempo-internal ----------
  /** A successful CI push run, or a push or merge without CI (12, Triggers). Never fails the caller. */
  async autoDeploy(input: { branch: string; sha: string }): Promise<void> {
    try {
      const spec = this.spec(this.latestRevision());

      if (!spec || !SHA.test(input.sha)) return;
      const revision = this.latestRevision()!.revision;

      for (const target of spec.targets) {
        if (!target.auto || target.branch !== input.branch) continue;

        const exists = this.db
          .select({ id: deployments.id })
          .from(deployments)
          .where(
            and(
              eq(deployments.target, target.key),
              eq(deployments.sha, input.sha),
              eq(deployments.revision, revision),
              eq(deployments.trigger, "auto"),
            ),
          )
          .get();

        if (!exists) await this.create(target.key, input.branch, input.sha, "auto", spec, null);
      }
    } catch (e) {
      log("warn", "auto deploy failed", { projectId: this.projectId, error: errorText(e) });
    }
  }

  /** A runner's result; accepted only for the running deployment and its token (12, Deployments). */
  async deploymentFinished(result: DeployJobResult): Promise<void> {
    const row = this.db.select().from(deployments).where(eq(deployments.id, result.deploymentId)).get();

    if (!row || row.status !== "running" || row.token !== result.token) return;
    await this.complete(row, result.conclusion, {
      exitCode: result.exitCode,
      summary: result.summary === null ? null : result.summary.slice(0, 1000),
    });
    await this.pump();
  }

  /** The project is unlinked: stop every deployment, revoke tokens and delete all deploy data. */
  async destroy(): Promise<void> {
    for (const row of this.db.select().from(deployments).where(ne(deployments.status, "completed")).all())
      await this.stop(row, "cancelled", { exitCode: null, summary: null }, false);
    await this.revokePending();
    const listed = await this.bindings.DATA.list({ prefix: `deploy/${this.projectId}/` });

    if (listed.objects.length) await this.bindings.DATA.delete(listed.objects.map((o) => o.key));
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await runMigrations(this.db, APP_DEPLOY_MIGRATIONS);
  }

  override async alarm(): Promise<void> {
    await this.watchdog();
    await this.revokePending();
    await this.pump();
    await this.arm();
  }

  // ---------- deployments ----------
  private async create(
    target: string,
    branch: string,
    sha: string,
    trigger: DeployTrigger,
    spec: DeploySpec,
    workspaceId: string | null,
  ): Promise<Row> {
    const revision = this.latestRevision()!.revision;
    const config = spec.targets.find((t) => t.key === target)!;
    const id = newId();

    const plan: DeployPlan = {
      tool: spec.tool,
      root: spec.root,
      install: spec.install,
      build: spec.build,
      permissions: spec.permissions,
      stage: config.stage,
      target,
    };

    const older = this.db
      .select()
      .from(deployments)
      .where(and(eq(deployments.target, target), eq(deployments.status, "queued")))
      .all();

    this.ctx.storage.transactionSync(() => {
      const last = this.db
        .select({ number: deployments.number })
        .from(deployments)
        .orderBy(desc(deployments.number))
        .get();

      const number = Math.max(last?.number ?? 0, this.kv<number>("lastNumber") ?? 0) + 1;
      this.db
        .insert(deployments)
        .values({
          id,
          number,
          target,
          stage: config.stage,
          branch,
          sha,
          revision,
          trigger,
          status: "queued",
          conclusion: null,
          exitCode: null,
          summary: null,
          workspaceId,
          planJson: JSON.stringify({
            ...plan,
            timeoutMinutes: spec.timeoutMinutes,
            egressAllowlist: spec.egressAllowlist,
          }),
          token: null,
          accountId: null,
          cfTokenId: null,
          tokenExpiresAt: null,
          tokenRevoked: 0,
          createdAt: Date.now(),
          startedAt: null,
          completedAt: null,
        })
        .run();
      this.setKv("lastNumber", number);
    });

    for (const row of older) await this.stop(row, "cancelled", { exitCode: null, summary: null }, false);
    await this.prune();
    await this.pump();

    return this.require(id);
  }

  /** Completes a deployment once, then cleans up its token. Conditional: it may have completed since. */
  private async complete(
    row: Row,
    conclusion: DeployConclusion,
    extra: { exitCode: number | null; summary: string | null },
  ): Promise<boolean> {
    const changed = this.db
      .update(deployments)
      .set({ status: "completed", conclusion, ...extra, token: null, completedAt: Date.now() })
      .where(and(eq(deployments.id, row.id), ne(deployments.status, "completed")))
      .returning({ id: deployments.id })
      .all();

    if (!changed.length) return false;
    await this.revoke(this.require(row.id));

    return true;
  }

  /** Cancel or watchdog: complete, then stop the runner when one was started. */
  private async stop(
    row: Row,
    conclusion: DeployConclusion,
    extra: { exitCode: number | null; summary: string | null },
    pump = true,
  ): Promise<void> {
    const token = row.token;

    if (!(await this.complete(row, conclusion, extra))) return;

    if (row.status === "running" && token)
      await this.runners
        .getByName(deployRunnerName(row.id))
        .deployCancel(token)
        .catch((e) =>
          log("warn", "deploy cancel failed", { projectId: this.projectId, error: errorText(e) }),
        );

    if (pump) await this.pump();
  }

  /** Admits the oldest queued deployment when none runs (12, Deployments). */
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
    const running = this.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.status, "running"))
      .get();

    if (!running) {
      const next = this.db
        .select()
        .from(deployments)
        .where(eq(deployments.status, "queued"))
        .orderBy(asc(deployments.number))
        .get();

      if (next) await this.admit(next);
    }

    await this.arm();
  }

  private async admit(row: Row): Promise<void> {
    const token = newId();
    const now = Date.now();

    const claimed = this.db
      .update(deployments)
      .set({ status: "running", token, startedAt: now })
      .where(and(eq(deployments.id, row.id), eq(deployments.status, "queued")))
      .returning({ id: deployments.id })
      .all();

    if (!claimed.length) return;

    // SAFETY: plan_json is written only by create from the parsed spec.
    const plan = JSON.parse(row.planJson) as DeployPlan & {
      timeoutMinutes: number;
      egressAllowlist: string[];
    };

    const fail = async (summary: string) => {
      const current = this.require(row.id);

      if (current.status === "running" && current.token === token)
        await this.complete(current, "failure", { exitCode: null, summary });
      this.repump = true;
    };

    let project: ProjectInfo;

    try {
      project = await this.project();
    } catch {
      return fail("The project is not available.");
    }

    const creds = this.bindings.CREDENTIALS.getByName(project.userId);
    const master = await creds.getSecret(DEPLOY_MASTER_KEY);
    const accountId = await creds.getSecret(DEPLOY_ACCOUNT_KEY);

    if (!master || !accountId) return fail("Add a Cloudflare account and token in Settings first.");

    const expiresAt = now + plan.timeoutMinutes * 60_000 + DEPLOY.tokenSlackMs;
    let minted: { id: string; value: string };

    try {
      const groups = await permissionGroups(this.cloudflare, master, accountId);
      const policies = tokenPolicies(groups, plan.permissions, accountId);
      minted = await createToken(this.cloudflare, master, accountId, {
        name: `tempo-deploy-${project.id}-${row.number}`,
        expiresAt,
        policies,
      });
    } catch (e) {
      const status = e instanceof Error && "status" in e ? String(e.status) : "error";

      return fail(
        e instanceof Error && e.message.startsWith("Cloudflare has no permission group")
          ? e.message
          : `Cloudflare did not create a deploy token: ${status}.`,
      );
    }

    // The secret first, then the row: any revoke that sees the token id also deletes the secret.
    await creds.putSecret(deployTokenKey(row.id), minted.value);
    this.db
      .update(deployments)
      .set({ accountId, cfTokenId: minted.id, tokenExpiresAt: expiresAt, tokenRevoked: 0 })
      .where(eq(deployments.id, row.id))
      .run();

    const current = this.require(row.id);

    // A cancel during the mint completed it before the token was recorded.
    if (current.status !== "running" || current.token !== token) {
      await this.revoke(current);

      return;
    }

    try {
      const started = await this.runners.getByName(deployRunnerName(row.id)).deployStart({
        projectId: project.id,
        deploymentId: row.id,
        token,
        userId: project.userId,
        repoName: project.repoName,
        artifactRepoId: project.artifactRepoId,
        cloneUrl: project.cloneUrl,
        branch: row.branch,
        sha: row.sha,
        command: deployCommand(plan, accountId),
        timeoutMinutes: plan.timeoutMinutes,
        egressAllowlist: plan.egressAllowlist,
        accountId,
      });

      if (!started.ok) throw new TempoError(started.error.code, started.error.message);

      // A cancel during the start reached the runner before its deployment did.
      if (this.require(row.id).token !== token)
        await this.runners.getByName(deployRunnerName(row.id)).deployCancel(token);
    } catch (e) {
      log("warn", "deploy start failed", { projectId: this.projectId, error: errorText(e) });
      await fail("The deploy container did not start.");
    }
  }

  /** Deletes the stored token and revokes it at Cloudflare (12, Tokens). Retried by the alarm. */
  private async revoke(row: Row): Promise<void> {
    if (row.tokenRevoked) return;
    const project = await this.project().catch(() => null);
    const creds = project ? this.bindings.CREDENTIALS.getByName(project.userId) : null;
    await creds?.deleteSecret(deployTokenKey(row.id));

    let done = row.cfTokenId === null || (row.tokenExpiresAt ?? 0) <= Date.now();

    if (!done && creds && row.accountId && row.cfTokenId) {
      const master = await creds.getSecret(DEPLOY_MASTER_KEY);

      if (master) done = await deleteToken(this.cloudflare, master, row.accountId, row.cfTokenId);
    }

    if (done) this.db.update(deployments).set({ tokenRevoked: 1 }).where(eq(deployments.id, row.id)).run();
  }

  private async revokePending(): Promise<void> {
    const pending = this.db
      .select()
      .from(deployments)
      .where(and(eq(deployments.status, "completed"), eq(deployments.tokenRevoked, 0)))
      .all();

    for (const row of pending) await this.revoke(row);
  }

  /** Deployments past their timeout plus grace complete as timed out (12, Deployments). */
  private async watchdog(): Promise<void> {
    const now = Date.now();

    for (const row of this.db.select().from(deployments).where(eq(deployments.status, "running")).all()) {
      // SAFETY: plan_json is written only by create.
      const { timeoutMinutes } = JSON.parse(row.planJson) as { timeoutMinutes: number };

      if ((row.startedAt ?? now) + timeoutMinutes * 60_000 + 2 * DEPLOY.graceMs > now) continue;
      await this.stop(
        row,
        "timed_out",
        { exitCode: null, summary: "The deployment ran out of time." },
        false,
      );
    }
  }

  private async prune(): Promise<void> {
    const old = this.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(and(eq(deployments.status, "completed"), eq(deployments.tokenRevoked, 1)))
      .orderBy(desc(deployments.number))
      .offset(DEPLOY.keptDeployments)
      .limit(1000)
      .all()
      .map((row) => row.id);

    if (!old.length) return;
    await this.bindings.DATA.delete(old.map((id) => deployLogKey(this.projectId, id)));
    this.db.delete(deployments).where(inArray(deployments.id, old)).run();
  }

  private async arm(): Promise<void> {
    const busy = this.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(ne(deployments.status, "completed"))
      .get();

    const unrevoked = this.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(and(eq(deployments.status, "completed"), eq(deployments.tokenRevoked, 0)))
      .get();

    if (!busy && !unrevoked) {
      await this.ctx.storage.deleteAlarm();

      return;
    }

    const next = Date.now() + DEPLOY.tickMs;
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

  private async requireSettings(userId: string): Promise<void> {
    const creds = this.bindings.CREDENTIALS.getByName(userId);

    if (!(await creds.getSecret(DEPLOY_MASTER_KEY)) || !(await creds.getSecret(DEPLOY_ACCOUNT_KEY)))
      throw new TempoError("DEPLOY_ACCOUNT_NOT_SET");
  }

  private latestRevision() {
    return this.db.select().from(deployConfigs).orderBy(desc(deployConfigs.revision)).get();
  }

  private spec(row: typeof deployConfigs.$inferSelect | undefined): DeploySpec | null {
    if (!row?.specJson) return null;

    // SAFETY: spec_json is written only by updateConfig from parseDeployConfig's validated result.
    return JSON.parse(row.specJson) as DeploySpec;
  }

  private requireSpec(): DeploySpec {
    const spec = this.spec(this.latestRevision());

    if (!spec) throw new TempoError("DEPLOY_NOT_CONFIGURED");

    return spec;
  }

  private configWire(): DeployConfig {
    const row = this.latestRevision();
    const spec = this.spec(row);

    return {
      projectId: this.projectId,
      revision: row?.revision ?? 0,
      source: row?.source ?? "",
      enabled: spec !== null,
      tool: spec?.tool ?? null,
      root: spec?.root ?? "",
      permissions: spec?.permissions ?? [],
      timeoutMinutes: spec?.timeoutMinutes ?? 0,
      egressAllowlist: spec?.egressAllowlist ?? [],
      targets: spec?.targets ?? [],
      updatedAt: row?.createdAt ?? null,
    };
  }

  private require(deploymentId: string): Row {
    const row = this.db.select().from(deployments).where(eq(deployments.id, deploymentId)).get();

    if (!row) throw new TempoError("NOT_FOUND");

    return row;
  }

  private wire(row: Row): Deployment {
    return {
      id: row.id,
      projectId: this.projectId,
      number: row.number,
      target: row.target,
      stage: row.stage,
      branch: row.branch,
      sha: row.sha,
      revision: row.revision,
      trigger: row.trigger,
      status: row.status,
      conclusion: row.conclusion,
      exitCode: row.exitCode,
      summary: row.summary,
      workspaceId: row.workspaceId,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      url: `https://${this.bindings.APP_HOST}/repositories?project=${encodeURIComponent(this.projectId)}&tab=deploys&deployment=${encodeURIComponent(row.id)}`,
    };
  }

  private kv<T>(key: string): T | undefined {
    const row = this.db.select().from(deployKv).where(eq(deployKv.key, key)).get();

    // SAFETY: each key is written by setKv with one fixed JSON type and read with that type.
    return row ? (JSON.parse(row.valueJson) as T) : undefined;
  }

  private setKv(key: string, value: number | string | boolean | null): void {
    const valueJson = JSON.stringify(value);
    this.db
      .insert(deployKv)
      .values({ key, valueJson })
      .onConflictDoUpdate({ target: deployKv.key, set: { valueJson } })
      .run();
  }
}
