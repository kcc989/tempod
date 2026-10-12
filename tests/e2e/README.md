# Acceptance tests (e2e)

Playwright tests for the acceptance tests in `docs/06 Build Plan.md` (gates B, C and D) and the
server side of gate E in `docs/07 Mac Client.md` (AT-23 to AT-25). They run against a **deployed
test environment** with real logins. A gate passes when every test in it passes 3 runs in a row.

Without `TEMPO_E2E_URL` every test is skipped, so `bun run test:e2e` is safe anywhere.

## Layout

| File                          | Covers                                                                                                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `playwright.config.ts`        | Chromium, `retries: 0`, `repeatEach` from `E2E_REPEAT`, `list` reporter, one worker (timing targets are measured, so tests do not share the deployment)                     |
| `tests/gate-b.spec.ts`        | AT-1 to AT-8                                                                                                                                                                |
| `tests/gate-c.spec.ts`        | AT-9 to AT-16                                                                                                                                                               |
| `tests/gate-d.spec.ts`        | AT-17 to AT-22, and the credential grep                                                                                                                                     |
| `tests/gate-e-server.spec.ts` | AT-23 to AT-25 (`/api/v1`, device sign-in, channel upgrades)                                                                                                                |
| `tests/lib/api.ts`            | Typed `rpc(name, input)` over `POST /api/v1/rpc/<fn>` (types from `@tempo/protocol`), attachments, preview URLs, WebSocket channels with a bearer token, raw upgrade status |
| `tests/lib/channels.ts`       | Workspace and hub channel clients, with the apply rules of 02 and timestamps                                                                                                |
| `tests/lib/terminal.ts`       | Terminal channel: runs shell scripts in the container, tree hashes, stopping the container                                                                                  |
| `tests/lib/flows.ts`          | Test workspaces (archived and deleted after each test), prompts, permissions, project settings                                                                              |
| `tests/lib/ui.ts`             | Browser helpers; selectors use only names and copy from 04                                                                                                                  |

Most tests drive the native JSON API and the channels, the same contract the web UI and the Mac
app use. Tests marked `(browser)` drive the web UI and need `TEMPO_E2E_STORAGE_STATE`.

## Local web acceptance

`bun run test:web` from the repo root runs the production client with local protocol fixtures in Chromium at desktop and phone width, including dark mode. It needs no deployment or credentials. See [`docs/WEB_ACCEPTANCE.md`](../../docs/WEB_ACCEPTANCE.md). The default `test` command below still runs the separate deployed acceptance gates.

## Environment

| Variable                                                                  | Needed for                                                   | Value                                                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `TEMPO_E2E_URL`                                                           | everything                                                   | `https://<APP_HOST>` of the test deployment                                                            |
| `TEMPO_E2E_TOKEN`                                                         | everything                                                   | A Better Auth session token of the owner, sent as `Authorization: Bearer` (see below)                  |
| `TEMPO_E2E_PROJECT_ID`                                                    | every test that creates a workspace                          | Id of the linked test repo's project (`listProjects`)                                                  |
| `TEMPO_E2E_STORAGE_STATE`                                                 | `(browser)` tests, AT-24 cookie check, AT-25 cookie upgrades | Path to a Playwright storage state of the signed-in owner                                              |
| `TEMPO_E2E_PREVIEW_DOMAIN`                                                | AT-16 URL format check                                       | The deployment's `PREVIEW_DOMAIN`                                                                      |
| `E2E_REPEAT`                                                              | gate runs                                                    | Runs of each test, default `1`; use `3` for a gate                                                     |
| `TEMPO_E2E_MODEL_CODEX`, `TEMPO_E2E_MODEL_OPENCODE`, `TEMPO_E2E_MODEL_PI` | AT-10 (optional)                                             | Model config value passed to `createSession` (01: OpenCode and Pi need one unless the project sets it) |
| `TEMPO_E2E_CODEX_AUTH_FILE`                                               | AT-11                                                        | Path to a fresh `~/.codex/auth.json` of the test account (below)                                       |
| `TEMPO_E2E_SECRETS_FILE`                                                  | credential grep                                              | Path to a file with one test credential value per line                                                 |
| `TEMPO_E2E_WORKER_LOG`                                                    | credential grep                                              | Path to the `wrangler tail` output of the run                                                          |
| `TEMPO_E2E_R2_DUMP`                                                       | credential grep                                              | Path to an unpacked copy of the `tempo-data` bucket                                                    |
| `TEMPO_E2E_KEEP`                                                          | debugging                                                    | `1` keeps the workspaces a test creates                                                                |

**Session token.** Sign in the way the Mac app does (07, Sign-in and first run):

```bash
curl -s -X POST "$TEMPO_E2E_URL/api/auth/device/code" -H 'content-type: application/json' -d '{"client_id":"tempo-mac"}'
# open verification_uri_complete in a browser where the owner is signed in, and click Approve
curl -s -X POST "$TEMPO_E2E_URL/api/auth/device/token" -H 'content-type: application/json' \
  -d '{"grant_type":"urn:ietf:params:oauth:grant-type:device_code","device_code":"<device_code>","client_id":"tempo-mac"}'
# access_token is TEMPO_E2E_TOKEN; revoke it later in Settings → Devices
```

**Storage state.** `./node_modules/.bin/playwright codegen --save-storage=owner.json "$TEMPO_E2E_URL"`,
sign in with GitHub as the owner, close the window, then `TEMPO_E2E_STORAGE_STATE=owner.json`.

