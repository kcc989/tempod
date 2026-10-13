# Tempo for Mac: local acceptance checklist

Status: not run by the cloud implementation task. The owner elected to perform native testing locally. The implementation was checked on Linux; headless GPUI tests do not establish Gate E.

Use macOS 15 or later on Apple silicon, Xcode Command Line Tools, the pinned Rust toolchain and Bun. Use an authorized Tempo test deployment and disposable repository/workspaces for mutations. Keep real tokens out of shell history, reports, screenshots and logs.

## Build and automated checks

```sh
bun install --frozen-lockfile
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
bun run typecheck
bun run lint
bun run test
bun run --cwd packages/protocol protocol:check
python3 -B scripts/mac/test_release.py
bun run mac:dev
```

For a local app bundle and DMG:

```sh
bun run mac:release -- --adhoc
open dist/mac/0.1.0/Tempo.app
```

Use the version from `apps/mac/Cargo.toml` if it changes. The ad-hoc bundle is for the owner's Mac. Native notification tests need a signed bundle. `--release` signs and notarizes without uploading; `--publish` also publishes to the owner's R2 bucket. Both signed modes require an authorized Developer ID identity, a notarytool Keychain profile, the bucket and existing `clients/mac/latest.json`. Publication is a separate owner action.

## Gate E evidence

Record the app SHA, server SHA, macOS version, hardware, test time and outcome. Attach only screenshots without credentials, private prompts, source code or repository names. Run each gate test three times as required by the build plan.

| ID    | Local exercise                                                                                                                                                                                                                                                       | Required evidence                                                                                                                                                                                                                                                | Status  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| AT-23 | Connect to the deployment; compare device codes; approve, deny and expire flows. Relaunch with a saved session.                                                                                                                                                      | Browser/app flow, successful session and denied message. Coordinate server results with core.                                                                                                                                                                    | Not run |
| AT-24 | With core, verify bearer RPC succeeds and cookie-only native RPC is rejected.                                                                                                                                                                                        | Authorized endpoint responses, with tokens removed.                                                                                                                                                                                                              | Not run |
| AT-25 | With core, exercise hub, workspace and terminal bearer upgrades without Origin; wrong browser Origin must fail.                                                                                                                                                      | Sanitized upgrade/close results.                                                                                                                                                                                                                                 | Not run |
| AT-26 | Run turns in five workspaces and compare Mac/web sidebar states and attention. Switch to a sixth workspace to exercise eviction.                                                                                                                                     | States converge within one second; hidden sockets close after 60 seconds; at most five workspace caches.                                                                                                                                                         | Not run |
| AT-27 | Stream a turn; disable networking for 30 seconds; reconnect. Switch chat tabs during streaming and revisit scroll positions.                                                                                                                                         | No missing/repeated items, accurate resume revision and retained draft.                                                                                                                                                                                          | Not run |
| AT-28 | Approve/reject a permission from Mac; resolve another from web. Verify the other card closes.                                                                                                                                                                        | One resolution, correct focused Enter/Backspace option.                                                                                                                                                                                                          | Not run |
| AT-29 | Added, modified, deleted, renamed, binary and untracked files; both scopes; unified/split; narrow window; 20,000-line boundary. Add line/range/file comments and send them, including with empty prompt text.                                                        | Correct gutters/content, delivered comments, hash invalidation, safe large-diff fallback.                                                                                                                                                                        | Not run |
| AT-30 | Commit/push, create a PR, refresh checks, squash merge, archive, Undo, restore, then slug-confirmed delete. Use disposable data.                                                                                                                                     | Correct branch/PR, operation failures preserve inputs, primary action updates.                                                                                                                                                                                   | Not run |
| AT-31 | Open t1–t9. Use vim, application cursor keys, bracketed paste, Unicode/wide cells, selection/copy and 10,000 lines of scrollback. Resize, lose the network, reconnect and wake the app.                                                                              | Same remote tmux session; accurate screen and resize; no local PTY.                                                                                                                                                                                              | Not run |
| AT-32 | Enable notifications from Settings; deny then enable in System Settings. Background the signed app for turn end, needs-input and error events. Click a notification.                                                                                                 | Correct workspace, no foreground notification, Dock count matches web.                                                                                                                                                                                           | Not run |
| AT-33 | Use Open in Tempo for Mac from web and `tempo://workspace/<id>` with the app open, closed and with its main window closed. Exercise invalid IDs/paths.                                                                                                               | Reopened main window, correct workspace or Not found, ignored invalid links.                                                                                                                                                                                     | Not run |
| AT-34 | Owner produces a signed/notarized DMG and installs it on a clean macOS 15 machine with Gatekeeper enabled. Test a valid, corrupt, oversized and incomplete update using core's published hash metadata, including an existing saved session in required-update mode. | Signing/notarization/Gatekeeper results; SHA and size rejection; version monotonicity.                                                                                                                                                                           | Not run |
| AT-35 | Revoke the Mac device session from web Settings while Mac is idle and while channels are connected.                                                                                                                                                                  | Within 60 seconds, all channels close, token disappears from Keychain and sign-in returns; drafts/layout remain.                                                                                                                                                 | Not run |
| AT-36 | Exercise every action in Settings → Shortcuts and the menus with focus in sidebar, composer, transcript, Changes, Diff, file editor and Terminal. Repeat in modal dialogs and Settings.                                                                              | Every Mac binding; terminal non-Command keys reach the remote shell; no stolen input focus.                                                                                                                                                                      | Not run |
| AT-37 | After a full run inspect Keychain, config, state and rotating logs using temporary test credentials.                                                                                                                                                                 | No token outside Keychain; no secrets or transcript in native storage/logs; redact screenshots. Intentional composer drafts are specified in 07's state.json table, which conflicts with AT-37's literal prohibition of any prompt text; record this separately. | Not run |

