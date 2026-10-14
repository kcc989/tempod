import { appendFileSync } from "node:fs";

const docsOnly = process.argv.includes("--docs-only");

const { devDependencies } = await Bun.file(new URL("../package.json", import.meta.url)).json();

const started = Number(process.env["CI_STARTED_AT"] ?? Date.now());

const checksStarted = Date.now();

const budgetMs = 300_000;

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
  workerTests: ["Worker tests", ["bun", "scripts/test.ts", "--worker-only"]],
  otherTests: ["Other tests", ["bun", "scripts/test.ts", "--other-only"]],
  daemon: ["Daemon build", ["bun", "run", "build:tempod"]],
  app: ["App build", ["bun", "run", "turbo", "run", "build:ci", "--filter=@tempo/app"]],
  browsers: ["Browser suites", ["bun", "run", "--cwd", "tests/e2e", "test:ci"]],
} satisfies Record<string, Check>;

let exitCode = 0;

const runCheck = async ([name, cmd]: Check): Promise<boolean> => {
  if (exitCode !== 0 || Date.now() - checksStarted >= budgetMs) return false;
  console.log(`Starting ${name}`);
  const stepStarted = Date.now();
  const child = Bun.spawn(cmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const remaining = budgetMs - (Date.now() - checksStarted);
  const timer = setTimeout(() => child.kill("SIGTERM"), Math.max(0, remaining));
  const result = await child.exited;
  clearTimeout(timer);
  const seconds = (Date.now() - stepStarted) / 1000;
  timings.push({ name, seconds });
  console.log(`::notice title=${name} runtime::${seconds.toFixed(1)} seconds`);

  if (result !== 0 || Date.now() - checksStarted >= budgetMs) {
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
  await Promise.all([
    (async () => {
      await Promise.all([
        runSequence([checks.typecheck, checks.daemon, checks.app]),
        runCheck(checks.otherTests),
      ]);

      if (exitCode === 0) {
        await runCheck(checks.browsers);
      }
    })(),
    runCheck(checks.workerTests),
  ]);
}

const total = (Date.now() - started) / 1000;

const workSeconds = (Date.now() - checksStarted) / 1000;

const summary = [
  "## CI runtime",
  docsOnly
    ? "Documentation-only change: lint and formatting; application tests and builds are not required."
    : "Complete suite.",
  "",
  "| Check | Seconds |",
  "| --- | ---: |",
  ...timings.map(({ name, seconds }) => `| ${name} | ${seconds.toFixed(1)} |`),
  `| Check commands | ${workSeconds.toFixed(1)} |`,
  `| Total including setup | ${total.toFixed(1)} |`,
  "",
  "Check deadline: 300 seconds after setup. Target: under five total runner minutes, including setup and cleanup; six-minute hard job limit.",
  "",
].join("\n");

console.log(summary);

console.log(`::notice title=Total CI runtime::${total.toFixed(1)} seconds including setup`);

const summaryFile = process.env["GITHUB_STEP_SUMMARY"];

if (summaryFile) appendFileSync(summaryFile, summary);

if (workSeconds >= budgetMs / 1000) {
  console.error(
    "::error::CI check commands exceeded their 300-second deadline. Fix the slow stage; do not raise the deadline.",
  );
  exitCode = 1;
}

process.exit(exitCode);
