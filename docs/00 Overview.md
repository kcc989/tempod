# Tempo — Overview and Architecture

Oct 10, 2026 · @Casey Collins

## Summary

Tempo runs Claude Code, Codex, OpenCode and Pi in parallel workspaces on your own Cloudflare account, with your own subscriptions. A workspace is one branch of a repo, one agent chat, and one Linux container that runs while the agent works and sleeps when it stops. The design copies SAM's control plane and orchestration, puts compute on Cloudflare Sandboxes in place of VMs, and copies Conductor's workspace UI.

This version is for **one trusted user on their own Cloudflare account**. The schema allows many users. The code allows one.

| # | Decision | Choice | Reason |
| --- | --- | --- | --- |
| D1 | Where the agent runs | The vendor's real CLI, inside a Cloudflare Sandbox | Claude and ChatGPT subscriptions work only through the vendors' own CLIs |
| D2 | Agent protocol | ACP (Agent Client Protocol) over stdio, bridged by an in-container daemon, `tempod` | One protocol for all four agents. SAM uses the same approach. |
| D3 | Source of truth | The transcript lives in WorkspaceDO SQLite. The container is disposable. | Work must survive the death of its container |
| D4 | Resume | Three layers: a git checkpoint at each turn end, a container snapshot on sleep, and the agent's own session files backed up to R2 | Each layer has a fallback: no snapshot means clone plus setup script; no session files means a new session with a transcript handoff |
| D5 | Repos | GitHub App. One branch per workspace, named `tempo/<workspace-slug>` | Conductor model; works on existing repos |
| D6 | Browser testing | Chromium and Playwright inside the Sandbox image. Browser Run Live View is optional. | Tests reach `localhost` with no public exposure |
| D7 | Stack | The standard stack: TanStack Start, shadcn/ui, Effect v4, Alchemy v2, Drizzle, D1, R2, Better Auth, Bun | Your standard stack for new products |
| D8 | SAM code | Do not copy any SAM code. Use SAM as a design reference only. | SAM is AGPL-3.0 |
| D9 | Container API | Sandbox SDK 1.0 model. WorkspaceDO owns ctx.container under the durable\_object scheduling policy. tempod is the container entrypoint. | SDK 1.0 (2026-09-30) removed the Sandbox class |
| D10 | GitHub and API-key credentials | Injected by the TempoOutbound egress handler. They never enter the container. | The documented Sandbox pattern for secrets |
| D11 | Claude and Codex credentials | Placed in the container: the Claude token as a process env var, the Codex auth.json as a file. Codex token refreshes sync back through CredentialDO. | Each CLI owns its own login and token refresh |
| D12 | Mac client | Tempo for Mac, a native app built with GPUI Kit. It is a client of the same Worker, through a JSON API and the same WebSocket channels. | Native speed and Conductor's ⌘ shortcuts, with one source of truth (07) |
| D13 | Agent artifacts | Agents publish files with the `publish_artifact` tool of the `tempo` MCP server in `tempod`. Tempo copies each version to R2 and shows it in the transcript. HTML runs offline, on its own host under `PREVIEW_DOMAIN`. | The owner can read plans, screenshots, diagrams and reports, also while the workspace sleeps. Agent HTML never runs on `APP_HOST`. |

**Rules for agents that build from this doc set**

- The words MUST, MUST NOT, SHOULD and MAY have their RFC 2119 meanings.
- Names in `code font` are exact. Do not rename tables, columns, events, routes or env vars.
- If two docs disagree, stop and ask. Do not pick one.
- If a doc is silent on a choice, stop and ask. Do not invent behavior.
- If the code and a doc disagree, the doc is correct until someone changes the doc.

**How this spec is organized.** This tab gives the shape. The other tabs give the exact rules.

| Tab | Holds |
| --- | --- |
| 01 Runtime and Agents | Container image, `tempod`, agents, credentials, egress, scripts, previews, terminal, browser tests, artifacts, durability |
| 02 Data and API | D1 and DO schemas, R2 layout, event model, server functions, WebSocket protocols, error codes |
| 03 Lifecycles | State machines, step runner, every multi-step flow, failure handling |
| 04 UI | Layout, panes, dialogs, indicators, keyboard shortcuts |
| 05 Security and Ops | Threat model, auth, secrets, egress, previews, deploy, logs, upgrades, cost |
| 06 Build Plan | Repo layout, phases, spikes, acceptance tests, rules for coding agents |
| 07 Mac Client | Tempo for Mac on GPUI Kit: native API, device sign-in, layout, macOS integration, release, phase 4 and gate E |

