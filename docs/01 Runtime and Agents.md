# 01 Runtime and Agents

This tab defines everything inside and around one container: the image, `tempod`, the four agents, credentials, egress, scripts, previews, terminal, browser tests, artifacts and durability.

The native Artifacts Git transport, token scope and additional daemon operations are defined in [09 Git Forge](09%20Git%20Forge.md), which extends this tab's GitHub-only repository rules.

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
| `playwright` (CLI) | 1.61.1 | npm |
| `@playwright/mcp` (and its Chromium build) | Pin in `versions.json` at build | npm |
| `gh`, `bun` | Pin in `versions.json` at build | GitHub releases |
| Oh My Zsh | Commit pinned as `OH_MY_ZSH_REF` in `versions.json` | GitHub (`ohmyzsh/ohmyzsh`) |

**Dockerfile** (`container/Dockerfile`)

```dockerfile
FROM node:24-trixie-slim@sha256:<pinned>

ARG TINI_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash zsh ca-certificates git ripgrep fd-find tmux inotify-tools curl jq unzip zstd \
    tini=${TINI_VERSION} procps iproute2 python3 python3-venv build-essential libnss3-tools \
 && rm -rf /var/lib/apt/lists/*

# gh and bun: versions from versions.json, passed as build args
ARG GH_VERSION
ARG BUN_VERSION
RUN curl -fsSL https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz \
    | tar -xz -C /tmp && mv /tmp/gh_${GH_VERSION}_linux_amd64/bin/gh /usr/local/bin/gh
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v${BUN_VERSION}"
RUN corepack enable

# Oh My Zsh, read-only for everyone; ZSH_CUSTOM lives in the home folder (Shell and dotfiles)
ARG OH_MY_ZSH_REF
RUN git clone --filter=blob:none https://github.com/ohmyzsh/ohmyzsh.git /opt/oh-my-zsh \
 && git -C /opt/oh-my-zsh checkout --detach "${OH_MY_ZSH_REF}" && rm -rf /opt/oh-my-zsh/.git

RUN npm install -g @agentclientprotocol/claude-agent-acp@0.89.1
RUN npm install -g @agentclientprotocol/codex-acp@2.2.2
RUN npm install -g opencode-ai@1.18.35 \
 && dir="$(npm root -g)/opencode-ai" \
 && for pkg in "$dir"/node_modules/opencode-linux-*; do \
      [ "$pkg/bin/opencode" -ef "$dir/bin/opencode.exe" ] || rm -rf "$pkg"; done
RUN npm install -g @earendil-works/pi-coding-agent@1.1.0 pi-acp@0.0.34

ARG PLAYWRIGHT_MCP_VERSION
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npm install -g playwright@1.61.1 @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} \
 && node "$(npm root -g)/@playwright/mcp/node_modules/playwright-core/cli.js" install --with-deps --no-shell chromium \
 && chmod -R a+rwX /opt/ms-playwright

COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
COPY dist/tempod /usr/local/bin/tempod
COPY container/home/ /home/tempo/
COPY container/home/ /etc/tempo/home-defaults/
COPY --chmod=0644 container/pi/tempo-profile.ts /opt/tempo/pi/tempo-profile.ts

RUN groupmod -n tempo node \
 && usermod -l tempo -d /home/tempo -s /bin/zsh node \
 && chmod 0755 /opt/tempo /opt/tempo/pi \
 && mkdir -p /workspace /home/tempo/.claude /home/tempo/.codex /home/tempo/.pi/agent /home/tempo/.oh-my-zsh-custom \
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

**Layer order.** Each agent and the browser install in their own layer, before any Tempo file is copied. A `tempod` change then rebuilds and uploads only the small layers at the end. A tool version change rebuilds its layer and the layers that follow it.

**Chromium.** `@playwright/mcp` bundles its own Playwright, which can expect a different Chromium build than the `playwright` package. The browser is installed with the bundled Playwright's CLI, so it is the build Playwright MCP launches. Playwright MCP starts full Chromium even with `--headless`, so the headless shell is not installed. The global `playwright` CLI stays for agents; projects bring their own Playwright and browsers. The image test starts Playwright MCP with the `session/new` arguments, loads a local HTTP fixture and checks its page title and rendered heading in the browser snapshot.

**OpenCode.** The `opencode-ai` postinstall hard-links `bin/opencode.exe` to one platform package (`opencode-linux-x64` or, on a CPU without AVX2, `opencode-linux-x64-baseline`). The other package is removed.

**Files baked into `/home/tempo`** (from `container/home/`)

| Path | Content |
| --- | --- |
| `.codex/config.toml` (Codex reads only TOML) | `approval_policy = "never"`, `sandbox_mode = "danger-full-access"`, `check_for_update_on_startup = false`, `cli_auth_credentials_store = "file"`, `[analytics] enabled = false`, `[feedback] enabled = false` |
| `.claude/settings.json` | `{"cleanupPeriodDays": 365}` so session files outlive the 30-day default |
| `.gitconfig` | `init.defaultBranch = main`, `pull.rebase = false`, `safe.directory = /workspace` |
| `.zshrc` | `DEFAULT_ZSHRC` from `packages/protocol/src/dotfiles.ts` (Shell and dotfiles) |
| `.tmux.conf` | `DEFAULT_TMUX_CONF` from the same file: zsh as the tmux shell, `tmux-256color` with true color, no status line |

`container/check-versions.ts` fails when `.zshrc` or `.tmux.conf` differ from those constants. `/etc/tempo/home-defaults/` keeps a read-only copy for `dotfiles.apply`.

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
  "worker_loaders": [{ "binding": "LOADER" }],
  "artifacts":    [{ "binding": "AGENTS", "namespace": "tempo-agents" }],
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

**Build.** TypeScript in `packages/tempod`, compiled with `bun build --compile --target=bun-linux-x64 --outfile dist/tempod packages/tempod/src/main.ts`. It MUST NOT need any file outside its binary at runtime. The same binary is the `tempo` MCP server: `tempod mcp` runs that mode (Environments).

**Startup sequence**

1. Read `TEMPOD_TOKEN` and `TEMPOD_PORT` (default `7070`). If `TEMPOD_TOKEN` is missing, exit with code 2.
2. Wait up to 10 s for `/etc/cloudflare/certs/cloudflare-containers-ca.crt`. Set these vars for every child process to that path: `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `GIT_SSL_CAINFO`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`.
3. Add the same certificate to Chromium's store: `certutil -d sql:/home/tempo/.pki/nssdb -N --empty-password` (only if the db does not exist), then `certutil -d sql:/home/tempo/.pki/nssdb -A -t "C,," -n cloudflare-containers -i <cert>`.
4. Open SQLite at `/home/tempo/.tempod/tempod.db` (`bun:sqlite`). Create tables `outbox`, `processes`, `meta` and `artifacts` (`artifact_id`, `session_id`, `path`, `last_version`; Artifacts) if missing. Generate `incarnation` (ULID) once per database and store it in `meta`.
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
| Default mode | `auto` | `agent-full-access` | Agent default (`build`) | Agent default |
| Plan mode | `plan` | `read-only` | `plan` | None |
| Model choice | ACP config option, category `model` | Same | Same; `agent.models.opencode` is required | Same; `agent.models.pi` is required |
| `session/load` | Yes | Yes | Verify in S9 | Yes, through `session-map.json` |

**Rules for every agent**

- Mode ids, model ids and config options come from the agent's own `session/new` result. The UI MUST show what the agent reports. MUST NOT hardcode model lists.
- With the OAuth token, MUST NOT set `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`. In `claude -p` mode an API key always wins over the token.
- The placeholder string is exactly `tempo-placeholder`. `TempoOutbound` swaps it for the real key (see below).
- `tempod` sends `initialize` with `protocolVersion: 1` and these client capabilities: `fs.readTextFile: true`, `fs.writeTextFile: true`, `terminal: false`, and session.notices: true. Agents run commands with their own shell tools.
- `tempod` serves `fs/read_text_file` and `fs/write_text_file` only for absolute paths under `/workspace` or `/home/tempo/attachments`. Any other path returns a JSON-RPC error.
- Every `session/new` and `session/load` passes Playwright, below, then `tempo` (Environments), then the user's servers (User MCP servers).

```json
{
  "name": "playwright",
  "command": "mcp-server-playwright",
  "args": ["--headless", "--isolated", "--browser", "chromium"],
  "env": [{ "name": "PLAYWRIGHT_BROWSERS_PATH", "value": "/opt/ms-playwright" }]
}
```

Spike S7 MUST confirm the bin name `mcp-server-playwright` and these flags for the pinned `@playwright/mcp` version.

**User MCP servers.** The owner adds MCP servers in Settings → MCP servers (02, `mcp_servers`). Each `session/new` and `session/load` passes Playwright first, then `tempo` (Environments), then every enabled user server. The names `playwright` and `tempo` are reserved. The WorkspaceDO reads the user's enabled servers from D1 at session start and sends them in `session.start` as `mcpServers: McpServerSpec[]`:

- `{name, transport: "stdio", command, args, env: [{name, value}]}`
- `{name, transport: "http" | "sse", url, headers: [{name, value}]}`

A secret header (02, `saveMcpServer`) has the value `tempo-placeholder:mcp:<serverId>:<header name in lowercase>`. The real value never enters the container; `TempoOutbound` rule 12 swaps it. A stdio server runs inside the container; its `env` values are not secret and are stored in D1. A key that a stdio server needs belongs in an `http` or `sse` server or a project secret, not in `env`.

`tempod` maps each spec to the agent's `initialize` result, `agentCapabilities.mcpCapabilities`:

| Spec | Agent supports the transport | Agent does not |
| --- | --- | --- |
| `stdio` | ACP stdio server | (all agents support stdio) |
| `http` | ACP `{type: "http", name, url, headers}` | The bridge, as an ACP stdio server |
| `sse` | ACP `{type: "sse", name, url, headers}` | The bridge, as an ACP stdio server |

The bridge is `tempod` itself: `command` is `/usr/local/bin/tempod`, `args` are `["mcp-bridge", "--transport", "http" | "sse", "--url", <url>]` plus `["--header", "<name>: <value>"]` per header, and `env` is the CA env from startup step 2. It reads newline-delimited JSON-RPC on stdin and writes it on stdout. For `http` it uses the MCP streamable HTTP transport: it POSTs each message with `Accept: application/json, text/event-stream`, keeps the `Mcp-Session-Id` header, and writes each JSON body or SSE `message` event. For `sse` it uses the MCP SSE transport: it opens the `GET` event stream, POSTs to the URL of the `endpoint` event, and writes each `message` event. It exits when stdin closes. All its requests go through `TempoOutbound`.

**Pi.** `pi-acp` accepts `mcpServers` but does not pass them to pi. Pi has its own MCP client, which reads `~/.pi/agent/mcp.json` (stdio and streamable HTTP; no SSE). Before it starts `pi-acp`, `tempod` writes that file, mode 0600, as `{"mcpServers": {<name>: entry}}` with Playwright (the same `args` as in `session/new`, so Browser Run applies), `tempo` and every user server: stdio as `{command, args, env}`, `http` as `{url, headers}`, and `sse` as the bridge stdio entry. It replaces the whole file on each Pi session start.

**Model discovery before workspace creation.** `listModels` addresses the existing WorkspaceDO class at `models:<userId>` as a private discovery instance. It has no workspace, session, turn or D1 workspace row. It starts the pinned image with only the usual tempod token, connects and sends `hello`, then starts and closes a temporary ACP session for each configured agent to read its model config option. It sends no prompts and clones no repository. Credentials use the same socket and TempoOutbound injection paths as workspace agents. Codex leases and refreshed auth are handled the same way. Closing a temporary session checks Codex auth immediately so a pending watcher refresh is delivered before the container is destroyed. Temporary events are acknowledged without storing payloads. The container is destroyed after discovery, with a ten-minute cleanup alarm and inactivity limit as a backstop. Results are stored with a key of credential metadata and image, and do not expire with time. A read returns the stored list without starting a container. When the key changed, the read still returns the stored list and one discovery run refreshes it in the background. A read waits for discovery only when an agent with a login has no stored models, for example on first use or after a new login. Concurrent reads share one discovery run.

**Model list.** Each owner keeps one ordered list of picked models (`model_lists` in 02), saved with `setModelList`. It filters only the model pickers of New workspace and New chat (04). An empty list offers every reported model. A non-empty list offers, in list order, each pick that `listModels` reports for an agent with a login. If no pick is available, the picker offers every reported model. The list never changes `agent.default`, `agent.models.<agent>`, Project Agents choices, library agents or sessions that already exist.

Discovery starts the configured agents in parallel and preserves their usual order in the result. An auth refresh accepted from the temporary Codex session updates that credential's cache signature. Adding, removing or replacing a login still invalidates the cache. Closing and reopening a creation dialog reuses its pending discovery request.

**ACP version.** Use ACP v1 (stable) through `@agentclientprotocol/sdk` 1.8.0. MUST NOT use v2; it is still a draft. ACP v1 mode config options (category `mode`, type `select`) define the available modes and current selection when advertised. Flatten grouped choices into Tempo’s `modes` and copy `currentValue` into `modeId`; refresh both on config updates. Use `session/set_config_option` to change that mode. Agents exposing the ACP session modes interface use `session/set_mode`. ACP v1 has no `session/set_model`. Set the model with `session/set_config_option` on the option whose category is `model`.

## Agent profiles

Agents are definitions in the user's D1 library, with project attachments, hooks, runs and proposals defined in [08 Events and Agents](08%20Events%20and%20Agents.md). Definitions are JSON data, not repository or Artifacts files. MCP `env` and `headers` accept only `${NAME}` references. A missing variable omits the server and reports `mcpServers`; expansion stays in memory.

When a session starts from an agent, the Worker reads its D1 definition and passes an `AgentProfile` to the WorkspaceDO. The session stores the profile at start. Edits and deletion do not change existing sessions, reloads or handoffs. Migration preserves already-stored profiles and commit SHAs. New library chats and runs freeze the library version and hash in flat Session fields. Their empty model means the adapter default where supported (OpenCode and Pi still require a selected model); an explicitly selected model, including an empty one, overrides the saved model. Existing chats retain their previous project-model fallback.

**How `tempod` applies a profile.** ACP v1 has no standard field for a system prompt or a tool list. `tempod` uses each adapter's own extension or the agent's own config. Where an agent has none, the field is reported as unsupported and the session still starts.

| Field | `claude` | `codex` | `opencode` | `pi` |
| --- | --- | --- | --- | --- |
| `systemPrompt` | `session/new` `_meta.systemPrompt = {append: <prompt>}` (keeps the `claude_code` preset) | `session/new` `_meta.jetbrains.air.customInstructions = <prompt>` (becomes Codex developer instructions) | `instructions: ["<dir>/prompt.md"]` in `OPENCODE_CONFIG_CONTENT` (appended to the system prompt) | `--append-system-prompt <dir>/prompt.md` |
| `tools.allow` | `_meta.claudeCode.options.tools = [...]`. MUST NOT use `allowedTools`; it only skips permission prompts. | Unsupported | `permission: {"*": "deny", <name>: "allow", ...}` in `OPENCODE_CONFIG_CONTENT` | `--tools <a>,<b>` (plain names; MCP tools stay unless a name starts with `mcp__`), plus the Tempo pi extension's guard (below) |
| `tools.deny` | `_meta.claudeCode.options.disallowedTools = [...]` | Unsupported | `permission: {<name>: "deny", ...}`; deny entries are written after allow entries | `--exclude-tools <a>,<b>`, plus the Tempo pi extension's guard (below) |
| `mcpServers` | Added to the user's servers (User MCP servers) | Same | Same | The Tempo pi extension (below). `sse` is not supported by pi. |
| `thoughtLevel` | Config option with category `thought_level` (id `effort` in 0.89.1) | Config option with category `thought_level` (id `reasoning_effort` in 2.2.2) | Config option with category `thought_level` (id `effort` in 1.18.35; offered only when the model has variants) | Config option with category `thought_level` (id `thought_level` in `pi-acp` 0.0.34) |

- An empty `tools.allow` means every built-in tool: leave out `tools` for `claude`, the `"*"` rule for `opencode` and `--tools` for `pi`. For `claude`, `tools: []` would turn every built-in tool off.
- Tool names are the base agent's own names, for example `Edit` for `claude`, `edit` for `opencode` and `pi`. Patterns with `*` work where the agent supports them (`opencode`, `pi`). Tempo does not translate names between agents.
- An agent's MCP servers become `McpServerSpec` entries, with `${NAME}` expanded, and join the user's servers after Playwright and `tempo`; a custom server replaces a user server of the same name. They use the same transport rules and bridge as user servers (User MCP servers).
- `playwright = false` leaves Playwright out of the ACP `mcpServers`. Pi always gets Playwright from `~/.pi/agent/mcp.json`, so for `pi` its tools (`mcp__playwright__*`) are added to the deny list instead.

**Profile files.** Before it spawns an adapter with a profile, `tempod` writes the directory `/home/tempo/.tempod/profiles/<sessionId>/` (mode 0700, owner `tempo`; `<dir>` above). It rewrites the directory on every start, so a reload uses the stored profile, and deletes it on `session.close`. The files hold no secret values: MCP `env` and `headers` keep their `${NAME}` references.

| File | When | Content |
| --- | --- | --- |
| `prompt.md` | `systemPrompt` is set and the base agent is `opencode` or `pi` | The system prompt |
| `pi` | Base agent `pi` | An executable shell script: `exec pi "$@" <flags>`, each flag value single-quoted, with the flags from the table above and `-e /opt/tempo/pi/tempo-profile.ts`. `tempod` starts `pi-acp` with `PI_ACP_PI_COMMAND=<dir>/pi` and `TEMPO_PROFILE_DIR=<dir>`. `pi-acp` passes its own arguments (`--mode rpc` and the session flags) through `"$@"`. |
| `mcp.json` | Base agent `pi` | `{"servers": [McpServerDef], "tools": {"allow": [...], "deny": [...]}}` for the Tempo pi extension |

- `OPENCODE_CONFIG_CONTENT` is set in the env of that one adapter process only. It holds `instructions` and `permission` and nothing else.
- **Tempo pi extension.** `container/pi/tempo-profile.ts`, copied to `/opt/tempo/pi/tempo-profile.ts` in the image. It is Tempo's own code, loaded by pi through `jiti`, and adds no library. On load it reads `$TEMPO_PROFILE_DIR/mcp.json`, expands each `${NAME}` from its own process env, and calls `pi.registerMcpServer` for each server. Playwright, `tempo` and the user's servers come from `~/.pi/agent/mcp.json` (User MCP servers, Pi). It also reads `tools.allow` and `tools.deny` from `mcp.json` and adds a `tool_call` handler that returns `{block: true}` for a denied name, or for a name outside a non-empty allowlist. Pi 1.x codemode scripts call MCP tools whenever they are registered, whatever the active tool set; their nested calls pass through `tool_call`, so this guard is what enforces the limits. The flags only hide tools from the model. If the allowlist is not empty and the profile has MCP servers, `tempod` adds `codemode` to `--tools`, so MCP tools stay reachable. A server with a missing name is skipped and logged to stderr as `tempo-profile: skipped <server>`. The extension keeps an agent's servers to its own session; `~/.pi/agent/mcp.json` is shared by every pi session in the container.
- Model and reasoning level come from the agent's own config options, as for every agent. MUST NOT hardcode model or level lists. Set the model first, then the reasoning level, because the levels on offer can depend on the model. If the agent does not offer the value, keep its default and report `model` or `thoughtLevel`.
- `profileIssues` is the list of fields that `tempod` could not apply: any of `systemPrompt`, `tools`, `mcpServers`, `model`, `thoughtLevel`, `access`. It is returned by `session.start` and shown in the chat (04).
- Spike S20 (06) MUST confirm every cell of this table for the pinned adapter versions. A cell it disproves becomes `Unsupported` until the spec changes.

**Run session environment.** Run sessions add `TEMPO_RUN_ID` and `TEMPO_RUN_OUTPUT_KIND` (`plan`, `review` or `note`) to their session environment. These select `report_result` on the `tempo` MCP server. Ordinary sessions list `list_agents` and `propose_agent_change`; run sessions do not.

**Read-only controls.** `session.start.access` is an optional `read-only`/`write` value, set from a run's frozen definition; ordinary chat starts keep their existing behavior. Apply an advertised read-only mode first, otherwise deny the base agent's edit tools through the profile, otherwise report `access`. The tree comparison always produces the warning specified in 08, while changes to protected login/config files fail the run. S20 must record the pinned adapters' exact mode IDs/tool names and shell behavior before claiming real-agent acceptance; these values are not yet established by a real-login spike. The implementation recognizes advertised `plan` modes for Claude/OpenCode and `read-only` for Codex, and uses Pi's profile guard to deny `write` and `edit`. Fake-adapter checks prove the mode path and the `access` issue for an unsupported mode; they do not prove shell behavior with a real login.

## Credentials and egress

Every request out of a container goes through `TempoOutbound`. It adds GitHub and API-key credentials, swaps environment secrets, runs injectors, logs the host, and enforces the egress policy of the workspace's environment (Environments, below).

**Where each credential lives**

| Credential | Stored in | Reaches the container? | How it is used |
| --- | --- | --- | --- |
| GitHub installation token | Minted on demand; cached in WorkspaceDO memory until 5 min before expiry | No | `TempoOutbound` adds it |
| OpenRouter key | CredentialDO | No | `TempoOutbound` swaps the placeholder |
| Anthropic or OpenAI API key (API-key mode) | CredentialDO | No | `TempoOutbound` swaps the placeholder |
| Environment secret with `hosts` | CredentialDO | No | `TempoOutbound` swaps `tempo-secret-<NAME>` (rule 14) or an injector uses it (rule 13) |
| Environment secret with no `hosts`, project secret | CredentialDO | Yes, as an env var | Scripts and agents read it |
| Claude OAuth token | CredentialDO | Yes, as env of the adapter process only | The `claude` binary sends it |
| Codex `auth.json` | CredentialDO | Yes, as a 0600 file | Codex reads and refreshes it |

**`TempoOutbound`**

```ts
export class TempoOutbound extends WorkerEntrypoint<Env, { workspaceId: string; userId: string }> {
  async fetch(request: Request): Promise<Response> { /* rules below */ }
}
```

Rules, checked in the order of the table. The first match wins. Rules 12, 13 and 14 come after 6 and before 7, in that order; their numbers are labels in `egress_log`, not the order.

Before rule 0, `TempoOutbound` calls the WorkspaceDO's `getEgressConfig()` for `{owner, repo, environmentId, policy, allowlist, secrets, injectors, mcp, dotfiles}` and caches it for 60 s. `mcp` lists the owner's enabled `http` and `sse` servers as `{serverId, host, secretHeaders}`; `secretHeaders` are the lowercase names of their secret headers. Rules 2 and 3 get the token from `getGithubToken()` on the same DO. Rules 4 to 6 and 12 get keys from the user's CredentialDO with `getSecret`.

**Rule 0** runs before all of these: a request whose host is `APP_HOST` returns 403 (05, Egress control).

**Rule 11** runs right after rule 0: a WebSocket upgrade to `wss://browser.tempo.internal/` goes to `WorkspaceDO.browserConnect(request)` (Browser Run). With `browser.run` off, or any other request to that host, it returns 404. MUST NOT add credentials. It is logged with `rule = 11`.

