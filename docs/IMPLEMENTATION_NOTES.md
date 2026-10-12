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

## Open questions for the owner

The spec disagrees with itself here, or the work needs a dependency only you can approve. The code makes the choice shown until you decide.

| # | Spec | Question | What the code does now |
| --- | --- | --- | --- |
| Q-1 (resolved 2026-10-11) | 03 Revert, Step runner | Owner requires a successful safety checkpoint before reverting. | Revert fails with `INTERNAL` after three failed safety-checkpoint attempts and leaves files and transcript intact. Other checkpoint operations remain best effort. 03 is updated. |
| Q-2 (resolved 2026-10-11) | 01 Container image | Orphaned agent and script processes need reaping. | Owner approved pinned `tini`. It runs as PID 1, forwards signals to `tempod`, and reaps orphaned children. 01 is updated. |
| Q-3 (resolved 2026-10-11) | 04 Design and front-end rules, 06 Definition of done | React component tests need a DOM library. | Owner approved pinned `happy-dom` and `@testing-library/react`. Component tests are being added alongside the existing Node logic tests. |

## Owner decisions (2026-10-12)

The owner answered Q-4 to Q-10. The spec now says:

| Question | Decision | Spec |
| --- | --- | --- |
| Q-4 Browser Run | Built: CDP through `TempoOutbound` rule 11 to `env.BROWSER`; the app under test through `outboundByHost` for `localhost`; Live View from `getBrowserLiveView`; `browser.run` setting, off by default, ignored under `allowlist`. Spike S17 checks the binding calls. | 01 Browser Run, 02, 04, 05, 06, 07 |
| Q-5 Errored workspaces | Any wake trigger restarts an errored workspace. | 03 Transitions |
| Q-6 Workspaces from a PR | Store `pr_number`, `pr_state` and the title at create; the top bar shows `#<number> ↗`. | 03 Create, 04 Top bar |
| Q-7 Project model | One default model per agent (`agent.models`). OpenCode and Pi need one: `MODEL_REQUIRED`. | 01 settings and Sessions, 02, 04 |
| Q-8 Unused statuses | Session `broken` and review-comment `resolved` are removed. | 02 |
| Q-9 Egress rows | Store 10,000; Diagnostics shows the newest 500 matches, filtered on the server. | 02 `getDiagnostics`, 05 |
| Q-10 Previews | Owner-only: no secret in the hostname; a one-time link from `openPreview` sets a `__Host-tempo_preview` cookie. Protected Quick Tunnels were rejected: containers can reach only ports 80 and 443 through `TempoOutbound`, and the tunnel needs port 7844. | 01, 02, 03, 04, 05, 06, 07 |

## ACP mode contract (resolved 2026-10-11)

The owner approved using ACP v1’s advertised mode config option directly. OpenCode 1.18.35 and the evaluated experimental `0.0.0-tui-v2-202606261840` snapshot both expose category `mode` through `configOptions`. Tempo derives its session `modes`/`modeId` from that option and uses `session/set_config_option`; agents exposing session modes use their advertised `session/set_mode` interface. Config updates and reloads refresh the normalized fields. The experimental snapshot provided no protocol advantage and was not adopted. No deployed-client compatibility shim or new dependency was introduced.

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
| HTTP | `GET /api/setup/status` → `AppSetupStatus {configured, installUrl}`, no auth | The sign-in page must know whether the GitHub App exists; the Add project dialog (web and Mac) needs the install link. Both facts are public. |
| tempod | A second `hello` on an open socket updates branch, base branch and env | `setBaseBranch` and `renameBranch` change what tempod uses for checkpoints and changes. |
| `agent.exited` | `reason`: `crashed`, `evicted` (LRU close) or `cancelled` (killed after a cancel timeout) | 01 sends `agent.exited` only for an unexpected exit, but the DO must still learn that a planned exit ended the process, so the next prompt reloads the session. Only `crashed` makes a crash notice. |
| `repo.clone` params | `mode`: `create` or `wake` | On create, 03's checkout per source applies (`new` always branches from `origin/<baseBranch>`; a `branch` or `pr` source missing on origin fails with `CLONE_FAILED`). On a fresh-disk wake, the branch is tracked from origin when it exists, else it branches from the base. A `repo.clone` with no `mode` behaves like `wake`. |
| tempod | Full script logs at `$HOME/.tempod/logs/<runId>.log` | 01 says the DO writes the full log (up to 50 MiB) to R2 at exit. The DO reads this file with `Files` after `script.exited`. |

