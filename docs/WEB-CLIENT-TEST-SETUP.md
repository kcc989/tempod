# Web client test environment

The owner authorized creating a dedicated test environment and disposable repository in this chat. Creating `kcc989/tempo-web-client-acceptance` was attempted, but GitHub rejected `createRepository` with `Resource not accessible by integration`. No test repository was created. No deployment or paid evaluation has been performed. The current cloud runtime has no configured Cloudflare credentials, account, app host, preview domain, or agent logins.

## Deployment inputs

Use a dedicated Workers Paid test account: the existing deployment scripts name their Worker, Alchemy stack and D1 database `tempo`, and R2 bucket `tempo-data`. Running them in an account already hosting Tempo would update those resources. Core owns any change to make resource names configurable.

Configure these runtime bindings through the environment's secret/configuration controls, never in a chat message, screenshot, committed file, or shell history:

| Input | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Scoped access for the existing Alchemy/Wrangler deployment |
| `CLOUDFLARE_ACCOUNT_ID` | Dedicated Workers Paid account |
| `APP_HOST` | Test app hostname in that account |
| `PREVIEW_DOMAIN` | Separate preview zone, with proxied wildcard `AAAA * 100::` |
| `TEMPO_OWNER_GITHUB_ID` | Numeric GitHub owner ID for the authorized test login |

The preview domain must differ from the app host and cannot be its parent. The runtime's network policy must allow Cloudflare's API, the chosen app hostname, and the preview zone; the current policy does not include them. Keep the session proxy and CA verification enabled.

Deploy from the agreed integration commit using the existing root `bun run deploy` after core confirms the resource destination and test-fixture reservation. Docker image builds must follow the cloud-environment runtime skill's proxy/CA guidance. Do not record the printed setup URL: its query contains the setup token.

## Disposable repository

Create `tempo-web-client-acceptance` under the authorized test GitHub account, with no branch protection and no secrets. Install the test GitHub App on only this repository. The repository must contain at least three tracked text files and a `pull_request` workflow, as required by the [e2e guide](https://github.com/kcc989/tempod/blob/b1ba351bfdbfad66215bbc3e9ea6e6a6c7e3ba0a/tests/e2e/README.md). Use a simple localhost dev server for preview and terminal tests; add a `.conductor/settings.toml` fixture for AT-14. AT-17/18 intentionally push and merge changes into this repository's default branch.

Sign in to the deployed app with the owner, add the authorized agent logins in Settings, link the repository, and obtain `TEMPO_E2E_PROJECT_ID` using `listProjects`. Complete the browser device flow described in the guide for a short-lived `TEMPO_E2E_TOKEN`. Save signed-in Playwright state to a private file outside the repository as `TEMPO_E2E_STORAGE_STATE`; revoke that session after acceptance.

Core and web must reserve this project for one suite at a time. The suite temporarily changes settings, creates workspaces, pushes branches, merges PRs, archives and deletes workspaces. Never run concurrent destructive gate suites against it.

## Evidence to collect

Record deployment URL, tested commit, platform/browser versions, start/end time, acceptance ID and result for each run. Redact capability preview URLs and all credentials. Capture safe screenshots of the UI, and keep traces containing tokens private. Do not attach authenticated storage state to the report.

```bash
cd tests/e2e
E2E_REPEAT=3 bun run test gate-b
E2E_REPEAT=3 bun run test gate-c
E2E_REPEAT=3 bun run test gate-d
```

The three consecutive runs must pass against the real deployment. Manual AT-1, AT-5, AT-7, AT-8 and AT-22 checks and gate-D credential grep remain required. Chrome, Safari and Firefox shortcuts on macOS require a macOS runner; Linux Playwright WebKit is not shipped Safari.

## Independent local browser checks

The local fixture build renders the production routes/components and consumes synthetic shared-protocol messages. It replaces only the server-function transport. It creates no accounts, workspaces, git branches or paid turns and is not hosted acceptance evidence.

```bash
bun run --cwd tests/e2e playwright install chromium firefox webkit
bun run --cwd tests/e2e test:browser
```

Install Playwright's Linux runtime dependencies when needed. In this cloud runner, downloaded browsers and extracted runtime libraries live under `/tmp`; Firefox requires execution outside the filesystem sandbox to initialize its renderer. No application library or pinned version changed.
