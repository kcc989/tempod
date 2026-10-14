import { Schema, Option } from "effect";
/**
 * `tempod mcp-bridge` (01, User MCP servers): stdio MCP on one side, a remote MCP server over
 * streamable HTTP or the older SSE transport on the other. For agents that lack that transport.
 */

export interface BridgeArgs {
  readonly transport: "http" | "sse";
  readonly url: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
}

export interface BridgeIo {
  readonly lines: AsyncIterable<string>;
  readonly write: (line: string) => void;
  readonly log: (msg: string) => void;
  readonly fetch?: typeof fetch;
}

export class BridgeArgsError extends Error {}

export const parseBridgeArgs = (argv: ReadonlyArray<string>): BridgeArgs => {
  let transport: string | undefined;
  let url: string | undefined;
  const headers: Array<readonly [string, string]> = [];

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];

    if (value === undefined) throw new BridgeArgsError(`${flag} needs a value`);
    i++;

    if (flag === "--transport") transport = value;
    else if (flag === "--url") url = value;
    else if (flag === "--header") {
      const colon = value.indexOf(":");

      if (colon <= 0) throw new BridgeArgsError("--header needs 'Name: value'");
      headers.push([value.slice(0, colon).trim(), value.slice(colon + 1).trim()]);
    } else throw new BridgeArgsError(`unknown flag ${flag}`);
  }

  if (transport !== "http" && transport !== "sse") throw new BridgeArgsError("--transport is http or sse");

  if (!url) throw new BridgeArgsError("--url is missing");

  return { transport, url, headers };
};

export interface SseEvent {
  readonly event: string;
  readonly data: string;
}

/** Parses a `text/event-stream` body into events (HTML Living Standard, server-sent events). */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let data: string[] = [];
  const reader = body.getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let nl: number;

      while ((nl = buffer.search(/\r\n|\r|\n/)) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + (buffer.startsWith("\r\n", nl) ? 2 : 1));

        if (line === "") {
          if (data.length > 0) yield { event: event || "message", data: data.join("\n") };
          event = "";
          data = [];
          continue;
        }

        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let val = colon < 0 ? "" : line.slice(colon + 1);

        if (val.startsWith(" ")) val = val.slice(1);

        if (field === "event") event = val;
        else if (field === "data") data.push(val);
      }

      if (done) {
        if (data.length > 0) yield { event: event || "message", data: data.join("\n") };

        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Reads newline-delimited text from a byte stream. */
export async function* streamLines(stream: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;

    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);

      if (line) yield line;
    }
  }

  const rest = (buffer + decoder.decode()).trim();

  if (rest) yield rest;
}

const RequestIdentity = Schema.Struct({
  id: Schema.Union([Schema.String, Schema.Number]),
  method: Schema.Unknown,
});

const idOf = (line: string): string | number | null => {
  const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(RequestIdentity))(line);

  return Option.isSome(parsed) ? parsed.value.id : null;
};

const rpcError = (id: string | number, message: string): string =>
  JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } });

const InitializationResult = Schema.Struct({ result: Schema.Struct({ protocolVersion: Schema.String }) });

const protocolVersionOf = (data: string): string | null => {
  const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(InitializationResult))(data);

  return Option.isSome(parsed) ? parsed.value.result.protocolVersion : null;
};

const bridgeHeaders = (args: BridgeArgs): Headers => {
  const headers = new Headers();

  for (const [name, value] of args.headers) headers.append(name, value);

  return headers;
};

