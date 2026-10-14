import {
  ToolRes,
  newId,
  type ToolReq,
  DoAck,
  DoHello,
  DoReq,
  errorMessage,
  MAX_MESSAGE_BYTES,
  TEMPOD_REQUESTS,
  TempoError,
  type TempodOp,
  type TempodResult,
  type TempodRes,
} from "@tempo/protocol";
import { Effect, Exit, Predicate, Schema } from "effect";
import { errorText, type Logger } from "./log.ts";
import type { OutboxSink } from "./outbox.ts";
import type { Handlers, Tempod } from "./tempod.ts";

export interface Socket extends OutboxSink {
  close(code?: number, reason?: string): void;
}

type Outcome =
  | { ok: true; result: TempodResult<TempodOp> }
  | { ok: false; error: { code: string; message: string } };

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject => Predicate.isObject(value);

const decodeHello = Schema.decodeUnknownExit(DoHello);

const decodeAck = Schema.decodeUnknownExit(DoAck);

const decodeReq = Schema.decodeUnknownExit(DoReq);

const schemaMessage = (cause: unknown): string =>
  (cause instanceof Error ? cause.message : String(cause)).split("\n").slice(0, 6).join(" ").slice(0, 1_000);

const toError = (cause: unknown) => {
  if (cause instanceof TempoError)
    return { code: cause.code, message: cause.message } satisfies { code: string; message: string };

  return {
    code: "INTERNAL",
    message: errorText(cause).slice(0, 2_000) || errorMessage("INTERNAL"),
  } satisfies { code: string; message: string };
};

const isOp = (op: string): op is TempodOp => Object.prototype.hasOwnProperty.call(TEMPOD_REQUESTS, op);

/** Ops whose result size depends on a file: an oversized answer is FILE_TOO_LARGE, not INTERNAL. */
const FILE_OPS: ReadonlySet<string> = new Set(["fs.read", "git.fileDiff"]);

/** Validates params with the op's schema, runs its handler, and checks the result against the schema. */
export const dispatch = (
  handlers: Handlers,
  request: Pick<DoReq, "op" | "params">,
): Effect.Effect<Outcome> => {
  const run = <K extends TempodOp>(op: K) =>
    Effect.gen(function* () {
      // SAFETY: op selects both codecs and their TempodParams<K>/TempodResult<K> types from this registry.
      const spec = TEMPOD_REQUESTS[op];
      const handler = handlers[op];

      const decoded = yield* Schema.decodeUnknownEffect(spec.params)(request.params).pipe(
        Effect.mapError((cause) => new TempoError("VALIDATION_FAILED", schemaMessage(cause))),
      );

      const result = yield* Effect.tryPromise({ try: () => handler(decoded), catch: (cause) => cause });

      const encoded = yield* Schema.encodeUnknownEffect(spec.result)(result).pipe(
        Effect.mapError((cause) => new TempoError("INTERNAL", `Bad ${op} result: ${schemaMessage(cause)}`)),
      );

      return { ok: true as const, result: encoded };
    });

  return Effect.gen(function* () {
    if (!isOp(request.op))
      return yield* Effect.fail(new TempoError("UNKNOWN_OP", `Unknown op ${request.op}.`));

    return yield* run(request.op);
  }).pipe(Effect.catch((cause: unknown) => Effect.succeed({ ok: false as const, error: toError(cause) })));
};

/** One `/v1/connect` socket: hello, ack and req (02, tempod protocol). */
export class ProtocolConnection {
  private readonly tools = new Map<
    string,
    {
      resolve: (value: Schema.Json) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly callTool = (input: Omit<ToolReq, "id" | "type">): Promise<Schema.Json> => {
    if (this.closed || !this.helloDone) return Promise.reject(new TempoError("TEMPOD_UNREACHABLE"));
    const id = newId();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.tools.delete(id);
        reject(new TempoError("TEMPOD_TIMEOUT"));
      }, 15000);

      this.tools.set(id, { resolve, reject, timer });

