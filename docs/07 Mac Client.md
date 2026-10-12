# 07 Mac Client

This tab plans a native macOS client for Tempo, built with GPUI Kit. It talks to the same Worker as the web UI.

## Summary and decisions

Tempo for Mac is a native macOS app for the same Tempo deployment. It does the same work as the web UI: it lists workspaces, streams agents, reviews diffs and ships pull requests. It keeps no workspace state of its own. The Worker and the Durable Objects stay the source of truth, and the web UI keeps working next to it.

The Mac app is a client of the cloud Tempo only. It does not run workspaces on the Mac (open question Q6).

| # | Decision | Choice | Reason |
| --- | --- | --- | --- |
| C1 | UI framework | GPUI Kit, `gpui-kit = "=0.7.1"` (Longbridge, Apache-2.0), which bundles GPUI | Native and GPU-drawn, 75+ components, in production at Longbridge |
| C2 | Role | Thin client. The client keeps only layout, drafts and its token. | One source of truth; the web UI and the Mac app can be open at once |
| C3 | API | A JSON API at `/api/v1/rpc/<function>` with the same functions, schemas and errors as the server functions in 02, plus the same three WebSocket channels | TanStack Start server-function URLs are internal and change between builds |
| C4 | Sign-in | Better Auth device authorization (RFC 8628) plus the bearer plugin. The token lives in the macOS Keychain. | No secret ships in the app; the owner can revoke it from the web |
| C5 | Wire types | Rust types generated from `packages/protocol` (Effect Schema to JSON Schema to `typify`), checked against shared fixtures | One definition of every message |
| C6 | Networking | One tokio runtime on background threads: `reqwest` for HTTP, `tokio-tungstenite` for WebSockets. The GPUI main thread does no I/O. | GPUI's executors are not tokio; the UI thread stays free |
| C7 | Previews | Open in the default browser. No in-app Browser tab in this version. | GPUI Kit's WebView (`gpui-wry`) is experimental and draws over popovers, dialogs and menus |
| C8 | Terminal | `crates/tempo-terminal`: a fork of `gpui-terminal` 0.1.0 (MIT or Apache-2.0) on `alacritty_terminal` 0.25.1, ported to GPUI Kit's GPUI | GPUI Kit has no terminal; `gpui-terminal` targets a different GPUI release |
| C9 | Platform | macOS 15 or later, Apple silicon (arm64) only | GPUI Kit needs macOS 15; one architecture halves the test matrix |
| C10 | Shortcuts | Conductor's ⌘ bindings: the Conductor column of the shortcut table in 04 | No browser reserves keys in a native app |
| C11 | Distribution | Signed with the owner's Developer ID, notarized, and served as a DMG by the owner's own Tempo (R2). The app checks for updates; the owner installs them. | Self-hosted end to end; no third-party update service |

**License rule.** GPUI, GPUI Kit, `gpui-terminal` and `alacritty_terminal` are Apache-2.0 or MIT. Zed's editor crates (for example `terminal_view` and `editor`) are GPL-3.0. MUST NOT copy code from them.

## Scope

The Mac app does what the web UI does, with the same names, copy and rules as 04. Pending prompt submissions keep their per-session guard across tab switches; repeated Enter or Send keeps the next draft without sending it again. This table lists every area and says where the Mac app differs.

| Web UI area (04) | Mac app | Notes |
| --- | --- | --- |
| Sidebar, hover card, right-click menu, History | Same |  |
| New workspace dialog | Same | Prompt-focused composer, new branch by default, workspace options in a secondary menu, models from `listModels`; creating automatically makes the first chat. First prompt is text only. |
| Chat tabs, transcript, composer, queue, Stop | Same |  |
| Send now (live steering) | Same | Show only for a running chat whose adapter advertises steering. Enter still queues. |
| Permission cards, plan mode, model and mode pickers | Same |  |
| Attachments, @-mentions, `/` commands | Same | Also accepts files dragged from Finder |
| Changes, Diff, review comments, Mark as viewed | Same | `DiffView` is custom (below) |
| All files and read-only file tabs | Same | Uses GPUI Kit `Editor` in read-only mode. Sleeping reads use the DO cache, show the last-synced notice, and offer an explicit wake on a cache miss. |
| Checks | Same |  |
| Setup, Run and Terminal tabs | Same |  |
| Previews | Different | Open in the default browser; no Browser tab |
| Commit and push, PR, merge, archive, restore, delete | Same |  |
| Command palette | Same |  |
| Environment… dialog and environment proposal review | Same |  |
| Settings: General, Logins, Environments, MCP servers, Project, Appearance, Shortcuts | Same | Codex uses the same start/poll/cancel device-login RPCs and opens the verification page in the default browser. Notifications are macOS notifications |
| Settings: Devices | Web only | The owner revokes Mac sign-ins from the web |
| First-run setup (GitHub App) | Web only | The Mac app needs a Tempo that is already set up |
| Device approval page `/device` | Web only | Part of Mac sign-in |
| Diagnostics | Same |  |
| Browser notifications and the tab-title count | Replaced | macOS notifications and the Dock badge |
| Phone width | Not applicable |  |

