import { DurableObject } from "cloudflare:workers";
import type { ProjectResources } from "../deploy/cf-gate.ts";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, ne } from "drizzle-orm";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import {
  DEPLOY_PERMISSIONS,
  TempoError,
  capture,
  newId,
  type DeployConclusion,
  type CloudflareGrant,
  type DeployConfig,
  type DeployPermission,
  type DeployRolloutWorker,
  type DeployTrigger,
  type Deployment,
  type ProductionError,
  type ProjectProfile,
  type Result,
} from "@tempo/protocol";
import { parseDeployConfig, parseProfile, type DeploySpec } from "@tempo/settings";
import { artifactHeadSha, validateArtifactBranch } from "../artifacts/repositories.ts";
import {
  appDeploySchema,
  deployConfigs,
  deployEvents,
  deployKv,
  deployments,
  prodErrors,
  profiles,
  manifests,
  grants,
} from "../db/app-deploy-do.ts";
import { ISSUES, type ParsedIssue } from "../deploy/issues.ts";
import { projects } from "../db/d1.ts";
import { APP_DEPLOY_MIGRATIONS, runMigrations } from "../db/do-migrations.ts";
import {
  createToken,
  deleteToken,
  permissionGroups,
  tokenPolicies,
  workerResources,
  type CloudflareApi,
} from "../deploy/cloudflare.ts";
import {
  ROLLOUT,
  RolloutError,
  moveTraffic,
  recordVersions,
  restorePrevious,
  smokeTest,
  type CloudflareTarget,
} from "../deploy/rollout.ts";
import {
  DEPLOY_ACCOUNT_KEY,
  DEPLOY_MASTER_KEY,
  deployCommand,
  deployLogKey,
  deployRunnerName,
  deployTokenKey,
  agentCloudflareTokenKey,
  type DeployJobResult,
  type DeployJobStart,
  type DeployPlan,
} from "../deploy/types.ts";
import type { Env } from "../env.ts";
import { errorText, log } from "../log.ts";
import type { ProjectInfo } from "./repository-ci.ts";

/** 12, Deployments and Tokens. */
export const AGENT_CF = { resourcesTtlMs: 10 * 60_000, tokenMs: 60 * 60_000 } as const;

export const DEPLOY = {
  keptDeployments: 200,
  keptRevisions: 20,
  pageSize: 50,
  graceMs: 5 * 60_000,
  tokenSlackMs: 15 * 60_000,
  tickMs: 30_000,
  keptEvents: 2000,
  rollbackTokenMs: 15 * 60_000,
} as const;

type EventType = typeof deployEvents.$inferInsert.type;

/** An event payload (12, Gradual rollout: Events). Never a token. */
interface EventPayload {
  readonly occurredAt?: number | null;
  readonly requestedAt?: number;
  readonly worker?: string;
  readonly versionId?: string;
  readonly previousVersionId?: string | null;
  readonly percentage?: number;
  readonly cloudflareDeploymentId?: string | null;
  readonly by?: "owner" | "tempo";
  readonly reason?: string;
  readonly errorId?: string;
  readonly title?: string;
  readonly workers?: ReadonlyArray<DeployRolloutWorker>;
  readonly errors?: ReadonlyArray<string>;
}

type Row = typeof deployments.$inferSelect;

type ErrorRow = typeof prodErrors.$inferSelect;