## Goals and non-goals

Version 1 succeeds when one user can run five agent workspaces at once, kill any container, and lose nothing but the work since the last turn ended.

**Goals**

| ID | Goal | Target |
| --- | --- | --- |
| G1 | Run Claude Code and Codex with the user's own Claude and ChatGPT subscriptions | Each logs in once and stays logged in across container restarts |
| G2 | Run OpenCode and Pi with API keys (OpenCode MAY also use a ChatGPT login) | Same UI as G1 |
| G3 | Run many workspaces in parallel, each in its own container | 5 at once, no shared state between containers |
| G4 | Work survives container death | Transcript: no loss. Files: loss limited to edits since the last turn ended. |
| G5 | Conductor-style UI in the browser | Sidebar, chat tabs, diff review, terminal, preview |
| G6 | Browser testing inside the workspace | Playwright with headless Chromium on `localhost` |
| G7 | Pull requests on GitHub from a workspace | One action from the diff view |
| G8 | Self-host from one repo | One Alchemy deploy on Workers Paid |
| G9 | Fast start | New workspace to first agent output: under 120 s. Resume a sleeping workspace: under 30 s. |
| G10 | Live output | Agent output in the UI within 1 s of `tempod` reading it (p95) |
| G11 | A native Mac client | Same features as the web UI, except in-app previews (07) |
| G12 | Show what agents make | Images, Markdown with diagrams, PDFs and offline HTML apps that an agent publishes show in the transcript, and stay readable while the workspace sleeps |

**Non-goals for version 1**

