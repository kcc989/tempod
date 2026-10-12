import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const versions = JSON.parse(readFileSync(new URL("container/versions.json", root), "utf8")) as {
  build_args: Record<string, string>;
};
const run = (cmd: string[]): void => {
  const result = Bun.spawnSync(cmd, {
    cwd: fileURLToPath(root),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) process.exit(result.exitCode || 1);
};
run(["bun", "run", "check:versions"]);
run(["bun", "run", "build:tempod"]);
const image = "tempo-workspace-test:local";
const ca = process.env.TEMPO_BUILD_CA;
const trust = ca ? ["--secret", `id=proxy_ca,src=${ca}`] : [];
run([
  "docker",
  "build",
  "--platform",
  "linux/amd64",
  "-f",
  "container/Dockerfile",
  ...trust,
  "-t",
  "tempo-workspace:local",
  ...Object.entries(versions.build_args).flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]),
  ".",
]);
const inspect = Bun.spawnSync(
  ["docker", "image", "inspect", "--format", "{{.Size}}", "tempo-workspace:local"],
  { stdout: "pipe", stderr: "inherit" },
);
const bytes = Number(inspect.stdout.toString().trim());
if (inspect.exitCode !== 0 || !Number.isFinite(bytes) || bytes <= 0 || bytes >= 6_000_000_000) {
  console.error("The workspace image must build successfully and stay below 6 GB (01).");
  process.exit(1);
}
console.log(`Workspace image: ${bytes} bytes (under 6 GB).`);
if (process.env.TEMPO_TEST_MOUNT_SOURCE === "1") {
  run([
    "docker",
    "run",
    "--rm",
    "--platform",
    "linux/amd64",
    "--env",
    "TEMPO_IMAGE_TEST=1",
    "--mount",
    `type=bind,src=${fileURLToPath(root)},dst=/opt/tempo,readonly`,
    "--workdir",
    "/opt/tempo",
    "--entrypoint",
    "/usr/bin/tini",
    "tempo-workspace:local",
    "--",
    "bun",
    "run",
    "--cwd",
    "packages/tempod",
    "test",
  ]);
  process.exit(0);
}
run([
  "docker",
  "build",
  "--platform",
  "linux/amd64",
  "-f",
  "container/Dockerfile.test",
  "-t",
  image,
  ...trust,
  ".",
]);
run(["docker", "run", "--rm", "--platform", "linux/amd64", "--env", "TEMPO_IMAGE_TEST=1", image]);
