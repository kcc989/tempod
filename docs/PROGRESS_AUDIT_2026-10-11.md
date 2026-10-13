# Tempo v1: done and to do

Updated 11 October 2026, 17:38 EDT, from the current local source and saved check results.

**The server and web app are substantially implemented. The Mac app can sign in and now has local workspace/chat wiring, but many native features still need to be built. The full product has not passed hosted acceptance.**

This report stands on its own. “Built” means the feature has code and wiring; it does not mean it has passed real-account acceptance. “In progress” means current local work is not yet published or fully checked. “To build” means a required implementation is missing or is a placeholder. Live verification is listed separately so completed implementation is not confused with a finished release.

## Done: shared platform and server

These parts have implementation and local test coverage:

- **Project foundation:** Bun workspace, builds, TypeScript checks, lint, formatting, pinned versions and GitHub CI.
- **Shared contract:** protocol types, 63 API functions, WebSocket messages, generated Rust types and cross-client fixtures.
- **Workspace engine:** create, wake, sleep, archive, restore and delete operations; operation retries; task queue; events; stored workspace state; live channels.
- **Agent daemon:** ACP v1 sessions for the four supported agents, prompt/cancel and permission handling, scripts, logs, git checkpoints, file watching, settings, port discovery and preview proxy.
- **Credentials and security:** credential encryption, outbound request rules, controlled token injection and secret redaction helpers.
- **GitHub integration:** App setup, installation tokens, repository access, branches, push, pull requests, checks and webhook handling.
- **Authentication:** web login, owner checks, bearer tokens, device approval and native API routes.
- **Container:** pinned tools and image, user identity, tini process cleanup, daemon image tests and deployment configuration.
- **Shared settings:** precedence, settings sources and workspace names.

**Still to do for these parts:** real cloud validation, restart and recovery checks, a fresh daemon/spec review, and fixes found during those checks. There is no evidence in this audit of a release accepted against real Cloudflare, GitHub and agent accounts.

## Done: web app implementation

The web app has working code paths for the main product regions. These are not blank shells.

| Feature | Built |
| --- | --- |
| Workspace shell | Desktop and phone layouts, resizable panels, saved layout, loading/error states and workspace banners. |
| Sidebar | Projects, workspace rows, sorting, collapsed sections, pinning, status indicators, hover cards, context menus and workspace actions. |
| Top bar | Title edit, branch controls, base-branch picker, port links, state pill, primary action and overflow menu. |
| Git actions | Commit/push, create PR, merge, wake/sleep, archive and restore. |
| Chat | New, renamed and closed sessions; transcript item renderers; tool output, plans, permissions, handoff and revert markers. |
| Composer | Prompt/cancel, mode/config controls, file attachments, mentions, queued-message editing/deletion/reorder, drafts and review-comment context. |
| Changes and diff | Change scopes, file tree, split/unified diff, review comments, viewed marks and commit controls. |
| Files and search | File reads, highlighting, file picker and content search. |
| PR checks | Check runs, PR refresh and open-PR data. |
| Workspace preview | Browser tab with iframe, address entry, reload and open externally. |
| Processes | Setup retry/continue, run-script start/stop/history and xterm terminal channels with input, resize and reconnect handling. |
| Dialogs and Settings | New workspace, Add project, Logins, Project, Appearance, Notifications, Devices, Shortcuts, Diagnostics and first-run checklist. |
| Global behavior | Shortcut registry, browser notifications and attention indicators. |

**Web work still to do:** verify each row in a running product with real data. The current automated component coverage is limited; it does not establish complete UI acceptance. Run the full journey, check phone layouts, keyboard/focus behavior, browser compatibility and error recovery, then fix the failures found. This audit did not find evidence that all those checks have passed.

## Done and in progress: Mac app

### Built and published