- More than one user, teams, or sharing.
- A hosted service for other people. Anthropic does not allow third parties to offer Claude sign-in.
- Billing, quotas, or a platform model proxy (SAM's `sam` mode).
- Tempo's own agent harness.
- Devcontainers. Version 1 uses one Tempo base image plus a per-project setup script.
- Docker inside the container.
- Approval policies. Version 1 runs each agent in its most permissive mode inside the container. It MUST still show any permission request an agent sends, such as a plan approval.
- A self-hosted git backend. Version 1 uses GitHub through a `GitProvider` interface, so a second provider can come later.
- Native mobile apps. The web UI MUST work at phone width for reading and sending prompts.

## Vocabulary

Use these words exactly, in code, UI and docs.

| Term | Meaning | Code name |
| --- | --- | --- |
| Project | One GitHub repo linked to Tempo, with its settings (scripts, default agent, env vars) | `project` |
| Environment | The template a container starts from: base image, setup script, env vars | `environment` |
| Workspace | Stored work: one branch, its sessions, its checkpoints, its backup. It outlives every container. | `workspace` |
| Container | One running Cloudflare Sandbox attached to one workspace. Temporary. | `container` |
| Session | One agent conversation inside a workspace, shown as one chat tab. One agent type, one ACP session id. | `session` |
| Turn | One user prompt plus everything the agent does until it stops | `turn` |
| Event | One normalized message about a session, stored in order | `event` |
| Checkpoint | A hidden git commit of the full working tree, made at the end of each turn | `checkpoint` |
| Preview | An owner-only URL to one port inside a container | `preview` |
| Artifact | A file that an agent published for the owner to see. Each publish adds a version, kept in R2. | `artifact` |
| Setup, run, archive scripts | Per-project shell scripts, as in Conductor | `setupScript`, `runScript`, `archiveScript` |
| `tempod` | The daemon inside each container. It runs agents and talks to the WorkspaceDO. | `tempod` |

**Banned words.** Do not use these in code, UI or docs: "VM", "node" (as a machine), "task", "worktree". SAM uses them, and they mean different things there. Use "Sandbox" only for the Cloudflare product and its SDK classes. In the UI, say "container".

## What we take from SAM

Tempo keeps SAM's control-plane patterns and replaces its compute layer. Facts about SAM come from its repo at commit `dd553a3` ([source](https://github.com/raphaeltm/simple-agent-manager)).

| Area | SAM | Tempo |
| --- | --- | --- |
| Control plane | Hono Worker plus a React SPA on Pages | TanStack Start in one Worker (server functions plus the SPA) |
| Compute | VMs in the user's cloud, a Go VM agent, devcontainers | One Cloudflare Sandbox per workspace, plus `tempod` |
| Orchestration | TaskRunner DO: alarm-driven, idempotent steps; callbacks skip the wait | Same pattern in WorkspaceDO |
| Warm start | NodeLifecycle DO keeps idle VMs warm for 30 min | No pool. Sandbox sleep plus restore from backup. |
| Chat storage | One ProjectData DO per project; one row per streamed chunk | One WorkspaceDO per workspace; chunks merged into one row per message |
| Agent protocol | ACP over `docker exec` stdio, Go SDK | ACP v1 over stdio, TypeScript SDK, inside `tempod` |
| Agents | Claude Code, Codex, Gemini, Mistral, OpenCode, Amp | Claude Code, Codex, OpenCode, Pi |
| Credentials | AES-256-GCM in D1; fetched at agent start; Codex `auth.json` synced back under a lock | Same |
| Repo access | GitHub App installation tokens through a git credential helper | Same |
| Terminal | Go PTY, RS256 JWT, custom JSON frames | PTY exec with tmux, xterm.js in the browser |
| Previews | Worker reverse proxy at `ws-{id}--{port}.{domain}` | Owner-only hostnames with a preview cookie, proxied Worker → WorkspaceDO → tempod |
| Message delivery | SQLite outbox on the VM, batched POSTs | SQLite outbox in `tempod`, batched over one WebSocket |

**Keep from SAM:** idempotent alarm steps; callbacks instead of polling; no secrets in images; the DO owns session state; an outbox for every message; one lock that serializes Codex token refresh.

**Avoid from SAM:**

- One DO per project. One SAM project reached 99.7% of the 10 GB DO limit.
- One row per streamed chunk.
- Privileged containers that run agents as root.
- Slow warm starts. SAM measures p50 82 s and p90 185 s.

## Architecture

&#91;embedded content: Tempo architecture · one Worker, Durable Objects, one container per workspace\]

The browser talks only to the Worker. Each WorkspaceDO starts its own container, keeps one WebSocket open to `tempod`, and stores the transcript. Every outbound request from a container passes through `TempoOutbound`, which adds GitHub and API-key credentials. WorkspaceDOs push status changes to UserHubDO, which feeds the live sidebar. Preview traffic takes the UI's path: Worker, WorkspaceDO, `tempod`, then the app's port.

## Components

Tempo is one Worker deployment, three Durable Object classes, one egress handler, one container image and one daemon.

| Component | Kind | Instances | Owns | Talks to |
| --- | --- | --- | --- | --- |
| Tempo Worker | TanStack Start app on Workers | 1 deployment | Routing, auth (Better Auth), server functions, the SPA, GitHub API calls, preview host routing | D1, R2, all DOs, GitHub API |
| `WorkspaceDO` | Durable Object with a container (`ctx.container`) | 1 per workspace, named by workspace id | Workspace state machine, step runner, sessions, transcript items, checkpoints index, scripts, previews, terminals, the `tempod` connection | `tempod`, `UserHubDO`, `CredentialDO`, D1, R2, GitHub API |
| `UserHubDO` | Durable Object | 1 per user | UI WebSocket fan-out for the sidebar; workspace summaries | Browser, `WorkspaceDO` |
| `CredentialDO` | Durable Object | 1 per user | Encrypted secrets; Codex `auth.json` versions and fan-out | `WorkspaceDO` |
| `TempoOutbound` | `WorkerEntrypoint` used as the container egress handler | Per request, with props workspaceId and userId | Egress policy, credential injection, egress log | GitHub, model APIs, the internet |
| `tempod` | Bun-compiled binary, container entrypoint | 1 per running container | ACP client for agents, scripts, git, port detection, preview proxy, the `tempo` MCP server, local outbox | `WorkspaceDO` (inbound WebSocket), agent processes |
| Tempo for Mac | Rust app on GPUI Kit (07) | 0 or more per owner | Window layout, drafts, its Keychain token | Tempo Worker (`/api/v1`, WebSockets) |
| Image `workspace` | Container image (Debian trixie, Node 24) | 1 image, many containers | Agents, Chromium, Playwright, dev tools | — |
| D1 database `tempo` | SQLite (D1) | 1 | Users, GitHub installations, projects, workspace summaries | — |
| R2 bucket `tempo-data` | Object storage | 1 | Checkpoint bundles, home backups, attachments, script logs, artifacts | — |

## Where state lives

The WorkspaceDO is the source of truth for a workspace. D1 holds only what lists and the sidebar need. Full schemas are in 02 Data and API.

| Data | Store | Kept until |
| --- | --- | --- |
| Users and login sessions | D1, Better Auth tables | Deleted |
| GitHub installations, projects | D1 | Unlinked |
| Workspace summary: name, branch, state, attention, PR | D1 `workspaces`, written only by its WorkspaceDO after createWorkspace inserts it | Deleted |
| Workspace state, sessions, turns, transcript items, events, checkpoint index, review comments, script runs | WorkspaceDO SQLite | Workspace deleted |
| Secrets | CredentialDO SQLite, AES-256-GCM | Deleted |
| Checkpoint bundles, home backups, attachments, script logs, artifacts | R2 bucket `tempo-data` | Retention rules in 02 |
| Container snapshot | Cloudflare Containers snapshot | 30 days after creation or last restore |
| Live UI connections | UserHubDO and WorkspaceDO memory | Connection closes |

## Main flows

Every flow runs as idempotent steps in the WorkspaceDO step runner. Steps, timeouts and failure handling are in 03 Lifecycles.

1. **Create a workspace.** Pick a repo and base branch, type a prompt. The WorkspaceDO starts a container, clones the repo, creates `tempo/<slug>`, runs the setup script, starts the agent session and sends the prompt.
2. **Send a prompt.** The UI calls a server function. The WorkspaceDO queues a turn, sends it to `tempod`, and streams items back to every open UI tab.
3. **End a turn.** The WorkspaceDO asks `tempod` for a checkpoint and uploads it to R2, backs up the home folder, and asks for the changed files. The workspace shows unread if nobody is watching.
4. **Sleep.** After 15 idle minutes, the WorkspaceDO writes a final checkpoint, snapshots the container and destroys it.
5. **Wake.** A prompt, a terminal or a preview request starts the container from its snapshot, or from a fresh clone plus the latest checkpoint.
6. **Ship.** Commit and push from the diff view, then open a pull request. The Worker calls the GitHub API.
7. **Archive.** Run the archive script, write a final checkpoint, destroy the container. The branch and transcript stay; restore brings the workspace back.

## Agents and credentials

All four agents speak ACP v1 to `tempod`. Claude Code and Codex use your subscriptions; OpenCode and Pi use an OpenRouter key. Exact packages, commands and env vars are in 01 Runtime and Agents.

| Agent | ACP adapter | Login | Billed to |
| --- | --- | --- | --- |
| Claude Code | `@agentclientprotocol/claude-agent-acp` (Claude Agent SDK, runs the native `claude` binary) | Token from `claude setup-token`, pasted once into Tempo | Your Claude Pro or Max plan |
| Codex | `@agentclientprotocol/codex-acp` (runs the Codex app server) | Device-code sign-in from Settings, or `~/.codex/auth.json` from `codex login`, uploaded once | Your ChatGPT plan |
| OpenCode | `opencode acp` | OpenRouter API key, added by `TempoOutbound` | OpenRouter usage |
| Pi | `pi-acp`, which runs `pi --mode rpc` | OpenRouter API key, added by `TempoOutbound` | OpenRouter usage |

**Policy.** Anthropic's Help Center (updated 2026-10-07) says you can use the Agent SDK and `claude -p` with your own plan ([source](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)). Its legal page forbids third parties from offering Claude login or routing other people's plan credentials ([source](https://code.claude.com/docs/en/legal-and-compliance)). Tempo is self-hosted for one user, so it stays inside both rules. A hosted multi-user Tempo MUST use API keys for Claude.

## Git and repos

Each workspace is one branch of one GitHub repo, and the container never holds a GitHub token. Flows are in 03 Lifecycles.

- Repos come from a GitHub App that the owner creates and installs on their account or org.
- A new workspace gets branch `tempo/<slug>`, created from `origin/<base_branch>` after a fetch. A workspace MAY instead check out an existing branch or a PR's head branch.
- One branch belongs to at most one non-archived workspace.
- At the end of each turn, `tempod` commits the full working tree to a hidden ref (`refs/tempo/checkpoints/<checkpointId>`) without touching the branch or the index, and uploads a git bundle of it to R2.
- `TempoOutbound` adds a repo-scoped installation token to every HTTPS request for `github.com` and `api.github.com`.
- The Worker opens, updates and merges pull requests through the GitHub REST API.
- The repo provider sits behind a `GitProvider` interface. GitHub is the only provider in version 1.

## Browser testing and previews

Agents test in a real Chromium inside their own container; you see the same app through a private preview URL. Details are in 01 Runtime and Agents.

- The image ships Chromium and Playwright at `/opt/ms-playwright`.
- Every agent session gets the Playwright MCP server, so all four agents can open pages, click and take screenshots.
- The owner can add their own MCP servers (stdio, or remote over HTTP or SSE) in Settings. Every agent gets them; `tempod` bridges a remote transport the agent lacks, and `TempoOutbound` adds secret headers at egress.
- Tests and the agent's browser use `http://localhost:<port>`. Nothing is exposed for them.
- You reach a running app at `https://<port>-<workspaceId>.<PREVIEW_DOMAIN>`. The hostname holds no secret: Tempo opens each preview through a one-time link that sets a preview cookie, so only you can open it. Traffic goes Worker, WorkspaceDO, `tempod`, then the port.
- The UI shows each detected port as a preview link and can open it in a Browser tab next to the chat.
- Cloudflare Browser Run with Live View is optional, off by default, and comes in phase 3. With it on, agents drive a remote browser that you can watch and control (01, Browser Run).

## Artifacts

An agent can show you a file it made: a plan, a screenshot, a diagram, a PDF report or a small HTML app. Details are in 01, Artifacts.

- Every session gets the `tempo` MCP server. Its tool `publish_artifact {path, title, summary?}` publishes a file.
- `tempod` copies the file, and the WorkspaceDO uploads it to R2. Each publish of the same path in the same session is a new version of the same artifact.
- The transcript shows each publish as an artifact card. The card opens an Artifact tab. The right panel has an Artifacts tab that lists all of them.
- Images, Markdown (with Mermaid diagrams) and text show inside the Tempo UI. PDFs and HTML show from their own owner-only host under `PREVIEW_DOMAIN`, in an iframe. HTML runs offline: it cannot load or send anything over the network.
- Artifacts stay readable while the workspace sleeps and after it is archived. They are deleted with the workspace.

## UI

The UI copies Conductor's three-pane layout in the browser. Full spec is in 04 UI.

- **Left sidebar:** projects, each with its workspaces. Each row shows the branch, the city name, a status icon and the PR number.
- **Center:** tabs for chats (one per session), files, the diff, previews and artifacts. The composer sits at the bottom of a chat tab.
- **Right panel, top:** Changes, All files, Checks and Artifacts.
- **Right panel, bottom:** Setup, Run and Terminal tabs.
- **Top bar:** branch name, base branch, preview links, and the next git action (commit and push, create PR, merge).
- Shortcuts follow Conductor, except where a browser reserves the key. ⌘N, ⌘T and ⌘W become ⌥N, ⌥T and ⌥W.
- **Tempo for Mac** offers the same UI as a native app, with Conductor's ⌘ shortcuts (07).

## Security

The container is the security boundary, and the only way out of it is `TempoOutbound`. Full model is in 05 Security and Ops.

- One owner. Better Auth signs in with GitHub, and only the GitHub user id in `TEMPO_OWNER_GITHUB_ID` may sign in.
- Containers start with `enableInternet: false`. All HTTP and HTTPS goes through `TempoOutbound`.
- GitHub tokens and the OpenRouter key never enter a container. Claude and Codex credentials do. This is an accepted risk for one trusted user and is logged as R4.
- Secrets are encrypted with AES-256-GCM in CredentialDO, keyed by `TEMPO_ENCRYPTION_KEY`.
- `tempod` port 7070 is reachable only from the WorkspaceDO through `getTcpPort`. Each container start gets a new bearer token. The preview proxy MUST refuse port 7070.
- Artifact HTML and PDFs never load on `APP_HOST`. Each artifact has its own owner-only host under `PREVIEW_DOMAIN`, with a CSP that blocks all network access (05, Artifact access).
- Under the `durable_object` scheduling policy every container process has root capabilities. A non-root user sets file ownership only; it is not a boundary.
- Tempo for Mac signs in with a device code that the owner approves in the browser. It keeps a bearer token in the Keychain, and the owner can revoke it (05, 07).

## Cost

A running workspace on `standard-3` costs about $0.10 an hour; a sleeping one costs only storage. Rates are from the Containers pricing page ([source](https://developers.cloudflare.com/containers/platform/pricing/)).

| Item | Rate | Per running hour on `standard-3` (2 vCPU, 8 GiB, 16 GB) |
| --- | --- | --- |
| Memory | $0.0000025 per GiB-s, billed on provisioned size | $0.072 |
| CPU | $0.000020 per vCPU-s, active use only | About $0.029, assuming 0.4 vCPU average use |
| Disk | $0.00000007 per GB-s | $0.004 |
| **Total** |  | **About $0.105** |

Example: 5 workspaces running 4 hours a day for 22 days is 440 hours, about $46 a month plus the $5 Workers Paid plan. The included allowances (25 GiB-h memory, 375 vCPU-minutes, 200 GB-h disk) take off about $1. Claude Code and Codex use your plans. OpenCode and Pi bill to OpenRouter.

## Phases

Build in six phases. Each phase ends at a gate: gate A is the spike results, and gates B to F are passing acceptance tests. Spikes, tests and the gates are in 06 Build Plan.

1. **Phase 0, spikes.** Prove the risky parts in throwaway code: the container API, egress injection, each agent's login through the egress proxy, snapshots, previews, Playwright.
2. **Phase 1, one workspace.** Claude Code only. Create, chat, stream, checkpoint, sleep, wake and resume, with the transcript intact.
3. **Phase 2, parallel work.** Many workspaces, the live sidebar, Codex, OpenCode and Pi, the diff view, scripts, terminal, previews and revert.
4. **Phase 3, ship.** Commit and push, pull requests, checks, merge, archive and restore, settings, and optional Browser Run.
5. **Phase 4, Mac client.** The native API and device sign-in on the server, then Tempo for Mac on GPUI Kit (07).
6. **Phase 5, artifacts.** The `publish_artifact` tool, artifact storage in R2, the artifact host, the Artifact and Artifacts tabs, image and Markdown views in file and diff tabs, and Mermaid diagrams, in the web UI and the Mac app.

## Risks and open questions

The biggest risk is that the container platform is new: Sandbox SDK 1.0 shipped on 2026-09-30, and snapshots are in beta. Each risk names the spike that tests it (spikes are in 06).

| ID | Risk | Impact | Mitigation | Spike |
| --- | --- | --- | --- | --- |
| R1 | Sandbox SDK 1.0, the `durable_object` scheduling policy and container snapshots are new or in beta | APIs change; snapshots fail | Pin exact versions. The fallback wake path (clone, checkpoint, setup script) MUST always work. | S1, S5, S6 |
| R2 | Alchemy v2 may not support `scheduling_policy: "durable_object"` or `exports` | Deploy blocked | If S1 finds a gap, deploy with wrangler and keep Alchemy for the rest | S1 |
| R3 | Model streams and WebSockets through `TempoOutbound` | Agent calls break or time out | Test each agent through the proxy before phase 1 | S2, S3, S4 |
| R4 | Claude and Codex credentials live inside the container | A hostile repo or prompt could leak them | One trusted user; egress log; later, test a placeholder token that `TempoOutbound` swaps for the real one | S3 |
| R5 | Codex token refreshes from parallel containers can race | One refresh can break another container's login | CredentialDO keeps the newest `auth.json` and pushes it to every running container; auth errors ask the user to reconnect in Settings | S4 |
| R6 | ACP adapters are young: `claude-agent-acp` 0.89.1, community `pi-acp` 0.0.34 | Breaking changes | Pin versions; adapter conformance tests in CI; Pi fallback is a Tempo adapter over `pi --mode rpc` | S3, S9 |
| R7 | Anthropic or OpenAI change subscription rules | Login stops working | Every agent also accepts an API key | — |
| R8 | Memory is billed on provisioned size | Monthly cost | Sleep after 15 idle minutes; instance size per project | S7 |
| R9 | A snapshot works only with the image it came from | Slow wake after each image change | Fallback wake path; R2 home backups; change the image rarely | S6 |
| R10 | Host restarts send SIGTERM, then SIGKILL within 15 minutes | A running turn stops | On SIGTERM the WorkspaceDO checkpoints and backs up before the container stops; the turn is marked interrupted; the session reloads | S6 |
| R11 | The WorkspaceDO cannot hibernate while its container runs | Small DO duration cost | Accepted; container cost dominates | — |
| R19 | Agent HTML runs in the owner's browser | A hostile artifact tries to read Tempo data or send data out | Own host under `PREVIEW_DOMAIN`, owner cookie, CSP `connect-src 'none'` and `sandbox`. A frame can still navigate itself to another site; this is accepted, because the same agent can already send data out through egress. | S18 |

**Open questions for you**

- [ ] Q1. Do any of your repos need Docker? Docker-in-Docker works only as root with special flags, so version 1 leaves it out.
- [ ] Q2. Is OpenRouter the right default provider for OpenCode and Pi?
- [x] Q3. Previews are owner-only. The hostname holds no secret; a one-time link sets a preview cookie (05, Preview access).
- [ ] Q4. Codex through `codex-acp` (one protocol for all agents) or through the Codex app server directly (steering, host-managed tokens)? This spec picks `codex-acp`.
- [ ] Q5. Default instance `standard-3` (2 vCPU, 8 GiB) or `standard-2` (1 vCPU, 6 GiB)?

Risks R12 to R18 and questions Q6 to Q10, for the Mac client, are in 07.

## Sources

Pages read on 2026-10-10.

- [Simple Agent Manager repo](https://github.com/raphaeltm/simple-agent-manager), commit `dd553a3`
- [Conductor docs](https://www.conductor.build/docs) and [changelog](https://www.conductor.build/changelog), version 0.90
- [Sandbox SDK: changes in 1.0](https://developers.cloudflare.com/sandbox/sdk/migrate/changes-in-1-0/)
- [Containers: Durable Object container API](https://developers.cloudflare.com/containers/api/durable-object-container/)
- [Containers: scheduling policy](https://developers.cloudflare.com/containers/configuration/scheduling-policy/)
- [Containers: limits](https://developers.cloudflare.com/containers/platform/limits/) and [pricing](https://developers.cloudflare.com/containers/platform/pricing/)
- [Containers: snapshots](https://developers.cloudflare.com/containers/guides/snapshots/)
- [Sandbox: directory backups](https://developers.cloudflare.com/sandbox/reference/directory-backups/)
- [Containers: outbound traffic](https://developers.cloudflare.com/containers/configuration/outbound-traffic/)
- [Sandbox: build a coding agent runner](https://developers.cloudflare.com/sandbox/get-started/build-a-coding-agent-runner/)
- [ACP v1 schema](https://agentclientprotocol.com/protocol/v1/schema)
- [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp) and [codex-acp](https://github.com/agentclientprotocol/codex-acp)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) and [authentication](https://code.claude.com/docs/en/authentication)
- [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [Help Center: Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [Codex auth in CI/CD](https://learn.chatgpt.com/docs/auth/ci-cd-auth) and [config reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [OpenCode ACP](https://opencode.ai/docs/acp)
- [pi-acp](https://github.com/svkozak/pi-acp) and [Pi RPC mode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
- [Browser Run Live View](https://developers.cloudflare.com/browser-run/features/live-view/) and [pricing](https://developers.cloudflare.com/browser-run/pricing/)
