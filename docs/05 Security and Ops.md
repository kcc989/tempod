# 05 Security and Ops

This tab defines who can do what, where secrets live, how traffic leaves a container, and how Tempo is deployed, observed and upgraded.

## Threat model

The main threat is code or text inside a workspace (a hostile dependency, a poisoned README, a prompt injection) that tries to steal credentials or reach other systems. Tempo assumes one trusted owner and treats everything inside a container as untrusted.

| Asset | Threat | Control |
| --- | --- | --- |
| GitHub token | Theft from the container | Never in the container; `TempoOutbound` adds it. Scoped to one repo. Lives about 1 hour. |
| OpenRouter, Anthropic, OpenAI keys | Theft from the container | Never in the container; swapped for a placeholder at egress |
| Claude token, Codex `auth.json` | Theft by code running in the container | Accepted risk R4 for one owner. Egress log shows every host contacted. The `allowlist` policy can limit hosts. |
| Other workspaces | One container reads another's files | One container per workspace; no shared disk or network |
| Tempo API | A container calls the Tempo app | Rule 0 in `TempoOutbound` blocks `APP_HOST`; every API call needs the owner's session cookie |
| `tempod` | Someone else drives the daemon | Reachable only through `getTcpPort` from its own DO; per-start bearer token |
| Previews | Someone finds a preview URL | 16-character secret in the hostname; rotate on demand; `Referrer-Policy: no-referrer` |
| The UI | XSS from agent output | Markdown rendered without raw HTML; remote images not loaded |
| The UI | CSRF | `SameSite=Lax` cookie, `POST` for writes, `Origin` check |
| Supply chain | A changed package or image | Every version pinned; the base image pinned by digest |

**Rules that follow from this**

- MUST NOT enable raw HTML in Markdown (no `rehype-raw`).
- MUST NOT load remote images in agent Markdown. Render them as links. Images from ACP `image` content blocks are fine; they are inline data.
- Links in the transcript open with `rel="noopener noreferrer"`.

## Authentication and authorization

One GitHub account owns a Tempo deployment. Nobody else can sign in.

- Sign-in uses Better Auth's GitHub provider with the **GitHub App's own OAuth client id and secret**. One GitHub App does sign-in and repo access.
- `TEMPO_OWNER_GITHUB_ID` is the owner's numeric GitHub user id. In Better Auth's sign-in hook, refuse any GitHub account whose id is different. Show `This Tempo belongs to someone else.`
- Session cookie: Better Auth default, `Secure`, `HttpOnly`, `SameSite=Lax`, 30-day expiry.
- Every server function runs the owner check (02). Every WebSocket upgrade checks the cookie and `Origin` (02).
- The setup pages (`/setup/*`) work only while no GitHub App is configured, and only with `?token=<TEMPO_SETUP_TOKEN>`. After setup they return 404.
- Cloudflare Access in front of `APP_HOST` is allowed as an extra layer. It MUST NOT be required.
- No GitHub webhooks in version 1. PR and check status come from polling (03).

## Secrets

Secrets live in exactly two places: Worker secrets for the deployment, and CredentialDO for everything else.

| Secret | Where | Set by |
| --- | --- | --- |
| `TEMPO_ENCRYPTION_KEY` | Worker secret | Deploy (32 random bytes, base64) |
| `BETTER_AUTH_SECRET` | Worker secret | Deploy (at least 32 random bytes) |
| `TEMPO_SETUP_TOKEN` | Worker secret | Deploy; printed once for the setup link |
| GitHub App id, slug, private key, client id, client secret | CredentialDO named `system`, keys `github_app.id`, `github_app.slug`, `github_app.private_key`, `github_app.client_id`, `github_app.client_secret` | The manifest flow (Deployment, below) |
| Agent logins, API keys, project secrets | The owner's CredentialDO (02) | The owner, in Settings |

**Rules**