"Same" means the same behavior, names and copy as 04. When 04 changes, the Mac app changes in the same phase (06, AGENTS.md rule 17).

## Architecture

The Mac app is one Rust binary. It talks only to the Tempo Worker, over HTTPS and WebSockets, with the same contracts as the web UI.

```text
apps/mac/                   crate tempo-mac, binary "Tempo"
  src/main.rs               start the tokio runtime, then GPUI: init, menus, key bindings, main window
  src/app.rs                AppState entity: server URL, auth state, HubStore, open workspaces
  src/stores/hub.rs         HubStore entity: the sidebar, fed by the hub channel
  src/stores/workspace.rs   WorkspaceStore entity: one per open workspace, fed by its channel
  src/views/                sidebar, top_bar, chat, composer, changes, diff, files, checks,
                            setup, run, terminal, dialogs, settings, palette, tokens.rs
  src/macos/                Keychain, notifications, Dock badge, URL scheme, wake events.
                            The only module with unsafe code.
  resources/                Info.plist, Tempo.entitlements, AppIcon.icns
crates/
  tempo-protocol/           generated serde types for every wire type in packages/protocol
  tempo-client/             tokio runtime, RPC client, channel clients, reconnect, device sign-in
  tempo-terminal/           terminal element, forked from gpui-terminal
```

**Threads**

| Thread | Runs | MUST NOT |
| --- | --- | --- |
| GPUI main thread | Views, entities, input, drawing | Block, do network or file I/O, or wait on a lock |
| GPUI background executor | CPU work: diff parsing, fuzzy file search, large Markdown | Network I/O |
| tokio runtime, 2 worker threads | All HTTP and WebSocket I/O, owned by `tempo_client::Runtime` | Touch GPUI entities |

**Data flow**

1. `main` starts `tempo_client::Runtime` before `application()`. It lives until the app quits.
2. A store asks the runtime to open a channel. The runtime returns a bounded receiver (`async_channel`, capacity 1024) of decoded channel messages.
3. A foreground task (`cx.spawn`) owned by the store reads the receiver and applies each message with `WeakEntity::update`. When the store is dropped, the task ends and the runtime closes the socket.
4. An RPC call, for example `client.call::<SendPromptIn, Turn>("sendPrompt", input)`, runs on tokio and returns a future that resolves through a `tokio::sync::oneshot`. Views await it inside `cx.spawn`; the oneshot receiver works on any executor.
5. When a receiver is full, the runtime stops reading that socket until the store catches up. It never drops a message. If the server then closes the socket with 4008, the client reconnects with its `sinceRev`.

## Server changes for native clients

The Worker gets a small JSON API, bearer-token sign-in and a download route. The exact contracts are in 02, 04 and 05; this is the list.

| Change | Where it is specified | Summary |
| --- | --- | --- |
| `POST /api/v1/rpc/<function>` | 02, Native client API | Same functions, inputs, outputs and errors as the server functions |
| `GET /api/v1/meta` | 02, Native client API | `{protocol, serverVersion, minMacClient, latestMacClient, latestMacClientSha256?}`, no auth |
| Bearer and device plugins | 05, Authentication | Better Auth `bearer()` and `deviceAuthorization()`; `/api/v1` accepts only bearer tokens |
| WebSocket auth | 02, Hub and terminal channels | Upgrades also accept `Authorization: Bearer` with no `Origin` header |
| `/device` page | 04, Dialogs | Where the owner approves a Mac sign-in |
| Settings: Devices | 04, Settings | Lists sign-in sessions, with Revoke |
| Mac downloads | 02, R2 layout | `clients/mac/` in R2, served at `GET /downloads/mac/<version>`, owner only |
| Shared types | 06, Repo layout | `bun run protocol:gen` writes the JSON Schema and the Rust types |

**One handler per function.** Each function in 02 is written once in `apps/tempo/src/server/`. `createServerFn` wraps it for the web UI, and the `/api/v1/rpc` route wraps it for the Mac app. Both wrappers run the same auth middleware and the same schema decode. MUST NOT put logic in either wrapper.

## Sign-in and first run

The Mac app signs in with a short code that the owner approves in the browser. It never sees the GitHub login.

**First run**

