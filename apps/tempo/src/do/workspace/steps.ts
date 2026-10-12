import { and, desc, eq, gt, inArray, isNotNull, lt, lte, ne } from "drizzle-orm";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { pickSlug } from "@tempo/cities";
import {
  TempoError,
  newId,
  revertNote,
  type CheckpointReason,
  type OpKind,
  type Source,
} from "@tempo/protocol";
import { workspaces } from "../../db/d1.ts";
import {
  checkpoints,
  events,
  homeBackups,
  egressLog,
  items,
  ops,
  permissions,
  scriptRuns,
  sessions,
  snapshots,
  turns,
  type CheckpointRow,
} from "../../db/workspace-do.ts";
import { github } from "../../github/provider.ts";
import { errorText, log } from "../../log.ts";
import {
  connectTempod,
  containerRunning,
  destroyContainer,
  startContainer,
  tempodFor,
  usableSnapshot,
  waitHealthy,
  type ConnectHandlers,
} from "./container.ts";
import { parseJson, type WorkspaceCore } from "./core.ts";
import {
  BUNDLES_KEPT,
  HOME_BACKUPS_KEPT,
  copyBundleIn,
  markLocalOnly,
  newestUploadedCheckpoint,
  restoreHome,
  RESTORE_BUNDLE_PATH,
  takeCheckpoint,
  uploadBundle,
  backupHome,
  type PendingBundle,
} from "./durability.ts";
import { sendEnv } from "./events.ts";
import { getGithubToken, refreshChanges } from "./git.ts";
import { finishTurn } from "./queue.ts";
import {
  OpRunner,
  type OpHooks,
  type OpState,
  type StepCtx,
  type StepFn,
  type StepOutcome,
} from "./runner.ts";
import { ARCHIVE_TIMEOUT_MS, SETUP_TIMEOUT_MS, closeOpenRuns, scriptRun, startScript } from "./scripts.ts";

const DAY = 24 * 60 * 60_000;
const skip = (sc: StepCtx): StepOutcome => OpRunner.skip(sc.state, sc.op.step);
const fresh = (sc: StepCtx): boolean => sc.state["freshDisk"] === true;

const CHECKPOINT_REASON: Partial<Record<OpKind, CheckpointReason>> = {
  sleep: "pre_sleep",
  archive: "pre_archive",
  revert: "pre_revert",
};

/** 03 Restore 2: the branch is gone from GitHub, so nothing is pushed any more. */
const markBranchGone = (core: WorkspaceCore): void => {
  core.updateWs({ pushed: 0, lastPushedSha: null, forcePushLease: 0 });
  core.broadcastDetailSoon();
};

/** A snapshot wake skips repo.clone, so it asks GitHub whether a pushed branch still exists. */
const checkPushedBranch = async (core: WorkspaceCore): Promise<void> => {
  const row = core.ws();
  if (row.pushed !== 1) return;
  try {
    const project = await core.project();
    const exists = await github.branchExists(
      await getGithubToken(core),
      { owner: project.owner, name: project.name },
      row.branch,
    );
    if (!exists) markBranchGone(core);
  } catch (e) {
    log("warn", "branch check failed", { workspaceId: core.workspaceId, error: errorText(e) });
  }
};

