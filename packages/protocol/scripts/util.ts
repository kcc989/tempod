import { join } from "node:path";

export const repoRoot = join(import.meta.dirname, "../../..");

export const run = (cmd: ReadonlyArray<string>): void => {
  const proc = Bun.spawnSync([...cmd], { cwd: repoRoot, stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) throw new Error(`${cmd.join(" ")} exited with ${proc.exitCode}`);
};

/** Formats generated JSON with the repo's oxfmt config, so `format:check` agrees with the generator. */
export const formatFiles = (paths: ReadonlyArray<string>): void => {
  if (paths.length > 0) run([join(repoRoot, "node_modules/.bin/oxfmt"), "--threads=1", ...paths]);
};

/** JSON with object keys sorted, for comparing and for writing deterministic files. */
export const stableJson = (value: unknown, indent?: number): string =>
  JSON.stringify(sortKeys(value), null, indent);

export const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value).sort()) out[k] = sortKeys((value as Record<string, unknown>)[k]);
  return out;
};