1. Show **Connect to Tempo** with one field, the Tempo URL, for example `https://tempo.example.com`.
2. Call `GET /api/v1/meta`. If the call fails, or `protocol` is not `1`, show `This is not a Tempo server, or it runs a different version.` If the app version is below `minMacClient`, show the update screen (Build, signing, distribution and updates) and stop.
3. Call `POST /api/auth/device/code` with `{client_id: "tempo-mac"}`.
4. Show the `user_code` in large monospace type and an **Open browser** button. Open `verification_uri_complete` in the default browser once, at once.
5. In the browser, the owner signs in with GitHub if needed, sees the same code on `/device`, and clicks **Approve**.
6. Poll `POST /api/auth/device/token` with `{grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code, client_id: "tempo-mac"}`, every `interval` seconds. On `authorization_pending`, keep polling. On `slow_down`, add 5 s to the interval. On `access_denied` or `expired_token`, go back to step 1 and show `Sign-in was denied or timed out.`
7. On success, store `access_token` in the Keychain (Local storage, below). It is a Better Auth session token. Open the main window.

**Later launches.** Read the token from the Keychain and call `GET /api/auth/get-session` with it. A `null` session means the token was revoked or expired: delete it and show **Connect to Tempo** with the URL filled in.

**Any 401** from `/api/v1` or a channel upgrade: close every channel, delete the token, and show **Connect to Tempo**. Drafts and layout stay.

**Sign out** (Tempo menu): call `POST /api/auth/sign-out` with the token, delete the token even if the call fails, and show **Connect to Tempo**.

## Live state and reconnects

The Mac stores apply the same messages with the same rules as the web stores (02, Workspace channel). Shared fixtures prove it (Testing, below).

- **HubStore** opens `/api/ws/hub` after sign-in and keeps it open while the app runs. It keeps one `WorkspaceSummary` per id and ignores any summary whose `rev` is not newer.
- **WorkspaceStore** opens `/api/ws/workspace/<workspaceId>?sinceRev=<n>` when a workspace is shown. It closes the socket 60 s after the workspace is no longer shown. The store keeps its items in memory until it is evicted, so a reopen sends its highest `itemsRev` as `n`; a new store sends `0`.
- At most 5 WorkspaceStores stay in memory. Evict the one shown least recently: close its socket and free its items.
- **Apply rules** (02): the backlog comes as `items` pages of 500 until `done: true`; after the backlog, drop any message whose `itemsRev` is lower than the store's; `item.delta` appends text to its item and remeasures only that row.
- **Every channel request** sends `Authorization: Bearer <token>`, `X-Tempo-Client: mac/<version>` and no `Origin` header.
- **Reconnect:** 0.5 s, then double up to 10 s, with 20% jitter. On wake from sleep (`NSWorkspaceDidWakeNotification`), reconnect every channel at once. Send `{"type":"ping"}` every 30 s; with no `pong` in 10 s, close and reconnect.
- **Close codes:** 4001 (replaced) means do not reconnect that socket. 4008 means reconnect with `sinceRev`. 4400 means show the update screen and stop. 4404 means close the workspace and show `Not found.`
- A socket down for more than 2 s shows the `Reconnecting…` bar from 04.

## Window layout and components

The Mac shell uses a 13 pt base size, matching the dense web shell. Sidebar actions, the Projects header, the scrolling project list and the fixed History/Settings footer follow 04, including empty, loading and error states. The sidebar uses the theme sidebar surface; project headers and workspace rows have distinct type weight and spacing. With no workspace selected, the center offers New workspace and Add project. Review controls are compact, the empty changes list fills the available space, and the commit form sits in a padded, bordered footer. Process controls use consistent padding and spacing.

The main window has the five regions of 04. Each region uses the GPUI Kit components below. Where no component fits, Tempo builds its own, marked **custom**.

| Region (04) | GPUI Kit components |
| --- | --- |
| Window frame | `Root`, `TitleBar` with the native traffic lights |
| Panes | `Resizable` for sidebar, center and right side; sizes saved in `state.json` |
| Sidebar | `Sidebar`; rows are custom; `HoverCard`; `Menu` for the right-click menu; `Badge` for the PR; `Spinner` |
| Top bar | `Toolbar`; `Button` for the primary action; `DropdownButton` and `Menu` for the overflow menu; `Badge`; `Tooltip` |
| Center tabs | `Tabs` |
| Transcript | `MessageScroller`; `TextView::markdown` for messages; `Collapsible` for work rows, thoughts, tool calls and handoff |
| Composer | `Textarea` (grows from 3 to 12 rows); `Select` for model and mode; `Attachment`; `Command` for `/`; `Popover` with `List` for `@` |
| Changes, Checks | `VirtualList`, `Badge`, `Tag` |
| All files | `Tree` |
| File tab | `Editor`, read-only, with syntax highlighting |
| Diff tab | **custom** `DiffView` (Changes, diff view and review comments) |
| Setup and Run output | **custom** log view on `VirtualList`, monospace |
| Terminal | **custom**, from `tempo-terminal` |
| Dialogs | `Dialog`, `AlertDialog`, `Form`, `Input`, `Select`, `Checkbox` |
| Command palette | `Command` |
| Toasts | `Notification` |
| Settings | Its own window with left sidebar navigation for Personal and Project sections, matching 04 |
| Loading | `Skeleton`, `Spinner` |
| Shortcut hints | `Kbd` |

