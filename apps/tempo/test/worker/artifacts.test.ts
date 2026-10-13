import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { newId, type TempodEventOf } from "@tempo/protocol";
import { artifactCsp, resumeArtifacts } from "../../src/do/workspace/artifacts.ts";
import type { WorkspaceDO } from "../../src/do/workspace/index.ts";
import { handleArtifactHost, handleArtifactRead, parseArtifactHost } from "../../src/http/artifacts.ts";
import {
  emitEvent,
  internals,
  seedCredentials,
  seedProject,
  sqlRows,
  seedWorkspace,
  waitApplied,
  waitFor,
} from "./fakes.ts";

/** Artifacts in the WorkspaceDO and the Worker: 01 (Artifacts), 02 (artifact route, listArtifacts,
 * openArtifact, readFileAt), 03 (artifacts.upload, artifacts.resume), 05 (Artifact access). */

type Res = { readonly ok: boolean };
const ok = (r: Res): any => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return (r as unknown as { value: unknown }).value;
};
const codeOf = (r: Res): string => (r.ok ? "OK" : (r as unknown as { error: { code: string } }).error.code);

const APP_ORIGIN = "https://tempo.test";
const PAGE = "This preview opens only from Tempo.";
const COOKIE =
  /^__Host-tempo_artifact=(\d+\.[A-Za-z0-9_-]{43}); Path=\/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=86400$/;

const signIn = async (userId: string): Promise<string> => {
  const token = newId() + newId();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(newId(), now + 86_400_000, token, now, now, userId)
    .run();
  return token;
};

const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const readyWs = async () => {
  const seeded = await seedProject();
  await seedCredentials(seeded.userId);
  const w = await seedWorkspace(seeded);
  w.tempod.on("artifact.release", () => ({}));
  const deadline = Date.now() + 20_000;
  while (!["ready", "working"].includes(ok(await w.stub.getWorkspace({})).state)) {
    if (Date.now() > deadline) throw new Error("timed out driving to ready");
    await runDurableObjectAlarm(w.stub);
    await new Promise((r) => setTimeout(r, 25));
  }
  const sessionId = String((await sqlRows(w.stub, "SELECT id FROM sessions"))[0]!["id"]);
  return { ...w, seeded, sessionId };
};
type Ws = Awaited<ReturnType<typeof readyWs>>;

/** Publishes one version. With `stored`, the R2 object is already there, so the upload needs no Files. */
const publish = async (
  w: Ws,
  opts: {
    name?: string;
    kind?: "image" | "markdown" | "pdf" | "html" | "text";
    mime?: string;
    body?: string;
    version?: number;
    artifactId?: string;
    stored?: boolean;
  } = {},
): Promise<TempodEventOf<"artifact.published">> => {
  const body = opts.body ?? "# Plan\n";
  const artifactId = opts.artifactId ?? newId();
  const version = opts.version ?? 1;
  const name = opts.name ?? "plan.md";
  const event: TempodEventOf<"artifact.published"> = {
    kind: "artifact.published",
    sessionId: w.sessionId,
    turnId: null,
    artifactId,
    version,
    path: `/workspace/${name}`,
    name,
    title: "Plan",
    summary: "Steps",
    mime: opts.mime ?? "text/markdown",
    artifactKind: opts.kind ?? "markdown",
    size: new TextEncoder().encode(body).byteLength,
    sha256: await sha256(body),
    stagedPath: `/home/tempo/.tempod/artifacts/${artifactId}/${version}`,
  };
  if (opts.stored !== false)
    await env.DATA.put(`artifacts/${w.workspaceId}/${artifactId}/${version}/${name}`, body, {
      customMetadata: { sha256: event.sha256 },
    });
  await waitApplied(w.stub, await emitEvent(w.stub, w.tempod, event));
  return event;
};

const artifactRows = (w: Ws) => sqlRows(w.stub, "SELECT * FROM artifacts ORDER BY created_at, version");
const itemOf = async (w: Ws, id: string) =>
  (await sqlRows(w.stub, "SELECT * FROM items WHERE id = ?", id))[0]!;
const ready = (w: Ws, id: string, version = 1) =>
  waitFor(
    async () =>
      (await sqlRows(w.stub, "SELECT status FROM artifacts WHERE id = ? AND version = ?", id, version))[0]?.[
        "status"
      ] === "ready",
    5000,
    "artifact ready",
  );