## Choices where the spec is silent

| Area | Choice |
| --- | --- |
| Monorepo | Bun workspaces with Turborepo (`turbo.json`), as requested. TypeScript 6.0.3: TypeScript 7 is the native compiler, and some tools still need the JS API. |
| Server functions | Each function returns its `Result` envelope as JSON text. TanStack Start's serializability check rejects the `unknown` fields that ACP data carries. The client helper `call()` parses and unwraps it. |
| DO RPC | Every WorkspaceDO method returns a `Result` envelope, because a thrown error loses its code across RPC. The methods are generated into `methods.gen.ts` (Workers RPC exposes prototype methods only). |
| Preview | The Worker hands preview requests to the DO with `stub.fetch()` and an internal header carrying the port and the preview cookie value, because RPC cannot carry a WebSocket upgrade. `previewFetch` still exists as an RPC method. `previewEnter` is a plain RPC call. A request without the preview cookie gets the preview 404 page from the Worker without reaching the DO. |
| Preview `/__tempo/` paths | Any request under `/__tempo/` other than `GET /__tempo/enter` gets the preview 404 page. A code used on another port's host is refused and stays usable on its own port until it expires. |
| `preview_key` migration | `0003_preview_access` adds `preview_key` with `DEFAULT ''` (SQLite needs a default to add a `NOT NULL` column to a table with rows), fills each existing row with a fresh key from `crypto.getRandomValues`, and creates `preview_codes`. An empty or undecodable key never verifies. `preview_token` stays, unused, because 05 Upgrades forbids dropping a column; new rows store `''`. |
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
| tempod message size | Every message stays under 1 MiB (02). Inline images, audio and resource blobs over 256 KiB of base64 in agent content are saved to `/home/tempo/attachments/<turnId>/` and sent as a `resource_link`. Item content over 512 KiB has long strings cut with `[tempo: truncated]`. Large deltas are split into pieces of 128K characters. An event that still does not fit (over 1 MiB − 1 KiB) is replaced by a `log` warning. A response over 1 MiB becomes `FILE_TOO_LARGE` (`fs.read`, `git.fileDiff`) or `INTERNAL`. `fs.list`, `git.changes` and `git.changed` list only the files that fit (about 960 KiB); `git.changed` totals count all files. |
| tempod git deadlines | Each git op ends 2 to 15 s before its 02 timeout, and time spent waiting for the repo lock counts. The process group of a timed-out git command (hooks, `git-remote-https`) is killed, so the repo lock is always released. A git timeout returns `INTERNAL`, or `CLONE_FAILED` for `repo.clone`. |
| `repo.clone` retries | `.git/tempo-cloned` marks a finished clone. A repo without it is a partial clone: `/workspace` is emptied and cloned again. |
| Planned agent exits | `agent.exited` with `evicted` or `cancelled` is sent when tempod kills the adapter, before `turn.ended`, with `code` and `signal` null. A crashed adapter's whole process group is killed (SIGTERM, then SIGKILL). |
| Seq numbers, DO ahead of the disk | With a matching incarnation and `lastAckedSeq` above tempod's last seq, events queued since tempod started move to `lastAckedSeq + 1`; older pending rows count as delivered. The outbox handshake runs before `app.hello`. |
| Child env | Scripts, agents and git never see `TEMPOD_*` vars; tempod deletes `TEMPOD_TOKEN` from its own env after reading it. |
| stderr tail | `stderrTail` is the last 200 lines (2,000 chars each), dropping older lines if JSON escaping would take it over 512 KiB. |
| Browser storage | The theme preference is kept per browser in localStorage (`tempo:theme`); 04 lists no server field for Appearance. Panel layout is kept in `tempo:layout:panels`. |
| Tab title | Pages set no title of their own; the browser tab always reads `(<n>) Tempo`. |
| First-run step 3 | Any credential that lets an agent run counts, including Anthropic and OpenAI keys. |
| First-run step 5 | Archived workspaces count, so archiving every workspace does not bring the checklist back. |
| ⌥J | Opens the right side too when it is hidden, because the bottom panel lives in it. |
| Shortcuts in modals | While a modal dialog is open, only ⌘K runs. |
| Center tabs | One tab per file path and one Diff tab; the line or file is a parameter. Tabs are not kept across reloads. |
| Browser tab iframe | The preview iframe's `sandbox` leaves out `allow-top-navigation`, so a preview cannot navigate the Tempo page away. |
| UI hooks | `useWorkspace(id)` only reads. `useWorkspaceLifecycle(id)` runs once per shown workspace and calls `markViewed` while the view is visible and focused, and again when a turn ends then. `useReconnectRules()` runs app-wide and reconnects every socket when the browser comes back online or the tab is shown again. |
| `/device` copy | "Check that this code matches the one in Tempo for Mac.", "Tempo for Mac is signed in. You can close this tab.", "Sign-in denied. You can close this tab.", "That code is not valid. Check it and try again.", "That code has expired. Start again in Tempo for Mac.", "This code was already used." |
| `/login` copy | Not set up: "Tempo is not set up yet. Open the setup link that the deploy printed." Errors other than `forbidden` show the `INTERNAL` text. |
| Turn usage | `Turn.usage` is ACP v1 `PromptResponse.usage` for that turn (02). Non-finite or negative counts are dropped; a missing total, input or output count drops the whole value. The footer reads `<total> tokens (<input> in, <output> out)`; the context ring still uses `usage_update`. |
| Command palette | It runs every action with a shortcut that has a handler, including Stop, plan mode, next or previous file and Mark viewed. Send, New line and the permission keys stay out: they act on the focused field or card. |
| Phone Setup output | Phones have no bottom panel, so `View output` and `Open Setup tab` open a Setup pane with `Back to chat`. It has no bottom-navigation entry. |
| Shortcuts tab | Shows the Tempo and the Conductor column of the 04 table. |
| JSON columns | Every JSON column is decoded with Effect Schema on read (a bad value logs `warn` and uses a fallback) and checked on write (`INTERNAL`). Item content from `tempod` that fails its kind's schema keeps each field that still decodes; the others take the kind's empty value. |
| Reset preview access | `rotatePreviewKey` also deletes unused entry codes, so a link made before the reset cannot start a cookie. Open preview WebSocket relays close with code 1008. |
| Queued commit | `commitAndPush` waits behind pending ops; behind a sleep it returns `CONTAINER_NOT_READY`. |
| Container stop during create or wake | The op is cancelled and the workspace restarts through the unplanned-stop path, so it counts toward 3 restarts an hour. |
| `container.start` step timeout | 150 s, not 60 s: the health poll is 60 s, and the rest covers a failed snapshot start falling back to the image. Attempts stay at 3. |
| Channel backpressure (02, 4008) | Workers `WebSocket` has no `bufferedAmount`, so the 4 MiB check reads 0 and never closes a socket. A deployed check should confirm this; a different mechanism needs a spec change. |
| OAuth tokens (05, Secrets) | Better Auth's `account` rows never keep GitHub `access_token`, `refresh_token` or `id_token`: database hooks null them on create and update. Sign-in needs only the GitHub profile. |
| Better Auth logs | Its logger writes through `log()`, so the redact rule applies. |
| Worker invocation logs | Off (`observability.logs.invocation_logs: false`): they record request URLs, which hold preview entry codes and the setup token. Structured logs stay on. |
| Build id | The deploy sets one id, `<version>+<git sha>[.dirty]`, as the Worker's `TEMPO_VERSION` and inlines it into `tempod` (`TEMPO_BUILD_ID`), so the version warning in 05 fires only for different builds. |
| `setup_url` redirect | When the owner is signed in, `/setup/github/installed` syncs installations at once. Otherwise the Add project dialog syncs them after sign-in. |
| Attachment upload Origin | A cookie-authenticated upload must send `Origin: https://<APP_HOST>`. Bearer uploads send none. Reads stay Origin-free so `<img>` works. |
| Transcript thumbnails | PNG, JPEG, GIF and WebP load from the owner-only attachment route. The web uses this browser's upload preview first. The Mac app keeps at most 32 MiB of thumbnails in memory per transcript and never writes them to disk. |
| DO migration `0004_drop_unused_statuses` | SQLite cannot change a CHECK, so `sessions`, `turns` and `review_comments` are rebuilt (new table, copy, drop, rename, `turns_by_status` again). `turns` is rebuilt because DO SQLite enforces foreign keys and `sessions` cannot be dropped while `turns` refers to it. A stored `broken` becomes `closed` and `resolved` becomes `sent`, so old rows cannot fail the new CHECK; no code ever wrote either value. |
| Diagnostics egress filters | Both clients trim the host text and leave out an empty host and `all`. The count reads `<n> shown`, because the server returns only the matches. The web keeps the last rows on screen while a filtered request runs. |
| PR link | Only the desktop top bar shows `#<number> ↗`; the phone bar stays `branch → base`. |
| Browser Run idle check | The 60 s idle rule reads `connectionId`, `connectionStartTime` and `connectionEndTime` from `env.BROWSER.getSession`: connected means a `connectionId` and no `connectionEndTime` after the latest `connectionStartTime`. Spike S17 must confirm these fields. |
| Browser Run Live View with no page | `getBrowserLiveView` fails with `INTERNAL` ("The browser has no page yet.") if the session lists no `page` target. A new Browser Run session starts with an `about:blank` page, so this should not happen. |
| Live View tab | It calls `getBrowserLiveView` each time it mounts: on open, on Reload, and when the user switches back to it. It does not reload by itself when `browserActive` turns true again. On the Mac a null result shows an info toast `Browser session ended.` |
| Browser Run binding absent | Local dev and tests have no `BROWSER` binding; Browser Run is then off, as if `browser.run` were false. |
| Settings project pages | 04 lists the pages but not where `browser.run` goes. Both clients show the default agent, `agent.models` and Browser Run on the project's Agents page. |

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
| 01 Sessions, 03 turn.ended | `agent.exited` with reason `evicted` while a turn is still running. | The DO does not fail the turn on the exit event; the turn ends only with tempod's own `turn.ended`. Only `crashed` (or no reason) fails the turn with `AGENT_CRASHED`. |

