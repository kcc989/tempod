# Implementation notes

This file lists where the code differs from the spec (tabs 00 to 07), what the spec left open and how the code fills it, and what is not built yet. Each item names the spec section it touches. Per AGENTS.md rule 16, a behaviour change needs a spec change; the items under **Spec changes to make** need your decision first.

## Spec changes to make

These are places where the spec and the real packages disagree. The code follows the packages and keeps the spec's names where it can.

| # | Spec | Finding | What the code does |
| --- | --- | --- | --- |
| S-1 | 00 R2, 05 Deploy | Alchemy 2.0.0-beta.81 cannot emit `exports` or a `durable_object` container with named `images`. | `alchemy.run.ts` owns D1 (and its migrations), R2 and the three generated secrets. `scripts/deploy-worker.ts` writes the wrangler config and deploys the Worker with wrangler. This is the fallback that R2 allows. |
| S-2 | 01 Agents, Playwright MCP | `@playwright/mcp@0.0.83` installs the bin `playwright-mcp`, not `mcp-server-playwright`. | The image adds a `mcp-server-playwright` symlink, so the spec's command works. Spike S7 should confirm the name and the flags. |
| S-3 | 01 Start procedure | `ContainerStartupOptions.containerSnapshot` takes `{ id }`, not a string. | `start({ containerSnapshot: { id } })`. |
| S-4 | 01 Start procedure | `DirectoryBackup` needs `backup.intercept()` before `interceptAllOutboundHttp()`. Otherwise the catch-all takes the backup gateway's host. | `container.start` registers the backup intercept first, then the two egress intercepts. |
| S-5 | 06 Tooling | `@cloudflare/vitest-pool-workers` is deprecated and renamed `@cloudflare/vitest-plugin`. Its bundled workerd supports compatibility dates up to 2026-08-22. | The spec's package is kept (0.23.0). `apps/tempo/test/wrangler.test.jsonc` uses 2026-08-22; deploys use 2026-10-10. |
| S-6 | 01 Worker config | Alchemy notes that Cloudflare may reject a redundant `nodejs_compat` flag after its default-on date (2026-08-04). | The flag is kept as the spec says. If a deploy rejects it, remove it. |

## Additive protocol changes

Protocol version 1 allows additive changes only (05). All of these are optional fields or new message types and live in `packages/protocol`.

| Where | Addition | Why |
| --- | --- | --- |
| `WorkspaceDetail` | `settingsWarnings`, `settingsErrors`, `settingsSources`, `changes`, `hasUnpushedCommits` | 04 needs settings issues in the Setup tab, the source of each setting in Settings → Project, the last known changes while sleeping, and row 1 of the primary-action table. |
| `settings.read` result, `settings.changed` | `sources` | Same as above: where each effective value came from. |
| `session.start` result | `modeId` | The agent's current mode, so the mode picker is right before the first `current_mode_update`. |
| `git.changes` result | `ahead`, `dirty` | Row 1 of the primary-action table: uncommitted changes, or local commits not on origin. |
| `repo.clone` result | `remoteHeadSha` | 03: for `branch` and `pr` sources, `last_pushed_sha` is the remote head. On wake it also tells the DO that the branch was deleted on GitHub. |
| Workspace channel | `turn.deleted {turnId}` | `deleteQueuedTurn` and archive remove queued turns; `turn` cannot say a turn is gone. |
| Server functions | `listScriptRuns {workspaceId}` → runs with `logTail` | The Setup and Run tabs need history after a reload; the channel sends output only live. |
| HTTP | `GET /api/setup/status` → `{configured, installUrl}`, no auth | The sign-in page must know whether the GitHub App exists; the Add project dialog needs the install link. Both facts are public. |
| tempod | A second `hello` on an open socket updates branch, base branch and env | `setBaseBranch` and `renameBranch` change what tempod uses for checkpoints and changes. |
| `agent.exited` | `reason`: `crashed`, `evicted` (LRU close) or `cancelled` (killed after a cancel timeout) | 01 sends `agent.exited` only for an unexpected exit, but the DO must still learn that a planned exit ended the process, so the next prompt reloads the session. Only `crashed` makes a crash notice. |
| `repo.clone` params | `mode`: `create` or `wake` | On create, 03's checkout per source applies (`new` always branches from `origin/<baseBranch>`). On a fresh-disk wake, the branch is tracked from origin when it exists. |
| tempod | Full script logs at `$HOME/.tempod/logs/<runId>.log` | 01 says the DO writes the full log (up to 50 MiB) to R2 at exit. The DO reads this file with `Files` after `script.exited`. |

## Choices where the spec is silent