/** What `startErrorFix` needs to create the fix workspace (12, Production errors). */
export type FixContext =
  | { readonly kind: "existing"; readonly workspaceId: string }
  | { readonly kind: "busy" }
  | { readonly kind: "create"; readonly baseBranch: string | null; readonly prompt: string };

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
  /** Smoke-test requests (12, Gradual rollout); tests replace it. */
  smokeFetch = (request: Request) => fetch(request);
  /** Deployments whose rollout step is in progress in this isolate. */
  private readonly rolling = new Set<string>();
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

      if (row.phase === "canary") await this.rollback(row, "cancelled by the owner", "cancelled");
      else if (row.status !== "completed")
        await this.stop(row, "cancelled", { exitCode: null, summary: null });

      return this.wire(this.require(deploymentId));
    });
  }

  /** 12, Gradual rollout: Owner rollback. */
  async rollbackDeployment(deploymentId: string): Promise<Result<Deployment>> {
    return capture(async () => {
      const requestedAt = Date.now();
      const row = this.require(deploymentId);
      const nothing = () => new TempoError("VALIDATION_FAILED", undefined, "Nothing to roll back to.");

      if (row.status !== "completed" || row.conclusion !== "success" || row.rolledBackAt !== null)
        throw nothing();

      if (this.plan(row).rollout !== "gradual") throw nothing();

      const newest = this.db
        .select({ id: deployments.id })
        .from(deployments)
        .where(
          and(
            eq(deployments.target, row.target),
            eq(deployments.status, "completed"),
            eq(deployments.conclusion, "success"),
          ),
        )
        .orderBy(desc(deployments.number))
        .get();

      if (newest?.id !== row.id) throw nothing();

      const busy = this.db
        .select({ id: deployments.id })
        .from(deployments)
        .where(ne(deployments.status, "completed"))
        .get();

      if (busy) throw new TempoError("WORKSPACE_BUSY");
      const workers = this.rolloutWorkers(row);

      if (workers.length === 0 || workers.some((w) => w.previousVersionId === null)) throw nothing();

      const project = await this.project();
      const creds = this.bindings.CREDENTIALS.getByName(project.userId);
      const master = await creds.getSecret(DEPLOY_MASTER_KEY);
      const accountId = await creds.getSecret(DEPLOY_ACCOUNT_KEY);

      if (!master || !accountId) throw new TempoError("DEPLOY_ACCOUNT_NOT_SET");

      const groups = await permissionGroups(this.cloudflare, master, accountId);

      const minted = await createToken(this.cloudflare, master, accountId, {
        name: `tempo-rollback-${project.id}-${row.number}`,
        expiresAt: Date.now() + DEPLOY.rollbackTokenMs,
        policies: tokenPolicies(groups, ["workers"], accountId),
      });

      const cf: CloudflareTarget = { api: this.cloudflare, token: minted.value, accountId };
      const { restored, errors } = await this.restoreAll(cf, workers, `tempo-rollback ${row.number}`);
      await deleteToken(this.cloudflare, master, accountId, minted.id);

      this.db
        .update(deployments)
        .set({
          phase: "rolled_back",
          rolledBackAt: Date.now(),
          rolloutJson: JSON.stringify(restored),
          summary: errors.length ? `Rollback incomplete: ${errors.join("; ")}`.slice(0, 1000) : row.summary,
        })
        .where(eq(deployments.id, row.id))
        .run();
      this.event(row.id, "deploy.rolled_back", { by: "owner", workers: restored, errors, requestedAt });

      return this.wire(this.require(row.id));
    });
  }

  /** The gate failed for a deployment in canary (12, Gradual rollout; 13, L-ADR-5). */
  async failGate(deploymentId: string, reason: string): Promise<void> {
    const row = this.db.select().from(deployments).where(eq(deployments.id, deploymentId)).get();

    if (!row || row.phase !== "canary" || row.gateFailure !== null) return;
    this.db.update(deployments).set({ gateFailure: reason }).where(eq(deployments.id, row.id)).run();
    await this.rollback(this.require(row.id), reason, "failure");
    await this.pump();
  }

  /** 13, L-ADR-7: deploy and production error events in [from, to), for the loop report. */
  async loopEvents(
    from: number,
    to: number,
  ): Promise<Array<{ deploymentId: string; type: string; at: number; payloadJson: string }>> {
    return this.db
      .select({
        deploymentId: deployEvents.deploymentId,
        type: deployEvents.type,
        at: deployEvents.at,
        payloadJson: deployEvents.payloadJson,
      })
      .from(deployEvents)
      .where(and(gte(deployEvents.at, from), lt(deployEvents.at, to)))
      .orderBy(asc(deployEvents.at), asc(deployEvents.id))
      .all();
  }

  // ---------- agent Cloudflare API access (13, L-ADR-8) ----------
  /** The project's account and resources: its Workers and what they bind. Cached for 10 minutes. */
  async cloudflareResources(): Promise<Result<ProjectResources | null>> {
    return capture(async () => {
      const config = this.configWire();

      if (!config.enabled) return null;
      const cached = this.kv<{ at: number; value: ProjectResources }>("cfResources");

      if (cached && Date.now() - cached.at < AGENT_CF.resourcesTtlMs) return cached.value;
      const project = await this.project();
      const creds = this.bindings.CREDENTIALS.getByName(project.userId);

      const [master, accountId] = await Promise.all([
        creds.getSecret(DEPLOY_MASTER_KEY),
        creds.getSecret(DEPLOY_ACCOUNT_KEY),
      ]);

      if (!master || !accountId) return null;
      const resources = new Map<string, boolean>();

      for (const target of config.targets) {
        const production = target.key === "production" || target.stage === "production";

        for (const worker of target.workers) {
          for (const id of [
            `worker:${worker}`,
            ...(await workerResources(this.cloudflare, master, accountId, worker)),
          ])
            resources.set(id, (resources.get(id) ?? false) || production);
        }
      }

      const value: ProjectResources = {
        accountId,
        resources: [...resources].map(([id, production]) => ({ id, production })),
      };

      this.setJsonKv("cfResources", JSON.stringify({ at: Date.now(), value }));

      return value;
    });
  }

  /** Mints the workspace's Cloudflare token from the deploy permissions; the value goes to CredentialDO only. */
  async mintAgentToken(
    workspaceId: string,
  ): Promise<Result<{ tokenId: string; expiresAt: number; permissions: DeployPermission[] } | null>> {
    return capture(async () => {
      const config = this.configWire();

      if (!config.enabled) return null;
      const project = await this.project();
      const creds = this.bindings.CREDENTIALS.getByName(project.userId);

      const [master, accountId] = await Promise.all([
        creds.getSecret(DEPLOY_MASTER_KEY),
        creds.getSecret(DEPLOY_ACCOUNT_KEY),
      ]);

      if (!master || !accountId) return null;
      const expiresAt = Date.now() + AGENT_CF.tokenMs;
      const groups = await permissionGroups(this.cloudflare, master, accountId);

      const minted = await createToken(this.cloudflare, master, accountId, {
        name: `tempo-agent-${workspaceId}`,
        expiresAt,
        policies: tokenPolicies(groups, this.grantedPermissions(), accountId),
      });

      await creds.putSecret(agentCloudflareTokenKey(workspaceId), minted.value);

      return { tokenId: minted.id, expiresAt, permissions: this.grantedPermissions() };
    });
  }

  async revokeAgentToken(tokenId: string): Promise<Result<boolean>> {
    return capture(async () => {
      const project = await this.project();
      const creds = this.bindings.CREDENTIALS.getByName(project.userId);

      const [master, accountId] = await Promise.all([
        creds.getSecret(DEPLOY_MASTER_KEY),
        creds.getSecret(DEPLOY_ACCOUNT_KEY),
      ]);

      return master && accountId ? deleteToken(this.cloudflare, master, accountId, tokenId) : true;
    });
  }

  // ---------- Cloudflare access grants (12, Access requests and grants) ----------
  /** `workers` and the owner-approved permissions, in catalog order. */
  private grantedPermissions(): DeployPermission[] {
    const granted = new Set(
      this.db
        .select({ p: grants.permission })
        .from(grants)
        .all()
        .map((r) => r.p),
    );

    return DEPLOY_PERMISSIONS.filter((p) => p === "workers" || granted.has(p));
  }

  private grantList(): CloudflareGrant[] {
    const rows = new Map(
      this.db
        .select()
        .from(grants)
        .all()
        .map((r) => [r.permission, r.grantedAt]),
    );

    return this.grantedPermissions().map((permission) => ({
      permission,
      grantedAt: rows.get(permission) ?? null,
    }));
  }

  async listGrants(): Promise<Result<CloudflareGrant[]>> {
    return capture(async () => this.grantList());
  }

  /** Adds owner-approved permissions. A permission already granted keeps its first approval. */
  async grant(input: {
    permissions: ReadonlyArray<DeployPermission>;
    workspaceId: string;
    requestId: string;
  }): Promise<Result<CloudflareGrant[]>> {
    return capture(async () => {
      const now = Date.now();

      for (const permission of input.permissions) {
        if (permission === "workers") continue;
        this.db
          .insert(grants)
          .values({ permission, grantedAt: now, workspaceId: input.workspaceId, requestId: input.requestId })
          .onConflictDoNothing()
          .run();
      }

      return this.grantList();
    });
  }

  async removeGrant(permission: DeployPermission): Promise<Result<CloudflareGrant[]>> {
    return capture(async () => {
      if (permission === "workers")
        throw new TempoError("VALIDATION_FAILED", undefined, "workers is always granted.");
      this.db.delete(grants).where(eq(grants.permission, permission)).run();

      return this.grantList();
    });
  }

  // ---------- capability manifests (14, C-ADR-1) ----------
  /** The project's manifest revision for this hash: the same hash keeps its number, a new one gets the next. */
  async manifestRevision(sha256: string): Promise<Result<number>> {
    return capture(async () => {
      const known = this.db.select().from(manifests).where(eq(manifests.sha256, sha256)).get();

      if (known) return known.revision;
      const last = this.db.select().from(manifests).orderBy(desc(manifests.revision)).get();
      const revision = (last?.revision ?? 0) + 1;
      this.db.insert(manifests).values({ sha256, revision, createdAt: Date.now() }).run();

      return revision;
    });
  }

  // ---------- project profile (13, L-ADR-3) ----------
  async getProfile(): Promise<Result<ProjectProfile>> {
    return capture(async () => this.profileWire());
  }

  async updateProfile(input: { source: string; revision: number }): Promise<Result<ProjectProfile>> {
    return capture(async () => {
      parseProfile(input.source);
      const current = this.latestProfile();

      if (input.revision !== (current?.revision ?? 0)) throw new TempoError("PROFILE_CHANGED");
      const revision = (current?.revision ?? 0) + 1;
      this.db.insert(profiles).values({ revision, source: input.source, createdAt: Date.now() }).run();
      this.db
        .delete(profiles)
        .where(lt(profiles.revision, revision - DEPLOY.keptRevisions + 1))
        .run();

      return this.profileWire();
    });
  }

  private latestProfile() {
    return this.db.select().from(profiles).orderBy(desc(profiles.revision)).get();
  }

  private profileWire(): ProjectProfile {
    const row = this.latestProfile();

    return {
      projectId: this.projectId,
      revision: row?.revision ?? 0,
      source: row?.source ?? "",
      updatedAt: row?.createdAt ?? null,
    };
  }

  // ---------- production errors (12, Production errors) ----------
  /** One webhook delivery. Returns the error and whether a new fix should start on its own. */
  async ingestIssue(issue: ParsedIssue): Promise<{ errorId: string; isNew: boolean; autoFix: boolean }> {
    const now = Date.now();
    const spec = this.spec(this.latestRevision());
    const configured = new Set(spec?.targets.flatMap((t) => t.workers) ?? []);
    const worker = issue.worker !== null && configured.has(issue.worker) ? issue.worker : null;
    const existing = this.db.select().from(prodErrors).where(eq(prodErrors.issueKey, issue.issueKey)).get();
    let errorId: string;

    if (existing) {
      errorId = existing.id;
      this.db
        .update(prodErrors)
        .set({
          occurrences: existing.occurrences + 1,
          lastSeenAt: now,
          text: issue.text,
          fixedAt: null,
          fixCheckAt: null,
          versionId: issue.versionId ?? existing.versionId,
        })
        .where(eq(prodErrors.id, existing.id))
        .run();

      if (existing.fixedAt !== null)
        this.event(existing.deploymentId ?? "", "prod.error.seen", {
          errorId,
          title: issue.title,
          occurredAt: issue.occurredAt,
        });
    } else {
      errorId = newId();
      this.db
        .insert(prodErrors)
        .values({
          id: errorId,
          issueKey: issue.issueKey,
          worker,
          versionId: issue.versionId,
          deploymentId: this.deploymentFor(worker, issue.versionId),
          title: issue.title,
          text: issue.text,
          occurrences: 1,
          firstSeenAt: now,
          lastSeenAt: now,
          fixWorkspaceId: null,
          fixClaimedAt: null,
          fixCheckAt: null,
          fixedAt: null,
        })
        .run();
      this.event(this.require0(errorId).deploymentId ?? "", "prod.error.seen", {
        errorId,
        title: issue.title,
        occurredAt: issue.occurredAt,
      });
      this.pruneErrors();
    }

    for (const row of this.db.select().from(deployments).where(eq(deployments.phase, "canary")).all()) {
      const workers = this.rolloutWorkers(row);

      const hit =
        issue.versionId !== null
          ? workers.some((w) => w.versionId === issue.versionId)
          : worker !== null && workers.some((w) => w.name === worker);

      if (hit) await this.failGate(row.id, `new production error: ${issue.title}`);
    }

    await this.arm();

    return { errorId, isNew: !existing, autoFix: !existing && (spec?.autoFix ?? false) };
  }

  async listErrors(): Promise<Result<ProductionError[]>> {
    return capture(async () =>
      this.db
        .select()
        .from(prodErrors)
        .orderBy(desc(prodErrors.lastSeenAt))
        .limit(100)
        .all()
        .map((row) => this.errorWire(row)),
    );
  }

  /** Claims the fix of one error, so two callers do not create two workspaces. */
  async fixContext(errorId: string): Promise<Result<FixContext>> {
    return capture(async () => {
      const row = this.require0(errorId);

      if (row.fixWorkspaceId) return { kind: "existing", workspaceId: row.fixWorkspaceId };
      const now = Date.now();

      if (row.fixClaimedAt !== null && row.fixClaimedAt + ISSUES.claimMs > now) return { kind: "busy" };
      this.db.update(prodErrors).set({ fixClaimedAt: now }).where(eq(prodErrors.id, row.id)).run();

      const deployment = row.deploymentId
        ? this.db.select().from(deployments).where(eq(deployments.id, row.deploymentId)).get()
        : undefined;

      const previous = deployment
        ? this.db
            .select({ sha: deployments.sha })
            .from(deployments)
            .where(
              and(
                eq(deployments.target, deployment.target),
                eq(deployments.conclusion, "success"),
                lt(deployments.number, deployment.number),
              ),
            )
            .orderBy(desc(deployments.number))
            .get()
        : undefined;

      const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

      const prompt = [
        `Fix this production error in ${row.worker ?? "the app"}.`,
        row.title,
        row.text,
        deployment
          ? `Deployment #${deployment.number} (${deployment.target}), version ${row.versionId ?? "unknown"}, commits ${previous?.sha ?? "unknown"}..${deployment.sha}.`
          : `Version ${row.versionId ?? "unknown"}.`,
        `Seen ${row.occurrences} times between ${iso(row.firstSeenAt)} and ${iso(row.lastSeenAt)} (UTC).`,
      ].join("\n");

      return { kind: "create", baseBranch: deployment?.branch ?? null, prompt };
    });
  }

  async setFixWorkspace(errorId: string, workspaceId: string | null): Promise<void> {
    this.db
      .update(prodErrors)
      .set(workspaceId ? { fixWorkspaceId: workspaceId } : { fixClaimedAt: null })
      .where(and(eq(prodErrors.id, errorId), isNull(prodErrors.fixWorkspaceId)))
      .run();
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

    if (!row || row.status !== "running" || row.token !== result.token || row.phase !== null) return;

    if (result.conclusion === "success" && this.plan(row).rollout === "gradual") {
      await this.startRollout(row, result.exitCode);
      await this.pump();

      return;
    }

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
    this.checkFixes();
    await this.advanceRollouts();
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
      permissions: this.grantedPermissions(),
      stage: config.stage,
      target,
      rollout: config.rollout,
      workers: config.workers,
      smoke: config.smoke,
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

    if (conclusion === "success")
      this.db
        .update(prodErrors)
        .set({ fixCheckAt: Date.now() + ROLLOUT.observeMs })
        .where(and(isNotNull(prodErrors.fixWorkspaceId), isNull(prodErrors.fixedAt)))
        .run();
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

    const expiresAt =
      now +
      plan.timeoutMinutes * 60_000 +
      DEPLOY.tokenSlackMs +
      (plan.rollout === "gradual" ? ROLLOUT.observeMs : 0);

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
      if (row.phase !== null) continue;

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

    const checking = this.db
      .select({ id: prodErrors.id })
      .from(prodErrors)
      .where(isNotNull(prodErrors.fixCheckAt))
      .get();

    if (!busy && !unrevoked && !checking) {
      await this.ctx.storage.deleteAlarm();

      return;
    }

    const next = Date.now() + DEPLOY.tickMs;
    const current = await this.ctx.storage.getAlarm();

    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }

  // ---------- rollout (12, Gradual rollout) ----------
  private async rolloutTarget(row: Row): Promise<CloudflareTarget | null> {
    const project = await this.project().catch(() => null);

    const token = project
      ? await this.bindings.CREDENTIALS.getByName(project.userId).getSecret(deployTokenKey(row.id))
      : null;

    return token && row.accountId ? { api: this.cloudflare, token, accountId: row.accountId } : null;
  }

  private async startRollout(row: Row, exitCode: number | null): Promise<void> {
    if (this.rolling.has(row.id)) return;
    this.rolling.add(row.id);

    try {
      const plan = this.plan(row);
      const fail = (summary: string) => this.complete(row, "failure", { exitCode, summary });
      const cf = await this.rolloutTarget(row);

      if (!cf) return void (await fail("The deploy token is gone."));
      let recorded;

      try {
        recorded = await recordVersions(cf, plan.workers ?? [], row.startedAt ?? row.createdAt);
      } catch (e) {
        return void (await fail(
          e instanceof RolloutError ? e.message : "Cloudflare did not list the Worker versions.",
        ));
      }

      for (const w of recorded.workers)
        this.event(row.id, "deploy.version.uploaded", { worker: w.name, versionId: w.versionId });

      const percent = recorded.full === null ? ROLLOUT.canaryPercent : 100;
      const moved: DeployRolloutWorker[] = [];

      for (const w of recorded.workers) {
        if (w.percentage === 100) {
          moved.push(w);
          continue;
        }

        try {
          const next = await moveTraffic(cf, w, percent, `tempo-deploy-${row.number} ${percent}%`);
          moved.push(next);
          this.trafficEvent(row.id, next);
        } catch {
          moved.push(w);
          this.saveRollout(row.id, "canary", moved.concat(recorded.workers.slice(moved.length)), null);

          return void (await this.rollback(
            this.require(row.id),
            `Cloudflare refused the ${percent}% step for ${w.name}`,
            "failure",
          ));
        }
      }

      if (recorded.full !== null) {
        this.saveRollout(row.id, "full", moved, null);

        return void (await this.complete(this.require(row.id), "success", {
          exitCode,
          summary: `${recorded.full} deployed at 100% without a gradual rollout.`,
        }));
      }

      this.saveRollout(row.id, "canary", moved, Date.now() + ROLLOUT.observeMs);
      this.db.update(deployments).set({ exitCode }).where(eq(deployments.id, row.id)).run();
      const reason = await smokeTest(this.smokeFetch, plan.smoke ?? [], moved[0]!);

      if (reason !== null) {
        this.db.update(deployments).set({ gateFailure: reason }).where(eq(deployments.id, row.id)).run();
        await this.rollback(this.require(row.id), reason, "failure");
      }
    } finally {
      this.rolling.delete(row.id);
    }
  }

  /** Promotes each canary whose window passed, or rolls back one whose gate failed. */
  private async advanceRollouts(): Promise<void> {
    const now = Date.now();

    for (const row of this.db.select().from(deployments).where(eq(deployments.phase, "canary")).all()) {
      if (row.status !== "running" || this.rolling.has(row.id)) continue;

      if (row.gateFailure !== null) await this.rollback(row, row.gateFailure, "failure");
      else if ((row.canaryUntil ?? 0) <= now) await this.promote(row);
    }
  }

  private async promote(row: Row): Promise<void> {
    this.rolling.add(row.id);

    try {
      const cf = await this.rolloutTarget(row);

      if (!cf) return void (await this.rollback(row, "the deploy token is gone", "failure"));
      const workers = this.rolloutWorkers(row);
      const moved: DeployRolloutWorker[] = [];

      for (const w of workers) {
        if (w.percentage === 100) {
          moved.push(w);
          continue;
        }

        try {
          const next = await moveTraffic(cf, w, 100, `tempo-deploy-${row.number} 100%`);
          moved.push(next);
          this.trafficEvent(row.id, next);
        } catch {
          this.saveRollout(row.id, "canary", moved.concat(workers.slice(moved.length)), row.canaryUntil);

          return void (await this.rollback(
            this.require(row.id),
            `Cloudflare refused the 100% step for ${w.name}`,
            "failure",
          ));
        }
      }

      this.saveRollout(row.id, "promoted", moved, row.canaryUntil);
      await this.complete(this.require(row.id), "success", { exitCode: row.exitCode, summary: null });
    } finally {
      this.rolling.delete(row.id);
    }
  }

  /** Step 5: every moved Worker back to its previous version, then complete. */
  private async rollback(row: Row, reason: string, conclusion: "failure" | "cancelled"): Promise<void> {
    if (row.phase !== "canary" || row.status === "completed") return;
    const cf = await this.rolloutTarget(row);
    const workers = this.rolloutWorkers(row);
    let restored = workers;
    let errors = ["the deploy token is gone"];

    if (cf) ({ restored, errors } = await this.restoreAll(cf, workers, `tempo-rollback ${row.number}`));

    this.saveRollout(row.id, "rolled_back", restored, row.canaryUntil);
    this.db.update(deployments).set({ rolledBackAt: Date.now() }).where(eq(deployments.id, row.id)).run();
    this.event(row.id, "deploy.rolled_back", { by: "tempo", reason, workers: restored, errors });

    await this.complete(this.require(row.id), conclusion, {
      exitCode: row.exitCode,
      summary: `Rolled back: ${reason}.${errors.length ? ` Not restored: ${errors.join("; ")}.` : ""}`.slice(
        0,
        1000,
      ),
    });
  }

  private async restoreAll(
    cf: CloudflareTarget,
    workers: ReadonlyArray<DeployRolloutWorker>,
    message: string,
  ): Promise<{ restored: DeployRolloutWorker[]; errors: string[] }> {
    const restored: DeployRolloutWorker[] = [];
    const errors: string[] = [];

    for (const w of workers) {
      if (w.percentage === 0) {
        restored.push(w);
        continue;
      }

      const result = await restorePrevious(cf, w, message);

      if (result.ok) restored.push(result.worker);
      else {
        errors.push(result.error);
        restored.push(w);
      }
    }

    return { restored, errors };
  }

  private saveRollout(
    id: string,
    phase: NonNullable<Row["phase"]>,
    workers: ReadonlyArray<DeployRolloutWorker>,
    canaryUntil: number | null,
  ): void {
    this.db
      .update(deployments)
      .set({ phase, canaryUntil, rolloutJson: JSON.stringify(workers) })
      .where(eq(deployments.id, id))
      .run();
  }

  private trafficEvent(deploymentId: string, w: DeployRolloutWorker): void {
    this.event(deploymentId, "deploy.traffic.changed", {
      worker: w.name,
      versionId: w.versionId,
      previousVersionId: w.previousVersionId,
      percentage: w.percentage,
      cloudflareDeploymentId: w.cloudflareDeploymentId,
    });
  }

  private event(deploymentId: string, type: EventType, payload: EventPayload): void {
    this.db
      .insert(deployEvents)
      .values({ id: newId(), deploymentId, type, at: Date.now(), payloadJson: JSON.stringify(payload) })
      .run();

    const old = this.db
      .select({ id: deployEvents.id })
      .from(deployEvents)
      .orderBy(desc(deployEvents.at), desc(deployEvents.id))
      .offset(DEPLOY.keptEvents)
      .limit(1000)
      .all()
      .map((e) => e.id);

    if (old.length) this.db.delete(deployEvents).where(inArray(deployEvents.id, old)).run();
  }

  private rolloutWorkers(row: Row): DeployRolloutWorker[] {
    // SAFETY: rollout_json is written only by saveRollout and rollbackDeployment.
    return row.rolloutJson ? (JSON.parse(row.rolloutJson) as DeployRolloutWorker[]) : [];
  }

  private plan(row: Row): DeployPlan {
    // SAFETY: plan_json is written only by create from the parsed spec.
    return JSON.parse(row.planJson) as DeployPlan;
  }

  /** An error with no occurrence for the observe window after a later success is fixed. */
  private checkFixes(): void {
    const now = Date.now();

    for (const row of this.db.select().from(prodErrors).where(isNotNull(prodErrors.fixCheckAt)).all()) {
      if (row.fixCheckAt! > now) continue;
      const fixed = row.lastSeenAt < row.fixCheckAt! - ROLLOUT.observeMs;

      this.db
        .update(prodErrors)
        .set({ fixCheckAt: null, fixedAt: fixed ? now : null })
        .where(eq(prodErrors.id, row.id))
        .run();

      if (fixed)
        this.event(row.deploymentId ?? "", "prod.error.fixed", { errorId: row.id, title: row.title });
    }
  }

  private deploymentFor(worker: string | null, versionId: string | null): string | null {
    const rows = this.db
      .select()
      .from(deployments)
      .where(isNotNull(deployments.rolloutJson))
      .orderBy(desc(deployments.number))
      .limit(DEPLOY.keptDeployments)
      .all();

    const byVersion = versionId
      ? rows.find((r) => this.rolloutWorkers(r).some((w) => w.versionId === versionId))
      : undefined;

    const byWorker =
      worker === null
        ? undefined
        : rows.find(
            (r) => r.conclusion === "success" && this.rolloutWorkers(r).some((w) => w.name === worker),
          );

    return (byVersion ?? byWorker)?.id ?? null;
  }

  private pruneErrors(): void {
    const cutoff = Date.now() - ISSUES.keptMs;
    this.db.delete(prodErrors).where(lt(prodErrors.lastSeenAt, cutoff)).run();

    const old = this.db
      .select({ id: prodErrors.id })
      .from(prodErrors)
      .orderBy(desc(prodErrors.lastSeenAt))
      .offset(ISSUES.kept)
      .limit(1000)
      .all()
      .map((r) => r.id);

    if (old.length) this.db.delete(prodErrors).where(inArray(prodErrors.id, old)).run();
  }

  private require0(errorId: string): ErrorRow {
    const row = this.db.select().from(prodErrors).where(eq(prodErrors.id, errorId)).get();

    if (!row) throw new TempoError("NOT_FOUND");

    return row;
  }

  private errorWire(row: ErrorRow): ProductionError {
    const deployment = row.deploymentId
      ? this.db
          .select({ number: deployments.number })
          .from(deployments)
          .where(eq(deployments.id, row.deploymentId))
          .get()
      : undefined;

    return {
      id: row.id,
      projectId: this.projectId,
      worker: row.worker,
      versionId: row.versionId,
      deploymentId: row.deploymentId,
      deploymentNumber: deployment?.number ?? null,
      title: row.title,
      text: row.text,
      occurrences: row.occurrences,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      fixWorkspaceId: row.fixWorkspaceId,
      fixedAt: row.fixedAt,
    };
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
      permissions: this.grantedPermissions(),
      timeoutMinutes: spec?.timeoutMinutes ?? 0,
      egressAllowlist: spec?.egressAllowlist ?? [],
      targets: spec?.targets ?? [],
      autoFix: spec?.autoFix ?? false,
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
      rollout:
        row.phase === null
          ? null
          : {
              phase: row.phase,
              canaryUntil: row.canaryUntil,
              rolledBackAt: row.rolledBackAt,
              workers: this.rolloutWorkers(row),
            },
    };
  }

  private kv<T>(key: string): T | undefined {
    const row = this.db.select().from(deployKv).where(eq(deployKv.key, key)).get();

    // SAFETY: each key is written by setKv with one fixed JSON type and read with that type.
    return row ? (JSON.parse(row.valueJson) as T) : undefined;
  }

  private setJsonKv(key: string, valueJson: string): void {
    this.db
      .insert(deployKv)
      .values({ key, valueJson })
      .onConflictDoUpdate({ target: deployKv.key, set: { valueJson } })
      .run();
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
