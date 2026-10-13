import { Files } from "@cloudflare/sandbox";
import { and, desc, eq, gt, lte } from "drizzle-orm";
import {
  TempoError,
  artifactR2Key,
  randomToken,
  type Artifact,
  type ArtifactKind,
  type TempodEventOf,
} from "@tempo/protocol";
import { artifactCodes, artifacts, type ArtifactRow } from "../../db/workspace-do.ts";
import { previewNotFound } from "../../http/preview.ts";
import { base64UrlToBytes, hmacSha256Base64Url, sha256Hex, timingSafeEqual } from "../../lib/crypto.ts";
import { errorText, log } from "../../log.ts";
import { containerRunning } from "./container.ts";
import type { WorkspaceCore } from "./core.ts";
import { PREVIEW_CODE, PREVIEW_CODE_MS, PREVIEW_COOKIE_SECONDS } from "./preview.ts";
import { backoffMs } from "./runner.ts";

/** 01 Artifacts, Upload: at most 2 at a time, 5 attempts each. */
export const UPLOADS_AT_ONCE = 2;
export const UPLOAD_ATTEMPTS = 5;
const COOKIE_VALUE = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

export const artifactToWire = (r: ArtifactRow): Artifact => ({
  id: r.id,
  version: r.version,
  sessionId: r.sessionId,
  turnId: r.turnId,
  itemId: r.itemId,
  path: r.path,
  name: r.name,
  title: r.title,
  summary: r.summary,
  mime: r.mime,
  kind: r.kind,
  size: r.sizeBytes,
  sha256: r.sha256,
  status: r.status,
  createdAt: r.createdAt,
});

export const artifactRow = (core: WorkspaceCore, id: string, version: number): ArtifactRow | null =>
  core.db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, id), eq(artifacts.version, version)))
    .get() ?? null;

/** 02 listArtifacts: every version, newest first. */
export const listArtifacts = (core: WorkspaceCore): Artifact[] => {
  core.ws();
  return core.db
    .select()
    .from(artifacts)
    .orderBy(desc(artifacts.createdAt), desc(artifacts.version))
    .all()
    .map(artifactToWire);
};

// ---------- upload (01, Artifacts, Upload) ----------

interface Uploads {
  readonly queue: string[];
  readonly running: Map<string, Promise<void>>;
}

const uploadState = new WeakMap<WorkspaceCore, Uploads>();
const uploadsOf = (core: WorkspaceCore): Uploads => {
  let u = uploadState.get(core);
  if (!u) {
    u = { queue: [], running: new Map() };
    uploadState.set(core, u);
  }
  return u;
};
const keyOf = (id: string, version: number) => `${id}/${version}`;
const parseKey = (key: string): [string, number] => {
  const slash = key.lastIndexOf("/");
  return [key.slice(0, slash), Number(key.slice(slash + 1))];
};

/** Upload step 1: the row and its `pending` item, in one transaction. */
export const onArtifactPublished = (core: WorkspaceCore, e: TempodEventOf<"artifact.published">): void => {
  core.ctx.storage.transactionSync(() => {
    if (artifactRow(core, e.artifactId, e.version)) return;
    const item = core.insertItem({
      sessionId: e.sessionId,
      turnId: e.turnId,
      kind: "artifact",
      status: "pending",
      content: {
        artifactId: e.artifactId,
        version: e.version,
        title: e.title,
        ...(e.summary !== undefined ? { summary: e.summary } : {}),
        name: e.name,
        path: e.path,
        mime: e.mime,
        artifactKind: e.artifactKind,
        size: e.size,
      },
    });
    core.db
      .insert(artifacts)
      .values({
        id: e.artifactId,
        version: e.version,
        sessionId: e.sessionId,
        turnId: e.turnId,
        itemId: item.id,
        path: e.path,
        name: e.name,
        title: e.title,
        summary: e.summary ?? null,
        mime: e.mime,
        kind: e.artifactKind,
        sizeBytes: e.size,
        sha256: e.sha256,
        stagedPath: e.stagedPath,
        status: "uploading",
        attempt: 0,
        r2Key: artifactR2Key(core.workspaceId, e.artifactId, e.version, e.name),
        createdAt: Date.now(),
      })
      .run();
  });
  scheduleArtifactUpload(core, e.artifactId, e.version);
};

