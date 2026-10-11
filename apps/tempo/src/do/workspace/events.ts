import { eq } from "drizzle-orm";
import {
  ERROR_CODES,
  type AgentId,
  type ErrorCode,
  type TempodEvent,
  type TempodEventOf,
} from "@tempo/protocol";
import { permissions, ports, scriptRuns, turns } from "../../db/workspace-do.ts";
import { errorText, log } from "../../log.ts";
import type { WorkspaceCore } from "./core.ts";
import { backupHome, takeCheckpoint, uploadBundleWithRetry } from "./durability.ts";
import { storeChanges, summarize } from "./git.ts";
import { afterTurnEnded, finishTurn } from "./queue.ts";
import type { OpRunner } from "./runner.ts";
import { appendLog, runToWire, scriptRun, startScript, uploadLog } from "./scripts.ts";
import { defaultRunScriptId } from "@tempo/settings";

export interface EventRuntime {
  readonly core: WorkspaceCore;
  readonly runner: OpRunner;
}

const toCode = (code: string | undefined, fallback: ErrorCode): ErrorCode =>
  code && (ERROR_CODES as ReadonlyArray<string>).includes(code) ? (code as ErrorCode) : fallback;

/** Applies one tempod event (02, Events; 03, While it runs). Events arrive in seq order. */
export const applyTempodEvent = (rt: EventRuntime, event: TempodEvent): Promise<void> | void => {
  const { core } = rt;
  switch (event.kind) {
    case "item.created":
      core.insertItem({
        id: event.item.id,
        sessionId: event.sessionId,
        turnId: event.turnId,
        kind: event.item.kind,
        status: event.item.status,
        content: event.item.content,
        createdAt: event.item.createdAt,
      });
      return;
    case "item.delta":
      core.appendItemText(event.itemId, event.append.text);
      return;
    case "item.updated":
      core.updateItem(event.itemId, {
        ...(event.patch.status ? { status: event.patch.status } : {}),
        ...(event.patch.content ? { content: event.patch.content } : {}),
      });
      return;
    case "session.updated": {
      const p = event.patch;
      core.updateSession(event.sessionId, {
        ...(p.modeId !== undefined ? { modeId: p.modeId } : {}),
        ...(p.modes ? { modesJson: JSON.stringify(p.modes) } : {}),
        ...(p.configOptions ? { configOptionsJson: JSON.stringify(p.configOptions) } : {}),
        ...(p.commands ? { commandsJson: JSON.stringify(p.commands) } : {}),
        ...(p.usage ? { usageJson: JSON.stringify(p.usage) } : {}),
        ...(p.title ? { title: p.title } : {}),
      });
      return;
    }
    case "turn.started": {
      const turn = core.db.select().from(turns).where(eq(turns.id, event.turnId)).get();
      if (!turn || turn.sessionId !== event.sessionId || turn.status !== "queued") return;
      core.updateTurn(turn.id, { status: "running", startedAt: Date.now(), queuePos: null });
      core.updateSession(turn.sessionId, { status: "running" });
      if (core.state === "ready") core.setState("working");
      return;
    }
    case "turn.ended":
      return onTurnEnded(rt, event);
    case "permission.requested": {
      core.db
        .insert(permissions)
        .values({
          requestId: event.requestId,
          sessionId: event.sessionId,
          turnId: event.turnId,
          itemId: event.itemId,
          optionsJson: JSON.stringify(event.options),
          status: "pending",
          chosenOptionId: null,
          createdAt: Date.now(),
          answeredAt: null,
        })
        .onConflictDoNothing()
        .run();
      core.broadcast({
        type: "permission",
        request: {
          requestId: event.requestId,
          sessionId: event.sessionId,
          turnId: event.turnId,
          itemId: event.itemId,
          title: event.title,
          options: event.options,
        },
      });
      core.recomputeAttention();
      return;
    }
    case "agent.exited": {
      core.liveSessions.delete(event.sessionId);
      // Planned exits: the session reloads on its next prompt; after a cancel timeout, turn.ended (cancelled) follows.
      if (event.reason === "evicted" || event.reason === "cancelled") return;
      const tail = event.stderrTail.trim().split("\n").slice(-20).join("\n");
      core.notice("error", `The agent stopped unexpectedly.${tail ? `\n${tail}` : ""}`, event.sessionId);
      const running = core.runningTurn();
      if (running && running.sessionId === event.sessionId) {
        if (
          finishTurn(core, running.id, "failed", {
            stopReason: null,
            errorCode: "AGENT_CRASHED",
            errorDetail: tail,
          })
        ) {
          void afterTurnEnded(core, running.id);
        }
      }
      return;
    }
    case "script.output":
      appendLog(core, event.runId, event.data);
      core.broadcast({ type: "script.output", runId: event.runId, stream: event.stream, data: event.data });
      return;
    case "script.exited":
      return onScriptExited(rt, event);
    case "git.changed":
      storeChanges(core, summarize(event.files));
      return;
    case "ports.changed": {
      const now = Date.now();
      const next = new Set(event.ports.filter((p) => p >= 1024 && p <= 65535 && p !== 7070));
      const current = core.db.select().from(ports).all();
      for (const p of current)
        if (!next.has(p.port)) core.db.delete(ports).where(eq(ports.port, p.port)).run();
      for (const p of next)
        core.db.insert(ports).values({ port: p, firstSeenAt: now }).onConflictDoNothing().run();
      core.broadcastDetailSoon();
      return;
    }
    case "settings.changed":
      core.updateWs({ settingsJson: JSON.stringify(event.effective) });
      core.setKv("settingsIssues", {
        warnings: event.warnings,
        errors: event.errors,
        sources: event.sources ?? {},
      });
      core.broadcastDetailSoon();
      core.ctx.waitUntil(sendEnv(core));
      return;
    case "credential.changed": {
      return core
        .credentials()
        .offerCodexAuth(event.content, event.lastRefresh, core.workspaceId)
        .then((res) => {
          log("info", "codex auth offered", {
            workspaceId: core.workspaceId,
            accepted: res.accepted,
            version: res.version,
          });
        });
    }
    case "credential.invalid":
      core.broadcast({ type: "credential.invalid", provider: event.provider });
      return;
    case "incarnation.changed":
      core.liveSessions.clear();
      return;
    case "outbox.overflow":
      core.notice("warning", "Some live events were lost; the transcript may have gaps.");
      return;
    case "tempod.stopping":
      core.ctx.waitUntil(onSigterm(core));
      return;
    case "log":
      log(
        event.level === "error" ? "error" : event.level === "warn" ? "warn" : "info",
        `tempod: ${event.msg}`,
        {
          workspaceId: core.workspaceId,
        },
      );
      return;
  }
};

