# Progress

Status of the Tempo build against the spec (tabs 00 to 07). Continuation started 2026-10-11 on `claude/great-franklin-xc39l8` ([PR #1](https://github.com/kcc989/tempod/pull/1)), from `dadd62d`. PR #1 is now merged; native chat controls continue on `codex/native-chat-controls` from merged main `1984b89`.

Percentages below are the previous build loops' estimates, not new acceptance measurements. Deviations and open questions are in `IMPLEMENTATION_NOTES.md`. The web continuation now has a separate [acceptance record](WEB_ACCEPTANCE.md).

## Current state

- **Web continuation (2026-10-11):** all four web regions are implemented in the existing source. Added local Playwright acceptance with production components, protocol-checked RPC fixtures and intercepted client WebSockets. CI now runs desktop Chromium, Firefox and WebKit, dark Chromium and phone Chromium. This is local browser evidence; hosted gates remain open.
- **Web verification:** after integrating main `5e259d6`, 59 styled local browser cases and 21 existing workspace browser regressions pass; 6 device-specific cases skip intentionally. Root typecheck, lint, unit tests, format check, version check and production build pass in this Linux workspace.
- **Web integration:** preserved the draft recovery, pending-send guard, chip metadata, scrolling and navigation fixes merged in PR #3. Added a guard so the initial transcript backlog does not announce as new activity, plus a matching native pending-send regression (formatted with pinned Rust 1.97; not executed in this Linux workspace).
- **Hosted test project:** inspected `kcc989/keeled` at `ffee1fa`. It needs a `pull_request` CI workflow for AT-17. Cloudflare credentials are configured, but the environment denies the configured app host. No first deployment, real login or hosted gate was started.

- **Continuation is active.** The prior loops stopped at the account usage limit; their interim code is now being checked locally on macOS.
- **Verified locally:** `bun run typecheck`, `lint`, `format:check`, `check:versions`, `test` and `build`. Tests: 717 Worker, 294 UI logic, 16 component, 201 protocol, 111 daemon, 9 settings and 3 cities. The 44 deployed e2e tests and 40 adapter conformance tests skip without their environment; these are not acceptance evidence.
- **Native baseline:** `cargo test --workspace` (189 tests), `cargo fmt --check`, and `cargo clippy --workspace --all-targets -- -D warnings` pass on this Mac. Workspace channel/cache/reconnect fixtures and headless chat, queue, steering, permission, picker, close-control, slash-menu and file-mention tests are included.
- **Image verification:** the prior full image run passed 112 tests, including uid/gid 1000, tini as PID 1, adapter/tool presence and orphan cleanup. The final daemon production image builds at 1,715,653,040 bytes (under 6 GB). Current Linux test evidence is recorded below.
- **Steering image tests:** 114 tests pass in the full derived Linux image with current daemon/protocol source and tests mounted read-only. The first image run captured older test fixtures while edits continued and failed the two new steering tests; the final run uses the corrected fixtures. This is local fixture evidence, not authenticated adapter acceptance.
- **Remote CI and deployment:** GitHub CI passed `408f985`, `fd92d37` and native sign-in `d59b273` (4m10s). The workspace/steering milestone `63761de` also passed (3m47s). Native chat-controls commit `55d0c36` passed (4m12s). The slash-menu follow-up needs its own remote check. Gate A and the hosted acceptance gates remain open. No deployment or paid evaluation has been started.

## Continuation changes

- Fixed formatting in 67 source/config files; excluded generated `worker-runtime.d.ts` from Oxfmt, as with the generated route tree. Kept the Turborepo-managed agent guidance block.
- Fixed the daemon test helpers on macOS: canonical temporary paths and process-state checks through `ps` (Linux still uses `/proc`). All 109 daemon tests pass on the host.
- Isolated the intermittent UserHubDO load-once regression from the live WorkspaceDO startup publisher. The fixture is now D1-only and asserts that the first message is `hello`.
- Fixed the daemon build output glob to cache the root `dist/tempod` binary.
- Fixed the container uid conflict: the pinned Node base already owns uid/gid 1000, so the image renames that account to `tempo` rather than trying to create it again. Updated 01's Dockerfile example.
- Added a test image derived from the complete workspace image, a pinned-arguments test command, a secrets/cache-excluding Docker context, and a main/manual image-test workflow. Production still uses `container/Dockerfile`.
- Added owner-approved pinned `tini` to launch the daemon and reap orphaned children. Updated 01; image tests check uid, PID 1 and orphan reaping.
- Added owner-approved pinned `happy-dom` and `@testing-library/react`, with 14 passing component tests for permission keyboard controls, focus, read-only chats, saved answers, safe Markdown and file links.
- Fixed workspace file links in both clients: decoded filenames work; malformed escapes, invalid UTF-8, controls and invalid path segments are ignored. Spec 04 and 07 now state these rules.
- Connected the Mac app to the real two-thread I/O runtime. Wake events reconnect its channels; unauthorized and incompatible-client signals reach AppState. Added native device sign-in, saved-session validation, server sign-out and channel cleanup. The hub channel now feeds the sidebar and Dock count.
- Connected native workspace channels, revision resume, 60-second hidden-store cleanup, chat tabs, draft persistence, prompt/Stop/plan-mode/permission RPCs and rich transcript rows. Static transcript spike windows still work. Headless tests cover successful and failed sends, queued edits/deletion/reordering, steering dispatch and permission keyboard replies.
- Added owner-requested live steering in web and Mac: Enter queues; supported running chats also offer Send now. The ACP v1 extension is capability-gated and uses host-owned idle fallback. A durable reservation prevents automatic duplicate delivery after an uncertain acknowledgement or DO restart. Specs 01–04 and 07 describe the new fields and behavior.

- Added native agent-reported model and mode pickers, grouped model labels, chat close buttons and confirmation, and chat/model/tool shortcuts. A running chat waits for its turn to stop before closing; cancellation failures and a 30-second timeout leave it open. Failed configuration restores the saved selection. Pickers stay disabled while starting, working or awaiting a configuration response. Six new headless tests cover these controls and failures; manual UI acceptance remains open.
- Added native `/` command selection with fuzzy filtering, agent descriptions, keyboard navigation and Tempo plan mode. Selection keeps the text after the caret; Escape dismisses the menu without stopping the agent. Three new tests cover UTF-8 boundaries, command identity and keyboard behavior. Specs 04 and 07 now state menu keyboard priority.

- Added native file mentions with the existing `listFiles` RPC, fuzzy matching, loading/error/empty states, Retry and removable chips. Queue and live steering include mentions. Four new tests cover matching, keyboard selection, text preservation, request payloads and failed-send retention. Attachment input and manual native acceptance remain open.

- Added GPUI Kit headless tests with its existing pinned test-support feature. Eight app tests cover saved-session validation, device approval/denial, cancellation, 401 cleanup, update requirements, server sign-out failure and Enter in the connect form. Tokens use a memory store in tests; real Keychain/browser acceptance remains open.

## Summary

| Area | Spec | Done | State |
| --- | --- | --- | --- |
| Monorepo, tooling, CI | 06 | 85% | Turborepo + Bun, TS 6.0.3, oxlint, oxfmt, CI workflow. Local format check and published CI pass. |
| `packages/protocol` | 02 | 95% | Effect Schema wire types, 63 API functions, channels, tempod envelopes. JSON Schema and fixtures are generated and checked; format check passes. |
| `packages/settings`, `packages/cities` | 01, 03 | 100% | Done and tested. |
| `tempod` daemon | 01 | 90% | Built; 109 tests pass. |
| Worker: Durable Objects and ops | 01, 03 | 82% | Interim review fixes pass local Worker tests; live restart validation pending. |
| Server functions | 02 | 95% | All 59 functions from 02 exist. |
| Egress (`TempoOutbound`) | 01, 05 | 95% | Rules 0 to 10 built and tested. |
| Auth and GitHub App setup | 05 | 92% | Built; not checked against real GitHub. |
| Native API for the Mac app | 07 | 90–100% | `/api/v1/*`, bearer WebSocket auth, `/downloads/mac`. |
| Container image and deploy | 01, 05 | 85% | Dockerfile, versions.json, Alchemy + wrangler deploy. |
| Web UI | 04 | implemented with contract gaps | Regions are present; local browser acceptance added. Historical usage, closed PR titles, attachment retrieval, hosted gates and macOS shortcut verification remain. |
| Tempo for Mac | 07 | partial | Device sign-in, hub/workspace channels and chat/queue/steering actions wired locally. Native review/process panels and acceptance remain. |
| Private previews + Browser Run | 00 Q3, 01 | design | Research done; decision brief not written. |
| Spikes S1–S16, acceptance tests AT-1–AT-37 | 06 | 0% | Need a Cloudflare account on Workers Paid and real agent logins. |

## Done

**Repo and tooling**
- Bun workspaces with Turborepo, TypeScript 6.0.3, oxlint 1.87, oxfmt 0.72.
- `.github/workflows/ci.yml` runs check:versions, typecheck, lint, format:check, test, build:tempod and the app build.
- `AGENTS.md` (rules 1 to 17), with `CLAUDE.md` as a symlink to it.

**Shared packages**
- `packages/protocol`: ids, enums, errors and `Result`, ACP types, settings, shared types, channels, tempod protocol, API contract, redaction.
- `packages/settings`: precedence, sources, Conductor mapping.
- `packages/cities`: slugs.

**tempod (01).** Everything in 01 is built:
- the outbox with coalescing;
- ACP v1 sessions for the four agents;
- scripts and logs;
- git checkpoints;
- port scan;
- file watcher;
- preview proxy;
- settings;
- credentials;
- the CA trust setup.

All 18 review findings are fixed, and 109 tests pass.

**Worker**
- **Durable Objects:**
  - `WorkspaceDO`: the op runner with idempotent steps, the queue, events, container start, durability, git, scripts, terminal, previews and the channel.
  - `UserHubDO`
  - `CredentialDO`: HKDF and AES-GCM encryption.
- **Other parts:**
  - `TempoOutbound` and `DirectoryBackupGateway`.
  - The GitHub App: manifest setup, JWT and installation tokens.
  - Better Auth with a GitHub owner check, bearer tokens and the device flow.
  - Server functions that return the `Result` envelope.
  - Channels, attachments and the native API.
- **Tests:** 697 Worker tests and 96 UI-logic tests pass. The Playwright e2e plan (44 tests) and the conformance plan (40 tests) are written; they skip without an account or the image.

**Container and deploy**
- `container/Dockerfile` with a pinned base digest, plus `versions.json`, `check-versions.ts` and `pin-base.ts`.
- `alchemy.run.ts` creates D1, R2 and the generated secrets.
- `scripts/deploy-worker.ts` writes the wrangler config and runs the deploy.

**Web UI foundation (04)**
- 28 shadcn primitives.
- Routes `/login`, `/device`, `/`, `/w/$id` and `/history`.
- The desktop and phone shell, hooks, stores, the action registry and the shortcut table.
- `src/ui/CONTRACT.md`.

**Tempo for Mac (07)**
- **Cargo workspace:** pinned to Rust 1.97.0.
- **Protocol generation:** `bun run protocol:gen` writes 178 Draft-07 schemas and `Api.json`, and generates the Rust types in `crates/tempo-protocol`.
- **Fixtures:** `bun run protocol:fixtures` writes 411 type fixtures and 6 channel sessions. The expected end state of each session comes from the web stores.
- **App skeleton:** builds on GPUI Kit 0.7.1. It has:
  - the panes and the 07 menu table;
  - the Conductor key bindings in 4 contexts;
  - raw-HTML escaping and remote-image blocking;
  - link and `tempo://` handling;
  - the Info.plist and entitlements.
- **Spike notes:** S11, S13 and S16 are written.
- **Checks at round 1:** `cargo fmt`, `clippy -D warnings` and 53 Rust tests pass, and the protocol package's 201 tests pass.

## Left to do

**CI and quality**
- [x] Fix `format:check` (67 source/config files, generated declarations excluded).
- [x] Fix the intermittent load-once test: use D1-only data and assert hello-first delivery.
- [x] Confirm `GH_VERSION` is 2.102.0 in both Wrangler and versions.json (already corrected in the interim branch).
- [x] Correct the Turbo output glob for `@tempo/tempod#build`.

**Worker review findings (from round 1)**
- [x] HIGH: a pending permission is not cleared when its turn ends, so the workspace never sleeps (`queue.ts` finishTurn). Interim fix checked by the local Worker suite.
- [x] HIGH: no tempod reconnect during a create or wake op (`index.ts`, `steps.ts`). Interim fix checked by the local Worker suite.
- [x] The handoff text and `pending_note` are lost when `session.prompt` fails. Interim fix checked by the local Worker suite.
- [x] A deferred turn never restarts, and the state can stay `working`. Interim fix checked by the local Worker suite.
- [x] A deleted branch keeps `pushed=1` after archive and restore. Interim fix checked by the local Worker suite.
- [x] A revert to a checkpoint that has no turn marks every turn reverted. Interim fix checked by the local Worker suite.
- [x] Attention is not recomputed when a turn fails to start; step timings miss the wait; housekeeping hides `WorkspaceDetail.op`. Interim fix checked by the local Worker suite.
- [ ] A test for a real DO restart with the tempod socket closed.

**tempod**
- [ ] A fresh spec review after the 18 fixes.
- [x] Implement zombie reaping (Q-2, owner approved). Verified by the Linux image smoke tests.
- [x] Run daemon tests inside the full container image (112 pass, rule 14).

**Web UI (04)**
- [x] Implemented region components: Sidebar, TopBar, ChatTabs/Transcript/Composer, RightPanel and BottomPanel. Prior percentages described an older foundation snapshot.
- [x] Implemented dialogs, indicators, notifications, action registry and phone variants; existing UI model/component tests pass.
- [x] Add rendered local browser acceptance and run it in CI. Coverage and boundaries are in `WEB_ACCEPTANCE.md`.
- [ ] Complete deployed gates B–D with real agent sessions and keeled, including PR checks, previews, restart durability and credential grep.
- [ ] Resolve the shared contracts in `WEB-CLIENT-CORE-REQUESTS.md`: historical turn usage, closed/merged PR titles and authenticated attachment retrieval.
- [ ] Verify every shortcut in shipped Chrome, Safari and Firefox on macOS.

**Tempo for Mac (07)**
- [x] `tempo-client`: runtime, RPC, channels, reconnects, close codes, device-flow client and store apply rules pass local tests. App sign-in, hub and workspace stores are wired. Manual and hosted acceptance remain.
- [ ] Sign-in and first run: device flow and saved-token checks are wired and tested headlessly; real browser approval, Keychain and update download acceptance remain.
- [ ] Live state and reconnects: hub and workspace channels, revision resume, hidden-store timers and reconnect bars are wired and tested locally. Notifications and manual acceptance remain.
- [ ] Window layout and components (15%).
- [ ] Transcript, composer and permissions: chat tabs, rich text/tool/permission rows, drafts, Send/Queue/Send now/Stop, queued edit/delete/drag, model/mode pickers, plan mode, permission replies, close confirmation and chat/tool shortcuts are wired. Attachment input, full tool content, remaining transcript actions, performance and manual acceptance remain.
- [ ] Changes, diff view and comments (2%).
- [ ] `tempo-terminal`, a fork of gpui-terminal (5%); scripts and previews.
- [ ] macOS integration (35%): notifications, Dock badge, URL scheme, window state.
- [ ] Local storage and logging (8%).
- [ ] Build, signing and updates (20%): `scripts/mac/release.sh`, update check.
- [ ] 07 testing table (18%), and the manual checklist `tests/mac-e2e/CHECKLIST.md`.
- [x] Compile, test and lint macOS code on this Mac. Manual UI, notification, Keychain and signing checks remain.

**Private previews and Browser Run (owner request, 2026-10-11)**
- [x] Research: Browser Run, Protected Quick Tunnels, Cloudflare Access, code integration points.
- [x] Three designs; two reviewed.
- [ ] Review of the in-container cloudflared design. Research found that cloudflared needs port 7844, and only ports 80 and 443 leave the container (05).
- [ ] Decision brief, then the owner's decisions (Q3 and Q-4).
- [ ] Spec changes (00, 01, 02, 04, 05, 07), then the build.

**Needs a Cloudflare account and real logins**
- [ ] Spikes S1–S16 (gate A).
- [ ] Acceptance tests AT-1–AT-37, e2e and conformance runs.
- [ ] First real deploy.

## Decisions waiting on the owner

See `IMPLEMENTATION_NOTES.md`:
- **S-1 to S-6:** spec changes to make.
- **Q-1 to Q-4:** open questions.
- **M-1:** remote-image blocking in the Mac app.
- **00 Q1 to Q5 and 07 Q7:** open questions in the spec.
- **Private previews:** the design choice, once the brief is ready.

## Core cloud implementation audit (2026-10-11)

Core continues on `codex/complete-tempo-core`, based on published `b1ba351` (the original cloud checkout was `1984b89`; the named integration branch was deleted after PR #1 merged). The cloud change adds atomic daemon-event application and replay after failures, accepts fast turn lifecycle events before prompt acknowledgements, persists checkpoint request identities and regenerates immutable checkpoint bundles, excludes daemon SQLite/outbox files from home backups, and fixes aborted requests and health probes. Concurrent adapter starts now preserve the process limit. ACP v1 mode config options drive the mode choices, selection and setters when advertised; the evaluated TUI-v2 snapshot provided no protocol advantage, so OpenCode remains pinned at 1.18.35. A native DO abort/reacquisition test verifies recovery of waiting setup without rerunning its script. The owner resolved Q-1 (a safety checkpoint is required before revert) and MQ-1 (optional `latestMacClientSha256` in version 1 metadata); specs, generated TypeScript/Rust contracts and fixtures are updated.

Deployment tooling has a local `--prepare` mode and a review configuration under `docs/deployment/`. Cloud image builds use temporary CA mounts with TLS verification; Linux runners can mount source/dependencies read-only into the full image for daemon tests. This section does not close hosted gates or replace their real-account evidence. Exact commands, results, SHAs and remaining inputs are in `CORE-RESULTS.md`.
