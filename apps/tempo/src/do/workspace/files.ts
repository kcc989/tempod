import { asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import { TempoError, type FnOutput } from "@tempo/protocol";
import { json } from "../../db/json.ts";
import { fileCache } from "../../db/workspace-do.ts";
import type { WorkspaceCore } from "./core.ts";

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 1_000;
const SYNC_MS = 10_000;
const encoder = new TextEncoder();

const cachePath = (path: string): string => {
  const relative = path.startsWith("/workspace/") ? path.slice(11) : path;
  if (relative.startsWith("/") || relative.includes("\0") || relative.split("/").includes(".."))
    throw new TempoError("PATH_OUTSIDE_WORKSPACE");
  return relative
    .split("/")
    .filter((p) => p && p !== ".")
    .join("/");
};

/** Read-only fallback; the container remains the source of truth. */
export class WorkspaceFiles {
  private syncing: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly changed = new Set<string>();

  constructor(private readonly core: WorkspaceCore) {}

  list(): FnOutput<"listFiles"> {
    if (this.core.kv<number>("filesSyncedAt") === undefined) throw new TempoError("CONTAINER_NOT_READY");
    return {
      paths: this.core.db
        .select({ path: fileCache.path })
        .from(fileCache)
        .orderBy(asc(fileCache.path))
        .all()
        .map((r) => r.path),
    };
  }

  read(path: string): FnOutput<"readFile"> {
    const row = this.core.db
      .select()
      .from(fileCache)
      .where(eq(fileCache.path, cachePath(path)))
      .get();
    const response = json.fileResponse.read(row?.responseJson, null);
    if (!response) throw new TempoError("CONTAINER_NOT_READY");
    return response;
  }

  rememberList(paths: ReadonlyArray<string>): void {
    const next = new Set(paths);
    this.core.ctx.storage.transactionSync(() => {
      for (const row of this.core.db.select({ path: fileCache.path }).from(fileCache).all()) {
        if (!next.has(row.path)) this.core.db.delete(fileCache).where(eq(fileCache.path, row.path)).run();
        else next.delete(row.path);
      }
      for (const path of next) this.core.db.insert(fileCache).values({ path }).run();
      this.core.setKv("filesSyncedAt", Date.now());
    });
  }

  rememberFile(path: string, response: FnOutput<"readFile">): void {
    const key = cachePath(path);
    // Only persist files in fs.list: ignored files and paths outside the repo stay out of the cache.
    if (!this.core.db.select({ path: fileCache.path }).from(fileCache).where(eq(fileCache.path, key)).get())
      return;
    const responseJson = json.fileResponse.tryWrite(response);
    if (responseJson === null) return this.forgetFile(path);
    const bytes = encoder.encode(responseJson).byteLength;
    if (bytes > 1024 * 1024) return;
    this.core.ctx.storage.transactionSync(() => {
      this.core.db
        .update(fileCache)
        .set({ responseJson, bytes, updatedAt: Date.now() })
        .where(eq(fileCache.path, key))
        .run();
      const rows = this.core.db
        .select({ path: fileCache.path, bytes: fileCache.bytes })
        .from(fileCache)
        .where(isNotNull(fileCache.responseJson))
        .orderBy(desc(fileCache.updatedAt))
        .all();
      let total = 0;
      let count = 0;
      for (const row of rows) {
        total += row.bytes;
        count++;
        if (total > MAX_BYTES || count > MAX_FILES) this.forgetFile(row.path);
      }
    });
  }

  forgetFile(path: string): void {
    this.core.db
      .update(fileCache)
      .set({ responseJson: null, bytes: 0, updatedAt: 0 })
      .where(eq(fileCache.path, cachePath(path)))
      .run();
  }

  requestSync(paths: ReadonlyArray<string> = []): void {
    for (const path of paths) this.changed.add(path);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.core.state === "ready" || this.core.state === "working") this.core.ctx.waitUntil(this.sync());
    }, 5_000);
  }

  async sync(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // A final pre-sleep sync must observe changes made during the earlier pass.
    const run = (this.syncing ?? Promise.resolve()).then(() => this.refresh());
    this.syncing = run;
    try {
      await run;
    } finally {
      if (this.syncing === run) this.syncing = null;
    }
  }

  private async refresh(): Promise<void> {
    const client = this.core.tempod;
    if (!client?.open) return;
    const deadline = Date.now() + SYNC_MS;
    try {
      const { paths } = await client.request("fs.list", {}, { timeoutMs: SYNC_MS });
      this.rememberList(paths);
      const changed = new Set(this.changed);
      this.changed.clear();
      const candidates = this.core.db
        .select({ path: fileCache.path })
        .from(fileCache)
        .orderBy(desc(sql`${fileCache.responseJson} IS NOT NULL`), asc(fileCache.path))
        .all()
        .sort((a, b) => Number(changed.has(b.path)) - Number(changed.has(a.path)))
        .slice(0, MAX_FILES);
      for (let i = 0; i < candidates.length && Date.now() < deadline && client.open; i += 4) {
        await Promise.all(
          candidates.slice(i, i + 4).map(async ({ path }) => {
            try {
              const response = await client.request(
                "fs.read",
                { path, maxBytes: 1024 * 1024 },
                { timeoutMs: Math.max(1, Math.min(2_000, deadline - Date.now())) },
              );
              this.rememberFile(path, response);
            } catch {
              this.forgetFile(path);
            }
          }),
        );
      }
    } catch {
      // Sync is best effort; an unavailable container must not block work or sleep.
    }
  }
}