export const makeSteps = (handlers: ConnectHandlers): Record<string, StepFn> => {
  /** Best effort: steps that only skip without tempod reconnect first, after a DO restart. */
  const reconnect = (core: WorkspaceCore): Promise<void> =>
    tempodFor(core, handlers).then(
      () => undefined,
      () => undefined,
    );
  return {
    "container.start": async (sc) => {
      const { core, op, state, signal } = sc;
      const row = core.ws();
      if (row.state !== "starting") core.setState("starting");
      if (containerRunning(core) && row.tempodToken) {
        try {
          await waitHealthy(core, AbortSignal.timeout(5000));
          state["freshDisk"] =
            op.kind === "create" || core.kv<{ snapshotId: string | null }>("lastStart")?.snapshotId == null;
          return "next";
        } catch {
          await destroyContainer(core, "unhealthy");
        }
      }
      let snap = op.kind === "wake" ? usableSnapshot(core) : null;
      core.setKv("lastStart", { snapshotId: snap?.id ?? null, at: Date.now() });
      try {
        await startContainer(core, snap);
        await waitHealthy(core, signal);
      } catch (e) {
        await destroyContainer(core, "start failed").catch(() => undefined);
        if (!snap)
          throw new TempoError(
            "CONTAINER_START_FAILED",
            undefined,
            e instanceof TempoError ? (e.detail ?? e.message) : errorText(e),
          );
        log("warn", "snapshot start failed; using the image", {
          workspaceId: core.workspaceId,
          snapshot: snap.id,
        });
        core.db.update(snapshots).set({ unusable: 1 }).where(eq(snapshots.id, snap.id)).run();
        snap = null;
        core.setKv("lastStart", { snapshotId: null, at: Date.now() });
        await startContainer(core, null);
        await waitHealthy(core, signal);
      }
      if (snap)
        core.db.update(snapshots).set({ lastRestoredAt: Date.now() }).where(eq(snapshots.id, snap.id)).run();
      state["freshDisk"] = snap === null;
      if (core.env.TEMPO_VERSION && core.tempodVersion && core.tempodVersion !== core.env.TEMPO_VERSION) {
        log("warn", "tempod version differs", {
          workspaceId: core.workspaceId,
          tempod: core.tempodVersion,
          worker: core.env.TEMPO_VERSION,
        });
      }
      return "next";
    },

    "tempod.connect": async (sc) => {
      const { core, state } = sc;
      await connectTempod(core, handlers);
      if (core.state === "starting") core.setState(fresh(sc) ? "setting_up" : "ready");
      void state;
      return "next";
    },

    "repo.clone": async (sc) => {
      const { core, op, signal } = sc;
      if (!fresh(sc)) {
        if (op.kind === "wake") await checkPushedBranch(core);
        return skip(sc);
      }
      const row = core.ws();
      const project = await core.project();
      const source = parseJson<Source>(row.sourceJson, { kind: "new" });
      const res = await (
        await tempodFor(core, handlers)
      ).request(
        "repo.clone",
        {
          url: `https://github.com/${project.owner}/${project.name}.git`,
          branch: row.branch,
          baseBranch: row.baseBranch,
          source,
          author: core.author(),
          mode: op.kind === "create" ? "create" : "wake",
        },
        { signal },
      );
      if (op.kind === "create" && source.kind !== "new" && res.remoteHeadSha) {
        core.updateWs({ pushed: 1, lastPushedSha: res.remoteHeadSha });
      } else if (op.kind === "wake" && row.pushed === 1 && !res.remoteHeadSha) {
        markBranchGone(core);
      }
      return "next";
    },

    "repo.applyCheckpoint": async (sc) => {
      const { core, op, signal } = sc;
      if (!fresh(sc) || op.kind !== "wake") return skip(sc);
      const ckpt = newestUploadedCheckpoint(core);
      if (!ckpt) return skip(sc);
      const tempod = await tempodFor(core, handlers);
      await copyBundleIn(core, ckpt);
      await tempod.request(
        "repo.applyCheckpoint",
        { bundlePath: RESTORE_BUNDLE_PATH, checkpointId: ckpt.id, branch: core.ws().branch },
        { signal },
      );
      return "next";
    },

    "home.restore": async (sc) => {
      if (!fresh(sc) || sc.op.kind !== "wake") return skip(sc);
      const restored = await restoreHome(sc.core, sc.signal);
      return restored ? "next" : skip(sc);
    },

    "settings.read": async (sc) => {
      const { core, op } = sc;
      if (op.kind === "wake" && !fresh(sc)) return skip(sc);
      const project = await core.project(true);
      const res = await (
        await tempodFor(core, handlers)
      ).request("settings.read", { overrides: project.overrides });
      core.updateWs({ settingsJson: JSON.stringify(res.effective) });
      core.setKv("settingsIssues", {
        warnings: res.warnings,
        errors: res.errors,
        sources: res.sources ?? {},
      });
      await sendEnv(core);
      core.broadcastDetailSoon();
      return "next";
    },

    "setup.run": async (sc) => {
      const { core, op, state } = sc;
      if (op.kind === "wake" && !fresh(sc)) return skip(sc);
      // script.exited arrives only over the socket, so a step that runs again after a DO restart reconnects
      // before it waits. If that fails, the heartbeat reconnects (or restarts the container).
      await reconnect(core);
      const existing = typeof state["setupRunId"] === "string" ? scriptRun(core, state["setupRunId"]) : null;
      if (existing) return existing.status === "running" ? "wait" : "next";
      const command = core.settings().scripts.setup;
      if (!command.trim()) {
        core.updateWs({ setupStatus: "none" });
        return "next";
      }
      core.updateWs({ setupStatus: "running" });
      core.publish();
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
        return "next";
      }
      state["setupRunId"] = run.id;
      state.waiting = { step: "setup.run", deadline: Date.now() + SETUP_TIMEOUT_MS + 60_000, runId: run.id };
      return "wait";
    },

    "sessions.markReload": async ({ core }) => {
      core.liveSessions.clear();
      const open = core.db
        .select()
        .from(sessions)
        .where(inArray(sessions.status, ["running", "starting"]))
        .all();
      for (const s of open) core.updateSession(s.id, { status: "idle" });
      return "next";
    },

    "turns.check": async ({ core }) => {
      if (core.runningTurn() || core.queuedTurns().length > 0) return "cancel";
      if (core.state !== "ready") return "cancel";
      core.setState("stopping");
      return "next";
    },

    "turns.cancel": async ({ core }) => {
      if (core.queueBusy) throw new TempoError("WORKSPACE_BUSY");
      // Read before finishTurn, which marks the running turn's requests cancelled without telling tempod.
      const pending = core.db.select().from(permissions).where(eq(permissions.status, "pending")).all();
      const running = core.runningTurn();
      if (running) {
        await core.tempod
          ?.request("session.cancel", { sessionId: running.sessionId, turnId: running.id })
          .catch(() => undefined);
        finishTurn(core, running.id, "cancelled", { stopReason: "cancelled" });
      }
      for (const t of core.queuedTurns()) {
        core.db.delete(items).where(eq(items.turnId, t.id)).run();
        core.db.delete(turns).where(eq(turns.id, t.id)).run();
        core.broadcast({ type: "turn.deleted", turnId: t.id });
      }
      for (const p of pending) {
        await core.tempod
          ?.request("permission.respond", { requestId: p.requestId, optionId: null })
          .catch(() => undefined);
        core.db
          .update(permissions)
          .set({ status: "cancelled", answeredAt: Date.now() })
          .where(eq(permissions.requestId, p.requestId))
          .run();
      }
      core.recomputeAttention();
      return "next";
    },

    "script.archive": async (sc) => {
      const { core, state } = sc;
      await reconnect(core);
      if (!containerRunning(core) || !core.tempod?.open) return skip(sc);
      const existing =
        typeof state["archiveRunId"] === "string" ? scriptRun(core, state["archiveRunId"]) : null;
      if (existing) return existing.status === "running" ? "wait" : "next";
      const command = core.settings().scripts.archive;
      if (!command.trim()) return "next";
      const run = await startScript(core, {
        kind: "archive",
        scriptId: null,
        command,
        cwd: "",
        timeoutMs: ARCHIVE_TIMEOUT_MS,
      });
      if (run.status === "failed_to_start") {
        core.notice("warning", "The archive script did not start.");
        return "next";
      }
      state["archiveRunId"] = run.id;
      state.waiting = {
        step: "script.archive",
        deadline: Date.now() + ARCHIVE_TIMEOUT_MS + 15_000,
        runId: run.id,
      };
      return "wait";
    },

    "git.checkpoint": async (sc) => {
      const { core, op, state, signal } = sc;
      if (typeof state["checkpointId"] === "string") return "next";
      await reconnect(core);
      if (!containerRunning(core) || !core.tempod?.open) {
        if (op.kind === "revert") throw new TempoError("CONTAINER_NOT_READY");
        return skip(sc);
      }
      const reason = CHECKPOINT_REASON[op.kind as OpKind] ?? "pre_sleep";
      const requestId =
        typeof state["checkpointRequestId"] === "string" ? state["checkpointRequestId"] : newId();
      state["checkpointRequestId"] = requestId;
      core.db
        .update(ops)
        .set({ stateJson: JSON.stringify(state) })
        .where(eq(ops.id, op.id))
        .run();
      const res = await takeCheckpoint(core, reason, null, signal, requestId);
      if (op.kind === "revert" && !res.checkpointId)
        throw new TempoError("INTERNAL", undefined, "Safety checkpoint missing");
      state["checkpointId"] = res.checkpointId;
      state["pendingBundle"] = res.bundle;
      return "next";
    },

    "bundle.upload": async (sc) => {
      const bundle = sc.state["pendingBundle"] as PendingBundle | null | undefined;
      if (!bundle || !containerRunning(sc.core)) return skip(sc);
      await uploadBundle(sc.core, bundle);
      sc.state["pendingBundle"] = null;
      return "next";
    },

    "home.backup": async (sc) => {
      if (!containerRunning(sc.core)) return skip(sc);
      await backupHome(sc.core, sc.signal);
      return "next";
    },

    "tempod.shutdown": async (sc) => {
      await reconnect(sc.core);
      if (!sc.core.tempod?.open) return skip(sc);
      await sc.core.files.sync();
      await sc.core.tempod.request("shutdown", { reason: sc.op.kind });
      return "next";
    },

    "container.snapshot": async (sc) => {
      const { core } = sc;
      if (!containerRunning(core)) return skip(sc);
      const n = core.db.select({ id: snapshots.id }).from(snapshots).all().length + 1;
      const name = `${core.workspaceId}-${n}`;
      const snap = await core.container!.snapshotContainer({ name });
      core.db
        .insert(snapshots)
        .values({
          id: snap.id,
          name,
          sizeBytes: snap.size,
          imageRef: core.container!.images["workspace"] ?? core.ws().imageRef ?? "",
          createdAt: Date.now(),
          lastRestoredAt: null,
          unusable: 0,
        })
        .onConflictDoNothing()
        .run();
      return "next";
    },

    "container.destroy": async (sc) => {
      await destroyContainer(sc.core, sc.op.kind);
      closeOpenRuns(sc.core);
      return "next";
    },

    "github.deleteBranch": async (sc) => {
      const { core } = sc;
      const row = core.ws();
      if (!core.settings().git.delete_branch_on_archive || row.pushed !== 1) return skip(sc);
      if (row.prState === "open" || row.prState === "draft") return skip(sc);
      const project = await core.project();
      try {
        await github.deleteBranch(
          await getGithubToken(core),
          { owner: project.owner, name: project.name },
          row.branch,
        );
      } catch (e) {
        if (!(e instanceof TempoError && e.code === "NOT_FOUND")) throw e;
      }
      markBranchGone(core);
      return "next";
    },

    "branch.check": async (sc) => {
      const { core } = sc;
      const row = core.ws();
      // A restore queued behind an archive that failed has nothing to restore.
      if (row.state !== "archived") return "cancel";
      const live = await drizzleD1(core.env.DB)
        .select({
          id: workspaces.id,
          slug: workspaces.slug,
          branch: workspaces.branch,
          archivedAt: workspaces.archivedAt,
        })
        .from(workspaces)
        .where(eq(workspaces.projectId, row.projectId))
        .all();
      const active = live.filter((w) => w.id !== row.workspaceId && w.archivedAt === null);
      if (active.some((w) => w.branch === row.branch)) throw new TempoError("BRANCH_IN_USE");
      if (active.some((w) => w.slug === row.slug)) {
        core.updateWs({ slug: pickSlug(active.map((w) => w.slug)) });
      }
      return "next";
    },

    "git.revert": async (sc) => {
      const { core, input, state, signal } = sc;
      const checkpointId = String(input["checkpointId"]);
      const res = await (await tempodFor(core, handlers)).request("git.revert", { checkpointId }, { signal });
      state["headSha"] = res.headSha;
      return "next";
    },

    "transcript.mark": async (sc) => {
      const { core, input, state } = sc;
      const checkpointId = String(input["checkpointId"]);
      const ckpt = core.db.select().from(checkpoints).where(eq(checkpoints.id, checkpointId)).get();
      const seq = ckpt ? checkpointTurnSeq(core, ckpt) : 0;
      for (const t of core.db.select().from(turns).where(gt(turns.seq, seq)).all()) {
        if (t.reverted === 0 && t.status !== "queued") core.updateTurn(t.id, { reverted: 1 });
      }
      const note = revertNote(seq);
      for (const s of core.db.select().from(sessions).where(ne(sessions.status, "closed")).all()) {
        core.insertItem({
          sessionId: s.id,
          turnId: null,
          kind: "revert_marker",
          status: "completed",
          content: { checkpointId, toTurnSeq: seq },
        });
        core.updateSession(s.id, { pendingNote: note });
      }
      const row = core.ws();
      const head = typeof state["headSha"] === "string" ? state["headSha"] : null;
      if (row.lastPushedSha && head && head !== row.lastPushedSha) core.updateWs({ forcePushLease: 1 });
      state["result"] = {};
      core.ctx.waitUntil(refreshChanges(core).catch(() => undefined));
      return "next";
    },

    "git.commitAndPush": async (sc) => {
      const { core, input, state, signal } = sc;
      const row = core.ws();
      const res = await (
        await tempodFor(core, handlers)
      ).request(
        "git.commitAndPush",
        {
          message: String(input["message"] ?? ""),
          branch: row.branch,
          forceWithLeaseSha: row.forcePushLease === 1 ? row.lastPushedSha : null,
        },
        { signal },
      );
      core.updateWs({ pushed: 1, lastPushedSha: res.commitSha, forcePushLease: 0 });
      core.setKv("hasUnpushedCommits", false);
      core.publish();
      state["result"] = { commitSha: res.commitSha };
      core.ctx.waitUntil(refreshChanges(core).catch(() => undefined));
      return "next";
    },

    "events.prune": async ({ core }) => {
      core.db
        .delete(events)
        .where(lt(events.receivedAt, Date.now() - 7 * DAY))
        .run();
      return "next";
    },

    "r2.retention": async ({ core }) => {
      const bundles = core.db
        .select()
        .from(checkpoints)
        .where(isNotNull(checkpoints.r2Key))
        .orderBy(desc(checkpoints.createdAt))
        .all();
      for (const c of bundles.slice(BUNDLES_KEPT)) {
        await core.env.DATA.delete(c.r2Key!);
        core.db.update(checkpoints).set({ r2Key: null, localOnly: 1 }).where(eq(checkpoints.id, c.id)).run();
      }
      const oldLogs = core.db
        .select()
        .from(scriptRuns)
        .where(and(isNotNull(scriptRuns.r2Key), lt(scriptRuns.startedAt, Date.now() - 30 * DAY)))
        .all();
      for (const r of oldLogs) {
        await core.env.DATA.delete(r.r2Key!);
        core.db.update(scriptRuns).set({ r2Key: null }).where(eq(scriptRuns.id, r.id)).run();
      }
      const homes = core.db.select().from(homeBackups).orderBy(desc(homeBackups.createdAt)).all();
      for (const h of homes.slice(HOME_BACKUPS_KEPT)) {
        const rec = parseJson<{ id?: string } | null>(h.recordJson, null);
        if (rec?.id) await core.env.DATA.delete(`homes/${core.workspaceId}/${rec.id}.tar.zst`);
        core.db.delete(homeBackups).where(eq(homeBackups.id, h.id)).run();
      }
      return "next";
    },

    "egress.trim": async ({ core }) => {
      const cutoff = core.db
        .select({ id: egressLog.id })
        .from(egressLog)
        .orderBy(desc(egressLog.id))
        .limit(1)
        .offset(10_000)
        .get();
      if (cutoff)
        core.db
          .delete(egressLog)
          .where(lt(egressLog.id, cutoff.id + 1))
          .run();
      return "next";
    },
  };
};

