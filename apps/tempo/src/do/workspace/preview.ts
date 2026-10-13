import { and, eq, gt, lte } from "drizzle-orm";
import { TEMPOD_PORT, TempoError, randomToken } from "@tempo/protocol";
import { artifactCodes, ports, previewCodes } from "../../db/workspace-do.ts";
import { previewNotFound, stripInternalHeaders } from "../../http/preview.ts";
import {
  base64UrlToBytes,
  hmacSha256Base64Url,
  randomBase64Url,
  sha256Hex,
  timingSafeEqual,
} from "../../lib/crypto.ts";
import { containerRunning } from "./container.ts";
import type { WorkspaceCore } from "./core.ts";
import { tempodFetch } from "./tempod-client.ts";

const WAKING_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Waking workspace</title><style>body{font:14px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#555}@media(prefers-color-scheme:dark){body{background:#111;color:#aaa}}</style></head><body><p>Waking workspace…</p></body></html>`;

export const PREVIEW_CODE = /^[a-z0-9]{32}$/;

export const PREVIEW_CODE_MS = 60_000;

export const PREVIEW_COOKIE_SECONDS = 86_400;

const COOKIE_VALUE = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

/** 03 init 1: 32 random bytes from crypto.getRandomValues, base64url. */
export const newPreviewKey = (): string => randomBase64Url(32);

export const validPort = (port: number): boolean =>
  Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== TEMPOD_PORT;

const closed = (state: string) => state === "archived" || state === "archiving";

const previewMac = async (key: string, port: number, expiresAt: number): Promise<string | null> => {
  let raw: Uint8Array<ArrayBuffer>;

  try {
    raw = base64UrlToBytes(key);
  } catch {
    return null;
  }

  if (raw.length === 0) return null;

  return hmacSha256Base64Url(raw, `${port}.${expiresAt}`);
};

/** 05 Cookie value: `<expiresAt>.<mac>`, expiresAt in epoch seconds 24 hours ahead. */
export const previewCookie = async (key: string, port: number, now = Date.now()): Promise<string | null> => {
  const expiresAt = Math.floor(now / 1000) + PREVIEW_COOKIE_SECONDS;
  const mac = await previewMac(key, port, expiresAt);

  return mac === null ? null : `${expiresAt}.${mac}`;
};

export const verifyPreviewCookie = async (
  key: string,
  port: number,
  value: string,
  now = Date.now(),
): Promise<boolean> => {
  const m = COOKIE_VALUE.exec(value);

  if (!m) return false;
  const expiresAt = Number(m[1]);

  if (expiresAt * 1000 <= now) return false;
  const expected = await previewMac(key, port, expiresAt);

  return expected !== null && timingSafeEqual(m[2]!, expected);
};

/** 02 openPreview: a one-time entry link for a detected port (05, Entry link). */
export const openPreview = async (core: WorkspaceCore, port: number): Promise<{ url: string }> => {
  const row = core.ws();
  const detected = core.db.select().from(ports).where(eq(ports.port, port)).get();

  if (!detected || !validPort(port) || closed(row.state))
    throw new TempoError("NOT_FOUND", undefined, "port not detected");
  const code = randomToken(32);
  const codeHash = await sha256Hex(code);
  const now = Date.now();
  core.db.delete(previewCodes).where(lte(previewCodes.expiresAt, now)).run();
  core.db
    .insert(previewCodes)
    .values({ codeHash, port, expiresAt: now + PREVIEW_CODE_MS })
    .run();

  return { url: `${core.previewUrl(port)}/__tempo/enter?code=${code}` };
};

/** 05 Enter: a good code is deleted and becomes a cookie value; anything else is null. */
export const previewEnter = async (
  core: WorkspaceCore,
  port: number,
  code: string,
): Promise<string | null> => {
  if (!core.wsOrNull() || !validPort(port) || !PREVIEW_CODE.test(code)) return null;
  const codeHash = await sha256Hex(code);
  const now = Date.now();

  const used = core.db
    .delete(previewCodes)
    .where(
      and(eq(previewCodes.codeHash, codeHash), eq(previewCodes.port, port), gt(previewCodes.expiresAt, now)),
    )
    .returning()
    .get();

  const row = core.wsOrNull();

  if (!used || !row || closed(row.state)) return null;

  return previewCookie(row.previewKey, port, now);
};

/** 02 rotatePreviewKey: every preview cookie stops working, open preview sockets close. */
export const rotatePreviewKey = (core: WorkspaceCore): void => {
  core.updateWs({ previewKey: newPreviewKey() });
  core.db.delete(previewCodes).run();
  core.db.delete(artifactCodes).run();
  core.closePreviews(1008, "preview access reset");
};

const isHtmlGet = (request: Request) =>
  request.method === "GET" && (request.headers.get("Accept") ?? "").includes("text/html");

/**
 * Preview request path (01, steps 3–7): check the preview cookie (the preview 404 page when it
 * fails), wake if needed, then forward through tempod's /v1/proxy. WebSocket upgrades are bridged
 * frame by frame.
 */
export const previewFetch = async (
  core: WorkspaceCore,
  request: Request,
  port: number,
  cookie: string,
  ensureAwake: () => void,
): Promise<Response> => {
  const key = core.wsOrNull()?.previewKey;

  if (key === undefined || !validPort(port)) return previewNotFound();

  if (!(await verifyPreviewCookie(key, port, cookie))) return previewNotFound();
  const row = core.wsOrNull();

  if (!row || row.previewKey !== key || closed(row.state)) return previewNotFound();

  return proxyToPort(core, request, port, ensureAwake, true);
};

/**
 * Preview request path steps 4–7, shared with Browser Run's `localhost` requests (01): wake if
 * needed, then forward through tempod's /v1/proxy. WebSocket upgrades are bridged frame by frame;
 * `resettable` relays close when the preview key is reset.
 */
export const proxyToPort = async (
  core: WorkspaceCore,
  request: Request,
  port: number,
  ensureAwake: () => void,
  resettable: boolean,
): Promise<Response> => {
  const row = core.ws();
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
  stripInternalHeaders(headers);
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

  // rotatePreviewKey closes every open preview relay (05 Preview access).
  if (resettable) {
    core.previewSockets.add(server);
    core.previewSockets.add(remote);
  }

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
      core.previewSockets.delete(from);
      core.previewSockets.delete(to);

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
