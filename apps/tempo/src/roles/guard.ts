import { Files } from "@cloudflare/sandbox";
import { TempoError } from "@tempo/protocol";
import { sha256Hex } from "../lib/crypto.ts";
import type { WorkspaceCore } from "../do/workspace/core.ts";

export const PROTECTED_ROLE_FILES = [
  "/home/tempo/.codex/auth.json",
  "/home/tempo/.claude/.credentials.json",
  "/home/tempo/.codex/config.toml",
  "/home/tempo/.claude/settings.json",
  "/home/tempo/.gitconfig",
] as const;

export const roleFileHashes = async (core: WorkspaceCore): Promise<Record<string, string | null>> => {
  const files = new Files(core.container!);
  const hashes: Record<string, string | null> = {};

  for (const path of PROTECTED_ROLE_FILES) {
    const response = await files.readFile(path);

    if (response.status === 404) {
      hashes[path] = null;
      continue;
    }

    if (!response.ok)
      throw new TempoError(
        "ROLE_ACCESS_VIOLATION",
        undefined,
        "Protected login or config files could not be checked.",
      );
    const chunks: Uint8Array[] = [];
    let length = 0;
    const reader = response.body?.getReader();

    if (reader)
      try {
        for (;;) {
          const chunk = await reader.read();

          if (chunk.done) break;
          length += chunk.value.byteLength;

          if (length > 1024 * 1024)
            throw new TempoError(
              "ROLE_ACCESS_VIOLATION",
              undefined,
              "A protected login or config file exceeds the check limit.",
            );
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }

    const bytes = new Uint8Array(length);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }

    hashes[path] = await sha256Hex(bytes);
  }

  return hashes;
};

export const roleFilesChanged = async (core: WorkspaceCore, turnId: string): Promise<boolean> => {
  const before = core.kv<Record<string, string | null>>(`runGuard:${turnId}`);

  if (!before) return true;
  const after = await roleFileHashes(core);

  return PROTECTED_ROLE_FILES.some((path) => before[path] !== after[path]);
};
