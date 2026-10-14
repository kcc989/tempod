import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { Option, Schema } from "effect";

/**
 * After `bun run ci`: decide whether the Turbo task cache needs saving, and when every check
 * passed, keep only the entries this run used so the archive does not grow without bound.
 */

const RunSummary = Schema.fromJsonString(
  Schema.Struct({ tasks: Schema.Array(Schema.Struct({ hash: Schema.String })) }),
);

/** `<hash>.tar.zst`, `<hash>-meta.json` and `<hash>-manifest.json` all belong to one task hash. */
export const entryHash = (file: string): string =>
  file.replace(/(-meta\.json|-manifest\.json|\.tar\.zst)$/, "");

export const staleEntries = (files: ReadonlyArray<string>, used: ReadonlySet<string>): string[] =>
  files.filter((file) => !used.has(entryHash(file)));

/** Task hashes from Turbo run summaries; None when any summary cannot be read, so nothing is pruned. */
export const usedHashes = (summaries: ReadonlyArray<string>): Option.Option<Set<string>> => {
  const hashes = new Set<string>();

  for (const text of summaries) {
    const summary = Schema.decodeUnknownOption(RunSummary)(text);

    if (Option.isNone(summary)) return Option.none();

    for (const task of summary.value.tasks) hashes.add(task.hash);
  }

  return hashes.size > 0 ? Option.some(hashes) : Option.none();
};

if (import.meta.main) {
  const root = path.resolve(import.meta.dirname, "..");
  const cacheDir = path.join(root, ".turbo/cache");
  const runsDir = path.join(root, ".turbo/runs");
  const marker = path.join(root, ".turbo/cache-restored");
  const files = existsSync(cacheDir) ? readdirSync(cacheDir) : [];
  const since = existsSync(marker) ? statSync(marker).mtimeMs : 0;
  const changed = files.some((file) => statSync(path.join(cacheDir, file)).mtimeMs > since);
  let removed = 0;

  if (process.env["CI_CHECKS_OK"] === "true" && changed && existsSync(runsDir)) {
    const summaries = readdirSync(runsDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => readFileSync(path.join(runsDir, file), "utf8"));

    const used = usedHashes(summaries);

    if (Option.isSome(used)) {
      for (const file of staleEntries(files, used.value)) {
        rmSync(path.join(cacheDir, file), { force: true });
        removed++;
      }
    }
  }

  console.log(`Task cache: ${changed ? "new entries" : "no new entries"}; removed ${removed} unused files.`);

  const output = process.env["GITHUB_OUTPUT"];

  if (output) appendFileSync(output, `changed=${changed}\n`);
}
