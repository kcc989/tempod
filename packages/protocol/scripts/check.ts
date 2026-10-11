import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { repoRoot, run } from "./util.ts";

/**
 * CI check (07, Testing): runs protocol:gen and protocol:fixtures and fails if any output changed,
 * so the committed schema, Rust types and fixtures always match packages/protocol/src.
 */

const outputs = [
  join(repoRoot, "packages/protocol/schema"),
  join(repoRoot, "packages/protocol/fixtures"),
  join(repoRoot, "crates/tempo-protocol/src/generated.rs"),
];

const walk = (path: string): string[] => {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((f) => walk(join(path, f)));
};

const snapshot = (): Map<string, string> =>
  new Map(
    outputs
      .flatMap(walk)
      .map((f) => [relative(repoRoot, f), createHash("sha256").update(readFileSync(f)).digest("hex")]),
  );

const before = snapshot();
run(["bun", "packages/protocol/scripts/gen-schema.ts"]);
run(["bun", "packages/protocol/scripts/gen-fixtures.ts"]);
const after = snapshot();

const changed = [...new Set([...before.keys(), ...after.keys()])]
  .filter((f) => before.get(f) !== after.get(f))
  .sort();
if (changed.length > 0) {
  console.error(
    `protocol outputs are stale; run bun run protocol:gen and bun run protocol:fixtures:\n${changed.join("\n")}`,
  );
  process.exit(1);
}
console.log(`protocol outputs are up to date (${after.size} files)`);
