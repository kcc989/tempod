import { createHash, timingSafeEqual } from "node:crypto";
import { MAX_MESSAGE_BYTES, type HealthResponse } from "@tempo/protocol";
import type { Server } from "bun";
import { VERSION } from "./config.ts";
import { ProtocolConnection } from "./protocol.ts";
import {
  bridgeClose,
  bridgeMessage,
  bridgeOpen,
  parseProxyPath,
  proxyAllowed,
  proxyHttp,
  proxyWebSocket,
  type ProxySocketData,
} from "./proxy.ts";
import type { Tempod } from "./tempod.ts";

type ConnectData = { kind: "connect"; conn: ProtocolConnection | null };

type WsData = ConnectData | ProxySocketData;

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

/** Constant-time check of `Authorization: Bearer <token>`. */
export const authorized = (req: Request, token: string): boolean => {
  const header = req.headers.get("authorization") ?? "";

  return timingSafeEqual(digest(header), digest(`Bearer ${token}`));
};

const json = <T>(body: T, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export interface TempodServer {
  readonly server: Server<WsData>;
  readonly port: number;
  /** The `/v1/connect` connection currently in use. */
  current(): ProtocolConnection | null;
  stop(): Promise<void>;
}

export const startServer = (app: Tempod, opts: { hostname?: string; port: number }): TempodServer => {
  let current: ProtocolConnection | null = null;
  const log = app.log;

  const server: Server<WsData> = Bun.serve<WsData>({
    hostname: opts.hostname ?? "0.0.0.0",
    port: opts.port,
    idleTimeout: 120,
    async fetch(req, srv) {
      if (!authorized(req, app.config.token)) return new Response("unauthorized\n", { status: 401 });
      const url = new URL(req.url);

      if (url.pathname === "/v1/health") {
        if (req.method !== "GET") return new Response(null, { status: 405 });
        const body: HealthResponse = { ok: true, version: VERSION, incarnation: app.outbox.incarnation };

        return json(body);
      }

      if (url.pathname === "/v1/connect") {
        if (req.method !== "GET") return new Response(null, { status: 405 });

        if (srv.upgrade(req, { data: { kind: "connect", conn: null } })) return undefined;

        return new Response("expected a WebSocket upgrade\n", { status: 400 });
      }

      const target = parseProxyPath(url.pathname, url.search);

      if (target === "bad") return new Response("bad proxy path\n", { status: 400 });

      if (target) {
        if (!proxyAllowed(target.port, [app.listenPort]))
          return new Response("forbidden port\n", { status: 403 });
        srv.timeout(req, 0);

        if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
          return proxyWebSocket(req, target, log, (data, headers) => srv.upgrade(req, { data, headers }));
        }

        return proxyHttp(req, target, log);
      }

      return new Response("not found\n", { status: 404 });
    },
    websocket: {
      maxPayloadLength: MAX_MESSAGE_BYTES + 64 * 1024,
      idleTimeout: 0,
      sendPings: true,
      open(ws) {
        const data = ws.data;

        if (data.kind === "proxy") {
          bridgeOpen(ws, data);

          return;
        }

        if (current) {
          log.info("connection replaced");
          current.close(4001, "replaced");
        }

        current = new ProtocolConnection(app, ws, log);
        data.conn = current;
      },
      message(ws, message) {
        const data = ws.data;

        if (data.kind === "proxy") bridgeMessage(data, message);
        else data.conn?.onMessage(message);
      },
      close(ws, code, reason) {
        const data = ws.data;

        if (data.kind === "proxy") {
          bridgeClose(data, code, reason);

          return;
        }

        data.conn?.onClose();

        if (current === data.conn) current = null;
      },
      drain(ws) {
        if (ws.data.kind === "connect" && ws.data.conn === current) app.outbox.pump();
      },
    },
  });

  const port = server.port ?? opts.port;
  app.listenPort = port;

  return {
    server,
    port,
    current: () => current,
    stop: async () => {
      current?.close(1001, "stopping");
      await server.stop(true);
    },
  };
};