/**
 * The turn whose end a checkpoint holds (03 Revert 4). A checkpoint with no turn (pre_sleep, sigterm, ...)
 * holds the turn that points at it with an unchanged turn_end, else the newest turn that ended before it.
 */
export const checkpointTurnSeq = (core: WorkspaceCore, ckpt: CheckpointRow): number => {
  if (ckpt.turnId) {
    const own = core.db.select({ s: turns.seq }).from(turns).where(eq(turns.id, ckpt.turnId)).get();
    if (own) return own.s;
  }
  const pointing = core.db
    .select({ s: turns.seq })
    .from(turns)
    .where(eq(turns.checkpointId, ckpt.id))
    .orderBy(desc(turns.seq))
    .get();
  if (pointing) return pointing.s;
  const before = core.db
    .select({ s: turns.seq })
    .from(turns)
    .where(and(isNotNull(turns.endedAt), lte(turns.endedAt, ckpt.createdAt)))
    .orderBy(desc(turns.seq))
    .get();
  return before?.s ?? 0;
};

const toReady = (core: WorkspaceCore) => {
  const state = core.state;
  if (state === "starting" || state === "setting_up") core.setState("ready");
  core.ctx.waitUntil(core.files.sync());
};

const dropLease = (core: WorkspaceCore) => {
  if (!core.kv<boolean>("codexLease")) return;
  core.setKv("codexLease", undefined);
  core.ctx.waitUntil(
    core
      .credentials()
      .dropCodexLease(core.workspaceId)
      .catch(() => undefined),
  );
};

