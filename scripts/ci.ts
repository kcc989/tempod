import { appendFileSync } from "node:fs";

const docsOnly = process.argv.includes("--docs-only");
const { devDependencies } = await Bun.file(new URL("../package.json", import.meta.url)).json();
const started = Number(process.env["CI_STARTED_AT"] ?? Date.now());
const budgetMs = 270_000;
const timings: { name: string; seconds: number }[] = [];
type Check = [string, string[]];
const checks = {
  versions: ["Container versions", ["bun", "run", "check:versions"]],
  typecheck: ["Typecheck", ["bun", "run", "typecheck"]],
  lint: [
    "Lint",
    docsOnly
      ? ["bunx", "--package", `oxlint@${devDependencies.oxlint}`, "oxlint", "--deny-warnings", "."]
      : ["bun", "run", "lint"],
  ],
  format: [
    "Format",
    docsOnly
      ? ["bunx", "--package", `oxfmt@${devDependencies.oxfmt}`, "oxfmt", "--check", "."]
      : ["bun", "run", "format:check"],
  ],
  tests: ["Unit and integration tests", ["bun", "run", "test"]],
  daemon: ["Daemon build", ["bun", "run", "build:tempod"]],
  app: ["App build", ["bun", "run", "--cwd", "apps/tempo", "build"]],
  web: ["Web client", ["bun", "run", "test:web"]],
  browser: ["Browser regressions", ["bun", "run", "--cwd", "tests/e2e", "test:browser"]],
} satisfies Record<string, Check>;

let exitCode = 0;
const runCheck = async ([name, cmd]: Check): Promise<boolean> => {
  if (exitCode !== 0 || Date.now() - started >= budgetMs) return false;
  console.log(`Starting ${name}`);
  const stepStarted = Date.now();
  const child = Bun.spawn(cmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const remaining = budgetMs - (Date.now() - started);
  const timer = setTimeout(() => child.kill("SIGTERM"), Math.max(0, remaining));
  const result = await child.exited;
  clearTimeout(timer);
  const seconds = (Date.now() - stepStarted) / 1000;
  timings.push({ name, seconds });
  console.log(`::notice title=${name} runtime::${seconds.toFixed(1)} seconds`);
  if (result !== 0 || Date.now() - started >= budgetMs) {
    exitCode = result || 1;
    return false;
  }
  return true;
};

const runSequence = async (sequence: Check[]): Promise<void> => {
  for (const check of sequence) {
    if (!(await runCheck(check))) break;
  }
};
await runSequence(docsOnly ? [checks.lint, checks.format] : [checks.versions, checks.lint, checks.format]);
if (!docsOnly && exitCode === 0) {
  await Promise.all([runSequence([checks.typecheck, checks.daemon, checks.app]), runCheck(checks.tests)]);
}
if (!docsOnly && exitCode === 0) {
  await Promise.all([runCheck(checks.web), runCheck(checks.browser)]);
}

const total = (Date.now() - started) / 1000;
const summary = [
  "## CI runtime",
  docsOnly
    ? "Documentation-only change: lint and formatting; application tests and builds are not required."
    : "Complete suite.",
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
console.log(`::notice title=Total CI runtime::${total.toFixed(1)} seconds including setup`);
const summaryFile = process.env["GITHUB_STEP_SUMMARY"];
if (summaryFile) appendFileSync(summaryFile, summary);
if (total >= budgetMs / 1000) {
  console.error(
    "::error::CI exceeded its 270-second work budget. Fix the slow stage; do not raise the budget.",
  );
  exitCode = 1;
}
process.exit(exitCode);
