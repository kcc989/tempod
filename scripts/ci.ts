import { appendFileSync, readdirSync, readFileSync } from "node:fs";

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
  app: [
    "App build",
    [
      "bun",
      "run",
      "turbo",
      "run",
      "build:ci",
      "build:web-fixture",
      "build:browser-fixture",
      "--filter=@tempo/app",
    ],
  ],
  browsers: ["Browser suites", ["bun", "run", "--cwd", "tests/e2e", "test:ci"]],
} satisfies Record<string, Check>;

let exitCode = 0;

/** Each check runs in its own process group, so no grandchild outlives it and stalls job cleanup. */
const killGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal);
  } catch {
    // the group has already exited
  }
};

const runCheck = async ([name, cmd]: Check): Promise<boolean> => {
  if (exitCode !== 0 || Date.now() - checksStarted >= budgetMs) return false;
  console.log(`Starting ${name}`);
  const stepStarted = Date.now();
  const child = Bun.spawn(cmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit", detached: true });
  const remaining = budgetMs - (Date.now() - checksStarted);
  const timer = setTimeout(() => killGroup(child.pid, "SIGTERM"), Math.max(0, remaining));
  const result = await child.exited;
  clearTimeout(timer);
  killGroup(child.pid, "SIGKILL");
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

/** 13, Phase 3: the newest weekly loop report. A missed time target does not fail CI. */
const loopSummary = (): string[] => {
  const dir = new URL("../docs/evidence/loop-weekly/", import.meta.url);
  let newest: string | undefined;

  try {
    newest = readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
      .at(-1);
  } catch {
    newest = undefined;
  }

  if (!newest) return ["## Loop report", "", "No weekly loop report yet.", ""];

  const report: {
    steps: { step: string; n: number; median: number | null; p90: number | null; met: boolean | null }[];
  } = JSON.parse(readFileSync(new URL(newest, dir), "utf8"));

  const value = (step: string, v: number | null) =>
    v === null ? "–" : step === "intent_corrections" ? String(v) : `${(v / 60_000).toFixed(1)} min`;

  return [
    `## Loop report (${newest.replace(".json", "")})`,
    "",
    "| Step | n | Median | p90 | Target met |",
    "| --- | ---: | ---: | ---: | --- |",
    ...report.steps.map(
      (r) =>
        `| ${r.step} | ${r.n} | ${value(r.step, r.median)} | ${value(r.step, r.p90)} | ${r.met === null ? "no data" : r.met ? "yes" : "no"} |`,
    ),
    "",
  ];
};

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
  ...loopSummary(),
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
