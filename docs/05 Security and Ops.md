# 05 Security and Ops

This tab defines who can do what, where secrets live, how traffic leaves a container, and how Tempo is deployed, observed and upgraded.

## Threat model

The main threat is code or text inside a workspace (a hostile dependency, a poisoned README, a prompt injection) that tries to steal credentials or reach other systems. Tempo assumes one trusted owner and treats everything inside a container as untrusted.

| Asset | Threat | Control |
| --- | --- | --- |
| GitHub token | Theft from the container | Never in the container; `TempoOutbound` adds it. Scoped to one repo. Lives about 1 hour. |
| OpenRouter, Anthropic, OpenAI keys | Theft from the container | Never in the container; swapped for a placeholder at egress |
| Environment secrets with `hosts` | Theft from the container, or sent to another host | Never in the container. Swapped only for hosts in the secret's `hosts`; a placeholder for any other host is refused (rule 7). An echo endpoint on an allowed host could reflect the value, so keep `hosts` narrow. |
| Injectors | Code that reads secrets | Only the owner saves injector code; an agent can only propose it. Injectors get MACs, not values, and can reach only their own `hosts`. |
| Agent proposals | The agent asks for wide egress or a hostile injector | The owner reviews every proposal and sees the full code before Apply. Secret values are typed in the review form, never in chat. |
| MCP server secret headers | Theft from the container, or replay to another host | Never in the container; rule 12 swaps the placeholder only for the host of the server that owns it |
| Claude token, Codex `auth.json` | Theft by code running in the container | Accepted risk R4 for one owner. Egress log shows every host contacted. The `allowlist` policy can limit hosts. |
| Other workspaces | One container reads another's files | One container per workspace; no shared disk or network |
| Tempo API | A container calls the Tempo app | Rule 0 in `TempoOutbound` blocks `APP_HOST`; every API call needs the owner's session cookie |
| `tempod` | Someone else drives the daemon | Reachable only through `getTcpPort` from its own DO; per-start bearer token |
| Previews | Someone finds a preview URL | The URL holds no secret; every request needs the owner's preview cookie; reset on demand; `Referrer-Policy: no-referrer` |
| The UI | XSS from agent output | Markdown rendered without raw HTML; remote images not loaded; SVG and Mermaid output only through `<img>` |
| Artifacts | Agent HTML reads Tempo data or sends data out | Never on `APP_HOST`; one host per artifact under `PREVIEW_DOMAIN`; owner cookie; CSP blocks every network fetch. Self-navigation of the frame is not blocked (R19). |
| The UI | CSRF | `SameSite=Lax` cookie, `POST` for writes, `Origin` check |
| Supply chain | A changed package or image | Every version pinned; the base image pinned by digest |

**Rules that follow from this**

- MUST NOT enable raw HTML in Markdown (no `rehype-raw`).
- MUST NOT load remote images in agent Markdown. Render them as links. Images from ACP `image` content blocks are fine; they are inline data.
- Links in the transcript open with `rel="noopener noreferrer"`.
- Guided PR HTML artifacts are an explicit isolated preview, never raw HTML inside Markdown or the app document. Load repository content through the authenticated `readFile` function. An artifact iframe uses only `sandbox="allow-scripts"` (no same-origin, popups, forms, downloads or top navigation), `referrerpolicy="no-referrer"`, and a CSP prepended before artifact content: `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`. Artifacts must use inline CSS/JavaScript and data media; remote dependencies are blocked. Load them only after the user opens them. The Mac app opens guides in the authenticated web client instead of executing HTML natively.
- MUST NOT render SVG inline, in `<object>` or in an `<iframe>` on `APP_HOST`. SVG files, SVG artifacts and Mermaid output render only through `<img>`.
- MUST NOT serve artifact HTML or PDFs from `APP_HOST`. The artifact route sends them only as downloads (02).

## Authentication and authorization

One GitHub account owns a Tempo deployment. Nobody else can sign in.

- Sign-in uses Better Auth's GitHub provider with the **GitHub App's own OAuth client id and secret**. One GitHub App does sign-in and repo access.
- `TEMPO_OWNER_GITHUB_ID` is the owner's numeric GitHub user id. In Better Auth's sign-in hook, refuse any GitHub account whose id is different. Show `This Tempo belongs to someone else.`
- Session cookie: Better Auth default, `Secure`, `HttpOnly`, `SameSite=Lax`, 30-day expiry.
- Every server function runs the owner check (02), except the `visitor` functions of 11, which read public projects without a session. Every WebSocket upgrade checks the cookie and `Origin` (02).
- The setup pages (`/setup/*`) work only while no GitHub App is configured, and only with `?token=<TEMPO_SETUP_TOKEN>`. After setup they return 404.
- Cloudflare Access in front of `APP_HOST` is allowed as an extra layer. It MUST NOT be required. It also hides the public pages of 11 from visitors unless its policy lets them in.
- No GitHub webhooks in version 1. PR and check status come from polling (03).

