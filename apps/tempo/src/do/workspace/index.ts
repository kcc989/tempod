import { eq, lte, isNull } from "drizzle-orm";
import {
  TempoError,
  capture,
  type AgentId,
  type FnOutput,
  type PrState,
  type Result,
  type Source,
  type WorkspaceFnName,
  type WorkspaceSummary,
  newId,
} from "@tempo/protocol";
import { resolveSettings } from "@tempo/settings";
import {
  lifecycleEvents,
  runs,
  attachments,
  egressLog,
  ops,
  sessions,
  turns,
  workspace,
} from "../../db/workspace-do.ts";
import { WORKSPACE_MIGRATIONS, runMigrations } from "../../db/do-migrations.ts";
import { json } from "../../db/json.ts";
import type { Env } from "../../env.ts";
import type { EgressConfig } from "../../egress/rules.ts";
import { BROWSER_APP_HEADER, BROWSER_CDP_HEADER, PREVIEW_HEADER } from "../../http/preview.ts";
import { mcpToEgress } from "../../lib/mcp.ts";
import { errorText, log } from "../../log.ts";
import { assertArtifactRemote, assertArtifactRepositoryIdentity } from "../../artifacts/repositories.ts";
import { openUiChannel } from "./channel.ts";
import {
  connectTempod,
  containerRunning,
  destroyContainer,
  dropCodexLease,
  scheduleReconnect,
  type ConnectHandlers,
} from "./container.ts";
import { CONVERSATION_INTERVAL_MS, markConversationDirty, saveConversation } from "./conversations.ts";
import { discoverModels } from "./model-catalog.ts";
import { ciAlarm, ciCancel, ciLog, ciStart } from "./ci-runner.ts";
import type { CiJobStart } from "../../ci/types.ts";
import { artifactToken } from "../../artifacts/repositories.ts";
import { WorkspaceCore, type Author } from "./core.ts";
import { applyTempodEvent, sendEnv, sendEnvironment } from "./events.ts";
import { getGithubToken, getRepositoryToken, pollPullRequestSafe } from "./git.ts";
import { WorkspaceRpcBase } from "./methods.gen.ts";
import { BROWSER_IDLE_MS, browserConnect, browserFetch, browserIdleCheck, closeBrowser } from "./browser.ts";
import { newPreviewKey, previewEnter, previewFetch } from "./preview.ts";
import { artifactEnter, artifactFetch, artifactRow, artifactToWire } from "./artifacts.ts";
import { finishTurn, recoverSteering, runQueue } from "./queue.ts";
import {
  applyPromptBranch,
  rememberFirstPrompt,
  agentSessionColumns,
  workspaceMethods,
  type MethodInput,
  type Methods,
  type SessionAgentProfile,
} from "./rpc.ts";
import { OpRunner } from "./runner.ts";
import { closeOpenRuns } from "./scripts.ts";
import { afterSkipWithState, operationHooks, operationSteps } from "./steps.ts";
import { openTerminal } from "./terminal.ts";
import { CONTAINER_STATES } from "./transitions.ts";

const HEARTBEAT_MS = 30_000;

const IDLE_CHECK_MS = 60_000;

const PR_POLL_MS = 60_000;

const HOUSEKEEPING_MS = 24 * 60 * 60_000;

const RESTARTS_PER_HOUR = 3;

const EGRESS_LOG_ROWS = 10_000;

const TERMINAL_PATH = /^\/api\/ws\/terminal\/[0-9a-hjkmnp-tv-z]{26}\/(t[1-9])$/;

export interface InitInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly slug: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly source: Source;
  readonly defaultAgent: AgentId;
  readonly agent: AgentId;
  readonly model?: string;
  readonly prompt: { readonly text: string } | null;
  /** For `source.kind = "pr"`: the PR as createWorkspace read it (03, Create a workspace). */
  readonly pr?: { readonly number: number; readonly state: PrState; readonly title: string } | null;
  /** The first session starts from this library agent (02, createWorkspace). */
  readonly savedProfile?: SessionAgentProfile | null;
  readonly author: Author;
  readonly createdAt: number;
}