**Rules**

- Themes: GPUI Kit `Default Light` and `Default Dark`. Follow the macOS appearance unless Settings → Appearance says otherwise.
- Read every color through `cx.theme()`. Map the tokens of 04 (`--primary`, `--destructive`, `--warning`, `--muted-foreground`) to `ThemeColor` fields once, in `src/views/tokens.rs`. No color values in views.
- Every custom control sets an element id, an `a11y_role()` and an `.aria_label(...)`, so AccessKit can expose it.
- Minimum window size: 900 × 600 pt. Below 1,100 pt wide, the right side collapses behind its toggle.

## Transcript, composer and permissions

Behavior follows 04, Center. These rules are for the Mac app only.

Tool calls use a borderless disclosure with indented content. Tool text renders as Markdown; unfenced execute output preserves literal lines in a code block, matching 04.

- **No raw HTML (05).** Render agent text with `TextView::markdown`. MUST NOT render raw HTML. If spike S11 shows that `TextView` renders HTML blocks, escape `<` outside code before the text reaches it.
- **No remote images (05).** Wrap the transcript in an `ImageCache` whose `load` refuses `http://` and `https://` URIs, and show those images as links. Images from ACP `image` blocks load from their inline data.
- **Links.** Install `on_link_click`. Open `http` and `https` URLs in the default browser. A `file:///workspace/<path>` link opens a file tab at that path. Ignore every other scheme.
- **Streaming.** On `item.delta`, append the text to the item and call `remeasure_items` for that row only.
- **Work rows.** Group, label and count items exactly as 04, Work row, Work types and Tool call labels, with the same Default and Detailed detail. Put the rules in `src/views/chat_model.rs` so they are tested without a window.
- **Scrolling.** `MessageScroller` follows the newest row. When the reader scrolls up, it shows its jump-to-latest control on an opaque background, as 04. Each chat tab keeps its own scroll position.
- **Sleeping and the right side.** Follow 04, Empty states (`sleeping`) and Right and bottom panels: no sleeping banner, the top bar pill wakes, and the right side starts closed while the workspace sleeps or has no changes and no PR.
- **Composer appearance.** The text field and toolbar share the rounded container from 04, using the native theme background. The field grows from 3 to 12 rows without a separate border; the toolbar aligns attachment and send controls to the right and shows the native ⌘L focus hint.
- **Composer keys.** Enter sends, ⇧Enter adds a line, Esc stops the turn, ⇧Tab toggles plan mode, as in 04.
- **Slash commands.** Use `Command` with the agent's reported commands and Tempo's `/plan`. An inner `ComposerPicker` key context gives its selection keys priority over composer keys. Choosing an agent command inserts its name and keeps the text after the caret; choosing `/plan` changes mode without sending a prompt.
- **File mentions.** `@` opens a `Popover` with a fuzzy `List` from `listFiles`. Show loading, empty and error states, with Retry after a failure. Up and Down choose a file, Enter adds its mention chip, and Esc dismisses the picker. Keep text after the caret. Queue and Send now include the same mentions; a failed send keeps the draft and chips.
- **Attachments.** Paste an image, drag files from Finder, or press ⌘U. Each file is at most 10 MiB and is sent to `POST /api/workspaces/<workspaceId>/attachments` with the bearer token.
- **Permissions.** A new card takes focus if the composer is empty. Enter picks the first `allow` option; ⌫ picks the first `reject` option.
- **Copy.** ⌘C copies selected text. Each code block has a copy button.

## Changes, diff view and review comments

The Changes tab and review comments work as in 04 and use the same functions in 02. GPUI Kit has no diff component, so `DiffView` is custom.

