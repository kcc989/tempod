import { preflightDeployment } from "./deployment-preflight.ts";

let existingStore = false;
if (!process.argv.includes("--help") && !process.argv.includes("-h")) {
  try {
    existingStore = await preflightDeployment(process.env, fetch);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Deployment preflight failed.");
    process.exit(1);
  }
}
const args = process.argv.slice(2).filter((arg) => !existingStore || (arg !== "--yes" && arg !== "-y"));
if (existingStore && !args.includes("--no-input")) args.push("--no-input");
const result = Bun.spawnSync(["bunx", "alchemy", "deploy", "./alchemy.run.ts", ...args], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(result.exitCode || 0);
