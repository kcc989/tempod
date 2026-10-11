import { expect, test } from "@playwright/test";
import {
  appUrl,
  bearer,
  fetchApp,
  getMeta,
  requireChannels,
  rpcRaw,
  Socket,
  storageStateCookie,
  upgradeStatus,
  uploadAttachment,
} from "./lib/api.ts";
import { E2E, ENABLED, SKIP_REASON } from "./lib/env.ts";
import { cleanupFile, cleanupTest, newWorkspace } from "./lib/flows.ts";
import { requireUi } from "./lib/ui.ts";
import { sleep } from "./lib/util.ts";

/**
 * Gate E, server side (07, milestone M0: AT-23 to AT-25). AT-26 to AT-37 need the Mac app and
 * are not part of this package.
 */

test.skip(!ENABLED, SKIP_REASON);
test.afterEach(cleanupTest);
test.afterAll(cleanupFile);

const MAC_CLIENT_ID = "tempo-mac";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

interface DeviceCode {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete: string;
  readonly expires_in: number;
  readonly interval: number;
}

/** Steps 3 and 6 of the Mac first run (07, Sign-in and first run). */
const requestDeviceCode = async (): Promise<DeviceCode> => {
  const r = await fetchApp("/api/auth/device/code", { token: null, json: { client_id: MAC_CLIENT_ID } });
  expect(r.status, r.text).toBe(200);
  return r.json as DeviceCode;
};

const pollToken = (code: DeviceCode) =>
  fetchApp("/api/auth/device/token", {
    token: null,
    json: { grant_type: DEVICE_GRANT, device_code: code.device_code, client_id: MAC_CLIENT_ID },
  });

/** Polls every `interval` seconds, adding 5 s on slow_down, until the answer is not authorization_pending. */
const pollUntilDecided = async (code: DeviceCode, timeoutMs = 120_000) => {
  let interval = Math.max(1, code.interval) * 1_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await sleep(interval);
    const r = await pollToken(code);
    const error = (r.json as { error?: string } | undefined)?.error;
    if (error === "slow_down") interval += 5_000;
    else if (error !== "authorization_pending") return r;
    if (Date.now() > deadline) throw new Error("the device code was neither approved nor denied in time");
  }
};

/** What the /device page does for a signed-in owner: claim the code, then approve or deny it. */
const decideWithBearer = async (code: DeviceCode, decision: "approve" | "deny") => {
  const claim = await fetchApp(`/api/auth/device?user_code=${encodeURIComponent(code.user_code)}`);
  expect(claim.status, claim.text).toBe(200);
  const r = await fetchApp(`/api/auth/device/${decision}`, {
    json: { userCode: code.user_code },
    headers: { Origin: E2E.url },
  });
  expect(r.status, r.text).toBe(200);
};

const normalize = (s: string): string => s.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

test.describe("AT-23 device sign-in", () => {
  test("AT-23 /api/v1/meta identifies a protocol 1 Tempo without auth", async () => {
    const { status, meta } = await getMeta();
    expect(status).toBe(200);
    expect(meta).toMatchObject({ protocol: 1 });
    expect(typeof meta?.serverVersion).toBe("string");
    expect(typeof meta?.minMacClient).toBe("string");
  });

  test("AT-23 a device code approved by the owner signs the app in; the token works on /api/v1 until signed out", async () => {
    const code = await requestDeviceCode();
    expect(new URL(code.verification_uri_complete, appUrl("/")).pathname).toBe("/device");
    expect(new URL(code.verification_uri_complete, appUrl("/")).searchParams.get("user_code")).toBe(
      code.user_code,
    );
    const pending = await pollToken(code);
    expect((pending.json as { error?: string }).error).toBe("authorization_pending");

    await decideWithBearer(code, "approve");
    const granted = await pollUntilDecided(code);
    expect(granted.status, granted.text).toBe(200);
    const token = (granted.json as { access_token?: string }).access_token;
    expect(token).toBeTruthy();

    expect((await rpcRaw("listProjects", {}, { token: token ?? null })).status).toBe(200);
    await fetchApp("/api/auth/sign-out", { token: token ?? null, json: {} });
    expect((await rpcRaw("listProjects", {}, { token: token ?? null })).status, "a signed-out token").toBe(
      401,
    );
  });

  test("AT-23 a denied device code ends with access_denied", async () => {
    const code = await requestDeviceCode();
    await decideWithBearer(code, "deny");
    const denied = await pollUntilDecided(code);
    expect(denied.status).toBe(400);
    expect((denied.json as { error?: string }).error).toBe("access_denied");
  });

  for (const decision of ["Approve", "Deny"] as const) {
    test(`AT-23 (browser) /device shows the app's code; ${decision} ${decision === "Approve" ? "signs the app in" : "denies it"}`, async ({
      page,
    }) => {
      requireUi();
      const code = await requestDeviceCode();
      await page.goto(new URL(code.verification_uri_complete, appUrl("/")).toString());
      await expect
        .poll(async () => normalize(await page.locator("body").innerText()))
        .toContain(normalize(code.user_code));
      await page.getByRole("button", { name: decision, exact: true }).click();
      const r = await pollUntilDecided(code);
      if (decision === "Approve") {
        const token = (r.json as { access_token?: string }).access_token ?? null;
        expect(token).toBeTruthy();
        expect((await rpcRaw("listProjects", {}, { token })).status).toBe(200);
        await fetchApp("/api/auth/sign-out", { token, json: {} });
      } else {
        expect((r.json as { error?: string }).error).toBe("access_denied");
      }
    });
  }

  // Manual: the Mac app itself (shows the code, opens the browser, shows
  // "Sign-in was denied or timed out.") is part of the Mac gate checklist (07, Testing).
  test.fixme("AT-23 the Mac app shows the same code as /device and the denied message", async () => {});
});

