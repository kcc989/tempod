import { Schema } from "effect";
import { Files } from "@cloudflare/sandbox";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { TempoError, newId, type CheckpointReason } from "@tempo/protocol";
import { checkpoints, homeBackups, type CheckpointRow } from "../../db/workspace-do.ts";
import { errorText, log } from "../../log.ts";
import { homeBackup, requireTempod } from "./container.ts";
import type { WorkspaceCore } from "./core.ts";

const DirectoryBackupRecordSchema = Schema.Struct({
  id: Schema.String,
  dir: Schema.String,
  size: Schema.Number,
  name: Schema.optional(Schema.String),
  sha256: Schema.String,
  format: Schema.Literal("tar+zstd/1"),
});

const readBackupRecord = Schema.decodeUnknownSync(Schema.fromJsonString(DirectoryBackupRecordSchema));

export const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;

export const HOME_BACKUPS_KEPT = 3;

export const BUNDLES_KEPT = 20;

const HOME_BACKUP_MIN_INTERVAL_MS = 60_000;

export const RESTORE_BUNDLE_PATH = "/home/tempo/.tempod/restore.bundle";

export const HOME_EXCLUDES = [
  ".cache/",
  ".npm/",
  "node_modules/",
  ".tempod/",
  "artifacts/",
  ".codex/auth.json",
  ".claude/.credentials.json",
] as const;

export const bundleKey = (workspaceId: string, checkpointId: string) =>
  `checkpoints/${workspaceId}/${checkpointId}.bundle`;

export interface PendingBundle {
  readonly checkpointId: string;
  readonly bundlePath: string;
  readonly bundleBytes: number;
}

/**
 * Asks tempod for a checkpoint and records it (01, Durability). Returns the new checkpoint and
 * the bundle to upload, or `unchanged` with the newest existing checkpoint id.
 */
export const takeCheckpoint = async (
  core: WorkspaceCore,
  reason: CheckpointReason,
  turnId: string | null,
  signal?: AbortSignal,
  checkpointId = newId(),
): Promise<{ checkpointId: string | null; bundle: PendingBundle | null }> => {
  const tempod = requireTempod(core);

  const res = await tempod.request(
    "git.checkpoint",
    { checkpointId, turnId, reason },
    signal ? { signal } : {},
  );

  if ("unchanged" in res) {
    const newest = core.db.select().from(checkpoints).orderBy(desc(checkpoints.createdAt)).get();

    return { checkpointId: newest?.id ?? null, bundle: null };
  }

  core.db
    .insert(checkpoints)
    .values({
      id: checkpointId,
      turnId,
      reason,
      commitSha: res.commit,
      treeSha: res.tree,
      parentSha: res.parent,
      baseSha: res.base,
      r2Key: null,
      bundleBytes: res.bundleBytes,
      localOnly: 0,
      createdAt: Date.now(),
    })
    .onConflictDoNothing()
    .run();

  return { checkpointId, bundle: { checkpointId, bundlePath: res.bundlePath, bundleBytes: res.bundleBytes } };
};

/** Streams the bundle to R2. Over 100 MiB the checkpoint is marked local_only. */
export const uploadBundle = async (core: WorkspaceCore, bundle: PendingBundle): Promise<void> => {
  if (bundle.bundleBytes > MAX_BUNDLE_BYTES) {
    core.db.update(checkpoints).set({ localOnly: 1 }).where(eq(checkpoints.id, bundle.checkpointId)).run();

    return;
  }

  const key = bundleKey(core.workspaceId, bundle.checkpointId);
  const res = await new Files(core.container!).readFile(bundle.bundlePath);

  if (!res.body) throw new TempoError("INTERNAL", undefined, "empty bundle");
  const body = res.body.pipeThrough(new FixedLengthStream(bundle.bundleBytes));
  await core.env.DATA.put(key, body);
  core.db
    .update(checkpoints)
    .set({ r2Key: key, localOnly: 0 })
    .where(eq(checkpoints.id, bundle.checkpointId))
    .run();
};

export const markLocalOnly = (core: WorkspaceCore, checkpointId: string): void => {
  core.db.update(checkpoints).set({ localOnly: 1 }).where(eq(checkpoints.id, checkpointId)).run();
};

/** Uploads with 3 attempts; then local_only (03, Step limits for bundle.upload). */
export const uploadBundleWithRetry = async (core: WorkspaceCore, bundle: PendingBundle): Promise<void> => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await uploadBundle(core, bundle);

      return;
    } catch (e) {
      log("warn", "bundle upload failed", { workspaceId: core.workspaceId, attempt, error: errorText(e) });

      if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
  }

  markLocalOnly(core, bundle.checkpointId);
};

/** Backs up /home/tempo, keeps the newest 3 (01, Back up the home directory). */
export const backupHome = async (core: WorkspaceCore, signal?: AbortSignal): Promise<void> => {
  const backup = homeBackup(core);
  const options = { dir: "/home/tempo", exclude: [...HOME_EXCLUDES] };
  const rec = await backup.backup(signal ? { ...options, signal } : options);
  core.db
    .insert(homeBackups)
    .values({ id: rec.id, recordJson: JSON.stringify(rec), sizeBytes: rec.size, createdAt: Date.now() })
    .onConflictDoNothing()
    .run();
  core.lastHomeBackupAt = Date.now();
  const all = core.db.select().from(homeBackups).orderBy(desc(homeBackups.createdAt)).all();

  for (const old of all.slice(HOME_BACKUPS_KEPT)) {
    try {
      await backup.delete(readBackupRecord(old.recordJson));
      core.db.delete(homeBackups).where(eq(homeBackups.id, old.id)).run();
    } catch (e) {
      log("warn", "home backup delete failed", { workspaceId: core.workspaceId, error: errorText(e) });
    }
  }
};

export const backupHomeIfDue = async (core: WorkspaceCore): Promise<void> => {
  if (Date.now() - core.lastHomeBackupAt < HOME_BACKUP_MIN_INTERVAL_MS) return;
  core.lastHomeBackupAt = Date.now();

  try {
    await backupHome(core);
  } catch (e) {
    log("warn", "home backup failed", { workspaceId: core.workspaceId, error: errorText(e) });
  }
};

export const restoreHome = async (core: WorkspaceCore, signal: AbortSignal): Promise<boolean> => {
  const newest = core.db.select().from(homeBackups).orderBy(desc(homeBackups.createdAt)).get();

  if (!newest) return false;
  await homeBackup(core).restore(readBackupRecord(newest.recordJson), {
    signal,
  });

  return true;
};

export const newestUploadedCheckpoint = (core: WorkspaceCore): CheckpointRow | null =>
  core.db
    .select()
    .from(checkpoints)
    .where(and(isNotNull(checkpoints.r2Key), eq(checkpoints.localOnly, 0)))
    .orderBy(desc(checkpoints.createdAt))
    .get() ?? null;

/** Copies a checkpoint bundle from R2 into the container. */
export const copyBundleIn = async (
  core: WorkspaceCore,
  ckpt: CheckpointRow,
  path = RESTORE_BUNDLE_PATH,
): Promise<void> => {
  if (!ckpt.r2Key) throw new TempoError("CHECKPOINT_NOT_FOUND");
  const obj = await core.env.DATA.get(ckpt.r2Key);

  if (!obj) throw new TempoError("CHECKPOINT_NOT_FOUND", undefined, "bundle missing from R2");
  await new Files(core.container!).writeFile(path, obj.body, { user: "1000:1000" });
};
