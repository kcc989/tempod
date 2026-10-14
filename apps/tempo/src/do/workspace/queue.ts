import { syncIdleCredentials } from "./credential-sync.ts";
import { Match, Schema } from "effect";
import { Files } from "@cloudflare/sandbox";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  HANDOFF_FIRST_LINE,
  HANDOFF_MAX_CHARS,
  PLACEHOLDER,
  TempoError,
  TURN_SUMMARY_RULE,
  type AgentId,
  type ContentBlock,
  type Settings,
  type Turn,
  type TurnUsage,
} from "@tempo/protocol";
import { EMPTY_PROMPT, json, readItemContent } from "../../db/json.ts";
import {
  attachments,
  items,
  permissions,
  reviewComments,
  sessions,
  turns,
  type SessionRow,
  type TurnRow,
} from "../../db/workspace-do.ts";
import { SECRET_KEYS } from "../credential.ts";
import { errorText, log } from "../../log.ts";
import { bytesToBase64 } from "../../lib/crypto.ts";
import { mcpToSpec } from "../../lib/mcp.ts";
import { browserRunEnabled } from "./browser.ts";
import { requireTempod } from "./container.ts";
import type { WorkspaceCore } from "./core.ts";
import { backupHomeIfDue, takeCheckpoint, uploadBundleWithRetry } from "./durability.ts";
import { refreshChanges } from "./git.ts";

/** Default modes (01, Agents table). OpenCode and Pi use the agent's own default. */
export const DEFAULT_MODE: Record<AgentId, string | null> = {
  claude: "auto",
  codex: "agent-full-access",
  opencode: null,
  pi: null,
};

export const PLAN_MODE: Record<AgentId, string | null> = {
  claude: "plan",
  codex: "read-only",
  opencode: "plan",
  pi: null,
};

/** Inline images above this size go as resource links: tempod messages are capped at 1 MiB. */
const MAX_INLINE_IMAGE_BYTES = 512 * 1024;

type CredentialKeys = ReadonlySet<string>;

export const credentialKeys = async (core: WorkspaceCore): Promise<CredentialKeys> =>
  new Set((await core.credentials().status()).map((s) => s.key));

/** Whether the agent has any login (subscription or API key). */
export const hasCredential = (agent: AgentId, keys: CredentialKeys): boolean => {
  switch (agent) {
    case "claude":
      return keys.has(SECRET_KEYS.claude) || keys.has(SECRET_KEYS.anthropic);
    case "codex":
      return keys.has(SECRET_KEYS.codex) || keys.has(SECRET_KEYS.openai);
    case "opencode":
    case "pi":
      return keys.has(SECRET_KEYS.openrouter);
  }
};

export const requireCredential = async (core: WorkspaceCore, agent: AgentId): Promise<void> => {
  if (!hasCredential(agent, await credentialKeys(core)))
    throw new TempoError("CREDENTIAL_MISSING", undefined, agent);
};

/**
 * The adapter env for one agent (01, Agents): the Claude token travels in the env, Codex gets
 * its auth.json over the socket, everything else uses the placeholder that TempoOutbound swaps.
 */
export const agentEnv = async (
  core: WorkspaceCore,
  agent: AgentId,
  signal?: AbortSignal,
): Promise<Record<string, string>> => {
  const creds = core.credentials();

  switch (agent) {
    case "claude": {
      const token = await creds.getSecret(SECRET_KEYS.claude);

      if (token) return { CLAUDE_CODE_OAUTH_TOKEN: token };

      if (await creds.getSecret(SECRET_KEYS.anthropic)) return { ANTHROPIC_API_KEY: PLACEHOLDER };
      throw new TempoError("CREDENTIAL_MISSING", undefined, agent);
    }

    case "codex": {
      const auth = await creds.getCodexAuth();

      if (auth) {
        await requireTempod(core).request(
          "credential.put",
          { provider: "codex", content: auth.content, version: auth.version },
          signal ? { signal } : {},
        );
        await creds.addCodexLease(core.workspaceId);
        core.setKv("codexLease", true);

        return {};
      }

      if (await creds.getSecret(SECRET_KEYS.openai)) return { OPENAI_API_KEY: PLACEHOLDER };
      throw new TempoError("CREDENTIAL_MISSING", undefined, agent);
    }

    case "opencode":
    case "pi": {
      if (await creds.getSecret(SECRET_KEYS.openrouter)) return { OPENROUTER_API_KEY: PLACEHOLDER };
      throw new TempoError("CREDENTIAL_MISSING", undefined, agent);
    }
  }
};

