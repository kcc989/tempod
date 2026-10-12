# Browser coverage against tab 04

Audit baseline: `b1ba351bfdbfad66215bbc3e9ea6e6a6c7e3ba0a`, latest `main` fetched on 2026-10-11. [PR #1](https://github.com/kcc989/tempod/pull/1) is merged; `claude/great-franklin-xc39l8` no longer exists on the remote. Work is isolated on `codex/complete-web-client`.

Source of truth: [04 UI](https://github.com/kcc989/tempod/blob/b1ba351bfdbfad66215bbc3e9ea6e6a6c7e3ba0a/docs/04%20UI.md), [02 contracts](https://github.com/kcc989/tempod/blob/b1ba351bfdbfad66215bbc3e9ea6e6a6c7e3ba0a/docs/02%20Data%20and%20API.md), [03 lifecycles](https://github.com/kcc989/tempod/blob/b1ba351bfdbfad66215bbc3e9ea6e6a6c7e3ba0a/docs/03%20Lifecycles.md), [05 security](https://github.com/kcc989/tempod/blob/b1ba351bfdbfad66215bbc3e9ea6e6a6c7e3ba0a/docs/05%20Security%20and%20Ops.md), [06 gates](https://github.com/kcc989/tempod/blob/b1ba351bfdbfad66215bbc3e9ea6e6a6c7e3ba0a/docs/06%20Build%20Plan.md), [07 parity](https://github.com/kcc989/tempod/blob/b1ba351bfdbfad66215bbc3e9ea6e6a6c7e3ba0a/docs/07%20Mac%20Client.md).

“Present” means the implementation was inspected, not that real acceptance passed. “Fixture browser” means the real UI rendered with synthetic shared-protocol inputs; it is not a real login, agent, container or git operation. Every manual/deployed entry below remains **not run** until the authorized environment is available. The results report records actual commands and outcomes separately.

Implementation sources are under [browser components](https://github.com/kcc989/tempod/tree/b1ba351bfdbfad66215bbc3e9ea6e6a6c7e3ba0a/apps/tempo/src/ui/components), [hooks](https://github.com/kcc989/tempod/tree/b1ba351bfdbfad66215bbc3e9ea6e6a6c7e3ba0a/apps/tempo/src/ui/hooks), [state/stores](https://github.com/kcc989/tempod/tree/b1ba351bfdbfad66215bbc3e9ea6e6a6c7e3ba0a/apps/tempo/src/ui), and [routes](https://github.com/kcc989/tempod/tree/b1ba351bfdbfad66215bbc3e9ea6e6a6c7e3ba0a/apps/tempo/src/routes). Existing automated evidence is in [UI tests](https://github.com/kcc989/tempod/tree/b1ba351bfdbfad66215bbc3e9ea6e6a6c7e3ba0a/apps/tempo/test/ui). The new fixture browser suite and recovery tests are on the web branch.

## Layout and navigation

| Requirement | Implementation audit | Automated evidence | Manual/deployed evidence needed |
| --- | --- | --- | --- |
| Five regions, draggable pane edges | Present: AppShell, WorkspaceLayout, resizable primitives | Layout/state tests; fixture browser workspace | Drag all edges in light/dark and multiple widths |
| Panel sizes/open state persist, safe storage | Present; volatile fallback fixed for controlled values when storage fails | foundation/workspace-ui; blocked-storage browser and composer component | Reload with saved sizes and storage quota exhausted |
| Sidebar default 280, min 220, max 400; Cmd-B | Present: AppShell pixel width adapter | foundation shortcuts; fixture browser | Real macOS browsers and resize/reload |
| Live non-archived list grouped by project | Present: Sidebar, hub channel/store | hub-state; sidebar logic | AT-9, simultaneous real workspaces |
| Pinned first, projects by sort order, History bottom | Present | hub-state/sidebar logic | Pin/unpin across live clients |
| Project collapse, owner/name, New workspace preselection | Present | sidebar logic; dialog models | Keyboard collapse and create in each project |
| Row title/attention, branch/slug, PR colours/checks dot | Present: WorkspaceRow, indicators | indicators/sidebar tests | AT-17/18 live updates |
| Newest activity / created sorting, persisted header choice | Present | hub-state/sidebar logic | Real changing activity across reload |
| 400 ms hover card, state/activity/PR/checks and actions | Present: HoverCard/RowHoverCard | sidebar/topbar logic | Pointer delay, keyboard access, failed detail query |
| Rename, pin, copy branch, GitHub, archive context menu | Present | sidebar/topbar logic | Browser clipboard and real mutations |
| Archived History, restore, typed-slug deletion | Present: history route, Confirm | workspace-ui confirmation/state tests | AT-19 and deletion in disposable repo |

## Top bar and git actions

| Requirement | Implementation audit | Automated evidence | Manual/deployed evidence needed |
| --- | --- | --- | --- |
| Title edit, copy branch, base picker until PR exists | Present | topbar logic | Rename, branch choices and PR lock |
| Port links; Alt-click Browser tab | Present: PortLinks, BrowserTab | browser-model logic | AT-16 real preview and hot reload |
| Container pill for every state, current step/instance | Present: indicators/pillText | foundation/topbar/banner tests | Real lifecycle progression and instance names |
| Exactly one primary action, first matching row | Present: primaryAction/topPrimary | topbar-logic tests | Dirty/ahead/pushed/failed checks/merged scenarios |
| Commit/popover, PR creation, merge, checks, archive | Present; existing shared API functions used | topbar logic, commit requests | AT-17/18 with real GitHub |
| Wake/sleep, rotate confirmation, GitHub/link, Diagnostics overflow | Present | topbar/confirmation/diagnostics tests | AT-16/19, clipboard and diagnostics |
| Open in Tempo for Mac and version/download presentation | Workspace URL scheme present; Devices metadata/download UI added using ApiMeta | links/auth; Mac-client component tests | Installed Mac URL-handler launch; real published DMG |

## Chat, transcript and composer

| Requirement | Implementation audit | Automated evidence | Manual/deployed evidence needed |
| --- | --- | --- | --- |
| Four-agent new-chat menu, unavailable login disabled | Present; models/modes come from agent config | chat-tabs/dialog models | AT-10 and all real login combinations |
| Rename, close confirmation while running, closed reading | Present | chat-tabs logic; closed-chat fixture browser | Live cancellation/close and archived reading |
| User bubbles, mentions, timestamps and checkpoint revert | Present | transcript model/permission components | AT-13 exact tree/safety checkpoint |
| User attachment thumbnails | Present: same-browser upload cache first, then the owner-only `GET /api/workspaces/<id>/attachments/<id>` route for PNG, JPEG, GIF and WebP; name chip on error or other types | attachment-cache tests | Reload and other-browser check against a deployed route |
| Agent GFM, lazy Shiki, code copy, streaming caret | Present; remote images/HTML never rendered | Markdown component/security and highlighting tests; streamed fixture | AT-3/4; clipboard and actual inline media |
| Thought and handoff collapsed text | Present | transcript-model tests | Real agent thoughts and restart handoff |
| Tool icon/title/status, expand, diffs/terminal text/file locations | Present; ACP terminal IDs have no output contract, and 01 advertises terminal=false | transcript/tool-content/expand helpers | AT-4; real adapter tool payloads |
| Ctrl-O expands/collapses all | Present | expand-store/shortcuts tests | All shipped macOS browsers |
| Plan checklist and composer Plan pill | Present | transcript/workspace-state/model tests | Real plan updates |
| Permission options, Enter allow, Backspace reject | Present; closed/archived controls disabled | permission components; fixture browser desktop/phone | AT-4/21 real permission/continuation |
| Notice level, revert divider and reverted opacity | Present | transcript-model/store tests | Real interruption/revert and security redaction |
| Error code/message/details, retry same prompt | Present | transcript model | Real adapter failure/retry, including attachments/comments |
| Turn duration and usage tokens | Duration present; historical per-turn usage blocked by Session-only usage contract | duration tests | Core turn-scoped usage contract, then reload evidence |
| Streaming follow, jump to latest, per-chat reading position | Follow/jump present; scroll restoration and virtual measurements fixed | transcript components; long-transcript fixture browser | AT-3 long real streams/reload |
| Enter send/queue; Shift-Enter newline; Stop/Esc | Present; queued input remains a separate delivery mode | composer components/model/shortcuts; fixture browser | Real AT-3/4 cancellation and queue drain |
| Queue edit/delete/drag/keyboard reorder, global queue order | Present; steering reservations disable queue controls | queue components, reorderedQueue/store tests; fixture edit | Cross-session real queue and drag/reorder |
| Supported active-chat Send now, pending/fallback/uncertainty | Present; capability gating; pending request survives chat switching; no automatic retry | composer/queue components and Worker steering tests; fixture delivery flag checks | Logged-in adapter injection, idle fallback and ambiguous acknowledgement |
| @ fuzzy files, mentions, picker keyboard/failure retry | Present; Retry added | composer model/components; draft fixture browser | Actual listFiles failure/recovery and large repo |
| Agent slash commands plus Tempo /plan, preserve caret suffix | Present | composer-model tests | Real advertised command list/modes |
| Paste/drop/Cmd-U uploads, per-file 10 MiB limit | Present; uploaded draft metadata survives unmount/reload; interrupted uploads become failed | composer model/components | Real HTTP upload, size limit, failures and paste/drop |
| Dynamic model/mode config and Shift-Tab plan | Present; shortcut now respects busy picker restrictions | composer/agent helpers | Each real adapter's config/options |
| Review chip and send with next prompt | Present; draft selection persists and list invalidates after successful delivery | composer components/model; phone review fixture | AT-12 real delivery to agent |
| Usage context ring | Present: Session usage_update | composer-model tests | Actual agents reporting used/total context |
| Per-session drafts survive send failure, remount and storage failure | Fixed: rich draft storage, legacy text compatibility, clear only acknowledged content | composer components; reload/blocked-storage fixture browser | Reload during network loss and uncertain delivery |
| Archived Restore bar, closed read-only, missing/invalid login banners | Present | banners/permission/auth tests; closed fixture | AT-19 and real invalid credentials |

## Review and processes

| Requirement | Implementation audit | Automated evidence | Manual/deployed evidence needed |
| --- | --- | --- | --- |
| Changes refresh from channel; A/M/D/R and +/- counts | Present | changes-model/store tests | AT-12 all statuses and scopes |
| Branch/Uncommitted, Alt-U, group folders, open diff | Present | changes-model/workspace-ui tests; phone diff fixture | AT-12 against exact git trees |
| Commit message/footer | Present | git/topbar contract tests | AT-17 dirty/ahead/empty commit |
| Unified/split persisted, unified below 1024 | Present | diff-model; phone fixture | Desktop split and real diffs |
| J/K file navigation, Ctrl-V diff-hash viewed marks | Present; modal shortcut isolation fixed | diff-model; modal shortcut component | Large diff keyboard navigation and hash changes |
| Line/range/file draft comments, send to agent | Present | diff-model; composer/phone browser | AT-12 line drag and real sent payload |
| All files tree, read-only Shiki file tabs | Present | file-tree/highlight logic; file-dialog browser | Large real repo, binary/error/sleeping paths |
| Cmd-P fuzzy picker and Cmd-Shift-F search | Present; hosts now remain when right side is hidden; retry and phone explanation added | fixture browser hidden-panel journey; search/model tests | Real file failures, regex/limits, all macOS browsers |
| Checks number/title/state/GitHub/check rows | Present for every PR state: title from `WorkspaceDetail.prTitle` or the `refreshPullRequest` result | checks-model | AT-17/18 |
| Browser address/reload/new tab, iframe restrictions | Present; excludes allow-top-navigation | browser-model tests | AT-16 real dev server/HMR and preview rotation |
| Right-side/bottom toggles and panel persistence | Present | workspace-ui/layout/shortcuts tests | All macOS browsers and reload |
| Setup live/history, rerun, continue anyway, settings issues | Present | script-runs/settings models | AT-14 real setup failure and warnings |
| Run scripts/default shortcut/Start/Stop/live/history | Present; default shortcut registration moved out of hidden panel | script-runs tests; hidden-panel browser | AT-14 real concurrent/nonconcurrent scripts |
| Terminal t1-t9, xterm binary/resize/ready, reconnect | Present; online/visible recovery and async focus fixed | terminal-model and component reconnect/replaced tests | AT-15 real tmux session/scrollback/resize |

## Dialogs, feedback and nonfunctional rules

| Requirement | Implementation audit | Automated evidence | Manual/deployed evidence needed |
| --- | --- | --- | --- |
| shadcn dialogs, Escape, platform Cmd-Enter submit | Present; composition/platform-safe submit fixed | dialog/shortcuts models/components | Each dialog in all macOS browsers |
| New workspace project/new base/existing search/PR source/agent/text | Present | new-workspace/dialog models | AT-2 real creation, branches and PR selection |
| Keep open dispatcher behavior | Present | dialog models | Create multiple real workspaces |
| Add project installations/repos, Link, empty install action | Present | first-run/dialog models | AT-1/2 real GitHub App installations |
| First-run five-step live checklist until complete | Present | first-run tests | Real setup manifest/install/login/repo/workspace |
| Settings Logins, commands, status/update time, never show stored values | Present | credentials-model/auth tests | Real login uploads and secret inspection |
| Project scripts/env/secrets/instance/sleep/egress/git/prompts/source | Present | settings-model tests | Real precedence/settings propagation and AT-14/20 |
| Theme system/light/dark | Present | theme tests | Both themes in every screen/phone |
| Notifications enabled/sound, permission only in Settings | Present | notify logic | Real browser permission and hidden-tab notifications |
| Read-only shortcut table | Present | shortcut-table tests | Every binding in real macOS browsers |
| Devices list/current marker/revoke, browser device approval | Present; metadata/download added | auth and Mac-client components | Device grant/denial/expiry/revocation, real sessions |
| Diagnostics Ops/Container/Logs/Egress/Sessions and filters | Present | diagnostics-model tests | Actual ops/egress/log history and redaction |
| Archive no confirm, eight-second Undo | Present | confirmation/topbar logic | AT-19, Undo during archive |
| Typed delete, revert/close/rotate confirmations | Present | confirmation models/components; closed fixture | Actual irreversible fixture actions and recovery |
| Palette workspace title/branch/slug and enabled shortcut actions | Present | fuzzy/actions/navigation tests | Keyboard/focus and changing live workspaces |
| Attention-first icon precedence, exact tooltips/PR/check colours | Present | indicators/sidebar logic | Real attention and PR transitions |
| Hidden-tab notifications for finished/input/error, click navigation | Present | hub-state/notify tests | Real browser Notification API and focus |
| Attention tab-title count | Present | hub/indicators tests | Multiple live workspaces/reload |
| Error-table toasts, suppress duplicates of banners | Present | foundation/toast/banner tests | Real server/socket/auth failures |
| All named empty/loading/error/reconnect/lifecycle states | Present: States, WorkspaceBanners, ReconnectingBar, region states | foundation/banner/socket tests | Real slow requests, lost socket >2s, failed setup/wake |
| Keyboard reachable actions, visible focus rings | Present, inspected custom controls; local diff keys respect modal | permission/modal/components and browser journeys | Keyboard-only full product on each macOS browser |
| aria-live once per message, not per delta | Fixed to announce every completion in a batch, including repeated text | transcript component regression | VoiceOver with real streamed messages |
| Tokens, 13px/system/monospace, lazy highlighting, quiet styling | Present; no application libraries added | build/typecheck/format/lint | Visual audit all screens in light/dark |
| TanStack Query/store/useSyncExternalStore, no private wire schemas | Preserved | store/protocol/typecheck tests | Real protocol/reconnect cross-client acceptance |
| Transcript/files virtualized past 200 | Present; measured transcript state survives navigation | list/tree/models; >200-row fixture browser | 10,000-item real transcript/performance |
| Safe Markdown, workspace file links and inline ACP media | Present; raw HTML/remote Markdown images blocked | Markdown/block/file-link component/model tests | Security gate and credential grep |
| Browser storage restricted; every read/write caught | Preserved; draft schema and volatile fallback added | storage/composer tests; blocked-storage browser | Browser storage denial/quota recovery |
| Phone Workspaces/Chat/Changes, chat menu, primary git at Changes | Present | fixture phone journey | AT-21 real live workspace/permission/reply |
| Phone unified diff and review comments | Present | phone fixture | AT-12/21 real comment delivery |
| Phone no terminal/Run/file tree, explanatory states | Present; search dialogs now explain width restriction | phone/component models | Phone shortcut/menu and rotate screen |
| Phone previews open externally | Present: phone overflow port links | browser/topbar models | Real device/new-tab preview |

## Every keyboard binding

All bindings match `KeyboardEvent.code`, use exact modifiers, prevent handled defaults, map Cmd to Ctrl on Windows/Linux, and preserve browser-reserved keys. Existing `logic`, `foundation`, `actions` and region tests cover matching/registration. Local browser evidence covers a subset of actions; **every row still requires AT-22 in shipped Chrome, Safari and Firefox on macOS**.

| Binding | Handler source | Current behavioral evidence |
| --- | --- | --- |
| Cmd-K | AppShell/CommandPalette | Registry and matching tests |
| Alt-N | AppShell/WorkspaceLayout | Registry/dialog tests |
| Alt-T | ChatTabs | Chat/menu models |
| Alt-W | ChatTabs | Closed-chat fixture browser |
| Alt-] / Alt-[ | WorkspaceLayout | Tab-cycle/state tests |
| Alt-1–9 | sidebar/navigation | Navigation tests |
| Alt-Down / Alt-Up | sidebar/navigation | Navigation tests |
| Alt-G | sidebar/navigation | Attention-navigation tests |
| Cmd-B | AppShell | Layout/registration tests |
| Cmd-Alt-B | AppShell | Hidden-panel fixture browser |
| Alt-J | AppShell | Layout tests |
| Alt-L | WorkspaceLayout/Composer | Focus-counter/state tests |
| Enter / Shift-Enter | Composer | Composer components; browser queue |
| Escape in composer | Composer | Shortcut matching and cancel action |
| Shift-Tab | Composer | Plan-target/model matching tests; busy guard |
| Cmd-/ | Composer/ModelPicker | Agent-config and registration tests |
| Cmd-U | Composer | Matching/file-size/attachment tests |
| Enter / Backspace permission | TranscriptItems | Permission components; fixture click journey |
| Ctrl-O | ChatTabs/expand-store | Expand-state tests |
| Alt-D | WorkspaceLayout | Tab/state tests |
| Alt-U | WorkspaceLayout | Scope/state tests |
| J / K | DiffTab | Diff-index and editable-target tests |
| Ctrl-V | DiffTab | Viewed-hash/model and modal isolation tests |
| Cmd-P | WorkspaceLayout/ReviewDialogs | Hidden-panel file-picker browser |
| Cmd-Shift-F | WorkspaceLayout/ReviewDialogs | Hidden-panel search browser |
| Alt-Y | TopBar/commit-request | Primary-action and commit-request tests |
| Alt-P | TopBar | Primary-action tests |
| Alt-M | TopBar | Primary-action tests |
| Alt-A | TopBar | Archive-availability tests |
| Alt-R | WorkspaceLayout/useScripts | Hidden-panel default-script browser |
| Alt-, | AppShell/SettingsDialog | Matching/registry tests |
| Cmd-Enter dialogs | DialogContent | Platform matching; submit composition guard |

## Gate status

Gates B–D remain open: AT-1–AT-22 have no three-run deployed evidence. No fixture or skipped test closes a gate. The full Mac parity and macOS/browser/manual/security proof are also pending. The standalone core requests and test setup identify the precise missing contracts, credentials and environment reservation.
