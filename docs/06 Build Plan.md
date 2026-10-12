# 06 Build Plan

This tab says what to build first, what each spike must prove, and how to know a phase is done.

## Repo layout

One Bun workspace monorepo. Each folder has one job; shared types live only in `packages/protocol`.

```text
tempo/
  apps/
    tempo/                      the Worker: TanStack Start app, Durable Objects, egress
      src/
        worker.ts               main module and its exports (01)
        routes/                 TanStack Start routes (UI)
        server/                 server functions, one file per area in 02
        do/
          workspace/            WorkspaceDO: index.ts, ops/, steps/, queue.ts, items.ts,
                                tempod-client.ts, preview.ts, terminal.ts, github.ts
          user-hub.ts
          credential.ts
        egress/outbound.ts      TempoOutbound
        github/                 app JWT, installation tokens, REST client
        auth/                   Better Auth config and owner check
        db/                     Drizzle schemas (d1.ts, workspace-do.ts, credential-do.ts,
                                user-hub-do.ts) and migrations/
        ui/                     components and per-workspace stores
  packages/
    protocol/                   Effect Schemas: shared types, channels, tempod protocol, errors
    tempod/                     the daemon: main.ts, server.ts, outbox.ts, acp/, scripts.ts,
                                git.ts, ports.ts, watcher.ts, proxy.ts
    settings/                   settings.toml parsing and Conductor mapping (used by tempod and the Worker)
    cities/                     the fixed slug list
  container/
    Dockerfile
    versions.json
    home/                       files baked into /home/tempo
  tests/
    e2e/                        Playwright tests against a deployed test environment
    conformance/                adapter conformance tests, run inside the image
  spikes/                       one S<n>.md per spike, with findings
  alchemy.run.ts
  AGENTS.md
  CLAUDE.md                     symlink to AGENTS.md
```

**Tooling:** Bun, Vite, TypeScript in strict mode, Vitest with `@cloudflare/vitest-pool-workers` for DO tests, oxlint, Oxfmt. Effect v4 in Worker server code and in `tempod`; the UI uses Effect Schema only.

**Scripts** (root `package.json`): `dev`, `build`, `typecheck`, `lint`, `format`, `test`, `test:conformance`, `test:e2e`, `deploy`.

## Phases and gates

&#91;embedded content: Build roadmap · 4 phases, 4 test gates\]

A phase starts only after the gate before it passes. Work for the next phase MAY begin early in a branch, but it MUST NOT merge until the gate passes. If a spike shows the spec is wrong, change the spec first, then the code.

Phase 5 (08) is the exception: it MAY run in parallel with phases 2 to 4, its milestones merge when their own tests pass, and gate F needs gate B. Its spikes are S18 and S19 (08).

## Spikes

Each spike is throwaway code in its own branch that answers one question. Its result goes in `spikes/S<n>.md`: what was tried, what worked, exact names and timings. If a result differs from the spec, change the spec before phase 1. Gate A, the end of phase 0, passes when every spike has its result file and the spec matches every result.

| ID | Question | Pass criteria | Risks |
| --- | --- | --- | --- |
| S1 | Does the container API work as this spec uses it? | A DO with `ctx.container` under `durable_object`, deployed with Alchemy v2 (or wrangler if Alchemy cannot), runs `start`, `exec` (with stdin and PTY), `getTcpPort().fetch`, `snapshotContainer`, `destroy` and `setInactivityTimeout` 10 times with no error. `exec` without `user` reports `id -u` = 1000. `images.workspace` is readable. | R1, R2 |
| S2 | Can git work with no token in the container? | With `interceptOutboundHttps("*")` and `TempoOutbound`, clone, fetch and push a private repo. `env` and every file under `/home/tempo` contain no GitHub token. Rows appear in `egress_log`. A request to `APP_HOST` gets 403. | R3 |
| S3 | Does Claude Code work with a subscription token through the egress proxy? | `claude-agent-acp` with `CLAUDE_CODE_OAUTH_TOKEN` completes 3 turns with tool calls, streaming live. Modes include `bypassPermissions` as uid 1000. `session/load` works after the adapter restarts. Usage counts against the plan. API-key mode works with the placeholder swap. Record every host contacted. | R3, R4, R6 |
| S4 | Does Codex work with ChatGPT login through the proxy, and does refresh sync work? | `codex-acp` completes 3 turns. Set `last_refresh` 9 days back: Codex rewrites `auth.json`, `tempod` sends `credential.changed`. With two containers on one login, a refresh in one is pushed to the other, and both complete 3 more turns. Record every host and any WebSocket use. | R3, R5 |
| S5 | Does the DO to `tempod` link survive restarts with no loss? | Stream 10,000 events. Redeploy the Worker mid-stream. The DO reconnects with the stored token; the transcript has every `seq` exactly once. | R1 |
| S6 | Are wake times on target? | A repo with about 1 GB of `node_modules`. Over 10 runs: wake from snapshot p90 under 30 s; fresh path before setup p90 under 90 s. Signal 15 to `tempod` writes a checkpoint. | R1, R9, R10 |
| S7 | Does browser testing fit? | Confirm the `@playwright/mcp` bin name and flags. Claude runs a Playwright check against a Vite app on `localhost`. Peak memory with Claude, Chromium and the dev server stays under 6 GiB on `standard-3`. | R8 |
| S8 | Do previews work for real dev servers? | A Vite dev server bound to `127.0.0.1` loads through the preview URL, and hot reload over WebSocket works. A sleeping workspace shows the wake page. | — |
| S9 | Do OpenCode and Pi work through ACP? | `opencode acp` and `pi-acp` complete 3 turns each with OpenRouter via the placeholder swap. Record whether `session/load` works for each. | R6 |
| S10 | Does the terminal work through the DO? | PTY `exec` with tmux over the DO WebSocket. Resize works. A reconnect gets the same session and scrollback. | — |
| S17 | Does Browser Run work as 01 uses it? | Playwright MCP in the container connects over `wss://browser.tempo.internal/` through `TempoOutbound` to a session from `env.BROWSER.acquire`. The remote browser loads `http://localhost:<port>` through `outboundByHost`. Live View shows the page in an iframe on `APP_HOST`. `closeSession` ends it. | — |

