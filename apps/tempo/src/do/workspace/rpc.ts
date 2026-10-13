import { promptSlug } from "@tempo/cities";
import { and, asc, desc, eq, gte, inArray, lt, ne, sql, type SQL } from "drizzle-orm";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import {
  EGRESS_BLOCK_RULES,
  TempoError,
  instanceLabel,
  newId,
  type AgentId,
  type CheckpointInfo,
  type Diagnostics,
  type EgressStatusFilter,
  type FnInput,
  type FnOutput,
  type ReviewComment,
  type Session,
  type Turn,
  type WorkspaceFnName,
  type AgentProfile,
  type SessionCustomAgent,
} from "@tempo/protocol";
import { environments, workspaces } from "../../db/d1.ts";
import { EMPTY_PROMPT, json, readItemContent } from "../../db/json.ts";
import {
  attachments,
  checkpoints,
  egressLog,
  environmentProposals,
  events,
  items,
  permissions,
  reviewComments,
  scriptRuns,
  sessions,
  snapshots,
  turns,
  type ReviewCommentRow,
} from "../../db/workspace-do.ts";
import { WORKSPACE_MIGRATIONS, runMigrations } from "../../db/do-migrations.ts";
import { github } from "../../github/provider.ts";
import { errorText, log } from "../../log.ts";
import { containerRunning, requireTempod } from "./container.ts";
import { parseJson, type WorkspaceCore } from "./core.ts";
import { saveConversation } from "./conversations.ts";
import { sendEnv } from "./events.ts";
import { defaultPrBody, getGithubToken, refreshPullRequest, requirePushed } from "./git.ts";
import {
  DEFAULT_MODE,
  dropQueuedTurnsOf,
  ensureSessionLive,
  finishTurn,
  requireCredential,
  steerQueued,
} from "./queue.ts";
import { browserLiveView } from "./browser.ts";
import { openPreview, rotatePreviewKey } from "./preview.ts";
import { listArtifacts, openArtifact } from "./artifacts.ts";
import type { OpRunner } from "./runner.ts";
import { runToWire, runningRuns, startScript, SETUP_TIMEOUT_MS } from "./scripts.ts";

/** Session columns for a custom agent (02, sessions). */
export const customSessionColumns = (custom: SessionAgentProfile | null | undefined) =>
  custom
    ? {
        customAgentId: custom.customAgent.id,
        customAgentName: custom.customAgent.name,
        customAgentCommit: custom.customAgent.commitSha,
        profileJson: JSON.stringify(custom.profile),
      }
    : {};

/** A custom agent resolved by the Worker (01, Custom agents): what the session row stores. */
export interface SessionAgentProfile {
  readonly customAgent: SessionCustomAgent;
  readonly profile: AgentProfile;
  readonly model: string;
}

/**
 * The method input: the server function's input minus workspaceId (02, WorkspaceDO RPC).
 * createSession also takes the custom agent the Worker resolved from `customAgentId`.
 */
export type MethodInput<K extends WorkspaceFnName> = Omit<FnInput<K>, "workspaceId"> &
  (K extends "createSession" ? { readonly custom?: SessionAgentProfile } : unknown);
export type Methods = { [K in WorkspaceFnName]: (input: MethodInput<K>) => Promise<FnOutput<K>> };

export interface RpcRuntime {
  readonly core: WorkspaceCore;
  readonly runner: OpRunner;
  /** Starts a wake if the workspace sleeps or failed. Throws WORKSPACE_ARCHIVED when archived. */
  ensureAwake(): void;
  /** The container is up and tempod is connected; else starts a wake and throws CONTAINER_NOT_READY. */
  requireReady(): void;
  resendHello(): Promise<void>;
}

