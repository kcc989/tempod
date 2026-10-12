# Web acceptance

The web client has implemented regions for the sidebar, top bar, chats, review, processes and settings. `bun run test:web` checks the rendered client independently of the hosted acceptance gates in 06.

## Local browser checks

```sh
bun install --frozen-lockfile
./tests/e2e/node_modules/.bin/playwright install --with-deps chromium firefox webkit
bun run test:web
```

The suite runs desktop Chromium, Firefox and WebKit, dark Chromium, and phone Chromium. Desktop-only tests skip on the phone; the phone navigation test skips on desktop. These skips are intentional coverage boundaries. No deployment, GitHub write or agent login is required.

The initial fixture run lacked the production Tailwind source scan and was discarded as visual evidence. The final harness loads production styles, asserts the app fills the viewport, and uses the production router and auth guard. The native pending-send regression was formatted with Rust 1.97 but could not be executed here because this workspace has no native build toolchain.

Verified after integrating main `5e259d6` on 2026-10-11: all 59 applicable cases passed with production styles, plus all 21 existing workspace browser regressions. Six desktop/phone-specific cases skip intentionally. Root typecheck, lint, unit tests, format check, version check and production build pass.

The harness loads the production shell, home/history views, workspace layout, components, stores, query hooks and shortcut handlers. Only the server-function transport is aliased to a fixture endpoint. Playwright intercepts that endpoint, authentication reads, attachment uploads and the real client WebSockets. RPC inputs and outputs are checked against `packages/protocol` schemas. Unexpected RPC calls and browser exceptions fail the test. The harness is a separate Vite entry under `apps/tempo/test/web`; it is excluded from the production route tree and build.

| Flow | Coverage |
| --- | --- |
| Live state and drafts | Workspace updates, per-chat text drafts and reload recovery |
| Prompt submission | Send, queue, queued edit, Stop, duplicate submission guard, failed-send recovery after switching tabs |
| Composer | File mentions, `/plan`, attachment upload, unsent chips across chats |
| Transcript | Historical backlog stays quiet; completed live messages announce once |
| Permissions | Enter on a focused card sends the first allow option and applies the live answer |
| Workspace creation | Project, new-branch source, available agent and first text prompt |
| Git actions | Commit and push → Create PR → Merge → Archive, with Undo |
| Review | Diff, draft comments, sending comments in a prompt, fuzzy file opening |
| Processes and settings | Run shortcut, live output, Stop, xterm mount, palette and Appearance |
| Phone | Workspaces/Chat/Changes navigation, unified diff, primary git action and hidden terminal |
| Workspace states | Sleeping banner, send-to-wake, archived composer and Restore |

CI runs this suite and the existing 21 workspace browser regressions in the `web` job and retains traces on failure. Browser-engine tests on Linux do not satisfy the spec's manual shortcut check in the shipped Chrome, Safari and Firefox on macOS.

Restricted Linux sandboxes may need `TEMPO_WEB_NO_SANDBOX=1` for the test Firefox profile, together with the host's Mozilla sandbox environment settings. This affects only the test browser. Ordinary development and CI use the default profile.

## Hosted acceptance with keeled

Use `https://github.com/kcc989/keeled` as the linked test project. The original checkout was `ffee1fa7c2baa17635ae8e0e9d2164f2919e5f62`. Its missing PR-check workflow is now added through [keeled PR #17](https://github.com/kcc989/keeled/pull/17), merged as `070c74e`. The workflow runs the existing `bun run check` command with Bun 1.4.2. Lint, formatting, typecheck and all 111 offline tests pass, and the workflow passed GitHub CI. This supplies the PR checks required by AT-17.

Hosted gates require:

1. An owner-approved Workers Paid deployment and network access to its `APP_HOST` and `PREVIEW_DOMAIN`.
2. GitHub App setup and installation on keeled, then linking keeled in Tempo.
3. Agent logins in Settings. Claude covers the early gates; additional adapters need their own credentials.
4. An owner bearer session and Playwright storage state, as described in `tests/e2e/README.md`.
5. `TEMPO_E2E_URL`, `TEMPO_E2E_TOKEN`, and the linked `TEMPO_E2E_PROJECT_ID`.

Run gates B–D three times with `E2E_REPEAT=3`, then perform the manual checks and credential grep documented in the deployed suite. AT-17 and AT-18 push and merge a test file into keeled; use that repo only with the owner's authorization for these writes. Never count skipped deployed tests or local fixture tests as proof of a hosted agent session.

The owner approved deployment and hosted tests on 2026-10-11. PR #5's GitHub CI passed. Cloudflare preflight confirms an active account token, active app/preview zones, and the proxied preview wildcard DNS record. No Tempo Worker or D1 database exists yet.

The production image built as `sha256:f0b5fa7a2601babcf3e78a31509f489f1b364212f7c1da923b745f5003910e30`, at 3,171,713,483 bytes (under 6 GB). All 119 daemon tests pass inside it. The runner supplies proxy settings and a temporary BuildKit CA secret; neither credentials nor the runner CA are copied into image layers.

Alchemy's optional `@effect/platform-node` peer at the existing Effect version 4.0.3 was initially supplied in local deployment tooling to unblock CLI module loading. Main now includes this pinned dependency and a guarded deployment command. The approved `production` deployment attempt stopped at remote state initialization; no app cloud resources were provisioned. The current enforced network policy still denies the necessary destinations. Add these through the environment configuration workflow before resuming:

- `tempod.dev`
- `typecast.dev` and `*.typecast.dev`
- `alchemy-state-store.apingot.workers.dev` (the account's existing Alchemy state service)
- `registry.cloudflare.com` (the container image registry reported by Cloudflare)

Deployment approval remains in effect. After network access is enabled, resume the same Alchemy account/profile with `--stage production`, using `ALCHEMY_HOME=/workspace/.config/tempo-alchemy` on this runner. Owner GitHub App setup, sign-in and agent credentials still need the real app; no hosted gate or paid agent evaluation has run.

Main `022fdf1` now supplies closed/merged PR titles and owner-authenticated attachment retrieval through shared contracts, as recorded in `WEB-CLIENT-CORE-REQUESTS.md`. Client integration and hosted verification still need those contracts; historical per-turn token accounting remains open.