/** Streamable HTTP: one POST per message; replies come back as JSON or as an SSE stream. */
const runHttp = async (args: BridgeArgs, io: BridgeIo, doFetch: typeof fetch): Promise<number> => {
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  let listening = false;
  const pending = new Set<Promise<void>>();

  const headers = (accept: string): Headers => {
    const h = bridgeHeaders(args);
    h.set("accept", accept);

    if (sessionId) h.set("mcp-session-id", sessionId);

    if (protocolVersion) h.set("mcp-protocol-version", protocolVersion);

    return h;
  };

  const emit = (data: string) => {
    protocolVersion ??= protocolVersionOf(data);
    io.write(data);
  };

  const forward = async (res: Response) => {
    const type = res.headers.get("content-type") ?? "";

    if (type.includes("text/event-stream") && res.body) {
      for await (const ev of sseEvents(res.body)) if (ev.event === "message") emit(ev.data);
    } else if (type.includes("application/json")) {
      const body = Schema.decodeUnknownSync(Schema.Json)(await res.json());

      for (const msg of Array.isArray(body) ? body : [body]) emit(JSON.stringify(msg));
    } else await res.body?.cancel();
  };

  const listen = () => {
    if (listening || !sessionId) return;
    listening = true;

    const work = doFetch(args.url, { method: "GET", headers: headers("text/event-stream") })
      .then((res) => (res.ok ? forward(res) : res.body?.cancel()))
      .catch((cause: unknown) => io.log(`mcp-bridge: event stream failed: ${String(cause)}`));

    void work;
  };

  const post = async (line: string) => {
    const id = idOf(line);

    try {
      const h = headers("application/json, text/event-stream");
      h.set("content-type", "application/json");
      const res = await doFetch(args.url, { method: "POST", headers: h, body: line });
      sessionId = res.headers.get("mcp-session-id") ?? sessionId;

      if (!res.ok) {
        await res.body?.cancel();
        io.log(`mcp-bridge: POST returned ${res.status}`);

        if (id !== null) io.write(rpcError(id, `MCP server returned HTTP ${res.status}`));

        return;
      }

      await forward(res);

      if (protocolVersion) listen();
    } catch (e) {
      io.log(`mcp-bridge: POST failed: ${String(e)}`);

      if (id !== null) io.write(rpcError(id, "Could not reach the MCP server"));
    }
  };

  for await (const line of io.lines) {
    const p = post(line).finally(() => pending.delete(p));
    pending.add(p);
  }

  await Promise.all(pending);

  if (sessionId) {
    await doFetch(args.url, { method: "DELETE", headers: headers("application/json") })
      .then((r) => r.body?.cancel())
      .catch(() => undefined);
  }

  return 0;
};

/** The SSE transport: one GET event stream; messages go to the URL of its `endpoint` event. */
const runSse = async (args: BridgeArgs, io: BridgeIo, doFetch: typeof fetch): Promise<number> => {
  const base = bridgeHeaders(args);
  const stream = new Headers(base);
  stream.set("accept", "text/event-stream");
  const res = await doFetch(args.url, { method: "GET", headers: stream });

  if (!res.ok || !res.body) {
    io.log(`mcp-bridge: event stream returned ${res.status}`);

    return 1;
  }

  let resolveEndpoint: (url: string) => void = () => {};

  const endpoint = new Promise<string>((r) => (resolveEndpoint = r));
  let closed = false;

  const reading = (async () => {
    for await (const ev of sseEvents(res.body!)) {
      if (ev.event === "endpoint") resolveEndpoint(new URL(ev.data.trim(), args.url).href);
      else if (ev.event === "message") io.write(ev.data);
    }
  })()
    .catch((cause: unknown) => io.log(`mcp-bridge: event stream failed: ${String(cause)}`))
    .finally(() => (closed = true));

  const post = async (line: string) => {
    const id = idOf(line);

    try {
      const h = new Headers(base);
      h.set("content-type", "application/json");
      const r = await doFetch(await endpoint, { method: "POST", headers: h, body: line });
      await r.body?.cancel();

      if (!r.ok) {
        io.log(`mcp-bridge: POST returned ${r.status}`);

        if (id !== null) io.write(rpcError(id, `MCP server returned HTTP ${r.status}`));
      }
    } catch (e) {
      io.log(`mcp-bridge: POST failed: ${String(e)}`);

      if (id !== null) io.write(rpcError(id, "Could not reach the MCP server"));
    }
  };

  const pending = new Set<Promise<void>>();

  const input = (async () => {
    for await (const line of io.lines) {
      const p = post(line).finally(() => pending.delete(p));
      pending.add(p);
    }

    await Promise.all(pending);
  })();

  await Promise.race([input, reading]);

  if (closed) return 1;
  await res.body.cancel().catch(() => undefined);

  return 0;
};

export const runBridge = (args: BridgeArgs, io: BridgeIo): Promise<number> => {
  const doFetch = io.fetch ?? fetch;

  return args.transport === "http" ? runHttp(args, io, doFetch) : runSse(args, io, doFetch);
};

export const bridgeMain = async (argv: ReadonlyArray<string>): Promise<number> => {
  let args: BridgeArgs;

  try {
    args = parseBridgeArgs(argv);
  } catch (e) {
    process.stderr.write(`mcp-bridge: ${e instanceof Error ? e.message : String(e)}\n`);

    return 2;
  }

  return runBridge(args, {
    lines: streamLines(Bun.stdin.stream()),
    write: (line) => process.stdout.write(`${line}\n`),
    log: (msg) => process.stderr.write(`${msg}\n`),
  });
};