| # | Match | Action |
| --- | --- | --- |
| 1 | Scheme `http:` | Skip rules 2 to 7 and apply rules 8 to 10. MUST NOT add credentials. |
| 2 | Host `github.com` or `codeload.github.com`, path starts with `/<owner>/<repo>` of this project (case-insensitive, optional `.git`) | Set `Authorization: Basic base64("x-access-token:" + token)` |
| 3 | Host `api.github.com` or `uploads.github.com` | Set `Authorization: Bearer <token>` |
| 4 | Host `openrouter.ai`, header `Authorization: Bearer tempo-placeholder` | Replace with the real OpenRouter key |
| 5 | Host `api.anthropic.com`, header `x-api-key: tempo-placeholder` | Replace with the real Anthropic key |
| 6 | Host `api.openai.com`, header `Authorization: Bearer tempo-placeholder` | Replace with the real OpenAI key |
| 12 | Checked after rule 6. Host equals the `host` of a server in `mcp`, and a header named in that server's `secretHeaders` has exactly the value `tempo-placeholder:mcp:<serverId>:<name>` | Replace each such header with the value of `mcp.<serverId>.header.<name>`. If one is not set, return 403, body `tempo: credential not set`. |
| 13 | Host matches the `hosts` of an injector of the environment (first match in list order) | Run the injector (Environments, below) and return its response |
| 14 | The request carries `tempo-secret-<NAME>`, every such name is a secret of the environment with a stored value, and the host matches the `hosts` of each | Replace each placeholder with its value and forward |
| 15 | Checked after rule 6. Host is `api.cloudflare.com` over HTTPS, `Authorization` is exactly `Bearer tempo-placeholder`, no other placeholder, and the manifest has `cloudflare` (14) | Ask the WorkspaceDO (13, L-ADR-8). If allowed, replace `Authorization` with the workspace's minted token and forward; else return 403 with its reason. |
| 7 | Any request that still carries `tempo-placeholder` or `tempo-secret-` | Return 403. MUST NOT forward the placeholder. |
| 8 | Egress policy `open` | Pass through unchanged |
| 9 | Egress policy `allowlist`, host matches an environment pattern, the built-in agent list, or the `host` of a server in `mcp` | Pass through unchanged |
| 10 | Anything else | Return 403, body `tempo: egress blocked for <host>` |

