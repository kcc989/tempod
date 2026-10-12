import type { Env } from "../env.ts";
import { log } from "../log.ts";

export const PREVIEW_HEADER = "x-tempo-preview";
export const PREVIEW_COOKIE = "__Host-tempo_preview";
export const PREVIEW_NOT_FOUND_TEXT = "This preview opens only from Tempo.";

const LABEL = /^(\d{4,5})-([0-9a-hjkmnp-tv-z]{26})$/;
const ENTER_PATH = "/__tempo/enter";
const CODE = /^[a-z0-9]{32}$/;

export const isPreviewHost = (host: string, env: Env): boolean =>
  host.toLowerCase().endsWith(`.${env.PREVIEW_DOMAIN.toLowerCase()}`);

export const parsePreviewHost = (host: string, env: Env): { port: number; workspaceId: string } | null => {
  const suffix = `.${env.PREVIEW_DOMAIN.toLowerCase()}`;
  const label = host.toLowerCase().slice(0, -suffix.length);
  const m = LABEL.exec(label);
  if (!m) return null;
  return { port: Number(m[1]), workspaceId: m[2]! };
};

const PRIVACY_HEADERS = { "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" } as const;

const NOT_FOUND_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:14px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#555}@media(prefers-color-scheme:dark){body{background:#111;color:#aaa}}</style></head><body><p>${PREVIEW_NOT_FOUND_TEXT}</p></body></html>`;

/** 05 Preview 404 page: the same for every failure, so it never says whether the workspace exists. */
export const previewNotFound = (): Response =>
  new Response(NOT_FOUND_PAGE, {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...PRIVACY_HEADERS },
  });

/**
 * Splits the Cookie header into the preview cookie's value and the app's other cookies. With
 * several preview cookies the last one wins; none of them reach the app.
 */
export const takePreviewCookie = (header: string | null): { value: string | null; rest: string } => {
  let value: string | null = null;
  const rest: string[] = [];
  for (const part of (header ?? "").split(";")) {
    const pair = part.trim();
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    if (eq >= 0 && pair.slice(0, eq).trim() === PREVIEW_COOKIE) value = pair.slice(eq + 1).trim();
    else rest.push(pair);
  }
  return { value, rest: rest.join("; ") };
};

const enterResponse = (cookie: string): Response =>
  new Response(null, {
    status: 303,
    headers: {
      Location: "/",
      "Set-Cookie": `${PREVIEW_COOKIE}=${cookie}; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=86400`,
      "Cache-Control": "no-store",
      ...PRIVACY_HEADERS,
    },
  });

/**
 * Preview request path (01): match the first label, then `GET /__tempo/enter` goes to
 * previewEnter and every other request to the WorkspaceDO with the preview cookie taken out
 * (05, Preview access). Never logs codes, cookie values or request URLs.
 */
export const handlePreview = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const parsed = parsePreviewHost(url.hostname, env);
  if (!parsed || parsed.port < 1024 || parsed.port > 65535) return previewNotFound();
  const stub = env.WORKSPACE.getByName(parsed.workspaceId);
  let res: Response;
  try {
    if (url.pathname.startsWith("/__tempo/")) {
      if (url.pathname !== ENTER_PATH || request.method !== "GET") return previewNotFound();
      const code = url.searchParams.get("code") ?? "";
      if (!CODE.test(code)) return previewNotFound();
      const cookie = await stub.previewEnter(parsed.port, code);
      return cookie ? enterResponse(cookie) : previewNotFound();
    }
    const { value, rest } = takePreviewCookie(request.headers.get("Cookie"));
    if (!value) return previewNotFound();
    const headers = new Headers(request.headers);
    if (rest === "") headers.delete("Cookie");
    else headers.set("Cookie", rest);
    // previewFetch runs inside the DO's fetch(), because RPC cannot carry a WebSocket upgrade.
    headers.set(PREVIEW_HEADER, `${parsed.port}:${value}`);
    res = await stub.fetch(new Request(request, { headers }));
  } catch (e) {
    log("error", "preview request failed", {
      workspaceId: parsed.workspaceId,
      port: parsed.port,
      error: e instanceof Error ? e.name : "unknown",
    });
    return new Response("Something went wrong.", { status: 502, headers: PRIVACY_HEADERS });
  }
  if (res.webSocket) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(PRIVACY_HEADERS)) out.headers.set(k, v);
  return out;
};
