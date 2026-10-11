# Goal 3: complete Tempo for Mac

## Objective

Complete the entire native Mac client for Tempo's agent workspace product, including chat, review, processes, terminal, settings, macOS integration and release/update tooling. Meet the Mac specification and prove native acceptance. Do not stop at panels that still need another agent to wire them into the shell.

This is one of exactly three parallel goals: **core**, **web client**, and **Mac client**. Core owns shared server/protocol contracts and integration. The web agent owns the complete browser client. You own the entire native app, including work formerly split into native review and native processes. There is no separate fourth coordinator.

## Start in the cloud

- Repository: [kcc989/tempod](https://github.com/kcc989/tempod).
- Integration branch: `claude/great-franklin-xc39l8`; [existing PR #1](https://github.com/kcc989/tempod/pull/1).
- Published reference at preparation: `63761dea83a7456addfeae18f88886309edc0e78`. Fetch and inspect the integration branch; this reference may no longer be its head.
- Use the repository connected to your cloud task, or clone it into an isolated cloud checkout. Agree on the starting commit and use your own `codex/` task branch. Do not depend on another agent's workstation, scratch terminal port, local checkout or unpublished edits.
- A Linux cloud runner can support source work and suitable platform-neutral checks. It cannot prove macOS rendering, Keychain, notifications, signing, notarization or clean-Mac installation. Obtain an authorized macOS 15 arm64 runner for required native checks. Missing Mac access is an evidence gap, not permission to weaken the target or claim completion.

Read [AGENTS.md](https://github.com/kcc989/tempod/blob/claude/great-franklin-xc39l8/AGENTS.md), [PROGRESS.md](https://github.com/kcc989/tempod/blob/claude/great-franklin-xc39l8/docs/PROGRESS.md), and [IMPLEMENTATION_NOTES.md](https://github.com/kcc989/tempod/blob/claude/great-franklin-xc39l8/docs/IMPLEMENTATION_NOTES.md). Read [spec tabs 00–07](https://github.com/kcc989/tempod/tree/claude/great-franklin-xc39l8/docs), especially the complete Mac requirements in tab 07, shared UI behavior in tab 04, API/channel contracts in tab 02, runtime/process behavior in tab 01 and security rules in tab 05. Inspect [published spike results](https://github.com/kcc989/tempod/tree/claude/great-franklin-xc39l8/spikes); scratch feasibility work is not a finished product.

## Ownership

Own the complete native app, its shell and views, actions/menus/key bindings, native stores/storage, client transport, terminal crate, native tests/resources, and Mac build/release scripts. You may integrate chat, review and process work directly within this scope; these files are not reserved for a fourth coordinator.

Use generated shared protocol types and the existing client runtime. Core owns wire schemas and generators, server/API behavior, daemon/container changes and deployment. Request exact contract changes from core; never define native-only wire messages. Coordinate shared Cargo/root manifests, lockfiles, CI and cross-client spec changes. Own tab 07 updates; coordinate changes to tab 04 with the web agent and contracts with core.

## Required work

1. Audit the whole native specification and milestones M1–M5 against current code and fresh evidence. Existing sign-in, hub/workspace channels and chat/queue/steering work are a foundation. Inspect before replacing them; finish all missing behavior and integration.
2. Complete device sign-in, saved-token validation, Keychain storage, revocation/401 cleanup, first-run/error/update states, workspace caching and channel recovery. Verify that native and web views converge without lost or repeated data.
3. Complete the native shell, sidebar, top bar, dialogs and chat tabs. Implement all transcript kinds, streaming row remeasurement, per-chat scroll position, permissions, model/mode controls, attachments, mentions, slash commands, review chips and draft behavior.
4. Preserve queueing and live steering. Enter queues during a running turn; queued messages support edit, delete and reorder. **Send now** injects into a supported active turn without stopping it. Show pending/fallback/uncertain delivery correctly and prevent duplicate sends or lost drafts. Test keyboard/focus and running-chat close confirmation.
5. Complete Changes, unified/split Diff, comments, viewed marks with diff-hash invalidation, All files, read-only file tabs, picker/search and Checks. Parse diffs off the UI thread and virtualize rows. Follow the specified large-diff fallback and width rules; no diff syntax highlighting in v1. Wire commit/push, PR creation, squash merge, archive/restore and deletion through the shell.
6. Complete Setup and Run output/history, retry/continue actions and script selection/start/stop. Implement the specified remote terminal fork and pinned parser with attribution, t1–t9 tabs, input/resize, 10,000-line scrollback, selection/copy and reconnect to the same tmux session. A local PTY is not a substitute. Mac previews open in the default browser; there is no in-app Browser tab.
7. Complete all native Settings and Diagnostics, appearance, notifications, Dock badge, URL scheme, window/panel persistence, command palette and Conductor shortcuts. Ask for notification permission only at the specified user action. Follow disk/log privacy rules and the Mac-specific feature differences in tab 07.
8. Complete app resources, ad-hoc development builds, release bundle/DMG creation, signing/notarization checks, version/download/hash validation and update flow. The owner performs authorized signing/publication from a Mac. Do not run signing, upload a release, use paid services or weaken integrity checks without required authorization and credentials.
9. Run integrated native acceptance against core's authorized test environment. Verify streaming with a 30-second network loss, shared permission resolution, all diff cases and comment delivery, git/PR/merge, vim and terminal resize/reconnect, notifications, deep links, revocation and every shortcut. Coordinate native/web behavior changes in the same phase.

## Rules and verification

Follow the pinned Rust/GPUI stack and repository instructions. Ask before adding libraries and pin approved versions; do not upgrade GPUI Kit to avoid implementation work. Use shared generated contracts. Keep slow parsing/I/O off the GPUI UI thread. Render no raw agent HTML; refuse remote Markdown images and accept only the specified inline ACP media. Keep secrets in the prescribed Keychain boundary and keep prompts/transcripts out of persistent native logs/storage.

Run `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, and root `bun run typecheck`, `bun run lint` and `bun run test`. Add meaningful parser/controller/RPC and GPUI headless tests. Check generated fixture compatibility. Read installed Turbo documentation before changing orchestration. Headless tests do not replace rendered/native acceptance.

Meet Gate E's AT-23–AT-37 requirements in tab 07, coordinating AT-23–AT-25 server evidence with core. Verify the clean macOS 15 installation, revocation within 60 seconds, shortcut table and Keychain/log/disk privacy audit. Keep unavailable signing, interactive terminal, real logins and manual evidence explicit. Do not claim a Gate E pass from Linux checks or mocked sockets.

## Deliverable and completion

Deliver fully integrated native commits and an integration-ready diff on your task branch. Return a standalone Markdown report named **MAC-CLIENT-RESULTS.md** with starting/final SHA, implementation/spec changes, exact runner/platform, test results, safe rendered evidence, acceptance IDs, release artifacts and unresolved requirements. Use GitHub/HTTPS references, not workstation paths. Publish or merge only within explicit task authorization.

The Mac goal is complete only when the full specified native product and required acceptance are proved. Missing Mac access, credentials, owner decisions or signing approval are blockers to completion, not reasons to narrow the goal. Complete all independent work and state the exact input needed for remaining proof.
