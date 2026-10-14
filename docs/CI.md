# CI runtime and test value

The [Linear playbook audit](CI_PLAYBOOK.md) records the fifteen recommendations,
run-history evidence and the filtered image-install change.

PRs target **under five total runner minutes**, not five minutes per parallel job.
The single `check` job runs all local checks, builds, and browser regressions for
code changes. Documentation-only changes keep the same required `check` job but
install only the pinned root tooling dependencies with `--filter tempo` and run
lint and formatting without Chromium.
The vendored anti-slop plugin resolves `@oxlint/plugins` from that installation.
Typecheck and builds overlap with tests on that one runner. Once the builds and
non-Worker suites pass, both browser suites run in one Playwright invocation with
a shared two-worker limit and separate fixture servers while Worker tests finish. Standalone
`test:web` and `test:browser` commands remain available. The timing summary
shows individual durations and the total elapsed time, so overlapping stages
should not be added together.
`bun run ci` reports stage durations to the Actions summary and gives check
commands 300 seconds after dependency/browser setup. Total elapsed time still
includes setup and is reported separately; cleanup is included in the job's
actual duration. The job has a six-minute hard timeout to allow setup and cache
cleanup. Normal runs should stay under five total runner minutes. Do not raise
the deadlines to accommodate regressions. Cancel superseded runs instead of
paying for outdated commits.

Chromium and deterministic Turbo task results are restored between runs. The
multi-gigabyte Bun dependency cache is not archived: saving it exceeded the
cleanup budget. Dependency installation still uses the frozen lockfile. Turbo hashes package
sources, transitive dependencies, root TypeScript configuration, Bun configuration
and dependency patches. Image tests have a separate `TEMPO_IMAGE_TEST` hash. Live
agent/deployment tasks are never cached. Task archives can be restored across
lockfile changes within the same OS/Bun namespace; Turbo checks the resolved
dependencies and inputs before reusing any result. Successful task results are
saved even if another check fails, but not after cancellation or failed dependency
installation. Each run/attempt has a distinct archive key. Turbo writes a run summary for every invocation (`TURBO_RUN_SUMMARY`). After the checks, `scripts/ci-cache.ts` saves the archive only when the run wrote new entries. When every check passed, it first removes entries whose task hash no run used, so the archive does not keep growing (it reached 434 to 565 MB). A failed run keeps every entry. Chromium is keyed by
the installed Playwright version rather than unrelated package script changes.

The daemon build and production app CI build are cached. `build:ci` fixes the app's
Wrangler configuration to the checked-in default and restores both `dist` and the
Wrangler deployment pointer. Its inputs include transitive workspace sources,
starter definitions, container configuration, local environment files and build-time
environment values. Generated Wrangler metadata contains absolute paths, so the
checkout directory is part of this task's hash. The general app `build` remains
uncached because it permits arbitrary external Wrangler configuration paths.
Browser fixture builds have separate cached outputs (`test/web/dist` and
`test/browser/dist`). The App build step builds them alongside `build:ci`, so the
browser stage's web servers only replay the cached outputs; both browser suites still
execute against those artifacts before previewing to avoid development-server
transform costs. Worker tests prebundle Effect and Drizzle (including their used subpaths)
to avoid loading the same dependency module graph into every workerd isolate.
Worker, UI model and component suites have separate Turbo tasks and cache entries.
`bun run test` starts the Worker task immediately and runs all other test tasks
one at a time alongside it (at most two active test tasks); `bun run --cwd apps/tempo test:all` runs the aggregate
Vitest configuration directly. A UI source change reuses the Worker test result.
Worker inputs exclude UI/routes but include Worker fixtures, runtime configuration
and server sources. UI/component inputs conservatively include all app sources
because UI API modules import server functions; their test/helper inputs are scoped
separately. All three tasks and fixture builds hash transitive workspace source
dependencies through `transit`, in addition to lockfiles and root configuration.
Widen inputs if a new import crosses these boundaries.

RPC cases that only need an already-ready workspace use the test-only
`seedReadyWorkspace` API. It creates a fresh user/project/DO, uses real migrated
storage and connects the real daemon client to the protocol fake, without
replaying the create operation. Options configure title, slug, branch, effective
settings and credentials for selected agents; no credentials are provisioned by
default. An equivalence test compares observable defaults and file/git RPC
outcomes with a lifecycle-created workspace and verifies isolation. Init/create,
session, recovery and lifecycle cases retain their full fixtures. Existing
credential helpers can provision a selected agent instead of storing unrelated
secrets.

