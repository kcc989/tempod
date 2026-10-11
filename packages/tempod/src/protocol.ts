import {
  DoAck,
  DoHello,
  DoReq,
  errorMessage,
  MAX_MESSAGE_BYTES,
  TEMPOD_REQUESTS,
  TempoError,
  type TempodOp,
  type TempodRes,
} from "@tempo/protocol";
import { Effect, Schema } from "effect";
import { errorText, type Logger } from "./log.ts";
import type { OutboxSink } from "./outbox.ts";
import type { Handlers, Tempod } from "./tempod.ts";

export interface Socket extends OutboxSink {
  close(code?: number, reason?: string): void;
}

type Outcome = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };

const decodeHello = Schema.decodeUnknownExit(DoHello);
const decodeAck = Schema.decodeUnknownExit(DoAck);
const decodeReq = Schema.decodeUnknownExit(DoReq);

const schemaMessage = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).split("\n").slice(0, 6).join(" ").slice(0, 1_000);

const toError = (e: unknown): { code: string; message: string } => {
  if (e instanceof TempoError) return { code: e.code, message: e.message };
  return { code: "INTERNAL", message: errorText(e).slice(0, 2_000) || errorMessage("INTERNAL") };
};

const isOp = (op: string): op is TempodOp => Object.prototype.hasOwnProperty.call(TEMPOD_REQUESTS, op);

/** Ops whose result size depends on a file: an oversized answer is FILE_TOO_LARGE, not INTERNAL. */
const FILE_OPS: ReadonlySet<string> = new Set(["fs.read", "git.fileDiff"]);

/** Validates params with the op's schema, runs its handler, and checks the result against the schema. */
export const dispatch = (handlers: Handlers, op: string, params: unknown): Effect.Effect<Outcome> =>
  Effect.gen(function* () {
    if (!isOp(op)) return yield* Effect.fail(new TempoError("UNKNOWN_OP", `Unknown op ${op}.`));
    const spec = TEMPOD_REQUESTS[op] as unknown as {
      params: Schema.Codec<unknown, unknown>;
      result: Schema.Codec<unknown, unknown>;
    };
    const handler = handlers[op] as (p: unknown) => Promise<unknown>;
    const decoded = yield* Schema.decodeUnknownEffect(spec.params)(params).pipe(
      Effect.mapError((e) => new TempoError("VALIDATION_FAILED", schemaMessage(e))),
    );
    const result = yield* Effect.tryPromise({ try: () => handler(decoded), catch: (e) => e });
    const encoded = yield* Schema.encodeUnknownEffect(spec.result)(result).pipe(
      Effect.mapError((e) => new TempoError("INTERNAL", `Bad ${op} result: ${schemaMessage(e)}`)),
    );
    return { ok: true as const, result: encoded };
  }).pipe(Effect.catch((e: unknown) => Effect.succeed({ ok: false as const, error: toError(e) })));

/** One `/v1/connect` socket: hello, ack and req (02, tempod protocol). */
export class ProtocolConnection {
  private helloDone = false;
  private closed = false;
  private readonly inflight = new Set<string>();

  constructor(
    private readonly app: Tempod,
    private readonly ws: Socket,
    private readonly log: Logger,
  ) {
    app.outbox.attach(ws);
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  onClose(): void {
    this.closed = true;
    this.app.outbox.detach(this.ws);
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.onClose();
    try {
      this.ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  /** Sends a response; one over the 1 MiB message limit (02) becomes an error response instead. */
  private send(res: TempodRes, op?: string): void {
    if (this.closed) {
      this.log.info("response dropped: socket closed", { id: res.id, ok: res.ok });
      return;
    }
    let text = JSON.stringify(res);
    const size = Buffer.byteLength(text);
    if (size > MAX_MESSAGE_BYTES) {
      const code = op !== undefined && FILE_OPS.has(op) ? "FILE_TOO_LARGE" : "INTERNAL";
      this.log.warn("response over the message size limit", { id: res.id, op, size });
      text = JSON.stringify({ type: "res", id: res.id, ok: false, error: { code, message: errorMessage(code) } });
    }
    this.ws.send(text);
  }

  onMessage(raw: string | Buffer): void {
    if (this.closed) return;
    let msg: unknown;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    } catch {
      this.log.warn("unparseable message from the DO");
      return;
    }
    const type = typeof msg === "object" && msg !== null ? (msg as { type?: unknown }).type : undefined;
    switch (type) {
      case "hello":
        return this.onHello(msg);
      case "ack": {
        const ack = decodeAck(msg);
        if (ack._tag === "Success" && this.helloDone) this.app.outbox.ack(ack.value.upTo);
        return;
      }
      case "req":
        return this.onReq(msg);
      default:
        this.log.warn("unknown message type from the DO", { type: String(type) });
    }
  }

  private onHello(msg: unknown): void {
    if ((msg as { v?: unknown }).v !== 1) {
      this.close(4400, "unsupported protocol version");
      return;
    }
    const hello = decodeHello(msg);
    if (hello._tag === "Failure") {
      this.close(4400, "bad hello");
      return;
    }
    // Before app.hello: the port scanner it starts queues events, which must get seqs after the handshake.
    const { matched } = this.app.outbox.handshake(hello.value.incarnation, hello.value.lastAckedSeq);
    this.app.hello(hello.value);
    this.helloDone = true;
    this.log.info("hello", { matched, incarnation: this.app.outbox.incarnation, lastAckedSeq: hello.value.lastAckedSeq });
  }

  private onReq(msg: unknown): void {
    const req = decodeReq(msg);
    if (req._tag === "Failure") {
      const id = (msg as { id?: unknown }).id;
      if (typeof id === "string") {
        this.send({ type: "res", id, ok: false, error: { code: "VALIDATION_FAILED", message: "Bad request envelope." } });
      } else this.log.warn("request without an id dropped");
      return;
    }
    const { id, op, params } = req.value;
    if (!this.helloDone) {
      this.send({ type: "res", id, ok: false, error: { code: "INTERNAL", message: "hello first" } });
      return;
    }
    if (this.inflight.has(id)) return;
    this.inflight.add(id);
    const started = Date.now();
    let answered = false;
    const answer = (res: TempodRes): void => {
      if (answered) return;
      this.send(res, op);
      answered = true;
      this.inflight.delete(id);
    };
    void Effect.runPromise(dispatch(this.app.handlers, op, params))
      .then((outcome) => {
        const ms = Date.now() - started;
        if (outcome.ok) {
          this.log.debug("request done", { id, op, ms });
          answer({ type: "res", id, ok: true, result: outcome.result });
        } else {
          const level = outcome.error.code === "INTERNAL" ? "warn" : "info";
          this.log.log(level, "request failed", { id, op, ms, code: outcome.error.code, message: outcome.error.message });
          answer({ type: "res", id, ok: false, error: outcome.error });
        }
        if (op === "shutdown" && outcome.ok) void this.app.afterShutdownAnswered();
      })
      .catch((e: unknown) => {
        this.log.local("error", "request handling failed", { id, op, error: errorText(e) });
        try {
          answer({ type: "res", id, ok: false, error: { code: "INTERNAL", message: errorMessage("INTERNAL") } });
        } catch {
          this.inflight.delete(id);
        }
      });
  }
}