      try {
        this.ws.send(JSON.stringify({ type: "tool.req", id, ...input }));
      } catch {
        clearTimeout(timer);
        this.tools.delete(id);
        reject(new TempoError("TEMPOD_UNREACHABLE"));
      }
    });
  };
  private helloDone = false;
  private closed = false;
  private readonly inflight = new Set<string>();

  constructor(
    private readonly app: Tempod,
    private readonly ws: Socket,
    private readonly log: Logger,
  ) {
    app.outbox.attach(ws);
    app.toolCall = this.callTool;
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  onClose(): void {
    this.closed = true;
    this.app.outbox.detach(this.ws);

    if (this.app.toolCall === this.callTool) this.app.toolCall = null;

    for (const pending of this.tools.values()) {
      clearTimeout(pending.timer);
      pending.reject(new TempoError("TEMPOD_UNREACHABLE"));
    }

    this.tools.clear();
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
      text = JSON.stringify({
        type: "res",
        id: res.id,
        ok: false,
        error: { code, message: errorMessage(code) },
      });
    }

    this.ws.send(text);
  }

  onMessage(raw: string | Buffer): void {
    if (this.closed) return;
    let msg: Schema.Json;

    try {
      msg = JSON.parse(Schema.is(Schema.String)(raw) ? raw : raw.toString("utf8"));
    } catch {
      this.log.warn("unparseable message from the DO");

      return;
    }

    if (!isJsonObject(msg)) {
      this.log.warn("unknown message type from the DO", { type: "undefined" });

      return;
    }

    const type = msg["type"];

    switch (type) {
      case "hello":
        return this.onHello(msg);
      case "ack": {
        const ack = decodeAck(msg);

        if (Exit.isSuccess(ack) && this.helloDone) this.app.outbox.ack(ack.value.upTo);

        return;
      }

      case "tool.res": {
        const decoded = Schema.decodeUnknownExit(ToolRes)(msg);

        if (Exit.isFailure(decoded)) return;
        const response = decoded.value;
        const pending = this.tools.get(response.id);

        if (!pending) return;
        clearTimeout(pending.timer);
        this.tools.delete(response.id);

        if (response.ok) pending.resolve(response.result);
        else pending.reject(new Error(response.error.message));

        return;
      }

      case "req":
        return this.onReq(msg);
      default:
        this.log.warn("unknown message type from the DO", { type: String(type) });
    }
  }

  private onHello(msg: Schema.JsonObject): void {
    if (msg["v"] !== 1) {
      this.close(4400, "unsupported protocol version");

      return;
    }

    const hello = decodeHello(msg);

    if (Exit.isFailure(hello)) {
      this.close(4400, "bad hello");

      return;
    }

    // Before app.hello: the port scanner it starts queues events, which must get seqs after the handshake.
    const { matched } = this.app.outbox.handshake(hello.value.incarnation, hello.value.lastAckedSeq);
    this.app.hello(hello.value);
    this.helloDone = true;
    this.log.info("hello", {
      matched,
      incarnation: this.app.outbox.incarnation,
      lastAckedSeq: hello.value.lastAckedSeq,
    });
  }

  private onReq(msg: Schema.JsonObject): void {
    const req = decodeReq(msg);

    if (Exit.isFailure(req)) {
      const id = msg["id"];

      if (Schema.is(Schema.String)(id)) {
        this.send({
          type: "res",
          id,
          ok: false,
          error: { code: "VALIDATION_FAILED", message: "Bad request envelope." },
        });
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

    void Effect.runPromise(dispatch(this.app.handlers, { op, params }))
      .then((outcome) => {
        const ms = Date.now() - started;

        if (outcome.ok) {
          this.log.debug("request done", { id, op, ms });
          answer({ type: "res", id, ok: true, result: outcome.result });
        } else {
          const level = outcome.error.code === "INTERNAL" ? "warn" : "info";
          this.log.log(level, "request failed", {
            id,
            op,
            ms,
            code: outcome.error.code,
            message: outcome.error.message,
          });
          answer({ type: "res", id, ok: false, error: outcome.error });
        }

        if (op === "shutdown" && outcome.ok) void this.app.afterShutdownAnswered();
      })
      .catch((cause: unknown) => {
        this.log.local("error", "request handling failed", { id, op, error: errorText(cause) });

        try {
          answer({
            type: "res",
            id,
            ok: false,
            error: { code: "INTERNAL", message: errorMessage("INTERNAL") },
          });
        } catch {
          this.inflight.delete(id);
        }
      });
  }
}
