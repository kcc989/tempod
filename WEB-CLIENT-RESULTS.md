# Tempo web client results

Status: **implementation prepared for review; web goal remains blocked on deployed acceptance and shared contracts**. Local regressions do not close gates B–D.

## Revision and scope

- Repository: [kcc989/tempod](https://github.com/kcc989/tempod).
- Starting SHA: [`b1ba351bfdbfad66215bbc3e9ea6e6a6c7e3ba0a`](https://github.com/kcc989/tempod/commit/b1ba351bfdbfad66215bbc3e9ea6e6a6c7e3ba0a), latest `main` fetched on 2026-10-11. The original integration PR #1 was merged and its branch was removed.
- Final implementation/tested SHA: [`efbd4af7bc7ed24447472b9296561982243d5075`](https://github.com/kcc989/tempod/commit/efbd4af7bc7ed24447472b9296561982243d5075). A following report-only commit records that SHA; the draft PR identifies its full branch head.
- Task branch: [`codex/complete-web-client`](https://github.com/kcc989/tempod/tree/codex/complete-web-client).

The full [tab 04 coverage matrix](https://github.com/kcc989/tempod/blob/codex/complete-web-client/docs/WEB-CLIENT-COVERAGE.md) distinguishes inspected implementation, automated evidence and outstanding manual/live verification. Existing regions were retained. No server, shared protocol, native implementation, lockfile or pinned application dependency changed. These changes restore specified behavior; no UI specification was changed. Matching native recovery/parity work remains with the Mac goal.

## Changes

1. Save composer text, mentions, review-comment chips and uploaded attachment references per chat. Keep drafts until server acknowledgement, preserve edits made while a send is pending, clear the correct chat after navigation, and prevent duplicate pending sends. Legacy string drafts still load. Failed or interrupted uploads have a readable recovery state. Storage failures retain typing for the current browser runtime.
2. Preserve queue and live-steer actions separately. Add pending-save feedback and invalidate sent review comments. Busy model/mode controls also respect the plan shortcut.
3. Restore per-chat transcript scroll position and virtualized measurements after navigating away. Scrolling upward stops automatic following before new output/resize can move the reader. Announce every completed message in a batch, including repeated text, without announcing each delta.
4. Keep file-picker/search dialogs and the default Run shortcut available when their panels are hidden. Add file-picker retry and explanatory phone states. Suppress region shortcuts behind modal dialogs and avoid submitting dialogs during text composition.
5. Reconnect terminals on online/visible transitions using the same session, preserve replaced/exited terminal states, and honor focus requested before xterm loads.
6. Show Mac server compatibility, published download and connection origin in Devices using the existing shared metadata contract and same-origin download endpoint.

## Verification

Runner: managed Linux cloud checkout, Bun 1.4.2, pinned repository dependencies. Browser versions: Chromium 149.0.7827.55, Firefox 151.0/Playwright build 1532, WebKit 26.5/build 2311. WebKit on Linux is not shipped Safari on macOS. Browser runtime libraries were prepared outside the repository; Firefox required approved execution outside the filesystem sandbox. Fresh root tests ran on 2026-10-11 from 22:41 to 22:43 UTC (2m 6.932s); the final styled browser run ran from 22:41 to 22:43 UTC (2.5 minutes).

| Command                                | Final result                                                                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run typecheck`                    | Passed: all seven workspaces and root TypeScript; changed app/e2e workspaces checked fresh                                                |
| `bun run lint`                         | Passed with warnings denied                                                                                                               |
| `bun run format:check`                 | Passed                                                                                                                                    |
| `bun run test --force`                 | Passed: seven tasks, zero cached; 717 Worker, 294 UI logic, 31 components, 201 protocol, 111 daemon, 9 settings and 3 cities tests passed |
| `bun run build`                        | Passed: production browser and SSR build; daemon build cache hit                                                                          |
| `bun run --cwd tests/e2e test:browser` | Passed: 21 cases (seven journeys × Chromium, Firefox and WebKit), no retries; 2.5 minutes                                                 |
| `git diff --check`                     | Passed                                                                                                                                    |

The seven local browser journeys exercise streaming/reload, queue editing and live steering, permission approval, hidden-panel file/search/Run actions, saved mention drafts across navigation/reload, phone reply/permission/unified-diff/comment chips without horizontal overflow, virtualized scroll restoration, running-chat close confirmation/closed reading, and blocked-storage draft recovery. They render production components/routes and validate synthetic server-function inputs/outputs against shared protocol schemas. They use no real login, paid agent, container or GitHub mutation.

The root test command skipped 40 adapter conformance tests and 44 deployed acceptance cases because their live prerequisites were absent, and three container-image-only daemon tests. These skips are explicitly excluded from acceptance proof. The build emitted its existing large-chunk warning; production browser and SSR compilation succeeded.

Environment URL for those checks: `http://127.0.0.1:4173`. No deployed HTTPS app or preview URL exists for this task yet. Safe synthetic screenshots: [desktop](https://github.com/kcc989/tempod/blob/codex/complete-web-client/docs/evidence/web-client/desktop-fixture.png), [phone](https://github.com/kcc989/tempod/blob/codex/complete-web-client/docs/evidence/web-client/phone-fixture.png). The harness explicitly scans the production sources for Tailwind utilities and verifies styles are applied. An earlier unstyled fixture run was discarded.

## Acceptance and remaining inputs

| Gate/IDs              | Real deployment runs    | Remaining evidence                                                                                                                                               |
| --------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B: AT-1–AT-8          | 0 of 3 consecutive runs | Owner/refused login; real repo/workspace; streaming/tool permissions; checkpoint bundles; sleep/wake; interrupted container and unusable snapshot recovery       |
| C: AT-9–AT-16         | 0 of 3 consecutive runs | Concurrent workspaces/adapters; credential refresh; real diff/comments/revert; conductor scripts; tmux reconnect; preview/HMR/token rotation/agent browser check |
| D: AT-17–AT-22        | 0 of 3 consecutive runs | Commit/push/PR/check updates/merge; archive/restore; egress policy; real phone journey; every shortcut in macOS Chrome/Safari/Firefox                            |
| Manual/security proof | Not run                 | AT-1/5/7/8/22 manual checks and zero credential matches in Worker logs, events and R2 during a full deployed run                                                 |

Exact setup is in [WEB-CLIENT-TEST-SETUP.md](https://github.com/kcc989/tempod/blob/codex/complete-web-client/docs/WEB-CLIENT-TEST-SETUP.md). The owner authorized creating the test setup (“Make one”). Attempting to create `kcc989/tempo-web-client-acceptance` failed with GitHub `Resource not accessible by integration (createRepository)`; it was not created. Creating the disposable repository requires a GitHub credential with repository-creation permission, or an owner-created repository with the test GitHub App installed.

The runtime needs a dedicated Workers Paid account and securely bound `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `APP_HOST`, `PREVIEW_DOMAIN` and `TEMPO_OWNER_GITHUB_ID`, plus network access to Cloudflare/the chosen hosts. It currently has none of the Cloudflare bindings. Fixed deployment resource names require a dedicated account or a core change before safe deployment. Real owner browser state, agent logins, test project ID and an exclusive core/web suite reservation are also needed. No deployment or paid evaluation was performed.

[WEB-CLIENT-CORE-REQUESTS.md](https://github.com/kcc989/tempod/blob/codex/complete-web-client/docs/WEB-CLIENT-CORE-REQUESTS.md) records exact shared-contract requirements and reproductions: historical per-turn usage, closed/merged PR titles, and authenticated attachment retrieval after reload. The client cannot provide these missing server data safely. Available tools permitted inspecting the other goal chats but did not expose cross-chat sending; the requests are recorded for integration rather than claimed as delivered.

The draft PR is reviewable implementation work. It must remain draft until the shared-contract gaps, native parity and required real acceptance evidence are resolved.
