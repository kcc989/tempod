import { proposeIntent } from "./intent.ts";
import { submitProof } from "./proof.ts";
import { deployTool } from "../../agents/deploys.ts";
import { issueTool } from "../../agents/issues.ts";
import { DeployToolName, IssueToolName, unwrap } from "@tempo/protocol";
import { agentTool } from "../../agents/proposals.ts";
import { toTurnUsage, type LifecycleEvent } from "@tempo/protocol";
import {
  ERROR_CODES,
  TempodToDo,
  type TempodRes,
  type ToolReq,
  TEMPOD_REQUESTS,
  TEMPOD_PORT,
  TempodEvent,
  TempoError,
  newId,
  type DoHello,
  type TempodEventEnvelope,
  type TempodOp,
  type TempodParams,
  type TempodResult,
} from "@tempo/protocol";
import { and, eq } from "drizzle-orm";
import { Schema, Exit, Option } from "effect";
import { events, turns, lifecycleEvents } from "../../db/workspace-do.ts";
import { log } from "../../log.ts";
import type { WorkspaceCore } from "./core.ts";

const ACK_EVERY_MS = 250;

const ACK_EVERY_EVENTS = 100;

const decodeEvent = Schema.decodeUnknownExit(TempodEvent);

export type EventHandler = (event: TempodEvent, envelope: TempodEventEnvelope) => Promise<void> | void;

/**
 * A container with no workspace row: model discovery (01) or a CI job (10). Events go only to
 * `onEvent`, in seq order, and are acked by seq; they are never stored as workspace events.
 */
export interface DetachedEvents {
  readonly onEvent: (event: TempodEvent, seq: number) => Promise<void> | void;
  /** The last seq already applied, so a replay after reconnect is skipped. */
  readonly appliedSeq?: () => number;
}

