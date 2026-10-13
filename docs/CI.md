# CI runtime and test value

PRs have a **five-minute total runner budget**, not five minutes per parallel job.
The single `check` job runs all local checks, builds, and browser regressions.
`bun run ci` reports stage durations to the Actions summary and fails after 270
seconds including checkout, dependency setup and Chromium installation. The job
has a five-minute timeout, reserving the last 30 seconds for cache saves and
cleanup. Do not raise the limits to accommodate regressions. Cancel superseded
runs instead of paying for outdated commits.

Dependencies, Chromium and deterministic Turbo task results are restored between
runs. Dependency installation still uses the frozen lockfile. Turbo hashes package
sources, transitive dependencies, root TypeScript configuration, Bun configuration
and dependency patches. Image tests have a separate `TEMPO_IMAGE_TEST` hash. Live
agent/deployment tasks are never cached. Builds used by CI still execute, and
browser fixtures build before previewing to avoid development-server transform
costs. A cache miss must also fit the budget.

## Test audit

The audit retains the following distinct responsibilities. Test counts alone are
not a quality target.

| Suite | What it proves | Where it runs |
| --- | --- | --- |
| Protocol fixtures and schemas | Wire decoding, validation and shared-client compatibility | Every PR |
| Settings and cities | Settings layering, invalid input and collision-free slugs | Every PR |
| Daemon Bun tests | Real filesystem, git, subprocess, WebSocket, ACP mapping, bounds, credentials and shutdown behavior with fake agent processes | Every PR and image checks |
| Worker unit tests | Egress/security decisions, crypto, transitions, limits and parsers | Every PR in workerd |
| Worker integration tests | Durable Object/D1/R2 behavior, RPC failures, idempotency, migrations, recovery and event ordering | Every PR in workerd, with storage isolation |
| UI model tests | Stores, parsing, drafts, shortcuts and view-state decisions | Every PR in Node |
| Component tests | DOM interaction, rendered states and accessibility contracts | Every PR in happy-dom |
| Web client browser tests | Shell integration, RPC contracts, keyboard, persistence, mobile navigation and rendering | Every PR in desktop and phone Chromium |
| Dark appearance browser test | Actual theme application, persistence and system media changes | Every PR; replaces duplicating every functional scenario in dark mode |
| Workspace browser regressions | Streaming reloads, hidden-panel shortcuts, draft mentions, phone overflow, transcript scroll, closed chats and blocked storage | Every PR, independent browser contexts |
| Deployment script tests | Preflight outcomes and isolation of the pinned Alchemy patch | Every PR |
| Image tests | Image tools, uid, tini and orphan reaping | Main pushes and manual image workflow |
| Hosted acceptance and adapter conformance | Real deployment/login and installed agent behavior | Explicit acceptance commands, outside the local PR suite |

The port-scanner integration test now requires a scan and the listener's port;
it previously passed when the scanner returned nothing. All app Vitest projects
require assertions. Browser fixtures fail on unexpected calls and runtime errors.
The complete dark functional matrix added no theme-specific assertion; a focused
theme test now provides that coverage. Hosted and conformance tests no longer
start in local CI merely to skip for missing deployments or binaries. Their
explicit commands and acceptance gates remain available.

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
5. Fix flaky tests without retries. Preserve isolation. Never remove security,
   failure, idempotency or migration coverage to meet the budget.
6. Use the CI timing summary to identify the slow stage. Changes to tests or CI
   must report timings and stay within the total budget, including cold setup.
   If cold CI misses the target, optimize the bottleneck before merging.
7. Skipped external suites do not establish acceptance. Run their explicit commands
   in the appropriate environment when their contracts or adapters change.

The removed standalone `web` job is now part of `check`. If branch protection
requires `web`, update the required check to `check` when adopting this workflow.
