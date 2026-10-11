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

Use `https://github.com/kcc989/keeled` as the linked test project. The checkout inspected for this work is `ffee1fa7c2baa17635ae8e0e9d2164f2919e5f62`. It has tracked text files and Bun tests, but no GitHub Actions workflow at that commit. AT-17 needs a workflow triggered by `pull_request` so checks can become pending and completed. Add a normal repository CI workflow before running that gate; for example, install its lockfile and run its existing `bun run check` command with the repository's chosen Bun version.

Hosted gates require:

1. An owner-approved Workers Paid deployment and network access to its `APP_HOST` and `PREVIEW_DOMAIN`.
2. GitHub App setup and installation on keeled, then linking keeled in Tempo.
3. Agent logins in Settings. Claude covers the early gates; additional adapters need their own credentials.
4. An owner bearer session and Playwright storage state, as described in `tests/e2e/README.md`.
5. `TEMPO_E2E_URL`, `TEMPO_E2E_TOKEN`, and the linked `TEMPO_E2E_PROJECT_ID`.

Run gates B–D three times with `E2E_REPEAT=3`, then perform the manual checks and credential grep documented in the deployed suite. AT-17 and AT-18 push and merge a test file into keeled; use that repo only with the owner's authorization for these writes. Never count skipped deployed tests or local fixture tests as proof of a hosted agent session.

The current cloud workspace has Cloudflare credentials configured, but its network policy refuses the configured app host. No deployment or real-agent gate was started in this work.

The shared-server gaps recorded in `WEB-CLIENT-CORE-REQUESTS.md` also remain open: historical per-turn token usage, PR titles after closing/merging, and authenticated attachment retrieval after reload. Local tests cannot supply these missing production contracts.
