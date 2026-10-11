# Progress

Status of the Tempo build against the spec (tabs 00 to 07). Last updated 2026-10-11 20:45 UTC, at commit `49fffd8` on `claude/great-franklin-xc39l8` ([PR #1](https://github.com/kcc989/tempod/pull/1)).

Percentages are the estimates of the build loops' progress checkers. Deviations from the spec and open questions are in `IMPLEMENTATION_NOTES.md`.

## Current state

- **Build loops stopped at 20:40 UTC.** All three workflows hit the account's session usage limit, which resets at 23:30 UTC. Agents that were mid-round were cut off, so the newest interim commits hold unfinished UI and Mac code that no checker has verified.
- **Last verified points:** web loop round 1 (`3676dce`) and Mac loop round 1 (`42a8645`, `a97321b`).
- **CI:** `format:check` fails on about 78 files. One Worker test fails sometimes (see Worker).

## Summary

| Area | Spec | Done | State |
| --- | --- | --- | --- |
| Monorepo, tooling, CI | 06 | 85% | Turborepo + Bun, TS 6.0.3, oxlint, oxfmt, CI workflow. Format check is red. |
| `packages/protocol` | 02 | 95% | Effect Schema wire types, 63 API functions, channels, tempod envelopes. JSON Schema and fixtures are generated (Mac loop). 15 files fail oxfmt. |
| `packages/settings`, `packages/cities` | 01, 03 | 100% | Done and tested. |
| `tempod` daemon | 01 | 90% | Built; 109 tests pass. |
| Worker: Durable Objects and ops | 01, 03 | 82% | Built; 12 review findings open (2 high). |
| Server functions | 02 | 95% | All 59 functions from 02 exist. |
| Egress (`TempoOutbound`) | 01, 05 | 95% | Rules 0 to 10 built and tested. |
| Auth and GitHub App setup | 05 | 92% | Built; not checked against real GitHub. |
| Native API for the Mac app | 07 | 90–100% | `/api/v1/*`, bearer WebSocket auth, `/downloads/mac`. |
| Container image and deploy | 01, 05 | 85% | Dockerfile, versions.json, Alchemy + wrangler deploy. |
| Web UI | 04 | about 30% | Foundation done; most regions are in progress. |
| Tempo for Mac | 07 | about 20% | Protocol generation done; app skeleton; client in progress. |
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
- [ ] Fix `format:check` (about 78 files).
- [ ] Fix the sometimes-failing test `regressions.test.ts:109` (UserHubDO sends `hello` after a workspace message).
- [ ] `apps/tempo/wrangler.jsonc` sets `GH_VERSION` 2.62.0, but `container/versions.json` says 2.102.0 (rule 12).
- [ ] The turbo `outputs` warning for `@tempo/tempod#build`.

**Worker review findings (from round 1)**
- [ ] HIGH: a pending permission is not cleared when its turn ends, so the workspace never sleeps (`queue.ts` finishTurn).
- [ ] HIGH: no tempod reconnect during a create or wake op (`index.ts`, `steps.ts`).
- [ ] The handoff text and `pending_note` are lost when `session.prompt` fails.
- [ ] A deferred turn never restarts, and the state can stay `working`.
- [ ] A deleted branch keeps `pushed=1` after archive and restore.
- [ ] A revert to a checkpoint that has no turn marks every turn reverted.
- [ ] Attention is not recomputed when a turn fails to start; step timings miss the wait; housekeeping hides `WorkspaceDetail.op`.
- [ ] A test for a real DO restart with the tempod socket closed.

**tempod**
- [ ] A fresh spec review after the 18 fixes.
- [ ] Zombie reaping (Q-2).
- [ ] Run its tests inside the container image (rule 14).

**Web UI (04)**
- [ ] Sidebar (15%): indicators, hover card, context menu, sort, sections, workspace actions.
- [ ] Top bar (10%): primary action table, pill, port links, base-branch picker, overflow menu, commit/PR/merge/archive.
- [ ] Center (10%):
  - the agent menu and closed chats;
  - the transcript for every item kind;
  - the composer: pickers, attachments, mentions, queue, drafts;
  - the banners.
- [ ] Right panel (5%): Changes, Diff with comments and viewed marks, All files, ⌘P and ⌘⇧F, Checks, Browser tab.
- [ ] Bottom panel (5%): Setup, Run, Terminal t1–t9 with xterm.
- [ ] Dialogs (30%): New workspace, Add project, Settings (Logins, Project, Notifications, Devices), Diagnostics, First-run checklist.
- [ ] Indicators and browser notifications (15%).
- [ ] Region actions in the shortcut registry (55%).
- [ ] Empty, loading and error states per region, and phone variants (55%).

**Tempo for Mac (07)**
- [ ] `tempo-client` (5%): runtime, RPC, channels, reconnects, close codes, device sign-in, store apply rules.
- [ ] Sign-in and first run (5%).
- [ ] Live state and reconnects (10%).
- [ ] Window layout and components (15%).
- [ ] Transcript, composer and permissions (15%).
- [ ] Changes, diff view and comments (2%).
- [ ] `tempo-terminal`, a fork of gpui-terminal (5%); scripts and previews.
- [ ] macOS integration (35%): notifications, Dock badge, URL scheme, window state.
- [ ] Local storage and logging (8%).
- [ ] Build, signing and updates (20%): `scripts/mac/release.sh`, update check.
- [ ] 07 testing table (18%), and the manual checklist `tests/mac-e2e/CHECKLIST.md`.
- [ ] macOS-only code cannot run here (Linux). It sits behind `cfg(target_os = "macos")` and needs a check on a Mac.

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
