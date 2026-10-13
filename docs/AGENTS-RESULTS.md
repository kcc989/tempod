# Agents as data results

Starting SHA: [3edf1f6fd8422b6d6aa4bac7f539c8920cb520ff](https://github.com/kcc989/tempod/commit/3edf1f6fd8422b6d6aa4bac7f539c8920cb520ff). Final implementation SHA will be recorded after M6 merges. All six implementation milestones have passed local verification; final hosted checks and merges are in progress.

## Milestones

| Milestone | Pull request | Result |
| --- | --- | --- |
| M1 Contracts | [#41](https://github.com/kcc989/tempod/pull/41) | Merged: tabs 00–08 define the library, hooks, decisions, runs and proposals. |
| M2 Library | [#42](https://github.com/kcc989/tempod/pull/42) | Merged at [5eba4fb](https://github.com/kcc989/tempod/commit/5eba4fbe57d9a0236fe4884b6932615b33fc2edc): D1 library/attachments, starters, CRUD, both settings clients and frozen chat profiles. |
| M3 Runs | [#46](https://github.com/kcc989/tempod/pull/46) | Merged at [893f3a2](https://github.com/kcc989/tempod/commit/893f3a21e68bfe0f6632565a5b4cb84407e0a98f): typed MCP reports, one follow-up, hidden run sessions, cards, warning/Revert, protected files, timeout/cancel/recovery and shared budgets. |
| M4 Decisions | [#47](https://github.com/kcc989/tempod/pull/47) | Merged at [aea92b1](https://github.com/kcc989/tempod/commit/aea92b161c83930943f30bc2482ff944352b0b3b): confirmed Clef binding, 64-question batches, thresholds, bounded/redacted state, retry/deadline, durable decisions, Diagnostics and Run anyway in both clients. |
| M5 Proposals | [#48](https://github.com/kcc989/tempod/pull/48) | Merged at [a55466d](https://github.com/kcc989/tempod/commit/a55466dd4fa966f9916bea08b6c4462d26bf040a): owner-applied full-change cards, strict/redacted tools, atomic D1 receipts, rejection, rollback and notification recovery. Final hosted checks passed. |
| M6 Remove | [#49](https://github.com/kcc989/tempod/pull/49) | Removes old editors, APIs, wire schemas, file stores, built-ins and settings. Flat Session metadata preserves old profiles and commit SHAs. |

## Contract clarifications

The owner approved these changes on 2026-10-13, recorded in [the task contract](https://github.com/kcc989/tempod/blob/main/docs/tasks/04-AGENTS-AS-DATA.md) and [implementation notes](https://github.com/kcc989/tempod/blob/main/docs/IMPLEMENTATION_NOTES.md):

- Clef question IDs use `<attachmentId>.<hookIndex>` because the API rejects colons. Decision dedupe keys retain colons.
- Access prompts say agent and describe a file-change warning. Daemon MCP tools use request/response frames on the existing socket, outside raw event storage.
- `AgentAttachment` names project wiring; `Attachment` continues to name uploaded files.
- Invalid imported handles use an `agent-` prefix/fallback, duplicate names gain suffixes, and imports may exceed 50 while new creates remain blocked. Copied prompts fit 32,000 characters/64 KiB, with originals preserved and name-only logs.
- The sole owner waived importing legacy Artifacts files. The binding and reader are removed completely; stored D1 definitions still import once, and old pointer tables remain read-only until Gate I.
- Session metadata uses optional flat `agentId`, `agentName`, `agentVersion` and `agentSha`. SQLite migration `0012_session_agents` preserves profile JSON and old commit SHAs; old sessions omit the new version. New library chats and runs use the adapter default for an empty model; existing chats retain their project-model fallback.
- Send to chat, including auto-send, keeps the original change and its `max_runs` budget.
- Clef may receive redacted typed results containing file-derived text. The existing report schemas have no `snippet` field; unknown report fields remain errors. Decision state reads changed paths rather than raw files and excludes env values/secrets.

## Spikes and acceptance

[S22](https://github.com/kcc989/tempod/blob/main/spikes/S22.md) passed before decision implementation: 50 valid calls from a deployed Worker binding, 4 KiB state/four questions, p95 **878 ms** (minimum 353 ms, median 411 ms, maximum 984 ms). It records the initial incomplete attempt and confirmed direct request/response fields. Temporary Workers were deleted.

[S20](https://github.com/kcc989/tempod/blob/main/spikes/S20.md) records implemented advertised-mode selection and Pi edit-tool denial, with real edit/shell challenges open. [S23](https://github.com/kcc989/tempod/blob/main/spikes/S23.md) records the twelve real-agent/output-kind cases still required. S21's result-file contract is retired. No agent login or hosted browser authentication state is configured in this environment; skipped suites are not counted as passes.

All nine deployed Gate I scenarios remain open until real logins are available and three consecutive runs establish them. Deterministic Worker/daemon/client tests cover their storage, RPC, queue and UI behavior; they do not establish real-model compliance, deployed recovery or a deployed credential grep. Linux native tests also do not establish macOS visual acceptance.

## Validation

Commands: `bun install --frozen-lockfile`, `bun run ci`, complete forced-task `TURBO_FORCE=true bun run ci`, focused Worker/UI/MCP tests, `cargo check --workspace --all-targets`, `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo fmt --all -- --check`. CI includes typecheck, strict lint, formatting, version consistency, all local tests, daemon/app/fixture builds and all 28 browser cases. No concurrency or deadlines were increased.

| Stage | Evidence |
| --- | --- |
| M2 full forced local CI | 92.6 s; Worker 90.5 s, other tests 48.9 s, browsers 40.0 s. [Hosted follow-up](https://github.com/kcc989/tempod/pull/42/checks) passed in 230.6 s including setup. |
| M3 full forced local CI | 90.4 s; Worker 88.2 s, other tests 46.1 s, browsers 37.8 s, typecheck 11.5 s, app build 13.1 s. |
| M3 hosted CI | [Run 38474358376](https://github.com/kcc989/tempod/actions/runs/38474358376): 295.9 s including setup, 309 s with cleanup; Worker 234.7 s, browsers 100.6 s. |
| Production image and daemon container | [Run 38475225303](https://github.com/kcc989/tempod/actions/runs/38475225303) passed M3's full image/container suite. Final cleanup image check pending. |
| M4 full local CI | 76.1 s after ready-fixture optimization, Worker 73.9 s, browsers 36.9 s. |
| M4 hosted CI | [Run 38477146737](https://github.com/kcc989/tempod/actions/runs/38477146737): 207.7 s including setup, 220 s with cleanup; Worker 150.5 s, browsers 80.4 s. |
| M5 full local CI | 90.3 s with notification recovery; Worker 87.9 s, other tests 24.7 s, browsers 42.2 s, app build 11.7 s. |
| M6 focused migration/library | 13 cases passed in 14.3 s, including preserved profile/SHA, one-time D1 imports without Artifacts access, explicit empty model and existing-chat fallback. Typecheck passed in 7.3 s. |
| M6 full forced local CI | Dependency bundling passed in 89.4 s with all 28 browsers; Worker 86.1 s, other tests 48.2 s, browsers 39.0 s, typecheck 12.5 s, app build 13.2 s. Previous cold local benchmark: 99.4 s. |
| Final daemon cleanup | Retired result-folder ACP reads/writes now return the outside-folder error. All 28 ACP cases pass; full local CI with cache reuse passed in 36.1 s, including all 28 browsers. |
| M6 native workspace | All workspace suites passed, including 264 Mac tests; all-target check and formatting passed. Strict Clippy and final forced-task CI passed. |

Early cold hosted attempts hit the 300-second command deadline. Catalog batching and ready-workspace fixtures resolved those bottlenecks without changing budgets or coverage. M5's prior hosted run passed in 303.3 s including setup (311 s with cleanup), slightly above the five-minute target; the next cold hosted check hit the deadline at 337.2 s including setup (Worker 293.6 s). Loading the transitional Git writer only during old writes now avoids its initialization on D1 requests; complete forced local CI passed in 97.4 s (Worker 95.0 s, other tests 50.1 s, browsers 40.4 s, typecheck 11.2 s, app build 14.5 s). M5 final hosted check passed in [run 38480964936](https://github.com/kcc989/tempod/actions/runs/38480964936): 318.1 s including setup, 328 s with cleanup, Worker 279.8 s. M6's first hosted cold check hit the existing command deadline at 332.3 s including setup (Worker 293.8 s, other tests 160.3 s, browsers 126.9 s). Shared dependency bundling now reduces repeated module loading; final M6 hosted measurements will be recorded here. Stage durations overlap and must not be added together.
