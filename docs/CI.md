# CI runtime and test value

PRs target **under five total runner minutes**, not five minutes per parallel job.
The single `check` job runs all local checks, builds, and browser regressions for
code changes. Documentation-only changes keep the same required `check` job but
install the pinned tooling dependencies and run lint and formatting without Chromium.
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
installation. Each run/attempt has a distinct archive key. Chromium is keyed by
the installed Playwright version rather than unrelated package script changes.

The daemon build and production app CI build are cached. `build:ci` fixes the app's
Wrangler configuration to the checked-in default and restores both `dist` and the
Wrangler deployment pointer. Its inputs include transitive workspace sources,
built-in roles, container configuration, local environment files and build-time
environment values. Generated Wrangler metadata contains absolute paths, so the
checkout directory is part of this task's hash. The general app `build` remains
uncached because it permits arbitrary external Wrangler configuration paths.
Browser fixture builds have separate cached outputs (`test/web/dist` and
`test/browser/dist`); both browser suites still execute against restored or freshly
built artifacts before previewing to avoid development-server transform costs. Worker tests prebundle Effect and Drizzle (including their used subpaths)
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
| Dark appearance browser test | Actual theme application, persistence and system media changes | Every code PR; replaces duplicating every functional scenario in dark mode |
| Workspace browser regressions | Streaming reloads, hidden-panel shortcuts, draft mentions, phone overflow, transcript scroll, closed chats and blocked storage | Every code PR, independent browser contexts |
| Deployment script tests | Preflight outcomes and isolation of the pinned Alchemy patch | Every code PR |
| Image tests | Image tools, uid, tini and orphan reaping | Relevant main pushes and manual image workflow |
| Hosted acceptance and adapter conformance | Real deployment/login and installed agent behavior | Explicit acceptance commands, outside the local PR suite |

The port-scanner integration test now requires a scan and the listener's port;
it previously passed when the scanner returned nothing. The idle-sleep test now asserts daemon shutdown and container destruction with an
open UI socket. All app Vitest projects require assertions. Browser fixtures fail on unexpected calls and runtime errors.
Eight repeated phone scenarios now execute only on desktop. Four phone web cases
cover the tab picker/draft persistence, upload chips, project creation and touch
navigation/settings. A separate iPhone touch regression covers the composer,
permission approval, review and narrow-screen overflow. All general RPC, failure,
announcement, git-lifecycle, sleep and theme cases remain covered on desktop.
The complete dark functional matrix added no theme-specific assertion; a focused
theme test now provides that coverage. Hosted and conformance tests no longer
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
`bunx` after the frozen dependency installation needed by the anti-slop plugin,
and publishes its mode/timings. Workflow-level path
ignores are not used, so a required check never stays pending on a docs-only PR.

## Rules for future changes

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

The removed standalone `web` job is now part of `check`. If branch protection
requires `web`, update the required check to `check` when adopting this workflow.

## Workspace tool regression (2026-10-13)

One desktop browser case protects independent chat/draft selection while files and Browser Run share the right tool area, including closing the active tool to the launcher. The existing desktop terminal case now opens Terminal from that launcher. Both browser suites use a shared test helper that honors Chromium client-hint platform data before the legacy platform field, matching the app's shortcut rule. Pool sizes, cache inputs and deadlines are unchanged.

Local macOS measurements: web cases took 9.6 seconds including one temporary visual-capture case (19 permanent cases); workspace browser regressions took 5.6 seconds (9 cases). UI model and component stages previously took 1.5 and 7.1 seconds in this checkout. These are local stage measurements, not a complete CI pass. The baseline cold CI run above remains 4m00s total. Cleanup resolved the initial 20 GiB free-disk gate. The Linux CI attempt then stopped in oxlint's allocator with SIGABRT: 2.2 s for check commands and 3.0 s including setup, with lint at 1.5 s. This failed partial run is not a full CI result. Source lint passes on macOS; separate Linux typecheck passed in 24.8 s. The complete root Linux test command passed: Worker tests took 118.7 s, other test tasks 130.0 s, followed by 13 root script tests in 3.2 s. Those overlapping stages are not additive.

The final Mac suite passed 264 tests in 5.45 seconds of test execution. Its native surface tests assert visibility after paint, pane hide/restore and deferred-popup hide/restore through an observable surface boundary. They do not establish native visual acceptance or hosted Browser Run acceptance.

The production app CI build task also passed locally on macOS in 4.1 seconds. The complete Linux CI command remains failed at its oxlint allocator abort; the successful separate stages are not presented as a full CI run.