**Channels.** Channel tests send `Authorization: Bearer` with no `Origin`, through Node's global
`WebSocket` (undici), which takes a non-standard `{ headers }` option from Node 22. The suite checks
this once against a local server; on a runtime that cannot send the header, channel tests are
skipped with that reason.

## The test deployment and repo

- Logins in Settings: a Claude token (all gates), a Codex login and an OpenRouter key (AT-10, AT-11).
- The test repo's default branch has at least three tracked text files (AT-12), a GitHub Actions
  workflow that runs on `pull_request` (AT-17 checks state) and no branch protection (AT-18 merges).
- The project's UI overrides set no `scripts` (AT-14) and no `git.branch_prefix` (AT-2 expects `tempo/`).
- Some tests change the project's settings for their duration and restore them: AT-6
  (`sleep_after_idle_minutes = 5`), AT-18 (`archive_on_merge`), AT-20 (egress policy). Do not run two
  suites against the same project at once.
- AT-17 and AT-18 push `e2e-tempo/last-run.md` and squash-merge it into the default branch on every run.
- Every test archives and deletes the workspaces it created.

## Running

Install Chromium once: `./node_modules/.bin/playwright install chromium`. Then, in `tests/e2e`:

```bash
export TEMPO_E2E_URL=https://tempo-test.example.com TEMPO_E2E_TOKEN=... TEMPO_E2E_PROJECT_ID=...
./node_modules/.bin/playwright test --list                  # what will run
E2E_REPEAT=3 ./node_modules/.bin/playwright test gate-b      # gate B: AT-1 to AT-8, 3 runs
E2E_REPEAT=3 ./node_modules/.bin/playwright test gate-c      # gate C: AT-9 to AT-16
E2E_REPEAT=3 ./node_modules/.bin/playwright test gate-d      # gate D: AT-17 to AT-22 (+ grep, below)
E2E_REPEAT=3 ./node_modules/.bin/playwright test gate-e      # gate E, server side: AT-23 to AT-25
./node_modules/.bin/playwright test --grep "AT-6 "           # one test
```

From the repo root, `bun run test:e2e` runs everything once. Tests take minutes each (AT-6 waits
for the idle timer, AT-9 runs five containers), so a gate run takes hours.

## Manual and `fixme` steps

These show as skipped (`fixme`); the comment above each one in the spec has the exact steps.

| Test                                                       | Why it is manual                                                                                                                                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AT-1 GitHub sign-in, and a different account refused       | Needs real GitHub logins (password, 2FA) for two accounts                                                                                                                             |
| AT-5 the R2 bundle exists                                  | No API lists R2; check with `wrangler r2 object get`. AT-8 depends on the bundle, so it covers it indirectly                                                                          |
| AT-7 destroy from the Cloudflare dashboard                 | The automated AT-7 stops tempod from inside the container instead (SIGKILL, or SIGTERM when tempod is PID 1)                                                                          |
| AT-8 with the snapshot marked `unusable`                   | No API marks a snapshot; the automated AT-8 uses a workspace that never slept (no snapshot), which takes the same fresh path. The literal case: sleep, redeploy a changed image, wake |
| AT-22 in Chrome on macOS, and the git and script shortcuts | Linux Chromium is not the shipped Chrome on macOS. The automated AT-22 covers ⌘K, ⌥N, ⌥,, ⌘B, ⌥L and ⌥T in Chromium                                                                   |
| AT-23 the Mac app's own screens                            | Part of the Mac app's gate E checklist; the server side is automated                                                                                                                  |
| Credential grep of `events` rows                           | No API reads the WorkspaceDO `events` table                                                                                                                                           |

AT-11 needs `TEMPO_E2E_CODEX_AUTH_FILE`. The test sets `last_refresh` 9 days back, uploads the file
with `setCodexAuth`, and makes Codex refresh in one workspace. Codex rotates the refresh token, so
use a fresh `codex login` file for each run.

## Credential grep (gate D)

06 requires zero matches of the test credentials' values in Worker logs, `events` rows and R2
objects after a full e2e run.

1. Write the secrets file: one value per line (Claude token, Codex `access_token`, `refresh_token`
   and `id_token`, the OpenRouter, Anthropic and OpenAI keys, project secret values, one inner line
   of the GitHub App private key). Lines under 8 characters are ignored.
2. Before the run, start `wrangler tail tempo --format json > worker-logs.jsonl` (in `apps/tempo`).
3. Run all gates.
4. Stop the tail. Copy the bucket through R2's S3 API (for example `rclone copy r2:tempo-data r2-dump`),
   then unpack what is compressed:
   ```bash
   find r2-dump -name '*.tar.zst' -exec sh -c 'mkdir -p "$1.d" && tar --zstd -xf "$1" -C "$1.d"' _ {} \;
   git clone --mirror https://github.com/<owner>/<repo>.git r2-dump/repo.git
   find r2-dump -name '*.bundle' -exec git -C r2-dump/repo.git fetch -q "$PWD/{}" 'refs/tempo/checkpoints/*:refs/tempo/checkpoints/*' \;
   git -C r2-dump/repo.git grep -F -f "$TEMPO_E2E_SECRETS_FILE" $(git -C r2-dump/repo.git for-each-ref --format='%(objectname)' refs/tempo/checkpoints) && echo LEAK
   ```
5. `TEMPO_E2E_SECRETS_FILE=... TEMPO_E2E_WORKER_LOG=worker-logs.jsonl TEMPO_E2E_R2_DUMP=r2-dump ./node_modules/.bin/playwright test --grep "credential grep"`.
   It also scans everything the API and the channels return for every workspace. Failures name
   the line number in the secrets file, never the value.