/** Steps 2 and 3 for one version. Idempotent: an R2 object with the same sha256 is not written again. */
export const uploadArtifact = async (core: WorkspaceCore, id: string, version: number): Promise<void> => {
  const row = artifactRow(core, id, version);
  if (!row || row.status !== "uploading") return;
  const head = await core.env.DATA.head(row.r2Key);
  if (head?.customMetadata?.["sha256"] !== row.sha256) {
    if (!containerRunning(core)) throw new TempoError("CONTAINER_NOT_READY");
    const res = await new Files(core.container!).readFile(row.stagedPath);
    if (!res.body) throw new TempoError("INTERNAL", undefined, "empty artifact");
    await core.env.DATA.put(row.r2Key, res.body.pipeThrough(new FixedLengthStream(row.sizeBytes)), {
      httpMetadata: { contentType: row.mime },
      customMetadata: { sha256: row.sha256 },
    });
  }
  core.db
    .update(artifacts)
    .set({ status: "ready" })
    .where(and(eq(artifacts.id, id), eq(artifacts.version, version)))
    .run();
  core.updateItem(row.itemId, { status: "completed" });
  try {
    await core.tempod?.request("artifact.release", { artifactId: id, version });
  } catch (e) {
    log("warn", "artifact release failed", { workspaceId: core.workspaceId, error: errorText(e) });
  }
};

const runJob = async (core: WorkspaceCore, key: string): Promise<void> => {
  const [id, version] = parseKey(key);
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    core.db
      .update(artifacts)
      .set({ attempt })
      .where(and(eq(artifacts.id, id), eq(artifacts.version, version)))
      .run();
    try {
      await uploadArtifact(core, id, version);
      return;
    } catch (e) {
      log("warn", "artifact upload failed", { workspaceId: core.workspaceId, attempt, error: errorText(e) });
      if (!containerRunning(core) || attempt === UPLOAD_ATTEMPTS) return;
      await new Promise((r) => setTimeout(r, backoffMs(attempt)));
    }
  }
};

const pump = (core: WorkspaceCore): void => {
  const u = uploadsOf(core);
  while (u.running.size < UPLOADS_AT_ONCE && u.queue.length > 0) {
    const key = u.queue.shift()!;
    if (u.running.has(key)) continue;
    const job = runJob(core, key).finally(() => {
      u.running.delete(key);
      pump(core);
    });
    u.running.set(key, job);
    core.ctx.waitUntil(job);
  }
};

export const scheduleArtifactUpload = (core: WorkspaceCore, id: string, version: number): void => {
  const u = uploadsOf(core);
  const key = keyOf(id, version);
  if (!u.running.has(key) && !u.queue.includes(key)) u.queue.push(key);
  pump(core);
};

const uploadingRows = (core: WorkspaceCore): ArtifactRow[] =>
  core.db.select().from(artifacts).where(eq(artifacts.status, "uploading")).all();

/**
 * Step `artifacts.upload` (03) and SIGTERM: waits for running uploads, then uploads every row still
 * `uploading`, 2 at a time. The first failure is thrown so the step retries.
 */
export const uploadAllArtifacts = async (core: WorkspaceCore): Promise<void> => {
  const u = uploadsOf(core);
  u.queue.length = 0;
  await Promise.all(u.running.values());
  const keys = uploadingRows(core).map((r) => keyOf(r.id, r.version));
  let failure: unknown = null;
  const worker = async () => {
    for (let key = keys.shift(); key !== undefined; key = keys.shift()) {
      try {
        await uploadArtifact(core, ...parseKey(key));
      } catch (e) {
        failure ??= e;
      }
    }
  };
  await Promise.all(Array.from({ length: UPLOADS_AT_ONCE }, worker));
  if (failure) throw failure;
};

/** Step `artifacts.resume` (03): a fresh disk lost the staged copies; else retry each upload. */
export const resumeArtifacts = (core: WorkspaceCore, freshDisk: boolean): void => {
  for (const row of uploadingRows(core)) {
    if (freshDisk) {
      core.db
        .update(artifacts)
        .set({ status: "lost" })
        .where(and(eq(artifacts.id, row.id), eq(artifacts.version, row.version)))
        .run();
      core.updateItem(row.itemId, { status: "failed" });
    } else scheduleArtifactUpload(core, row.id, row.version);
  }
};

// ---------- artifact host (05, Artifact access) ----------

export const artifactHost = (core: WorkspaceCore, artifactId: string): string =>
  `a-${artifactId}-${core.workspaceId}.${core.env.PREVIEW_DOMAIN}`;

