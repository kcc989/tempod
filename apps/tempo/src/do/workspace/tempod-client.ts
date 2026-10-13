import { toTurnUsage, type AgentId } from "@tempo/protocol";
import {
  ERROR_CODES,
  TEMPOD_REQUESTS,
  TEMPOD_PORT,
  TempodEvent,
  TempoError,
  newId,
  type DoHello,
  type ErrorCode,
  type TempodEventEnvelope,
  type TempodOp,
  type TempodParams,
  type TempodResult,
} from "@tempo/protocol";
import { and, eq } from "drizzle-orm";
import { Schema } from "effect";
import { events, turns, lifecycleEvents } from "../../db/workspace-do.ts";
import { log } from "../../log.ts";
import type { WorkspaceCore } from "./core.ts";

const ACK_EVERY_MS = 250;
const ACK_EVERY_EVENTS = 100;
const decodeEvent = Schema.decodeUnknownExit(TempodEvent);

export type EventHandler = (event: TempodEvent, envelope: TempodEventEnvelope) => Promise<void> | void;

interface Pending {
  readonly op: TempodOp;
  readonly resolve: (v: unknown) => void;
  readonly reject: (e: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly cleanup: () => void;
}

/** Kinds whose payload is a secret: never stored in `events` (02, Rules). */
const SECRET_EVENT_KINDS = new Set(["credential.changed"]);

/**
 * The DO's side of the tempod WebSocket (02, tempod protocol). Requests time out per op; events
 * are applied strictly in seq order, deduplicated by (incarnation, seq), and acked in batches.
 */
export class TempodClient {
  private readonly pending = new Map<string, Pending>();
  private chain: Promise<void> = Promise.resolve();
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private unacked = 0;
  private catalogAck = 0;
  closed = false;

  constructor(
    private readonly core: WorkspaceCore,
    private readonly socket: WebSocket,
    private readonly onEvent: EventHandler,
    private readonly onClose: (client: TempodClient, code: number) => void,
    private readonly catalogUserId?: string,
  ) {
    socket.addEventListener("message", (e) => this.onMessage(e.data));
    socket.addEventListener("close", (e) => this.handleClose(e.code));
    socket.addEventListener("error", () => this.handleClose(1006));
  }

  get open(): boolean {
    return !this.closed;
  }