- Return the upstream `Response` as is. MUST NOT buffer bodies; model responses stream.
- After each request, log `{ts, method, host, path, status, ms, rule}` to the WorkspaceDO `egress_log` with `ctx.waitUntil`. Path without the query string. MUST NOT log headers or bodies.
- The token is minted with `repository_ids: [<repo id>]` and permissions `contents: write`, `pull_requests: write`, `metadata: read`, `checks: read`, `actions: read`, `issues: read`. A token for one repo cannot touch another.
- Built-in agent hosts for `allowlist`: `api.anthropic.com`, `claude.ai`, `console.anthropic.com`, `chatgpt.com`, `auth.openai.com`, `api.openai.com`, `openrouter.ai`, `registry.npmjs.org`, `github.com`, `api.github.com`, `codeload.github.com`, `objects.githubusercontent.com`, `cdn.playwright.dev`, `storage.googleapis.com`. Spike S3 and S4 MUST confirm the full list each agent needs.
- The default policy is `allowlist`.

**Codex device-code login**

Settings uses device-code login by default, without a workspace or container. Web Settings runs the exchange in CredentialDO. The Mac client runs the same exchange locally and sends the completed auth.json through `setCodexAuth` (07), so OpenAI sign-in does not depend on requests from a cloud server. CredentialDO follows Codex's device-code exchange at `https://auth.openai.com`: request `/api/accounts/deviceauth/usercode` with the Codex public client ID, show `/codex/device` and the user code, poll `/api/accounts/deviceauth/token`, then exchange the authorization code and PKCE verifier at `/oauth/token` with redirect URI `/deviceauth/callback`. Pending poll responses are 403 or 404. Honor the returned interval (minimum one second), expire after 15 minutes, and bound each request to 15 seconds. Never return or log upstream bodies, device auth IDs, authorization codes, verifiers or tokens. This follows the open-source CLI implementation; upstream changes may require updates.