/** Agents whose sessions need `agent.models.<agent>` (01, Agents: Model choice). */
export const MODEL_REQUIRED_AGENTS: ReadonlySet<AgentId> = new Set(["opencode", "pi"]);

/**
 * The `model` of session.start (01, Start a session 2): the session's own choice, else
 * `agent.models.<agent>`, else none. New library sessions keep the frozen choice, including
 * an empty adapter default. OpenCode and Pi without a model fail with MODEL_REQUIRED.
 */
export const sessionModel = (
  agent: AgentId,
  config: import("@tempo/protocol").Session["config"],
  settings: Settings,
  frozen = false,
): string | null => {
  const own = Schema.is(Schema.String)(config["model"]) ? config["model"] : "";
  const model = frozen ? own : own || settings.agent.models[agent];

  if (model) return model;

  if (MODEL_REQUIRED_AGENTS.has(agent))
    throw new TempoError("MODEL_REQUIRED", undefined, `agent.models.${agent} is empty`);

  return null;
};

/** Starts (or reloads) the session's adapter in tempod and stores what the agent reports. */
export const ensureSessionLive = async (
  core: WorkspaceCore,
  session: SessionRow,
  signal?: AbortSignal,
): Promise<void> => {
  await core.sessionClosures.get(session.id);

  if (signal?.aborted) return;

  if (core.liveSessions.has(session.id)) return;
  const tempod = requireTempod(core);
  const agent = session.agent;
  const config = json.config.read(session.configJson, {});
  const model = sessionModel(agent, config, core.settings(), session.agentVersion !== null);
  let env = await agentEnv(core, agent, signal);
  const run = session.runId ? core.lifecycle.runs.row(session.runId) : null;

  if (run) env = { ...env, TEMPO_RUN_ID: run.id, TEMPO_RUN_OUTPUT_KIND: run.outputKind };
  const opts = signal ? { signal } : {};

  let input: import("@tempo/protocol").TempodParams<"session.start"> = {
    sessionId: session.id,
    agent,
    env,
    modeId: session.modeId ?? DEFAULT_MODE[agent],
    browser: browserRunEnabled(core) ? "run" : "local",
    acpSessionId: session.acpSessionId,
    mcpServers: (await core.mcpServers()).map(mcpToSpec),
  };

  if (run) input = { ...input, access: core.lifecycle.runs.snapshot(run).access };

  if (model) input = { ...input, model };

  if (session.profileJson) input = { ...input, profile: json.profile.read(session.profileJson, undefined) };
  const res = await tempod.request("session.start", input, opts);

  core.liveSessions.add(session.id);

  const sessionPatch: Partial<SessionRow> = {
    acpSessionId: res.acpSessionId,
    status: "idle",
    modesJson: json.modes.write(res.modes),
    modeId: res.modeId ?? session.modeId ?? DEFAULT_MODE[agent],
    configOptionsJson: json.configOptions.write(res.configOptions),
    commandsJson: json.commands.write(res.availableCommands),
    capabilitiesJson: json.capabilities.write(res.capabilities),
    profileIssuesJson: json.profileIssues.write(res.profileIssues ?? []),
  };

  if (res.handoff) sessionPatch.handoffPending = 1;
  core.updateSession(session.id, sessionPatch);

  for (const [configId, value] of Object.entries(config)) {
    if (configId === "model") continue;
    const option = res.configOptions.find((o) => o.id === configId);

    if (
      option &&
      option.currentValue !== value &&
      (Schema.is(Schema.String)(value) || Schema.is(Schema.Boolean)(value))
    ) {
      const r = await tempod.request("session.setConfig", { sessionId: session.id, configId, value }, opts);
      core.updateSession(session.id, { configOptionsJson: json.configOptions.write(r.configOptions) });
    }
  }
};

