import { Schema } from "effect";
import { and, eq } from "drizzle-orm";
import {
  DEPLOY_PERMISSIONS,
  DeployPermission,
  TempoError,
  newId,
  unwrap,
  type CloudflareAccessContent,
} from "@tempo/protocol";
import {
  cloudflareAccessRequests,
  type CloudflareAccessRow,
  type SessionRow,
} from "../../db/workspace-do.ts";
import type { WorkspaceCore } from "./core.ts";
import { queueChatTurn } from "./intent.ts";

/** 12, Access requests and grants: exact texts. */
export const ACCESS_TEXT = {
  granted: (list: string) => `Already granted: ${list}.`,
  asked: (list: string) =>
    `Tempo asked the owner for ${list}. End your turn; you will get the answer as a message.`,
  waiting: "A Cloudflare access request is already waiting for the owner.",
  approved: (list: string) => `The owner approved Cloudflare access: ${list}.`,
  denied: (list: string) => `The owner denied Cloudflare access: ${list}.`,
} as const;

const RequestInput = Schema.Struct({
  permissions: Schema.Array(DeployPermission).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(DEPLOY_PERMISSIONS.length),
  ),
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
});

const permissionsOf = (r: CloudflareAccessRow): DeployPermission[] =>
  Schema.decodeUnknownSync(Schema.Array(DeployPermission))(JSON.parse(r.permissionsJson)).slice();

const content = (r: CloudflareAccessRow): CloudflareAccessContent => ({
  requestId: r.id,
  permissions: permissionsOf(r),
  reason: r.reason,
  status: r.status,
});

const requestRow = (core: WorkspaceCore, id: string): CloudflareAccessRow => {
  const r = core.db.select().from(cloudflareAccessRequests).where(eq(cloudflareAccessRequests.id, id)).get();

  if (!r) throw new TempoError("NOT_FOUND");

  return r;
};

export const pendingAccess = (core: WorkspaceCore): boolean =>
  core.db
    .select({ id: cloudflareAccessRequests.id })
    .from(cloudflareAccessRequests)
    .where(eq(cloudflareAccessRequests.status, "pending"))
    .all().length > 0;

const show = (core: WorkspaceCore, r: CloudflareAccessRow): void => {
  const status = r.status === "pending" ? "pending" : "completed";

  if (r.itemId) {
    core.updateItem(r.itemId, { status, content: content(r) });

    return;
  }

  const running = core.runningTurn();

  const item = core.insertItem({
    sessionId: r.sessionId,
    turnId: running?.sessionId === r.sessionId ? running.id : null,
    kind: "cloudflare_access",
    status,
    content: content(r),
  });

  core.db
    .update(cloudflareAccessRequests)
    .set({ itemId: item.id })
    .where(eq(cloudflareAccessRequests.id, r.id))
    .run();
};

/** The `request_cloudflare_access` tool. Returns the tool's answer text. */
export const requestCloudflareAccess = async (
  core: WorkspaceCore,
  session: SessionRow,
  params: Schema.Json,
): Promise<string> => {
  const input = Schema.decodeUnknownSync(RequestInput)(params);
  const asked = DEPLOY_PERMISSIONS.filter((p) => input.permissions.includes(p));
  const grants = unwrap(await core.env.APP_DEPLOY.getByName(core.ws().projectId).listGrants());
  const missing = asked.filter((p) => !grants.some((g) => g.permission === p));

  if (missing.length === 0) return ACCESS_TEXT.granted(asked.join(", "));

  const waiting = core.db
    .select({ id: cloudflareAccessRequests.id })
    .from(cloudflareAccessRequests)
    .where(
      and(eq(cloudflareAccessRequests.sessionId, session.id), eq(cloudflareAccessRequests.status, "pending")),
    )
    .get();

  if (waiting) throw new TempoError("VALIDATION_FAILED", ACCESS_TEXT.waiting);
  const id = newId();

  core.db
    .insert(cloudflareAccessRequests)
    .values({
      id,
      sessionId: session.id,
      itemId: null,
      permissionsJson: JSON.stringify(missing),
      reason: input.reason.trim(),
      status: "pending",
      createdAt: Date.now(),
      decidedAt: null,
    })
    .run();
  show(core, requestRow(core, id));
  core.recomputeAttention();

  return ACCESS_TEXT.asked(missing.join(", "));
};

/** `decideCloudflareAccess`. Approve adds the permissions to the project's grant. A repeat does nothing. */
export const decideCloudflareAccess = async (
  core: WorkspaceCore,
  requestId: string,
  approve: boolean,
): Promise<void> => {
  const r = requestRow(core, requestId);

  if (r.status !== "pending") return;
  const permissions = permissionsOf(r);

  if (approve)
    unwrap(
      await core.env.APP_DEPLOY.getByName(core.ws().projectId).grant({
        permissions,
        workspaceId: core.workspaceId,
        requestId: r.id,
      }),
    );

  const decided = core.db
    .update(cloudflareAccessRequests)
    .set({ status: approve ? "approved" : "denied", decidedAt: Date.now() })
    .where(and(eq(cloudflareAccessRequests.id, r.id), eq(cloudflareAccessRequests.status, "pending")))
    .returning({ id: cloudflareAccessRequests.id })
    .all();

  if (decided.length === 0) return;
  show(core, requestRow(core, r.id));
  const list = permissions.join(", ");
  const session = core.sessionRow(r.sessionId);

  if (session.status !== "closed")
    queueChatTurn(core, r.sessionId, null, approve ? ACCESS_TEXT.approved(list) : ACCESS_TEXT.denied(list));
  core.recomputeAttention();
};
