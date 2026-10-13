# Agents as data results

Starting SHA: [3edf1f6](https://github.com/kcc989/tempod/commit/3edf1f6fd8422b6d6aa4bac7f539c8920cb520ff). Final SHA: pending implementation milestones.

Merged milestones: [M1 #41](https://github.com/kcc989/tempod/pull/41), [M2 #42](https://github.com/kcc989/tempod/pull/42). M2 merged at [5eba4fb](https://github.com/kcc989/tempod/commit/5eba4fbe57d9a0236fe4884b6932615b33fc2edc).

S22 passed: 50 valid deployed Worker binding calls, 4 KiB state/four questions, p95 878 ms. [Evidence](../spikes/S22.md) includes the earlier incomplete batch and confirmed request/response fields. All temporary Workers were deleted.

Owner clarifications on 2026-10-13: Clef question IDs use a dot instead of a colon; access prompts say agent and explain the files-changed warning, preserving A1 and A9. The task contract records both corrections.

M1 updates tabs 00–08 for D1 agent libraries, attachments/hooks, frozen run definitions, typed MCP reports, run cards, proposals and decision privacy. Owner decisions A1–A12 remain fixed. Published chat profiles survive the migration. Legacy storage remains read-only until Gate I passes.

Implementation, S20's read-only adapter spike, S23, Gate I, final commands and milestone PR links remain pending. No real-agent or native-rendering acceptance is claimed by S22 or local fake-adapter tests.

M1 validation: `bun install --frozen-lockfile` passed. `bun run ci --docs-only` passed in 3.7 seconds (lint 2.7 s, formatting 1.0 s). Baseline full CI passed typecheck, lint, formatting, version checks, both builds and non-browser tests; its browser stage failed because Chromium was absent. Chromium installation is in progress before subsequent code verification.


## M2 Library implementation

D1 migration `0005_agents` adds the library, project attachments and migration sentinel. Agent saves use canonical JSON, SHA-256 and incrementing versions. Imports and their sentinel commit atomically and prevent duplicate work across isolates; starters are copied once and never attached automatically. The owner approved invalid-handle normalization, duplicate-name suffixes, preservation of imports above the limit, and the `AgentAttachment` wire name. New creates enforce the 50-agent limit atomically.

Both settings clients expose the definition fields, Duplicate/Delete, a read-only JSON view, and structured project attachment/hook controls. New chats and workspaces read the library; saved session profiles stay frozen through edits and deletion. Deleted agents retain their attachment rows with Remove.

`bun run ci` passed in 54.9 seconds with restored task results: typecheck 7.3 s, non-Worker tests 23.1 s and browser suites 29.4 s. The new Worker suite has eight cases, including a real DO session with frozen profile data. `cargo check -p tempo-mac` passed; `cargo test -p tempo-mac` passed all 264 native tests. Native compilation also required correcting four pre-existing chat accesses from the old tuple-shaped `ContentBlock` to the current named fields. This Linux verification does not establish macOS rendering or real-agent acceptance.

The owner approved truncating copied legacy prompts to the new character/JSON limits while preserving original legacy storage and logging affected names only; the migration regression verifies preservation. M3–M6, S20/S23 and Gate I remain pending; hook execution is not provided by M2 alone.

M2 follow-up hosted CI passed in 230.6 seconds including setup (Worker 178.2 s, other tests 61.4 s, browsers 91.1 s). The earlier cold hosted run hit the 300-second deadline; no limits changed. A complete local forced-task benchmark passed in 92.6 seconds (Worker 90.5 s, other tests 48.9 s, browsers 40.0 s).

## M3 Runs

The replacement engine freezes definitions/options, takes one pin, accepts typed MCP reports through request/response frames, provides one follow-up, warns on tree changes and fails protected-file edits. Send to chat and auto-send retain the change and its run budget, as the owner approved. Both clients have run cards, hidden run sessions, transcript side panels, activity lists and `/agent`/`@handle` requests. The SQLite rebuild preserves history, profiles, sequence numbers and dedupe keys.

S20 real-adapter checks, S23 and Gate I remain open; local fake-adapter tests and Linux native checks are not deployed/macOS acceptance. M4–M6 remain pending.

M3 validation: `bun run ci` passed in 92.0 seconds with cache reuse (Worker 89.7 s, non-Worker 26.9 s, browser 44.8 s, typecheck 5.9 s, app build 12.1 s). The focused run suite passed 15 cases; all five migration cases, the run-card interaction, 28 ACP cases and 17 MCP/mapper cases passed. Native tests passed 264/264 and strict Clippy passed. Browser fixtures now implement the new attachment/activity APIs, and the legacy startup fixture waits for readiness before teardown.

The run PR rebases onto workspace tools (#44) and deterministic reconnect coverage (#45). Both clients place Activity and hidden run transcripts in the tool area beside the chat. Hosted cold checks hit the 300-second deadline; catalog loading now batches reads, reuses loaded agent rows and leaves one-time imports to the specified library access paths. A regression verifies that workspace startup does not import a library.

The complete post-optimization forced-task benchmark passed in 90.4 seconds: Worker 88.2 s, other tests 46.1 s, typecheck 11.5 s, app build 13.1 s and all 28 browsers 37.8 s. No CI limits or concurrency changed.