- MUST NOT log a secret, put one in an error message, or store one in D1, in WorkspaceDO `events`, or in R2.
- The log helper redacts any field whose name matches `/token|key|secret|password|authorization|auth_json|cookie/i`.
- Home backups exclude `.codex/auth.json`, `.claude/.credentials.json` and `.tempod/` (01, Durability). The daemon outbox may contain unacknowledged credential refreshes.
- Container snapshots do hold Codex `auth.json`. They stay inside the Cloudflare account; this is part of R4.
- The `system` CredentialDO derives its key with salt `system` instead of a user id.
- Rotating `TEMPO_ENCRYPTION_KEY` is not supported in version 1. A new key makes every stored secret unreadable, and the owner enters them again. The GitHub App must then be set up again.

## Egress control

A container has no internet of its own. Every HTTP and HTTPS request goes through `TempoOutbound`; nothing else can leave.

- Containers start with `enableInternet: false`. Only ports 80 and 443 can leave, and only through the intercepts.
- Git over SSH does not work. Repos use HTTPS only.
- **Rule 0**, before the rules in 01: a request whose host is `APP_HOST` returns 403. Containers MUST NOT call the Tempo API.
- Egress settings come only from Tempo. `egress_policy` and `egress_allowlist` in `.tempo/settings.toml`, `.conductor/settings.toml` or `conductor.json` are ignored with a warning, because the agent can write those files.
- Policy `open`: every host passes, with credentials added only by rules 2 to 6.
- Policy `allowlist` (default): only the built-in agent hosts (01) and the project's `egress_allowlist` patterns pass. A pattern is a host or `*.` plus a domain; `*.example.com` matches `a.example.com` but not `example.com`.
- Every request is logged to `egress_log`: host, path without query, status, time, rule number. The owner sees the newest 10,000 rows in Diagnostics.
- Cloud metadata addresses are not reachable from containers, so Tempo needs no rule for them.

## Preview access

A preview URL is a capability: whoever has the link can use the app behind it. That keeps previews working in iframes, on phones and in Browser Run, with no cookies.

- Token: 16 characters from `[a-z0-9]`, from `crypto.getRandomValues`. That is about 82 bits.
- Compare tokens in constant time. A wrong token or an unknown workspace returns 404, never 403.
- `rotatePreviewToken` makes a new token; old links stop working at once.
- The Worker adds `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex, nofollow` to every preview response.
- `PREVIEW_DOMAIN` MUST NOT be `APP_HOST` or a parent of it, so preview pages cannot read Tempo's cookies.
- MUST NOT log full preview hostnames. Log the port and workspace id only.
- Open question Q3 (00): whether to add Cloudflare Access in front of previews.

## Deployment and configuration

One deploy command builds the image, deploys the Worker and runs migrations. A one-time setup page then creates the GitHub App.

**Before the first deploy**

- A Cloudflare account on Workers Paid.
- `APP_HOST`: a hostname for the app, for example `tempo.example.com`.
- `PREVIEW_DOMAIN`: a separate zone in the account, for example `example-previews.com`, with one proxied DNS record `AAAA * 100::`.
- The owner's numeric GitHub user id (`https://api.github.com/users/<login>` shows it as `id`).

**Config**

| Name | Kind | Value |
| --- | --- | --- |
| `APP_HOST` | var | App hostname |
| `PREVIEW_DOMAIN` | var | Preview zone apex |
| `TEMPO_OWNER_GITHUB_ID` | var | Owner's GitHub user id |
| `TEMPO_ENCRYPTION_KEY` | secret | 32 random bytes, base64 |
| `BETTER_AUTH_SECRET` | secret | At least 32 random bytes |
| `TEMPO_SETUP_TOKEN` | secret | 32 random characters |
| `DB` | D1 binding | Database `tempo` |
| `DATA` | R2 binding | Bucket `tempo-data` |
| `WORKSPACE`, `USER_HUB`, `CREDENTIALS` | DO bindings | As in 01 |

**Deploy.** `bun run deploy` first verifies Cloudflare API access and the existing Alchemy state-store health endpoint, then runs Alchemy v2. An unreachable existing store must stop deployment before bootstrap; a network error must never be interpreted as absent state. When the store exists, the wrapper disables automatic bootstrap/upgrade approval (`--yes`) and runs without prompts. Existing state-store auth/encryption secrets and the Tempo secrets must be preserved. It MUST: build `dist/tempod`, build and push the container image, create D1 and R2 if missing, apply D1 migrations, set vars and secrets (generating the three secrets on first deploy), deploy the Worker, and print `https://<APP_HOST>/setup/github?token=<TEMPO_SETUP_TOKEN>`.