describe("artifact.published (01, Artifacts, Upload)", { timeout: 60_000 }, () => {
  it("stores the row and a pending item, uploads, then marks ready and completed and releases the staged copy", async () => {
    const w = await readyWs();
    const e = await publish(w);
    await ready(w, e.artifactId);
    const [row] = await artifactRows(w);
    expect(row).toMatchObject({
      id: e.artifactId,
      version: 1,
      session_id: w.sessionId,
      name: "plan.md",
      kind: "markdown",
      status: "ready",
      r2_key: `artifacts/${w.workspaceId}/${e.artifactId}/1/plan.md`,
      staged_path: e.stagedPath,
    });
    const item = await itemOf(w, String(row!["item_id"]));
    expect(item["kind"]).toBe("artifact");
    expect(item["status"]).toBe("completed");
    expect(JSON.parse(String(item["content_json"]))).toEqual({
      artifactId: e.artifactId,
      version: 1,
      title: "Plan",
      summary: "Steps",
      name: "plan.md",
      path: "/workspace/plan.md",
      mime: "text/markdown",
      artifactKind: "markdown",
      size: 7,
    });
    await waitFor(() => w.tempod.requestsOf("artifact.release").length === 1, 5000, "release");
    expect(w.tempod.requestsOf("artifact.release")).toEqual([{ artifactId: e.artifactId, version: 1 }]);

    // The same event again (a resend) adds nothing.
    await waitApplied(w.stub, await emitEvent(w.stub, w.tempod, e));
    expect(await artifactRows(w)).toHaveLength(1);
  });

  it("artifacts.resume: a fresh disk makes uploading rows lost and items failed; otherwise they upload", async () => {
    const w = await readyWs();
    const lostOne = await publish(w, { stored: false });
    const keptOne = await publish(w, { stored: false });
    await env.DATA.put(`artifacts/${w.workspaceId}/${keptOne.artifactId}/1/plan.md`, "# Plan\n", {
      customMetadata: { sha256: keptOne.sha256 },
    });
    await runInDurableObject(w.stub, (i: WorkspaceDO, s: DurableObjectState) => {
      s.storage.sql.exec("UPDATE artifacts SET status = 'uploading'");
      resumeArtifacts(internals(i).core, false);
    });
    await ready(w, keptOne.artifactId);
    await runInDurableObject(w.stub, (i: WorkspaceDO) => resumeArtifacts(internals(i).core, true));
    const rows = await artifactRows(w);
    const lost = rows.find((r) => r["id"] === lostOne.artifactId)!;
    expect(lost["status"]).toBe("lost");
    expect((await itemOf(w, String(lost["item_id"])))["status"]).toBe("failed");
    expect(rows.find((r) => r["id"] === keptOne.artifactId)!["status"]).toBe("ready");
  });
});

describe("upload retries and the artifacts.upload step (01, 03)", { timeout: 60_000 }, () => {
  it("a failed upload is retried with backoff", async () => {
    const w = await readyWs();
    const e = await publish(w, { stored: false });
    await env.DATA.put(`artifacts/${w.workspaceId}/${e.artifactId}/1/plan.md`, "# Plan\n", {
      customMetadata: { sha256: e.sha256 },
    });
    await ready(w, e.artifactId);
    const [row] = await artifactRows(w);
    expect(Number(row!["attempt"])).toBeGreaterThanOrEqual(2);
  });

  it("sleep uploads every row still uploading before tempod.shutdown", async () => {
    const w = await readyWs();
    const e = await publish(w);
    await ready(w, e.artifactId);
    await runInDurableObject(w.stub, (_i: WorkspaceDO, s: DurableObjectState) => {
      s.storage.sql.exec("UPDATE artifacts SET status = 'uploading'");
    });
    const releases = w.tempod.requestsOf("artifact.release").length;
    ok(await w.stub.sleepWorkspace({}));
    const deadline = Date.now() + 20_000;
    while (ok(await w.stub.getWorkspace({})).state !== "sleeping") {
      if (Date.now() > deadline) throw new Error("timed out driving to sleeping");
      await runInDurableObject(w.stub, (_i: WorkspaceDO, s: DurableObjectState) => {
        s.storage.sql.exec("UPDATE ops SET next_run_at = 0 WHERE status IN ('pending', 'running')");
      });
      await runDurableObjectAlarm(w.stub);
      await new Promise((r) => setTimeout(r, 25));
    }
    expect((await artifactRows(w))[0]!["status"]).toBe("ready");
    const ops = w.tempod.requests.map((r) => r.op);
    expect(ops.lastIndexOf("artifact.release")).toBeLessThan(ops.indexOf("shutdown"));
    expect(w.tempod.requestsOf("artifact.release").length).toBe(releases + 1);
  });
});

