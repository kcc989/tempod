import { ARTIFACT_HOST_LABEL, toErrorBody } from "@tempo/protocol";
import { requireUser } from "../auth/auth.ts";
import type { Env } from "../env.ts";
import { log } from "../log.ts";
import { appOrigin, errorOf, errorResponse, getWritableWorkspace } from "./common.ts";
import { previewNotFound } from "./preview.ts";

export const ARTIFACT_COOKIE = "__Host-tempo_artifact";

export const ARTIFACT_ROUTE =
  /^\/api\/workspaces\/([0-9a-hjkmnp-tv-z]{26})\/artifacts\/([0-9a-hjkmnp-tv-z]{26})\/(\d{1,9})$/;

const ROUTE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

const ENTER_PATH = "/__tempo/enter";

const CODE = /^[a-z0-9]{32}$/;

const PRIVACY_HEADERS = { "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" } as const;

const disposition = (kind: "inline" | "attachment", name?: string): string =>
  name ? `${kind}; filename*=UTF-8''${encodeURIComponent(name)}` : kind;

/**
 * The artifact route (02): `GET /api/workspaces/<id>/artifacts/<artifactId>/<version>`. Images,
 * Markdown and text are inline; HTML and PDFs are only downloads here (05).
 */
export const handleArtifactRead = async (
  request: Request,
  env: Env,
  url: URL,
  workspaceId: string,
  artifactId: string,
  version: number,
): Promise<Response> => {
  try {
    const origin = request.headers.get("Origin");

    if (origin !== null && origin !== appOrigin(env)) return errorOf("FORBIDDEN");
    const bearer = request.headers.get("Authorization")?.toLowerCase().startsWith("bearer ") ?? false;
    const user = await requireUser(env, request.headers, { allowCookie: !bearer, allowBearer: bearer });
    const ws = await getWritableWorkspace(env, user.id, workspaceId);

    if (!ws) return errorOf("NOT_FOUND");

    if (ws === "forbidden") return errorOf("FORBIDDEN");
    const a = await env.WORKSPACE.getByName(workspaceId).getArtifact(artifactId, version);

    if (!a || a.status === "lost") return errorOf("NOT_FOUND");

    if (a.status === "uploading") return errorOf("ARTIFACT_NOT_READY");
    const object = await env.DATA.get(`artifacts/${workspaceId}/${a.id}/${a.version}/${a.name}`);

    if (!object) return errorOf("NOT_FOUND");
    const download = url.searchParams.get("download") === "1";
    const renders = a.kind === "image" || a.kind === "markdown" || a.kind === "text";

    return new Response(object.body, {
      headers: {
        "Content-Type": renders ? a.mime : "application/octet-stream",
        "Content-Length": String(object.size),
        "Content-Disposition":
          download || !renders ? disposition("attachment", a.name) : disposition("inline"),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": ROUTE_CSP,
      },
    });
  } catch (e) {
    return errorResponse(toErrorBody(e));
  }
};

export const parseArtifactHost = (
  host: string,
  env: Env,
): { artifactId: string; workspaceId: string } | null => {
  const suffix = `.${env.PREVIEW_DOMAIN.toLowerCase()}`;
  const lower = host.toLowerCase();

  if (!lower.endsWith(suffix)) return null;
  const m = ARTIFACT_HOST_LABEL.exec(lower.slice(0, -suffix.length));

  return m ? { artifactId: m[1]!, workspaceId: m[2]! } : null;
};

const takeCookie = (header: string | null): string | null => {
  let value: string | null = null;

  for (const part of (header ?? "").split(";")) {
    const pair = part.trim();
    const eq = pair.indexOf("=");

    if (eq >= 0 && pair.slice(0, eq).trim() === ARTIFACT_COOKIE) value = pair.slice(eq + 1).trim();
  }

  return value;
};

/**
 * 05 Artifact access on `a-<artifactId>-<workspaceId>.<PREVIEW_DOMAIN>`: `/__tempo/enter` trades a
 * code for the cookie; every other request goes to artifactFetch. Never logs codes, cookies or URLs.
 */
export const handleArtifactHost = async (
  request: Request,
  env: Env,
  url: URL,
  parsed: { artifactId: string; workspaceId: string },
): Promise<Response> => {
  const stub = env.WORKSPACE.getByName(parsed.workspaceId);

  try {
    if (url.pathname.startsWith("/__tempo/")) {
      if (url.pathname !== ENTER_PATH || request.method !== "GET") return previewNotFound();
      const code = url.searchParams.get("code") ?? "";

      if (!CODE.test(code)) return previewNotFound();
      const entered = await stub.artifactEnter(parsed.artifactId, code);

      if (!entered) return previewNotFound();

      return new Response(null, {
        status: 303,
        headers: {
          Location: entered.location,
          "Set-Cookie": `${ARTIFACT_COOKIE}=${entered.cookie}; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=86400`,
          "Cache-Control": "no-store",
          ...PRIVACY_HEADERS,
        },
      });
    }

    const cookie = takeCookie(request.headers.get("Cookie"));

    if (!cookie) return previewNotFound();

    return await stub.artifactFetch(
      new Request(url.toString(), { method: request.method }),
      parsed.artifactId,
      cookie,
    );
  } catch (e) {
    log("error", "artifact request failed", {
      workspaceId: parsed.workspaceId,
      artifactId: parsed.artifactId,
      error: e instanceof Error ? e.name : "unknown",
    });

    return new Response("Something went wrong.", { status: 502, headers: PRIVACY_HEADERS });
  }
};
