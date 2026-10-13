import { createApiClient } from "../../src/ui/lib/api-client";

export { TempoError } from "@tempo/protocol";

/** Fixture HTTP transport uses the production API envelope decoder. */
export const call = createApiClient(async (name, input) => {
  const response = await fetch(`/__fixture/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });

  return response.text();
});