- **Input:** the unified diff from `getFileDiff`. Parse it on the background executor into hunks and lines, each with its old and new line number.
- **Drawing:** one `VirtualList` row per line, two line-number gutters (old, new), added and removed lines on the theme's success and destructive tints, and a separator row for each hunk header.
- **Views:** unified and split, kept in `state.json`. Unified only when the window is below 1,024 pt wide, as 04.
- **Highlighting:** none in diffs in this version. File tabs have it.
- **Comments:** click a line number, or drag across several, to add a draft comment with `addReviewComment`. A file-level comment button sits in each file header. `Send <n> comments to <agent>` puts them into the composer as one chip, as 04.
- **Keys:** ↓ and ↑ (Conductor column of 04) move to the next and previous file when focus is in the Changes list. ⌃V marks the file viewed; viewed marks live in `state.json` with the file's diff hash.
- **Large files:** above 20,000 diff lines in one file, show `This diff is too large to show.` and an **Open file** button.

## Terminal, scripts and previews

**Terminal**

- `crates/tempo-terminal` forks `gpui-terminal` 0.1.0 and ports it to the GPUI that `gpui-kit` 0.7.1 bundles. Keep its license file and headers. It uses `alacritty_terminal = "=0.25.1"` for parsing and the grid.
- It reads bytes from the terminal channel (02) instead of a local PTY. Received frames feed the parser; keystrokes and resizes go out on the same socket, as defined in 01, Terminal.
- Scrollback: 10,000 lines. Mouse selection and ⌘C copy are required; `gpui-terminal` lists selection as planned, so Tempo adds it.
- Tabs `t1` to `t9` and the `+` button as in 04. A reconnect attaches to the same tmux session, so tmux restores the screen.
- In the `Terminal` key context, only ⌘ shortcuts leave the terminal. Every other key goes to the shell.

**Setup and Run.** Same as 04: output from `script.output`, Start and Stop, and ⌘R to start or stop the default run script.

**Previews.** Each detected port shows as `<port> ↗` in the top bar. A click calls `openPreview` and opens the returned link in the default browser. There is no in-app Browser tab in this version (C7). Reset preview access works as in 04. When `browserActive` is true, `Live` calls `getBrowserLiveView` and opens the URL in the default browser. A PR link `#<number> ↗` shows as in 04. Agents still test in Chromium inside the container (01), so browser testing does not change.

## macOS integration

**Menus.** Set with GPUI's app menus. Every item is a GPUI action, so the menu item, the command palette entry and the shortcut run one handler.

| Menu | Items (shortcut) |
| --- | --- |
| Tempo | About Tempo; Check for Updates…; Settings… (⌘,); Sign Out; Hide Tempo (⌘H); Quit Tempo (⌘Q) |
| File | New Workspace (⌘N); New Chat (⌘T); Close Tab (⌘W); Open File (⌘P) |
| Edit | Undo, Redo, Cut, Copy, Paste, Select All (standard keys); Search Files (⌘⇧F) |
| View | Command Palette (⌘K); Toggle Sidebar (⌘B); Toggle Right Side (⌘⌥B); Toggle Bottom Panel (⌘J); Diff (⌘⇧D) |
| Workspace | Commit and Push (⌘⇧Y); Create PR (⌘⇧P); Merge (⌘⇧M); Archive (⌘⇧A); Start or Stop Run (⌘R); Next Workspace That Needs You (⌘⌥L) |
| Window | Minimize (⌘M); Zoom; Workspace 1 to 9 (⌘1 to ⌘9) |
| Help | Open Tempo in Browser |

**Shortcuts.** Every action uses the Conductor column of the shortcut table in 04. Bind them with GPUI key bindings in four key contexts: `Workspace`, `Composer`, `Diff` and `Terminal`. Spike S11 confirms the binding and menu APIs in GPUI Kit 0.7.1.

**Notifications.** Use `UNUserNotificationCenter` through the `objc2-user-notifications` crate. Ask for permission only when the owner turns notifications on in Settings. Send one only when the app is not active, for the three events in 04 (a turn ends, `needs_input`, `error`), with the same title and body. A click activates the app and opens that workspace; put `workspaceId` in `userInfo`. This needs a signed app bundle.

**Dock badge.** Set `NSApp.dockTile.badgeLabel` to the number of workspaces whose attention is `needs_input`, `error` or `unread`. Clear it at 0. It is the same count as the web tab title.

**URL scheme.** Register `tempo` in `Info.plist` (`CFBundleURLTypes`). `tempo://workspace/<workspaceId>` opens that workspace. Ignore any other path. The web overflow menu adds `Open in Tempo for Mac`, which opens that link.

**Window state.** Restore the window frame and the last open workspace on launch. This version has one main window plus the Settings window.

## Local storage and settings

The app stores no workspace data on disk. This table is the full list of what it stores.

| What | Where |
| --- | --- |
| Session token | Keychain, generic password, service `dev.tempo.mac`, account = the Tempo host |
| Tempo URL, theme, transcript detail, notifications on or off, sound on or off | `~/Library/Application Support/dev.tempo.mac/config.toml` |
| Pane sizes, open panels, sort order, last workspace, composer drafts, diff viewed marks | `~/Library/Application Support/dev.tempo.mac/state.json` |
| Logs | `~/Library/Logs/Tempo/tempo.log`: JSON lines, 5 files of 5 MB each |

