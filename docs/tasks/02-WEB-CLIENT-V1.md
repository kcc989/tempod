# Goal 2: complete the Tempo web client

## Objective

Complete the entire browser client for Tempo's agent workspace product. Make all regions, dialogs, settings, actions, live state and browser acceptance meet the UI specification. Deliver working user journeys and evidence, not just components or screenshots.

This is one of exactly three parallel goals: **core**, **web client**, and **Mac client**. Core owns server behavior, shared contracts and integration. You own the complete browser client. The Mac agent owns native parity. There is no separate fourth coordinator.

## Start in the cloud

- Repository: [kcc989/tempod](https://github.com/kcc989/tempod).
- Integration branch: `claude/great-franklin-xc39l8`; [existing PR #1](https://github.com/kcc989/tempod/pull/1).
- Published reference at preparation: `63761dea83a7456addfeae18f88886309edc0e78`. Fetch the branch; do not assume this reference is still the latest commit.
- Use the repository connected to your cloud task, or clone it into an isolated cloud checkout. Agree on a starting commit with the other agents and use your own `codex/` task branch. Do not use their checkout or unpublished changes.
- No access to the original author's computer, local worktrees, browser session, Colima engine or local logs is required. Use your cloud runner and produce fresh evidence.

Read [AGENTS.md](https://github.com/kcc989/tempod/blob/claude/great-franklin-xc39l8/AGENTS.md), [PROGRESS.md](https://github.com/kcc989/tempod/blob/claude/great-franklin-xc39l8/docs/PROGRESS.md), and [IMPLEMENTATION_NOTES.md](https://github.com/kcc989/tempod/blob/claude/great-franklin-xc39l8/docs/IMPLEMENTATION_NOTES.md). Read [spec tabs 00–07](https://github.com/kcc989/tempod/tree/claude/great-franklin-xc39l8/docs), especially tab 04's full UI requirements, tab 02's contracts, tab 03's lifecycles, tab 05's security rules and tab 06's acceptance gates. Tab 07 defines native parity and intentional differences.

## Ownership

Own browser components, browser pages/routes, client hooks and state, browser styling, responsive behavior, UI tests and browser acceptance tests. Existing web regions have substantial implementations; inspect and finish them instead of replacing working features without evidence.

Core owns server functions, API handlers, auth logic, Durable Objects, migrations, daemon/container behavior, shared wire schemas and generated contracts. Do not create private wire types or patch server behavior in a client workaround. Send core an exact contract/failure requirement with reproduction evidence. Coordinate routes that mix page rendering and server handlers, shared manifests, lockfiles, CI and shared progress edits. The Mac agent owns all native implementation.

## Required work

1. Audit every tab 04 requirement against the current browser app. Build a coverage matrix for implementation, automated evidence and manual/live evidence. Finish missing behavior and fix faults found in existing regions.
2. Complete sidebar indicators, hover cards, menus, sorting, sections and History; the top bar's state-dependent primary actions, status pill, branch/port links and lifecycle/git menus; and all specified window/panel persistence.
3. Complete chat creation, rename, close confirmation and closed-chat reading; every transcript item kind; streaming and scroll behavior; permissions; model/mode controls; attachments, mentions, slash commands, review-comment chips and saved drafts.
4. Preserve queueing and live steering as separate actions. Enter queues during work; queued messages support edit, delete and reorder. **Send now** is available only for a supported active chat and injects without stopping its turn. Show pending delivery, fallback and uncertain-delivery states correctly; never lose a draft or silently resend uncertain text.
5. Complete Changes, Diff, review comments, viewed marks, All files, file tabs, file picker/search, Checks and browser/preview behavior defined for the web. Finish Setup, Run and remote Terminal tabs with real channel data, reconnects and specified shortcuts.
6. Complete New workspace, Add project, all web Settings sections, Devices, Diagnostics, first-run/GitHub setup and device approval pages. Implement the web-to-Mac opening flow and required version/download presentation using core's contracts.
7. Complete all shortcuts, accessible keyboard/focus behavior, notifications, tab-title attention count, empty/loading/error states and phone layouts. Verify long content, multiple workspaces, archived/closed views and disconnected sessions.
8. Run actual browser journeys with core's authorized test environment: sign in, add a repository, create a workspace, read streamed output, answer a permission, queue/steer/cancel, review and send comments, commit/push, create/merge a PR, use scripts/terminal/previews, sleep/wake and archive/restore. Exercise reload and failure recovery, not only the happy path.

## Rules and verification

Follow repository instructions and the pinned stack. Wire types live only in the shared protocol package. Never render raw agent HTML or load remote images from agent Markdown; use the specified safe links and inline ACP media rules. Keep secret values out of snapshots, logs and reports. Ask before adding libraries and pin approved versions. If behavior must change, update tab 04 and coordinate the matching Mac change in the same phase. Ask about silent or conflicting spec requirements rather than inventing them.

Run root `bun run typecheck`, `bun run lint`, `bun run test`, `bun run format:check` and applicable builds. Add meaningful component/state/browser regressions for changed behavior. Read the installed Turbo documentation before changing orchestration.

Use the [e2e setup guide](https://github.com/kcc989/tempod/blob/claude/great-franklin-xc39l8/tests/e2e/README.md). Verify the specified Chrome, Safari and Firefox shortcuts and phone journey. Record real browser evidence, environment/commit and acceptance IDs. Gates B–D require each included acceptance test to pass three consecutive runs in a deployed test environment with real logins, plus required manual/security proof. Coordinate test-environment use with core; do not run conflicting destructive fixtures against the same project.

Prepare test setup and browser work independently of missing credentials. Deployment, production changes, account choice and paid agent evaluations require explicit authorization. Private-preview/Browser Run design proposals are pending owner decisions; do not silently adopt them.

## Deliverable and completion

Deliver commits and an integration-ready diff on your task branch. Return a standalone Markdown report named **WEB-CLIENT-RESULTS.md** with starting/final SHA, UI/spec changes, commands/results, browser screenshots or recordings where safe, environment URLs, acceptance IDs, repeated-run evidence and exact remaining blockers. Use GitHub/HTTPS references, not local file links. Publish or merge only within explicit task authorization.

The web goal is complete only when the full specified browser product works and the required acceptance is proved. Green unit tests, a screenshot, a skipped suite or a list of blockers do not meet that standard. Continue independent work and identify the precise input needed for anything still unverified.