/** Handoff text (01): exact first line, one line per item, cut from the oldest end to 24,000 chars. */
export const buildHandoffText = (core: WorkspaceCore, sessionId: string, beforeTurnId: string): string => {
  const rows = core.db
    .select()
    .from(items)
    .where(
      and(
        eq(items.sessionId, sessionId),
        inArray(items.kind, ["user_message", "agent_message", "tool_call"]),
      ),
    )
    .orderBy(asc(items.createdAt))
    .all()
    .filter((r) => r.turnId !== beforeTurnId);

  const lines = rows.map((r) => {
    const c = readItemContent(r.kind, r.contentJson);

    if (r.kind === "user_message") return `User: ${"text" in c ? c.text : ""}`;

    if (r.kind === "agent_message") return `Agent: ${"text" in c ? c.text : ""}`;

    return `Tool: ${"title" in c ? c.title : ""}`;
  });

  const budget = HANDOFF_MAX_CHARS - HANDOFF_FIRST_LINE.length - 1;
  const kept: string[] = [];
  let used = 0;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;

    if (used + line.length + 1 > budget) {
      const room = budget - used - 1;

      if (room > 0 && kept.length === 0) kept.unshift(line.slice(line.length - room));
      break;
    }

    kept.unshift(line);
    used += line.length + 1;
  }

  return [HANDOFF_FIRST_LINE, ...kept].join("\n");
};

const text = (t: string): ContentBlock => ({ type: "text", text: t });

export interface PromptContent {
  readonly blocks: ContentBlock[];
  /** Session fields to clear once session.prompt is accepted (01, Send a prompt, blocks 1 and 2). */
  readonly patch: Partial<SessionRow>;
  readonly handoff: string | null;
}