describe("listArtifacts and openArtifact (02)", { timeout: 60_000 }, () => {
  it("lists every version newest first; opens only ready versions", async () => {
    const w = await readyWs();
    const v1 = await publish(w);
    const v2 = await publish(w, { artifactId: v1.artifactId, version: 2, body: "# Plan 2\n" });
    await ready(w, v1.artifactId, 2);
    const list = ok(await w.stub.listArtifacts({}));
    expect(list.map((a: { version: number }) => a.version)).toEqual([2, 1]);
    expect(list[0]).toMatchObject({ id: v1.artifactId, kind: "markdown", status: "ready", summary: "Steps" });

    const url = new URL(ok(await w.stub.openArtifact({ artifactId: v2.artifactId, version: 2 })).url);
    expect(url.hostname).toBe(`a-${v1.artifactId}-${w.workspaceId}.previews.test`);
    expect(url.pathname).toBe("/__tempo/enter");
    expect(url.searchParams.get("code")).toMatch(/^[a-z0-9]{32}$/);
    expect(codeOf(await w.stub.openArtifact({ artifactId: newId(), version: 1 }))).toBe("NOT_FOUND");

    const pending = await publish(w, { stored: false });
    await runInDurableObject(w.stub, (_i: WorkspaceDO, s: DurableObjectState) => {
      s.storage.sql.exec("UPDATE artifacts SET status = 'uploading' WHERE id = ?", pending.artifactId);
    });
    expect(codeOf(await w.stub.openArtifact({ artifactId: pending.artifactId, version: 1 }))).toBe(
      "ARTIFACT_NOT_READY",
    );
    await runInDurableObject(w.stub, (_i: WorkspaceDO, s: DurableObjectState) => {
      s.storage.sql.exec("UPDATE artifacts SET status = 'lost' WHERE id = ?", pending.artifactId);
    });
    expect(codeOf(await w.stub.openArtifact({ artifactId: pending.artifactId, version: 1 }))).toBe(
      "NOT_FOUND",
    );
  });

  it("readFileAt asks tempod for git.readFile with a 1 MiB limit", async () => {
    const w = await readyWs();
    w.tempod.on("git.readFile", () => ({ content: "aGk=", encoding: "base64", size: 2 }));
    expect(ok(await w.stub.readFileAt({ path: "logo.png", sha: "abc123" }))).toEqual({
      content: "aGk=",
      encoding: "base64",
      size: 2,
    });
    expect(w.tempod.requestsOf("git.readFile")).toEqual([
      { sha: "abc123", path: "logo.png", maxBytes: 1024 * 1024 },
    ]);
  });
});

