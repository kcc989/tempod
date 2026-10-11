import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { join } from "node:path";
import type { Logger } from "./log.ts";

export const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** Codex `auth.json` sync (01, Credentials and egress). The content is a secret: never log it. */
export class CodexCredentials {
  private lastHash: string | null = null;
  private watcher: FSWatcher | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private pending: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly opts: {
      codexHome: string;
      log: Logger;
      onChanged: (content: string, lastRefresh: number) => void;
      pollMs?: number;
    },
  ) {}

  get path(): string {
    return join(this.opts.codexHome, "auth.json");
  }

  private readCurrent(): string | null {
    try {
      return readFileSync(this.path, "utf8");
    } catch {
      return null;
    }
  }

  put(content: string): void {
    mkdirSync(this.opts.codexHome, { recursive: true, mode: 0o700 });
    const tmp = join(this.opts.codexHome, `.auth.json.${randomBytes(6).toString("hex")}.tmp`);
    try {
      writeFileSync(tmp, content, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      this.lastHash = sha256(content);
      renameSync(tmp, this.path);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }

  start(): void {
    if (this.watcher || this.poll) return;
    const current = this.readCurrent();
    if (this.lastHash === null && current !== null) this.lastHash = sha256(current);
    try {
      mkdirSync(this.opts.codexHome, { recursive: true, mode: 0o700 });
      this.watcher = watch(this.opts.codexHome, { persistent: false }, (_event, name) => {
        if (name === null || name === "auth.json") this.schedule();
      });
      (this.watcher as unknown as NodeJS.EventEmitter).on("error", () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch (e) {
      this.opts.log.warn("cannot watch CODEX_HOME; polling only", { error: String(e) });
    }
    this.poll = setInterval(() => this.check(), this.opts.pollMs ?? 10_000);
  }

  private schedule(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => {
      this.pending = null;
      this.check();
    }, 100);
  }

  check(): void {
    const content = this.readCurrent();
    if (content === null) return;
    const hash = sha256(content);
    if (hash === this.lastHash) return;
    let lastRefresh = NaN;
    try {
      const parsed = JSON.parse(content) as { last_refresh?: unknown };
      if (typeof parsed.last_refresh === "string") lastRefresh = Date.parse(parsed.last_refresh);
    } catch {
      // Codex may be mid-write; the next event or poll retries.
      return;
    }
    this.lastHash = hash;
    if (!Number.isFinite(lastRefresh)) {
      this.opts.log.warn("codex auth.json changed without a valid last_refresh; not synced");
      return;
    }
    this.opts.onChanged(content, lastRefresh);
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
  }
}