/** Content blocks in the order of 01, Send a prompt. Changes no session field: see `commitContent`. */
export const buildContent = async (
  core: WorkspaceCore,
  session: SessionRow,
  turn: TurnRow,
): Promise<PromptContent> => {
  const prompt = json.prompt.read(turn.promptJson, EMPTY_PROMPT);
  const blocks: ContentBlock[] = [];
  const settings = core.settings();
  const patch: Partial<SessionRow> = {};
  let handoff: string | null = null;

  if (session.generalPromptSent === 0) {
    blocks.push(text(TURN_SUMMARY_RULE));

    if (settings.prompts.general) blocks.push(text(settings.prompts.general));
    patch.generalPromptSent = 1;
  }

  if (session.handoffPending === 1) {
    handoff = buildHandoffText(core, session.id, turn.id);
    blocks.push(text(handoff));
    patch.handoffPending = 0;
  }

  if (session.pendingNote) {
    blocks.push(text(session.pendingNote));
    patch.pendingNote = null;
  }

  if (session.runId && turn.origin !== "user") {
    blocks.push(...(await core.lifecycle.runs.content(turn)));

    return { blocks, patch, handoff };
  }

  if (prompt.reviewCommentIds.length > 0) {
    const comments = core.db
      .select()
      .from(reviewComments)
      .where(inArray(reviewComments.id, [...prompt.reviewCommentIds]))
      .all();

    if (comments.length > 0) {
      const lines = comments.map(
        (c) =>
          `${c.path}:${c.lineStart === null ? "" : c.lineEnd && c.lineEnd !== c.lineStart ? `${c.lineStart}-${c.lineEnd}` : c.lineStart}: ${c.body}`,
      );

      blocks.push(text(["Review comments:", ...lines].join("\n")));
    }
  }

  if (prompt.text) blocks.push(text(prompt.text));

  for (const m of prompt.mentions) {
    const path = m.path.replace(/^\/+/, "");
    blocks.push({
      type: "resource_link",
      uri: `file:///workspace/${path}`,
      name: path.split("/").pop() ?? path,
    });
  }

  if (prompt.attachmentIds.length > 0) {
    const caps = json.capabilities.read(session.capabilitiesJson, {});

    const supportsImage = Schema.is(
      Schema.Struct({ promptCapabilities: Schema.Struct({ image: Schema.Literal(true) }) }),
    )(caps);

    const rows = core.db
      .select()
      .from(attachments)
      .where(inArray(attachments.id, [...prompt.attachmentIds]))
      .all();

    const files = new Files(core.container!);

    for (const a of rows) {
      const obj = await core.env.DATA.get(a.r2Key);

      if (!obj) continue;
      const containerPath = `/home/tempo/attachments/${turn.id}/${a.name}`;
      const isImage = a.mime.startsWith("image/");

      if (isImage && supportsImage && a.sizeBytes <= MAX_INLINE_IMAGE_BYTES) {
        const bytes = new Uint8Array(await obj.arrayBuffer());
        blocks.push({ type: "image", mimeType: a.mime, data: bytesToBase64(bytes) });
        await files.writeFile(containerPath, bytes, { user: "1000:1000" }).catch(() => undefined);
      } else {
        await files.mkdir(`/home/tempo/attachments/${turn.id}`, { recursive: true, user: "1000:1000" });
        await files.writeFile(containerPath, obj.body, { user: "1000:1000" });
        blocks.push({
          type: "resource_link",
          uri: `file://${containerPath}`,
          name: a.name,
          mimeType: a.mime,
        });
      }

      core.db
        .update(attachments)
        .set({ containerPath, turnId: turn.id })
        .where(eq(attachments.id, a.id))
        .run();
    }
  }

  return { blocks, patch, handoff };
};

/** After session.prompt is accepted: clear the one-time fields and record the handoff block that was sent. */
const commitContent = (
  core: WorkspaceCore,
  sessionId: string,
  turnId: string,
  content: PromptContent,
  sentAt: number,
): void => {
  if (content.handoff !== null) {
    core.insertItem({
      sessionId,
      turnId,
      kind: "handoff",
      status: "completed",
      content: { text: content.handoff },
      createdAt: sentAt,
    });
  }

  if (Object.keys(content.patch).length > 0) core.updateSession(sessionId, content.patch);
};

/**
 * The queue runner (03): starts the lowest queue_pos turn when the workspace is ready, setup is
 * fine, no turn runs, and no op other than housekeeping is pending or running.
 */
export const recoverSteering = (core: WorkspaceCore): void => {
  for (const turn of core.db.select().from(turns).where(eq(turns.steeringPending, 1)).all()) {
    core.updateTurn(turn.id, {
      steeringPending: 0,
      status: "failed",
      queuePos: null,
      endedAt: Date.now(),
      errorCode: "INTERNAL",
      errorDetail: "Steering delivery could not be confirmed. Check the agent response before retrying.",
    });
    core.notice(
      "warning",
      "Steering delivery could not be confirmed. Check the agent response before retrying.",
      turn.sessionId,
      turn.id,
    );
  }
};

/** Marks the queue busy while `work` runs. turns.cancel (archive) waits on `queueWork` (03 Archive 1). */
const whileQueueBusy = async <T>(core: WorkspaceCore, work: () => Promise<T>): Promise<T> => {
  let release!: () => void;
  core.queueBusy = true;
  core.queueWork = new Promise<void>((resolve) => (release = resolve));

  try {
    return await work();
  } finally {
    core.queueBusy = false;
    core.queueWork = null;
    core.turnStartAbort = null;
    core.startingTurnId = null;
    release();
  }
};

/** 03 Queue runner: a turn starts, or keeps starting, only while the workspace is ready or working. */
const turnAllowed = (core: WorkspaceCore): boolean => core.state === "ready" || core.state === "working";