UI and component files use isolated VM threads to avoid repeated process startup;
each suite is limited to two workers. Worker files run at most four at a time;
event, RPC and operation cases use four-way concurrency within each file, with distinct users, projects and Durable Objects, and
test-context assertions. Held daemon fakes register cleanup on their own test
context. The SVG data URL encoder lives in a small shared helper so loading Mermaid does
not pull in the protocol/Effect schema graph; Mermaid cases retain fresh module
fixtures and their original deadlines. Groups using shared GitHub spies or a global clock remain sequential
and form barriers between concurrent groups. DOM cases remain sequential. TypeScript
7.0.2 provides the native checker; use two checkers per project and at most two
concurrent typecheck tasks. The root deployment/tooling typecheck is also cached
with its own source/configuration inputs. Update those inputs if root scripts
start importing files outside that scope. A cache miss must also fit the budget.

PR #34's cold run spent 199.8 seconds on unit/integration tests, 39.5 seconds on
typecheck and 31.4 seconds on the app build. Waiting for the test stage before
starting browsers left only 8.6 seconds before the former 270-second deadline. Browser
checks overlap the independent Worker suite. The follow-up cold run showed
heavy contention when browsers also overlapped component/UI tests (over 100
seconds per browser stage). They now wait for those suites and builds; all
checks remain. Turbo emits full test logs on failure,
rather than streaming routine native Worker logs to Actions.

Before the configurable-fixture/shared-pool changes, main run `38411262121`
completed in 4m59s: Worker tests took 239.0s, other tests 93.9s, typecheck
23.7s, the app build 41.1s and dependency installation 33s. Browser stages
took 76.2s and 60.5s concurrently. These overlapping durations are the baseline
for evaluating the next changes; they are not additive runner minutes.

The final four-file Worker configuration passed a complete cold-task benchmark
in **4m00s total** (run `38430168102`, job `115409966002`). `TURBO_FORCE=true`
on a temporary benchmark branch reran every typecheck, test task and build,
including both browser fixture builds; all 27 browser cases still executed.
Three Worker files took 5m22s with cold tasks, despite reaching 4m09s when
unchanged tasks were cached. Use the full cold workload to evaluate concurrency,
not only a cached rerun. The force flag is not part of normal CI.

## Timing review (runs 196 to 210, 2026-10-14)

Worker tests were the critical path in all 14 runs: median 219 s, max 293 s. Five runs failed on the 300-second deadline or the six-minute job limit. Findings and changes:

- Worker results never came from the cache on CI. Locally an unchanged Worker task is a full Turbo hit. On CI, most PRs change Worker inputs, and a push to `main` cannot restore caches saved by pull request runs (GitHub scopes caches to the branch), so `main` always reruns the PR's work. A shared remote Turbo cache would fix the `main` case; it needs a new service and an owner decision.
- The Worker suite is CPU-bound on the four-core runner. Alone it takes 77 s locally (192 s of CPU), and 128 s while the other stages run. Each file spends about 10 s importing the Worker app into workerd before its first case. Eight concurrent cases per file instead of four took 75 to 76 s, the same as four, so the concurrency limits are unchanged. Vitest's `experimental.fsModuleCache` cannot be used: workerd cannot read the cache path.
- Run 210 passed every check, then spent 60 s in "Cleaning up orphan processes" and hit the job limit. `bun run ci` now starts each check in its own process group and kills the group when the check ends or the deadline passes.
- Bun's install cache is 2.8 GB; restoring it would cost about as much as the 18 to 34 s install, so dependencies are still installed fresh.

## Test audit

The audit retains the following distinct responsibilities. Test counts alone are
not a quality target.

