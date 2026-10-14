import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { errorMessage, type ErrorBody, type ErrorCode } from "@tempo/protocol";
import { atLeast, memberRoleOf } from "../auth/access.ts";
import { projects, workspaces, type WorkspaceRow } from "../db/d1.ts";
import type { Env } from "../env.ts";

export const STATUS_BY_CODE: Partial<Record<ErrorCode, number>> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  SETTINGS_INVALID: 400,
  FILE_TOO_LARGE: 413,
  CONTAINER_NOT_READY: 503,
  INTERNAL: 500,
};

export const errorResponse = (body: ErrorBody): Response =>
  Response.json(body, { status: STATUS_BY_CODE[body.code] ?? 409 });

export const errorOf = (code: ErrorCode, detail?: string): Response =>
  errorResponse(
    detail ? { code, message: errorMessage(code), detail } : { code, message: errorMessage(code) },
  );

export const getOwnedWorkspace = async (
  env: Env,
  userId: string,
  workspaceId: string,
): Promise<WorkspaceRow | null> =>
  (await drizzle(env.DB)
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.userId, userId)))
    .get()) ?? null;

/**
 * The caller's own workspace, while they still have `write` on its project (11, Function access).
 * `"forbidden"` means the workspace exists but its user lost `write`.
 */
export const getWritableWorkspace = async (
  env: Env,
  userId: string,
  workspaceId: string,
): Promise<WorkspaceRow | "forbidden" | null> => {
  const ws = await getOwnedWorkspace(env, userId, workspaceId);

  if (!ws) return null;

  return (await canWriteProject(env, userId, ws.projectId)) ? ws : "forbidden";
};

export const canWriteProject = async (env: Env, userId: string, projectId: string): Promise<boolean> => {
  const project = await drizzle(env.DB).select().from(projects).where(eq(projects.id, projectId)).get();

  return project !== undefined && atLeast(await memberRoleOf(env, userId, project), "write");
};

export const appOrigin = (env: Env): string =>
  env.APP_HOST.startsWith("localhost") ? `http://${env.APP_HOST}` : `https://${env.APP_HOST}`;

/** Closes a fresh WebSocket with an application close code (02, close codes). */
export const closeWith = (code: number, reason: string): Response => {
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].close(code, reason);

  return new Response(null, { status: 101, webSocket: pair[0] });
};

export const html = (body: string, status = 200): Response =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tempo setup</title><style>body{font:14px system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;color:#111;background:#fff}@media(prefers-color-scheme:dark){body{color:#eee;background:#111}}input,button,select{font:inherit;padding:6px 10px}code{font-family:ui-monospace,monospace}</style></head><body>${body}</body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    },
  );

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