describe("artifact host (05, Artifact access)", { timeout: 60_000 }, () => {
  const send = (url: string, init: RequestInit = {}) => {
    const request = new Request(url, init);
    const u = new URL(request.url);
    return handleArtifactHost(request, env, u, parseArtifactHost(u.hostname, env)!);
  };
  const is404 = async (res: Response, label = "") => {
    expect(res.status, label).toBe(404);
    expect(await res.text(), label).toContain(PAGE);
  };

  it("parses only the artifact label", () => {
    const a = newId();
    const w = newId();
    expect(parseArtifactHost(`a-${a}-${w}.previews.test`, env)).toEqual({ artifactId: a, workspaceId: w });
    expect(parseArtifactHost(`A-${a.toUpperCase()}-${w}.PREVIEWS.test`, env)).toEqual({
      artifactId: a,
      workspaceId: w,
    });
    expect(parseArtifactHost(`3000-${w}.previews.test`, env)).toBeNull();
    expect(parseArtifactHost(`a-${a}-${w}.other.test`, env)).toBeNull();
  });

  it("enters once with a code, serves the version with the CSP, and refuses everything else", async () => {
    const w = await readyWs();
    const body = "<!doctype html><script>fetch('https://x.test')</script>";
    const e = await publish(w, { name: "app page.html", kind: "html", mime: "text/html", body });
    await ready(w, e.artifactId);
    const link = ok(await w.stub.openArtifact({ artifactId: e.artifactId, version: 1 })).url;
    const host = `https://a-${e.artifactId}-${w.workspaceId}.previews.test`;

    const enter = await send(link);
    expect(enter.status).toBe(303);
    expect(enter.headers.get("Location")).toBe("/1/app%20page.html");
    const cookie = COOKIE.exec(enter.headers.get("Set-Cookie") ?? "")![1]!;
    await is404(await send(link), "a code works once");

    const res = await send(`${host}/1/app%20page.html`, {
      headers: { Cookie: `__Host-tempo_artifact=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Content-Security-Policy")).toBe(artifactCsp("html", "tempo.test"));
    expect(res.headers.get("Content-Security-Policy")).toContain("connect-src 'none'");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");

    const withCookie = { headers: { Cookie: `__Host-tempo_artifact=${cookie}` } };
    await is404(await send(`${host}/1/app%20page.html`), "no cookie");
    await is404(await send(`${host}/1/other.html`, withCookie), "wrong name");
    await is404(await send(`${host}/2/app%20page.html`, withCookie), "no such version");
    await is404(await send(`${host}/1/app%20page.html`, { ...withCookie, method: "POST" }), "POST");
    await is404(await send(`${host}/__tempo/other`, withCookie), "other tempo path");
    const otherArtifact = `https://a-${newId()}-${w.workspaceId}.previews.test/1/app%20page.html`;
    await is404(await send(otherArtifact, withCookie), "a cookie is bound to one artifact");

    ok(await w.stub.rotatePreviewKey({}));
    await is404(await send(`${host}/1/app%20page.html`, withCookie), "reset preview access");
  });

  it("pdf has no sandbox; other kinds use their mime and the strict CSP", () => {
    expect(artifactCsp("pdf", "tempo.test")).toBe("default-src 'none'; frame-ancestors https://tempo.test");
    expect(artifactCsp("image", "tempo.test")).toBe(
      "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors https://tempo.test; sandbox",
    );
  });
});

describe("artifact route (02)", { timeout: 60_000 }, () => {
  it("serves images, Markdown and text inline, HTML and PDF as downloads, and checks the owner", async () => {
    const w = await readyWs();
    const token = await signIn(w.seeded.userId);
    const md = await publish(w);
    const html = await publish(w, { name: "app.html", kind: "html", mime: "text/html", body: "<p>hi</p>" });
    await ready(w, md.artifactId);
    await ready(w, html.artifactId);
    const read = (
      id: string,
      version = 1,
      query = "",
      headers: HeadersInit = { Authorization: `Bearer ${token}` },
    ) => {
      const url = new URL(`${APP_ORIGIN}/api/workspaces/${w.workspaceId}/artifacts/${id}/${version}${query}`);
      return handleArtifactRead(new Request(url, { headers }), env, url, w.workspaceId, id, version);
    };

    const a = await read(md.artifactId);
    expect(a.status).toBe(200);
    expect(await a.text()).toBe("# Plan\n");
    expect(a.headers.get("Content-Type")).toBe("text/markdown");
    expect(a.headers.get("Content-Disposition")).toBe("inline");
    expect(a.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    expect(a.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await read(md.artifactId, 1, "?download=1")).headers.get("Content-Disposition")).toBe(
      "attachment; filename*=UTF-8''plan.md",
    );
    const h = await read(html.artifactId);
    expect(h.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(h.headers.get("Content-Disposition")).toBe("attachment; filename*=UTF-8''app.html");

    expect((await read(md.artifactId, 2)).status).toBe(404);
    expect((await read(newId())).status).toBe(404);
    expect((await read(md.artifactId, 1, "", {})).status).toBe(401);
    const other = await signIn((await seedProject()).userId);
    expect((await read(md.artifactId, 1, "", { Authorization: `Bearer ${other}` })).status).toBe(404);

    await runInDurableObject(w.stub, (_i: WorkspaceDO, s: DurableObjectState) => {
      s.storage.sql.exec("UPDATE artifacts SET status = 'uploading' WHERE id = ?", md.artifactId);
    });
    const notReady = await read(md.artifactId);
    expect(notReady.status).toBe(409);
    expect(((await notReady.json()) as { code: string }).code).toBe("ARTIFACT_NOT_READY");
  });
});
