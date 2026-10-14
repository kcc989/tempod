import { Predicate } from "effect";
import { type WorkspaceStub } from "../../src/do/workspace/stub.ts";
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { WORKSPACE_MIGRATIONS } from "../../src/db/do-migrations.ts";
import { previewCookie } from "../../src/do/workspace/preview.ts";
import type { WorkspaceDO } from "../../src/do/workspace/index.ts";
import { handlePreview } from "../../src/http/preview.ts";
import { seedCredentials, seedProject, seedWorkspace, waitFor } from "./fakes.ts";

/**
 * Owner-only previews end to end through the Worker: 05 (Preview access), 01 (Preview URL,
 * Preview request path), 02 (openPreview, rotatePreviewKey, preview_codes), 03 (init step 1).
 */

type Stub = WorkspaceStub;

type Row = Record<string, SqlStorageValue>;

type Res<T = import("@tempo/protocol").JsonData> = import("@tempo/protocol").Result<T>;

const PAGE = "This preview opens only from Tempo.";

const KEY = /^[A-Za-z0-9_-]{43}$/;

const COOKIE =
  /^__Host-tempo_preview=(\d+\.[A-Za-z0-9_-]{43}); Path=\/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=86400$/;

const ok = <T>(r: Res<T>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);

  return r.value;
};

const codeOf = <T>(r: Res<T>): string => (r.ok ? "OK" : r.error.code);

const rows = (stub: Stub, query: string, ...binds: Array<string | number | null>): Promise<Row[]> =>
  runInDurableObject(stub, (_i: WorkspaceDO, state: DurableObjectState) =>
    state.storage.sql.exec(query, ...binds).toArray(),
  );

const keyOf = async (stub: Stub): Promise<string> =>
  String((await rows(stub, "SELECT preview_key FROM workspace WHERE id = 1"))[0]!["preview_key"]);

const readyWs = async () => {
  const seeded = await seedProject();
  await seedCredentials(seeded.userId);
  const w = await seedWorkspace(seeded);
  const deadline = Date.now() + 20_000;

  while (!["ready", "working"].includes(ok(await w.stub.getWorkspace({})).state)) {
    if (Date.now() > deadline) throw new Error("timed out driving to ready");
    await runDurableObjectAlarm(w.stub);
    await new Promise((r) => setTimeout(r, 25));
  }

  await rows(w.stub, "INSERT INTO ports (port, first_seen_at) VALUES (3000, 0), (5173, 0)");

  return w;
};

type Ws = Awaited<ReturnType<typeof readyWs>>;

const send = (url: string, init: RequestInit = {}) => {
  const request = new Request(url, init);

  return handlePreview(request, env, new URL(request.url));
};

const host = (w: Ws, port = 3000) => `https://${port}-${w.workspaceId}.previews.test`;

const isPreview404 = async (res: Response, label = "") => {
  expect(res.status, label).toBe(404);
  expect(await res.text(), label).toContain(PAGE);
  expect(res.headers.get("Referrer-Policy"), label).toBe("no-referrer");
  expect(res.headers.get("X-Robots-Tag"), label).toBe("noindex, nofollow");
};

const link = async (w: Ws, port = 3000): Promise<string> => ok(await w.stub.openPreview({ port })).url;

/** Follows an entry link and returns the cookie value it set. */
const enter = async (w: Ws, port = 3000): Promise<string> => {
  const res = await send(await link(w, port));
  expect(res.status).toBe(303);

  return COOKIE.exec(res.headers.get("Set-Cookie") ?? "")![1]!;
};

const withCookie = (value: string, extra = "") => ({
  Cookie: extra ? `${extra}; __Host-tempo_preview=${value}` : `__Host-tempo_preview=${value}`,
});

describe("WorkspaceDO.init (03 init 1)", { timeout: 30_000 }, () => {
  it("makes a 32-byte base64url preview_key per workspace and keeps it out of the detail", async () => {
    const seeded = await seedProject();
    const a = await seedWorkspace(seeded, { slug: "alpha" });
    const b = await seedWorkspace(seeded, { slug: "beta" });
    expect(await keyOf(a.stub)).toMatch(KEY);
    expect(await keyOf(a.stub)).not.toBe(await keyOf(b.stub));
    const d = ok(await a.stub.getWorkspace({}));
    expect(d).not.toHaveProperty("previewToken");
    expect(JSON.stringify(d)).not.toContain(await keyOf(a.stub));
    expect(await rows(a.stub, "SELECT preview_token FROM workspace")).toEqual([{ preview_token: "" }]);
  });
});