## Secrets

Secrets live in exactly two places: Worker secrets for the deployment, and CredentialDO for everything else.

| Secret | Where | Set by |
| --- | --- | --- |
| `TEMPO_ENCRYPTION_KEY` | Worker secret | Deploy (32 random bytes, base64) |
| `BETTER_AUTH_SECRET` | Worker secret | Deploy (at least 32 random bytes) |
| `TEMPO_SETUP_TOKEN` | Worker secret | Deploy; saved privately for the setup link |
| GitHub App id, slug, private key, client id, client secret | CredentialDO named `system`, keys `github_app.id`, `github_app.slug`, `github_app.private_key`, `github_app.client_id`, `github_app.client_secret` | The manifest flow (Deployment, below) |
| Agent logins, API keys, project secrets, environment secrets | The owner's CredentialDO (02) | The owner, in Settings |
| Cloudflare deploy master token; per-deployment minted tokens | The owner's CredentialDO, keys `cloudflare.deploy_token`, `cloudflare.account_id` and `deploy.<deploymentId>.token` (12) | The owner, in Settings; `AppDeployDO` mints and revokes each deployment's token |

**Rules**

- MUST NOT log a secret, put one in an error message, or store one in D1, in WorkspaceDO `events`, in lifecycle events (08), or in R2.
- Agent definitions in D1 hold only `${NAME}` references in MCP `env` and `headers`; validation refuses literal values (08). Agent proposals write nothing until the owner applies them.
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
- The egress policy and allowlist come from the workspace's environment (01, Environments). With no environment, they come from the project's Tempo overrides.
- Egress settings come only from Tempo. `egress_policy` and `egress_allowlist` in `.tempo/settings.yaml` are ignored with a warning, because the agent can write those files.
- Policy `open`: every host passes, with credentials added only by rules 2 to 6.
- Policy `allowlist` (default): only the built-in agent hosts (01), the `egress_allowlist` patterns, and the hosts of the owner's enabled `http` and `sse` MCP servers pass. A pattern is a host or `*.` plus a domain; `*.example.com` matches `a.example.com` but not `example.com`.
- Every request is logged to `egress_log`: host, path without query, status, time, rule number. The WorkspaceDO keeps the newest 10,000 rows. Diagnostics searches all of them (Observability).
- Cloud metadata addresses are not reachable from containers, so Tempo needs no rule for them.
- CI job containers (10, Egress) use a separate, smaller rule set: read-only access to their own repository through a read token, no other credential or placeholder swap, and the built-in hosts plus the owner-approved pipeline `egress_allowlist`. Their requests are logged with `log()`, not stored in `egress_log`.
- Deploy containers (12, Egress) use the CI rule set plus one swap: a `Bearer tempo-placeholder` Authorization header to `api.cloudflare.com` becomes the deployment's minted token. They also reach `api.cloudflare.com`, `*.workers.dev` and the configuration's `egress_allowlist`.

## Preview access

A preview is for the owner only. The hostname names the port and the workspace and holds no secret. Each request needs a preview cookie, and only an owner-only server function can start one.

- **Entry link.** `openPreview {workspaceId, port}` returns `https://<P>-<workspaceId lowercase>.<PREVIEW_DOMAIN>/__tempo/enter?code=<code>`. The code is 32 characters from `[a-z0-9]`, from `crypto.getRandomValues`. It works once, for that port only, for 60 s. The WorkspaceDO stores only its SHA-256 in `preview_codes`.
- **Enter.** `GET /__tempo/enter?code=<code>` calls `previewEnter(port, code)`. A good code is deleted and the Worker answers `303` to `/` with `Set-Cookie: __Host-tempo_preview=<value>; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=86400` and `Cache-Control: no-store`. A bad, used or expired code returns the preview 404 page.
- **Cookie value.** `<expiresAt>.<mac>`: `expiresAt` in epoch seconds, 24 hours ahead; `mac` is base64url HMAC-SHA256 with `preview_key` over `<port>.<expiresAt>`. The DO checks the expiry and compares the MAC in constant time. The Worker removes the cookie before the request reaches the app.
- `Partitioned` keeps the cookie working inside Tempo's iframe, where it is a third-party cookie.
- **Preview 404 page.** One fixed page, the same for an unknown workspace, a bad host, a missing or bad cookie and a bad code: `This preview opens only from Tempo.` It never says whether the workspace exists.
- `rotatePreviewKey` makes a new `preview_key`; every preview cookie for the workspace stops working at once.
- Paths under `/__tempo/` on a preview host belong to Tempo; the app never sees them.
- The Worker adds `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex, nofollow` to every preview response.
- `PREVIEW_DOMAIN` MUST NOT be `APP_HOST` or a parent of it, so preview pages cannot read Tempo's cookies.
- MUST NOT log preview codes, cookie values or request URLs on a preview host. Log the port and workspace id only.
- Browser Run does not use previews: it reaches the app through `BrowserOutbound` (01, Browser Run).