const onTurnEnded = (rt: EventRuntime, event: TempodEventOf<"turn.ended">): void => {
  const { core } = rt;
  const turn = core.db.select().from(turns).where(eq(turns.id, event.turnId)).get();
  if (!turn || turn.status !== "running") return;
  const session = core.sessionRow(turn.sessionId);
  let status: "completed" | "cancelled" | "failed" | "interrupted";
  let errorCode: ErrorCode | null = null;
  if (event.interrupted) status = "interrupted";
  else if (event.error) {
    status = "failed";
    const msg = event.error.message ?? "";
    const credential = (session.agent as AgentId) === "codex" && /401|refresh_token/.test(msg);
    errorCode = credential ? "CREDENTIAL_INVALID" : toCode(event.error.code, "AGENT_CRASHED");
  } else if (event.stopReason === "cancelled") status = "cancelled";
  else status = "completed";
  finishTurn(core, turn.id, status, {
    stopReason: event.stopReason,
    errorCode,
    errorDetail: event.error?.message ?? null,
  });
  if (status === "interrupted") {
    core.notice("warning", "The turn was interrupted.", turn.sessionId, turn.id);
    if (core.tempodStopping) {
      core.recomputeAttention(false);
      core.publish();
      return;
    }
  }
  void afterTurnEnded(core, turn.id);
};

const onScriptExited = (rt: EventRuntime, event: TempodEventOf<"script.exited">): void => {
  const { core, runner } = rt;
  const run = scriptRun(core, event.runId);
  if (!run || run.status !== "running") return;
  const status = event.timedOut ? "timed_out" : event.signal ? "killed" : "exited";
  core.db
    .update(scriptRuns)
    .set({ status, exitCode: event.exitCode, signal: event.signal, endedAt: Date.now() })
    .where(eq(scriptRuns.id, run.id))
    .run();
  core.broadcast({ type: "script.run", run: runToWire(scriptRun(core, run.id)!) });
  core.ctx.waitUntil(uploadLog(core, run.id));
  const ok = status === "exited" && event.exitCode === 0;
  if (run.kind === "setup") {
    core.updateWs({ setupStatus: ok ? "succeeded" : "failed" });
    core.recomputeAttention(false);
    core.publish();
    if (ok && core.settings().scripts.auto_run_after_setup) {
      const id = defaultRunScriptId(core.settings());
      const def = id ? core.settings().scripts.run[id] : undefined;
      if (id && def) {
        core.ctx.waitUntil(
          startScript(core, {
            kind: "run",
            scriptId: id,
            command: def.command,
            cwd: def.cwd,
            timeoutMs: null,
          }).catch((e) =>
            log("warn", "auto run failed", { workspaceId: core.workspaceId, error: errorText(e) }),
          ),
        );
      }
    }
    const op = runner.waitingOn("setup.run");
    if (op) core.ctx.waitUntil(runner.completeWaiting(op.id, "setup.run", "next"));
    core.kickQueue();
    return;
  }
  if (run.kind === "archive") {
    if (!ok)
      core.notice("warning", `The archive script failed (exit ${event.exitCode ?? event.signal ?? "?"}).`);
    const op = runner.waitingOn("script.archive");
    if (op) core.ctx.waitUntil(runner.completeWaiting(op.id, "script.archive", "next"));
  }
};

/** SIGTERM (03, Failure handling): checkpoint, upload, back up, then shutdown. */
const onSigterm = async (core: WorkspaceCore): Promise<void> => {
  core.tempodStopping = true;
  try {
    const { bundle } = await takeCheckpoint(core, "sigterm", null);
    if (bundle) await uploadBundleWithRetry(core, bundle);
    await backupHome(core).catch((e) => log("warn", "sigterm home backup failed", { error: errorText(e) }));
    await core.tempod?.request("shutdown", { reason: "sigterm" });
  } catch (e) {
    log("warn", "sigterm save failed", { workspaceId: core.workspaceId, error: errorText(e) });
  }
};

/** env.set after settings or secrets change (02). */
export const sendEnv = async (core: WorkspaceCore): Promise<void> => {
  try {
    await core.tempod?.request("env.set", { env: await core.scriptEnv() });
  } catch (e) {
    log("warn", "env.set failed", { workspaceId: core.workspaceId, error: errorText(e) });
  }
};

export const pendingPermissionsOf = (core: WorkspaceCore, turnId: string) =>
  core.db
    .select()
    .from(permissions)
    .where(eq(permissions.turnId, turnId))
    .all()
    .filter((p) => p.status === "pending");
