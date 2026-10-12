import { describe, expect, it } from "bun:test";
import { preflightDeployment } from "./deployment-preflight.ts";

const env = { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_API_TOKEN: "private" };
const api = (result: unknown) => Response.json({ success: true, result });

describe("deployment preflight", () => {
  it("refuses bootstrap when an existing store is blocked, without leaking the token", async () => {
    const paths: string[] = [];
    const fake = async (url: string | URL | Request) => {
      paths.push(String(url));
      if (String(url).endsWith("workers/scripts")) return api([{ id: "tempo-state-store" }]);
      if (String(url).endsWith("workers/subdomain")) return api({ subdomain: "account" });
      throw new Error("CONNECT 403");
    };
    await expect(preflightDeployment(env, fake)).rejects.toThrow("do not bootstrap or rotate secrets");
    expect(paths).toHaveLength(3);
    expect(paths.join(" ")).not.toContain("private");
  });
  it("fails closed on API denial and an unhealthy existing store", async () => {
    await expect(
      preflightDeployment(env, async () => new Response("denied", { status: 403 })),
    ).rejects.toThrow("Cloudflare preflight workers/scripts failed (403)");
    const fake = async (url: string | URL | Request) => {
      if (String(url).endsWith("workers/scripts")) return api([{ id: "tempo-state-store" }]);
      if (String(url).endsWith("workers/subdomain")) return api({ subdomain: "account" });
      return new Response("unavailable", { status: 500 });
    };
    await expect(preflightDeployment(env, fake)).rejects.toThrow("do not bootstrap or rotate secrets");
  });
  it("refuses to replay an unfinished bootstrap over an existing store", async () => {
    await expect(
      preflightDeployment(env, async () => api([{ id: "tempo-state-store" }]), true),
    ).rejects.toThrow("do not replay generated secrets");
  });
  it("permits a reachable existing store and a confirmed first deployment", async () => {
    for (const exists of [true, false]) {
      const fake = async (url: string | URL | Request) => {
        if (String(url).endsWith("workers/scripts")) return api(exists ? [{ id: "tempo-state-store" }] : []);
        if (String(url).endsWith("workers/subdomain")) return api({ subdomain: "account" });
        if (String(url).endsWith("secrets_store/stores")) return api([]);
        return Response.json({ version: "2" });
      };
      expect(await preflightDeployment(env, fake)).toBe(exists);
    }
  });
});

it("ignores the unrelated account-wide store", async () => {
  const paths: string[] = [];
  expect(
    await preflightDeployment(env, async (url) => {
      paths.push(String(url));
      return api(String(url).endsWith("workers/scripts") ? [{ id: "alchemy-state-store" }] : []);
    }),
  ).toBe(false);
  expect(paths).toHaveLength(2);
});

it("refuses a missing Worker when dedicated remote secrets or local bootstrap survive", async () => {
  const fake = async (url: string | URL | Request) => {
    if (String(url).endsWith("workers/scripts")) return api([]);
    if (String(url).endsWith("secrets_store/stores")) return api([{ id: "store" }]);
    return api([{ name: "TempoStateStoreEncryptionKey" }]);
  };
  await expect(preflightDeployment(env, fake)).rejects.toThrow("do not bootstrap or rotate secrets");
  await expect(preflightDeployment(env, fake, true)).rejects.toThrow("do not replay generated secrets");
});