## Artifact access

HTML and PDF artifacts open only from their own host. The rules copy Preview access; the differences are listed here.

- **Host.** `a-<artifactId>-<workspaceId lowercase>.<PREVIEW_DOMAIN>`. The Worker matches the first label against `^a-([0-9a-hjkmnp-tv-z]{26})-([0-9a-hjkmnp-tv-z]{26})$`. Each artifact has its own origin, so one artifact cannot read another.
- **Entry link.** `openArtifact {workspaceId, artifactId, version}` returns `https://<host>/__tempo/enter?code=<code>`. The code follows the preview rules (32 characters, once, 60 s) and is bound to that artifact and version. The WorkspaceDO stores only its SHA-256 in `artifact_codes`.
- **Enter.** A good code is deleted. The Worker answers `303` to `/<version>/<name>` (name percent-encoded) with `Set-Cookie: __Host-tempo_artifact=<value>; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=86400` and `Cache-Control: no-store`.
- **Cookie value.** `<expiresAt>.<mac>`, with the MAC over `a.<artifactId>.<expiresAt>` and the workspace's `preview_key`. `rotatePreviewKey` also ends every artifact cookie.
- **Requests.** `GET /<version>/<name>` with a good cookie calls `artifactFetch`, which streams that version from R2. Any version of the artifact works with one cookie. Every other path, method or name, a version not `ready`, and a missing or bad cookie return the preview 404 page.
- **Response headers** (every response):

| Kind | `Content-Type` | `Content-Security-Policy` |
| --- | --- | --- |
| `html` | `text/html; charset=utf-8` | `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob:; style-src 'unsafe-inline' data: blob:; img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors https://<APP_HOST>; sandbox allow-scripts allow-forms allow-modals allow-downloads` |
| `pdf` | `application/pdf` | `default-src 'none'; frame-ancestors https://<APP_HOST>`. No `sandbox`: browsers do not render PDFs in a sandboxed document. |
| Any other kind | Its `mime` | `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors https://<APP_HOST>; sandbox` |

  Also `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow` and `Cross-Origin-Opener-Policy: same-origin`.
- **Offline.** The CSP blocks `fetch`, XHR, WebSocket, `EventSource`, beacons, form posts and every remote script, style, image, font and frame. Without `allow-same-origin` the document has an opaque origin, so it has no cookies and no storage. Without `allow-popups` and `allow-top-navigation` it cannot open windows or move Tempo's page.
- **Accepted gap (R19).** A frame can still navigate itself to another site, with data in the URL. No browser control blocks this. It adds little: the agent that wrote the HTML can already send data out through egress under the `open` policy.
- MUST NOT log artifact codes, cookie values or request URLs on an artifact host. Log the artifact id and workspace id only.
- Spike S18 MUST confirm the cookie flow inside Tempo's iframe, the CSP above in Chrome, Safari and Firefox, and PDF display in the iframe.

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

**Deploy.** `bun run deploy` first verifies Cloudflare API access and the dedicated Tempo state-store health endpoint, then runs Alchemy v2. An unreachable existing store must stop deployment before bootstrap; a network error must never be interpreted as absent state. When the store exists, the wrapper sets `TEMPO_STATE_BOOTSTRAP_ALLOWED=0` and runs without prompts. The SDK patch then refuses automatic state-store bootstrap/upgrade even when `--yes` approves the app resource plan. Existing state-store auth/encryption secrets and the Tempo secrets must be preserved. It MUST: build `dist/tempod`, build and push the container image, create D1 and R2 if missing, apply D1 migrations, set vars and secrets (generating the three secrets on first deploy), deploy the Worker, and save `https://<APP_HOST>/setup/github?token=<TEMPO_SETUP_TOKEN>` privately in mode-0600 `.alchemy/tempo-setup-link.txt`. The pinned SDK patch isolates Worker/DO namespace, auth/encryption secret names, bootstrap stack and credential cache identity (deployment guide). Stage `production` and profile `tempo` are fixed by the wrapper. Bootstrap and generated Tempo secrets persist in encrypted remote state; local files are caches. The unrelated account-wide `alchemy-state-store` and its secrets MUST NOT be touched or reused.

