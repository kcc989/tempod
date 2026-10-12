import type { Env } from "../env.ts";
import { errorText, log } from "../log.ts";

export const PREVIEW_HEADER = "x-tempo-preview";

const LABEL = /^(\d{4,5})-([0-9a-hjkmnp-tv-z]{26})-([a-z0-9]{16})$/;

export const isPreviewHost = (host: string, env: Env): boolean =>
  host.toLowerCase().endsWith(`.${env.PREVIEW_DOMAIN.toLowerCase()}`);

export const parsePreviewHost = (
  host: string,
  env: Env,
): { port: number; workspaceId: string; token: string } | null => {
  const suffix = `.${env.PREVIEW_DOMAIN.toLowerCase()}`;
  const label = host.toLowerCase().slice(0, -suffix.length);
  const m = LABEL.exec(label);
  if (!m) return null;
  return { port: Number(m[1]), workspaceId: m[2]!, token: m[3]! };
};

const PRIVACY_HEADERS = { "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" } as const;

const notFound = () => new Response("Not found", { status: 404, headers: PRIVACY_HEADERS });

/**
 * Preview request path (01): match the first label, hand the request to the WorkspaceDO, add
 * the privacy headers (05). Never log the full hostname.
 */
export const handlePreview = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const parsed = parsePreviewHost(url.hostname, env);
  if (!parsed || parsed.port < 1024 || parsed.port > 65535) return notFound();
  // previewFetch runs inside the DO's fetch(), because RPC cannot carry a WebSocket upgrade.
  const headers = new Headers(request.headers);
  headers.set(PREVIEW_HEADER, `${parsed.port}:${parsed.token}`);
  let res: Response;
  try {
    res = await env.WORKSPACE.getByName(parsed.workspaceId).fetch(new Request(request, { headers }));
  } catch (e) {
    log("error", "preview request failed", {
      workspaceId: parsed.workspaceId,
      port: parsed.port,
      error: errorText(e),
    });
    return new Response("Something went wrong.", { status: 502, headers: PRIVACY_HEADERS });
  }
  if (res.webSocket) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(PRIVACY_HEADERS)) out.headers.set(k, v);
  return out;
};