// Control characters are part of git's rule (check-ref-format), so the class names them.
// oxlint-disable no-control-regex
const BRANCH_RE =
  /^(?![-./]|HEAD$|.*(?:\/\.|\/\/|\.\.|@\{|\\|\.lock\/))[^\x00-\x20~^:?*[\x7f]+(?<![./]|\.lock)$/;
// oxlint-enable no-control-regex
export const isValidBranch = (b: string): boolean =>
  b.length > 0 && b.length <= 250 && BRANCH_RE.test(b) && b !== "@";

/** 02 getDiagnostics: host contains the text (any case) and the status matches, over every stored row. */
const egressFilter = (host?: string, status: EgressStatusFilter = "all"): SQL | undefined => {
  const conds: SQL[] = [];
  const q = host?.toLowerCase() ?? "";
  if (q !== "") conds.push(sql`instr(lower(${egressLog.host}), ${q}) > 0`);
  if (status === "blocked") conds.push(inArray(egressLog.rule, [...EGRESS_BLOCK_RULES]));
  else if (status !== "all") {
    const floor = Number(status[0]) * 100;
    conds.push(gte(egressLog.status, floor), lt(egressLog.status, floor + 100));
  }
  return conds.length > 0 ? and(...conds) : undefined;
};

const reviewToWire = (r: ReviewCommentRow): ReviewComment => ({
  id: r.id,
  path: r.path,
  lineStart: r.lineStart,
  lineEnd: r.lineEnd,
  side: r.side as ReviewComment["side"],
  body: r.body,
  status: r.status as ReviewComment["status"],
  sentTurnId: r.sentTurnId,
  createdAt: r.createdAt,
});

const notArchived = (core: WorkspaceCore) => {
  const s = core.state;
  if (s === "archived" || s === "archiving") throw new TempoError("WORKSPACE_ARCHIVED");
};

const sessionBusy = (core: WorkspaceCore, sessionId: string) => {
  const running = core.runningTurn();
  if (running && running.sessionId === sessionId) throw new TempoError("SESSION_BUSY");
  if (
    core.db
      .select()
      .from(turns)
      .where(and(eq(turns.sessionId, sessionId), eq(turns.steeringPending, 1)))
      .get()
  )
    throw new TempoError("SESSION_BUSY");
};

const branchInUse = async (core: WorkspaceCore, branch: string): Promise<boolean> => {
  const row = core.ws();
  const hit = await drizzleD1(core.env.DB)
    .select({ id: workspaces.id, archivedAt: workspaces.archivedAt })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.projectId, row.projectId),
        eq(workspaces.branch, branch),
        ne(workspaces.id, row.workspaceId),
      ),
    )
    .all();
  return hit.some((w) => w.archivedAt === null);
};

const namingLocks = new WeakMap<WorkspaceCore, Promise<void>>();

const withBranchNaming = async <T>(core: WorkspaceCore, action: () => Promise<T>): Promise<T> => {
  const previous = namingLocks.get(core) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  namingLocks.set(core, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
  }
};

export const rememberFirstPrompt = (core: WorkspaceCore, text: string): void => {
  if (core.kv<boolean>("firstPromptSeen")) return;
  core.setKv("firstPromptSeen", true);
  if (core.kv<boolean>("branchManuallyNamed") || core.ws().pushed === 1) return;
  if (parseJson<{ kind: string }>(core.ws().sourceJson, { kind: "branch" }).kind !== "new") return;
  const slug = promptSlug(text);
  if (slug) core.setKv("promptBranch", `${core.settings().git.branch_prefix}${slug}`);
};

export const applyPromptBranch = async (
  core: WorkspaceCore,
  resendHello: () => Promise<void>,
): Promise<void> => {
  return withBranchNaming(core, async () => {
    const base = core.kv<string>("promptBranch");
    if (!base || core.kv<boolean>("branchManuallyNamed") || core.ws().pushed === 1) return;
    if (!isValidBranch(base)) {
      core.setKv("promptBranch", undefined);
      return;
    }
    const row = core.ws();
    const rev = row.summaryRev + 1;
    let next = base;
    for (let n = 2; ; n++) {
      if (core.kv<boolean>("branchManuallyNamed")) return;
      if (await branchInUse(core, next)) {
        next = `${base}-${n}`;
        continue;
      }
      try {
        // Reserve atomically: the asynchronous summary publication cannot settle name collisions.
        await drizzleD1(core.env.DB)
          .update(workspaces)
          .set({ branch: next, summaryRev: rev })
          .where(eq(workspaces.id, row.workspaceId))
          .run();
        break;
      } catch (error) {
        const detail = String((error as { cause?: unknown } | null)?.cause ?? error);
        if (!detail.includes("UNIQUE") || !detail.includes("workspaces.branch")) throw error;
        next = `${base}-${n}`;
      }
    }
    core.updateWs({ summaryRev: rev });
    try {
      if (core.tempod?.open && containerRunning(core) && next !== row.branch)
        await core.tempod.request("git.renameBranch", { from: row.branch, to: next });
    } catch (error) {
      core.publish();
      throw error;
    }
    core.updateWs({ branch: next });
    core.publish();
    await resendHello();
    core.setKv("promptBranch", undefined);
  });
};

