import { Predicate, Schema } from "effect";
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
export const stableJson = <T>(value: T, indent?: number): string =>
  JSON.stringify(sortKeys(JSON.parse(JSON.stringify(value))), null, indent);

const isJsonArray = (value: Schema.Json): value is Schema.JsonArray => Array.isArray(value);

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject => Predicate.isObject(value);

export const sortKeys = (value: Schema.Json): Schema.Json => {
  if (isJsonArray(value)) return value.map(sortKeys);

  if (!isJsonObject(value)) return value;
  const out: { [key: string]: Schema.Json } = {};

  for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]!);

  return out;
};
