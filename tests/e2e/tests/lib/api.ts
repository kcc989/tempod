import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import type { ApiMeta, ErrorBody, FnInput, FnName, FnOutput } from "@tempo/protocol";
import { test } from "@playwright/test";
import { E2E, appHost, required } from "./env.ts";
import { sleep } from "./util.ts";

/**
 * Client for the native JSON API (07, Server changes for native clients): `POST /api/v1/rpc/<fn>`
 * with a bearer token, the three WebSocket channels, attachments and preview URLs.
 */

export const appUrl = (path: string): string => new URL(path, `${E2E.url}/`).toString();

export interface CallOptions {
  /** Bearer token. Defaults to TEMPO_E2E_TOKEN; null sends no Authorization header. */
  readonly token?: string | null;
  readonly headers?: Readonly<Record<string, string>>;
}

const authHeaders = (token: string | null | undefined): Record<string, string> => {
  const value = token === undefined ? E2E.token || required("TEMPO_E2E_TOKEN") : token;
  return value === null ? {} : { Authorization: `Bearer ${value}` };
};

export interface RawResponse {
  readonly status: number;
  readonly text: string;
  readonly json: unknown;
  readonly headers: Headers;
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export const fetchApp = async (
  path: string,
  opts: CallOptions & { readonly method?: string; readonly json?: unknown; readonly body?: FormData } = {},
): Promise<RawResponse> => {
  const headers: Record<string, string> = { ...authHeaders(opts.token), ...opts.headers };
  let body: string | FormData | undefined = opts.body;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  const res = await fetch(appUrl(path), {
    method: opts.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body,
    redirect: "manual",
  });
  const text = await res.text();
  return { status: res.status, text, json: parseJson(text), headers: res.headers };
};

const asErrorBody = (u: unknown): ErrorBody | undefined =>
  typeof u === "object" &&
  u !== null &&
  typeof (u as { code?: unknown }).code === "string" &&
  typeof (u as { message?: unknown }).message === "string"
    ? (u as ErrorBody)
    : undefined;

export class RpcError extends Error {
  constructor(
    readonly fn: string,
    readonly status: number,
    readonly body: ErrorBody | undefined,
    text: string,
  ) {
    super(
      `${fn}: HTTP ${status} ${
        body ? `${body.code} ${body.message}${body.detail ? ` (${body.detail})` : ""}` : text.slice(0, 500)
      }`,
    );
    this.name = "RpcError";
  }

  get code(): string | undefined {
    return this.body?.code;
  }
}

export const rpcRaw = (name: string, input: unknown, opts: CallOptions = {}): Promise<RawResponse> =>
  fetchApp(`/api/v1/rpc/${name}`, { ...opts, method: "POST", json: input });

/** Calls one server function; 200 is its output, anything else throws an RpcError. */
export const rpc = async <K extends FnName>(
  name: K,
  input: FnInput<K>,
  opts: CallOptions = {},
): Promise<FnOutput<K>> => {
  const r = await rpcRaw(name, input, opts);
  if (r.status !== 200) throw new RpcError(name, r.status, asErrorBody(r.json), r.text);
  return r.json as FnOutput<K>;
};

/** Calls `name` and returns the error it fails with; throws if it succeeds. */
export const rpcFails = async <K extends FnName>(
  name: K,
  input: FnInput<K>,
  opts?: CallOptions,
): Promise<RpcError> => {
  try {
    await rpc(name, input, opts);
  } catch (e) {
    if (e instanceof RpcError) return e;
    throw e;
  }
  throw new Error(`${name} succeeded, but the test expected an error`);
};

/** Retries while the call answers CONTAINER_NOT_READY or WORKSPACE_BUSY (03, wake triggers). */
export const rpcRetry = async <K extends FnName>(
  name: K,
  input: FnInput<K>,
  timeoutMs = 5 * 60_000,
  codes: ReadonlyArray<string> = ["CONTAINER_NOT_READY", "WORKSPACE_BUSY"],
): Promise<FnOutput<K>> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await rpc(name, input);
    } catch (e) {
      if (!(e instanceof RpcError) || !codes.includes(e.code ?? "") || Date.now() > deadline) throw e;
      await sleep(2_000);
    }
  }
};