## Acceptance tests

Each gate is a list of end-to-end tests in `tests/e2e`, run against a deployed test environment with real logins. A gate passes when every test in it passes 3 runs in a row.

**Gate B: Phase 1**

| ID | Test |
| --- | --- |
| AT-1 | The owner signs in. A different GitHub account is refused with the owner message. |
| AT-2 | Link a repo, create a workspace with a prompt. First agent output in under 120 s. Branch `tempo/<slug>` exists in the container. |
| AT-3 | Agent text streams live. Reloading the page mid-turn shows the full transcript and the stream continues. |
| AT-4 | Tool calls render with live status. A plan-mode permission request is approved from the UI and the turn continues. |
| AT-5 | Each turn end that changed files creates a checkpoint row and an R2 bundle. A turn with no change reuses the previous checkpoint. `listCheckpoints` returns it. |
| AT-6 | With `sleep_after_idle_minutes = 5`, the workspace sleeps and the container is destroyed. A prompt wakes it from the snapshot in under 30 s, and the agent still knows the earlier turns. |
| AT-7 | Destroying the container mid-turn marks the turn `interrupted`, shows a notice, wakes the workspace, and the next prompt works. |
| AT-8 | With the snapshot marked `unusable`, a wake takes the fresh path. The working tree's hash equals the last checkpoint's tree, and the session reloads or hands off. |

**Gate C: Phase 2**

| ID | Test |
| --- | --- |
| AT-9 | Five workspaces run turns at the same time. The sidebar shows each state live. No output appears in the wrong workspace. |
| AT-10 | Codex, OpenCode and Pi each complete a turn in their own chat tab in one workspace. |
| AT-11 | A Codex token refresh in one workspace reaches a second running workspace, which then completes a turn. |
| AT-12 | The diff view is correct for added, changed, deleted, renamed and untracked files in both scopes. Review comments reach the agent in the next prompt. |
| AT-13 | Revert restores the exact tree of the chosen checkpoint, shows the marker, and the next prompt carries the revert note. |
| AT-14 | A repo with only `.conductor/settings.toml` runs its setup and run scripts, with `CONDUCTOR_PORT` set. |
| AT-15 | A terminal runs commands; after a reconnect, the session and scrollback are still there. |
| AT-16 | A Vite preview opened from Tempo works with hot reload, also in a Browser tab. The bare preview URL in a fresh browser shows the preview 404 page. Reset preview access stops an open preview. An agent passes a Playwright MCP check on `localhost`. |

**Gate D: Phase 3**

| ID | Test |
| --- | --- |
| AT-17 | Commit and push, then create a PR. The badge and checks state update within 60 s. |
| AT-18 | Squash-merge from Tempo. With `archive_on_merge`, the workspace archives. |
| AT-19 | Archive, restore, wake: transcript and files are intact. |
| AT-20 | With the `allowlist` policy, a host not on the list gets 403 and an `egress_log` row. `APP_HOST` is blocked under both policies. |
| AT-21 | At phone width: list workspaces, read a live transcript, send a prompt, approve a permission. |
| AT-22 | Every shortcut in 04 works in Chrome on macOS. |
| AT-38 | A workspace created from a PR shows `#<number> ↗` and the PR state at once; Create PR is not offered. |
| AT-39 | With `browser.run = true`, an agent checks the app on `localhost` in Browser Run, and the Live View tab shows it. Under `allowlist`, the agent uses local Chromium. |
| AT-40 | An OpenCode chat with no `agent.models.opencode` is disabled in the New chat menu; a queued OpenCode turn fails with `MODEL_REQUIRED`. |

**Also at Gate D:** during a full e2e run, grep all Worker logs, `events` rows and R2 objects for the test credentials' values. Zero matches is required.

## AGENTS.md

Put this file at the repo root, with `CLAUDE.md` as a symlink to it. It turns the most common mistakes into rules.

```markdown
# Rules for agents working on Tempo

The Tempo Spec (tabs 00 to 06) is the source of truth. Read the tab for the area you change before you write code.

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
```

## Definition of done

A change is done only when every box below is true.

- [ ] It does what the spec says, with the exact names from the spec.
- [ ] Typecheck, lint and unit tests pass.
- [ ] New server functions, op steps and `tempod` requests have tests, including one failure case each.
- [ ] Any new wire type is in `packages/protocol`.
- [ ] No secret can reach a log, an error, D1, `events` or R2 (checked by reading the diff).
- [ ] Any new version is pinned.
- [ ] UI changes work at phone width and in both themes.
- [ ] The acceptance tests of the current phase still pass.
- [ ] If behavior changed, the spec changed in the same pull request.