CredentialDO holds one login attempt in memory per owner; a repeated start returns the active attempt. Eviction expires the attempt and the owner reconnects. Serialize start/poll calls; cancellation, removal or a manual upload invalidates the attempt, including an in-flight exchange. Successful login saves Codex-compatible `auth.json` (including ID/access/refresh tokens, account ID and `last_refresh`) encrypted under `codex.auth_json` and pushes it to existing lease holders. No credentials enter browser storage. Upload remains a fallback.

**Codex `auth.json` sync**

Credential synchronization runs only while no turn is running or being checked. WorkspaceDO holds incoming offers and pushes in memory until those checks finish, then applies them before the next turn. It does not perform a remote auth refresh during a turn. Runs treat any login-file change as an access violation (08).

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
2. It makes sure the container is `ready` (03), then sends `session.start {sessionId, agent, env, modeId, model, profile, browser, acpSessionId: null}`. `profile` is the session's `AgentProfile` from a library agent, or absent (Agents). `model` is the model chosen for this session (`createSession` or the composer's model picker), else `agent.models.<agent>` from the effective settings, or absent when both are empty. For `opencode` and `pi` with no model, nothing is sent: the session stays `idle` and the turn that waited for it fails with `MODEL_REQUIRED`. `browser` is `"run"` when `browser.run` is true and the egress policy is `open` (Browser Run), else `"local"`.
3. `tempod` spawns the adapter as user `tempo` with cwd `/workspace` and the given env.
4. `tempod` sends `initialize`. It checks `agentCapabilities` and stores them. It also reads top-level `_meta.steering.supported`, normalizes it to the boolean `capabilities.steering`, and exposes that flag as `Session.steering`. Missing support means false. Steering uses the ACP v1 `_session/steering` extension, not a concurrent `session/prompt`.
5. `tempod` sends `session/new {cwd: "/workspace", mcpServers: [playwright, tempo, ...userServers]}` and stores the returned ACP session id, modes and config options. With a profile, `_meta` and extra MCP servers follow Agents.
6. If the requested mode differs from the current one, `tempod` sets the advertised `mode` config option with `session/set_config_option`, or uses `session/set_mode` for agents exposing session modes. If `model` is set, it sends `session/set_config_option` for the `model` option. If `profile.thoughtLevel` is set, it then sends `session/set_config_option` for the option whose category is `thought_level`.
7. `tempod` returns the `session.start` result: `{acpSessionId, modes, configOptions, availableCommands, capabilities, profileIssues, reloaded: false, handoff: false}`. `profileIssues` is `[]` without a profile.

