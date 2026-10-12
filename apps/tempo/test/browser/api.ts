import { unwrap, type FnInput, type FnName, type FnOutput, type Result } from "@tempo/protocol";

/** Only this browser fixture build replaces the server-function transport. */
export const call = async <K extends FnName>(name: K, input: FnInput<K>): Promise<FnOutput<K>> => {
  const response = await fetch(`/__fixture/rpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return unwrap((await response.json()) as Result<FnOutput<K>>);
};