## Not built

| Item | Status |
| --- | --- |
| Tempo for Mac (07, Rust on GPUI Kit) | In scope (the owner approved it on 2026-10-11). Built after the server side of M0 in its own build loop: `crates/tempo-protocol`, `crates/tempo-client`, `crates/tempo-terminal`, `crates/protocol-gen`, `apps/mac`. The build machine runs Linux, so macOS-only parts (Keychain, notifications, Dock badge, URL scheme, signing, notarization) sit behind `cfg(target_os = "macos")` and cannot be run here; everything else compiles and is tested here. Rust is pinned to 1.97.0 in `rust-toolchain.toml`. |
| Spikes S1 to S17 (06, 07) | Not run. They need a Cloudflare account on Workers Paid and real Claude and Codex logins. Gate A is open. |
| Acceptance tests AT-1 to AT-40 | Not run, for the same reason. `tests/e2e` holds the plan. |
| Adapter conformance tests | `tests/conformance` holds the plan; they run inside the image. |
| tempod tests in the image | Rule 14 says tempod tests run inside the container image. The build machine has no Docker, so `packages/tempod` tests run on the host; they need only the image's tools (git, rg, tmux, bash, coreutils). |
| Browser checks of the web UI | 04 asks for every shortcut to be tested in Chrome, Safari and Firefox on macOS. There is no browser on the build machine. |

