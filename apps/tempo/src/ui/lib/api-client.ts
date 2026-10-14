import { API, ErrorBody, unwrap, type FnInput, type FnName, type FnOutput } from "@tempo/protocol";
import { Schema } from "effect";

export type ApiTransport = (name: FnName, input: FnInput<FnName>) => Promise<string>;

/** Validates the response envelope for the requested API function before returning its value. */
export const createApiClient =
  (transport: ApiTransport) =>
  async <K extends FnName>(name: K, input: FnInput<K>): Promise<FnOutput<K>> => {
    const output = API[name].output;

    const envelope = Schema.Union([
      Schema.Struct({ ok: Schema.Literal(true), value: output }),
      Schema.Struct({ ok: Schema.Literal(false), error: ErrorBody }),
    ]);

    return unwrap(Schema.decodeUnknownSync(Schema.fromJsonString(envelope))(await transport(name, input)));
  };
