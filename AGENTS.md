# Rules for agents working on Tempo

The Tempo Spec (tabs 00 to 07 in `docs/`) is the source of truth. Read the tab for the area you change before you write code.

## Never guess
1. If the spec is silent, or two tabs disagree, stop and ask. Do not invent behavior.
2. Names in the spec are exact: tables, columns, enum values, routes, env vars, message types, error codes.

## Architecture
3. Wire types live only in packages/protocol (Effect Schema). Do not define one anywhere else.
4. Only a WorkspaceDO writes its own SQLite and its D1 workspaces row. The one exception is the first insert in createWorkspace.
5. Every op step is idempotent and checks state before it acts.
6. tempod makes no outbound request before it receives hello.
7. Use the Sandbox SDK 1.0 model: ctx.container, Files, DirectoryBackup. Do not use 0.x APIs such as getSandbox, exposePort, startProcess, gitCheckout or createBackup.
8. Use ACP v1 through @agentclientprotocol/sdk. Do not use ACP v2. There is no session/set_model; use session/set_config_option.

## Secrets
9. Never put a secret in logs, error messages, D1, the events table, R2, or the container start env. TEMPOD_TOKEN is the one exception; it is new for every start. Use the redact helper for every log call.
10. GitHub tokens and API keys never enter a container. Only TempoOutbound adds them.

## Dependencies
11. Use only the stack named in the spec. Ask before adding any library.
12. Pin every version you add. Container versions go in container/versions.json.

## Code
13. Keep comments minimal. Comment only where the reason is not clear from the code.
14. Every server function, op step and tempod request has a test. DO tests use @cloudflare/vitest-pool-workers. tempod tests run inside the container image.
15. Before you finish: bun run typecheck, bun run lint and bun run test all pass.
16. If behavior must change, change the spec in the same pull request, and say so in its description.
17. When the web UI (04) changes, the Mac client (07) changes in the same phase.

## Repo
- Bun workspaces, orchestrated by Turborepo (`turbo.json`). Run tasks from the root: `bun run build`, `bun run typecheck`, `bun run test`.
- Deviations from the spec, and choices the spec leaves open, are listed in `docs/IMPLEMENTATION_NOTES.md`.
