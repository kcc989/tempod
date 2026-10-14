# Spikes

Phase 0 (06, Spikes) and phase 4 (07, Spikes). Each spike is throwaway code in its own branch that
answers one question. Its result goes here as `S<n>.md`: what was tried, what worked, exact names
and timings. If a result differs from the spec, change the spec before phase 1.

Historical phase-0 status is listed below. Goal 4 uses [S20](https://github.com/kcc989/tempod/blob/main/spikes/S20.md), [S22](https://github.com/kcc989/tempod/blob/main/spikes/S22.md) and [S23](https://github.com/kcc989/tempod/blob/main/spikes/S23.md). S22 passed 50 deployed Worker calls at p95 878 ms; S20/S23 remain open for real agent logins.

| ID      | Question                             | Status  | Notes from the build                                                                                                  |
| ------- | ------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------- |
| S1      | Container API as the spec uses it    | Not run | Alchemy cannot emit `exports` or DO-managed `images`; wrangler deploys the Worker (docs/IMPLEMENTATION_NOTES.md S-1). |
| S2      | Git with no token in the container   | Not run |                                                                                                                       |
| S3      | Claude Code through the egress proxy | Not run |                                                                                                                       |
| S4      | Codex login and refresh sync         | Not run |                                                                                                                       |
| S5      | DO to tempod link survives restarts  | Not run |                                                                                                                       |
| S6      | Wake times                           | Not run |                                                                                                                       |
| S7      | Browser testing fits                 | Not run | `@playwright/mcp@0.0.83` bin is `playwright-mcp`; the image adds `mcp-server-playwright` (S-2).                       |
| S8      | Previews for real dev servers        | Not run |                                                                                                                       |
| S9      | OpenCode and Pi through ACP          | Not run |                                                                                                                       |
| S10     | Terminal through the DO              | Not run |                                                                                                                       |
| S11–S16 | Mac client (07)                      | Not run | The Mac client is not built.                                                                                          |