export const steerQueued = async (core: WorkspaceCore, queued: TurnRow): Promise<Turn | null> => {
  const running = core.runningTurn();

  if (!running || running.sessionId !== queued.sessionId || core.queueBusy) return null;
  const session = core.sessionRow(queued.sessionId);

  if (json.capabilities.read(session.capabilitiesJson, {})["steering"] !== true) return null;

  try {
    return await whileQueueBusy(core, () => steer(core, session, queued, running));
  } finally {
    core.kickQueue();
  }
};

const steer = async (
  core: WorkspaceCore,
  session: SessionRow,
  queued: TurnRow,
  running: TurnRow,
): Promise<Turn | null> => {
  core.updateTurn(queued.id, { steeringPending: 1 });

  try {
    const content = await buildContent(core, session, queued);

    const result = await requireTempod(core).request("session.steer", {
      sessionId: session.id,
      turnId: running.id,
      messageId: queued.id,
      content: content.blocks,
    });

    if (result.outcome !== "injected") {
      core.updateTurn(queued.id, { steeringPending: 0 });

      return null;
    }

    commitContent(core, session.id, running.id, content, Date.now());

    for (const item of core.db.select().from(items).where(eq(items.turnId, queued.id)).all()) {
      core.updateItem(item.id, { turnId: running.id });
    }

    core.db.update(attachments).set({ turnId: running.id }).where(eq(attachments.turnId, queued.id)).run();
    core.db
      .update(reviewComments)
      .set({ sentTurnId: running.id })
      .where(eq(reviewComments.sentTurnId, queued.id))
      .run();
    core.deleteTurn(queued.id);
    core.broadcastDetailSoon();

    return core.turnToWire(core.turnRow(running.id));
  } catch (error) {
    // An ambiguous acknowledgement must never trigger an automatic duplicate prompt.
    const err = error instanceof TempoError ? error : new TempoError("INTERNAL");
    core.updateTurn(queued.id, {
      steeringPending: 0,
      status: "failed",
      queuePos: null,
      endedAt: Date.now(),
      errorCode: err.code,
      errorDetail: "Steering delivery could not be confirmed. Check the agent response before retrying.",
    });
    core.notice(
      "warning",
      "Steering delivery could not be confirmed. Check the agent response before retrying.",
      queued.sessionId,
      queued.id,
    );
    throw new TempoError(
      err.code,
      "Steering delivery could not be confirmed. Check the agent response before retrying.",
    );
  }
};

export const runQueue = async (
  core: WorkspaceCore,
  opsBusy: () => boolean,
  beforeStart: () => Promise<void> = async () => {},
): Promise<void> => {
  if (core.queueBusy || core.credentialsBusy) return;
  const row = core.wsOrNull();

  if (!row) return;

  if (core.runningTurn()) return;
  const next = core.queuedTurns()[0];

  const canStart =
    next !== undefined &&
    turnAllowed(core) &&
    ["none", "succeeded", "skipped"].includes(row.setupStatus) &&
    !opsBusy() &&
    !core.turnEndInProgress;

  if (!next || !canStart) {
    // 03 turn.ended step 6: if no turn starts, the state goes back to ready.
    backToReady(core);

    return;
  }

  const abort = new AbortController();

  try {
    await whileQueueBusy(core, async () => {
      await syncIdleCredentials(core, true);
      core.turnStartAbort = abort;
      core.startingTurnId = next.id;
      await beforeStart();

      return startTurn(core, next, abort.signal);
    });
  } finally {
    const status = core.db
      .select({ status: turns.status })
      .from(turns)
      .where(eq(turns.id, next.id))
      .get()?.status;

    if (status !== "queued") core.kickQueue();
  }
};

const backToReady = (core: WorkspaceCore): void => {
  if (core.state === "working" && !core.turnEndInProgress && !core.runningTurn()) core.setState("ready");
};