export const makeMethods = (rt: RpcRuntime): Methods => {
  const { core, runner } = rt;

  const awaitOp = async <T>(kind: "revert" | "commit_push", input: Record<string, unknown>): Promise<T> => {
    const op = runner.insert(kind, input);
    core.broadcastDetailSoon();
    return (await runner.wait(op.id)) as T;
  };

  return {
    getWorkspace: async () => core.detail(),

    renameWorkspace: async ({ title }) => {
      core.updateWs({ title: title.trim().slice(0, 200) });
      core.publish();
      return {};
    },

    renameBranch: async ({ branch }) =>
      withBranchNaming(core, async () => {
        const row = core.ws();
        const next = branch.trim();
        if (!isValidBranch(next)) throw new TempoError("BRANCH_INVALID");
        if (row.pushed === 1) throw new TempoError("BRANCH_ALREADY_PUSHED");
        if (next === row.branch) {
          core.setKv("branchManuallyNamed", true);
          core.setKv("promptBranch", undefined);
          return {};
        }
        if (await branchInUse(core, next)) throw new TempoError("BRANCH_IN_USE");
        if (core.tempod?.open && containerRunning(core)) {
          await core.tempod.request("git.renameBranch", { from: row.branch, to: next });
        }
        core.setKv("branchManuallyNamed", true);
        core.setKv("promptBranch", undefined);
        core.updateWs({ branch: next });
        core.publish();
        await rt.resendHello();
        return {};
      }),

    setWorkspaceEnvironment: async ({ environmentId }) => {
      if (environmentId !== null) {
        const found = await drizzleD1(core.env.DB)
          .select({ id: environments.id })
          .from(environments)
          .where(and(eq(environments.id, environmentId), eq(environments.userId, core.ws().userId)))
          .get();
        if (!found) throw new TempoError("NOT_FOUND", undefined, "environment not found");
      }
      core.updateWs({ environmentId });
      core.publish();
      core.ctx.waitUntil(sendEnv(core));
      return {};
    },

    resolveEnvironmentProposal: async ({ proposalId, status }) => {
      const row = core.db
        .select({ id: environmentProposals.id })
        .from(environmentProposals)
        .where(and(eq(environmentProposals.id, proposalId), eq(environmentProposals.status, "pending")))
        .get();
      if (!row) throw new TempoError("NOT_FOUND", undefined, "no pending proposal with that id");
      core.db
        .update(environmentProposals)
        .set({ status })
        .where(eq(environmentProposals.id, proposalId))
        .run();
      core.broadcastDetailSoon();
      return {};
    },

    setPinned: async ({ pinned }) => {
      core.updateWs({ pinned: pinned ? 1 : 0 });
      core.publish();
      return {};
    },

    markViewed: async () => {
      core.updateWs({ lastViewedAt: Date.now() });
      core.recomputeAttention(false);
      core.publish();
      return {};
    },

    wakeWorkspace: async () => {
      const s = core.state;
      if (s === "archived") throw new TempoError("WORKSPACE_ARCHIVED");
      if (s === "archiving") throw new TempoError("WORKSPACE_BUSY");
      rt.ensureAwake();
      return {};
    },

    sleepWorkspace: async () => {
      const s = core.state;
      if (s === "archived") throw new TempoError("WORKSPACE_ARCHIVED");
      if (s === "sleeping") return {};
      if (s !== "ready" || runner.hasPendingOrRunning()) throw new TempoError("WORKSPACE_BUSY");
      runner.insert("sleep");
      return {};
    },

    archiveWorkspace: async () => {
      const s = core.state;
      if (s === "archived" || s === "archiving") return {};
      if (!["ready", "working", "sleeping", "error"].includes(s)) throw new TempoError("WORKSPACE_BUSY");
      core.setState("archiving");
      runner.insert("archive");
      return {};
    },

    restoreWorkspace: async () => {
      const s = core.state;
      if (s !== "archived" && s !== "archiving") return {};
      if (runner.find("restore")) return {};
      if (s === "archived" && (await branchInUse(core, core.ws().branch)))
        throw new TempoError("BRANCH_IN_USE");
      runner.insert("restore");
      return {};
    },

    deleteWorkspace: async () => {
      const row = core.ws();
      if (row.state !== "archived") throw new TempoError("WORKSPACE_NOT_ARCHIVED");
      await saveConversation(core, true);
      for (const prefix of ["checkpoints", "homes", "attachments", "logs", "artifacts"]) {
        let cursor: string | undefined;
        do {
          const list = await core.env.DATA.list({
            prefix: `${prefix}/${row.workspaceId}/`,
            ...(cursor ? { cursor } : {}),
          });
          if (list.objects.length) await core.env.DATA.delete(list.objects.map((o) => o.key));
          cursor = list.truncated ? list.cursor : undefined;
        } while (cursor);
      }
      await drizzleD1(core.env.DB).delete(workspaces).where(eq(workspaces.id, row.workspaceId)).run();
      await core.env.USER_HUB.getByName(row.userId).remove(row.workspaceId);
      core.closeTerminals(1001, "deleted");
      for (const ws of core.uiSockets()) {
        try {
          ws.close(4404, "workspace deleted");
        } catch {
          // already closed
        }
      }
      await core.ctx.storage.deleteAlarm();
      await core.ctx.storage.deleteAll();
      // Recreate the empty tables, so later calls on this instance see "not found", not "no such table".
      await runMigrations(core.db, WORKSPACE_MIGRATIONS);
      return {};
    },

    openPreview: ({ port }) => openPreview(core, port),

    rotatePreviewKey: async () => {
      rotatePreviewKey(core);
      return {};
    },

    getBrowserLiveView: () => browserLiveView(core),

    setBaseBranch: async ({ baseBranch }) => {
      const row = core.ws();
      if (row.prNumber !== null) throw new TempoError("PR_EXISTS");
      const project = await core.project();
      const exists = await github.branchExists(
        await getGithubToken(core),
        { owner: project.owner, name: project.name },
        baseBranch,
      );
      if (!exists) throw new TempoError("NOT_FOUND", undefined, "branch not on origin");
      core.updateWs({ baseBranch });
      core.publish();
      await rt.resendHello();
      return {};
    },

    getDiagnostics: async ({ egressHost, egressStatus }): Promise<Diagnostics> => {
      const row = core.ws();
      return {
        ops: runner.recent(50).map((o) => ({
          id: o.id,
          kind: o.kind as Diagnostics["ops"][number]["kind"],
          status: o.status as Diagnostics["ops"][number]["status"],
          step: o.step,
          attempt: o.attempt,
          errorCode: o.errorCode,
          errorDetail: o.errorDetail,
          timings: parseJson<{ timings?: Record<string, number> }>(o.stateJson, {}).timings ?? {},
          createdAt: o.createdAt,
          updatedAt: o.updatedAt,
        })),
        container: {
          state: core.state,
          running: containerRunning(core),
          instance: instanceLabel(core.settings().environment.instance),
          imageRef: row.imageRef,
          snapshots: core.db
            .select()
            .from(snapshots)
            .orderBy(desc(snapshots.createdAt))
            .all()
            .map((s) => ({
              id: s.id,
              name: s.name,
              sizeBytes: s.sizeBytes,
              imageRef: s.imageRef,
              createdAt: s.createdAt,
              lastRestoredAt: s.lastRestoredAt,
              unusable: s.unusable === 1,
            })),
          tempodVersion: core.tempodVersion,
          incarnation: row.tempodIncarnation,
        },
        logs: core.db
          .select()
          .from(events)
          .where(eq(events.kind, "log"))
          .orderBy(desc(events.id))
          .limit(200)
          .all()
          .map((e) => {
            const p = parseJson<{ level?: string; msg?: string; data?: unknown }>(e.payloadJson, {});
            return { ts: e.receivedAt, level: p.level ?? "info", msg: p.msg ?? "", data: p.data };
          }),
        egress: core.db
          .select()
          .from(egressLog)
          .where(egressFilter(egressHost, egressStatus))
          .orderBy(desc(egressLog.id))
          .limit(500)
          .all()
          .map(({ id: _id, ...rest }) => rest),
        sessions: core.db
          .select()
          .from(sessions)
          .orderBy(asc(sessions.sortOrder))
          .all()
          .map((s) => ({
            id: s.id,
            agent: s.agent as AgentId,
            acpSessionId: s.acpSessionId,
            capabilities: json.capabilities.read(s.capabilitiesJson, {}),
            live: core.liveSessions.has(s.id),
          })),
      };
    },

    createSession: async ({ agent, model, modeId, custom }): Promise<Session> => {
      notArchived(core);
      await requireCredential(core, agent);
      const chosenModel = model || custom?.model || "";
      const now = Date.now();
      const id = newId();
      const order =
        core.db.select({ o: sessions.sortOrder }).from(sessions).orderBy(desc(sessions.sortOrder)).get()?.o ??
        0;
      core.db
        .insert(sessions)
        .values({
          id,
          agent,
          title: "",
          acpSessionId: null,
          status: "starting",
          modeId: modeId ?? null,
          configJson: json.config.write(chosenModel ? { model: chosenModel } : {}),
          modesJson: "[]",
          configOptionsJson: "[]",
          commandsJson: "[]",
          capabilitiesJson: "{}",
          usageJson: "{}",
          handoffPending: 0,
          pendingNote: null,
          generalPromptSent: 0,
          ...customSessionColumns(custom),
          sortOrder: order + 1,
          createdAt: now,
          updatedAt: now,
          closedAt: null,
        })
        .run();
      const session = core.sessionToWire(core.sessionRow(id));
      core.broadcast({ type: "session", session });
      rt.ensureAwake();
      if (core.tempod?.open && ["ready", "working"].includes(core.state)) {
        core.ctx.waitUntil(
          ensureSessionLive(core, core.sessionRow(id)).catch((e) => {
            core.updateSession(id, { status: "idle" });
            core.notice("error", `${errorText(e)}`, id);
          }),
        );
      }
      return session;
    },

    closeSession: async ({ sessionId }) => {
      const s = core.sessionRow(sessionId);
      if (s.status === "closed") return {};
      sessionBusy(core, sessionId);
      dropQueuedTurnsOf(core, sessionId);
      if (core.liveSessions.has(sessionId)) {
        core.liveSessions.delete(sessionId);
        await core.tempod?.request("session.close", { sessionId }).catch(() => undefined);
      }
      core.updateSession(sessionId, { status: "closed", closedAt: Date.now() });
      return {};
    },

    renameSession: async ({ sessionId, title }) => {
      core.sessionRow(sessionId);
      core.updateSession(sessionId, { title: title.trim().slice(0, 200) });
      return {};
    },

    sendPrompt: async ({
      sessionId,
      text,
      mentions,
      attachmentIds,
      reviewCommentIds,
      delivery,
    }): Promise<Turn> => {
      notArchived(core);
      const session = core.sessionRow(sessionId);
      if (session.status === "closed")
        throw new TempoError("VALIDATION_FAILED", undefined, "the chat is closed");
      if (!text.trim() && attachmentIds.length === 0 && reviewCommentIds.length === 0) {
        throw new TempoError("VALIDATION_FAILED", undefined, "the message is empty");
      }
      await requireCredential(core, session.agent as AgentId);
      const atts = attachmentIds.length
        ? core.db
            .select()
            .from(attachments)
            .where(inArray(attachments.id, [...attachmentIds]))
            .all()
        : [];
      if (atts.length !== new Set(attachmentIds).size)
        throw new TempoError("VALIDATION_FAILED", undefined, "unknown attachment");
      const firstPrompt = !core.db.select({ id: turns.id }).from(turns).get();
      const drafts = reviewCommentIds.length
        ? core.db
            .select({ id: reviewComments.id })
            .from(reviewComments)
            .where(and(inArray(reviewComments.id, [...reviewCommentIds]), eq(reviewComments.status, "draft")))
            .all()
        : [];
      if (drafts.length !== new Set(reviewCommentIds).size)
        throw new TempoError("VALIDATION_FAILED", undefined, "unknown or already sent review comment");
      const now = Date.now();
      const turnId = newId();
      const prompt = {
        text,
        mentions: [...mentions],
        attachmentIds: [...attachmentIds],
        reviewCommentIds: [...reviewCommentIds],
      };
      core.ctx.storage.transactionSync(() => {
        core.db
          .insert(turns)
          .values({
            id: turnId,
            sessionId,
            seq: core.nextTurnSeq(),
            queuePos: core.nextQueuePos(),
            status: "queued",
            promptJson: json.prompt.write(prompt),
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
        if (reviewCommentIds.length) {
          core.db
            .update(reviewComments)
            .set({ status: "sent", sentTurnId: turnId })
            .where(and(inArray(reviewComments.id, [...reviewCommentIds]), eq(reviewComments.status, "draft")))
            .run();
        }
        if (atts.length)
          core.db
            .update(attachments)
            .set({ turnId })
            .where(inArray(attachments.id, [...attachmentIds]))
            .run();
      });
      if (firstPrompt) rememberFirstPrompt(core, text);
      const turn = core.turnToWire(core.turnRow(turnId));
      core.broadcast({ type: "turn", turn });
      core.insertItem({
        sessionId,
        turnId,
        kind: "user_message",
        status: "completed",
        content: {
          text,
          mentions: prompt.mentions,
          attachments: atts.map((a) => ({ id: a.id, name: a.name, mime: a.mime })),
          reviewCommentIds: prompt.reviewCommentIds,
        },
      });
      core.broadcastDetailSoon();
      if (delivery === "steer") {
        const running = await steerQueued(core, core.turnRow(turnId));
        if (running) return running;
      }
      // A prompt in sleeping, error or stopping (03, sendPrompt step 5): stopping wakes after the sleep op.
      rt.ensureAwake();
      core.kickQueue();
      return turn;
    },

    cancelTurn: async ({ turnId }) => {
      const turn = core.turnRow(turnId);
      if (turn.steeringPending) throw new TempoError("TURN_NOT_ACTIVE");
      if (turn.status === "queued") {
        finishTurn(core, turnId, "cancelled", { stopReason: "cancelled" });
        core.broadcastDetailSoon();
        return {};
      }
      if (turn.status !== "running") throw new TempoError("TURN_NOT_ACTIVE");
      try {
        await requireTempod(core).request("session.cancel", { sessionId: turn.sessionId, turnId });
      } catch {
        if (finishTurn(core, turnId, "cancelled", { stopReason: "cancelled" })) core.kickQueue();
      }
      return {};
    },

    editQueuedTurn: async ({ turnId, text }): Promise<Turn> => {
      const turn = core.turnRow(turnId);
      if (turn.status !== "queued" || turn.steeringPending) throw new TempoError("TURN_NOT_QUEUED");
      const prompt = { ...json.prompt.read(turn.promptJson, EMPTY_PROMPT), text };
      const updated = core.updateTurn(turnId, { promptJson: json.prompt.write(prompt) });
      const item = core.db
        .select()
        .from(items)
        .where(and(eq(items.turnId, turnId), eq(items.kind, "user_message")))
        .get();
      if (item)
        core.updateItem(item.id, { content: { ...readItemContent(item.kind, item.contentJson), text } });
      return updated;
    },

    deleteQueuedTurn: async ({ turnId }) => {
      const turn = core.turnRow(turnId);
      if (turn.status !== "queued" || turn.steeringPending) throw new TempoError("TURN_NOT_QUEUED");
      core.deleteTurn(turnId, () =>
        core.db
          .update(reviewComments)
          .set({ status: "draft", sentTurnId: null })
          .where(eq(reviewComments.sentTurnId, turnId))
          .run(),
      );
      core.broadcastDetailSoon();
      return {};
    },

    reorderQueue: async ({ turnIds }) => {
      const queued = core.queuedTurns().map((t) => t.id);
      if (
        queued.length !== turnIds.length ||
        new Set(turnIds).size !== turnIds.length ||
        !turnIds.every((id) => queued.includes(id))
      ) {
        throw new TempoError("VALIDATION_FAILED", undefined, "turnIds must list every queued turn once");
      }
      turnIds.forEach((id, i) => core.updateTurn(id, { queuePos: i + 1 }));
      core.broadcastDetailSoon();
      return {};
    },

    setSessionMode: async ({ sessionId, modeId }) => {
      core.sessionRow(sessionId);
      sessionBusy(core, sessionId);
      if (core.liveSessions.has(sessionId))
        await requireTempod(core).request("session.setMode", { sessionId, modeId });
      core.updateSession(sessionId, { modeId });
      return {};
    },

    setSessionConfig: async ({ sessionId, configId, value }) => {
      const s = core.sessionRow(sessionId);
      sessionBusy(core, sessionId);
      const options = json.configOptions.read(s.configOptionsJson, []);
      const isModel = options.find((o) => o.id === configId)?.category === "model";
      const config: Record<string, unknown> = { ...json.config.read(s.configJson, {}), [configId]: value };
      if (isModel && typeof value === "string") config["model"] = value;
      if (core.liveSessions.has(sessionId)) {
        const res = await requireTempod(core).request("session.setConfig", { sessionId, configId, value });
        core.updateSession(sessionId, {
          configJson: json.config.write(config),
          configOptionsJson: json.configOptions.write(res.configOptions),
        });
      } else core.updateSession(sessionId, { configJson: json.config.write(config) });
      return {};
    },

    respondPermission: async ({ requestId, optionId }) => {
      const p = core.db.select().from(permissions).where(eq(permissions.requestId, requestId)).get();
      if (!p || p.status !== "pending") throw new TempoError("NOT_FOUND");
      const options = json.permissionOptions.read(p.optionsJson, []);
      if (!options.some((o) => o.optionId === optionId))
        throw new TempoError("VALIDATION_FAILED", undefined, "unknown option");
      await requireTempod(core).request("permission.respond", { requestId, optionId });
      core.db
        .update(permissions)
        .set({ status: "answered", chosenOptionId: optionId, answeredAt: Date.now() })
        .where(eq(permissions.requestId, requestId))
        .run();
      const item = core.itemRow(p.itemId);
      if (item)
        core.updateItem(item.id, {
          content: { ...readItemContent(item.kind, item.contentJson), chosenOptionId: optionId },
        });
      core.recomputeAttention();
      return {};
    },

    getChanges: async ({ scope }) => {
      rt.requireReady();
      const res = await requireTempod(core).request("git.changes", { scope });
      return { files: res.files, baseSha: res.baseSha, headSha: res.headSha };
    },

    getFileDiff: async ({ scope, path }) => {
      rt.requireReady();
      return requireTempod(core).request("git.fileDiff", { scope, path });
    },

    addReviewComment: async ({ path, lineStart, lineEnd, side, body }): Promise<ReviewComment> => {
      const row: ReviewCommentRow = {
        id: newId(),
        path,
        lineStart: lineStart ?? null,
        lineEnd: lineEnd ?? lineStart ?? null,
        side: side ?? null,
        body,
        status: "draft",
        sentTurnId: null,
        createdAt: Date.now(),
      };
      core.db.insert(reviewComments).values(row).run();
      return reviewToWire(row);
    },

    deleteReviewComment: async ({ commentId }) => {
      core.db.delete(reviewComments).where(eq(reviewComments.id, commentId)).run();
      return {};
    },

    listReviewComments: async () =>
      core.db.select().from(reviewComments).orderBy(asc(reviewComments.createdAt)).all().map(reviewToWire),

    listCheckpoints: async (): Promise<CheckpointInfo[]> => {
      const seqs = new Map(
        core.db
          .select({ id: turns.id, seq: turns.seq })
          .from(turns)
          .all()
          .map((t) => [t.id, t.seq]),
      );
      return core.db
        .select()
        .from(checkpoints)
        .orderBy(desc(checkpoints.createdAt))
        .all()
        .map((c) => ({
          id: c.id,
          turnId: c.turnId,
          turnSeq: c.turnId ? (seqs.get(c.turnId) ?? null) : null,
          reason: c.reason as CheckpointInfo["reason"],
          createdAt: c.createdAt,
        }));
    },

    revertToCheckpoint: async ({ checkpointId }) => {
      if (
        !core.db
          .select({ id: checkpoints.id })
          .from(checkpoints)
          .where(eq(checkpoints.id, checkpointId))
          .get()
      ) {
        throw new TempoError("CHECKPOINT_NOT_FOUND");
      }
      if (core.runningTurn() || core.queuedTurns().length > 0 || runner.hasPendingOrRunning())
        throw new TempoError("WORKSPACE_BUSY");
      rt.requireReady();
      await awaitOp("revert", { checkpointId });
      return {};
    },

    commitAndPush: async ({ message }) => {
      notArchived(core);
      rt.requireReady();
      // 03 Step runner: the op waits as pending behind other ops and starts in creation order.
      const msg = message.trim() || core.ws().title || "Update from Tempo";
      return awaitOp<{ commitSha: string }>("commit_push", { message: msg });
    },

    createPullRequest: async ({ title, body, draft }) => {
      const row = core.ws();
      requirePushed(core);
      if (row.prNumber !== null && (row.prState === "open" || row.prState === "draft"))
        throw new TempoError("PR_EXISTS");
      const project = await core.project();
      const pr = await github.createPullRequest(
        await getGithubToken(core),
        { owner: project.owner, name: project.name },
        {
          title: title.trim() || row.title || row.branch,
          head: row.branch,
          base: row.baseBranch,
          body: body.trim() || defaultPrBody(core),
          draft,
        },
      );
      core.setKv("prTitle", title.trim() || row.title || row.branch);
      core.updateWs({ prNumber: pr.number, prState: pr.state, checksState: null });
      core.publish();
      core.scheduleAlarm();
      return { number: pr.number, url: pr.url };
    },

    mergePullRequest: async ({ method }) => {
      const row = core.ws();
      if (row.prNumber === null) throw new TempoError("PR_NOT_MERGEABLE");
      const project = await core.project();
      await github.mergePullRequest(
        await getGithubToken(core),
        { owner: project.owner, name: project.name },
        row.prNumber,
        method,
      );
      core.updateWs({ prState: "merged" });
      core.publish();
      if (
        core.settings().git.archive_on_merge &&
        ["ready", "working", "sleeping", "error"].includes(core.state)
      ) {
        core.setState("archiving");
        runner.insert("archive");
      }
      return {};
    },

    refreshPullRequest: async () => refreshPullRequest(core),

    listCheckRuns: async () => {
      const row = core.ws();
      if (row.prNumber === null) return [];
      const project = await core.project();
      const token = await getGithubToken(core);
      const repo = { owner: project.owner, name: project.name };
      const pr = await github.getPullRequest(token, repo, row.prNumber);
      return github.listCheckRuns(token, repo, pr.head.sha);
    },

    listFiles: async () => {
      if (core.state === "sleeping") return core.files.list();
      rt.requireReady();
      const res = await requireTempod(core).request("fs.list", {});
      try {
        core.files.rememberList(res.paths);
      } catch {
        /* The live response is still usable. */
      }
      return res;
    },

    readFile: async ({ path }) => {
      if (core.state === "sleeping") return core.files.read(path);
      rt.requireReady();
      try {
        const res = await requireTempod(core).request("fs.read", { path, maxBytes: 1024 * 1024 });
        try {
          core.files.rememberFile(path, res);
        } catch {
          /* The live response is still usable. */
        }
        return res;
      } catch (e) {
        try {
          core.files.forgetFile(path);
        } catch {
          /* Preserve the live error. */
        }
        throw e;
      }
    },

    searchFiles: async ({ query, regex }) => {
      rt.requireReady();
      const res = await requireTempod(core).request("fs.search", {
        query,
        regex: regex ?? false,
        maxResults: 500,
      });
      return res.matches;
    },

    runScript: async ({ scriptId }) => {
      notArchived(core);
      const settings = core.settings();
      const def = settings.scripts.run[scriptId];
      if (!def) throw new TempoError("NOT_FOUND", undefined, "no such run script");
      rt.requireReady();
      if (settings.scripts.run_mode === "nonconcurrent") {
        for (const r of runningRuns(core, "run")) {
          await requireTempod(core)
            .request("script.stop", { runId: r.id })
            .catch(() => undefined);
        }
      }
      return startScript(core, {
        kind: "run",
        scriptId,
        command: def.command,
        cwd: def.cwd,
        timeoutMs: null,
      });
    },

    stopScript: async ({ runId }) => {
      // Not a wake trigger (03): with no container, nothing runs that could be stopped.
      if (!containerRunning(core) || !core.tempod?.open) return {};
      await core.tempod.request("script.stop", { runId });
      return {};
    },

    rerunSetup: async () => {
      notArchived(core);
      const row = core.ws();
      if (
        row.setupStatus === "running" ||
        runningRuns(core, "setup").length > 0 ||
        runner.hasPendingOrRunning()
      ) {
        throw new TempoError("WORKSPACE_BUSY");
      }
      rt.requireReady();
      const command = core.settings().scripts.setup;
      core.updateWs({ setupStatus: command.trim() ? "running" : "none" });
      core.publish();
      if (!command.trim()) throw new TempoError("NOT_FOUND", undefined, "no setup script");
      const run = await startScript(core, {
        kind: "setup",
        scriptId: null,
        command,
        cwd: "",
        timeoutMs: SETUP_TIMEOUT_MS,
      });
      if (run.status === "failed_to_start") {
        core.updateWs({ setupStatus: "failed" });
        core.recomputeAttention();
      }
      return run;
    },

    continueAfterSetupFailure: async () => {
      if (core.ws().setupStatus === "failed") {
        core.updateWs({ setupStatus: "skipped" });
        core.recomputeAttention(false);
        core.publish();
        core.kickQueue();
      }
      return {};
    },

    listTerminals: async () => {
      if (!core.tempod?.open || !containerRunning(core)) return [];
      const res = await core.tempod.request("terminal.list", {});
      return res.terminalIds.map((terminalId) => ({ terminalId }));
    },

    readFileAt: async ({ path, sha }) => {
      rt.requireReady();
      return requireTempod(core).request("git.readFile", { sha, path, maxBytes: 1024 * 1024 });
    },

    listArtifacts: async () => listArtifacts(core),

    openArtifact: ({ artifactId, version }) => openArtifact(core, artifactId, version),

    listScriptRuns: async () =>
      core.db
        .select()
        .from(scriptRuns)
        .orderBy(desc(scriptRuns.startedAt))
        .limit(50)
        .all()
        .map((r) => ({ ...runToWire(r), logTail: r.logTail })),
  };
};

/** The DO's internal default mode lookup, re-exported for tests. */
export { DEFAULT_MODE };

export const logEnvChange = (core: WorkspaceCore) => {
  log("info", "env changed", { workspaceId: core.workspaceId });
  return sendEnv(core);
};