- Use the `security-framework` crate for the Keychain.
- Write files atomically: temp file, then rename. If a file does not parse, rename it to `<name>.bad` and start from defaults.
- Logs pass through the same redact rule as 05. MUST NOT log tokens, secrets, prompts or transcript text.
- Project settings, logins and secrets are server data. The Settings window changes them with the same functions as the web.
- Project settings follow 04's direct editing and `Reset to inherited` behavior, including explicit empty and Off overrides, source labels, and per-entry merging for run scripts and environment variables. There is no separate override toggle.
- The bundle identifier is `dev.tempo.mac`. Change it only before the first release; the Keychain item and folders depend on it.

## Build, signing, distribution and updates

The owner builds, signs and publishes the app from a Mac. The owner's Tempo serves the DMG, so nothing depends on a third-party update service.

**Toolchain.** `rust-toolchain.toml` pins one stable Rust, 1.92 or later; spike S11 picks it. Xcode Command Line Tools. CI runs `cargo fmt --check`, `cargo clippy --workspace -- -D warnings` and `cargo test --workspace` on a macOS 15 arm64 runner.

**Commands** (root `package.json`)

| Command | Does |
| --- | --- |
| `bun run mac:dev` | `cargo run -p tempo-mac` |
| `bun run mac:test` | `cargo test --workspace` |
| `bun run protocol:gen` | Writes `packages/protocol/schema/*.json` (JSON Schema Draft-07) and `crates/tempo-protocol/src/generated.rs` |
| `bun run protocol:fixtures` | Writes `packages/protocol/fixtures/` from the TypeScript schema tests |
| `bun run mac:release -- --adhoc` | Builds a local ad-hoc bundle and DMG (default mode) |
| `bun run mac:release -- --release` | Builds, signs and notarizes a release without uploading |
| `bun run mac:release -- --publish` | Runs the signed release checks and publishes with `latest.json` last |

**`mac:release`** (`scripts/mac/release.sh`). It MUST stop at the first failed step. The default ad-hoc mode performs local bundling only. The owner explicitly selects signed release or publication; the steps below apply to signed publication. Both signed modes first verify that the version is newer than the owner's existing manifest. The release script reads the uploaded DMG back and compares its bytes before publishing `latest.json`.

1. Read the version from `apps/mac/Cargo.toml`. It MUST be newer than `clients/mac/latest.json`.
2. `cargo build --release -p tempo-mac --target aarch64-apple-darwin`.
3. Build `Tempo.app`: `Contents/MacOS/Tempo`, `Contents/Info.plist` (`CFBundleIdentifier` `dev.tempo.mac`, the version, `LSMinimumSystemVersion` `15.0`, `CFBundleURLTypes` for `tempo`), and `Contents/Resources/AppIcon.icns`.
4. `codesign --force --options runtime --timestamp --entitlements apps/mac/resources/Tempo.entitlements --sign "$TEMPO_MAC_SIGN_IDENTITY" Tempo.app`
5. `hdiutil create -volname Tempo -srcfolder Tempo.app -ov -format UDZO Tempo-<version>.dmg`, then sign the DMG with the same identity.
6. `xcrun notarytool submit Tempo-<version>.dmg --keychain-profile "$TEMPO_MAC_NOTARY_PROFILE" --wait`, then `xcrun stapler staple Tempo-<version>.dmg`.
7. Upload the DMG to R2 at `clients/mac/<version>/Tempo-<version>.dmg`. Then write `clients/mac/latest.json` as `{version, sha256, size, publishedAt}`. Write `latest.json` last.

- `TEMPO_MAC_SIGN_IDENTITY` is a "Developer ID Application" identity. `TEMPO_MAC_NOTARY_PROFILE` is made once with `xcrun notarytool store-credentials`. Both need a paid Apple Developer Program membership.
- Without them, `mac:dev` and local builds use ad-hoc signing (`codesign --sign -`). Those builds are for the owner's own Mac only; macOS may ask again for Keychain access after each rebuild.
- `Tempo.entitlements` turns on the hardened runtime with no exceptions. No App Sandbox in this version.

`latestMacClientSha256` is the lowercase 64-character SHA-256 from the same `clients/mac/latest.json` record as `latestMacClient`. It is omitted when no valid hash is published. Clients MUST refuse an unverified download when the field is absent. This is additive under protocol version 1.