const startTurn = async (core: WorkspaceCore, turn: TurnRow, signal: AbortSignal): Promise<void> => {
  const session = core.sessionRow(turn.sessionId);

  if (session.status === "closed") {
    core.updateTurn(turn.id, { status: "cancelled", queuePos: null, endedAt: Date.now() });

    return;
  }

  let content: PromptContent | undefined;
  let sentAt = 0;

  try {
    await ensureSessionLive(core, session, signal);

    if (signal.aborted) return;

    if (!(await core.lifecycle.runs.beforeTurn(turn))) return;
    const fresh = core.sessionRow(session.id);
    content = await buildContent(core, fresh, turn);

    // The workspace left ready while the agent started (an archive): the turn stays queued and is not sent.
    if (signal.aborted || !turnAllowed(core)) {
      log("info", "turn start stopped before the prompt", { workspaceId: core.workspaceId });

      return;
    }

    sentAt = Date.now();
    await requireTempod(core).request("session.prompt", {
      sessionId: session.id,
      turnId: turn.id,
      content: content.blocks,
    });

    if (signal.aborted) {
      await requireTempod(core)
        .request("session.cancel", { sessionId: session.id, turnId: turn.id })
        .catch(() => undefined);

      return;
    }

    commitContent(core, session.id, turn.id, content, sentAt);

    if (core.turnRow(turn.id).status !== "queued") return;

    if (!turnAllowed(core)) {
      // The agent has the prompt, but the workspace may no longer run turns: cancel it at once.
      await requireTempod(core)
        .request("session.cancel", { sessionId: session.id, turnId: turn.id })
        .catch(() => undefined);
      finishTurn(core, turn.id, "cancelled", { stopReason: "cancelled" });

      return;
    }

    const now = Date.now();
    core.updateTurn(turn.id, { status: "running", startedAt: now, queuePos: null });
    core.updateSession(session.id, { status: "running" });

    if (core.state === "ready") core.setState("working");
    core.updateWs({ lastActivityAt: now });
    core.publish();
  } catch (e) {
    if (signal.aborted) {
      log("info", "turn start aborted", { workspaceId: core.workspaceId });

      return;
    }

    if (content && core.turnRow(turn.id).startedAt !== null) {
      commitContent(core, session.id, turn.id, content, sentAt);

      return;
    }

    const err = e instanceof TempoError ? e : new TempoError("AGENT_START_FAILED", undefined, errorText(e));

    if (err.code === "CONTAINER_NOT_READY" || err.code === "TEMPOD_UNREACHABLE") {
      // The turn stays queued; connectTempod runs the queue again once tempod is back.
      log("warn", "turn start deferred", { workspaceId: core.workspaceId, code: err.code });
      backToReady(core);

      return;
    }

    const code = Match.value(err).pipe(
      Match.when({ code: "CREDENTIAL_MISSING" }, () => "CREDENTIAL_MISSING"),
      Match.when({ code: "TEMPOD_TIMEOUT" }, () => "AGENT_START_FAILED"),
      Match.orElse((err) => err.code),
    );

    log("warn", "turn start failed", {
      workspaceId: core.workspaceId,
      code,
      error: err.detail ?? err.message,
    });
    core.liveSessions.delete(session.id);
    core.updateSession(session.id, { status: "idle" });
    finishTurn(core, turn.id, "failed", {
      stopReason: null,
      errorCode: code,
      errorDetail: err.detail ?? err.message,
    });

    if (session.runId && turn.origin !== "user")
      core.lifecycle.runs.fail(
        core.lifecycle.runs.row(session.runId),
        err.code === "RUN_ACCESS_VIOLATION" ? "RUN_ACCESS_VIOLATION" : "RUN_TURN_FAILED",
        err.code === "RUN_ACCESS_VIOLATION"
          ? "Protected login or config files could not be checked."
          : undefined,
      );
    core.recomputeAttention();
    core.lifecycle.kick();
    core.kickQueue();
  } finally {
    if (signal.aborted && session.runId && turn.origin !== "user") {
      const run = core.lifecycle.runs.row(session.runId);

      if (run.status !== "running") core.lifecycle.runs.close(run);
    }
  }
};