## Tempo for Mac

The Mac build loop keeps these rows (07). The build machine is Linux x86_64, so macOS-only code sits behind `cfg(target_os = "macos")` with in-memory or no-op fallbacks.

### Spec changes to make (Mac)

| # | Spec | Finding | What the code does |
| --- | --- | --- | --- |
| M-1 | 07 Transcript, "No remote images" | Spike S11: GPUI uses an element's `ImageCache` only during layout and paint. `MessageScroller` rows and `TextView`'s inline images are laid out during prepaint, so a transcript-level `ImageCache` does not stop them from fetching through GPUI's global HTTP client. GPUI also fetches `data:` and `file:` URIs through that client. | GPUI starts with `image_policy::blocked_http_client()`, which refuses every request, and each transcript row is wrapped in an `ImageCache` whose `load` refuses every URI resource. Proposed 07 text: "Start GPUI with `http_client::BlockedHttpClient`, and wrap each transcript row in an `ImageCache` whose `load` refuses every URI resource." ACP `image` blocks still load from their inline data. |

### Open questions (Mac)

| # | Spec | Question | What the code does now |
| --- | --- | --- | --- |
| MQ-1 (resolved 2026-10-11) | 07 Updates | Owner approved an optional `latestMacClientSha256` in `ApiMeta`. | `/api/v1/meta` copies a valid lowercase SHA-256 from the same `latest.json` record as the version. TypeScript/Rust contracts and fixtures are regenerated. Mac clients must refuse an unverified download if the hash is absent. |

