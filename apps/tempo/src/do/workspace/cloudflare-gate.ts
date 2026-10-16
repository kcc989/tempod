import { and, eq } from "drizzle-orm";
import { TempoError, newId, type CloudflareHoldContent } from "@tempo/protocol";
import { cloudflareHolds, intents, sessions, type CloudflareHoldRow } from "../../db/workspace-do.ts";
import { gateRule } from "../../deploy/cf-gate.ts";
import { agentCloudflareTokenKey } from "../../deploy/types.ts";
import { judgeCloudflareCall, ownerJudge, type Judge } from "../../judge/jev.ts";
import { errorText, log } from "../../log.ts";
import type { WorkspaceCore } from "./core.ts";

/** 13, L-ADR-8: exact texts. */
export const CF_GATE_TEXT = {
  held: "tempo: held for owner approval",
  refused: "tempo: the owner refused this request",
  noAccess: "tempo: no Cloudflare access for this project",
} as const;

/** Mint a new token when the current one has less than this left. */
const TOKEN_MARGIN_MS = 5 * 60_000;

/** Tests replace the judge; the default reads the owner's TypeSafe AI key. */
export const cloudflareJudge = {
  for: (core: WorkspaceCore): Promise<Judge | null> => ownerJudge(core.env, core.ws().userId),
};

export type GateAnswer = { readonly allow: true } | { readonly allow: false; readonly body: string };

const holdContent = (r: CloudflareHoldRow): CloudflareHoldContent => ({
  holdId: r.id,
  method: r.method,
  path: r.path,
  resource: r.resource,
  // SAFETY: reasons_json is written only by `hold` from a string array.
  reasons: JSON.parse(r.reasonsJson) as string[],
  status: r.status,
});

export const pendingHold = (core: WorkspaceCore): boolean =>
  core.db
    .select({ id: cloudflareHolds.id })
    .from(cloudflareHolds)
    .where(eq(cloudflareHolds.status, "pending"))
    .all().length > 0;

const holdRow = (core: WorkspaceCore, id: string): CloudflareHoldRow => {
  const r = core.db.select().from(cloudflareHolds).where(eq(cloudflareHolds.id, id)).get();

  if (!r) throw new TempoError("NOT_FOUND");

  return r;
};

const show = (core: WorkspaceCore, r: CloudflareHoldRow): void => {
  const status = r.status === "pending" ? "pending" : "completed";

  if (r.itemId) {
    core.updateItem(r.itemId, { status, content: holdContent(r) });

    return;
  }

  if (!r.sessionId) return;

  const item = core.insertItem({
    sessionId: r.sessionId,
    turnId: core.runningTurn()?.id ?? null,
    kind: "cloudflare_hold",
    status,
    content: holdContent(r),
  });

  core.db.update(cloudflareHolds).set({ itemId: item.id }).where(eq(cloudflareHolds.id, r.id)).run();
};

/** The request's open hold: a pending, allowed or refused row for the same method and path. */
const openHold = (core: WorkspaceCore, method: string, path: string): CloudflareHoldRow | undefined =>
  core.db
    .select()
    .from(cloudflareHolds)
    .where(and(eq(cloudflareHolds.method, method), eq(cloudflareHolds.path, path)))
    .all()
    .find((r) => r.status !== "used");

const chatSession = (core: WorkspaceCore): string | null => {
  const running = core.runningTurn();

  if (running) return running.sessionId;

  return (
    core.db
      .select({ id: sessions.id, status: sessions.status, updatedAt: sessions.updatedAt })
      .from(sessions)
      .all()
      .filter((s) => s.status !== "closed")
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id ?? null
  );
};

const hold = (
  core: WorkspaceCore,
  method: string,
  path: string,
  resource: string | null,
  reasons: string[],
) => {
  const id = newId();

  core.db
    .insert(cloudflareHolds)
    .values({
      id,
      sessionId: chatSession(core),
      itemId: null,
      method,
      path,
      resource,
      reasonsJson: JSON.stringify(reasons),
      status: "pending",
      createdAt: Date.now(),
      decidedAt: null,
    })
    .run();
  show(core, holdRow(core, id));
  core.recomputeAttention();
};

/** The confirmed intent of the chat whose turn is running, or null. */
const confirmedIntent = (core: WorkspaceCore) => {
  const running = core.runningTurn();

  if (!running) return null;
  const r = core.db.select().from(intents).where(eq(intents.sessionId, running.sessionId)).get();

  return r?.status === "confirmed" && r.goal
    ? { goal: r.goal, approach: r.approach, notDoing: r.notDoing }
    : null;
};

