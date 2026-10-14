import { Schema } from "effect";
import { env, runInDurableObject } from "cloudflare:test";
import { newId } from "@tempo/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCodexLogin, pollCodexLogin, cancelCodexLogin } from "../../src/server/handlers/credentials.ts";
import type { HandlerCtx } from "../../src/server/run.ts";
import { runFn } from "../../src/server/run.ts";
import type { CredentialDO } from "../../src/do/credential.ts";

const device = { device_auth_id: "private-device-id", user_code: "ABCD-EFGH", interval: "5" };

const approved = {
  authorization_code: "private-code",
  code_verifier: "private-verifier",
  code_challenge: "challenge",
};

const tokens = {
  id_token: `header.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } }))}.signature`,
  access_token: "private-access",
  refresh_token: "private-refresh",
};

const setup = () => {
  const userId = newId();
  const c: HandlerCtx = { env, user: { id: userId, name: "Owner", email: "owner@example.com", image: null } };
  const stub: DurableObjectStub<CredentialDO> = env.CREDENTIALS.getByName(userId);
  const fetch = vi.spyOn(globalThis, "fetch");

  const reply = (status: number, body: import("@tempo/protocol").JsonData) =>
    fetch.mockImplementationOnce(async () => Response.json(body, { status }));

  const allowNextPoll = () =>
    runInDurableObject<CredentialDO, void>(stub, (instance: CredentialDO, _state: DurableObjectState) => {
      instance["codexLogin"]!.nextPollAt = 0;
    });

  return { c, stub, fetch, reply, allowNextPoll };
};

afterEach(() => vi.restoreAllMocks());