/**
 * One workspace: the source of truth for its state, transcript and container (00, 02, 03).
 * Owns `ctx.container` under the durable_object scheduling policy.
 */
export class WorkspaceDO extends WorkspaceRpcBase {
  private readonly core: WorkspaceCore;
  private readonly runner: OpRunner;
  private readonly handlers: ConnectHandlers;
  private readonly methods: Methods;
  private queueScheduled = false;
  private alarmScheduled = false;
  private lastHeartbeat = 0;
  private lastIdleCheck = 0;
  private lastPrPoll = 0;
  private modelDiscovery: Promise<FnOutput<"listModels">> | null = null;
  private lastBrowserCheck = 0;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const core = new WorkspaceCore(ctx, env);
    this.core = core;
    this.handlers = {
      onEvent: (event) => applyTempodEvent({ core, runner: this.runner }, event),
      onLost: () => this.onTempodLost(),
    };
    this.runner = new OpRunner(
      core,
      operationSteps(this.handlers),
      operationHooks(
        () => this.scheduleHousekeeping(),
        () => this.onUnplannedStop("The container stopped unexpectedly."),
      ),
      (step, state) => afterSkipWithState(core, step, state),
    );
    core.kickQueue = () => this.kickQueue();
    core.scheduleAlarm = () => this.scheduleAlarm();
    this.methods = workspaceMethods({
      core,
      runner: this.runner,
      ensureAwake: () => this.ensureAwake(),
      requireReady: () => this.requireReady(),
      resendHello: () => this.resendHello(),
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
    void ctx.blockConcurrencyWhile(async () => {
      await runMigrations(core.db, WORKSPACE_MIGRATIONS);

      if (core.wsOrNull()) {
        if (
          core.kv<number>("conversationSavedRevision") === undefined &&
          core.kv<number>("conversationDueAt") === undefined
        )
          markConversationDirty(core);
        await core.lifecycle.load();
        core.lifecycle.kick();
        recoverSteering(core);
        this.runner.recover();
        await this.armAlarm();
      }
    });
  }
  protected rpc<K extends WorkspaceFnName>(name: K, input: MethodInput<K>): Promise<Result<FnOutput<K>>> {
    return capture(() => this.methods[name](input));
  }
  // ---------- internal RPC ----------
  /** Called once by createWorkspace after the D1 insert (03, In WorkspaceDO.init). */
  async init(input: InitInput): Promise<Result<WorkspaceSummary>> {
    return capture(async () => {
      const existing = this.core.wsOrNull();

      if (existing) return this.core.summary(existing);
      const core = this.core;
      const now = input.createdAt;
      const project = await core.project().catch(() => null);
      const preliminary = resolveSettings(project?.overrides ?? {}, {}).effective;

      interface InitialTurn {
        turn: { sessionId: string; turnId: string } | null;
      }

      const first: InitialTurn = { turn: null };
      core.ctx.storage.transactionSync(() => {
        core.db
          .insert(workspace)
          .values({
            id: 1,
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            userId: input.userId,
            slug: input.slug,
            title: input.prompt ? input.prompt.text.trim().slice(0, 60) : input.slug,
            defaultAgent: input.defaultAgent,
            pinned: 0,
            createdAt: now,
            archivedAt: null,
            branch: input.branch,
            baseBranch: input.baseBranch,
            sourceJson: json.source.write(input.source),
            state: "creating",
            stateSince: now,
            errorCode: null,
            errorDetail: null,
            attention: "none",
            setupStatus: "none",
            previewKey: newPreviewKey(),
            settingsJson: json.settings.write(preliminary),
            pushed: 0,
            prNumber: input.pr?.number ?? null,
            prState: input.pr?.state ?? null,
            checksState: null,
            lastActivityAt: now,
            lastViewedAt: now,
            tempodToken: null,
            tempodIncarnation: null,
            lastPushedSha: null,
            forcePushLease: 0,
            autoRestartsJson: "[]",
            tempodAckedSeq: 0,
            imageRef: null,
            summaryRev: 0,
            itemsRev: 0,
          })
          .run();
        core.setKv("author", { ...input.author });

        if (input.pr) core.setKv("prTitle", input.pr.title);
        {
          const sessionId = newId();
          core.db
            .insert(sessions)
            .values({
              id: sessionId,
              agent: input.agent,
              title: "",
              acpSessionId: null,
              status: input.prompt ? "starting" : "idle",
              modeId: null,
              configJson: json.config.write(
                input.savedProfile || input.model
                  ? { model: input.model ?? input.savedProfile?.model ?? "" }
                  : {},
              ),
              modesJson: "[]",
              configOptionsJson: "[]",
              commandsJson: "[]",
              capabilitiesJson: "{}",
              usageJson: "{}",
              handoffPending: 0,
              pendingNote: null,
              generalPromptSent: 0,
              ...agentSessionColumns(input.savedProfile),
              sortOrder: 1,
              createdAt: now,
              updatedAt: now,
              closedAt: null,
            })
            .run();

          if (input.prompt) {
            const turnId = newId();
            core.db
              .insert(turns)
              .values({
                id: turnId,
                sessionId,
                seq: 1,
                queuePos: 1,
                status: "queued",
                promptJson: json.prompt.write({
                  text: input.prompt.text,
                  mentions: [],
                  attachmentIds: [],
                  reviewCommentIds: [],
                }),
                stopReason: null,
                errorCode: null,
                errorDetail: null,
                checkpointId: null,
                reverted: 0,
                queuedAt: now,
                startedAt: null,
                endedAt: null,
              })
              .run();
            core.lifecycle.createPromptChange(turnId, sessionId, input.agent);
            first.turn = { sessionId, turnId };
          }
        }
      });

      if (input.prompt) {
        rememberFirstPrompt(core, input.prompt.text);
        await applyPromptBranch(core, () => this.resendHello());
      }

      await core.lifecycle.load();
      core.lifecycle.kick();
      const firstTurn = first.turn;

      if (input.prompt && firstTurn) {
        core.insertItem({
          sessionId: firstTurn.sessionId,
          turnId: firstTurn.turnId,
          kind: "user_message",
          status: "completed",
          content: { text: input.prompt.text, mentions: [], attachments: [], reviewCommentIds: [] },
          createdAt: now,
        });
      }

      this.runner.insert("create");
      this.runner.insert("housekeeping", {}, Date.now() + HOUSEKEEPING_MS);
      core.setState("starting");
      await this.armAlarm();

      return core.summary();
    });
  }
  async persistConversation(): Promise<void> {
    await saveConversation(this.core, true);
  }
  async discoverModels(userId: string): Promise<Result<FnOutput<"listModels">>> {
    return capture(async () => {
      if (this.ctx.id.name !== `models:${userId}`) throw new TempoError("NOT_FOUND");

      if (this.modelDiscovery) await this.modelDiscovery;
      this.modelDiscovery ??= discoverModels(this.core, userId).finally(() => {
        this.modelDiscovery = null;
      });

      return this.modelDiscovery;
    });
  }

  async agentsChanged(): Promise<Result<{}>> {
    return capture(async () => {
      if (this.core.wsOrNull()) {
        await this.core.lifecycle.load();
        this.core.lifecycle.kick();
      }

      return {};
    });
  }

  async getGithubToken(): Promise<string | null> {
    if (!this.core.wsOrNull()) return null;

    try {
      return await getGithubToken(this.core);
    } catch (e) {
      log("warn", "github token mint failed", { workspaceId: this.core.workspaceId, error: errorText(e) });

      return null;
    }
  }
  /** RepositoryCiDO: a run on this workspace's branch changed (10, Checks, merge and events). */
  async ciChanged(): Promise<void> {
    const row = this.core.wsOrNull();

    if (!row || row.prNumber === null || row.archivedAt !== null) return;
    await pollPullRequestSafe(this.core);
  }
  // ---------- CI runner (10, Execution) ----------
  async ciStart(input: CiJobStart): Promise<Result<Record<string, never>>> {
    return capture(async () => {
      await ciStart(this.core, input);

      return {};
    });
  }
  async ciCancel(token: string): Promise<void> {
    await ciCancel(this.core, token);
  }
  async ciLog(token: string): Promise<Result<{ text: string; truncated: boolean }>> {
    return capture(() => ciLog(this.core, token));
  }
  async getEgressConfig(): Promise<EgressConfig> {
    const ci = this.ciJob();

    if (ci)
      return {
        owner: "tempo",
        repo: ci.repoName,
        provider: "artifacts",
        cloneUrl: assertArtifactRemote(ci.cloneUrl, ci.repoName).href,
        policy: "allowlist",
        allowlist: [...ci.egressAllowlist],
        mcp: [],
        ci: true,
      };
    const project = await this.core.project();

    if (project.provider === "artifacts")
      await assertArtifactRepositoryIdentity(this.core.env, project.name, project.artifactRepoId);
    const environment = await this.core.environment();
    const settings = this.core.settings().environment;
    this.core.setKv("egressPolicy", environment?.egressPolicy ?? settings.egress_policy);

    return {
      owner: project.owner,
      repo: project.name,
      provider: project.provider,
      cloneUrl:
        project.provider === "artifacts"
          ? assertArtifactRemote(project.cloneUrl ?? "", project.name).href
          : null,
      environmentId: environment?.id ?? null,
      policy: environment?.egressPolicy ?? settings.egress_policy,
      allowlist: environment?.egressAllowlist ?? settings.egress_allowlist,
      secrets: environment?.secrets ?? [],
      injectors: environment?.injectors ?? [],
      mcp: (await this.core.mcpServers()).flatMap((r) => mcpToEgress(r) ?? []),
    };
  }

  /** The job of a CI runner instance; never set on a workspace. */
  private ciJob(): CiJobStart | null {
    if (this.core.wsOrNull() || !this.ctx.id.name?.startsWith("ci:")) return null;

    return this.core.kv<CiJobStart>("ciJob") ?? null;
  }
  async getRepositoryToken(): Promise<string | null> {
    const ci = this.ciJob();

    if (ci) {
      try {
        return await artifactToken(this.core.env, ci.repoName, "read", ci.artifactRepoId);
      } catch {
        log("warn", "ci repository credential unavailable", { runner: this.ctx.id.name });

        return null;
      }
    }

    if (!this.core.wsOrNull()) return null;

    try {
      return await getRepositoryToken(this.core);
    } catch {
      log("warn", "repository credential unavailable", { workspaceId: this.core.workspaceId });

      return null;
    }
  }
  async logEgress(row: {
    ts: number;
    method: string;
    host: string;
    path: string;
    status: number;
    ms: number;
    rule: number;
  }): Promise<void> {
    if (!this.core.wsOrNull()) return;
    const blocked = row.rule === 7 || row.rule === 10;
    const known = blocked && this.core.blockedHosts().includes(row.host);
    const [inserted] = this.core.db.insert(egressLog).values(row).returning({ id: egressLog.id }).all();

    // 02 egress_log: newest 10,000 rows only. Ids only grow, so one indexed range delete keeps the bound.
    if (inserted && inserted.id > EGRESS_LOG_ROWS)
      this.core.db
        .delete(egressLog)
        .where(lte(egressLog.id, inserted.id - EGRESS_LOG_ROWS))
        .run();

    if (blocked && !known) this.scheduleEnvironmentPush();
  }
  private environmentPushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEnvironmentPushAt = 0;
  /** environment.set at most every 5 s after a new blocked host (02). */
  private scheduleEnvironmentPush(): void {
    if (this.environmentPushTimer) return;
    const wait = Math.max(0, this.lastEnvironmentPushAt + 5000 - Date.now());
    this.environmentPushTimer = setTimeout(() => {
      this.environmentPushTimer = null;
      this.lastEnvironmentPushAt = Date.now();
      this.ctx.waitUntil(sendEnvironment(this.core));
    }, wait);
  }
  async pushCodexAuth(content: string, version: number): Promise<void> {
    if (
      this.core.runningTurn() ||
      this.core.turnEndInProgress ||
      this.core.queueBusy ||
      this.core.credentialsBusy
    ) {
      if (!this.core.pendingCodexPush || this.core.pendingCodexPush.version < version)
        this.core.pendingCodexPush = { content, version };

      return;
    }

    if (!this.core.tempod?.open) return;
    await this.core.tempod.request("credential.put", { provider: "codex", content, version });
  }
  async getAttachment(id: string): Promise<import("@tempo/protocol").Attachment | null> {
    this.core.ws();
    const a = this.core.db.select().from(attachments).where(eq(attachments.id, id)).get();

    return a ? { id: a.id, name: a.name, mime: a.mime, size: a.sizeBytes } : null;
  }
  async registerAttachment(a: {
    id: string;
    name: string;
    mime: string;
    size: number;
    r2Key: string;
  }): Promise<void> {
    this.core.ws();
    this.core.db
      .insert(attachments)
      .values({
        id: a.id,
        turnId: null,
        name: a.name,
        mime: a.mime,
        sizeBytes: a.size,
        r2Key: a.r2Key,
        containerPath: null,
        createdAt: Date.now(),
      })
      .run();
  }
  /** Re-reads settings after the project's UI overrides change. */
  async refreshSettings(): Promise<void> {
    const core = this.core;

    if (!core.wsOrNull() || !core.tempod?.open) return;

    try {
      const project = await core.project(true);
      const res = await core.tempod.request("settings.read", { overrides: project.overrides });
      core.updateWs({ settingsJson: json.settings.write(res.effective) });
      core.setKv("settingsIssues", {
        warnings: res.warnings,
        errors: res.errors,
        sources: res.sources ?? {},
      });
      core.broadcastDetailSoon();
      await sendEnv(core);
    } catch (e) {
      log("warn", "settings refresh failed", { workspaceId: core.workspaceId, error: errorText(e) });
    }
  }
  /** env.set and environment.set after project secrets or the environment change (02). */
  async refreshEnv(): Promise<void> {
    if (!this.core.wsOrNull()) return;
    await this.core.project(true).catch(() => undefined);
    this.core.broadcastDetailSoon();

    if (!this.core.tempod?.open) return;
    await sendEnv(this.core);
  }
  async previewFetch(request: Request, port: number, cookie: string): Promise<Response> {
    return previewFetch(this.core, request, port, cookie, () => this.tryEnsureAwake());
  }
  /** 05 Enter: the preview cookie value for a good code, else null. */
  async previewEnter(port: number, code: string): Promise<string | null> {
    return previewEnter(this.core, port, code);
  }
  /** 05 Artifact access, Enter: the cookie value and the redirect path for a good code, else null. */
  async artifactEnter(
    artifactId: string,
    code: string,
  ): Promise<{ cookie: string; location: string } | null> {
    return artifactEnter(this.core, artifactId, code);
  }
  async artifactFetch(request: Request, artifactId: string, cookie: string): Promise<Response> {
    return artifactFetch(this.core, request, artifactId, cookie);
  }
  /** For the artifact route (02): one version's metadata, or null. */
  async getArtifact(artifactId: string, version: number): Promise<import("@tempo/protocol").Artifact | null> {
    if (!this.core.wsOrNull()) return null;
    const row = artifactRow(this.core, artifactId, version);

    return row ? artifactToWire(row) : null;
  }
  // ---------- fetch: UI channel, terminal, preview ----------
  override async fetch(request: Request): Promise<Response> {
    const preview = request.headers.get(PREVIEW_HEADER);

    if (preview) {
      const sep = preview.indexOf(":");

      return this.previewFetch(request, Number(preview.slice(0, sep)), sep < 0 ? "" : preview.slice(sep + 1));
    }

    if (request.headers.has(BROWSER_CDP_HEADER)) return browserConnect(this.core, request);
    const browserPort = request.headers.get(BROWSER_APP_HEADER);

    if (browserPort)
      return browserFetch(this.core, request, Number(browserPort), () => this.tryEnsureAwake());
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/ws/workspace/")) return openUiChannel(this.core, request);
    const term = TERMINAL_PATH.exec(url.pathname);

    if (term) {
      const row = this.core.wsOrNull();

      if (!row) return new Response("Not found", { status: 404 });

      if (row.state === "archived" || row.state === "archiving")
        return new Response("Workspace archived", { status: 409 });
      this.tryEnsureAwake();
      const cols = Number(url.searchParams.get("cols") ?? "80");
      const rows = Number(url.searchParams.get("rows") ?? "24");

      return openTerminal(this.core, term[1]!, cols, rows, (deadline) => this.waitReady(deadline));
    }

    return new Response("Not found", { status: 404 });
  }
  override async webSocketMessage(): Promise<void> {
    // UI sockets only send ping, answered by the auto-response.
  }
  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {
      // already closed
    }
  }
  // ---------- alarm: ops, heartbeat, idle check, PR polling ----------
  override async alarm(): Promise<void> {
    const core = this.core;

    if (!core.wsOrNull()) {
      if (core.kv("catalogUserId")) {
        core.tempod?.close();
        core.tempod = null;

        if (core.container?.running) await core.container.destroy();
        await core.credentials().dropCodexLease(core.workspaceId);
        core.setKv("catalogToken", null);
      }

      if (this.ciJob()) await ciAlarm(core);

      return;
    }

    await core.lifecycle.runs.timeouts();
    core.lifecycle.kick();
    await this.runner.runDue();
    const now = Date.now();

    if (this.containerExpected() && now - this.lastHeartbeat >= HEARTBEAT_MS - 500) {
      this.lastHeartbeat = now;
      await this.heartbeat();
    }

    if (containerRunning(core) && now - this.lastIdleCheck >= IDLE_CHECK_MS - 500) {
      this.lastIdleCheck = now;
      this.idleCheck();
    }

    if (
      core.uiSockets().length > 0 &&
      core.ws().prNumber !== null &&
      now - this.lastPrPoll >= PR_POLL_MS - 500
    ) {
      this.lastPrPoll = now;
      await pollPullRequestSafe(core);
    }

    const conversationDue = core.kv<number>("conversationDueAt");

    if (conversationDue !== undefined && conversationDue <= Date.now()) {
      try {
        await saveConversation(core);
      } catch {
        core.setKv("conversationDueAt", Date.now() + CONVERSATION_INTERVAL_MS);
        log("warn", "conversation artifact upload failed", { workspaceId: core.workspaceId });
      }
    }

    if (core.ws().browserSessionId !== null && now - this.lastBrowserCheck >= BROWSER_IDLE_MS - 500) {
      this.lastBrowserCheck = now;
      await browserIdleCheck(core, now);
    }

    await this.armAlarm();
  }
  private containerExpected(): boolean {
    const state = this.core.wsOrNull()?.state;

    return containerRunning(this.core) || CONTAINER_STATES.some((expected) => expected === state);
  }
  private async armAlarm(): Promise<void> {
    const core = this.core;

    if (!core.wsOrNull()) return;
    const candidates: number[] = [];
    const conversationDue = core.kv<number>("conversationDueAt");

    if (conversationDue !== undefined) candidates.push(conversationDue);

    if (core.lifecycle.retryAt !== null) candidates.push(core.lifecycle.retryAt);
    const roleDeadline = core.lifecycle.runs.nextDeadline();

    if (roleDeadline !== null) candidates.push(roleDeadline);

    if (core.db.select().from(lifecycleEvents).where(isNull(lifecycleEvents.dispatchedAt)).get())
      candidates.push(Date.now() + 1000);
    const due = this.runner.nextDueAt();

    if (due !== null) candidates.push(due);

    if (this.containerExpected()) candidates.push(this.lastHeartbeat + HEARTBEAT_MS);

    if (containerRunning(core)) candidates.push(this.lastIdleCheck + IDLE_CHECK_MS);

    if (core.uiSockets().length > 0 && core.ws().prNumber !== null)
      candidates.push(this.lastPrPoll + PR_POLL_MS);

    if (core.ws().browserSessionId !== null) candidates.push(this.lastBrowserCheck + BROWSER_IDLE_MS);

    if (candidates.length === 0) {
      await core.ctx.storage.deleteAlarm();

      return;
    }

    const at = Math.max(Date.now(), Math.min(...candidates));
    const current = await core.ctx.storage.getAlarm();

    if (current === null || Math.abs(current - at) > 250) await core.ctx.storage.setAlarm(at);
  }
  private scheduleAlarm(): void {
    if (this.alarmScheduled) return;
    this.alarmScheduled = true;
    queueMicrotask(() => {
      this.alarmScheduled = false;
      this.ctx.waitUntil(
        this.armAlarm().catch((e) => log("error", "arm alarm failed", { error: errorText(e) })),
      );
    });
  }
  private scheduleHousekeeping(): void {
    if (!this.runner.find("housekeeping"))
      this.runner.insert("housekeeping", {}, Date.now() + HOUSEKEEPING_MS);
  }
  private kickQueue(): void {
    if (this.queueScheduled) return;
    this.queueScheduled = true;
    queueMicrotask(() => {
      this.queueScheduled = false;

      if (!this.core.wsOrNull()) return;
      this.core.lifecycle.kick();
      this.ctx.waitUntil(
        runQueue(
          this.core,
          () => this.runner.hasPendingOrRunning(),
          () => applyPromptBranch(this.core, () => this.resendHello()),
        ).catch((e) =>
          log("error", "queue runner failed", { workspaceId: this.core.workspaceId, error: errorText(e) }),
        ),
      );
    });
  }
  /** Heartbeat (03): the container still runs and the tempod socket is open. */
  private async heartbeat(): Promise<void> {
    const core = this.core;
    const state = core.state;

    if (!CONTAINER_STATES.some((value) => value === state)) return;
    const starting = this.runner.find("create") ?? this.runner.find("wake");

    if (!containerRunning(core)) {
      // container.start owns the container while it (re)starts it; sleep and archive skip what needs it.
      if (starting?.step === "container.start") return;

      if (starting) this.runner.cancel(starting.id);
      else if (this.runner.hasPendingOrRunning(["sleep", "archive"])) return;
      await this.onUnplannedStop("The container stopped unexpectedly.");

      return;
    }

    if (!core.tempod?.open) this.onTempodLost();
  }
  /** Idle check (03, Activity): sleep after sleep_after_idle_minutes with nothing active. */
  private idleCheck(): void {
    const core = this.core;
    const row = core.ws();

    if (row.state !== "ready" || this.runner.hasPendingOrRunning()) return;

    if (core.isActive(core.terminals.size)) {
      core.touchActivity();

      return;
    }

    const lastBusy = Math.max(row.lastActivityAt, core.kv<number>("lastBusyAt") ?? 0);

    if (Date.now() - lastBusy >= core.settings().environment.sleep_after_idle_minutes * 60_000) {
      log("info", "workspace idle; sleeping", { workspaceId: row.workspaceId });
      this.runner.insert("sleep");
    }
  }
  private onTempodLost(): void {
    const core = this.core;
    const state = core.wsOrNull()?.state;

    if (!state || !CONTAINER_STATES.includes(state) || !containerRunning(core)) return;
    // Only these two steps connect on their own; every later step needs the socket back.
    const op = this.runner.find("create") ?? this.runner.find("wake");

    if (op && (op.step === "container.start" || op.step === "tempod.connect")) return;
    scheduleReconnect(core, this.handlers, async () => {
      if (!CONTAINER_STATES.some((expected) => expected === core.wsOrNull()?.state)) return;

      // The container is about to go: a create or wake op cannot finish on it, so the wake below replaces it.
      for (const kind of ["create", "wake"] as const) {
        const stale = this.runner.find(kind);

        if (stale) this.runner.cancel(stale.id);
      }

      await destroyContainer(core, "tempod unreachable").catch(() => undefined);
      await this.onUnplannedStop("Lost contact with the workspace. Restarting it.");
    });
  }
  /** Container stopped without Tempo asking (03, Failure handling): interrupt, then wake (3 per hour). */
  private async onUnplannedStop(text: string): Promise<void> {
    const core = this.core;
    const running = core.runningTurn();

    if (running) {
      finishTurn(core, running.id, "interrupted", { stopReason: null });
      core.notice("warning", text, running.sessionId, running.id);
    } else core.notice("warning", text);

    for (const run of core.db.select().from(runs).where(eq(runs.status, "running")).all())
      core.lifecycle.runs.fail(run, "RUN_TURN_FAILED");
    closeOpenRuns(core);
    core.closeTerminals(1001, "container stopped");
    core.tempod?.close(1000, "container stopped");
    core.tempod = null;
    core.pendingCodexAuth = null;
    core.pendingCodexPush = null;
    core.tempodStopping = false;
    core.liveSessions.clear();
    core.updateWs({ tempodToken: null });
    dropCodexLease(core);
    closeBrowser(core);
    const now = Date.now();

    const recent = json.autoRestarts
      .read(core.ws().autoRestartsJson, [])
      .filter((t) => now - t < 60 * 60_000);

    if (recent.length >= RESTARTS_PER_HOUR) {
      core.updateWs({ autoRestartsJson: json.autoRestarts.write(recent) });
      core.setState("error", {
        code: "CONTAINER_START_FAILED",
        detail: "The container stopped 3 times in an hour.",
      });

      return;
    }

    core.updateWs({ autoRestartsJson: json.autoRestarts.write([...recent, now]) });
    core.setState("starting");

    if (!this.runner.find("wake")) this.runner.insert("wake");
  }
  // ---------- wake triggers ----------
  private ensureAwake(): void {
    const core = this.core;
    const state = core.state;

    if (state === "archived" || state === "archiving") throw new TempoError("WORKSPACE_ARCHIVED");

    if (state !== "sleeping" && state !== "error" && state !== "stopping") return;

    if (this.runner.find("wake") || this.runner.find("create")) return;
    this.runner.insert("wake");

    if (state === "sleeping" || state === "error") core.setState("starting");
  }
  private tryEnsureAwake(): void {
    try {
      this.ensureAwake();
    } catch {
      // archived: nothing to wake
    }
  }
  private requireReady(): void {
    const core = this.core;
    const state = core.state;

    if (
      (state === "ready" || state === "working" || state === "setting_up") &&
      core.tempod?.open &&
      containerRunning(core)
    )
      return;
    this.ensureAwake();
    throw new TempoError("CONTAINER_NOT_READY");
  }
  private async waitReady(deadline: number): Promise<void> {
    while (Date.now() < deadline) {
      const state = this.core.wsOrNull()?.state;

      if (!state || state === "archived" || state === "archiving" || state === "error") break;

      if ((state === "ready" || state === "working" || state === "setting_up") && this.core.tempod?.open)
        return;
      await new Promise((r) => setTimeout(r, 500));
    }

    throw new TempoError("CONTAINER_NOT_READY");
  }
  /** A second hello on the open socket updates tempod's branch, base branch and env. */
  private async resendHello(): Promise<void> {
    const core = this.core;

    if (!core.tempod?.open) return;
    const row = core.ws();
    const project = await core.project();
    core.tempod.sendHello({
      type: "hello",
      v: 1,
      incarnation: row.tempodIncarnation,
      lastAckedSeq: row.tempodAckedSeq,
      workspace: {
        id: row.workspaceId,
        slug: row.slug,
        branch: row.branch,
        baseBranch: row.baseBranch,
        repo: { owner: project.owner, name: project.name },
      },
      env: await core.scriptEnv(),
    });
  }
  /** For tests and diagnostics: reconnect without waiting for the heartbeat. */
  async reconnectTempod(): Promise<void> {
    await connectTempod(this.core, this.handlers);
  }
  /** Test helper: the op table. */
  async listOps(): Promise<Array<{ kind: string; status: string; step: string }>> {
    return this.core.db.select({ kind: ops.kind, status: ops.status, step: ops.step }).from(ops).all();
  }
}
