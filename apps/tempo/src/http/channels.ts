import { CloseCode } from "@tempo/protocol";
import { getSessionUser, isOwner } from "../auth/auth.ts";
import type { Env } from "../env.ts";
import { appOrigin, closeWith, getOwnedWorkspace } from "./common.ts";
import { stripInternalHeaders } from "./preview.ts";

const TERMINAL_ID = /^t[1-9]$/;

/**
 * Upgrade rules for the hub, workspace and terminal channels (02, 07): a browser upgrade needs
 * the session cookie and `Origin: https://<APP_HOST>`; a native client sends a bearer token and
 * no Origin.
 */
export const handleChannel = async (request: Request, env: Env, url: URL): Promise<Response | null> => {
  const parts = url.pathname.split("/").filter(Boolean); // api ws <kind> ...

  if (parts[0] !== "api" || parts[1] !== "ws") return null;

  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
    return new Response("expected websocket", { status: 426 });
  const origin = request.headers.get("Origin");
  const bearer = request.headers.get("Authorization")?.toLowerCase().startsWith("bearer ") ?? false;

  if (origin !== null && origin !== appOrigin(env)) return new Response("forbidden origin", { status: 403 });

  if (origin === null && !bearer) return new Response("forbidden origin", { status: 403 });

  const user = await getSessionUser(env, request.headers, {
    allowCookie: origin !== null,
    allowBearer: true,
  });

  if (!user) return new Response("unauthenticated", { status: 401 });

  if (!(await isOwner(env, user.id))) return new Response("forbidden", { status: 403 });
  const kind = parts[2];
  // The WorkspaceDO's fetch() trusts x-tempo-* headers; a client must not send them.
  const inner = new Request(request, { headers: stripInternalHeaders(new Headers(request.headers)) });

  if (kind === "hub" && parts.length === 3) return env.USER_HUB.getByName(user.id).fetch(inner);
  const workspaceId = parts[3];

  if (!workspaceId) return new Response("not found", { status: 404 });
  const owned = await getOwnedWorkspace(env, user.id, workspaceId);

  if (!owned) return closeWith(CloseCode.workspaceNotFound, "workspace not found");

  if (kind === "workspace" && parts.length === 4) return env.WORKSPACE.getByName(workspaceId).fetch(inner);

  if (kind === "terminal" && parts.length === 5 && TERMINAL_ID.test(parts[4]!)) {
    return env.WORKSPACE.getByName(workspaceId).fetch(inner);
  }

  return new Response("not found", { status: 404 });
};
