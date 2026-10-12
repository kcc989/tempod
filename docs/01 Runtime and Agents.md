# 01 Runtime and Agents

This tab defines everything inside and around one container: the image, `tempod`, the four agents, credentials, egress, scripts, previews, terminal, browser tests and durability.

## Container image

One image, named `workspace`, holds all four agents, Chromium and the dev tools. It runs as user `tempo` (uid 1000) with `tini` as PID 1 launching `tempod`. `tini` forwards signals to the daemon and reaps orphaned child processes.

**Rules**

- Pin every version. Store all versions in `container/versions.json`. CI MUST fail if the Dockerfile and `versions.json` disagree.
- Pin the base image by digest at build time.
- MUST NOT install npm packages with `--omit=optional`. The native `claude` binary comes from an optional platform package of the Claude Agent SDK.
- MUST NOT put any secret in the image.
- Target platform: `linux/amd64`.

**Pinned versions (as of 2026-10-10)**

| Component | Version | Source |
| --- | --- | --- |
| Base image | `node:24-trixie-slim` | Docker Hub |
| Sandbox shim | `docker.io/cloudflare/sandbox:1.0.0` (copy `/usr/local/bin/sandbox-shim` only) | Cloudflare |
| `@agentclientprotocol/claude-agent-acp` | 0.89.1 | npm |
| `@agentclientprotocol/codex-acp` | 2.2.2 | npm |
| `opencode-ai` | 1.18.35 | npm |
| `@earendil-works/pi-coding-agent` | 1.1.0 | npm |
| `pi-acp` | 0.0.34 | npm |
| `playwright` (browsers) | 1.61.1 | npm |
| `@playwright/mcp` | Pin in `versions.json` at build | npm |
| `gh`, `bun` | Pin in `versions.json` at build | GitHub releases |

**Dockerfile** (`container/Dockerfile`)

```dockerfile
FROM node:24-trixie-slim@sha256:<pinned>

ARG TINI_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates git ripgrep fd-find tmux inotify-tools curl jq unzip zstd \
    tini=${TINI_VERSION} procps iproute2 python3 python3-venv build-essential libnss3-tools \
 && rm -rf /var/lib/apt/lists/*

# gh and bun: versions from versions.json, passed as build args
ARG GH_VERSION
ARG BUN_VERSION
RUN curl -fsSL https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz \
    | tar -xz -C /tmp && mv /tmp/gh_${GH_VERSION}_linux_amd64/bin/gh /usr/local/bin/gh
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v${BUN_VERSION}"
RUN corepack enable

ARG PLAYWRIGHT_MCP_VERSION
RUN npm install -g \
    @agentclientprotocol/claude-agent-acp@0.89.1 \
    @agentclientprotocol/codex-acp@2.2.2 \
    opencode-ai@1.18.35 \
    @earendil-works/pi-coding-agent@1.1.0 \
    pi-acp@0.0.34 \
    playwright@1.61.1 \
    @playwright/mcp@${PLAYWRIGHT_MCP_VERSION}

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN playwright install --with-deps chromium && chmod -R a+rwX /opt/ms-playwright

COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
COPY dist/tempod /usr/local/bin/tempod
COPY container/home/ /home/tempo/

RUN groupmod -n tempo node \
 && usermod -l tempo -d /home/tempo -s /bin/bash node \
 && mkdir -p /workspace /home/tempo/.claude /home/tempo/.codex /home/tempo/.pi/agent \
             /home/tempo/.local/share/opencode /home/tempo/.tempod /home/tempo/attachments \
 && chown -R tempo:tempo /workspace /home/tempo

ENV HOME=/home/tempo \
    LANG=C.UTF-8 \
    TERM=xterm-256color \
    GIT_TERMINAL_PROMPT=0 \
    CLAUDE_CONFIG_DIR=/home/tempo/.claude \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_AUTOUPDATER=1 \
    IS_SANDBOX=1 \
    CODEX_HOME=/home/tempo/.codex \
    NO_BROWSER=1 \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
    OPENCODE_DISABLE_SHARE=1 \
    PI_SKIP_VERSION_CHECK=1 \
    PI_TELEMETRY=0

USER tempo
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/tempod"]
```

**Files baked into `/home/tempo`** (from `container/home/`)

| Path | Content |
| --- | --- |
| `.codex/config.toml` | `approval_policy = "never"`, `sandbox_mode = "danger-full-access"`, `check_for_update_on_startup = false`, `cli_auth_credentials_store = "file"`, `[analytics] enabled = false`, `[feedback] enabled = false` |
| `.claude/settings.json` | `{"cleanupPeriodDays": 365}` so session files outlive the 30-day default |
| `.gitconfig` | `init.defaultBranch = main`, `pull.rebase = false`, `safe.directory = /workspace` |

`IS_SANDBOX=1` is set even though agents run as uid 1000. Claude Code hides `bypassPermissions` for root unless `IS_SANDBOX` is `1`. The flag is undocumented, so spike S3 MUST confirm the mode list.