const toError = (core: WorkspaceCore, code: string, detail: string | null) => {
  if (core.state !== "archived") core.setState("error", { code, detail });
};

export const makeHooks = (scheduleHousekeeping: () => void): Record<OpKind, OpHooks> => ({
  create: { onDone: (core) => toReady(core), onFailed: (core, _op, e) => toError(core, e.code, e.detail) },
  wake: { onDone: (core) => toReady(core), onFailed: (core, _op, e) => toError(core, e.code, e.detail) },
  sleep: {
    onDone: (core) => {
      if (core.state === "stopping") core.setState("sleeping");
      dropLease(core);
    },
    onFailed: (core, _op, e) => toError(core, e.code, e.detail),
  },
  archive: {
    onDone: (core) => {
      core.updateWs({ archivedAt: Date.now() });
      core.setState("archived");
      dropLease(core);
      core.publish();
    },
    onFailed: (core, _op, e) => toError(core, e.code, e.detail),
  },
  restore: {
    onDone: (core) => {
      if (core.state !== "archived") return;
      core.updateWs({ archivedAt: null });
      core.setState("sleeping");
      core.publish();
    },
    onFailed: (core, _op, e) => core.error(e.code, e.detail ?? e.code),
  },
  revert: { onDone: () => undefined, onFailed: () => undefined },
  commit_push: { onDone: () => undefined, onFailed: () => undefined },
  housekeeping: { onDone: () => scheduleHousekeeping(), onFailed: () => scheduleHousekeeping() },
});

/** Permanent-skip side effects that need the op state. */
export const afterSkipWithState = (core: WorkspaceCore, step: string, state: OpState): void => {
  if (step === "bundle.upload") {
    const bundle = state["pendingBundle"] as PendingBundle | null | undefined;
    if (bundle) markLocalOnly(core, bundle.checkpointId);
  }
  if (step === "setup.run") {
    core.updateWs({ setupStatus: "failed" });
    core.recomputeAttention();
  }
};
