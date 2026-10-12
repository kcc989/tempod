import { TempoError, newId, toErrorBody } from "@tempo/protocol";
import { requireOwner } from "../auth/auth.ts";
import type { Env } from "../env.ts";
import { appOrigin, errorOf, errorResponse, getOwnedWorkspace } from "./common.ts";

const MAX_BYTES = 10 * 1024 * 1024;

/** POST /api/workspaces/<workspaceId>/attachments: multipart, one file, at most 10 MiB (02). */
export const handleAttachment = async (
  request: Request,
  env: Env,
  workspaceId: string,
): Promise<Response> => {
  try {
    const origin = request.headers.get("Origin");
    const bearer = request.headers.get("Authorization")?.toLowerCase().startsWith("bearer ") ?? false;
    if (origin !== null && origin !== appOrigin(env)) return errorOf("FORBIDDEN");
    const user = await requireOwner(env, request.headers, { allowCookie: !bearer, allowBearer: bearer });
    const ws = await getOwnedWorkspace(env, user.id, workspaceId);
    if (!ws) return errorOf("NOT_FOUND");
    if (ws.archivedAt !== null) return errorOf("WORKSPACE_ARCHIVED");
    const declared = Number(request.headers.get("Content-Length") ?? "0");
    if (declared > MAX_BYTES + 64 * 1024) return errorOf("FILE_TOO_LARGE");
    const form = await request.formData();
    const files = [...(form as unknown as Iterable<[string, unknown]>)]
      .map(([, v]) => v)
      .filter((v): v is File => typeof v === "object" && v !== null && "stream" in v);
    if (files.length !== 1) throw new TempoError("VALIDATION_FAILED", undefined, "send exactly one file");
    const file = files[0]!;
    if (file.size > MAX_BYTES) return errorOf("FILE_TOO_LARGE");
    const name = sanitizeName(file.name || "file");
    const mime = file.type || "application/octet-stream";
    const attachmentId = newId();
    const r2Key = `attachments/${workspaceId}/${attachmentId}/${name}`;
    await env.DATA.put(r2Key, file.stream(), { httpMetadata: { contentType: mime } });
    await env.WORKSPACE.getByName(workspaceId).registerAttachment({
      id: attachmentId,
      name,
      mime,
      size: file.size,
      r2Key,
    });
    return Response.json({ attachmentId, name, mime, size: file.size });
  } catch (e) {
    return errorResponse(toErrorBody(e));
  }
};

export const sanitizeName = (name: string): string =>
  name
    .replace(/[/\\\0]/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 200) || "file";

/** Authenticated bytes; the DO resolves metadata before the Worker reads R2. */
export const handleAttachmentRead = async (
  request: Request,
  env: Env,
  workspaceId: string,
  attachmentId: string,
): Promise<Response> => {
  try {
    const origin = request.headers.get("Origin");
    if (origin !== null && origin !== appOrigin(env)) return errorOf("FORBIDDEN");
    const bearer = request.headers.get("Authorization")?.toLowerCase().startsWith("bearer ") ?? false;
    const user = await requireOwner(env, request.headers, { allowCookie: !bearer, allowBearer: bearer });
    if (!(await getOwnedWorkspace(env, user.id, workspaceId))) return errorOf("NOT_FOUND");
    const a = await env.WORKSPACE.getByName(workspaceId).getAttachment(attachmentId);
    if (!a) return errorOf("NOT_FOUND");
    if (a.size > MAX_BYTES) return errorOf("FILE_TOO_LARGE");
    const object = await env.DATA.get(`attachments/${workspaceId}/${a.id}/${a.name}`);
    if (!object) return errorOf("NOT_FOUND");
    if (object.size !== a.size || object.size > MAX_BYTES) return errorOf("FILE_TOO_LARGE");
    const image = ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(a.mime);
    return new Response(object.body, {
      headers: {
        "Content-Type": image ? a.mime : "application/octet-stream",
        "Content-Length": String(object.size),
        "Content-Disposition": image ? "inline" : "attachment",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (e) {
    return errorResponse(toErrorBody(e));
  }
};