On TLS-proxied deployment runners, `TEMPO_BUILD_CA` supplies the temporary BuildKit CA secret for an explicit full-image build and Wrangler registry push. The Worker uses the image tagged by its digest; CA material stays out of image layers. Deployment runs Wrangler every time so the private setup link is recreated on fresh VMs. A missing dedicated Worker with surviving dedicated state-store secrets or local bootstrap files must fail closed to prevent key rotation.

**GitHub App setup** (manifest flow)

1. The setup page posts a manifest to `https://github.com/settings/apps/new` (or the org's `.../organizations/<org>/settings/apps/new`).
2. Manifest: `name` = `Tempo (<APP_HOST>)`, `url` = `https://<APP_HOST>`, `callback_urls` = `["https://<APP_HOST>/api/auth/callback/github"]`, `redirect_url` = `https://<APP_HOST>/setup/github/callback`, `setup_url` = `https://<APP_HOST>/setup/github/installed`, `public: false`, `hook_attributes: {active: false}`, `default_permissions`: `email_addresses: read` (account permission required for private-email sign-in), `contents: write`, `pull_requests: write`, `metadata: read`, `checks: read`, `actions: read`, `issues: read`.
3. The callback exchanges the code with `POST https://api.github.com/app-manifests/<code>/conversions` and stores the id, slug, PEM, client id and client secret in the `system` CredentialDO.
4. The page then links to `https://github.com/apps/<slug>/installations/new`.
5. After install, GitHub redirects to `setup_url` with `installation_id`. Tempo stores it once the owner signs in. The Add project dialog also syncs installations with GET /app/installations (app JWT) before it lists repos, so installs on more accounts appear without this redirect.

Existing Apps created without `email_addresses: read` must enable **Permissions & events → Account permissions → Email addresses → Read-only** in GitHub App settings. Save the change and sign in again, accepting updated authorization if GitHub prompts. Better Auth requires an email address; OAuth scopes do not grant GitHub App account permissions. Do not make the owner’s email public or synthesize an email to work around this.

The GitHub App config is read from the `system` CredentialDO with getGithubAppConfig() and cached in isolate memory for 5 minutes.

## Observability and logs

Every log line is structured JSON, and every workspace has a Diagnostics view that shows its own history.

- Turn on Workers Logs (`observability.enabled: true`) and redact URL queries (`observability.redact_query_string: true`) so setup-token URLs are not captured in invocation logs.
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
| Egress | The newest 500 `egress_log` rows that match the host and status filters. The WorkspaceDO applies the filters to all stored rows. |
| Sessions | Each session's agent, ACP session id, capabilities and live or not |

## Upgrades and versioning

A deploy MUST NOT break running containers. Old `tempod` binaries keep running until their container is destroyed.

- **Protocol changes are additive only** within protocol version 1: new ops, new events and new optional fields. The explicit native repository extension in 08 also permits nullable GitHub identities on Project and requires Mac client 0.2.0. The DO logs and ignores unknown event kinds. `tempod` answers unknown ops with `{ok: false, error: {code: "UNKNOWN_OP"}}`.
- The DO reads `tempod`'s version from `/v1/health` and logs a `warn` when it differs from its own build.
- **Image changes** make every snapshot unusable, so the next wake of each workspace takes the fresh path. Release notes MUST say when the image changed.
- **Migrations** are forward only. Add columns by default. The preservation-tested `projects` and DO `ops` reconstructions in 08 are the permitted exceptions to relax GitHub-only NOT NULL constraints and extend the operation-kind CHECK without dropping existing data.
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
| R2 | Bundles, backups, logs, attachments, artifacts | Retention rules (02); artifacts at most 25 MiB per version |
| Browser Run (phase 3) | Browser hours over 10 a month | Off by default |
| Models | Your Claude and ChatGPT plans; OpenRouter usage | Outside Tempo |

The UI shows the instance size in the container pill, so the owner can see what is running.


## Decision state privacy

The Clef-flash decision state is the only new data that leaves Tempo in phase 7. Every text value passes through the lifecycle redactor. It is at most 32 KiB and may contain the change's prompt or request text cut to 4 KiB, but never file contents, environment values or secrets. Changed paths and line counts, check names/conclusions, branch names and the other run's handle/status/redacted summary follow 08. Events and logs never store question text or decision state. Decisions record only the attachment/agent IDs, hook, outcome, probability and threshold. The `AI` binding is owner-approved; no API key enters a container.
