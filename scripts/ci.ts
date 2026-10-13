import { appendFileSync } from "node:fs";

const started = Number(process.env["CI_STARTED_AT"] ?? Date.now());
const budgetMs = 270_000;
const timings: { name: string; seconds: number }[] = [];
const checks: [string, string[]][] = [
  ["Container versions", ["bun", "run", "check:versions"]],
  ["Typecheck", ["bun", "run", "typecheck"]],
  ["Lint", ["bun", "run", "lint"]],
  ["Format", ["bun", "run", "format:check"]],
  ["Unit and integration tests", ["bun", "run", "test"]],
  ["Daemon build", ["bun", "run", "build:tempod"]],
  ["App build", ["bun", "run", "--cwd", "apps/tempo", "build"]],
  ["Web client", ["bun", "run", "test:web"]],
  ["Browser regressions", ["bun", "run", "--cwd", "tests/e2e", "test:browser"]],
];

let exitCode = 0;
for (const [name, cmd] of checks) {
  console.log(`::group::${name}`);
  const stepStarted = Date.now();
  const child = Bun.spawn(cmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const remaining = budgetMs - (Date.now() - started);
  const timer = setTimeout(() => child.kill("SIGTERM"), Math.max(0, remaining));
  const result = await child.exited;
  clearTimeout(timer);
  timings.push({ name, seconds: (Date.now() - stepStarted) / 1000 });
  console.log("::endgroup::");
  if (result !== 0 || Date.now() - started >= budgetMs) {
    exitCode = result || 1;
    break;
  }
}

const total = (Date.now() - started) / 1000;
const summary = [
  "## CI runtime",
  "",
  "| Check | Seconds |",
  "| --- | ---: |",
  ...timings.map(({ name, seconds }) => `| ${name} | ${seconds.toFixed(1)} |`),
  `| Total including setup | ${total.toFixed(1)} |`,
  "",
  "Budget: 270 seconds, leaving 30 seconds for cache saves and runner cleanup within the five-minute job limit.",
  "",
].join("\n");
console.log(summary);
const summaryFile = process.env["GITHUB_STEP_SUMMARY"];
if (summaryFile) appendFileSync(summaryFile, summary);
if (total >= budgetMs / 1000) {
  console.error(
    "::error::CI exceeded its 270-second work budget. Fix the slow stage; do not raise the budget.",
  );
  exitCode = 1;
}
process.exit(exitCode);