| Area | Choice |
| --- | --- |
| Monorepo | Bun workspaces with Turborepo (`turbo.json`), as requested. TypeScript 6.0.3: TypeScript 7 is the native compiler, and some tools still need the JS API. |
| Server functions | Each function returns its `Result` envelope as JSON text. TanStack Start's serializability check rejects the `unknown` fields that ACP data carries. The client helper `call()` parses and unwraps it. |
| DO RPC | Every WorkspaceDO method returns a `Result` envelope, because a thrown error loses its code across RPC. The methods are generated into `methods.gen.ts` (Workers RPC exposes prototype methods only). |
| Preview | The Worker hands preview requests to the DO with `stub.fetch()` and an internal header, because RPC cannot carry a WebSocket upgrade. `previewFetch` still exists as an RPC method. |
| Images in prompts | An image goes inline only up to 512 KiB, because tempod messages are capped at 1 MiB. Larger images go as a `resource_link` to the copied file. |
| Sleep op | The state becomes `stopping` only after `turns.check` passes. `stopping → ready` is not a legal transition, so a cancelled sleep must not leave `ready` first. |
| Archive | Queued turns are deleted with their `user_message` items (03: "delete queued turns"). |
| Revert | One `revert_marker` item per open session, so every chat tab shows the divider. |
| Setup | With no setup script, `setup_status` stays `none`. |
| Project settings | `updateProjectSettings` asks every live workspace of the project to run `settings.read` again. `setProjectSecret` and `deleteProjectSecret` send `env.set`. |
| Commit author | From `GET /user/{TEMPO_OWNER_GITHUB_ID}` with the installation token: name, else login; email `<id>+<login>@users.noreply.github.com` (03). |
| Seq numbers | tempod keeps one incarnation per database (01). On a hello whose incarnation differs, it sends `incarnation.changed` at seq 1 and renumbers pending events from 2. When the incarnation is one the DO saw before (a disk restored from an older snapshot), the DO deletes its stored events for that incarnation first, so the restarted seqs cannot collide with kept rows. |
| ACP client capabilities | 01 says `session.notices: true`; `@agentclientprotocol/sdk` 1.8.0 types it as an object, so tempod sends `notices: {}`. |
| File watcher | 01's exclude pattern is cut off in the table. tempod excludes `(^|/)(\.git|node_modules)(/|$)`. |
| Base image | `container/pin-base.ts` reads the digest from the Docker Hub registry API. Set `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` to avoid the anonymous rate limit. |

## Spec ambiguities found by the tests

The test agents found these. The code makes the choice shown; none contradicts an explicit rule.

| Spec | Ambiguity | Choice |
| --- | --- | --- |
| 01 TempoOutbound, rules 1 and 7 | An `http:` request that carries `tempo-placeholder`: rule 1 skips rules 2 to 7, but rule 7 says never forward the placeholder. | Rule 1 wins: plain HTTP goes to rules 8 to 10 and carries no credentials. The log records the rule that decided (8, 9 or 10). |
| 01 TempoOutbound, rule 2 | "Path starts with `/<owner>/<repo>`". | Whole path segments: `/acme/app2` does not match repo `app`. |
| 05 Egress control | Whether `*.example.com` matches `b.a.example.com`. | It does. |
| 01 Sessions | Review comments for a line range or a whole file. | `<path>:<start>-<end>: <text>` and `<path>:: <text>`. |
| 02 Item model, Status | Tool calls still open when a turn ends `completed`. | They keep the status the agent last sent. |
| 02 OpProgress | `WorkspaceDetail.op` and the always-pending housekeeping op. | Housekeeping is never shown. |
| 03 Step runner | Which errors are transient. | `NOTHING_TO_COMMIT`, `PUSH_REJECTED`, `CHECKPOINT_NOT_FOUND`, `UNKNOWN_OP`, `BRANCH_IN_USE`, `VALIDATION_FAILED` and `NOT_FOUND` end a step at once; everything else retries up to the step's limit. |
| 03 Step runner and Transitions | A restore that fails: "step fails for good → error", but `archived` cannot go to `error`. | The workspace stays archived and the UI gets an `error` message. A restore queued behind an archive that failed is cancelled. |
| 05 GitHub App setup | `/setup/*` returns 404 after setup, but GitHub's `setup_url` must keep working. | `/setup/github/installed` always redirects to the app. The manifest also sends `hook_attributes.url` (GitHub requires it) and cuts the name to 34 characters (GitHub's limit). |
| 02 Credentials | Whether `deleteCredential.key` is a provider name or a secret key. | Both are accepted. |
| 07 Server changes | 07 cites "02, Native client API", which does not exist. | `/api/v1` follows the table in 07. |

## Not built

| Item | Status |
| --- | --- |
| Tempo for Mac (07, Rust on GPUI Kit) | In scope (the owner approved it on 2026-10-11). Built after the server side of M0 in its own build loop: `crates/tempo-protocol`, `crates/tempo-client`, `crates/tempo-terminal`, `crates/protocol-gen`, `apps/mac`. The build machine runs Linux, so macOS-only parts (Keychain, notifications, Dock badge, URL scheme, signing, notarization) sit behind `cfg(target_os = "macos")` and cannot be run here; everything else compiles and is tested here. Rust is pinned to 1.97.0 in `rust-toolchain.toml`. |
| Spikes S1 to S16 (06, 07) | Not run. They need a Cloudflare account on Workers Paid and real Claude and Codex logins. Gate A is open. |
| Acceptance tests AT-1 to AT-37 | Not run, for the same reason. `tests/e2e` holds the plan. |
| Adapter conformance tests | `tests/conformance` holds the plan; they run inside the image. |