test.describe("AT-24 /api/v1 auth", () => {
  test("AT-24 /api/v1/rpc accepts a bearer token and refuses requests without one", async () => {
    expect((await rpcRaw("listProjects", {})).status).toBe(200);
    const none = await rpcRaw("listProjects", {}, { token: null });
    expect(none.status).toBe(401);
    expect(none.json).toMatchObject({ code: "UNAUTHENTICATED" });
    expect((await rpcRaw("listProjects", {}, { token: "not-a-session-token" })).status).toBe(401);
    const unknown = await rpcRaw("noSuchFunction", {});
    expect(unknown.status).not.toBe(200);
    expect(unknown.json).toMatchObject({ code: "NOT_FOUND" });
    const invalid = await rpcRaw("getWorkspace", { workspaceId: 42 });
    expect(invalid.status).not.toBe(200);
    expect(invalid.json).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  test("AT-24 a cookie-only request to /api/v1/rpc gets 401, although the cookie is a valid session", async () => {
    requireUi();
    const cookie = storageStateCookie();
    test.skip(!cookie, "the storage state holds no cookie for the app host");
    const session = await fetchApp("/api/auth/get-session", {
      token: null,
      headers: { Cookie: cookie ?? "" },
    });
    expect((session.json as { user?: unknown } | null)?.user, "the cookie is a live session").toBeTruthy();
    const r = await rpcRaw(
      "listProjects",
      {},
      { token: null, headers: { Cookie: cookie ?? "", Origin: E2E.url } },
    );
    expect(r.status).toBe(401);
    expect(r.json).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  test("AT-24 the attachments route accepts a bearer token", async () => {
    const { summary } = await newWorkspace();
    const ok = await uploadAttachment(summary.id, "e2e.txt", "hello from e2e\n");
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json).toMatchObject({ name: "e2e.txt", mime: "text/plain", size: 15 });
    expect((ok.json as { attachmentId?: string }).attachmentId).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/);
    expect((await uploadAttachment(summary.id, "e2e.txt", "x", "text/plain", { token: null })).status).toBe(
      401,
    );
  });
});

test("AT-25 all three channels accept a bearer upgrade with no Origin; a wrong Origin gets 403", async () => {
  await requireChannels();
  const { summary } = await newWorkspace();
  const paths = {
    hub: "/api/ws/hub",
    workspace: `/api/ws/workspace/${summary.id}?sinceRev=0`,
    terminal: `/api/ws/terminal/${summary.id}/t1?cols=80&rows=24`,
  };
  const cookie = storageStateCookie();
  for (const [name, path] of Object.entries(paths)) {
    expect(await upgradeStatus(path, bearer()), `${name}: bearer, no Origin`).toBe(101);
    expect(
      await upgradeStatus(path, { ...bearer(), Origin: "https://evil.example" }),
      `${name}: bearer, wrong Origin`,
    ).toBe(403);
    if (cookie) {
      expect(
        await upgradeStatus(path, { Cookie: cookie, Origin: "https://evil.example" }),
        `${name}: cookie, wrong Origin`,
      ).toBe(403);
      expect(
        await upgradeStatus(path, { Cookie: cookie, Origin: E2E.url }),
        `${name}: cookie, app Origin`,
      ).toBe(101);
    }
  }

  const hub = await Socket.open(paths.hub);
  const hello = await hub.until(
    "hub hello",
    () => hub.messages.find((m) => (m.data as { type?: string }).type === "hello"),
    30_000,
  );
  expect(hello.data).toMatchObject({ type: "hello", v: 1 });
  hub.close();
  const ws = await Socket.open(paths.workspace);
  const wsHello = await ws.until(
    "workspace hello",
    () => ws.messages.find((m) => (m.data as { type?: string }).type === "hello"),
    30_000,
  );
  expect(wsHello.data).toMatchObject({ type: "hello", v: 1, workspace: { id: summary.id } });
  ws.close();
});