describe("DO migration 0003_preview_access", { timeout: 30_000 }, () => {
  it("gives an existing workspace a fresh preview_key, keeps preview_token and adds preview_codes", async () => {
    const migration = WORKSPACE_MIGRATIONS.find((m) => m.tag === "0003_preview_access")!;

    const migrate = (stub: Stub) =>
      runInDurableObject(stub, (_i: WorkspaceDO, state: DurableObjectState) => {
        const sql = state.storage.sql;
        sql.exec("DROP TABLE preview_codes");
        sql.exec("ALTER TABLE workspace DROP COLUMN preview_key");

        for (const st of migration.statements) sql.exec(Predicate.isFunction(st) ? st() : st);
      });

    const seeded = await seedProject();
    const a = await seedWorkspace(seeded, { slug: "alpha" });
    const b = await seedWorkspace(seeded, { slug: "beta" });
    await migrate(a.stub);
    await migrate(b.stub);
    expect(await keyOf(a.stub)).toMatch(KEY);
    expect(await keyOf(a.stub)).not.toBe(await keyOf(b.stub));
    const columns = (await rows(a.stub, "PRAGMA table_info(workspace)")).map((c) => c["name"]);
    expect(columns).toContain("preview_token");
    expect((await rows(a.stub, "PRAGMA table_info(preview_codes)")).map((c) => c["name"])).toEqual([
      "code_hash",
      "port",
      "expires_at",
    ]);
    expect(migration.when).toBeGreaterThan(
      WORKSPACE_MIGRATIONS.find((m) => m.tag === "0002_turn_usage")!.when,
    );
  });
});

