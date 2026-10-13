import { and, eq, isNull, ne } from "drizzle-orm";
import { TempoError, unwrap, type FnInput, type FnOutput } from "@tempo/protocol";
import { parseRoleFile } from "@tempo/settings";
import { userRoles, workspaces } from "../../db/d1.ts";
import { baseRoles, ownedRoleText, parseRole, removeUserRole, withPrecedence } from "../../roles/catalog.ts";
import type { HandlerCtx } from "../run.ts";
import { d1 } from "./common.ts";
import { viaWorkspace } from "./workspaces.ts";

export const listRoles = async (
  ctx: HandlerCtx,
  input: FnInput<"listRoles">,
): Promise<FnOutput<"listRoles">> =>
  input.workspaceId
    ? viaWorkspace("listRoles")(ctx, input)
    : withPrecedence(await baseRoles(ctx.env, ctx.user.id)).map((r) => r.info);

export const getRoleText = async (
  ctx: HandlerCtx,
  input: FnInput<"getRoleText">,
): Promise<FnOutput<"getRoleText">> =>
  input.workspaceId
    ? viaWorkspace("getRoleText")(ctx, input)
    : ownedRoleText(ctx.env, ctx.user.id, input.name, input.scope);

const changed = async ({ env, user }: HandlerCtx): Promise<void> => {
  const live = await d1(env)
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(eq(workspaces.userId, user.id), isNull(workspaces.archivedAt), ne(workspaces.state, "archived")),
    )
    .all();

  await Promise.all(live.map(async (r) => unwrap(await env.WORKSPACE.getByName(r.id).rolesChanged())));
};

export const putUserRole = async (
  ctx: HandlerCtx,
  { name, text }: FnInput<"putUserRole">,
): Promise<FnOutput<"putUserRole">> => {
  parseRoleFile(name, text);
  await d1(ctx.env)
    .insert(userRoles)
    .values({ userId: ctx.user.id, name, text, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: [userRoles.userId, userRoles.name], set: { text, updatedAt: Date.now() } })
    .run();
  await changed(ctx);

  return (await parseRole(name, "user", text)).info;
};

export const deleteUserRole = async (
  ctx: HandlerCtx,
  { name }: FnInput<"deleteUserRole">,
): Promise<FnOutput<"deleteUserRole">> => {
  if (!(await removeUserRole(ctx.env, ctx.user.id, name))) throw new TempoError("NOT_FOUND");
  await changed(ctx);

  return {};
};