- GPUI app/window foundation, menus, key bindings and protocol generation.
- Real client runtime, API calls, channels, reconnect handling and shared state stores.
- Device sign-in, approval/denial/cancellation handling and saved-session validation.
- Unauthorized-session cleanup and sign-out, including cleanup when server sign-out fails.
- Live hub data feeding the workspace sidebar and Dock attention count.
- Safe workspace file-link parsing and transcript image/HTML protection.
- Real macOS Keychain, notification, Dock and wake helper implementations.
- Local storage and logging modules, including atomic storage, rotation and redaction tests.

Platform helpers still need manual verification in the running app. Their presence does not prove that every notification, URL or window-state flow is complete.

### Built locally; not yet published

Current shared working-tree changes add:

- Live workspace channels, revision-based reconnect, hidden-workspace socket timers and reconnect/error views.
- Chat session selection, new-session controls and closed-chat viewing.
- Transcript rendering and basic prompt, stop, plan-mode and permission controls.
- Draft retention when sending fails; draft clearing after a successful response.
- Queued-message editing, deletion and drag reorder.
- A “Send now” control for agents that advertise steering support.

The latest saved native test run passes **176 tests**, including prompt/draft handling, queue controls, focused permission keys, workspace channel fixtures and the steering UI request. Clippy also passes. These local changes have not reached the published branch, and tests against a local fake server do not prove real agent behavior.

## To build: Mac app

These are concrete implementation gaps, not just acceptance tasks:

| Area | Work required |
| --- | --- |
| Changes | Replace the placeholder with change scopes, file tree and commit controls. |
| Diff | Build split/unified views, comments, viewed marks, file navigation and draft-comment delivery. |
| Files | Build file reading/highlighting, file picker and content search. |
| Checks | Show live PR checks and their refresh/error states. |
| Setup | Show setup output, history, warnings, retry and continue controls. |
| Run | Build script selection, start/stop, default-run behavior and output/history. |
| Terminal | Implement the terminal crate and native view; connect input/output/resize/reconnect, selection, copy and scrollback. |
| Preview | Add the native workspace preview route and controls. |
| Top bar | Connect primary git actions, branch controls, ports and overflow actions. The current primary button is presentation only. |
| Sidebar/history | Complete menus, indicators, workspace actions, history and Add project behavior. |
| Chat controls | Complete rename/close actions and agent/model/config pickers, attachment upload, mentions, commands and remaining transcript actions. |
| Dialogs | Build New workspace, Add project, command palette, diagnostics and first-run flows. |
| Settings | Build Logins, Project, Appearance and Notifications. Only the shortcut table currently has content. Devices is web-only. |
| State and platform | Finish app-wide persistence and platform wiring; verify window restore, notification actions, URL handling and wake recovery. |
| Updates | Connect scheduled update checks, required-update UI and download verification. Version/hash/save helpers alone are not a complete updater. |
| Distribution | Add release scripts and assets, package the app, sign, notarize and test clean install and upgrade. |
| Acceptance checklist | Create and run the native manual checklist, performance checks and platform acceptance tests. |

The seven native Changes, Diff, Files, Checks, Setup, Run and Terminal panels still render skeletons. The terminal crate, dialogs and command palette remain placeholders.

## In progress: send a message during a running turn

Local changes span the protocol, database, Worker, daemon and both clients. They advertise adapter support and can send a new message into the active turn instead of always queueing it. The implementation includes duplicate-delivery protection and handling for uncertain acknowledgements.

Native UI tests have passed. Worker and daemon tests have been added, but the latest complete JavaScript result read for this report predates this change. **Treat the server/adapter behavior as in progress until its new suites and real-adapter checks pass.**

## To verify before v1