**GitHub App setup** (manifest flow)

1. The setup page posts a manifest to `https://github.com/settings/apps/new` (or the org's `.../organizations/<org>/settings/apps/new`).
2. Manifest: `name` = `Tempo (<APP_HOST>)`, `url` = `https://<APP_HOST>`, `callback_urls` = `["https://<APP_HOST>/api/auth/callback/github"]`, `redirect_url` = `https://<APP_HOST>/setup/github/callback`, `setup_url` = `https://<APP_HOST>/setup/github/installed`, `public: false`, `hook_attributes: {active: false}`, `default_permissions`: `contents: write`, `pull_requests: write`, `metadata: read`, `checks: read`, `actions: read`, `issues: read`.
3. The callback exchanges the code with `POST https://api.github.com/app-manifests/<code>/conversions` and stores the id, slug, PEM, client id and client secret in the `system` CredentialDO.
4. The page then links to `https://github.com/apps/<slug>/installations/new`.
5. After install, GitHub redirects to `setup_url` with `installation_id`. Tempo stores it once the owner signs in. The Add project dialog also syncs installations with GET /app/installations (app JWT) before it lists repos, so installs on more accounts appear without this redirect.

The GitHub App config is read from the `system` CredentialDO with getGithubAppConfig() and cached in isolate memory for 5 minutes.

## Observability and logs

Every log line is structured JSON, and every workspace has a Diagnostics view that shows its own history.

- Turn on Workers Logs (`observability.enabled: true`).
- Log line shape: `{ts, level, msg, workspaceId?, opId?, step?, ...}`. Levels: `debug`, `info`, `warn`, `error`. Production logs `info` and up.
- All logs pass through the redact helper (Secrets).
- Each op stores its step timings in `ops.state_json`, as `{"timings": {"<step>": <ms>}}`.
- `tempod` `log` events of level `warn` or higher are kept in `events` for 7 days.

**Diagnostics view** (overflow menu, `Diagnostics`)

| Panel | Content |
| --- | --- |
| Ops | The last 50 ops with status, steps, timings and errors |
| Container | State, instance, image ref, snapshot list, `tempod` version and incarnation |
| Logs | The newest 200 `log` events |
| Egress | The newest 500 `egress_log` rows, filterable by host and status |
| Sessions | Each session's agent, ACP session id, capabilities and live or not |

## Upgrades and versioning

A deploy MUST NOT break running containers. Old `tempod` binaries keep running until their container is destroyed.

- **Protocol changes are additive only** within protocol version 1: new ops, new events and new optional fields. The DO logs and ignores unknown event kinds. `tempod` answers unknown ops with `{ok: false, error: {code: "UNKNOWN_OP"}}`.
- The DO reads `tempod`'s version from `/v1/health` and logs a `warn` when it differs from its own build.
- **Image changes** make every snapshot unusable, so the next wake of each workspace takes the fresh path. Release notes MUST say when the image changed.
- **Migrations** are forward only. Version 1 MUST NOT drop or rename a column; add new ones instead.
- **Agent upgrades:** change `container/versions.json`, rebuild, run the adapter conformance tests (06), deploy.
- **Rollback:** deploy the previous build. Containers started on the newer image keep it until they sleep.

## Cost model

Container memory is the biggest cost; sleeping is the main control. The per-hour figures are in 00, Cost.

| Cost | Driver | Control |
| --- | --- | --- |
| Container memory | Provisioned GiB × hours running | `sleep_after_idle_minutes` (default 15); instance size per project |
| Container CPU | Active CPU only | None needed; idle waiting costs little |
| Container disk | Provisioned GB × hours running | Instance size |
| Durable Objects | Duration while a container runs (the DO holds a socket) | Same as memory: sleep |
| R2 | Bundles, backups, logs, attachments | Retention rules (02) |
| Browser Run (phase 3) | Browser hours over 10 a month | Off by default |
| Models | Your Claude and ChatGPT plans; OpenRouter usage | Outside Tempo |

The UI shows the instance size in the container pill, so the owner can see what is running.
