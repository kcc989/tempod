import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { newId } from "@tempo/protocol";
import { runFn } from "../../src/server/run.ts";
import { seedProject } from "./fakes.ts";

const randomToken = (n = 32) => {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
};

const signIn = async (userId: string): Promise<string> => {
  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(newId(), now + 86_400_000, token, now, now, userId)
    .run();
  return token;
};

const BEARER = { allowCookie: false, allowBearer: true };

describe("probe", () => {
  it("bearer works", async () => {
    const seeded = await seedProject();
    const token = await signIn(seeded.userId);
    const res = await runFn("listProjects", env, new Headers({ Authorization: `Bearer ${token}` }), {}, BEARER);
    console.log(JSON.stringify(res));
    expect(res.ok).toBe(true);
  });
});
