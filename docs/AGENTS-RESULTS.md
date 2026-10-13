# Agents as data results

Starting SHA: [3edf1f6](https://github.com/kcc989/tempod/commit/3edf1f6fd8422b6d6aa4bac7f539c8920cb520ff). Final SHA: pending implementation milestones.

S22 passed: 50 valid deployed Worker binding calls, 4 KiB state/four questions, p95 878 ms. [Evidence](../spikes/S22.md) includes the earlier incomplete batch and confirmed request/response fields. All temporary Workers were deleted.

Owner clarifications on 2026-10-13: Clef question IDs use a dot instead of a colon; access prompts say agent and explain the files-changed warning, preserving A1 and A9. The task contract records both corrections.

M1 updates tabs 00–08 for D1 agent libraries, attachments/hooks, frozen run definitions, typed MCP reports, run cards, proposals and decision privacy. Owner decisions A1–A12 remain fixed. Published chat profiles survive the migration. Legacy storage remains read-only until Gate I passes.

Implementation, S20's read-only adapter spike, S23, Gate I, final commands and milestone PR links remain pending. No real-agent or native-rendering acceptance is claimed by S22 or local fake-adapter tests.

M1 validation: `bun install --frozen-lockfile` passed. `bun run ci --docs-only` passed in 3.7 seconds (lint 2.7 s, formatting 1.0 s). Baseline full CI passed typecheck, lint, formatting, version checks, both builds and non-browser tests; its browser stage failed because Chromium was absent. Chromium installation is in progress before subsequent code verification.