**Send a prompt**

- The WorkspaceDO sends `session.prompt {sessionId, turnId, content}`. `content` is a list of ACP content blocks built in this order:
  1. On the first prompt of a session only: a text block with the capability summary (14, Delivery to the agent), then a text block with the turn-summary rule (below), then a text block with the project's `prompts.general`, if it is set, then the project profile block (13, L-ADR-3), if the project has a saved profile.
  2. On the first prompt after a handoff only: the handoff text block (below); then clear `handoff_pending`. On any prompt: `sessions.pending_note`, if set (for example, the revert note in 03); then clear it.
  3. One text block per review comment group: `Review comments:` followed by one line per comment, `<path>:<line>: <text>`.
  4. On the first prompt of a chat that starts the intent check (13, L-ADR-1): the intent rule text block. When the chat's Intent check control is off, there is no rule.
     While design checklist items are open (13, L-ADR-2): the open checklist text block.
  5. The user's text.
  6. One `resource_link` per @-mentioned file: `uri` = `file:///workspace/<path>`, `name` = the file name.
  7. Images: an `image` block if `promptCapabilities.image` is true; else a `resource_link` to the file saved at `/home/tempo/attachments/<turnId>/<name>`.
- The turn-summary rule is this fixed text. The web and Mac clients show the last agent message of a turn as its answer (04, Work row), so it must stand alone:

  ```text
  Tempo shows your last message in each turn as the summary of that turn. End every turn with a short final message that answers the user or says what you did. If you changed files, say what you changed and link each file you name as file:///workspace/<path>. If you ran checks, name the command for each check and give its result. If work is left, say what it is. Do not report files you did not change, checks you did not run, or that nothing is left to do.
  ```

- `tempod` calls `session/prompt` and turns every `session/update` into items (02). When `session/prompt` returns, it sends `turn.ended {turnId, stopReason}`.
- Only one turn runs per workspace at a time, across all its sessions. Other prompts wait in the queue.

**Cancel.** `tempod` sends the ACP `session/cancel` notification. If `session/prompt` has not returned 10 s later, `tempod` kills the adapter (SIGTERM, SIGKILL after 5 s), ends the turn as `cancelled`, and marks the process dead. The next prompt reloads the session.

**Permission requests.** When an agent calls `session/request_permission`, `tempod` creates a `permission` item (`item.created`), then sends `permission.requested {requestId, sessionId, turnId, itemId, title, options}` with that item's id. It waits with no time limit. The workspace shows `needs_input`. The user's choice comes back as `permission.respond {requestId, optionId}`, and `tempod` answers `{outcome: {outcome: "selected", optionId}}`. If the turn is cancelled first, it answers `{outcome: {outcome: "cancelled"}}`.

**Reload after a restart**

1. `tempod` spawns the adapter and sends `initialize`.
2. If `agentCapabilities.loadSession` is true, it sends `session/load {sessionId: <acpSessionId>, cwd: "/workspace", mcpServers: [playwright, tempo, ...userServers]}`. With a profile, `mcpServers` and `_meta` are the same as in `session/new`.
3. While `session/load` runs, the agent replays history as `session/update` messages. `tempod` MUST drop all of them. The transcript already has them.
4. If `session/load` succeeds, return the `session.start` result with `reloaded: true`.
5. If it fails, or the agent cannot load sessions, call `session/new`, store the new ACP session id, and return the result with `handoff: true`. The WorkspaceDO sets `handoff_pending = 1`.

**Handoff text.** Exactly this first line: `This conversation continues an earlier session that was lost. Here is the transcript so far, oldest first:`. Then one line per item, `User: <text>`, `Agent: <text>` or `Tool: <title>`. Cut from the oldest end so the block is at most 24,000 characters.

**Process limits.** At most 3 adapter processes run at once. Concurrent session starts are serialized so admission and eviction cannot race. If every slot is busy, return `AGENT_START_FAILED` and preserve the running turns. To start a fourth, close the least recently used session that has no running turn: send `session/close` if the agent supports it, then SIGTERM. Its status in Tempo stays `idle`.

**Crashes.** `tempod` keeps the last 200 stderr lines of each adapter. If an adapter exits unexpectedly, it sends `agent.exited {sessionId, code, signal, stderrTail}`. A running turn ends as `failed`.

## Environments

An environment is a named, reusable set of egress rules and secrets. The owner makes environments in Settings and picks one per project. A workspace can override its project's choice. The agent never sees the value of a secret that has `hosts`.

**Fields** (D1 `environments`, 02)

| Field | Meaning |
| --- | --- |
| `name` | Unique per owner. 1 to 64 characters. |
| `egressPolicy` | `open` or `allowlist`. Default `allowlist`. |
| `egressAllowlist` | Host patterns, as in 05. At most 200. |
| `secrets` | `[{name, hosts}]`. `name` matches `^[A-Z_][A-Z0-9_]*$`. `hosts` are host patterns, at most 20. At most 50 secrets. Values live in CredentialDO under `environment.<environmentId>.secret.<NAME>`. |
| `injectors` | `[{name, hosts, code, sha256}]`. `name` matches `^[a-z][a-z0-9-]{0,31}$`. `hosts` are host patterns, 1 to 20. `code` is at most 64 KiB. `sha256` is the hex SHA-256 of `code`, set by the server. At most 10 injectors. |

**Which environment applies.** The workspace's override, else the project's `environment_id`, else none. An id that no longer exists is skipped: a deleted override falls back to the project's environment. With none, the project's `environment.egress_policy` and `environment.egress_allowlist` settings apply (Tempo overrides only), with no environment secrets and no injectors.

Browser Run (below) is on only when the egress policy that applies, the environment's or else the project's, is `open`. The `browser.run` settings warning sees only the project's settings.

**Secrets in the container.** `tempod` gets every environment secret in `env` (02, tempod protocol):

- A secret with `hosts` is the string `tempo-secret-<NAME>`, for example `STRIPE_KEY=tempo-secret-STRIPE_KEY`. Its value never enters the container.
- A secret with no `hosts` is its plain value. The UI marks it "visible to the agent".
- Precedence for a name that is set twice, highest first: the `TEMPO_` vars, project secrets, environment secrets, `environment_variables`.

**Rule 14, secret swap.**

