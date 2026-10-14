const workerOnly = process.argv.includes("--worker-only");

const otherOnly = process.argv.includes("--other-only");

if (workerOnly && otherOnly) throw new Error("Choose one test mode");

const commands = [
  ["bun", "run", "turbo", "run", "test:worker", "--filter=@tempo/app", "--output-logs=errors-only"],
  [
    "bun",
    "run",
    "turbo",
    "run",
    "test",
    "test:ui",
    "test:components",
    "--concurrency=1",
    "--filter=!@tempo/e2e",
    "--filter=!@tempo/conformance",
    "--output-logs=errors-only",
  ],
];

const selected = workerOnly ? commands.slice(0, 1) : otherOnly ? commands.slice(1) : commands;

const children = selected.map((cmd) =>
  Bun.spawn(cmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit" }),
);

process.on("SIGTERM", () => {
  for (const child of children) child.kill("SIGTERM");
});

process.on("SIGINT", () => {
  for (const child of children) child.kill("SIGINT");
});

const results = await Promise.all(children.map((child) => child.exited));

const failure = results.find((code) => code !== 0);

if (failure !== undefined) process.exit(failure);

if (workerOnly) process.exit(0);

const scripts = Bun.spawn(["bun", "test", ...new Bun.Glob("scripts/*.test.ts").scanSync()], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await scripts.exited);
