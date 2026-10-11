import { Files } from "@cloudflare/sandbox";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  HANDOFF_FIRST_LINE,
  HANDOFF_MAX_CHARS,
  PLACEHOLDER,
  TempoError,
  type AgentId,
  type ContentBlock,
  type TurnPrompt,
} from "@tempo/protocol";
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
import { requireTempod } from "./container.ts";
import { parseJson, type WorkspaceCore } from "./core.ts";
import { backupHomeIfDue, takeCheckpoint, uploadBundleWithRetry } from "./durability.ts";
import { refreshChanges } from "./git.ts";

/** Default modes (01, Agents table). OpenCode and Pi use the agent's own default. */
export const DEFAULT_MODE: Record<AgentId, string | null> = {
  claude: "bypassPermissions",
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
export const agentEnv = async (core: WorkspaceCore, agent: AgentId): Promise<Record<string, string>> => {
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
        await requireTempod(core).request("credential.put", {
          provider: "codex",
          content: auth.content,
          version: auth.version,
        });
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

/** Starts (or reloads) the session's adapter in tempod and stores what the agent reports. */
export const ensureSessionLive = async (core: WorkspaceCore, session: SessionRow): Promise<void> => {
  if (core.liveSessions.has(session.id)) return;
  const tempod = requireTempod(core);
  const agent = session.agent as AgentId;
  const env = await agentEnv(core, agent);
  const config = parseJson<Record<string, unknown>>(session.configJson, {});
  const settings = core.settings();
  const model =
    typeof config["model"] === "string"
      ? (config["model"] as string)
      : agent === settings.agent.default && settings.agent.model
        ? settings.agent.model
        : null;
  const res = await tempod.request("session.start", {
    sessionId: session.id,
    agent,
    env,
    modeId: session.modeId ?? DEFAULT_MODE[agent],
    model,
    acpSessionId: session.acpSessionId,
  });
  core.liveSessions.add(session.id);
  core.updateSession(session.id, {
    acpSessionId: res.acpSessionId,
    status: "idle",
    modesJson: JSON.stringify(res.modes),
    modeId: res.modeId ?? session.modeId ?? DEFAULT_MODE[agent],
    configOptionsJson: JSON.stringify(res.configOptions),
    commandsJson: JSON.stringify(res.availableCommands),
    capabilitiesJson: JSON.stringify(res.capabilities),
    ...(res.handoff ? { handoffPending: 1 } : {}),
  });
  for (const [configId, value] of Object.entries(config)) {
    if (configId === "model") continue;
    const option = res.configOptions.find((o) => o.id === configId);
    if (
      option &&
      option.currentValue !== value &&
      (typeof value === "string" || typeof value === "boolean")
    ) {
      const r = await tempod.request("session.setConfig", { sessionId: session.id, configId, value });
      core.updateSession(session.id, { configOptionsJson: JSON.stringify(r.configOptions) });
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
    const c = parseJson<{ text?: string; title?: string }>(r.contentJson, {});
    if (r.kind === "user_message") return `User: ${c.text ?? ""}`;
    if (r.kind === "agent_message") return `Agent: ${c.text ?? ""}`;
    return `Tool: ${c.title ?? ""}`;
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
  const prompt = parseJson<TurnPrompt>(turn.promptJson, {
    text: "",
    mentions: [],
    attachmentIds: [],
    reviewCommentIds: [],
  });
  const blocks: ContentBlock[] = [];
  const settings = core.settings();
  const patch: Partial<SessionRow> = {};
  let handoff: string | null = null;
  if (session.generalPromptSent === 0) {
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
    const caps = parseJson<{ promptCapabilities?: { image?: boolean } }>(session.capabilitiesJson, {});
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
      if (isImage && caps.promptCapabilities?.image && a.sizeBytes <= MAX_INLINE_IMAGE_BYTES) {
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
export const runQueue = async (core: WorkspaceCore, opsBusy: () => boolean): Promise<void> => {
  if (core.queueBusy) return;
  const row = core.wsOrNull();
  if (!row) return;
  if (core.runningTurn()) return;
  const state = row.state;
  const next = core.queuedTurns()[0];
  const canStart =
    next !== undefined &&
    (state === "ready" || state === "working") &&
    ["none", "succeeded", "skipped"].includes(row.setupStatus) &&
    !opsBusy() &&
    !core.turnEndInProgress;
  if (!next || !canStart) {
    // 03 turn.ended step 6: if no turn starts, the state goes back to ready.
    backToReady(core);
    return;
  }
  core.queueBusy = true;
  try {
    await startTurn(core, next);
  } finally {
    core.queueBusy = false;
  }
};

const backToReady = (core: WorkspaceCore): void => {
  if (core.state === "working" && !core.turnEndInProgress && !core.runningTurn()) core.setState("ready");
};

const startTurn = async (core: WorkspaceCore, turn: TurnRow): Promise<void> => {
  const session = core.sessionRow(turn.sessionId);
  if (session.status === "closed") {
    core.updateTurn(turn.id, { status: "cancelled", queuePos: null, endedAt: Date.now() });
    return;
  }
  try {
    await ensureSessionLive(core, session);
    const fresh = core.sessionRow(session.id);
    const content = await buildContent(core, fresh, turn);
    const sentAt = Date.now();
    await requireTempod(core).request("session.prompt", {
      sessionId: session.id,
      turnId: turn.id,
      content: content.blocks,
    });
    commitContent(core, session.id, turn.id, content, sentAt);
    const now = Date.now();
    core.updateTurn(turn.id, { status: "running", startedAt: now, queuePos: null });
    core.updateSession(session.id, { status: "running" });
    if (core.state !== "working") core.setState("working");
    core.updateWs({ lastActivityAt: now });
    core.publish();
  } catch (e) {
    const err = e instanceof TempoError ? e : new TempoError("AGENT_START_FAILED", undefined, errorText(e));
    if (err.code === "CONTAINER_NOT_READY" || err.code === "TEMPOD_UNREACHABLE") {
      // The turn stays queued; connectTempod runs the queue again once tempod is back.
      log("warn", "turn start deferred", { workspaceId: core.workspaceId, code: err.code });
      backToReady(core);
      return;
    }
    const code =
      err.code === "CREDENTIAL_MISSING"
        ? "CREDENTIAL_MISSING"
        : err.code === "TEMPOD_TIMEOUT"
          ? "AGENT_START_FAILED"
          : err.code;
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
    core.recomputeAttention();
    core.kickQueue();
  }
};

/** Marks a turn ended and closes its items. Returns false when the turn was not active. */
export const finishTurn = (
  core: WorkspaceCore,
  turnId: string,
  status: "completed" | "cancelled" | "failed" | "interrupted",
  info: { stopReason: string | null; errorCode?: string | null; errorDetail?: string | null },
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
  core.updateTurn(turnId, {
    status,
    stopReason: info.stopReason,
    errorCode: info.errorCode ?? null,
    errorDetail: info.errorDetail?.slice(0, 2000) ?? null,
    endedAt: Date.now(),
    queuePos: null,
  });
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
    core.turnEndInProgress = false;
  }
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