### Spike results (Mac)

| Spike | Status | Result |
| --- | --- | --- |
| S11 | Partly run (Linux) | `gpui-kit =0.7.1` builds, lints and tests with Rust 1.97.0 (07 asks for 1.92 or later; the highest `rust-version` in the tree is 1.92). `TextView::markdown` renders raw HTML, blocks and inline tags, so 07's fallback applies (M-2). An `ImageCache` alone does not block remote images (M-1). The 10,000-row example is `apps/mac/examples/s11_transcript.rs`; frame time p99 on an M1 is not measured (no Mac). Linux needs `libxkbcommon-dev` and `libxkbcommon-x11-dev`. See `spikes/S11.md`. |
| S13 | Feasibility checked | `gpui-terminal` 0.1.0 depends on `gpui` 0.2.2, not the GPUI that `gpui-kit` 0.7.1 bundles, so the fork in C8 is required. A scratch port hit 2 one-line API changes (`ShapedLine::paint` takes `TextAlign` and an align width; `Window::focus` takes `cx`) and then type-checked. Selection, clipboard and wheel scrollback are TODOs in the crate. See `spikes/S13.md`. |
| S16 | Done (Linux) | Every wire type becomes Rust. Two hand-written types, `Item` and `Empty` (M-5). See `spikes/S16.md`. |
| S12, S14, S15 | Not run | They need a deployed Tempo, a Mac and (S15) a Developer ID. |

### Choices where 07 is silent (Mac)

| # | Area | Choice |
| --- | --- | --- |
| M-2 | Raw HTML (05, 07 Transcript) | `markdown::escape_raw_html` turns `<` into `&lt;` outside code before text reaches `TextView::markdown`. It is conservative: where block structure is ambiguous, and in indented code blocks, `&lt;` can show inside code. |
| M-3 | Schema layout (`bun run protocol:gen`) | One Draft-07 file per wire type, `packages/protocol/schema/<Type>.json`, referencing others as `{"$ref": "<Type>.json"}`, plus `Api.json` with every function (method, input, output). 178 types and 59 functions. tempod's own protocol is left out: the Mac app never sees it. |
| M-4 | Fixture layout (`bun run protocol:fixtures`) | `fixtures/types/<Type>.jsonl` (one valid sample per line) and `fixtures/channel/<session>.jsonl` with `<session>.expected.json`. The expected end state comes from the web stores in `apps/tempo/src/ui/stores`. `bun run --cwd packages/protocol protocol:check` re-runs both generators and fails on any diff. |
| M-5 | Rust wire types | Effect's JSON Schema describes the JSON codec, not the plain schema: optional fields come out nullable, `Schema.Number` also allows `"Infinity"`, `"-Infinity"` and `"NaN"`, `Struct({})` comes out as `not: null`, regex patterns are dropped and string lengths are counted in code points. `crates/protocol-gen` corrects the first three before typify (each rule is unit-tested) and drops `additionalProperties: true`. `Item` is hand-written so the seven shared fields sit on one struct; `Empty` is hand-written because typify panics on `not`. |
| M-6 | Generated Rust shapes | Every `Schema.Number` is `f64`. Fields are snake_case with `serde(rename)`. Channel unions are untagged enums: `WorkspaceServerMessage::Hello` … `Pong` and `HubServerMessage::HubHello`, `HubWorkspace`, `HubWorkspaceRemoved`, `WsPong`. Unknown fields are ignored, so additive fields decode; an unknown message type fails to decode and is dropped, as in the web store. Functions are called through `tempo_protocol::Function` (`api::SendPrompt` and so on). |
| M-7 | Composer and terminal keys | Enter, Esc and ⇧Tab are bound on `Composer > Input`, so they outrank GPUI Kit's own `Input` bindings. Stop the turn also has ⌘⇧⌫ in `Workspace` (Conductor column). The `Terminal` context unbinds tab, ⇧Tab, ⌃Tab, ⌃⇧Tab and ⌃O so they reach the shell. Permission Enter and ⌫ are handled by the focused card. The Changes list's ↓ and ↑ use the `Diff` context. |
| M-8 | Links and `tempo://` | `file:///workspace/` links with `..`, `.` or empty segments are ignored. A `tempo://workspace/<id>` id must be 1 to 64 ASCII letters or digits; an unknown id shows `Not found.` as for close code 4404. |
| M-9 | Dependencies | Pinned in each crate: `gpui-kit =0.7.1`, `async-channel =2.5.0`, `serde =1.0.229`, `serde_json =1.0.154`. `crates/protocol-gen` (a build tool, not shipped) uses `typify =0.8.0` (the newest stable release; 0.10.0-alpha.2 exists), `schemars =0.8.22`, `syn =3.0.8` and `prettyplease =0.3.0`, which typify's output needs. |