describe("preview request path through the Worker (01, 05)", { timeout: 30_000 }, () => {
  it("lists bare preview URLs; the hostname holds no secret", async () => {
    const w = await readyWs();
    const d = ok(await w.stub.getWorkspace({}));
    expect(d.ports).toEqual([
      { port: 3000, url: host(w, 3000) },
      { port: 5173, url: host(w, 5173) },
    ]);
  });

  it("enter: a good code answers 303 to / with the preview cookie, then the app loads", async () => {
    const w = await readyWs();
    const url = await link(w);
    const res = await send(url);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toMatch(COOKIE);
    const value = COOKIE.exec(setCookie)![1]!;
    const expiresAt = Number(value.split(".")[0]);
    expect(Math.abs(expiresAt - (Math.floor(Date.now() / 1000) + 86_400))).toBeLessThanOrEqual(5);
    // 05: the code works once.
    expect(await rows(w.stub, "SELECT * FROM preview_codes")).toHaveLength(0);
    const page = await send(`${host(w)}/app?x=1`, { headers: withCookie(value) });
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("proxied /v1/proxy/3000/app?x=1");
    expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
    // The entry path never reaches the app.
    expect(w.tempod.proxyRequests.map((r) => r.path)).toEqual(["/v1/proxy/3000/app?x=1"]);
  });

  it("a used code returns the preview 404 page", async () => {
    const w = await readyWs();
    const url = await link(w);
    expect((await send(url)).status).toBe(303);
    await isPreview404(await send(url), "second use");
  });

  it("an expired code returns the preview 404 page, and old codes are deleted when a new one is made", async () => {
    const w = await readyWs();
    const url = await link(w);
    await rows(w.stub, "UPDATE preview_codes SET expires_at = ?", Date.now() - 1);
    await isPreview404(await send(url), "expired");
    await link(w);
    const left = await rows(w.stub, "SELECT expires_at FROM preview_codes");
    expect(left).toHaveLength(1);
    expect(left[0]!["expires_at"]).toBeGreaterThan(Date.now());
  });

  it("a code works for its own port only", async () => {
    const w = await readyWs();
    const url = new URL(await link(w, 3000));
    await isPreview404(await send(`${host(w, 5173)}${url.pathname}${url.search}`), "other port");
  });

  it("only GET /__tempo/enter enters; other /__tempo/ paths never reach the app", async () => {
    const w = await readyWs();
    const url = await link(w);
    await isPreview404(await send(url, { method: "POST" }), "POST enter");
    expect(await rows(w.stub, "SELECT * FROM preview_codes")).toHaveLength(1);
    const value = await enter(w);
    await isPreview404(await send(`${host(w)}/__tempo/other`, { headers: withCookie(value) }), "other path");
    expect(w.tempod.proxyRequests).toHaveLength(0);
  });

  it("a missing, bad, expired or other-port cookie returns the preview 404 page and reaches nothing", async () => {
    const w = await readyWs();
    const value = await enter(w);
    const [expiresAt, mac] = value.split(".");
    const flipped = `${expiresAt}.${mac!.startsWith("A") ? "B" : "A"}${mac!.slice(1)}`;
    const key = await keyOf(w.stub);
    const expired = (await previewCookie(key, 3000, Date.now() - 86_401_000))!;
    const otherPort = (await previewCookie(key, 5173))!;

    for (const [label, headers] of [
      ["missing", {}],
      ["other cookies only", { Cookie: "session=abc" }],
      ["bad MAC", withCookie(flipped)],
      ["later expiry, same MAC", withCookie(`${Number(expiresAt) + 1}.${mac}`)],
      ["expired", withCookie(expired)],
      ["other port", withCookie(otherPort)],
      ["garbage", withCookie("nope")],
    ] as const) {
      await isPreview404(await send(`${host(w)}/`, { headers }), label);
    }

    expect(w.tempod.proxyRequests).toHaveLength(0);
    expect((await send(`${host(w)}/`, { headers: withCookie(value) })).status).toBe(200);
  });

  it("removes the preview cookie before the request reaches the app and keeps the app's cookies", async () => {
    const w = await readyWs();
    const value = await enter(w);

    const res = await send(`${host(w)}/`, {
      headers: {
        Cookie: `app=1; __Host-tempo_preview=${value}; theme=dark`,
        Authorization: "Basic dXNlcjpwYXNz",
        "x-tempo-preview": "1:forged",
      },
    });

    expect(res.status).toBe(200);
    const seen = w.tempod.proxyRequests[0]!.headers;
    expect(seen.get("Cookie")).toBe("app=1; theme=dark");
    expect(seen.get("x-tempo-preview")).toBeNull();
    expect(seen.get("Authorization")).toMatch(/^Bearer /);
    expect(seen.get("X-Forwarded-Host")).toBe(`3000-${w.workspaceId}.previews.test`);
    expect(seen.get("X-Forwarded-Proto")).toBe("https");
    const only = await send(`${host(w)}/x`, { headers: withCookie(value) });
    expect(only.status).toBe(200);
    expect(w.tempod.proxyRequests[1]!.headers.get("Cookie")).toBeNull();

    for (const r of w.tempod.proxyRequests) expect([...r.headers.values()].join("\n")).not.toContain(value);
  });

  it("keeps WebSocket upgrades working with the cookie, and refuses them without it", async () => {
    const w = await readyWs();
    const value = await enter(w);
    await isPreview404(await send(`${host(w)}/hmr`, { headers: { Upgrade: "websocket" } }), "no cookie");

    const res = await send(`${host(w)}/hmr`, {
      headers: { Upgrade: "websocket", ...withCookie(value, "a=1") },
    });

    expect(res.status).toBe(101);
    const socket = res.webSocket!;
    socket.accept();
    await waitFor(() => w.tempod.proxySockets.length === 1, 3000, "proxied socket");
    const upgrade = w.tempod.proxyRequests.at(-1)!;
    expect(upgrade.path).toBe("/v1/proxy/3000/hmr");
    expect(upgrade.headers.get("Cookie")).toBe("a=1");
    socket.close(1000, "done");
  });

  it("rotatePreviewKey stops every preview cookie at once, closes open sockets and drops unused codes", async () => {
    const w = await readyWs();
    const before = await keyOf(w.stub);
    const value = await enter(w);
    const pending = await link(w);
    const res = await send(`${host(w)}/hmr`, { headers: { Upgrade: "websocket", ...withCookie(value) } });
    const socket = res.webSocket!;
    let closed: number | null = null;
    socket.addEventListener("close", (e) => {
      closed = e.code;
    });
    socket.accept();
    await waitFor(() => w.tempod.proxySockets.length === 1, 3000, "proxied socket");
    expect(ok(await w.stub.rotatePreviewKey({}))).toEqual({});
    expect(await keyOf(w.stub)).toMatch(KEY);
    expect(await keyOf(w.stub)).not.toBe(before);
    await waitFor(() => closed === 1008, 5000, "browser side closed");
    await waitFor(() => w.tempod.proxySockets[0]!.closed !== null, 5000, "tempod side closed");
    await isPreview404(await send(`${host(w)}/`, { headers: withCookie(value) }), "old cookie");
    await isPreview404(await send(pending), "code made before the reset");
    const fresh = await enter(w);
    expect((await send(`${host(w)}/`, { headers: withCookie(fresh) })).status).toBe(200);
  });

  it("openPreview refuses archived workspaces and ports that are not detected", async () => {
    const w = await readyWs();
    expect(codeOf(await w.stub.openPreview({ port: 8080 }))).toBe("NOT_FOUND");
    const value = await enter(w);
    await rows(w.stub, "UPDATE workspace SET state = 'archived' WHERE id = 1");
    expect(codeOf(await w.stub.openPreview({ port: 3000 }))).toBe("NOT_FOUND");
    await isPreview404(await send(`${host(w)}/`, { headers: withCookie(value) }), "archived");
  });
});