/** Marks a turn ended and closes its items. Returns false when the turn was not active. */
export const finishTurn = (
  core: WorkspaceCore,
  turnId: string,
  status: "completed" | "cancelled" | "failed" | "interrupted",
  info: {
    stopReason: string | null;
    errorCode?: string | null;
    errorDetail?: string | null;
    usage?: TurnUsage | null;
  },
): boolean => {
  const turn = core.db.select().from(turns).where(eq(turns.id, turnId)).get();

  if (!turn || (turn.status !== "running" && turn.status !== "queued")) return false;
  core.closeTurnItems(turnId, status === "completed" ? "completed" : "cancelled");
  // A request of an ended turn can no longer be answered (03 Activity and Attention count only pending ones).
  core.db
    .update(permissions)
    .set({ status: "cancelled", answeredAt: Date.now() })
    .where(and(eq(permissions.turnId, turnId), eq(permissions.status, "pending")))
    .run();

  if (status === "failed") {
    core.insertItem({
      sessionId: turn.sessionId,
      turnId,
      kind: "error",
      status: "completed",
      content: { code: info.errorCode ?? "INTERNAL", detail: info.errorDetail ?? null },
    });
  }

  let patch: Parameters<WorkspaceCore["updateTurn"]>[1] = {
    status,
    stopReason: info.stopReason,
    errorCode: info.errorCode ?? null,
    errorDetail: info.errorDetail?.slice(0, 2000) ?? null,
    endedAt: Date.now(),
    queuePos: null,
  };

  if (info.usage) patch = { ...patch, usageJson: json.turnUsage.write(info.usage) };
  core.updateTurn(turnId, patch);
  const session = core.db.select().from(sessions).where(eq(sessions.id, turn.sessionId)).get();

  if (session && session.status === "running") core.updateSession(session.id, { status: "idle" });

  return true;
};

/**
 * After a turn ends (03, turn.ended): checkpoint (awaited, it gates the next turn), then upload,
 * home backup and changes in the background; then activity, attention, summary, queue.
 */
export const afterTurnEnded = async (core: WorkspaceCore, turnId: string): Promise<void> => {
  core.turnEndInProgress = true;
  let bundle: Awaited<ReturnType<typeof takeCheckpoint>>["bundle"] = null;

  try {
    const res = await takeCheckpoint(core, "turn_end", turnId);

    if (res.checkpointId) core.updateTurn(turnId, { checkpointId: res.checkpointId });
    bundle = res.bundle;
  } catch (e) {
    log("warn", "turn checkpoint failed", { workspaceId: core.workspaceId, error: errorText(e) });
  } finally {
    try {
      await core.lifecycle.runs.turnEnded(turnId);
    } finally {
      core.turnEndInProgress = false;
    }
  }

  await syncIdleCredentials(core).catch((e) =>
    log("warn", "idle credential sync failed", { error: errorText(e) }),
  );
  const endedChange = core.turnRow(turnId).changeId;

  if (endedChange) core.lifecycle.checkEnd(endedChange);
  core.lifecycle.kick();
  core.updateWs({ lastActivityAt: Date.now() });
  core.recomputeAttention(false);
  core.publish();
  core.kickQueue();

  const background = (async () => {
    if (bundle) await uploadBundleWithRetry(core, bundle);
    await backupHomeIfDue(core);
    await refreshChanges(core).catch(() => undefined);
  })();

  core.ctx.waitUntil(background);
};

/** Deletes queued turns older than now that belong to a closed session. */
export const dropQueuedTurnsOf = (core: WorkspaceCore, sessionId: string): void => {
  const queued = core.db
    .select()
    .from(turns)
    .where(and(eq(turns.sessionId, sessionId), eq(turns.status, "queued")))
    .all();

  for (const t of queued) core.updateTurn(t.id, { status: "cancelled", queuePos: null, endedAt: Date.now() });
};
