import type { ServerWebSocket } from "bun";
import type { Logger } from "./log.ts";

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

export const PROXY_PREFIX = "/v1/proxy/";

export interface ProxyTarget {
  readonly port: number;
  /** Path and query to forward, starting with `/`. */
  readonly pathAndQuery: string;
}

/** Parses `/v1/proxy/<port>/<path>`; `null` when the path is not a proxy path. */
export const parseProxyPath = (pathname: string, search: string): ProxyTarget | "bad" | null => {
  if (!pathname.startsWith(PROXY_PREFIX)) return null;
  const rest = pathname.slice(PROXY_PREFIX.length);
  const slash = rest.indexOf("/");
  const portText = slash < 0 ? rest : rest.slice(0, slash);
  if (!/^\d{1,5}$/.test(portText)) return "bad";
  const port = Number(portText);
  if (port > 65535) return "bad";
  const path = slash < 0 ? "/" : rest.slice(slash);
  return { port, pathAndQuery: path + search };
};

/** 7070, tempod's own port and ports below 1024 are never proxied (01, tempod). */
export const proxyAllowed = (port: number, ownPorts: ReadonlyArray<number>): boolean =>
  port >= 1024 && port !== 7070 && !ownPorts.includes(port);

const upstreamHeaders = (req: Request, port: number): Headers => {
  const headers = new Headers(req.headers);
  for (const h of HOP_BY_HOP) headers.delete(h);
  headers.delete("authorization");
  headers.delete("host");
  headers.set("host", `localhost:${port}`);
  return headers;
};

export const proxyHttp = async (req: Request, target: ProxyTarget, log: Logger): Promise<Response> => {
  const url = `http://127.0.0.1:${target.port}${target.pathAndQuery}`;
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== null;
  const init: BunFetchRequestInit & { duplex: "half" } = {
    method: req.method,
    headers: upstreamHeaders(req, target.port),
    body: hasBody ? req.body : null,
    redirect: "manual",
    decompress: false,
    duplex: "half",
  };
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    log.info("proxy upstream unreachable", { port: target.port, error: e instanceof Error ? e.message : String(e) });
    return new Response(`tempo: nothing answered on port ${target.port}\n`, { status: 502 });
  }
  const headers = new Headers(res.headers);
  for (const h of HOP_BY_HOP) headers.delete(h);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
};

export interface ProxySocketData {
  readonly kind: "proxy";
  readonly upstream: WebSocket;
  client: ServerWebSocket<unknown> | null;
  readonly queue: Array<string | Uint8Array>;
  upstreamClosed: { code: number; reason: string } | null;
}

const safeCode = (code: number): number => (code === 1000 || (code >= 3000 && code <= 4999) ? code : code === 1001 ? 1001 : 1011);

/**
 * Opens the upstream WebSocket first, so the client handshake can echo the subprotocol the dev server
 * chose (Vite's HMR needs this), then upgrades the client and copies frames both ways.
 */
export const proxyWebSocket = async (
  req: Request,
  target: ProxyTarget,
  log: Logger,
  upgrade: (data: ProxySocketData, headers: Record<string, string>) => boolean,
): Promise<Response | undefined> => {
  const url = `ws://127.0.0.1:${target.port}${target.pathAndQuery}`;
  const protocols = (req.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const headers: Record<string, string> = { host: `localhost:${target.port}` };
  for (const name of ["origin", "cookie", "user-agent", "x-forwarded-host", "x-forwarded-proto"]) {
    const v = req.headers.get(name);
    if (v !== null) headers[name] = v;
  }
  const upstream = new WebSocket(url, { headers, protocols } as unknown as string[]);
  upstream.binaryType = "arraybuffer";
  const opened = await new Promise<boolean>((resolve) => {
    upstream.addEventListener("open", () => resolve(true), { once: true });
    upstream.addEventListener("error", () => resolve(false), { once: true });
    upstream.addEventListener("close", () => resolve(false), { once: true });
  });
  if (!opened) {
    log.info("proxy websocket upstream unreachable", { port: target.port });
    return new Response(`tempo: no WebSocket on port ${target.port}\n`, { status: 502 });
  }
  const data: ProxySocketData = { kind: "proxy", upstream, client: null, queue: [], upstreamClosed: null };
  upstream.addEventListener("message", (ev) => {
    const d = ev.data as string | ArrayBuffer;
    const frame = typeof d === "string" ? d : new Uint8Array(d);
    if (data.client) data.client.send(frame);
    else data.queue.push(frame);
  });
  upstream.addEventListener("close", (ev) => {
    data.upstreamClosed = { code: ev.code, reason: ev.reason };
    closeClient(data);
  });
  const responseHeaders: Record<string, string> = upstream.protocol ? { "Sec-WebSocket-Protocol": upstream.protocol } : {};
  if (!upgrade(data, responseHeaders)) {
    upstream.close();
    return new Response("upgrade failed\n", { status: 400 });
  }
  return undefined;
};

const closeClient = (data: ProxySocketData): void => {
  if (!data.client || !data.upstreamClosed) return;
  try {
    data.client.close(safeCode(data.upstreamClosed.code), data.upstreamClosed.reason);
  } catch {
    // already closed
  }
};

/** Wires an accepted client socket to its upstream, sending what the upstream said before. */
export const bridgeOpen = (ws: ServerWebSocket<unknown>, data: ProxySocketData): void => {
  data.client = ws;
  for (const frame of data.queue.splice(0)) ws.send(frame);
  closeClient(data);
};

export const bridgeMessage = (data: ProxySocketData, message: string | Buffer): void => {
  if (data.upstream.readyState === WebSocket.OPEN) {
    data.upstream.send(typeof message === "string" ? message : new Uint8Array(message));
  }
};

export const bridgeClose = (data: ProxySocketData, code: number, reason: string): void => {
  try {
    const c = code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
    data.upstream.close(c, reason);
  } catch {
    // already closed
  }
};