## Additional product checks

- Queue while a turn runs; edit/delete/reorder across chats; Send now on a capable adapter; unsupported fallback; uncertain delivery; running-chat close confirmation.
- Pick and change model/mode; toggle plan mode; `/` keyboard navigation; `@` file mentions; queue draft restoration; cancel while offline.
- Finder chooser, drag/drop, file paste and inline PNG/JPEG/GIF/WebP clipboard paste. Upload failure and 10 MiB limit retain the draft; attachment-only prompts send. User-message attachment thumbnail retrieval still needs a core download route.
- No raw agent HTML or remote Markdown image fetches. Code-block copy and safe `file:///workspace/path#L12` navigation work. Invalid paths, SVG and unsupported inline media fail closed.
- All files tree, fuzzy picker and content search open cached read-only file tabs at the correct line. Close inactive file tabs, cycle chats/documents and refresh stale documents after a git operation.
- Setup history, warnings, failure, rerun and Continue anyway; run-script selection, default Command-R and start/stop; previews open the default browser.
- Logins never reveal stored values; Codex file upload/paste; project selector before the first workspace, multiline scripts/prompts, dotted run IDs, environment variables, override resets, secrets and source labels; diagnostics tabs and filters.
- Themes, restored window geometry, pane sizes/toggles, sort order, project collapse and project-specific new workspace; Settings is a single reusable window and Command-W closes it.
- S11: measure 10,000-row streaming performance on Apple silicon, including row remeasurement and p99 frame time. S12/S14 require deployed bearer/device checks. S13 requires interactive vim/htop. S15 requires native signed notification/Dock/URL tests. None are established by Linux tests.

## Known core dependencies

MQ-1 is resolved by the imported core `ApiMeta.latestMacClientSha256` contract. Both update screens use authenticated bounded downloads and verify before saving/opening. With no saved token on first launch, the spec stops device sign-in before the owner-only download can authenticate. The screen explains manual installation; a native authorization path for this case needs a core/spec policy decision.

The existing attachment route only uploads; the native transcript cannot retrieve a thumbnail from a prior session or another client. Per-turn token counts, check-run duration and closed/merged PR titles are also absent from the relevant wire types; do not infer them from session totals or unrelated fields.
