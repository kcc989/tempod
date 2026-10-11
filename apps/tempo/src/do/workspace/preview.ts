import { TEMPOD_PORT } from "@tempo/protocol";
import { PREVIEW_HEADER } from "../../http/preview.ts";
import { timingSafeEqual } from "../../lib/crypto.ts";
import { containerRunning } from "./container.ts";
import type { WorkspaceCore } from "./core.ts";
import { tempodFetch } from "./tempod-client.ts";

const WAKING_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Waking workspace</title><style>body{font:14px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#555}@media(prefers-color-scheme:dark){body{background:#111;color:#aaa}}</style></head><body><p>Waking workspace…</p></body></html>`;

const notFound = () => new Response("Not found", { status: 404 });

const isHtmlGet = (request: Request) =>
  request.method === "GET" && (request.headers.get("Accept") ?? "").includes("text/html");

/**
 * Preview request path (01, steps 3–7): constant-time token check (404 on mismatch), wake if
 * needed, then forward through tempod's /v1/proxy. WebSocket upgrades are bridged frame by frame.
 */
export const previewFetch = async (
  core: WorkspaceCore,
  request: Request,
  port: number,
  token: string,
  ensureAwake: () => void,
): Promise<Response> => {
  const row = core.wsOrNull();
  if (!row || !timingSafeEqual(token, row.previewToken)) return notFound();
  if (port === TEMPOD_PORT || port < 1024 || port > 65535) return notFound();
  if (row.state === "archived" || row.state === "archiving") return notFound();
  core.lastPreviewAt = Date.now();
  core.touchActivity();
  if (
    !containerRunning(core) ||
    !core.tempod?.open ||
    !["ready", "working", "setting_up"].includes(row.state)
  ) {
    ensureAwake();
    if (isHtmlGet(request)) {
      return new Response(WAKING_PAGE, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    return new Response("Workspace is waking", { status: 503, headers: { "Retry-After": "5" } });
  }
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete(PREVIEW_HEADER);
  headers.delete("Authorization");
  headers.set("X-Forwarded-Host", url.host);
  headers.set("X-Forwarded-Proto", "https");
  const path = `/v1/proxy/${port}${url.pathname}${url.search}`;
  const upgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
  if (!upgrade) {
    return tempodFetch(core, path, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
      redirect: "manual",
    });
  }
  const upstream = await tempodFetch(core, path, { headers });
  const remote = upstream.webSocket;
  if (!remote) return new Response("Bad gateway", { status: 502 });
  remote.accept();
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  const relay = (from: WebSocket, to: WebSocket) => {
    from.addEventListener("message", (e) => {
      try {
        to.send(e.data);
      } catch {
        // peer closed
      }
      core.lastPreviewAt = Date.now();
    });
    from.addEventListener("close", (e) => {
      try {
        to.close(e.code === 1005 ? 1000 : e.code, e.reason);
      } catch {
        // already closed
      }
    });
  };
  relay(server, remote);
  relay(remote, server);
  return new Response(null, { status: 101, webSocket: client });
};