`TINI_VERSION` is pinned in `container/versions.json` to Debian trixie’s [amd64 package version](https://packages.debian.org/trixie/tini), currently `0.19.0-3+b8`.

The Node base image already has user and group `node` at uid/gid 1000. Rename them to `tempo`; creating a second user at uid 1000 fails. `bun run test:tempod:container` builds `container/Dockerfile.test` from the workspace image and runs the daemon tests as `tempo`.

For builds behind a TLS proxy, supply a combined public CA bundle as BuildKit secret `proxy_ca` (`TEMPO_BUILD_CA=<path> bun run test:tempod:container`). Networked steps mount it temporarily and keep TLS verification enabled; the CA is not copied into image layers. Set `TEMPO_TEST_MOUNT_SOURCE=1` on Linux to mount the source and already installed frozen-lockfile dependencies read-only into the complete workspace image instead of building a second test image. Both modes run as uid 1000 with tini as PID 1.

**Size budget.** The image MUST stay under 6 GB so it fits the 16 GB disk of `standard-3` with room for repos and dependencies.

## Container config and start

The WorkspaceDO class owns the container through `this.ctx.container`, under the `durable_object` scheduling policy. There is no `Sandbox` class and no `getSandbox()`; those were removed in SDK 1.0.

**Worker config** (Alchemy v2 MUST produce the same result; if it cannot, use this wrangler file)

```jsonc
{
  "name": "tempo",
  "main": "apps/tempo/src/worker.ts",
  "compatibility_date": "2026-10-10",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "vars": { "APP_HOST": "<APP_HOST>", "PREVIEW_DOMAIN": "<PREVIEW_DOMAIN>", "TEMPO_OWNER_GITHUB_ID": "<id>" },
  "containers": [{
    "class_name": "WorkspaceDO",
    "scheduling_policy": "durable_object",
    "images": { "workspace": { "dockerfile": "./container/Dockerfile" } }
  }],
  "durable_objects": { "bindings": [
    { "name": "WORKSPACE",   "class_name": "WorkspaceDO" },
    { "name": "USER_HUB",    "class_name": "UserHubDO" },
    { "name": "CREDENTIALS", "class_name": "CredentialDO" }
  ]},
  "exports": {
    "WorkspaceDO":  { "type": "durable-object", "storage": "sqlite" },
    "UserHubDO":    { "type": "durable-object", "storage": "sqlite" },
    "CredentialDO": { "type": "durable-object", "storage": "sqlite" }
  },
  "d1_databases": [{ "binding": "DB", "database_name": "tempo", "database_id": "<id>" }],
  "r2_buckets":   [{ "binding": "DATA", "bucket_name": "tempo-data" }],
  "routes": [
    { "pattern": "<APP_HOST>", "custom_domain": true },
    { "pattern": "*.<PREVIEW_DOMAIN>/*", "zone_name": "<PREVIEW_DOMAIN>" }
  ]
}
```

- MUST NOT add a `migrations` array. It conflicts with `exports`.
- `instance_type` and `max_instances` do not apply under this policy. Pass `instance` to `start()`.

**Main module exports** (`apps/tempo/src/worker.ts`)

```ts
export { WorkspaceDO } from "./do/workspace";
export { UserHubDO } from "./do/user-hub";
export { CredentialDO } from "./do/credential";
export { TempoOutbound } from "./egress/outbound";
export { DirectoryBackupGateway } from "@cloudflare/sandbox";
export default { fetch: handleRequest };
```

**Instance sizes**

| Name | vCPU | Memory | Disk | Use |
| --- | --- | --- | --- | --- |
| `standard-2` | 1 | 6 GiB | 12 GB | Small repos, no browser tests |
| `standard-3` | 2 | 8 GiB | 16 GB | **Default** |
| `standard-4` | 4 | 12 GiB | 20 GB | Large repos, heavy builds |

A project MAY set a custom size `{vcpu, memoryMib, diskMb}`: 1 to 4 vCPU, at most 12 GiB and 20 GB, at least 3 GiB per vCPU. Claude Code needs 4 GiB or more, so smaller sizes are not allowed.

**Start procedure** (step `container.start` in 03)

```ts
const token = randomToken(32); // new for every start; stored in workspace.tempod_token so a DO restart can reconnect
const props = { workspaceId: this.workspaceId, userId: this.userId };
this.ctx.container.start({
  ...(snapshot ? { containerSnapshot: snapshot.id } : { image: "workspace" }),
  instance: settings.environment.instance,
  enableInternet: false,
  env: {
    TEMPOD_TOKEN: token,
    TEMPOD_PORT: "7070",
    TEMPO_WORKSPACE_ID: this.workspaceId,
  },
  labels: { workspace: this.workspaceId },
});
await this.ctx.container.interceptAllOutboundHttp(this.ctx.exports.TempoOutbound({ props }));
await this.ctx.container.interceptOutboundHttps("*", this.ctx.exports.TempoOutbound({ props }));
await this.ctx.container.setInactivityTimeout(sleepAfterMs + 15 * 60_000); // safety net, max 21_600_000
```

- `start()` returns before the container is ready. Readiness = `GET /v1/health` on port 7070 returns 200. Poll every 250 ms for at most 60 s.
- Intercepts MUST be registered after every `start()`. They cannot be removed while the container runs.
- `tempod` MUST NOT make any outbound request before it receives `hello`. The DO sends `hello` only after the intercepts are in place.
- `start()` env MUST NOT hold credentials. Every process in the container can read it. Credentials travel over the `tempod` WebSocket.
- The inactivity timeout is a safety net only. Tempo stops containers itself with `ctx.container.destroy()`. While the DO holds an accepted WebSocket to `tempod`, the container stays up.
- Record `ctx.container.images.workspace` (the digest-pinned image reference) with every start and every snapshot.

`settings` is the effective settings in `workspace.settings_json`. Before the first `settings.read`, use the project's UI override for `environment.instance`, else `standard-3`.

## tempod

`tempod` is the only long-running process the container starts. It supervises everything else and talks only to its WorkspaceDO.

**Build.** TypeScript in `packages/tempod`, compiled with `bun build --compile --target=bun-linux-x64 --outfile dist/tempod packages/tempod/src/main.ts`. It MUST NOT need any file outside its binary at runtime.

**Startup sequence**

1. Read `TEMPOD_TOKEN` and `TEMPOD_PORT` (default `7070`). If `TEMPOD_TOKEN` is missing, exit with code 2.
2. Wait up to 10 s for `/etc/cloudflare/certs/cloudflare-containers-ca.crt`. Set these vars for every child process to that path: `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `GIT_SSL_CAINFO`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`.
3. Add the same certificate to Chromium's store: `certutil -d sql:/home/tempo/.pki/nssdb -N --empty-password` (only if the db does not exist), then `certutil -d sql:/home/tempo/.pki/nssdb -A -t "C,," -n cloudflare-containers -i <cert>`.
4. Open SQLite at `/home/tempo/.tempod/tempod.db` (`bun:sqlite`). Create tables `outbox`, `processes` and `meta` if missing. Generate `incarnation` (ULID) once per database and store it in `meta`.
5. Listen on `0.0.0.0:<TEMPOD_PORT>`.
6. Wait for `hello`. Do nothing else before it.

**HTTP endpoints** (all require `Authorization: Bearer <TEMPOD_TOKEN>`; else 401)

| Method and path | Purpose |
| --- | --- |
| `GET /v1/health` | `200 {"ok":true,"version":"<tempod version>","incarnation":"<ulid>"}` |
| `GET /v1/connect` | WebSocket upgrade for the tempod protocol (02). One connection at a time; a new one closes the old with code 4001 `replaced`. |
| `ANY /v1/proxy/<port>/<path>` | Reverse proxy to `127.0.0.1:<port>`, HTTP and WebSocket. Port 7070 and ports below 1024 return 403. |

**What tempod supervises**

| Child | How it runs | Limits |
| --- | --- | --- |
| Agent adapters | One process per live session, stdio pipes, cwd `/workspace` | At most 3 live. The least recently used idle one is closed first. |
| Scripts | `bash -lc '<command>'` in a new process group (`setsid`), cwd `/workspace` | Stop = SIGTERM to the group, SIGKILL after 5 s |
| File watcher | \`inotifywait -m -r -e create,modify,delete,move --format '%e %w%f' --exclude '(^ | /)(.git |
| Port scanner | In-process: read `/proc/net/tcp` and `/proc/net/tcp6` every 2 s | Report LISTEN sockets on ports 1024 to 65535, except 7070 |

**Outbox**

- Every event `tempod` sends gets `seq`, a counter that never decreases within one `incarnation`.
- Events stay in `outbox` until the DO sends `ack {upTo}`.
- On `hello {incarnation, lastAckedSeq}`: if the incarnation matches, resend every event with `seq > lastAckedSeq`. If it does not match, send `incarnation.changed` and start from seq 1.
- Cap: 50,000 events or 200 MB. Over the cap, drop the oldest events and send one `outbox.overflow {dropped}`.

**Coalescing.** `agent_message_chunk` and `agent_thought_chunk` updates for the same item are merged into one `item.delta` event per 100 ms or 8 KB, whichever comes first. Every other update is sent at once.

**SIGTERM.** Refuse new prompts. Send `session/cancel` to running turns and end each with `turn.ended {interrupted: true}`. Send the event `tempod.stopping {reason: "sigterm"}`. Keep answering requests: the DO checkpoints and backs up (03, Failure handling), then sends `shutdown`. In this mode only, `tempod` exits 0 after it answers `shutdown`, or 120 s after SIGTERM, whichever comes first.

**Logs.** JSON lines on stderr. Events of level `warn` or higher also go to the DO as `log` events.

## Agents

Each agent is an ACP v1 adapter process that `tempod` starts and drives over stdio. Agent ids in code are exactly `claude`, `codex`, `opencode` and `pi`.

| Field | `claude` | `codex` | `opencode` | `pi` |
| --- | --- | --- | --- | --- |
| Package | `@agentclientprotocol/claude-agent-acp` 0.89.1 | `@agentclientprotocol/codex-acp` 2.2.2 | `opencode-ai` 1.18.35 | `pi-acp` 0.0.34 plus `@earendil-works/pi-coding-agent` 1.1.0 |
| Built on | Claude Agent SDK; runs the native `claude` binary | Codex app server (bundles `@openai/codex`) | OpenCode | `pi --mode rpc` |
| Command | `claude-agent-acp` | `codex-acp` | `opencode acp --cwd /workspace` | `pi-acp` |
| Login (default) | `CLAUDE_CODE_OAUTH_TOKEN` in the adapter env | `$CODEX_HOME/auth.json`, written by `tempod` | `OPENROUTER_API_KEY=tempo-placeholder` | `OPENROUTER_API_KEY=tempo-placeholder` |
| Login (API key) | `ANTHROPIC_API_KEY=tempo-placeholder` | `OPENAI_API_KEY=tempo-placeholder` | Same as default | Same as default |
| Extra env | `CLAUDE_CONFIG_DIR=/home/tempo/.claude` | `CODEX_HOME=/home/tempo/.codex`, `INITIAL_AGENT_MODE=agent-full-access` | — | `PI_CODING_AGENT_SESSION_DIR=/home/tempo/.pi/agent/sessions` |
| Session files | `~/.claude/projects/-workspace/<sessionId>.jsonl` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `~/.local/share/opencode/project/<slug>/storage/` | `~/.pi/agent/sessions/`, `~/.pi/pi-acp/session-map.json` |
| Default mode | `bypassPermissions` | `agent-full-access` | Agent default (`build`) | Agent default |
| Plan mode | `plan` | `read-only` | `plan` | None |
| Model choice | ACP config option, category `model` | Same | Same; required in project settings | Same; required in project settings |
| `session/load` | Yes | Yes | Verify in S9 | Yes, through `session-map.json` |

**Rules for every agent**

- Mode ids, model ids and config options come from the agent's own `session/new` result. The UI MUST show what the agent reports. MUST NOT hardcode model lists.
- With the OAuth token, MUST NOT set `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`. In `claude -p` mode an API key always wins over the token.
- The placeholder string is exactly `tempo-placeholder`. `TempoOutbound` swaps it for the real key (see below).
- `tempod` sends `initialize` with `protocolVersion: 1` and these client capabilities: `fs.readTextFile: true`, `fs.writeTextFile: true`, `terminal: false`, and session.notices: true. Agents run commands with their own shell tools.
- `tempod` serves `fs/read_text_file` and `fs/write_text_file` only for absolute paths under `/workspace` or `/home/tempo/attachments`. Any other path returns a JSON-RPC error.
- Every `session/new` and `session/load` passes one MCP server, Playwright:

```json
{
  "name": "playwright",
  "command": "mcp-server-playwright",
  "args": ["--headless", "--isolated", "--browser", "chromium"],
  "env": [{ "name": "PLAYWRIGHT_BROWSERS_PATH", "value": "/opt/ms-playwright" }]
}
```

Spike S7 MUST confirm the bin name `mcp-server-playwright` and these flags for the pinned `@playwright/mcp` version.

**User MCP servers.** The owner adds MCP servers in Settings → MCP servers (02, `mcp_servers`). Each `session/new` and `session/load` passes Playwright first, then every enabled user server. The WorkspaceDO reads the user's enabled servers from D1 at session start and sends them in `session.start` as `mcpServers: McpServerSpec[]`:

- `{name, transport: "stdio", command, args, env: [{name, value}]}`
- `{name, transport: "http" | "sse", url, headers: [{name, value}]}`

A secret header (02, `saveMcpServer`) has the value `tempo-placeholder:mcp:<serverId>:<header name in lowercase>`. The real value never enters the container; `TempoOutbound` rule 11 swaps it. A stdio server runs inside the container; its `env` values are not secret and are stored in D1. A key that a stdio server needs belongs in an `http` or `sse` server or a project secret, not in `env`.

`tempod` maps each spec to the agent's `initialize` result, `agentCapabilities.mcpCapabilities`:

| Spec | Agent supports the transport | Agent does not |
| --- | --- | --- |
| `stdio` | ACP stdio server | (all agents support stdio) |
| `http` | ACP `{type: "http", name, url, headers}` | The bridge, as an ACP stdio server |
| `sse` | ACP `{type: "sse", name, url, headers}` | The bridge, as an ACP stdio server |

The bridge is `tempod` itself: `command` is `/usr/local/bin/tempod`, `args` are `["mcp-bridge", "--transport", "http" | "sse", "--url", <url>]` plus `["--header", "<name>: <value>"]` per header, and `env` is the CA env from startup step 2. It reads newline-delimited JSON-RPC on stdin and writes it on stdout. For `http` it uses the MCP streamable HTTP transport: it POSTs each message with `Accept: application/json, text/event-stream`, keeps the `Mcp-Session-Id` header, and writes each JSON body or SSE `message` event. For `sse` it uses the MCP SSE transport: it opens the `GET` event stream, POSTs to the URL of the `endpoint` event, and writes each `message` event. It exits when stdin closes. All its requests go through `TempoOutbound`.

**Pi.** `pi-acp` accepts `mcpServers` but does not pass them to pi. Pi has its own MCP client, which reads `~/.pi/agent/mcp.json` (stdio and streamable HTTP; no SSE). Before it starts `pi-acp`, `tempod` writes that file, mode 0600, as `{"mcpServers": {<name>: entry}}` with Playwright and every user server: stdio as `{command, args, env}`, `http` as `{url, headers}`, and `sse` as the bridge stdio entry. It replaces the whole file on each Pi session start.

**ACP version.** Use ACP v1 (stable) through `@agentclientprotocol/sdk` 1.8.0. MUST NOT use v2; it is still a draft. ACP v1 mode config options (category `mode`, type `select`) define the available modes and current selection when advertised. Flatten grouped choices into Tempo’s `modes` and copy `currentValue` into `modeId`; refresh both on config updates. Use `session/set_config_option` to change that mode. Agents exposing the ACP session modes interface use `session/set_mode`. ACP v1 has no `session/set_model`. Set the model with `session/set_config_option` on the option whose category is `model`.

## Credentials and egress

Every request out of a container goes through `TempoOutbound`. It adds GitHub and API-key credentials, logs the host, and enforces the project's egress policy.

**Where each credential lives**

| Credential | Stored in | Reaches the container? | How it is used |
| --- | --- | --- | --- |
| GitHub installation token | Minted on demand; cached in WorkspaceDO memory until 5 min before expiry | No | `TempoOutbound` adds it |
| OpenRouter key | CredentialDO | No | `TempoOutbound` swaps the placeholder |
| Anthropic or OpenAI API key (API-key mode) | CredentialDO | No | `TempoOutbound` swaps the placeholder |
| Claude OAuth token | CredentialDO | Yes, as env of the adapter process only | The `claude` binary sends it |
| Codex `auth.json` | CredentialDO | Yes, as a 0600 file | Codex reads and refreshes it |

**`TempoOutbound`**

```ts
export class TempoOutbound extends WorkerEntrypoint<Env, { workspaceId: string; userId: string }> {
  async fetch(request: Request): Promise<Response> { /* rules below */ }
}
```

Rules, checked in this order. The first match wins.

Before rule 0, `TempoOutbound` calls the WorkspaceDO's `getEgressConfig()` for `{owner, repo, policy, allowlist, mcp}` and caches it for 60 s. `mcp` lists the owner's enabled `http` and `sse` servers as `{serverId, host, secretHeaders}`; `secretHeaders` are the lowercase names of their secret headers. Rules 2 and 3 get the token from `getGithubToken()` on the same DO. Rules 4 to 6 and 11 get keys from the user's CredentialDO with `getSecret`.

**Rule 0** runs before all of these: a request whose host is `APP_HOST` returns 403 (05, Egress control).

| # | Match | Action |
| --- | --- | --- |
| 1 | Scheme `http:` | Skip rules 2 to 7 and apply rules 8 to 10. MUST NOT add credentials. |
| 2 | Host `github.com` or `codeload.github.com`, path starts with `/<owner>/<repo>` of this project (case-insensitive, optional `.git`) | Set `Authorization: Basic base64("x-access-token:" + token)` |
| 3 | Host `api.github.com` or `uploads.github.com` | Set `Authorization: Bearer <token>` |
| 4 | Host `openrouter.ai`, header `Authorization: Bearer tempo-placeholder` | Replace with the real OpenRouter key |
| 5 | Host `api.anthropic.com`, header `x-api-key: tempo-placeholder` | Replace with the real Anthropic key |
| 6 | Host `api.openai.com`, header `Authorization: Bearer tempo-placeholder` | Replace with the real OpenAI key |
| 11 | Checked after rule 6. Host equals the `host` of a server in `mcp`, and a header named in that server's `secretHeaders` has exactly the value `tempo-placeholder:mcp:<serverId>:<name>` | Replace each such header with the value of `mcp.<serverId>.header.<name>`. If one is not set, return 403, body `tempo: credential not set`. |
| 7 | Any request that still carries `tempo-placeholder` | Return 403. MUST NOT forward the placeholder. |
| 8 | Egress policy `open` | Pass through unchanged |
| 9 | Egress policy `allowlist`, host matches a project pattern, the built-in agent list, or the `host` of a server in `mcp` | Pass through unchanged |
| 10 | Anything else | Return 403, body `tempo: egress blocked for <host>` |

- Return the upstream `Response` as is. MUST NOT buffer bodies; model responses stream.
- After each request, log `{ts, method, host, path, status, ms, rule}` to the WorkspaceDO `egress_log` with `ctx.waitUntil`. Path without the query string. MUST NOT log headers or bodies.
- The token is minted with `repository_ids: [<repo id>]` and permissions `contents: write`, `pull_requests: write`, `metadata: read`, `checks: read`, `actions: read`, `issues: read`. A token for one repo cannot touch another.
- Built-in agent hosts for `allowlist`: `api.anthropic.com`, `claude.ai`, `console.anthropic.com`, `chatgpt.com`, `auth.openai.com`, `api.openai.com`, `openrouter.ai`, `registry.npmjs.org`, `github.com`, `api.github.com`, `codeload.github.com`, `objects.githubusercontent.com`, `cdn.playwright.dev`, `storage.googleapis.com`. Spike S3 and S4 MUST confirm the full list each agent needs.
- The default policy is `open`.

**Codex device-code login**

Settings uses device-code login by default, without a workspace or container. CredentialDO follows Codex's device-code exchange at `https://auth.openai.com`: request `/api/accounts/deviceauth/usercode` with the Codex public client ID, show `/codex/device` and the user code, poll `/api/accounts/deviceauth/token`, then exchange the authorization code and PKCE verifier at `/oauth/token` with redirect URI `/deviceauth/callback`. Pending poll responses are 403 or 404. Honor the returned interval (minimum one second), expire after 15 minutes, and bound each request to 15 seconds. Never return or log upstream bodies, device auth IDs, authorization codes, verifiers or tokens. This follows the open-source CLI implementation; upstream changes may require updates.

CredentialDO holds one login attempt in memory per owner; a repeated start returns the active attempt. Eviction expires the attempt and the owner reconnects. Serialize start/poll calls; cancellation, removal or a manual upload invalidates the attempt, including an in-flight exchange. Successful login saves Codex-compatible `auth.json` (including ID/access/refresh tokens, account ID and `last_refresh`) encrypted under `codex.auth_json` and pushes it to existing lease holders. No credentials enter browser storage. Upload remains a fallback.

**Codex `auth.json` sync**

Codex rewrites `auth.json` when its token is about 8 days old or a request returns 401. Parallel containers each hold a copy, so Tempo keeps one newest version and pushes it everywhere.

1. Before a `codex` session starts, the WorkspaceDO calls `CredentialDO.getCodexAuth()` and sends `credential.put {provider: "codex", content, version}` to `tempod`.
2. `tempod` writes `$CODEX_HOME/auth.json` atomically (temp file, then rename), mode 0600, and remembers its SHA-256.
3. `tempod` watches `$CODEX_HOME`. When `auth.json` changes and the hash is new, it sends `credential.changed {provider: "codex", content, lastRefresh}`. `lastRefresh` is the file's `last_refresh` field as epoch milliseconds (`Date.parse`).
4. The WorkspaceDO calls `CredentialDO.offerCodexAuth(content, lastRefresh, workspaceId)`. CredentialDO stores it only if `lastRefresh` is newer, then increments `version`.
5. CredentialDO calls `pushCodexAuth` on every WorkspaceDO that holds a lease, except the sender. Each sends `credential.put` to its `tempod`.
6. A WorkspaceDO takes a lease when a `codex` session starts and drops it when its container stops.
7. If a `codex` turn fails with an error that contains `401` or `refresh_token`, `tempod` sends `credential.invalid {provider: "codex"}`. The UI shows a banner asking the owner to reconnect in Settings.

**Claude token.** The WorkspaceDO reads it from CredentialDO and sends it in `session.start` as part of the adapter env. `tempod` MUST NOT write it to disk or log it.

## Sessions

A session is one ACP session in one adapter process. The adapter process may die and come back; the session id in Tempo stays the same.

**Start a session**

1. The WorkspaceDO inserts the session row with status `starting`.
2. It makes sure the container is `ready` (03), then sends `session.start {sessionId, agent, env, modeId, model, acpSessionId: null}`.
3. `tempod` spawns the adapter as user `tempo` with cwd `/workspace` and the given env.
4. `tempod` sends `initialize`. It checks `agentCapabilities` and stores them. It also reads top-level `_meta.steering.supported`, normalizes it to the boolean `capabilities.steering`, and exposes that flag as `Session.steering`. Missing support means false. Steering uses the ACP v1 `_session/steering` extension, not a concurrent `session/prompt`.
5. `tempod` sends `session/new {cwd: "/workspace", mcpServers: [playwright]}` and stores the returned ACP session id, modes and config options.
6. If the requested mode differs from the current one, `tempod` sets the advertised `mode` config option with `session/set_config_option`, or uses `session/set_mode` for agents exposing session modes. If a model is set, it sends `session/set_config_option` for the `model` option.
7. `tempod` returns the `session.start` result: `{acpSessionId, modes, configOptions, availableCommands, capabilities, reloaded: false, handoff: false}`.

**Send a prompt**

- The WorkspaceDO sends `session.prompt {sessionId, turnId, content}`. `content` is a list of ACP content blocks built in this order:
  1. On the first prompt of a session only: a text block with the turn-summary rule (below), then a text block with the project's `prompts.general`, if it is set.
  2. On the first prompt after a handoff only: the handoff text block (below); then clear `handoff_pending`. On any prompt: `sessions.pending_note`, if set (for example, the revert note in 03); then clear it.
  3. One text block per review comment group: `Review comments:` followed by one line per comment, `<path>:<line>: <text>`.
  4. The user's text.
  5. One `resource_link` per @-mentioned file: `uri` = `file:///workspace/<path>`, `name` = the file name.
  6. Images: an `image` block if `promptCapabilities.image` is true; else a `resource_link` to the file saved at `/home/tempo/attachments/<turnId>/<name>`.
- The turn-summary rule is this fixed text. The web and Mac clients show the last agent message of a turn as its answer (04, Work row), so it must stand alone:

  ```text
  Tempo shows your last message in each turn as the summary of that turn. End every turn with a short final message that says what you changed, which checks you ran and their results, and what is left to do. Name the command for each check. Link each file you name as file:///workspace/<path>.
  ```

- `tempod` calls `session/prompt` and turns every `session/update` into items (02). When `session/prompt` returns, it sends `turn.ended {turnId, stopReason}`.
- Only one turn runs per workspace at a time, across all its sessions. Other prompts wait in the queue.

**Cancel.** `tempod` sends the ACP `session/cancel` notification. If `session/prompt` has not returned 10 s later, `tempod` kills the adapter (SIGTERM, SIGKILL after 5 s), ends the turn as `cancelled`, and marks the process dead. The next prompt reloads the session.

**Permission requests.** When an agent calls `session/request_permission`, `tempod` creates a `permission` item (`item.created`), then sends `permission.requested {requestId, sessionId, turnId, itemId, title, options}` with that item's id. It waits with no time limit. The workspace shows `needs_input`. The user's choice comes back as `permission.respond {requestId, optionId}`, and `tempod` answers `{outcome: {outcome: "selected", optionId}}`. If the turn is cancelled first, it answers `{outcome: {outcome: "cancelled"}}`.

**Reload after a restart**

1. `tempod` spawns the adapter and sends `initialize`.
2. If `agentCapabilities.loadSession` is true, it sends `session/load {sessionId: <acpSessionId>, cwd: "/workspace", mcpServers: [playwright]}`.
3. While `session/load` runs, the agent replays history as `session/update` messages. `tempod` MUST drop all of them. The transcript already has them.
4. If `session/load` succeeds, return the `session.start` result with `reloaded: true`.
5. If it fails, or the agent cannot load sessions, call `session/new`, store the new ACP session id, and return the result with `handoff: true`. The WorkspaceDO sets `handoff_pending = 1`.

**Handoff text.** Exactly this first line: `This conversation continues an earlier session that was lost. Here is the transcript so far, oldest first:`. Then one line per item, `User: <text>`, `Agent: <text>` or `Tool: <title>`. Cut from the oldest end so the block is at most 24,000 characters.

**Process limits.** At most 3 adapter processes run at once. Concurrent session starts are serialized so admission and eviction cannot race. If every slot is busy, return `AGENT_START_FAILED` and preserve the running turns. To start a fourth, close the least recently used session that has no running turn: send `session/close` if the agent supports it, then SIGTERM. Its status in Tempo stays `idle`.

**Crashes.** `tempod` keeps the last 200 stderr lines of each adapter. If an adapter exits unexpectedly, it sends `agent.exited {sessionId, code, signal, stderrTail}`. A running turn ends as `failed`.

## Scripts, ports and previews

Scripts work as in Conductor: one setup script, any number of run scripts, one archive script. Every container has its own network, so every workspace uses the same port numbers.

**Script env.** `tempod` gives every script and every agent these vars, plus the project's `environment_variables` and secrets:

| Var | Value |
| --- | --- |
| `TEMPO_WORKSPACE_ID` | Workspace ULID |
| `TEMPO_WORKSPACE_NAME` | Workspace slug, for example `lisbon` |
| `TEMPO_WORKSPACE_PATH` | `/workspace` |
| `TEMPO_DEFAULT_BRANCH` | The workspace's base branch |
| `TEMPO_PORT` | `3000`. Ports 3000 to 3009 are for the project. |
| `CONDUCTOR_WORKSPACE_NAME`, `CONDUCTOR_WORKSPACE_PATH`, `CONDUCTOR_ROOT_PATH`, `CONDUCTOR_DEFAULT_BRANCH`, `CONDUCTOR_PORT` | Same values as the `TEMPO_` vars, so Conductor scripts run unchanged. `CONDUCTOR_ROOT_PATH` is `/workspace`. |

**Setup script**

- Runs after a fresh clone, and after a wake that had no usable snapshot.
- Prompts sent before setup ends wait in the queue.
- On exit code 0, the queue continues. If `auto_run_after_setup` is true, the default run script starts.
- On a non-zero exit, the workspace shows `Setup failed` with two actions: `Rerun setup` and `Continue anyway`. The queue waits for one of them.
- Timeout: 30 min.

**Run scripts**

- Started and stopped from the UI. With `run_mode = "nonconcurrent"`, starting one stops the others first.
- Stop: SIGTERM to the process group, then SIGKILL after 5 s.
- A running run script counts as activity, so the workspace does not sleep.

**Archive script.** Runs at archive time with a 120 s timeout. A failure is logged and does not block the archive.

**Output.** `tempod` sends `script.output {runId, stream, data}`, merged per 100 ms. The WorkspaceDO keeps the last 1 MiB of each run in SQLite. At exit it writes the full log, at most 50 MiB, to R2 at `logs/<workspaceId>/<runId>.log`.

**Ports.** The port scanner sends `ports.changed {ports}` when the set of listening ports changes. Each port P becomes a preview.

**Preview URL.** `https://<P>-<workspaceId lowercase>-<previewToken>.<PREVIEW_DOMAIN>`, for example `https://3000-01jaxk3v2m9q8r7t6y5w4e3d2c-k3j9x2m4q8w7e5r1.example-previews.com`. `previewToken` is 16 characters from `[a-z0-9]`, made at workspace creation. Rotating it breaks old links.

**Preview request path**

1. The Worker sees a host under `PREVIEW_DOMAIN`. It matches the first label against `^(\d{4,5})-([0-9a-hjkmnp-tv-z]{26})-([a-z0-9]{16})$`. No match returns 404.
2. It calls `WorkspaceDO.previewFetch(request, port, token)`.
3. The WorkspaceDO compares the token in constant time. A mismatch returns 404, not 403.
4. If the container is not running, the DO starts the wake flow. An HTML `GET` gets a small `Waking workspace` page that reloads every 3 s. Any other request gets 503 with `Retry-After: 5`.
5. The DO forwards to `tempod` at `/v1/proxy/<P>/<path and query>` through `getTcpPort(7070)`. It adds `Authorization: Bearer <TEMPOD_TOKEN>`, `X-Forwarded-Host` and `X-Forwarded-Proto: https`.
6. `tempod` sets `Host: localhost:<P>` and forwards to `127.0.0.1:<P>`. Dev servers that bind only to localhost work, and host checks such as Vite's pass.
7. For a WebSocket upgrade (for example, hot reload), the DO accepts both ends and copies frames both ways.

## Terminal

Terminals are tmux sessions inside the container, opened by the WorkspaceDO with a PTY `exec`. They do not go through `tempod`.

- The UI opens a WebSocket to `/api/ws/terminal/<workspaceId>/<terminalId>?cols=<n>&rows=<n>`. `terminalId` is `t1` to `t9`.
- The WorkspaceDO makes sure the container is `ready`, then runs:

```ts
const proc = await this.ctx.container.exec(
  ["tmux", "new-session", "-A", "-s", terminalId, "-c", "/workspace"],
  { pty: { cols, rows }, stdin: "pipe", user: "1000:1000", cwd: "/workspace",
    env: { TERM: "xterm-256color", HOME: "/home/tempo", ...scriptEnv } },
);
```

- Frames:
  - Client to server, binary: keystrokes, written to `proc.stdin`.
  - Client to server, text: `{"type":"resize","cols":<n>,"rows":<n>}` calls `proc.resize(cols, rows)`.
  - Server to client, binary: `proc.stdout`.
  - Server to client, text: `{"type":"ready"}` once, after the process starts.
- The DO MUST `accept()` this WebSocket. It MUST NOT use hibernation for it; hibernation drops the process handle.
- When the WebSocket closes, kill the `exec` process. The tmux session keeps running, so a reconnect gets the same shell and scrollback.
- An open terminal counts as activity, so the workspace does not sleep.
- The terminal tab list comes from `tmux list-sessions -F '#S'`, run through `tempod` (`terminal.list`).
- Client: `@xterm/xterm` 6.0.0 and `@xterm/addon-fit` 0.11.0.

## Browser testing

Agents test in headless Chromium inside their own container, through the Playwright MCP server or the project's own Playwright tests.

- Chromium comes from Playwright 1.61.1 at `/opt/ms-playwright`. The directory is world-writable, so a project that pins another Playwright version can install its own build there at runtime.
- That runtime install needs egress to `cdn.playwright.dev` and `storage.googleapis.com`.
- Every session has the Playwright MCP server (see Agents). Agents MUST open the app at `http://localhost:<port>`, not at the preview URL.
- Headless only. There is no display in the container.
- Images an agent returns in a tool result (ACP `image` content) are shown in the transcript.
- Chromium trusts the Cloudflare containers CA through the NSS database that `tempod` sets up, so HTTPS sites load during tests.
- Memory: plan on up to 1 GiB for Chromium. This is one reason `standard-3` is the default.

**Browser Run (phase 3, optional)**

- The Worker creates a Browser Run session and passes its CDP WebSocket URL to `tempod`, which starts the Playwright MCP server with `--cdp-endpoint <url>` for that session.
- The UI shows the session's Live View URL in a Browser tab. Live View currently sends `frame-ancestors *`, so an iframe works, but this is not documented.
- The Live View URL carries a JWT that lets anyone control the tab. Treat it as a secret. MUST NOT log it or store it.
- The site under test must be reachable from Browser Run, so it uses the preview URL.
- Pricing on Workers Paid: 10 browser hours a month included, then $0.09 an hour ([source](https://developers.cloudflare.com/browser-run/pricing/)).

## Durability

A container's disk is wiped when it stops. Tempo keeps work safe in four layers, each with a fallback.

| Layer | What it saves | When | Where | If missing |
| --- | --- | --- | --- | --- |
| Transcript | Every item and event | As events arrive | WorkspaceDO SQLite | Cannot be missing |
| Checkpoint | The full working tree, including untracked files that are not ignored | End of each turn, before revert, before sleep, before archive, on SIGTERM | Hidden git ref in the container, plus a bundle in R2 | Use the previous checkpoint |
| Home backup | `/home/tempo`: agent session files and settings | End of each turn, at most once per 60 s | R2, through `DirectoryBackup` | Reload fails, so use the handoff |
| Snapshot | The whole writable disk: deps, caches, `tempod.db` | Sleep and archive | Cloudflare Containers snapshot | Fresh start: clone, apply checkpoint, restore home, run setup |

**Write a checkpoint** (`tempod`, inside `/workspace`)

```bash
# Inputs: CHECKPOINT_ID (ULID), TURN_ID (may be empty), BASE_BRANCH
export GIT_INDEX_FILE=/home/tempo/.tempod/ckpt.index
git read-tree HEAD
git add -A -- . $BIG_FILE_EXCLUDES   # ":(exclude)<path>" for each untracked file over 50 MiB
TREE=$(git write-tree)
PARENT=$(git rev-parse HEAD)
# If TREE and PARENT equal the last checkpoint's (kept in tempod.db), return {unchanged: true}.
COMMIT=$(git commit-tree "$TREE" -p "$PARENT" -m "tempo checkpoint $CHECKPOINT_ID turn ${TURN_ID:-none}")
git update-ref "refs/tempo/checkpoints/$CHECKPOINT_ID" "$COMMIT"
BASE=$(git merge-base "$PARENT" "origin/$BASE_BRANCH")
git bundle create /home/tempo/.tempod/ckpt.bundle "refs/tempo/checkpoints/$CHECKPOINT_ID" "^$BASE"
```

- Repeating `git.checkpoint` with the same checkpoint id returns that ref’s original tree and regenerates its bundle. It MUST NOT overwrite an existing checkpoint ref with later edits.
- This MUST NOT change the branch, `HEAD`, or the user's index. It uses its own index file.
- `.gitignore` applies, so `node_modules` and `.env` files are not in checkpoints. Project secrets come back through env vars; dependencies come back through the setup script.
- The WorkspaceDO starts every checkpoint with the request `git.checkpoint {checkpointId, turnId, reason}` (02). `tempod` answers `{commit, tree, parent, base, bundlePath, bundleBytes}` or `{unchanged: true}`.
- The WorkspaceDO reads the bundle with `new Files(this.ctx.container).readFile(bundlePath)` and streams it to R2 at `checkpoints/<workspaceId>/<checkpointId>.bundle`. A bundle over 100 MiB is not uploaded; the checkpoint is marked `local_only`.

**Back up the home directory**

```ts
const backup = new DirectoryBackup(this.ctx.container, this.ctx.exports.DirectoryBackupGateway,
  { binding: "DATA", prefix: "homes/" + workspaceId + "/" });
const rec = await backup.backup({
  dir: "/home/tempo",
  exclude: [".cache/", ".npm/", "node_modules/", ".tempod/",
            ".codex/auth.json", ".claude/.credentials.json"],
});
```

- Credentials MUST be excluded from backups. They come back from CredentialDO. Exclude the entire `.tempod/` directory: its SQLite outbox can contain unacknowledged `credential.changed` payloads, and a home restore MUST NOT overwrite the running daemon’s database. A fresh disk starts a new incarnation; snapshots retain the daemon database.
- Keep the 3 newest backups per workspace. Delete older ones with `backup.delete(rec)`.

**Snapshot.** Call `ctx.container.snapshotContainer({ name: snapshotName })`, where `snapshotName` is `<workspaceId>-<n>`. Store `{id, size, imageRef, createdAt}`. `imageRef` is `ctx.container.images.workspace` at that time.

A snapshot is usable only if both are true:

- `imageRef` equals the current `ctx.container.images.workspace`. A snapshot works only with the image it came from.
- It was created or last restored less than 29 days ago. Cloudflare keeps snapshots for 30 days, with no list or delete API.

**Restore order on wake**

1. **Usable snapshot:** `start({ containerSnapshot: id, ... })`. Disk, deps and `tempod.db` are back. Sessions reload. Done.
2. **No usable snapshot:**
   1. `start({ image: "workspace", ... })`.
   2. `git clone --filter=blob:none https://github.com/<owner>/<repo>.git /workspace`.
   3. Copy the newest checkpoint bundle from R2 into the container with `Files.writeFile`, then `git fetch <bundle> refs/tempo/checkpoints/<checkpointId>:refs/tempo/checkpoints/<checkpointId>`.
   4. `git checkout -B <branch> <checkpoint>^1`, then `git read-tree -u --reset <checkpoint>`, then `git reset -q`. Now `HEAD` matches the branch at that time, and the working tree matches the checkpoint.
   5. If there is no checkpoint: check out `origin/<branch>` if it exists, else create the branch from `origin/<base_branch>`.
   6. Restore the newest home backup with `backup.restore(rec)`.
   7. Run the setup script.
   8. Sessions reload, or hand off if their files are gone.

## Project settings file

A repo MAY hold `.tempo/settings.toml`. Tempo also reads Conductor's files, so a repo set up for Conductor works with no changes.

```toml
[agent]
default = "claude"              # claude | codex | opencode | pi
model = ""                      # the agent's model config value; required for opencode and pi

[scripts]
setup = "bun install"
archive = ""
run_mode = "concurrent"         # concurrent | nonconcurrent
auto_run_after_setup = false

[scripts.run.dev]
command = "bun run dev"
cwd = ""                        # relative to /workspace; empty = /workspace
default = true

[environment]
instance = "standard-3"         # standard-2 | standard-3 | standard-4
sleep_after_idle_minutes = 15   # 5 to 240
egress_policy = "open"          # open | allowlist
egress_allowlist = []           # host patterns; "*.example.com" is allowed

[environment_variables]
NODE_ENV = "development"

[git]
branch_prefix = "tempo/"
delete_branch_on_archive = false
archive_on_merge = false

[prompts]
general = ""                    # added to the first prompt of every session
```

**Precedence**, highest first:

1. Project overrides set in the Tempo UI (D1 `projects.settings_json`).
2. `.tempo/settings.toml` on the workspace branch.
3. `.conductor/settings.toml`, mapped as below.
4. `conductor.json`, mapped as below.
5. Defaults (the values shown above, with all scripts empty).

**Conductor mapping**

| Conductor key | Tempo key |
| --- | --- |
| `scripts.setup`, `scripts.archive`, `scripts.run_mode`, `scripts.auto_run_after_setup` | Same names |
| `scripts.run.<id>.command` plus `args` (joined with spaces) | `scripts.run.<id>.command` |
| `scripts.run.<id>.options.cwd` | `scripts.run.<id>.cwd` |
| `scripts.run.<id>.default` | Same |
| `environment_variables.cloud`, else `environment_variables` | `environment_variables` |
| `prompts.general` | Same |
| `git.branch_prefix`, `git.delete_branch_on_archive`, `git.archive_on_merge` | Same |
| `conductor.json` `scripts.setup`, `scripts.archive` | Same |
| `conductor.json` `scripts.run` (one string) | `scripts.run.default.command`, with `default = true` |
| `conductor.json` `runScriptMode` | `scripts.run_mode` |

Other Conductor keys (for example `spotlight_testing`, `file_include_globs`, `preview_urls`) are ignored. The Setup tab shows one warning that lists them.

**Rules**

- Parse TOML with `smol-toml`. Validate with an Effect Schema.
- If a file fails to parse or validate, ignore the whole file, show the error in the Setup tab, and use the next source.
- Unknown keys are warnings, not errors.
- Secrets MUST NOT be in the repo file. Set them in the UI; they live in CredentialDO and join `environment_variables` at runtime.
- Read settings after the clone, and again when the file watcher sees a change to any of the three files. A script uses the settings in effect when it starts.

## Sources

- [Containers: Durable Object container API](https://developers.cloudflare.com/containers/api/durable-object-container/)
- [Containers: scheduling policy](https://developers.cloudflare.com/containers/configuration/scheduling-policy/) and [limits](https://developers.cloudflare.com/containers/platform/limits/)
- [Containers: outbound traffic](https://developers.cloudflare.com/containers/configuration/outbound-traffic/)
- [Sandbox: changes in 1.0](https://developers.cloudflare.com/sandbox/sdk/migrate/changes-in-1-0/) and [API map](https://developers.cloudflare.com/sandbox/sdk/migrate/api-map/)
- [Sandbox: lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/) and [security](https://developers.cloudflare.com/sandbox/concepts/security/)
- [Sandbox: files](https://developers.cloudflare.com/sandbox/reference/files/) and [directory backups](https://developers.cloudflare.com/sandbox/reference/directory-backups/)
- [Containers: snapshots](https://developers.cloudflare.com/containers/guides/snapshots/) and [image management](https://developers.cloudflare.com/containers/guides/image-management/)
- [Sandbox: previews](https://developers.cloudflare.com/sandbox/previews/) and [preview hostnames](https://developers.cloudflare.com/sandbox/previews/serve-previews-on-their-own-hostnames/)
- [Sandbox: terminal in the browser](https://developers.cloudflare.com/sandbox/commands/open-a-terminal-in-the-browser/)
- [Sandbox: build a coding agent runner](https://developers.cloudflare.com/sandbox/get-started/build-a-coding-agent-runner/)
- [ACP v1 schema](https://agentclientprotocol.com/protocol/v1/schema) and [initialization](https://agentclientprotocol.com/protocol/v1/initialization)
- [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp), [codex-acp](https://github.com/agentclientprotocol/codex-acp), [pi-acp](https://github.com/svkozak/pi-acp), [OpenCode ACP](https://opencode.ai/docs/acp)
- [Claude Code env vars](https://code.claude.com/docs/en/env-vars) and [sessions](https://code.claude.com/docs/en/sessions)
- [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference) and [auth in CI/CD](https://learn.chatgpt.com/docs/auth/ci-cd-auth)
- [Conductor settings reference](https://www.conductor.build/docs/reference/settings/reference) and [environment variables](https://www.conductor.build/docs/reference/environment-variables)