/** 02 openArtifact: a one-time entry link bound to one version. */
export const openArtifact = async (
  core: WorkspaceCore,
  artifactId: string,
  version: number,
): Promise<{ url: string }> => {
  core.ws();
  const row = artifactRow(core, artifactId, version);
  if (!row || row.status === "lost") throw new TempoError("NOT_FOUND");
  if (row.status === "uploading") throw new TempoError("ARTIFACT_NOT_READY");
  const code = randomToken(32);
  const now = Date.now();
  core.db.delete(artifactCodes).where(lte(artifactCodes.expiresAt, now)).run();
  core.db
    .insert(artifactCodes)
    .values({ codeHash: await sha256Hex(code), artifactId, version, expiresAt: now + PREVIEW_CODE_MS })
    .run();
  return { url: `https://${artifactHost(core, artifactId)}/__tempo/enter?code=${code}` };
};

const artifactMac = async (key: string, artifactId: string, expiresAt: number): Promise<string | null> => {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = base64UrlToBytes(key);
  } catch {
    return null;
  }
  if (raw.length === 0) return null;
  return hmacSha256Base64Url(raw, `a.${artifactId}.${expiresAt}`);
};

export const artifactCookie = async (
  key: string,
  artifactId: string,
  now = Date.now(),
): Promise<string | null> => {
  const expiresAt = Math.floor(now / 1000) + PREVIEW_COOKIE_SECONDS;
  const mac = await artifactMac(key, artifactId, expiresAt);
  return mac === null ? null : `${expiresAt}.${mac}`;
};

export const verifyArtifactCookie = async (
  key: string,
  artifactId: string,
  value: string,
  now = Date.now(),
): Promise<boolean> => {
  const m = COOKIE_VALUE.exec(value);
  if (!m) return false;
  const expiresAt = Number(m[1]);
  if (expiresAt * 1000 <= now) return false;
  const expected = await artifactMac(key, artifactId, expiresAt);
  return expected !== null && timingSafeEqual(m[2]!, expected);
};

/**
 * 05 Enter: a good code is deleted; returns the cookie value and the path of the version the code
 * is bound to, to redirect to.
 */
export const artifactEnter = async (
  core: WorkspaceCore,
  artifactId: string,
  code: string,
): Promise<{ cookie: string; location: string } | null> => {
  const row = core.wsOrNull();
  if (!row || !PREVIEW_CODE.test(code)) return null;
  const now = Date.now();
  const used = core.db
    .delete(artifactCodes)
    .where(
      and(
        eq(artifactCodes.codeHash, await sha256Hex(code)),
        eq(artifactCodes.artifactId, artifactId),
        gt(artifactCodes.expiresAt, now),
      ),
    )
    .returning()
    .get();
  const art = used ? artifactRow(core, artifactId, used.version) : null;
  if (!used || !art || art.status !== "ready") return null;
  const cookie = await artifactCookie(row.previewKey, artifactId, now);
  return cookie ? { cookie, location: `/${art.version}/${encodeURIComponent(art.name)}` } : null;
};

export const artifactCsp = (kind: ArtifactKind, appHost: string): string => {
  const ancestors = `frame-ancestors https://${appHost}`;
  if (kind === "html")
    return `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob:; style-src 'unsafe-inline' data: blob:; img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; ${ancestors}; sandbox allow-scripts allow-forms allow-modals allow-downloads`;
  if (kind === "pdf") return `default-src 'none'; ${ancestors}`;
  return `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; ${ancestors}; sandbox`;
};

const contentTypeOf = (row: ArtifactRow): string =>
  row.kind === "html" ? "text/html; charset=utf-8" : row.kind === "pdf" ? "application/pdf" : row.mime;

const PATH = /^\/(\d{1,9})\/([^/]+)$/;

/** 05 Requests: `GET /<version>/<name>` with a good cookie streams that version from R2. */
export const artifactFetch = async (
  core: WorkspaceCore,
  request: Request,
  artifactId: string,
  cookie: string,
): Promise<Response> => {
  const ws = core.wsOrNull();
  if (!ws || request.method !== "GET") return previewNotFound();
  if (!(await verifyArtifactCookie(ws.previewKey, artifactId, cookie))) return previewNotFound();
  const m = PATH.exec(new URL(request.url).pathname);
  if (!m) return previewNotFound();
  let name: string;
  try {
    name = decodeURIComponent(m[2]!);
  } catch {
    return previewNotFound();
  }
  const row = artifactRow(core, artifactId, Number(m[1]));
  if (!row || row.status !== "ready" || row.name !== name) return previewNotFound();
  const object = await core.env.DATA.get(row.r2Key);
  if (!object) return previewNotFound();
  return new Response(object.body, {
    headers: {
      "Content-Type": contentTypeOf(row),
      "Content-Length": String(object.size),
      "Content-Security-Policy": artifactCsp(row.kind, core.env.APP_HOST),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  });
};
