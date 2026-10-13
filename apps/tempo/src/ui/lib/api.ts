import type { FnInput, FnName } from "@tempo/protocol";
import { createApiClient, type ApiTransport } from "./api-client";

export { createApiClient, type ApiTransport } from "./api-client";

export { TempoError } from "@tempo/protocol";

type ServerFn<K extends FnName> = (opts: { data: FnInput<K> }) => Promise<string>;

const serverTransport: ApiTransport = async (name, input) => {
  const fns = await import("../../server/fns.ts");
  // SAFETY: generated fns exports one function per API key; createApiClient couples the key and input.
  const fn = fns[name] as ServerFn<typeof name>;

  return fn({ data: input });
};

export const call = createApiClient(serverTransport);