/** 13, L-ADR-8: decides one Cloudflare API request from the agent. */
export const cloudflareGate = async (
  core: WorkspaceCore,
  rawMethod: string,
  path: string,
): Promise<GateAnswer> => {
  const method = rawMethod.toUpperCase();
  const existing = openHold(core, method, path);

  if (existing?.status === "pending") return { allow: false, body: CF_GATE_TEXT.held };

  if (existing?.status === "refused") return { allow: false, body: CF_GATE_TEXT.refused };

  if (existing?.status === "allowed") {
    core.db.update(cloudflareHolds).set({ status: "used" }).where(eq(cloudflareHolds.id, existing.id)).run();
    show(core, holdRow(core, existing.id));

    return { allow: true };
  }

  const res = await core.env.APP_DEPLOY.getByName(core.ws().projectId).cloudflareResources();

  if (!res.ok || !res.value) return { allow: false, body: CF_GATE_TEXT.noAccess };
  const rule = gateRule(method, path, res.value);

  if (rule.action === "allow") return { allow: true };

  if (rule.action === "refuse") return { allow: false, body: rule.body };

  if (rule.action === "hold") {
    hold(core, method, path, null, rule.reasons);

    return { allow: false, body: CF_GATE_TEXT.held };
  }

  const intent = confirmedIntent(core);

  if (!intent) {
    hold(core, method, path, rule.resource, ["no_intent"]);

    return { allow: false, body: CF_GATE_TEXT.held };
  }

  const judgement = await judgeCloudflareCall(
    await cloudflareJudge.for(core),
    { method, path, resource: rule.resource },
    intent,
  );

  if (!judgement.high) return { allow: true };
  hold(core, method, path, rule.resource, [...judgement.reasons]);

  return { allow: false, body: CF_GATE_TEXT.held };
};

/** `decideCloudflareHold`: the owner allows the request once, or refuses it. A repeat does nothing. */
export const decideCloudflareHold = (core: WorkspaceCore, holdId: string, allow: boolean): void => {
  const r = holdRow(core, holdId);

  if (r.status !== "pending") return;
  core.db
    .update(cloudflareHolds)
    .set({ status: allow ? "allowed" : "refused", decidedAt: Date.now() })
    .where(eq(cloudflareHolds.id, r.id))
    .run();
  show(core, holdRow(core, r.id));
  core.recomputeAttention();
};

type AgentToken = {
  readonly tokenId: string;
  readonly expiresAt: number;
  /** Absent for tokens minted before grants (12, Access requests and grants). */
  readonly permissions?: ReadonlyArray<string>;
};

/** The token was minted for other permissions than the project's grant now holds. */
export const agentTokenStale = (core: WorkspaceCore, permissions: ReadonlyArray<string>): boolean => {
  const current = core.kv<AgentToken>("cfAgentToken");

  return (
    current !== undefined &&
    (current.permissions === undefined ||
      current.permissions.length !== permissions.length ||
      current.permissions.some((p) => !permissions.includes(p)))
  );
};

/** The workspace's minted Cloudflare token (13, L-ADR-8, 1). Mints a new one when it is near its end. */
export const agentCloudflareToken = async (core: WorkspaceCore): Promise<string | null> => {
  const current = core.kv<AgentToken>("cfAgentToken");
  const creds = core.credentials();

  if (current && current.expiresAt - Date.now() > TOKEN_MARGIN_MS) {
    const value = await creds.getSecret(agentCloudflareTokenKey(core.workspaceId));

    if (value) return value;
  }

  const res = await core.env.APP_DEPLOY.getByName(core.ws().projectId).mintAgentToken(core.workspaceId);

  if (!res.ok || !res.value) return null;
  core.setKv("cfAgentToken", res.value);

  if (current) await revokeAgentToken(core, current.tokenId);

  return creds.getSecret(agentCloudflareTokenKey(core.workspaceId));
};

const revokeAgentToken = async (core: WorkspaceCore, tokenId: string): Promise<void> => {
  const res = await core.env.APP_DEPLOY.getByName(core.ws().projectId)
    .revokeAgentToken(tokenId)
    .catch((e) => ({ ok: false as const, error: errorText(e) }));

  if (!res.ok) log("warn", "agent token revoke failed", { workspaceId: core.workspaceId });
};

/** Revokes the workspace's token when no open chat may use the Cloudflare API any more. */
export const releaseAgentToken = async (core: WorkspaceCore): Promise<void> => {
  const current = core.kv<AgentToken>("cfAgentToken");

  if (!current) return;
  core.setKv("cfAgentToken", undefined);
  await core.credentials().deleteSecret(agentCloudflareTokenKey(core.workspaceId));
  await revokeAgentToken(core, current.tokenId);
};