export const getMeta = async (): Promise<{ status: number; meta: ApiMeta | undefined }> => {
  const r = await fetchApp("/api/v1/meta", { token: null });
  return { status: r.status, meta: r.json as ApiMeta | undefined };
};

/** `POST /api/workspaces/<id>/attachments`, multipart with one file (02). */
export const uploadAttachment = (
  workspaceId: string,
  name: string,
  content: string,
  mime = "text/plain",
  opts: CallOptions = {},
): Promise<RawResponse> => {
  const form = new FormData();
  form.append("file", new Blob([content], { type: mime }), name);
  return fetchApp(`/api/workspaces/${workspaceId}/attachments`, { ...opts, method: "POST", body: form });
};

/** `https://<port>-<workspaceId>-<previewToken>.<PREVIEW_DOMAIN>` (01, Preview URL). */
export const previewUrl = (port: number, workspaceId: string, previewToken: string): string =>
  `https://${port}-${workspaceId.toLowerCase()}-${previewToken}.${E2E.previewDomain ?? required("TEMPO_E2E_PREVIEW_DOMAIN")}`;

/** `Cookie` header value for the app host, from the Playwright storage state of a signed-in owner. */
export const storageStateCookie = (): string | undefined => {
  if (!E2E.storageState) return undefined;
  const state = JSON.parse(readFileSync(E2E.storageState, "utf8")) as {
    cookies?: Array<{ name: string; value: string; domain: string }>;
  };
  const host = appHost().replace(/:\d+$/, "");
  const cookies = (state.cookies ?? []).filter((c) => {
    const domain = c.domain.replace(/^\./, "");
    return host === domain || host.endsWith(`.${domain}`);
  });
  return cookies.length > 0 ? cookies.map((c) => `${c.name}=${c.value}`).join("; ") : undefined;
};

// --- WebSocket channels -----------------------------------------------------------------------

/** Node's global WebSocket (undici) takes a non-standard `{ headers }` init and sends no Origin. */
type HeaderWebSocket = new (url: string, init?: { headers?: Record<string, string> }) => WebSocket;
const NodeWebSocket = globalThis.WebSocket as unknown as HeaderWebSocket;

let headerProbe: Promise<boolean> | null = null;