**Updates.** On launch and every 24 h, read `latestMacClient` from `GET /api/v1/meta`. If it is newer than the app, show `Tempo <version> is available.` with **Download**. Download fetches `GET /downloads/mac/<version>` with the bearer token, checks the SHA-256 from `meta`, saves the DMG to `~/Downloads`, and opens it in Finder. The owner drags the app to Applications. If the app is older than `minMacClient`, it shows only this update screen.

## Testing

Each layer has its own tests. The shared fixtures are the main guard against the web and Mac apps drifting apart.

| Layer | What | Where |
| --- | --- | --- |
| Protocol | Rust decodes every file in `packages/protocol/fixtures/`. CI runs `protocol:gen` and `protocol:fixtures` and fails on any diff. | `crates/tempo-protocol` |
| Stores | Each channel fixture (`fixtures/channel/*.jsonl` plus its expected end state) gives the same end state in the web store and in the Rust store | `crates/tempo-client`, `apps/tempo` |
| Client | Reconnect, backoff, close codes and device sign-in against a fake server, with tokio's paused test clock | `crates/tempo-client` |
| Views | GPUI context tests (`#[gpui::test]`) on the test executor, with no sleeps | `apps/mac` |
| Diff parser, terminal | Plain Rust unit tests | `apps/mac`, `crates/tempo-terminal` |
| End to end | `cargo test -p tempo-client --features e2e` against the deployed test environment with a real token; the rest of gate E by hand from its checklist | `tests/mac-e2e/` |

## Phase 4: milestones, spikes and gate E

Phase 4 starts after gate D passes. Server changes come first, so the web UI never waits on the Mac app.

| Milestone | Delivers | Done when |
| --- | --- | --- |
| M0 Server | `/api/v1`, bearer and device plugins, `/device` page, Devices settings, WebSocket bearer auth, `protocol:gen`, fixtures, download route | AT-23 to AT-25 pass |
| M1 Shell | App opens, sign-in, main window, sidebar live from the hub | AT-26 passes |
| M2 Chat | Workspace view, transcript, composer, sessions, queue, permissions, New workspace | AT-27 and AT-28 pass |
| M3 Review | Changes, diff, comments, files, checks, commit and push, PR, merge, archive | AT-29 and AT-30 pass |
| M4 Processes | Setup, Run, terminal, previews, Diagnostics, Settings | AT-31 passes |
| M5 Native and ship | Menus, shortcuts, notifications, Dock badge, URL scheme, `mac:release`, update check | AT-32 to AT-37 pass |

**Spikes.** Same rules as 06: throwaway code, results in `spikes/S<n>.md`, and the spec changes before M1 if a result differs. They run before M0 ends.

| ID | Question | Pass criteria |
| --- | --- | --- |
| S11 | Can GPUI Kit 0.7.1 carry the Tempo transcript? | A window with `Sidebar`, `Resizable`, `Tabs` and a `MessageScroller` of 10,000 `TextView::markdown` rows, one row streaming 200 deltas a second: frame time p99 under 16 ms on an M1. Record the Rust version that builds, the action, key-binding and menu APIs, whether `TextView` renders raw HTML, and that an `ImageCache` blocks remote images. |
| S12 | Do native channels work through Cloudflare with a bearer token? | `tokio-tungstenite` (rustls) opens the workspace channel with `Authorization: Bearer` and no `Origin`; the DO accepts it with hibernation; 1 hour of streaming with a reconnect every 5 minutes loses no item. |
| S13 | Can `gpui-terminal` run on GPUI Kit's GPUI and a socket? | The fork builds against `gpui-kit` 0.7.1, runs `vim` and `htop` over the terminal channel, resizes, and restores the screen after a reconnect. |
| S14 | Does device sign-in work with Better Auth on Workers and D1? | `deviceAuthorization()` and `bearer()` migrate on D1. The full flow returns a token; `/api/v1` accepts it; revoking the session makes the next call return 401. |
| S15 | Do notifications, the Dock badge and `tempo://` work? | From a Developer ID-signed bundle: a notification appears while the app is in the background and a click opens the right workspace; the badge updates; a `tempo://` link from Safari opens the workspace. |
| S16 | Can every protocol schema become Rust types? | `Schema.toJsonSchemaDocument` plus `JsonSchema.toDocumentDraft07` plus `typify` produce types for every schema in `packages/protocol`, and every fixture round-trips. List any type that needs a hand-written Rust version. |

**Gate E: Phase 4**