| Suite | What it proves | Where it runs |
| --- | --- | --- |
| Protocol fixtures and schemas | Wire decoding, validation and shared-client compatibility | Every code PR |
| Settings and cities | Settings layering, invalid input and collision-free slugs | Every code PR |
| Daemon Bun tests | Real filesystem, git, subprocess, WebSocket, ACP mapping, bounds, credentials and shutdown behavior with fake agent processes | Every code PR and image checks |
| Worker unit tests | Egress/security decisions, crypto, transitions, limits and parsers | Every code PR in workerd |
| Worker integration tests | Durable Object/D1/R2 behavior, RPC failures, idempotency, migrations, recovery and event ordering | Every code PR in workerd, with storage isolation |
| UI model tests | Stores, parsing, drafts, shortcuts and view-state decisions | Every code PR in Node |
| Component tests | DOM interaction, rendered states and accessibility contracts | Every code PR in happy-dom |
| Web client browser tests | Shell integration, RPC contracts, keyboard, persistence, mobile navigation and rendering | Every code PR; desktop contracts plus focused phone interactions |
| Theme browser test | Actual theme application, persistence and system media changes | Every code PR on desktop; one run covers light, dark, reload and System media changes |
| Workspace browser regressions | Streaming reloads, hidden-panel shortcuts, draft mentions, phone overflow, transcript scroll, closed chats and blocked storage | Every code PR, independent browser contexts |
| Deployment script tests | Preflight outcomes and isolation of the pinned Alchemy patch | Every code PR |
| Image tests | Image tools, uid, tini and orphan reaping | Relevant main pushes and manual image workflow |
| Hosted acceptance and adapter conformance | Real deployment/login and installed agent behavior | Explicit acceptance commands, outside the local PR suite |

The port-scanner integration test now requires a scan and the listener's port;
it previously passed when the scanner returned nothing. The idle-sleep test now asserts daemon shutdown and container destruction with an
open UI socket. All app Vitest projects require assertions. Browser fixtures fail on unexpected calls and runtime errors.
One phone web case covers touch navigation, the tab picker's focus return, the
unified diff, settings and narrow-screen overflow; a separate iPhone touch regression
covers the composer, permission approval, review and overflow. Other browser cases
run on desktop only. The theme test runs once on desktop: it already switches
light, dark and System and emulates both media schemes, so a second dark-default
project added no assertion.
Hosted and conformance tests no longer
start in local CI merely to skip for missing deployments or binaries. Their
explicit commands and acceptance gates remain available.

## Documentation-only changes

The change classifier compares the PR base SHA (or the previous push SHA) with
HEAD. Only root README/AGENTS/CLAUDE Markdown, documentation Markdown/images and
spike Markdown qualify. Unknown or unavailable bases, empty diffs, code/config
changes and renames from code to docs run the full suite. Both rename paths are
checked, and missing shallow-history bases are fetched with bounded,
noninteractive Git operations. Manual dispatch runs the full suite.

The lightweight path runs the existing pinned oxlint/Oxfmt binaries through
`bunx` after a frozen root-only dependency installation needed by the anti-slop plugin,
and publishes its mode/timings. Workflow-level path
ignores are not used, so a required check never stays pending on a docs-only PR.

## Rules for future changes

Hosted run `38469401920` spent 224.2 seconds on Worker tests and failed the
deferred-turn reconnect case: its fixed 100 ms settling delay could outlast the
one-second reconnect timer under load. The fake now holds the actual reconnect
response until the test observes the queued turn and absence of a daemon prompt,
then releases it and verifies execution resumes. Cleanup releases the gate on
failure; production reconnect timing and test concurrency remain unchanged.

1. Name the distinct bug or contract a test protects. Assert the externally
   observable result, including failure behavior where relevant. A mock expectation
   is useful only when the interaction itself is the contract.
2. Put pure logic in unit tests; reserve workerd for runtime/storage semantics and
   browsers for actual interaction, layout, focus, storage or reconnect behavior.
3. Extend an existing case when it already owns the behavior. Add a new viewport,
   theme or browser only when it exercises a distinct failure mode. Keep desktop
   and phone navigation coverage.
4. Poll for a bounded condition or use a controlled promise. Avoid fixed sleeps
   except when elapsed time is the behavior under test. Scale test-only deadlines;
   do not change production timeouts for speed.
5. Fix flaky tests without retries. Preserve isolation. Concurrent cases need
   independent fixtures and test-context assertions; do not share global mocks,
   fake timers, a DOM or cleanup lists between concurrent cases. Never remove security,
   failure, idempotency or migration coverage to meet the budget.
6. Use the CI timing summary to identify the slow stage. Changes to tests or CI
   must report timings and stay within the total budget, including cold setup.
   If cold CI misses the target, optimize the bottleneck before merging.