/** Checks once, against a local server, that this runtime's WebSocket sends custom headers and no Origin. */
export const webSocketSendsHeaders = (): Promise<boolean> => {
  headerProbe ??= new Promise<boolean>((resolve) => {
    if (typeof globalThis.WebSocket !== "function") return resolve(false);
    const server = createServer();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), 5_000);
    server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
      socket.destroy();
      done(req.headers["x-tempo-probe"] === "1" && req.headers.origin === undefined);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      try {
        const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/`, { headers: { "X-Tempo-Probe": "1" } });
        ws.addEventListener("error", () => undefined);
      } catch {
        done(false);
      }
    });
  });
  return headerProbe;
};

/** Skips the running test when channels cannot carry a bearer token from this runtime. */
export const requireChannels = async (): Promise<void> => {
  test.skip(
    !(await webSocketSendsHeaders()),
    "This runtime's WebSocket cannot send an Authorization header; channel tests need Node 22 or later (README.md)",
  );
};

export interface OpenOptions extends CallOptions {
  readonly origin?: string;
  readonly timeoutMs?: number;
  /** Send `{"type":"ping"}` every 30 s, as the clients do (02). */
  readonly ping?: boolean;
}

const openSockets = new Set<Socket>();

export const closeAllSockets = (): void => {
  for (const s of openSockets) s.close();
};

/** One channel connection: JSON text frames in order, binary frames decoded into `output`. */
export class Socket {
  readonly messages: Array<{ readonly at: number; readonly data: unknown }> = [];
  output = "";
  closed: { readonly code: number; readonly reason: string } | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly jsonHandlers = new Set<(data: unknown) => void>();
  private readonly decoder = new TextDecoder();
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  private constructor(private readonly ws: WebSocket) {
    ws.binaryType = "arraybuffer";
    ws.addEventListener("message", (e: MessageEvent) => {
      if (typeof e.data === "string") {
        const data = parseJson(e.data) ?? e.data;
        this.messages.push({ at: Date.now(), data });
        for (const h of this.jsonHandlers) h(data);
      } else {
        this.output += this.decoder.decode(new Uint8Array(e.data as ArrayBuffer), { stream: true });
      }
      this.notify();
    });
    ws.addEventListener("close", (e: CloseEvent) => {
      this.closed = { code: e.code, reason: e.reason };
      this.stopPing();
      openSockets.delete(this);
      this.notify();
    });
  }

  static open(path: string, opts: OpenOptions = {}): Promise<Socket> {
    const headers: Record<string, string> = {
      ...authHeaders(opts.token),
      "X-Tempo-Client": "e2e/1",
      ...opts.headers,
    };
    if (opts.origin !== undefined) headers["Origin"] = opts.origin;
    const ws = new NodeWebSocket(appUrl(path).replace(/^http/, "ws"), { headers });
    const socket = new Socket(ws);
    openSockets.add(socket);
    return new Promise<Socket>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`WebSocket ${path} did not open within ${opts.timeoutMs ?? 30_000} ms`));
      }, opts.timeoutMs ?? 30_000);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          if (opts.ping) socket.pingTimer = setInterval(() => socket.sendJson({ type: "ping" }), 30_000);
          resolve(socket);
        },
        { once: true },
      );
      ws.addEventListener(
        "close",
        (e: CloseEvent) => {
          clearTimeout(timer);
          reject(new Error(`WebSocket ${path} closed before it opened (${e.code} ${e.reason})`));
        },
        { once: true },
      );
    });
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  /** Replays the JSON messages received so far, then calls `handler` for each new one. */
  onJson(handler: (data: unknown) => void): void {
    for (const m of this.messages) handler(m.data);
    this.jsonHandlers.add(handler);
  }

  sendJson(value: unknown): void {
    if (this.isOpen) this.ws.send(JSON.stringify(value));
  }

  /** Binary frame, as the terminal channel expects for keystrokes (01, Terminal). */
  sendBytes(text: string): void {
    if (this.isOpen) this.ws.send(new TextEncoder().encode(text));
  }

  /** Resolves with the first truthy value of `check`, re-run after every frame. */
  until<T>(label: string, check: () => T | undefined | null | false, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.listeners.delete(onChange);
      };
      const onChange = () => {
        let value: T | undefined | null | false;
        try {
          value = check();
        } catch (e) {
          finish();
          reject(e instanceof Error ? e : new Error(String(e)));
          return;
        }
        if (value !== undefined && value !== null && value !== false) {
          finish();
          resolve(value);
        } else if (this.closed) {
          finish();
          reject(new Error(`${label}: the socket closed (${this.closed.code} ${this.closed.reason})`));
        }
      };
      const timer = setTimeout(() => {
        finish();
        reject(new Error(`Timed out after ${timeoutMs} ms waiting for ${label}`));
      }, timeoutMs);
      this.listeners.add(onChange);
      onChange();
    });
  }

  close(code = 1000): void {
    this.stopPing();
    openSockets.delete(this);
    try {
      this.ws.close(code);
    } catch {
      // already closed
    }
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }
}

/**
 * Status of a raw upgrade request: 101 when the server accepts it, else the HTTP status. Used to
 * see the 401 and 403 answers that a WebSocket object hides.
 */
export const upgradeStatus = (path: string, headers: Readonly<Record<string, string>>): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    const url = new URL(appUrl(path));
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(url, {
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        ...headers,
      },
    });
    req.on("upgrade", (res: IncomingMessage, socket: Duplex) => {
      socket.destroy();
      resolve(res.statusCode ?? 101);
    });
    req.on("response", (res: IncomingMessage) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.setTimeout(30_000, () => req.destroy(new Error(`upgrade ${path} timed out`)));
    req.end();
  });

export const bearer = (token: string = E2E.token || required("TEMPO_E2E_TOKEN")): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
});
