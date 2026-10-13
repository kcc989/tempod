const commands = [
  ["bun", "run", "turbo", "run", "test:worker", "--filter=@tempo/app"],
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
  ],
];
const children = commands.map((cmd) =>
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
const scripts = Bun.spawn(["bun", "test", ...new Bun.Glob("scripts/*.test.ts").scanSync()], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await scripts.exited);