7. Skipped external suites do not establish acceptance. Run their explicit commands
   in the appropriate environment when their contracts or adapters change.

Image checks run on main only when the image, daemon, shared daemon packages or
installation/build inputs change, and remain manually dispatchable. UI-only or
native-only merges do not rebuild the full image. Superseded image runs cancel.
Both the image workflow and test-image dependency installation filter Bun to the
root tooling (`tempo`) and daemon (`@tempo/tempod`). Bun includes the daemon's
workspace dependencies (`@tempo/protocol` and `@tempo/settings`) and their external
dependencies. The frozen lockfile, version check, compiled daemon, complete image
build, size limit and daemon/image tests still run. PR CI installs every workspace
because it uses the app and browser suites as well.

The removed standalone `web` job is now part of `check`. If branch protection
requires `web`, update the required check to `check` when adopting this workflow.

## Workspace tool regression (2026-10-13)

One desktop browser case protects independent chat/draft selection while files and Browser Run share the right tool area, including closing the active tool to the launcher. The existing desktop terminal case now opens Terminal from that launcher. Both browser suites use a shared test helper that honors Chromium client-hint platform data before the legacy platform field, matching the app's shortcut rule. Pool sizes, cache inputs and deadlines are unchanged.

Local macOS measurements: web cases took 9.6 seconds including one temporary visual-capture case (19 permanent cases); workspace browser regressions took 5.6 seconds (9 cases). UI model and component stages previously took 1.5 and 7.1 seconds in this checkout. These are local stage measurements, not a complete CI pass. The baseline cold CI run above remains 4m00s total. Cleanup resolved the initial 20 GiB free-disk gate. The Linux CI attempt then stopped in oxlint's allocator with SIGABRT: 2.2 s for check commands and 3.0 s including setup, with lint at 1.5 s. This failed partial run is not a full CI result. Source lint passes on macOS; separate Linux typecheck passed in 24.8 s. The complete root Linux test command passed: Worker tests took 118.7 s, other test tasks 130.0 s, followed by 13 root script tests in 3.2 s. Those overlapping stages are not additive.

The final Mac suite passed 264 tests in 5.45 seconds of test execution. Its native surface tests assert visibility after paint, pane hide/restore and deferred-popup hide/restore through an observable surface boundary. They do not establish native visual acceptance or hosted Browser Run acceptance.

The production app CI build task also passed locally on macOS in 4.1 seconds. The complete Linux CI command remains failed at its oxlint allocator abort; the successful separate stages are not presented as a full CI run.

PR #44's first hosted full-suite run (`38470261533`, head `23e6a64`) passed. Check commands took 251.3 s and setup-inclusive time was 305.7 s; the job including cleanup took 319 s, above the five-minute target but inside both deadlines. Worker tests were the critical path at 244.8 s, with no Worker source or configuration changes in this PR. Other tests took 72.5 s, typecheck 19.5 s, app build 51.0 s and all 28 browser cases 97.7 s. The base main run had failed an existing Worker reconnect assertion, so its Worker result was unavailable for reuse. No pool size, cache input, test coverage or deadline changed. After rebasing, all 266 Mac tests passed in 1.61 s of execution.


## Agents cleanup test loading

M6's first hosted check (run `38481219598`) hit the unchanged 300-second command deadline: 332.3 s including setup, Worker 293.8 s, other tests 160.3 s and browsers 126.9 s. All 28 browsers passed; the Worker task was terminated at the deadline.

The Worker optimizer now also bundles the shared protocol/settings modules and the migration-only parser. The UI and component optimizers bundle Effect and the shared protocol. This changes dependency loading only; Worker limits stay four files/four cases, the UI/component limits stay two, the browser pool stays two, and all cases remain. A complete forced-task local benchmark passed in 89.4 s versus the previous 99.4 s: Worker 86.1 s (previously 96.6 s), other tests 48.2 s (52.1 s), browsers 39.0 s (43.8 s), typecheck 12.5 s and app build 13.2 s. Stage durations overlap. The complete optimized hosted check commands passed in 202.6 s (Worker 197.5 s, other tests 60.3 s, browsers 96.1 s) before a later commit superseded that job during cleanup. The final M6 PR check passed in run `38482734084`: 128.2 s including setup, 139 s with cleanup, with the Worker result reused and all 28 browsers executed in 60.7 s. No canceled workflow is counted as a complete workflow pass.

