import { mkdirSync, realpathSync, rmdirSync, rmSync, statSync } from "node:fs";
import { basename, isAbsolute, join, sep } from "node:path";
import {
  ARTIFACT_MAX_BYTES,
  ARTIFACT_MESSAGES,
  artifactTypeOf,
  newId,
  publishedText,
  type PublishArtifactRequest,
  type TempodEvent,
} from "@tempo/protocol";
import type { TempodDb } from "./db.ts";

export interface ArtifactDeps {
  readonly db: TempodDb;
  readonly workspace: string;
  readonly artifactsDir: string;
  readonly stageDir: string;
  readonly emit: (event: TempodEvent) => void;
  readonly runningTurnId: (sessionId: string) => string | null;
}

export type PublishAnswer = { readonly text: string } | { readonly error: string };

const ID = /^[0-9a-z]{26}$/;

const realOrNull = (p: string): string | null => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

const under = (root: string | null, p: string): boolean =>
  root !== null && p.startsWith(root.endsWith(sep) ? root : root + sep);

/** Publish and release (01, Artifacts). Publishes run one at a time, so versions never collide. */
export class Artifacts {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ArtifactDeps) {
    mkdirSync(deps.artifactsDir, { recursive: true });
  }

  stagedPath(artifactId: string, version: number): string {
    return join(this.deps.stageDir, artifactId, String(version));
  }

  publish(req: PublishArtifactRequest): Promise<PublishAnswer> {
    const next = this.chain.then(
      () => this.doPublish(req),
      () => this.doPublish(req),
    );

    this.chain = next.catch(() => undefined);

    return next;
  }

  private async doPublish(req: PublishArtifactRequest): Promise<PublishAnswer> {
    const { db } = this.deps;
    const path = isAbsolute(req.path) ? realOrNull(req.path) : null;
    const st = path ? statSync(path, { throwIfNoEntry: false }) : undefined;
    const roots = [realOrNull(this.deps.workspace), realOrNull(this.deps.artifactsDir)];

    if (!path || !st?.isFile() || !roots.some((r) => under(r, path)))
      return { error: ARTIFACT_MESSAGES.path };
    const name = basename(path);
    const type = artifactTypeOf(name);

    if (!type) return { error: ARTIFACT_MESSAGES.type };

    if (st.size > ARTIFACT_MAX_BYTES) return { error: ARTIFACT_MESSAGES.size };

    const row = db.db
      .query<{ artifact_id: string; last_version: number }, [string, string]>(
        "SELECT artifact_id, last_version FROM artifacts WHERE session_id = ? AND path = ?",
      )
      .get(req.sessionId, path);

    const artifactId = row?.artifact_id ?? newId();
    const version = (row?.last_version ?? 0) + 1;

    const staged = this.stagedPath(artifactId, version);
    mkdirSync(join(this.deps.stageDir, artifactId), { recursive: true });
    const hasher = new Bun.CryptoHasher("sha256");
    const writer = Bun.file(staged).writer();
    let size = 0;

    try {
      for await (const chunk of Bun.file(path).stream()) {
        size += chunk.byteLength;

        if (size > ARTIFACT_MAX_BYTES) throw new RangeError("too large");
        hasher.update(chunk);
        writer.write(chunk);
      }

      await writer.end();
    } catch (e) {
      await Promise.resolve(writer.end()).catch(() => undefined);
      rmSync(staged, { force: true });

      if (e instanceof RangeError) return { error: ARTIFACT_MESSAGES.size };

      return { error: ARTIFACT_MESSAGES.path };
    }

    db.db
      .query(
        `INSERT INTO artifacts (artifact_id, session_id, path, last_version) VALUES (?, ?, ?, ?)
         ON CONFLICT(artifact_id) DO UPDATE SET last_version = excluded.last_version`,
      )
      .run(artifactId, req.sessionId, path, version);

    const event = {
      kind: "artifact.published",
      sessionId: req.sessionId,
      turnId: this.deps.runningTurnId(req.sessionId),
      artifactId,
      version,
      path,
      name,
      title: req.title,
      mime: type.mime,
      artifactKind: type.kind,
      size,
      sha256: hasher.digest("hex"),
      stagedPath: staged,
    } satisfies TempodEvent;

    this.deps.emit(req.summary === undefined ? event : { ...event, summary: req.summary });

    return { text: publishedText(req.title, version) };
  }

  /** `artifact.release` (02): deletes the staged copy; a copy that is already gone is fine. */
  release(artifactId: string, version: number): void {
    if (!ID.test(artifactId) || !Number.isInteger(version) || version < 1) return;
    rmSync(this.stagedPath(artifactId, version), { force: true });

    try {
      rmdirSync(join(this.deps.stageDir, artifactId));
    } catch {
      // other versions are still staged
    }
  }
}