### Mac status (2026-10-12)

Every 07 area has code; nothing renders a stub. What remains is acceptance on a Mac, not missing views.

| Item | Status |
| --- | --- |
| `crates/tempo-client` | Runtime, RPC, channels, reconnect, device flow, stores, attachment upload and read, setup status and verified downloads. |
| `crates/tempo-terminal` | The `gpui-terminal` fork on the remote terminal channel, with selection, copy, scrollback and resize. |
| Views | Sidebar with 04 indicators and hover card; top bar with the base-branch picker; chat, transcript with thumbnails, composer, queue and steering; state banners and the op checklist; Changes, Diff, Files, Checks; Setup, Run, Terminal; New workspace, Add project, History, command palette, Diagnostics and Settings (typed Project fields). |
| macOS integration | Menus, key bindings, Keychain, notifications, Dock badge, URL scheme, wake reconnect and window restore. Needs a signed bundle to verify. |
| Copy left to the app | "Tempo is up to date." (Check for Updates with nothing newer), the macOS notification-permission texts and the toggle label "macOS notifications". Hover times are relative ("5 min ago"); the app has no local time-zone helper yet. |
| Tests | 194 `tempo-mac` tests (headless GPUI views included) and the `tempo-client`, `tempo-terminal` and protocol suites pass on Linux. Real Keychain, notifications, signing, rendering performance and Gate E stay open. |

## Continuation verification (2026-10-11)

The continuation runs on macOS. Native tests and Clippy now compile the macOS-specific modules; this does not prove manual UI, Keychain, notification, signing or hosted API behavior. The earlier Linux-only notes above describe the original build environment.

`bun run test:tempod:container` builds the pinned full workspace image, derives `container/Dockerfile.test`, and runs daemon tests as uid 1000. It uses the build arguments from `container/versions.json`. The new main/manual workflow runs the same command. Local image validation passes on the shared Colima engine: 112 tests, including uid/gid, PID 1, adapter/tool presence and orphan cleanup. Production image size is 1,715,652,650 bytes. The earlier host-only daemon-test limitation is closed.

The native continuation implements 07's existing sign-in contract: server/version check, browser device approval, Keychain save, later-launch session validation, 401 cleanup and server sign-out. The hub uses the shared Rust apply rules and project/sort data for the sidebar; resetting auth closes its channel and clears its Dock count. Existing static transcript spike windows still run without a live AppState. The required-update screen is present; authenticated DMG download is not yet connected.

The next native milestone wires workspace channels and cached chat views to the same apply rules used by `tempo-client`. Reconnect and hidden-store tests share the web channel fixtures. Composer drafts survive failed sends; queue editing uses a separate field so it does not replace the unsent draft. Queue reordering sends every queued turn in the workspace, including other chats. Headless view tests use loopback RPC fixtures; rendered pixel quality and authenticated agent behavior still need acceptance.

