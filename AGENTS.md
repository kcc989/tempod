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

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

## CI and test budget

- Target less than five total runner minutes for normal PR CI. Keep the single `check` job. `bun run ci` allows 300 seconds for check commands after setup, with a six-minute hard job timeout for setup/cleanup. Report both check time and total time; do not increase these limits or add jobs without measurement and explicit authorization.
- Read `docs/CI.md` before changing workflows, test configuration, or adding tests. Include the relevant stage timing from the CI summary when changing the suite.
- Every test must identify a distinct behavior or regression and assert an observable outcome. Do not add source-text snapshots, assertions of mock configuration, success-only smoke tests, duplicate matrices, or conditional assertions that can execute zero checks.
- Prefer the lowest test layer that proves the behavior. Browser tests are for real interaction, layout, accessibility, persistence and reconnect behavior; pure logic belongs in unit tests. Keep failure, security, idempotency, and migration coverage.
- Wait for observable state instead of sleeping. Use a short local timeout when testing deadlines, and restore it afterwards. Never add retries to hide flakes.
- Keep live deployment/agent suites explicit (`test:e2e`, `test:conformance`) and uncached. Image/tool/PID checks belong in `test:tempod:container`. A skip is never proof that those gates passed.
- Concurrent Worker cases must use test-context assertions and cleanup, with a distinct user/project/DO per fixture. Keep global clock/GitHub mock groups sequential; keep shared DOM cases sequential.
- Keep Worker, UI and component caches separate. Include transitive workspace sources and shared helpers/configuration in their inputs; widen them when imports cross boundaries. Cache fixture builds, but execute the browser tests.
- Documentation-only classification must fail closed for unavailable bases, code/config changes and both sides of renames. Keep the required `check` job; do not use workflow path ignores that leave it pending.
- Preserve cache correctness: shared root configuration is a global input; include runtime-changing environment variables in task hashes. Do not cache deployment or live external checks.
