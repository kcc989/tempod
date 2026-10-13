import { existsSync, readdirSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { preflightDeployment } from "./deployment-preflight.ts";

process.env.ALCHEMY_HOME ??= path.resolve(".alchemy/profile");
process.env.XDG_CONFIG_HOME = path.resolve(".alchemy/xdg");
mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true, mode: 0o700 });

// Refuse an unpatched install before any SDK state access.
const sdk = "node_modules/alchemy";
if (JSON.parse(readFileSync(`${sdk}/package.json`, "utf8")).version !== "2.0.0-beta.81")
  throw new Error("Tempo requires the pinned, isolated Alchemy SDK.");
for (const [file, marker] of [
  ["Api", 'STATE_STORE_SCRIPT_NAME = "tempo-state-store"'],
  ["CredentialsFile", 'CREDENTIALS_FILE = "tempo-state-store-credentials"'],
  ["Token", 'EncryptionKeySecretName = "TempoStateStoreEncryptionKey"'],
  ["Token", 'AuthTokenSecretName = "TempoStateStoreToken"'],
  ["State", '"TempoStateStore"'],
  ["State", 'process.env.TEMPO_STATE_BOOTSTRAP_ALLOWED === "1"'],
] as const) {
  for (const [folder, ext] of [
    ["src", "ts"],
    ["lib", "js"],
  ])
    if (!readFileSync(`${sdk}/${folder}/Cloudflare/StateStore/${file}.${ext}`, "utf8").includes(marker))
      throw new Error("Tempo state-store isolation patch is missing; run bun install --frozen-lockfile.");
}
let existingStore = false;
if (!process.argv.includes("--help") && !process.argv.includes("-h")) {
  try {
    const localState = ".alchemy/state/TempoStateStore";
    const pendingBootstrap =
      existsSync(localState) &&
      readdirSync(localState, { recursive: true }).some((file) => String(file).endsWith(".json"));
    existingStore = await preflightDeployment(process.env, fetch, pendingBootstrap);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Deployment preflight failed.");
    process.exit(1);
  }
}
const userArgs = process.argv.slice(2);
if (
  userArgs.some(
    (arg) =>
      arg === "--stage" || arg.startsWith("--stage=") || arg === "--profile" || arg.startsWith("--profile="),
  )
) {
  throw new Error("Tempo deployment uses the fixed production stage and tempo profile.");
}
process.env.TEMPO_STATE_BOOTSTRAP_ALLOWED = existingStore ? "0" : "1";
const args = process.argv.slice(2);
if (existingStore && !args.includes("--no-input")) args.push("--no-input");
args.push("--stage", "production", "--profile", "tempo");
const result = Bun.spawnSync(["bunx", "alchemy", "deploy", "./alchemy.run.ts", ...args], {
  env: { ...process.env },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(result.exitCode || 0);