- Find every match of `tempo-secret-([A-Z_][A-Z0-9_]*)` in the URL (path and query) and in each header value. For `Authorization: Basic <b64>`, also look inside the decoded `user:password` and encode again after the swap.
- All matches MUST name a secret of the environment that has a stored value and whose `hosts` match the request host. Otherwise rule 14 does not match, and rule 7 returns 403.
- MUST NOT look in or change the body. Bodies stream.
- Rule 14 forwards without the policy check (rules 8 to 10), as rules 2 to 6 do. It sends the request with `redirect: "manual"`, so a redirect cannot carry a value to another host; the container follows the redirect with a new request.
- A secret value that is not stored makes the request fail with rule 7.

**Rule 13, injectors.** An injector is code the owner approved. It handles auth schemes that a swap cannot do, for example AWS SigV4 or HMAC request signing.

- `TempoOutbound` runs the injector as a Dynamic Worker through the Worker Loader binding `LOADER`: `env.LOADER.get("injector-<sha256>-<workspaceId>-<environmentId>-<name>", ...)`, so a cached isolate never serves another workspace or changed code, with `mainModule: "injector.js"`, `compatibilityDate: "2026-08-01"`.
- `code` is an ES module whose default export has `fetch(request, env)`. It gets the container's request unchanged and returns the response for the container.
- `env.SECRETS` is an RPC binding with one method: `hmac(name, data, {hash, prefix?})`. `name` is a secret of the environment; `hash` is `SHA-1`, `SHA-256` or `SHA-512`; `data` is a string (UTF-8) or `ArrayBuffer`; the key is `prefix + value` as UTF-8. It returns the MAC as an `ArrayBuffer`. A missing secret throws. The injector never gets a raw value.
- `globalOutbound` is `TempoOutbound` with the props `{workspaceId, userId, injector: <name>}`. For such a request, rule 0 and rule 1 apply, then only hosts that match the injector's `hosts` pass, then rule 14, then rule 7. Anything else returns 403. Rule 13 never runs again, so an injector cannot call another.
- `egress_log` records the container request and each injector subrequest with rule 13.
- An injector that throws returns 502, body `tempo: injector <name> failed`. MUST NOT log the error text; it can hold request data.

**Who may change an environment.** Only the owner, through server functions. Repo files cannot pick or change an environment (05). The agent can only propose changes (Agent proposals, below).

**After a change.** `updateEnvironment`, `setEnvironmentSecret`, `deleteEnvironmentSecret`, `deleteEnvironment`, `setProjectEnvironment` and `setWorkspaceEnvironment` call `refreshEnv()` on every live workspace that the change can touch. `refreshEnv()` sends `env.set` and `environment.set` (02). `TempoOutbound` picks up new rules within its 60 s cache.

**Agent proposals.** The agent can ask for changes, but cannot make them.

- `tempod` serves an MCP server named `tempo` to every agent session: `{"name": "tempo", "command": "/usr/local/bin/tempod", "args": ["mcp"], "env": [{"name": "TEMPO_SESSION_ID", "value": "<sessionId>"}]}`, where `<sessionId>` is the Tempo session id. It is passed next to Playwright in every `session/new` and `session/load`.
- `tempod mcp` speaks MCP over stdio (JSON-RPC 2.0, protocol version `2025-06-18`, methods `initialize`, `tools/list`, `tools/call`, `ping`). It talks to the `tempod` daemon over the Unix socket `/home/tempo/.tempod/mcp.sock`. The socket accepts the two environment tools below, `publish_artifact` (Artifacts), the agent tools from 08, project-scoped issue tools from 09 and deploy tools from 12. `report_result` is listed only for a run, with that run's output-kind schema. `list_agents` and `propose_agent_change` are listed only outside runs.
- Tool `environment_status`, no input: returns the summary from the last `environment.set`: environment name or null, policy, allowlist, secrets as `{name, hosts, set}`, injectors as `{name, hosts}`, and `blockedHosts`. Never a secret value.
- Tool `propose_environment_change`, input `EnvironmentProposal` (02): `tempod` sends the event `environment.proposed`. The tool returns "Sent to the owner for review." The agent MUST NOT ask the user to paste secret values in chat; the tool description says so.
- The DO stores each proposal in `environment_proposals` (02) as `pending`, at most 20 pending; a new one over the limit replaces the oldest. The UI shows pending proposals (04). Applying is done by the owner's client with the environment server functions; then it calls `resolveEnvironmentProposal`.
- A proposal only adds or replaces. It never removes allowlist patterns, secrets or injectors.

## Scripts, ports and previews

Each project has one setup script, any number of run scripts and one archive script. Every container has its own network, so every workspace uses the same port numbers.

**Script env.** `tempod` gives every script and every agent these vars, plus the project's `environment_variables` and secrets, and the environment secrets (Environments, above):

| Var | Value |
| --- | --- |
| `TEMPO_WORKSPACE_ID` | Workspace ULID |
| `TEMPO_WORKSPACE_NAME` | Workspace slug, for example `otter` |
| `TEMPO_WORKSPACE_PATH` | `/workspace` |
| `TEMPO_DEFAULT_BRANCH` | The workspace's base branch |
| `TEMPO_PORT` | `3000`. Ports 3000 to 3009 are for the project. |
| `TEMPO_ARTIFACTS_DIR` | `/home/tempo/artifacts`. A place for files an agent makes only to publish (Artifacts). It is not in the repo or in checkpoints. |

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

**Preview URL.** `https://<P>-<workspaceId lowercase>.<PREVIEW_DOMAIN>`, for example `https://3000-01jaxk3v2m9q8r7t6y5w4e3d2c.example-previews.com`. The hostname holds no secret. Each request needs the preview cookie for that host, which only the owner can get (05, Preview access).

**Preview request path**

1. The Worker sees a host under `PREVIEW_DOMAIN`. It matches the first label against `^(\d{4,5})-([0-9a-hjkmnp-tv-z]{26})$`. A label that matches the artifact pattern goes to 05, Artifact access instead. No match returns the preview 404 page (05).
2. A `GET /__tempo/enter` calls `WorkspaceDO.previewEnter(port, code)` (05, Preview access). Any other request calls `WorkspaceDO.previewFetch(request, port, cookie)` with the value of the `__Host-tempo_preview` cookie, after removing that cookie from the request.
3. The WorkspaceDO checks the cookie (05). A missing or bad cookie returns the preview 404 page, never 401 or 403.
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
- Set the accepted socket's `binaryType` to `"arraybuffer"` before accepting it, so keyboard frames reach `proc.stdin` as bytes regardless of the runtime's default binary type. Send `ready` only after both stdin and stdout are available. A failed stdin write closes the socket with 1011 so the client can reconnect.
- When the WebSocket closes, kill the `exec` process. The tmux session keeps running, so a reconnect gets the same shell and scrollback.
- An open terminal counts as activity, so the workspace does not sleep.
- The terminal tab list comes from `tmux list-sessions -F '#S'`, run through `tempod` (`terminal.list`).
- tmux reads `/home/tempo/.tmux.conf` (Shell and dotfiles), so the terminal shell is zsh and tmux shows no status line.
- Client: `@xterm/xterm` 6.0.0 and `@xterm/addon-fit` 0.11.0.

## Shell and dotfiles

Terminals run zsh with Oh My Zsh. The owner can change their shell files in Settings → Shell (04). Tempo keeps them in a private Cloudflare Artifacts repository (09) and copies them into each workspace's home folder.