Final M6 main run `38483102400` passed: 292.2 s for check commands, 329.6 s including setup, 342 s including cleanup, Worker 284.7 s, other tests 146.8 s and browsers 119.6 s. This cold main run remains above the five-minute target despite the dependency-loading improvement; it passed the unchanged command/job deadlines. The final PR check above is under the target.

## Forge and issue tracking validation (2026-10-14)

The complete local workload with `CI=true TURBO_FORCE=true bun run ci` passed with task caches bypassed: 111.9 seconds for check commands and 112.0 seconds including the frozen dependency check. The installed toolchain and Chromium prerequisites were reused; this does not measure hosted runner provisioning. Worker tests took 108.8 seconds, other tests 58.4, browsers 42.1, typecheck 14.0, app build 14.5, daemon build 0.9, lint 2.8 and formatting 0.2. Stages overlap. All 1,007 Worker tests and 28 browser cases passed; UI model/components/protocol passed 365/178/363 cases. The four-file/four-case Worker limits, two-worker browser pool, single job and deadlines are unchanged.

Earlier attempts exposed temporary-filesystem exhaustion, an old migration fixture that accidentally included the new migration, and untracked WorkspaceDO queue/turn-end work during teardown. Temporary compiler caches were cleaned; the legacy fixture remains a true previous-release upgrade; complete asynchronous work now uses `waitUntil`. A controlled request-context regression fails without queue tracking. The final complete run above has no unhandled teardown errors. Rust validation separately passes 397 cases, including 276 Mac cases; the explicit pinned-image suite passes all 172 cases in 15.31 seconds of tests (46.60 seconds including startup and probes). These separate suites are not added to PR CI or presented as deployed acceptance.

## Agent issue tools validation

The complete local `CI=true TURBO_FORCE=true bun run ci` workload passed with caches bypassed: 119.0 seconds for check commands and 119.0 seconds in the setup-inclusive summary. Frozen installation was checked separately; installed toolchain and Chromium prerequisites were reused. Worker tests took 116.1 seconds, other tests 62.3, browsers 43.7, typecheck 13.8, app build 16.7, daemon build 1.2, lint 2.5 and formatting 0.2. Stages overlap. All 1,012 Worker cases, 365 UI model cases, 178 component cases, 364 protocol cases and 28 browser cases passed. Pool sizes, the single job and deadlines remain unchanged.

Four isolated Worker cases exercise agent issue CRUD, comment operations, project/author isolation, run access/identity checks, frozen tool permissions, credential redaction and bounded pagination. Existing issue and migration cases now cover guarded deletion, counter rollback, concurrent allocation without number reuse and legacy issue/comment preservation. Daemon coverage verifies MCP discovery, strict arguments and live session/run forwarding. The mobile prompt-contract case now waits for the chat menu's focus restoration before typing; its previous focus race reopened the menu on Enter. Five consecutive focused executions and the full browser suite pass without retries or timeout changes.

Separate checks pass all 648 generated outputs, 397 Rust cases (276 Mac) and strict all-targets Clippy. The updated pinned image is 4,061,880,709 bytes and passes all 173 daemon/image tests with 922 assertions in 12.00 seconds of test execution. The initial container run prevented test hooks from executing because its temporary mount was `noexec`; the successful run explicitly mounts executable temporary fixtures. Source remains read-only, the daemon/profile are installed in the image, and production image pins are unchanged. These checks do not establish hosted agent or Artifacts acceptance.


## Terminal transport validation (2026-10-14)

PR #53's first hosted check (`38587679509`) passed all 28 browser cases but hit the unchanged 300-second command deadline. Worker tests were interrupted at 291.7 seconds; other tests took 106.2 seconds, browsers 141.2, typecheck 30.0 and app build 60.9. Setup-inclusive time was 334.9 seconds. This is a failed run, not complete validation.

The Worker optimizer now bundles the existing Better Auth minimal initializer, Drizzle adapter, bearer and device-authorization plugins. Node crypto and async-hooks remain workerd built-ins. The six terminal transport regressions share the existing Worker unit suite rather than starting an additional Worker environment. All 1,030 Worker cases remain; the focused unit suite passes 382 cases. Four-file/four-case Worker limits, the two-worker browser pool, single job and deadlines are unchanged.