describe("Codex device login", () => {
  it("starts without a workspace, honors polling interval, saves encrypted auth and makes completion idempotent", async () => {
    const h = setup();
    h.reply(200, device);
    const [login, concurrent] = await Promise.all([startCodexLogin(h.c), startCodexLogin(h.c)]);
    expect(concurrent).toEqual(login);
    expect(login).toMatchObject({
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: device.user_code,
      intervalMs: 5000,
    });
    expect(JSON.stringify(login)).not.toContain(device.device_auth_id);
    expect(await startCodexLogin(h.c)).toEqual(login);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(Schema.decodeUnknownSync(Schema.String)(h.fetch.mock.calls[0]![1]!.body))).toEqual({
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    });
    h.reply(403, {});
    expect(await pollCodexLogin(h.c, { loginId: login.loginId })).toEqual({ status: "pending" });
    expect(await pollCodexLogin(h.c, { loginId: login.loginId })).toEqual({ status: "pending" });
    expect(h.fetch).toHaveBeenCalledTimes(2);
    await h.allowNextPoll();
    h.reply(200, approved);
    h.reply(200, tokens);
    expect(await pollCodexLogin(h.c, { loginId: login.loginId })).toEqual({ status: "connected" });
    expect(await pollCodexLogin(h.c, { loginId: login.loginId })).toEqual({ status: "connected" });
    expect(h.fetch).toHaveBeenCalledTimes(4);

    const exchange = new URLSearchParams(
      Schema.decodeUnknownSync(Schema.String)(h.fetch.mock.calls[3]![1]!.body),
    );

    expect(exchange.get("code_verifier")).toBe(approved.code_verifier);
    expect(exchange.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
    const auth = await h.stub.getCodexAuth();
    expect(JSON.parse(auth!.content)).toMatchObject({
      auth_mode: "chatgpt",
      tokens: { ...tokens, account_id: "account-1" },
    });
    expect(auth!.version).toBe(1);

    const raw = await runInDurableObject(h.stub, (_i, state) =>
      state.storage.sql.exec("SELECT ciphertext, meta_json FROM secrets WHERE key = 'codex.auth_json'").one(),
    );

    expect(
      new TextDecoder().decode(Schema.decodeUnknownSync(Schema.instanceOf(ArrayBuffer))(raw.ciphertext)),
    ).not.toContain(tokens.access_token);
    expect(JSON.parse(String(raw.meta_json)).lastRefresh).toBe(auth!.lastRefresh);
    expect(JSON.stringify(await h.stub.status())).not.toContain("private-");
  });

  it("does not save an in-flight exchange after cancellation and does not cancel a different attempt", async () => {
    const h = setup();
    h.reply(200, device);
    const login = await startCodexLogin(h.c);
    await cancelCodexLogin(h.c, { loginId: "another-attempt" });
    let finish!: () => void;
    h.reply(200, approved);
    h.fetch.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });

      return Response.json(tokens);
    });
    await runInDurableObject<CredentialDO, void>(
      h.stub,
      async (i: CredentialDO, _state: DurableObjectState) => {
        const instance = i;
        const poll = instance.pollCodexLogin(login.loginId);
        await vi.waitFor(() => expect(finish).toBeDefined());
        await instance.cancelCodexLogin(login.loginId);
        finish();
        expect(await poll).toEqual({ ok: true, value: { status: "expired" } });
      },
    );
    expect(await h.stub.getCodexAuth()).toBeNull();
  });

  it("expires a stale attempt, and a removed login cannot be restored by polling", async () => {
    const h = setup();
    h.reply(200, device);
    const login = await startCodexLogin(h.c);
    await runInDurableObject<CredentialDO, void>(
      h.stub,
      (instance: CredentialDO, _state: DurableObjectState) => {
        instance["codexLogin"]!.public = { ...instance["codexLogin"]!.public, expiresAt: 0 };
      },
    );
    expect(await pollCodexLogin(h.c, { loginId: login.loginId })).toEqual({ status: "expired" });
    h.reply(200, device);
    const next = await startCodexLogin(h.c);
    await h.stub.deleteSecret("codex.auth_json");
    expect(await pollCodexLogin(h.c, { loginId: next.loginId })).toEqual({ status: "expired" });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("a manual upload supersedes device login without letting the old attempt overwrite it", async () => {
    const h = setup();
    h.reply(200, device);
    const login = await startCodexLogin(h.c);
    await h.stub.replaceCodexAuth("manual-login", 456);
    expect(await pollCodexLogin(h.c, { loginId: login.loginId })).toEqual({ status: "expired" });
    expect((await h.stub.getCodexAuth())!.content).toBe("manual-login");
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps an existing login on upstream failure, hides upstream secrets and allows retry", async () => {
    const h = setup();
    await h.stub.replaceCodexAuth("existing-login", 123);
    h.reply(200, device);
    const login = await startCodexLogin(h.c);
    h.reply(500, { error: "private-access private-verifier" });
    await expect(pollCodexLogin(h.c, { loginId: login.loginId })).rejects.toThrow("Could not connect Codex");
    expect((await h.stub.getCodexAuth())!.content).toBe("existing-login");
    expect(await pollCodexLogin(h.c, { loginId: login.loginId })).toEqual({ status: "expired" });
    h.reply(200, device);
    expect((await startCodexLogin(h.c)).loginId).not.toBe(login.loginId);
  });

  it("returns a safe error for disabled device login and malformed responses", async () => {
    const h = setup();
    h.reply(404, { secret: "private-upstream-body" });
    await expect(startCodexLogin(h.c)).rejects.toThrow("Enable device-code login");
    h.reply(200, { ...device, interval: "bad" });
    await expect(startCodexLogin(h.c)).rejects.toThrow("Could not connect Codex");
    expect(await h.stub.getCodexAuth()).toBeNull();
  });

  it("does not store malformed token exchanges or expose transport errors", async () => {
    const h = setup();
    h.reply(200, device);
    const login = await startCodexLogin(h.c);
    h.reply(200, approved);
    h.reply(200, { ...tokens, id_token: "not-a-jwt" });
    await expect(pollCodexLogin(h.c, { loginId: login.loginId })).rejects.toThrow("Could not connect Codex");
    expect(await h.stub.getCodexAuth()).toBeNull();
    h.fetch.mockRejectedValueOnce(new Error("private-access private-verifier"));
    await expect(startCodexLogin(h.c)).rejects.toThrow("Could not connect Codex");
  });

  it("requires Tempo authentication for each public login function", async () => {
    const h = setup();

    for (const name of ["startCodexLogin", "pollCodexLogin", "cancelCodexLogin"] as const) {
      const result = await runFn(
        name,
        env,
        new Headers(),
        { loginId: "id" },
        { allowCookie: false, allowBearer: true },
      );

      expect(result).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    }

    expect(h.fetch).not.toHaveBeenCalled();
  });
});