- **Defaults.** Until the first save, the files are `DEFAULT_DOTFILES`: `.zshrc` and `.tmux.conf`, the files baked into the image. Scripts still run with `bash -lc`; only terminals and the login shell use zsh.
- **Files.** Each file is a path relative to `/home/tempo` and UTF-8 text. Limits are in `DOTFILES_LIMITS`: 20 files, 64 KB each, 256 KB in total. `isDotfilePath` allows only plain segments (`A-Z a-z 0-9 . _ + -`, no `.` or `..` segments) and rejects `DOTFILES_RESERVED` (`.tempod`, `.claude`, `.codex`, `.pi`, `.local/share/opencode`, `.ssh`, `attachments`) and anything under them. Shell files MUST NOT hold secrets; use Environments for those.
- **Storage.** The first `updateDotfiles` creates the Artifacts repository `dotfiles-<first 16 hex digits of sha256(userId)>` and a `dotfiles` row (02). Every save commits a complete snapshot of the file list to `main`: the Worker writes the blobs, trees and commit itself and pushes them with a short-lived write token over Git smart HTTP. The push names the stored `head_sha` as the old value; when Artifacts rejects it as stale, the call fails with `DOTFILES_CHANGED` and nothing changes. The repository is not a project and does not appear in project lists.
- **Apply.** The `dotfiles.apply` step (03) runs on `create` after `settings.read`, and on every `wake` before `sessions.markReload`. It calls tempod `dotfiles.apply` with the stored `clone_url` and `head_sha`, or `null` when the owner never saved. tempod fetches that commit into `/home/tempo/.tempod/dotfiles` and copies every file to its path, creating folders. It records the paths in `/home/tempo/.tempod/dotfiles.json`. A path from the previous record that is no longer listed is restored from `/etc/tempo/home-defaults/` when a default exists there, and deleted otherwise. With `null` it restores every recorded path the same way. The step is idempotent: the same commit gives the same files.
- **Egress.** `getEgressConfig()` adds `dotfiles: {cloneUrl} | null` for the workspace owner. Only the read side of that remote gets a credential (09, Git transport), from the WorkspaceDO's `getDotfilesToken()`; the container cannot push to it.
- **Failure.** A failed apply never blocks the workspace. The step logs `warn`, shows `Could not apply your shell files. Terminals use the defaults.` in the Setup tab, and continues.
- Changes reach a running workspace on its next wake. Terminals that are already open keep their shell until they are closed.

## Browser testing

Agents test in headless Chromium inside their own container, through the Playwright MCP server or the project's own Playwright tests.

- Chromium comes from Playwright 1.61.1 at `/opt/ms-playwright`. The directory is world-writable, so a project that pins another Playwright version can install its own build there at runtime.
- That runtime install needs egress to `cdn.playwright.dev` and `storage.googleapis.com`.
- Every session has the Playwright MCP server (see Agents). Agents MUST open the app at `http://localhost:<port>`, not at the preview URL.
- Headless only. There is no display in the container.
- Images an agent returns in a tool result (ACP `image` content) are shown in the transcript. To keep a screenshot, the agent saves it to a file and publishes it (Artifacts).
- Chromium trusts the Cloudflare containers CA through the NSS database that `tempod` sets up, so HTTPS sites load during tests.
- Memory: plan on up to 1 GiB for Chromium. This is one reason `standard-3` is the default.

**Browser Run (phase 3, optional, off by default)**

With `browser.run = true`, agents drive a Cloudflare Browser Run session instead of the container's Chromium, and the owner can watch and control it in Live View. The container never sees a Cloudflare token or a Live View URL.