interface Pending {
  readonly op: TempodOp;
  readonly complete: (response: TempodRes) => void;
  readonly reject: (cause: unknown) => void;
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
  private detachedAck = 0;
  closed = false;
  constructor(
    private readonly core: WorkspaceCore,
    private readonly socket: Pick<WebSocket, "send" | "close" | "addEventListener">,
    private readonly onEvent: EventHandler,
    private readonly onClose: (client: TempodClient, code: number) => void,
    private readonly detached?: DetachedEvents,
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
      // SAFETY: the operation key selects its own result schema from TEMPOD_REQUESTS;
      // the decoder validates that result before resolving this operation's promise.
      const resultSchema = TEMPOD_REQUESTS[op].result as Schema.ConstraintDecoder<TempodResult<O>>;
      const decodeResult = Schema.decodeUnknownExit(resultSchema);

      const complete = (response: TempodRes) => {
        if (response.ok) {
          const decoded = decodeResult(response.result);

          if (Exit.isSuccess(decoded)) resolve(decoded.value);
          else reject(new TempoError("INTERNAL", undefined, `tempod sent an invalid ${op} result`));
        } else {
          const code = Schema.is(Schema.Literals(ERROR_CODES))(response.error.code)
            ? response.error.code
            : "INTERNAL";

          reject(new TempoError(code, undefined, response.error.message.slice(0, 2000)));
        }
      };

      this.pending.set(id, { op, complete, reject, timer, cleanup });
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
  private onMessage(data: MessageEvent["data"]): void {
    if (!Schema.is(Schema.String)(data)) return;
    const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(TempodToDo))(data);

    if (Option.isNone(parsed)) {
      log("warn", "tempod sent invalid json", { workspaceId: this.core.wsOrNull()?.workspaceId });

      return;
    }

    const msg = parsed.value;

    if (msg.type === "res" && Schema.is(Schema.String)(msg.id)) {
      const p = this.pending.get(msg.id);

      if (!p) return;
      clearTimeout(p.timer);
      p.cleanup();
      this.pending.delete(msg.id);

      p.complete(msg);

      return;
    }

    if (msg.type === "tool.req") {
      const work = this.agentTool(msg)
        .then((result) => ({ type: "tool.res", id: msg.id, ok: true, result }))
        .catch((error) => ({
          type: "tool.res",
          id: msg.id,
          ok: false,
          error: {
            code: error instanceof TempoError ? error.code : "INTERNAL",
            message: error instanceof TempoError ? (error.detail ?? error.message) : "Tool failed.",
          },
        }))
        .then((response) => {
          if (!this.closed) this.socket.send(JSON.stringify(response));
        });

      this.core.ctx.waitUntil(work);

      return;
    }

    if (msg.type === "event") {
      const envelope = msg;
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
  private async agentTool(request: ToolReq): Promise<Schema.Json> {
    if (this.detached) throw new TempoError("NOT_FOUND");
    const session = this.core.sessionRow(request.sessionId);

    if (request.op === "report_result") {
      if (!request.runId || session.runId !== request.runId) throw new TempoError("RUN_NOT_RUNNING");

      return this.core.lifecycle.runs.report(session.id, request.runId, request.params);
    }

    if (request.op === "get_project_profile")
      return unwrap(await this.core.env.APP_DEPLOY.getByName(this.core.ws().projectId).getProfile());

    if (request.op === "submit_proof") {
      if (session.runId) throw new TempoError("RUN_NOT_RUNNING");

      return submitProof(this.core, session, request.params);
    }

    if (request.op === "propose_intent") {
      if (session.runId) throw new TempoError("RUN_NOT_RUNNING");

      return proposeIntent(this.core, session, request.params);
    }

    if (Schema.is(IssueToolName)(request.op)) return issueTool(this.core, request);

    if (Schema.is(DeployToolName)(request.op)) return deployTool(this.core, request);

    if (session.runId) throw new TempoError("RUN_NOT_RUNNING");

    return agentTool(this.core, request);
  }
  private async applyEvent(envelope: TempodEventEnvelope): Promise<void> {
    if (this.closed) return;

    if (this.detached) {
      const decoded = decodeEvent(envelope.event);
      const replay = envelope.seq <= (this.detached.appliedSeq?.() ?? 0);

      if (Exit.isSuccess(decoded) && (!replay || decoded.value.kind === "incarnation.changed"))
        await this.detached.onEvent(decoded.value, envelope.seq);

      this.detachedAck = Math.max(this.detachedAck, envelope.seq);
      this.queueAck(true);

      return;
    }

    const row = this.core.ws();
    const parsedKind = Schema.decodeUnknownOption(Schema.Struct({ kind: Schema.String }))(envelope.event);
    const kind = Option.isSome(parsedKind) ? parsedKind.value.kind : undefined;
    const isIncarnation = kind === "incarnation.changed";

    if (!isIncarnation && envelope.seq <= row.tempodAckedSeq) return;
    const incarnation = row.tempodIncarnation ?? "";
    const decoded = decodeEvent(envelope.event);

    if (Exit.isFailure(decoded)) {
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

        if (turn && turn.status !== "queued" && turn.status !== "running") {
          const session = this.core.sessionRow(turn.sessionId);
          const runId = turn.origin !== "user" ? session.runId : null;

          const sentCause = this.core.kv<string>(`turnCause:${turn.id}`);

          const cause = sentCause
            ? this.core.lifecycle.row(sentCause)
            : runId
              ? this.core.db
                  .select()
                  .from(lifecycleEvents)
                  .where(and(eq(lifecycleEvents.runId, runId), eq(lifecycleEvents.type, "run.started")))
                  .get()
              : turn.changeId
                ? this.core.lifecycle.origin(turn.changeId)
                : null;

          let payload: Extract<LifecycleEvent, { type: "agent.turn.ended" }>["payload"] = {
            status: turn.status,
            stopReason: turn.stopReason,
          };

          const usage = toTurnUsage(event.usage);

          if (turn.errorCode) payload = { ...payload, errorCode: turn.errorCode };

          if (usage) payload = { ...payload, usage };

          let input: Omit<
            Extract<LifecycleEvent, { type: "agent.turn.ended" }>,
            "id" | "occurredAt" | "workspaceId"
          > = {
            type: "agent.turn.ended",
            source: "agent",
            turnId: turn.id,
            sessionId: turn.sessionId,
            agent: session.agent,
            dedupeKey: `tempod:${incarnation}:${envelope.seq}`,
            payload,
          };

          if (turn.changeId) input = { ...input, changeId: turn.changeId };

          if (runId) input = { ...input, runId };

          if (cause) input = { ...input, causationId: cause.id };
          this.core.lifecycle.append(input);
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
          upTo: this.detached ? this.detachedAck : this.core.ws().tempodAckedSeq,
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

  const token =
    core.wsOrNull()?.tempodToken ??
    core.kv<string>("catalogToken") ??
    core.kv<string>("ciToken") ??
    core.kv<string>("deployToken");

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