The owner requested both queueing and live steering, and selected delivery during the active turn where supported. Specs 01–04 and 07 now define the ACP v1 steering extension, optional send delivery, capability/progress flags and the durable `turns.steering_pending` reservation. Unsupported or settled delivery stays queued. An ambiguous acknowledgement or interrupted reservation becomes a failed turn with an explicit check-before-retry message. No new library or adapter version was added. Primary reference: [Claude ACP steering example](https://github.com/agentclientprotocol/claude-agent-acp/blob/main/examples/steering.ts). Real logged-in adapter conformance remains open.


## Native implementation continuation (cloud, 2026-10-11)

The owner requested implementation in the cloud and elected to perform native testing locally. The existing chat/channel foundation remains in use. Review/files/diff/comments, scripts/remote terminal, settings/diagnostics and shell actions are now connected to that foundation. Native file I/O, Keychain operations, diff parsing and fuzzy matching run off the main thread. No new library or version was added: the app now uses the existing terminal crate and its tests enable the existing pinned GPUI Kit test-support feature.

The terminal implementation retains `gpui-terminal` 0.1.0 attribution/licenses and the pinned Alacritty parser. Its transport is the remote terminal channel, with selection, clipboard, query replies, resize/reconnect dimensions, synchronized updates, ANSI colors and scrollback. The earlier table describing terminal source as a stub is historical. Linux tests do not establish native terminal acceptance.

Release tooling now defaults to `--adhoc`. `--release` requires authorized Developer ID/notary credentials and verifies a signed/stapled DMG without publishing. `--publish` additionally uploads, reads the DMG back and compares it before writing `latest.json` last. Signed modes require an existing published manifest; first-release bootstrap remains an owner/core release preparation step. No signing or publication was run here.

### Exact shared-contract dependencies

- **MQ-1 resolved and consumed:** the final task branch imports published core/web integration through `5e259d6`. Core's generated `ApiMeta.latestMacClientSha256` is bound to `latestMacClient` from the same R2 manifest. Native Download now uses that exact contract: bearer HTTP, a 1 GiB hard bound, declared transfer-size checks, SHA-256 verification before atomic save and macOS system opening. Missing/invalid hashes, incompatible/stale release versions, corrupted bytes and oversized downloads fail closed. The existing exact-size helper remains available for trusted manifest-size callers. Normal and required-update screens share this flow.
- **First-launch required-update authentication:** a valid saved Keychain session is validated and retained for Download while normal channels stay closed. With no saved token, 07 stops device sign-in before the owner-only download can authenticate; the screen explains manual installation from the owner's browser. A future native authorization path in this state requires a core/spec policy decision. No unauthenticated download route or weakened integrity check was added.
- **Attachment thumbnails:** consumed. `GET /api/workspaces/<workspaceId>/attachments/<attachmentId>` (02) feeds transcript thumbnails in both clients.
- **Display metadata:** `Turn.usage` and `prTitle` exist and both clients show them. `CheckRun` still has no start, completion or duration fields; 04 does not ask for them.
- **Privacy wording:** 07 explicitly permits composer drafts in `state.json`, while AT-37 literally forbids any prompt text outside Keychain. The implementation follows the storage table: unsent drafts may persist, tokens remain in Keychain and transcripts/attachment bodies do not persist. The local audit must distinguish this specified draft storage from leaks and record the unresolved wording.

The project settings fallback is a native resource copied from shared `DEFAULT_SETTINGS`; the final verification compares it to the canonical TypeScript value. Without an open workspace the UI labels file-derived settings as unavailable until a workspace opens, rather than inventing source information.

Validation and the per-acceptance local checklist accompany the implementation. No claim is made for hosted agent behavior, rendering performance, macOS Keychain/notifications, signing, notarization or Gate E.
## Core deployment continuation

The current follow-up adds `WorkspaceDetail.prTitle` and `refreshPullRequest.prTitle`, persisted by the WorkspaceDO for any PR state, and owner-authenticated attachment reads at the route documented in 02. `Attachment` metadata is shared in TypeScript/Rust and fixtures. Active formats download as binary; raster previews use private/no-store responses. ACP v1 and OpenCode 1.18.35 stay pinned. Turn token accounting now uses ACP v1 `PromptResponse.usage` per turn (`Turn.usage`, 02); the session context ring remains unchanged.

Alchemy beta.81 imports its optional `@effect/platform-node` peer while loading Cloudflare providers; the existing Effect stack now pins that peer at 4.0.3. A preflight wrapper prevents unavailable existing state-store probes from entering automatic bootstrap. See the deployment guide and CORE-RESULTS.md for the actual failed attempt and state-store recovery requirement.

The native PR imports this core follow-up for compatibility. Both clients now consume the attachment-read route and `prTitle`.