- **Config.** The Worker has a Browser Run binding `BROWSER`. Under the `allowlist` egress policy, `browser.run` is ignored and the Setup tab shows `Browser Run is off: it does not pass the egress allowlist.` Browser Run loads other sites from Cloudflare's network, not through `TempoOutbound`.
- **Start.** `session.start` carries `browser: "run"` (else `"local"`). For `"run"`, `tempod` passes the Playwright MCP server `"--cdp-endpoint", "wss://browser.tempo.internal/"` in place of `"--headless", "--isolated", "--browser", "chromium"`. Playwright MCP connects on its first browser tool call.
- **CDP.** That connection leaves the container through `TempoOutbound` rule 11, which hands it to `WorkspaceDO.browserConnect(request)`. That reuses the workspace's Browser Run session while `env.BROWSER.getSession` says it is open, or acquires one with `env.BROWSER.acquire({keepAlive: 600000, outboundByHost: {localhost: ctx.exports.BrowserOutbound({props: {workspaceId}})}})`. It stores the session id in `workspace.browser_session_id` and returns the WebSocket from the session-pinned `webSocket` fetcher of `env.BROWSER.connectSession(sessionId)`.
- **The app under test.** Agents still open `http://localhost:<port>`. Browser Run sends requests for `localhost` to `BrowserOutbound`, which calls `WorkspaceDO.browserFetch(request, port)`. That follows steps 4 to 7 of the preview request path. Port 7070 is refused.
- **Live View.** `getBrowserLiveView` (02) checks that the session is still open (else it clears `browser_session_id` and returns null), lists the session's targets with `env.BROWSER.devtools.listTargets(sessionId)`, takes the last target of type `page`, and returns `env.BROWSER.getLiveView(sessionId, {targetId, mode: "tab"})`'s `devtoolsFrontendUrl`. The URL is valid for 5 minutes to connect. It carries a JWT that lets anyone control the tab: MUST NOT log it, store it or send it to `tempod`. Live View sends `frame-ancestors *`, so the web UI shows it in an iframe.
- **State.** `WorkspaceDetail.browserActive` is true while `browser_session_id` is set.
- **End.** While a session is open, the WorkspaceDO reads `env.BROWSER.getSession(sessionId)` every 60 s. It closes the session with `env.BROWSER.closeSession(sessionId)` and clears `browser_session_id` when the session has had no connection for 60 s, when the container stops, and on archive. It clears `browser_session_id` at once when Browser Run has ended the session itself, which it does after 10 minutes without a connection.
- Pricing on Workers Paid: 10 browser hours a month included, then $0.09 an hour ([source](https://developers.cloudflare.com/browser-run/pricing/)).
- Spike S17 MUST confirm the binding calls above, a WebSocket through `TempoOutbound`, and `outboundByHost` for `localhost`.

## Artifacts

An artifact is a file that an agent publishes for the owner to see: a plan, a screenshot, a diagram, a PDF or a small offline HTML app. Each publish is one version. Versions are stored in R2 and stay readable while the workspace sleeps.

**Tempo MCP server.** `publish_artifact` is a third tool of the `tempo` MCP server (Environments, Agent proposals).

- `tempod mcp` sends a `publish_artifact` call to the daemon as `POST /artifacts` on `/home/tempo/.tempod/mcp.sock`, with body `{sessionId, path, title, summary?}`. `sessionId` comes from `TEMPO_SESSION_ID`. The daemon answers `{text}` or, with status 400, `{error}`. The tool returns that text, with `isError` on an error. These schemas live in `packages/protocol`.
- Spike S18 MUST confirm that all four agents call this tool.

**Tool `publish_artifact`**

| Field | Value |
| --- | --- |
| Input | `path`: string, absolute. `title`: string, 1 to 120 characters. `summary`: optional string, at most 500 characters. |
| Output | Text: `Published "<title>" as version <version>. The user can open it in Tempo.` |
| Description | `Show a file to the user in Tempo. Use it for plans, reports, screenshots, diagrams, PDFs and small HTML apps that help the user understand or review your work. The file must be inside /workspace or $TEMPO_ARTIFACTS_DIR. Publish the same path again to replace what the user sees with a new version. Markdown may contain mermaid code blocks. HTML runs offline as one file: it cannot load or send anything over the network, so inline all scripts, styles, fonts and images.` |

**Allowed files.** The type comes from the file extension, case-insensitive. Any other extension is refused.

| Extensions | `mime` | `kind` |
| --- | --- | --- |
| `.png` | `image/png` | `image` |
| `.jpg`, `.jpeg` | `image/jpeg` | `image` |
| `.gif` | `image/gif` | `image` |
| `.webp` | `image/webp` | `image` |
| `.avif` | `image/avif` | `image` |
| `.svg` | `image/svg+xml` | `image` |
| `.md`, `.markdown` | `text/markdown` | `markdown` |
| `.pdf` | `application/pdf` | `pdf` |
| `.html`, `.htm` | `text/html` | `html` |
| `.txt`, `.log`, `.json`, `.csv` | `text/plain`, `text/plain`, `application/json`, `text/csv` | `text` |

**Publish** (`tempod`, on `POST /artifacts`)

`tempod` creates `/home/tempo/artifacts` at startup. Publishes run one at a time, so two publishes of one path never get the same version.

1. Resolve `path` with `realpath`. It MUST be a regular file under `/workspace` or `/home/tempo/artifacts`. Else answer `Path must be a file inside /workspace or $TEMPO_ARTIFACTS_DIR.`
2. Check the type (Allowed files). Else answer `This file type cannot be published. Use one of: png, jpg, gif, webp, avif, svg, md, pdf, html, txt, log, json, csv.`
3. Check the size: at most 25 MiB. Else answer `Artifacts are limited to 25 MiB.`
4. Find the artifact: the row in `tempod.db` table `artifacts` with the same session id and resolved path. If there is one, `version` is its last version plus 1. Else make a new `artifactId` (ULID) with `version` 1.
5. Copy the file to `/home/tempo/.tempod/artifacts/<artifactId>/<version>` and compute its SHA-256 while copying. The copy is what Tempo stores, so later edits to the file do not change this version.
6. Send the event `artifact.published` (02, tempod protocol) with the session's running `turnId`, or `null` when no turn runs. `name` is the file's base name.
7. Answer the tool call with the output text.

**Upload** (WorkspaceDO, on `artifact.published`)

1. In one transaction: insert the `artifacts` row (02) with status `uploading`, and create an `artifact` item (02, Item model) with status `pending` in the event's session and turn.
2. Read the staged copy with `new Files(this.ctx.container).readFile(stagedPath)` and write it to R2 at `artifacts/<workspaceId>/<artifactId>/<version>/<name>`, with `httpMetadata.contentType` = `mime` and custom metadata `sha256`.
3. Set the row to `ready` and the item to `completed`. Then send `artifact.release {artifactId, version}`, which deletes the staged copy.
- Uploads run outside the step runner, at most 2 at a time. A failed upload is retried with the step runner's backoff, at most 5 attempts.
- An upload is idempotent: if the R2 object exists with the same `sha256`, skip step 2.
- After `tempod.connect` on every wake, the DO retries each row still `uploading`. If the staged copy is gone (a fresh disk), set the row to `lost` and the item to `failed`.
- `sleep` and `archive` upload every row still `uploading` before `tempod.shutdown` (03, step `artifacts.upload`).

**Serving.** Images, Markdown and text reach the UI through the artifact route on `APP_HOST` (02). HTML and PDFs show only from the artifact host under `PREVIEW_DOMAIN` (05, Artifact access). The WorkspaceDO serves both from R2. Neither needs the container, so neither wakes it.

## Durability

A container's disk is wiped when it stops. Tempo keeps work safe in four layers, each with a fallback.

| Layer | What it saves | When | Where | If missing |
| --- | --- | --- | --- | --- |
| Transcript | Every item and event | As events arrive | WorkspaceDO SQLite | Cannot be missing |
| Checkpoint | The full working tree, including untracked files that are not ignored | End of each turn, before revert, before sleep, before archive, on SIGTERM | Hidden git ref in the container, plus a bundle in R2 | Use the previous checkpoint |
| Home backup | `/home/tempo`: agent session files and settings | End of each turn, at most once per 60 s | R2, through `DirectoryBackup` | Reload fails, so use the handoff |
| Snapshot | The whole writable disk: deps, caches, `tempod.db` | Sleep and archive | Cloudflare Containers snapshot | Fresh start: clone, apply checkpoint, restore home, run setup |
| Artifact | Each published version (Artifacts) | When the agent publishes it | R2 | A version not yet uploaded when its staged copy is lost becomes `failed` |

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
  exclude: [".cache/", ".npm/", "node_modules/", ".tempod/", "artifacts/",
            ".codex/auth.json", ".claude/.credentials.json"],
});
```

- Credentials MUST be excluded from backups. They come back from CredentialDO. Exclude the entire `.tempod/` directory: its SQLite outbox can contain unacknowledged `credential.changed` payloads, and a home restore MUST NOT overwrite the running daemon’s database. A fresh disk starts a new incarnation; snapshots retain the daemon database.
- Keep the 3 newest backups per workspace. Delete older ones with `backup.delete(rec)`.
- `artifacts/` is excluded because every published version is already in R2.

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

A repo MAY hold `.tempo/settings.yaml`. It is the only settings file Tempo reads from a repo.

```yaml
agent:
  default: claude               # claude | codex | opencode | pi
  models:                       # each agent's default model: its model config value; "" = the agent's own default
    claude: ""
    codex: ""
    opencode: ""                # required to start an OpenCode session
    pi: ""                      # required to start a Pi session

browser:
  run: false                    # true: agents use Browser Run, watched in Live View; ignored under egress_policy: allowlist

scripts:
  setup: bun install
  archive: ""
  run_mode: concurrent          # concurrent | nonconcurrent
  auto_run_after_setup: false
  run:
    dev:
      command: bun run dev
      cwd: ""                   # relative to /workspace; empty = /workspace
      default: true

environment:
  instance: standard-3          # standard-2 | standard-3 | standard-4
  sleep_after_idle_minutes: 15  # 5 to 240
  egress_policy: allowlist      # open | allowlist; Tempo UI only, ignored in repo files
  egress_allowlist: []          # host patterns; "*.example.com" is allowed; Tempo UI only

environment_variables:
  NODE_ENV: development

git:
  branch_prefix: tempo/
  delete_branch_on_archive: false
  archive_on_merge: false

prompts:
  general: ""                   # added to the first prompt of every session
```

**Precedence**, highest first:

1. Project overrides set in the Tempo UI (D1 `projects.settings_json`).
2. `.tempo/settings.yaml` on the workspace branch.
3. Defaults (the values shown above, with all scripts empty).

Tempo reads no Conductor files (`conductor.json`, `.conductor/`) and sets no `CONDUCTOR_*` env vars. Tempo uses no TOML of its own; the only TOML files are ones other tools require (Codex `config.toml`, Rust `Cargo.toml` and `rust-toolchain.toml`).

**Rules**

- Parse YAML with `yaml`. An empty file means no settings. Validate with an Effect Schema.
- If the file fails to parse or validate, ignore the whole file, show the error in the Setup tab, and use the defaults.
- Unknown keys are warnings, not errors.
- Secrets MUST NOT be in the repo file. Set them in the UI; they live in CredentialDO and join `environment_variables` at runtime.
- Read settings after the clone, and again when the file watcher sees a change to it. A script uses the settings in effect when it starts.

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