1. **Infrastructure feasibility:** complete the missing cloud and adapter spike results. Only three spike documents exist: protocol compatibility has local proof; transcript performance and native terminal feasibility are partial. The native performance target still needs measurement on an M1.
2. **First real environment:** provision the required Cloudflare resources, configure the GitHub App and authenticate real agents. Run a first deploy and smoke test.
3. **Workspace recovery:** test a real workspace coordinator restart with a closed daemon socket, container loss, sleep/wake, archive/restore, snapshot failure and queued-turn recovery.
4. **End-to-end web journey:** sign in, add a project, create a workspace, run an agent, answer permissions, review changes, run scripts/terminal/preview, open a PR, then sleep and restore.
5. **Security and data safety:** verify real outbound rules, token injection, secret redaction, backup contents, preview protection and diagnostics.
6. **Both-client acceptance:** run the specified browser and native checks, including shortcuts, focus, reconnect, empty/error states and accessibility. Complete the repeated successful runs required by the release gates.
7. **Native release acceptance:** verify Keychain, notifications, Dock, wake, URL handling, signed installation and updates on a real Mac.

The 44 deployed e2e tests and 40 adapter conformance tests were skipped in the saved local runs. They do not count as passed release criteria.

## Decisions still required

- **Revert safety:** decide whether a revert must fail if its safety checkpoint cannot be created. The current implementation notes permit continuing with a warning, while the spec also promises data protection.
- **Protected previews:** choose the protection design and complete its implementation. The existing iframe/preview proxy does not close this decision.
- **Optional Browser Run:** decide whether remote browser control and Live View are required for the first release. Their protocol fields are still undefined. This is separate from the existing workspace preview tab.
- **Updater hash contract:** define how the Mac client receives the trusted download hash; its metadata contract currently lacks that field.
- **Remaining spec conflicts:** settle the recorded package/runtime differences and remaining product questions before accepting affected behavior.

Tini and the React test libraries are already approved and implemented. They are not pending decisions.

## Latest check evidence

| Evidence | Result and scope |
| --- | --- |
| Published code | Commit `d59b273` on PR #1. Local workspace/chat and steering changes are not included. |
| GitHub CI | Successful for `d59b273`; freshly checked for this report. |
| Native tests | 176 passing tests; saved run finished at 17:36 EDT. |
| Native Clippy | Passed; saved run finished at 17:36 EDT. |
| JavaScript tests | Latest complete saved run at 17:26 EDT: 713 Worker, 294 UI logic, 14 component, 201 protocol, 109 daemon, 9 settings and 3 cities. Predates the new server steering work. |
| Typecheck/lint/build | Saved successful runs at approximately 17:36–17:37 EDT. Continued edits can invalidate these results. |
| Container tests | 112 passing tests in the earlier local image run at 17:00 EDT. Not rerun after the latest daemon changes. |

This report used read-only source inspection and existing logs. It did not start new suites, deploy or run live acceptance. The shared source is changing during development; these results are a dated snapshot, not a claim that every current file has passed every check.

## Next milestones

1. Finish and publish the current native chat and steering work after all affected checks pass.
2. Complete cloud feasibility and run the first full hosted web journey.
3. Build the missing native review, process, terminal, dialog and settings features.
4. Close security, recovery and both-client acceptance gates.
5. Complete native distribution and update acceptance.

**Current readiness:** substantial web/server implementation; incomplete native implementation; full v1 acceptance still open. There is not enough live evidence to give a reliable release date or completion percentage.

## Evidence links

These links are optional supporting detail; all status and remaining work are stated above.

- [Published PR](https://github.com/kcc989/tempod/pull/1) and [successful CI](https://github.com/kcc989/tempod/actions/runs/38175391278).
- [Web workspace](../apps/tempo/src/ui/components/shell/WorkspaceLayout.tsx), [review panels](../apps/tempo/src/ui/components/review), [process panels](../apps/tempo/src/ui/components/processes) and [dialogs](../apps/tempo/src/ui/components/dialogs).
- [Native workspace/chat](../apps/mac/src/views/workspace.rs), [native views](../apps/mac/src/views), [terminal crate](../crates/tempo-terminal/src/lib.rs) and [update helpers](../apps/mac/src/update.rs).
- [Worker queue](../apps/tempo/src/do/workspace/queue.ts), [agent session](../packages/tempod/src/acp/session.ts) and [API contract](../packages/protocol/src/api.ts).
- [Spike results](../spikes), [hosted test limits](../tests/e2e/README.md) and [release gates](06%20Build%20Plan.md).