  request<O extends TempodOp>(
    op: O,
    params: TempodParams<O>,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<TempodResult<O>> {
    if (this.closed) return Promise.reject(new TempoError("TEMPOD_UNREACHABLE"));
    if (opts.signal?.aborted)
      return Promise.reject(new TempoError("TEMPOD_TIMEOUT", undefined, `${op} aborted`));
    const id = newId();
    const timeoutMs = opts.timeoutMs ?? TEMPOD_REQUESTS[op].timeoutMs;
    return new Promise<TempodResult<O>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.get(id)?.cleanup();
        this.pending.delete(id);
        reject(new TempoError("TEMPOD_TIMEOUT", undefined, `${op} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      const abort = () => {
        const p = this.pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        p.cleanup();
        this.pending.delete(id);
        reject(new TempoError("TEMPOD_TIMEOUT", undefined, `${op} aborted`));
      };
      const cleanup = () => opts.signal?.removeEventListener("abort", abort);
      this.pending.set(id, { op, resolve: resolve as (v: unknown) => void, reject, timer, cleanup });
      opts.signal?.addEventListener("abort", abort, { once: true });
      try {
        this.socket.send(JSON.stringify({ type: "req", id, op, params }));
      } catch (e) {
        clearTimeout(timer);
        cleanup();
        this.pending.delete(id);
        reject(new TempoError("TEMPOD_UNREACHABLE", undefined, String(e)));
      }
    });
  }

  sendHello(hello: DoHello): void {
    this.socket.send(JSON.stringify(hello));
  }

  close(code = 1000, reason = "closing"): void {
    if (this.closed) return;
    this.flushAck();
    try {
      this.socket.close(code, reason);
    } catch {
      // already closed
    }
    this.handleClose(code);
  }

  /** Resolves when every event received so far has been applied. */
  drained(): Promise<void> {
    return this.chain;
  }

  private onMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let msg: {
      type?: string;
      id?: string;
      ok?: boolean;
      result?: unknown;
      error?: { code?: string; message?: string };
    };
    try {
      msg = JSON.parse(data);
    } catch {
      log("warn", "tempod sent invalid json", { workspaceId: this.core.wsOrNull()?.workspaceId });
      return;
    }
    if (msg.type === "res" && typeof msg.id === "string") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      p.cleanup();
      this.pending.delete(msg.id);
      if (msg.ok) {
        const decoded = Schema.decodeUnknownExit(
          TEMPOD_REQUESTS[p.op].result as unknown as Schema.Decoder<unknown>,
        )(msg.result);
        if (decoded._tag === "Success") p.resolve(decoded.value);
        else p.reject(new TempoError("INTERNAL", undefined, `tempod sent an invalid ${p.op} result`));
      } else {
        const code = ERROR_CODES.includes(msg.error?.code as ErrorCode)
          ? (msg.error!.code as ErrorCode)
          : "INTERNAL";
        p.reject(new TempoError(code, undefined, msg.error?.message?.slice(0, 2000)));
      }
      return;
    }
    if (msg.type === "event") {
      const envelope = msg as unknown as TempodEventEnvelope;
      this.chain = this.chain
        .then(() => this.applyEvent(envelope))
        .catch((e) => {
          log("error", "tempod event failed", {
            workspaceId: this.core.wsOrNull()?.workspaceId,
            error: String(e),
          });
          this.close(1011, "event application failed");
        });
    }
  }

  private async applyEvent(envelope: TempodEventEnvelope): Promise<void> {
    if (this.closed) return;
    if (this.catalogUserId) {
      const decoded = decodeEvent(envelope.event);
      if (decoded._tag === "Success" && decoded.value.kind === "credential.changed") {
        await this.core
          .credentials()
          .offerCodexAuth(decoded.value.content, decoded.value.lastRefresh, this.core.workspaceId);
      }
      this.catalogAck = envelope.seq;
      this.queueAck(true);
      return;
    }
    const row = this.core.ws();
    const kind = (envelope.event as { kind?: unknown })?.kind;
    const isIncarnation = kind === "incarnation.changed";
    if (!isIncarnation && envelope.seq <= row.tempodAckedSeq) return;
    const incarnation = row.tempodIncarnation ?? "";
    const decoded = decodeEvent(envelope.event);
    if (decoded._tag === "Failure") {
      log("warn", "unknown or invalid tempod event", { workspaceId: row.workspaceId, kind: String(kind) });
      this.markApplied(envelope.seq);
      return;
    }
    const event = decoded.value;
    if (SECRET_EVENT_KINDS.has(event.kind)) {
      await this.onEvent(event, envelope);
    }
    this.core.ctx.storage.transactionSync(() => {
      if (!isIncarnation) {
        const payload = SECRET_EVENT_KINDS.has(event.kind) ? "{}" : JSON.stringify(event);
        const inserted = this.core.db
          .insert(events)
          .values({
            incarnation,
            seq: envelope.seq,
            kind: event.kind,
            payloadJson: payload,
            receivedAt: Date.now(),
          })
          .onConflictDoNothing()
          .returning({ id: events.id })
          .all();
        if (inserted.length === 0) return;
      }
      if (event.kind === "incarnation.changed") {
        this.core.db.delete(events).where(eq(events.incarnation, event.incarnation)).run();
      }
      if (!SECRET_EVENT_KINDS.has(event.kind)) {
        const result = this.onEvent(event, envelope);
        if (result !== undefined) throw new Error("Local tempod events must apply synchronously");
      }
      if (event.kind === "turn.ended") {
        const turn = this.core.db.select().from(turns).where(eq(turns.id, event.turnId)).get();
        if (turn && !["queued", "running"].includes(turn.status)) {
          const session = this.core.sessionRow(turn.sessionId);
          const roleRunId = turn.origin !== "user" ? session.roleRunId : null;
          const cause = roleRunId
            ? this.core.db
                .select()
                .from(lifecycleEvents)
                .where(
                  and(eq(lifecycleEvents.roleRunId, roleRunId), eq(lifecycleEvents.type, "role.run.started")),
                )
                .get()
            : turn.changeId
              ? this.core.lifecycle.origin(turn.changeId)
              : null;
          this.core.lifecycle.append({
            type: "agent.turn.ended",
            source: "agent",
            ...(turn.changeId ? { changeId: turn.changeId } : {}),
            turnId: turn.id,
            sessionId: turn.sessionId,
            agent: session.agent as AgentId,
            ...(roleRunId ? { roleRunId } : {}),
            ...(cause ? { causationId: cause.id } : {}),
            dedupeKey: `tempod:${incarnation}:${envelope.seq}`,
            payload: {
              status: turn.status as "completed" | "cancelled" | "failed" | "interrupted",
              stopReason: turn.stopReason,
              ...(turn.errorCode ? { errorCode: turn.errorCode } : {}),
              ...(toTurnUsage(event.usage) ? { usage: toTurnUsage(event.usage)! } : {}),
            },
          });
        }
      }
      if (event.kind === "incarnation.changed") {
        this.core.updateWs({ tempodIncarnation: event.incarnation, tempodAckedSeq: envelope.seq });
      } else if (envelope.seq > this.core.ws().tempodAckedSeq) {
        this.core.updateWs({ tempodAckedSeq: envelope.seq });
      }
    });
    this.core.lifecycle.kick();
    this.queueAck(isIncarnation);
  }

  private markApplied(seq: number): void {
    if (seq > this.core.ws().tempodAckedSeq) this.core.updateWs({ tempodAckedSeq: seq });
    this.queueAck(false);
  }

  private queueAck(now: boolean): void {
    this.unacked++;
    if (now || this.unacked >= ACK_EVERY_EVENTS) return this.flushAck();
    this.ackTimer ??= setTimeout(() => this.flushAck(), ACK_EVERY_MS);
  }

  private flushAck(): void {
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
    if (this.unacked === 0 || this.closed) return;
    this.unacked = 0;
    try {
      this.socket.send(
        JSON.stringify({
          type: "ack",
          upTo: this.catalogUserId ? this.catalogAck : this.core.ws().tempodAckedSeq,
        }),
      );
    } catch {
      // socket closing
    }
  }

  private handleClose(code: number): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ackTimer) clearTimeout(this.ackTimer);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.cleanup();
      p.reject(new TempoError("TEMPOD_UNREACHABLE", undefined, `${p.op}: connection closed`));
      this.pending.delete(id);
    }
    this.onClose(this, code);
  }
}

export const tempodFetch = (core: WorkspaceCore, path: string, init: RequestInit = {}): Promise<Response> => {
  const container = core.container;
  if (!container) throw new TempoError("CONTAINER_NOT_READY");
  const token = core.wsOrNull()?.tempodToken ?? core.kv<string>("catalogToken");
  if (!token) throw new TempoError("CONTAINER_NOT_READY");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return container.getTcpPort(TEMPOD_PORT).fetch(`http://tempod${path}`, { ...init, headers });
};

/** Opens /v1/connect and sends `hello`. The caller wires events and close handling. */
export const openTempodSocket = async (core: WorkspaceCore): Promise<WebSocket> => {
  const res = await tempodFetch(core, "/v1/connect", { headers: { Upgrade: "websocket" } });
  const ws = res.webSocket;
  if (res.status !== 101 || !ws)
    throw new TempoError("TEMPOD_UNREACHABLE", undefined, `connect returned ${res.status}`);
  ws.accept();
  return ws;
};
