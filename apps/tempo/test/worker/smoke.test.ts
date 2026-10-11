import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("harness", () => {
  it("has D1 with the app tables", async () => {
    const rows = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='workspaces'",
    ).all();
    expect(rows.results).toHaveLength(1);
  });
  it("reaches a CredentialDO", async () => {
    const stub = env.CREDENTIALS.getByName("user-1");
    await stub.putSecret("openrouter.api_key", "sk-or-test");
    expect(await stub.getSecret("openrouter.api_key")).toBe("sk-or-test");
  });
});