The complete local `CI=true TURBO_FORCE=true bun run ci` workload passed with task caches bypassed in 115.8 seconds for check commands and the setup-inclusive summary. Worker tests took 106.7 seconds, other tests 67.6, browsers 45.0, typecheck 17.0, app build 17.5, daemon build 0.9, lint 2.7 and formatting 0.3. Stage durations overlap. Installed toolchains and Chromium were reused; this does not measure hosted runner provisioning. The preceding authentication-only benchmark passed in 119.8 seconds with Worker tests at 113.4 seconds. All 28 browsers execute, including real terminal keyboard input and focus across tab switches. Separate native validation passes 415 Rust cases, the attached-PTY restoration case, strict all-targets Clippy and six packaging script cases; Linux validation does not establish macOS launch, Keychain or signed-bundle acceptance.

## Browser and non-Worker test reduction (2026-10-14)

Hosted runs spent 127–182 s on other tests and 90–111 s on browsers, so that chain
was nearly as long as the Worker suite. Runs where only `test:ui` and
`test:components` missed the cache still took 70–103 s for other tests; the component
suite alone took 39.5 s (35 s of module import) in a failed hosted log.

The browser stage drops from 28 to 15 cases. Removed cases duplicated lower layers or
another browser case: queue/edit/stop (workspace streaming case and composer
components), duplicate-Enter and failed-send recovery (composer components), live
announcements (transcript component and `messagesToAnnounce` unit tests), permission
Enter (permission component and the streaming case), new workspace and both new-chat
cases (new-workspace and workspace-composer components), desktop review/file
navigation (phone review and file-dialog cases), and the draft/title case (draft
mention reload and sleep/archive live updates). The new-chat case's lazy model
discovery assertion moved into the draft-mention case. Three phone repeats and the
dark-default theme project were removed; the phone navigation case now asserts the
tab picker returns focus. The desktop terminal case now opens its second terminal as
an outer `Terminal 2` tab; it still used the removed inner terminal tab list and
timed out. Fixture builds moved to the App build step (20–33 s of browser-stage
startup on uncached hosted runs).

The Codex device-login component test used the response's one-second poll interval
and waited three seconds; the fixture now returns a 10 ms interval. Daemon Git tests
copy one seeded origin per process instead of running nine Git commands per origin.

Local macOS measurements, on a machine shared with another test workload (load
average about 6), with Chrome rather than the bundled Chromium: browser cases took
11.0–12.1 s wall and 13.5 s of case time (previously 23.2 s for 27 passing cases plus
the timed-out terminal case). Components took 6.8–7.6 s (previously 9.8 s; the Codex
file 3.0 s to 0.09 s). Daemon tests took 16.6–20.2 s (previously 19.7–21.4 s). These
are not hosted results; pool sizes, the single job and deadlines are unchanged.

## Worker suite reduction (2026-10-14)

The Worker suite exceeded the 300-second check deadline on the hosted runner (225–293 s). Local wall time fell from 35–38 s to 16–18 s, and sequential test time from 90 s to 48 s.

- **Four files.** `ops`, `workspace-rpc`, `workspace-events` and `platform` are the only `*.test.ts` files, so all four Worker slots start at once and the per-file workerd startup is paid four times. Other modules are `*.cases.ts`, each imported inside its own `describe` so its hooks (fetch spies, `restoreAllMocks`) stay scoped to it.
- **Retry timing.** `WorkspaceCore.retryDelayScale` (default 1) scales reconnect delays, bundle and artifact upload backoff and the health poll. Tests set it per workspace with `fastRetries(stub)`; production values are unchanged. Deadline cases move the clock instead of waiting.
- **Setup.** RPC cases that need only a ready workspace use `seedReadyWorkspace`; create, wake, archive/restore and errored-workspace groups run concurrently. Cases that spy on `Date.now` or the GitHub provider stay in small sequential groups.
- **Deleted cases (covered elsewhere):** archive and restore RPC duplicates of the ops cases; four errored-workspace read calls that share one readiness guard; sendPrompt and wakeWorkspace from error; two of four identical turn.ended stop reasons; a failed-setup queue case covered by the setup.run and continueAfterSetupFailure cases; an agent.exited duplicate; the branch-source clone variant; a wake snapshot variant; and the two harness smoke checks.
