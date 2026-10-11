import { TempoError, unwrap, type FnInput, type FnName, type FnOutput, type Result } from "@tempo/protocol";
import * as fns from "../../server/fns.ts";

type ServerFn<K extends FnName> = (opts: { data: FnInput<K> }) => Promise<string>;

/**
 * Calls one server function and unwraps its Result. Throws TempoError with the code and message
 * from the error table (02, Error codes).
 */
export const call = async <K extends FnName>(name: K, input: FnInput<K>): Promise<FnOutput<K>> => {
  const fn = (fns as unknown as Record<FnName, ServerFn<K>>)[name];
  return unwrap(JSON.parse(await fn({ data: input })) as Result<FnOutput<K>>);
};

export { TempoError };
