# Agents as data results

Starting SHA: [3edf1f6](https://github.com/kcc989/tempod/commit/3edf1f6fd8422b6d6aa4bac7f539c8920cb520ff). Final SHA: pending implementation milestones.

S22 passed: 50 valid deployed Worker binding calls, 4 KiB state/four questions, p95 878 ms. [Evidence](../spikes/S22.md) includes the earlier incomplete batch and confirmed request/response fields. All temporary Workers were deleted.

Owner clarifications on 2026-10-13: Clef question IDs use a dot instead of a colon; access prompts say agent and explain the files-changed warning, preserving A1 and A9. The task contract records both corrections.

M1 updates tabs 00–08 for D1 agent libraries, attachments/hooks, frozen run definitions, typed MCP reports, run cards, proposals and decision privacy. Owner decisions A1–A12 remain fixed. Published chat profiles survive the migration. Legacy storage remains read-only until Gate I passes.

Implementation, S20's read-only adapter spike, S23, Gate I, final commands and milestone PR links remain pending. No real-agent or native-rendering acceptance is claimed by S22 or local fake-adapter tests.

M1 validation: `bun install --frozen-lockfile` passed. `bun run ci --docs-only` passed in 3.7 seconds (lint 2.7 s, formatting 1.0 s). Baseline full CI passed typecheck, lint, formatting, version checks, both builds and non-browser tests; its browser stage failed because Chromium was absent. Chromium installation is in progress before subsequent code verification.


## M2 Library implementation

D1 migration `0005_agents` adds the library, project attachments and migration sentinel. Agent saves use canonical JSON, SHA-256 and incrementing versions. Imports and their sentinel commit atomically and prevent duplicate work across isolates; starters are copied once and never attached automatically. The owner approved invalid-handle normalization, duplicate-name suffixes, preservation of imports above the limit, and the `AgentAttachment` wire name. New creates enforce the 50-agent limit atomically.

Both settings clients expose the definition fields, Duplicate/Delete, a read-only JSON view, and structured project attachment/hook controls. New chats and workspaces read the library; saved session profiles stay frozen through edits and deletion. Deleted agents retain their attachment rows with Remove.

`bun run ci` passed in 54.9 seconds with restored task results: typecheck 7.3 s, non-Worker tests 23.1 s and browser suites 29.4 s. The new Worker suite has eight cases, including a real DO session with frozen profile data. `cargo check -p tempo-mac` passed; `cargo test -p tempo-mac` passed all 264 native tests. Native compilation also required correcting four pre-existing chat accesses from the old tuple-shaped `ContentBlock` to the current named fields. This Linux verification does not establish macOS rendering or real-agent acceptance.

The legacy long-prompt migration policy is awaiting owner clarification. M3–M6, S20/S23 and Gate I remain pending; hook execution is not provided by M2 alone.