| ID | Test |
| --- | --- |
| AT-23 | Device sign-in: the code shown in the app matches `/device`; Approve signs the app in; Deny shows the denied message. |
| AT-24 | `/api/v1/rpc` accepts a bearer token and refuses a cookie-only request with 401. |
| AT-25 | All three channels accept a bearer upgrade with no `Origin`. A browser-style upgrade with a wrong `Origin` still gets 403. |
| AT-26 | With five workspaces running turns, the Mac sidebar and the web sidebar show the same states within 1 s of each other. |
| AT-27 | A turn streams live. Turning Wi-Fi off for 30 s, then on, resumes the stream with no missing or repeated item. |
| AT-28 | A permission request is approved from the Mac app, and the web card closes at the same time. |
| AT-29 | The diff is correct for added, changed, deleted, renamed and untracked files in both scopes. A review comment from the Mac reaches the agent. |
| AT-30 | Commit and push, create PR and squash-merge from the Mac app. |
| AT-31 | The terminal runs `vim`; resize works; after a reconnect, the screen is restored. |
| AT-32 | With the app in the background, a turn end shows a notification; a click opens that workspace. The Dock badge matches the web tab-title count. |
| AT-33 | `Open in Tempo for Mac` in the web UI opens the same workspace in the app. |
| AT-34 | The notarized DMG from `mac:release` installs and opens on a clean macOS 15 Mac with Gatekeeper on. |
| AT-35 | Revoking the Mac session in web Settings → Devices returns the app to the sign-in screen within 60 s. |
| AT-36 | Every action in 04's shortcut table works with its Conductor binding. |
| AT-37 | A logs, Keychain and disk check after a full run finds no token, secret, prompt or transcript text outside the Keychain. |

## Risks and open questions

The largest risk is that GPUI is pre-1.0. GPUI Kit bundles a GPUI snapshot (`gpui-pre`), and its API can change between releases.

| ID | Risk | Impact | Mitigation | Spike |
| --- | --- | --- | --- | --- |
| R12 | GPUI and GPUI Kit change their APIs | Upgrades break the build | Pin `gpui-kit = "=0.7.1"`; upgrade on purpose, in its own pull request | S11 |
| R13 | No terminal or diff component | More custom code | Fork `gpui-terminal`; build `DiffView` on `VirtualList` | S13 |
| R14 | `TextView` may render raw HTML or load remote images | XSS-like content or tracking pixels in the app | Escape HTML; `ImageCache` that refuses remote URIs | S11 |
| R15 | A bearer token on the Mac gives full access | A stolen token controls Tempo | Keychain only; 30-day session; Devices list with Revoke; the device page shows the code to compare | S14 |
| R16 | The TypeScript and Rust types drift apart | Messages fail to decode | Generated types, shared fixtures, `protocol` in `meta`, `minMacClient` | S16 |
| R17 | Notarization needs a paid Apple developer account | No signed DMG | Ad-hoc builds for the owner's own Mac | S15 |
| R18 | Two UIs to keep in step | The Mac app falls behind | "Same" rule in Scope; AGENTS.md rule 17; gate E repeats on each phase | — |

**Open questions for you**

- [ ] Q6. Should the Mac app also run workspaces on the Mac itself, as Conductor does with local worktrees? This spec says no: the Mac app is a client of the cloud Tempo only.
- [ ] Q7. Should previews open in an in-app tab through `gpui-wry`, even though it is experimental? This spec opens them in the default browser.
- [ ] Q8. Will anyone but you install the app? If not, ad-hoc builds may be enough, and notarization can wait.
- [ ] Q9. Is Apple silicon only acceptable, or do you need Intel Macs?
- [ ] Q10. Should the app cache transcripts on disk for offline reading? This spec keeps them in memory only.

## Workspace file links
Decode valid percent escapes in `file:///workspace/<path>` filenames. Ignore malformed escapes, invalid UTF-8, control characters, empty path segments and `.` or `..` segments. Invalid file links render as text and do not open a browser or a file panel. A line fragment is parsed before decoding the filename.

## Sources

Pages read on 2026-10-11.

- [GPUI Kit](https://gpui-kit.com/), [Getting started](https://gpui-kit.com/docs/getting-started), [Installation](https://gpui-kit.com/docs/installation) and [Components](https://gpui-kit.com/component)
- GPUI Kit [MessageScroller](https://gpui-kit.com/component/message-scroller), [TextView](https://gpui-kit.com/component/text-view) and [WebView guide](https://gpui-kit.com/docs/webview)
- [GPUI Kit llms-full.txt](https://gpui-kit.com/llms-full.txt) (executors, accessibility, testing guidance)
- [gpui-terminal on docs.rs](https://docs.rs/gpui-terminal)
- Better Auth [Device Authorization](https://better-auth.com/docs/plugins/device-authorization) and [Bearer](https://better-auth.com/docs/plugins/bearer) plugins
- [Effect v4: Schema to JSON Schema](https://effect.website/docs/v4/schema/json-schema)
- [RFC 8628: OAuth 2.0 Device Authorization Grant](https://www.rfc-editor.org/rfc/rfc8628)
- [Apple: Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
