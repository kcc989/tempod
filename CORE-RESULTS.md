# Tempo core continuation results — 2026-10-11

**Not deployed.** The implementation and production-image checks below passed, but this run is blocked by managed network access and state-store secret recovery. No live agent acceptance, credential-leak audit or three consecutive hosted gate runs are claimed. Paid model evaluations were not run.

## Current revision and changes

- Fetched main: `5e259d6abd8c21d1afc40abebe0c3a983fbc78c5`. PR #4 was already merged and had no review comments; its latest CI and main CI passed. The published web and native client changes are included in this baseline.
- Follow-up branch: `codex/core-deploy-contracts`; implementation SHA: `0dfac8f5cb600cdc76a8552a8704098c3950ab3a`. This results document is committed separately. No automatic merge is authorized or performed.
- Added persisted optional PR titles to shared workspace-detail and refresh contracts, including closed/merged PRs and title-only updates. Added owner-authenticated same-origin attachment retrieval, including archived workspaces, safe raster MIME responses, binary downloads for active formats, private/no-store headers and size checks. Effect schemas, JSON schemas, Rust types and fixtures change together with 02/05 and implementation notes.
- Pinned Alchemy's missing Effect Node peer at 4.0.3 within the existing Effect stack. The deployment wrapper checks the existing state-store endpoint before invoking Alchemy and disables automatic bootstrap approval for an existing store. Three preflight tests run in the root test command.
- Fixed a race in the existing transport-recovery test fixture: finish startup and drain its daemon connection before resetting the isolated database. The first full root run exposed the race; the corrected final run passed.
- ACP v1 and OpenCode 1.18.35 remain pinned. No experimental TUI-v2 version or new agent/provider credentials were configured.

## Current validation

Commands use Bun 1.4.2 and Rust 1.97.0. This runner's writable tool/profile/cache directories are under `/workspace`; proxy and CA settings are preserved.

| Command | Actual result |
| --- | --- |
| `bun install --frozen-lockfile` | Pass; updated lockfile installs without changes. |
| `bun run typecheck` | Pass, seven workspace tasks and root scripts. |
| `bun run lint` | Pass. |
| `bun run format:check`, `bun run check:versions`, `git diff --check` | Pass. |
| `TURBO_FORCE=true bun run test` | Final pass, all seven tasks plus three deployment guard tests. Worker 732; UI logic 294; components 31; protocol 202; settings 9; cities 3. Host daemon tests have three image-only skips; host conformance skips 40; hosted e2e skips 44 without a deployment. Skips are not acceptance evidence. |
| `bun run build` | Pass, application and compiled Linux daemon. |
| `bun run protocol:gen`, `bun run protocol:fixtures`, `bun run --cwd packages/protocol protocol:check` | Pass; 372 outputs checked, including generated Rust and new attachment/title fixtures. |
| `cargo test -p tempo-protocol -p protocol-gen` | Pass, 16 tests. |
| `cargo test -p tempo-client` | Pass, 39 tests. Native UI/platform acceptance is not established. |
| `DOCKER_CONFIG=/workspace/docker-config TEMPO_TEST_MOUNT_SOURCE=1 TEMPO_BUILD_CA=/etc/ssl/certs/ca-certificates.crt bun run test:tempod:container` | Pass in the complete production Linux image: **119 passed, 0 failed**, 647 assertions. Image **3,171,713,382 bytes**, id `sha256:2928ec1c55dce72aeef9f1e2bf37ee622d853e9245aa9d36cbb2ca25a26cc343`. Tests run as image uid 1000 under tini with frozen Linux dependencies/source read-only. Daemon source is unchanged from fetched main. The clean runner had 30 GB free initially; Docker used the existing vfs daemon. |
| Main production-image GitHub Actions job | Independently passed on `5e259d6`: [run 38183387333](https://github.com/kcc989/tempod/actions/runs/38183387333), job 114600495287, 119 tests/zero failures. This closes the previous final-source image-capacity blocker for that revision. |
| Sequential offline adapters in that production image, `CONFORMANCE_LIVE=0` | Claude 5 pass/3 skip; OpenCode 5 pass/3 skip; Pi 5 pass/3 skip. Codex 1 pass/3 skip/4 fail: session/new requires authentication. No prompts or paid evaluations ran. Reports in `docs/evidence/core/continuation-offline/` omit stderr. |

## Cloudflare and failed deployment

Configured target: **https://tempod.dev**, preview zone `typecast.dev`, owner GitHub id `3671149`. This is the configured target, **not an actual deployed app URL**. Both zones are active in the configured account. `*.typecast.dev` has the required existing proxied `AAAA 100::` record. API reads of zones/DNS, Workers, D1, R2, custom domains and Secrets Store succeeded. No `tempo` Worker/D1, `tempo-data` bucket or app custom domain existed before provisioning. The existing `alchemy-state-store` Worker and account Secrets Store were detected.

The first `bun run deploy --yes --no-input` failed loading Alchemy's missing `@effect/platform-node` peer; adding the pinned peer resolved that actual SDK failure. The next attempt reached Alchemy state-store setup. The proxy rejects `alchemy-state-store.apingot.workers.dev` and `tempod.dev` with CONNECT 403. The SDK incorrectly treated the failed store health probe as absence and entered bootstrap. **This attempt modified the pre-existing state-store auth and encryption secrets** (`AlchemyStateStoreToken` and `AlchemyStateStoreEncryptionKey`, modified 2026-10-11 23:33 UTC). The agent stopped the attempt and informed the owner. Tempo's encryption/auth/setup secrets were never generated and Tempo resources were not created. No secret values or setup tokens are published here.

The new preflight now fails before Alchemy when that store is unreachable. Do not rerun SDK bootstrap, destroy remote state, change its namespace or rotate keys to bypass this incident. Preserve this runner's private `.alchemy/state/CloudflareStateStore/` and `/workspace/alchemy-profile/`, and the original operator's bootstrap/profile state. Existing encrypted state may be unreadable until the original encryption value is restored securely from an original backup; recoverability has not been verified. The original values cannot be retrieved from the normal Secrets Store API. Actual deployment and hosted verification are pending recovery.

## Remaining decisions and exact setup sequence

1. Apply managed network-policy access for `alchemy-state-store.apingot.workers.dev`, `tempod.dev`, `tempo.apingot.workers.dev`, `typecast.dev` and `*.typecast.dev`; preserve API/registry/package/browser access. No proxy bypass was attempted.
2. Recover the original state-store auth/encryption values and verify existing remote state using the original profile/stage before proceeding. Do not send these values in chat or commit them. The network and original-state requests are pending with the owner.
3. Decide the turn-usage contract. ACP v1 usage_update supplies context occupancy in tokens (`used`/`size`), while prompt-response usage is optional and its member descriptions say cumulative session totals. 04 requires tokens under each turn, but 02 has only session usage. The choice between per-turn differences of cumulative totals and a context snapshot is unresolved; no numbers were invented or attributed from the most recent session. AGENTS.md's "If the spec is silent, or two tabs disagree, stop and ask" applies. This request was sent while independent work continued.
4. Resume `bun run deploy` with the same account/profile/stage after recovery. Keep its printed `https://tempod.dev/setup/github?token=<private setup token>` link private. There is no usable setup token from this attempt.
5. Open the printed link; submit the manifest to GitHub; confirm **Create GitHub App**; follow **Install**; select repositories; finish installation; sign in at `https://tempod.dev/login` as `kcc989`. Follow `docs/deployment/CORE-TEST-DEPLOYMENT.md`. Agent credentials are linked later only through Tempo Settings, never container env.
6. Verify public endpoints, setup completion, owner/non-owner authentication, generated deployed bindings and infrastructure smokes after deployment. They could not run against an app in this attempt. Client consumption of the new PR-title and attachment routes, turn usage after a spec decision, live agent turns, credential-leak auditing, repeated hosted Gates B–D and native Gate E remain open.

The earlier report below is historical evidence from PR #4; the current results above supersede its revision, image-capacity and deployment-input status.

---

# Tempo core results — 2026-10-11

The recovery fixes and ACP v1 mode integration are implemented, and all root checks pass. **Core acceptance remains blocked:** no hosted test environment, real credentials or repeated hosted acceptance runs were available. This report does not close Gates A–E.

## Revision and scope

- Repository: [kcc989/tempod](https://github.com/kcc989/tempod).
- Initial cloud checkout: `1984b8957c10b7ad8389330121f264e3a0eba4b3`.
- Integration baseline: `b1ba351bfdbfad66215bbc3e9ea6e6a6c7e3ba0a` from published `main`. The named integration branch had been deleted after [PR #1](https://github.com/kcc989/tempod/pull/1) merged. The two client chats reported this same baseline; their unpublished files were not used.
- Task branch: `codex/complete-tempo-core`. Implementation SHA: `f56911de26c6a3f9c9810fc1df9257d6cce4cf91`. This report is committed separately so it can name the implementation SHA without a circular self-reference.
- No push, publication, merge, account selection, deployment or paid model evaluation was performed.

The audit compared the existing backend, daemon, adapters, shared contracts and deployment tooling with [spec tabs 00–07](https://github.com/kcc989/tempod/tree/main/docs). Existing implementation covers auth/owner enforcement, device sign-in/revocation, HTTP/cookie/bearer rules, all three channels, setup, queued prompts and steering, permissions/cancellation, git operations, scripts, terminals, previews, sleep/wake, archive/restore/delete, credentials and egress. The changes below address gaps found at their recovery boundaries. Local tests establish implementation behavior; they do not establish Cloudflare feasibility or end-to-end client acceptance.

## Changes and contracts

1. Daemon local-event mutations, event receipt and acknowledgement cursor commit together. A failed event closes the connection and stops later events from advancing the cursor; replay applies the failed event once. Credential updates must reach CredentialDO before acknowledgement, and their SQLite event receipt stores an empty payload.
2. `turn.started` can durably accept a queued turn before the prompt RPC acknowledgement. Fast `turn.ended` events survive the delayed acknowledgement, pending content is consumed once, and queue processing resumes after the in-flight queue callback settles.
3. Waiting setup recovers after a native Durable Object abort with the daemon socket closed. Reacquiring the actor reconnects using the stored token without restarting the container or setup script.
4. Checkpoint request identities persist before the daemon call. Retrying an existing checkpoint regenerates its original bundle without overwriting its tree. The owner requires a successful safety checkpoint before revert; three failed attempts fail the op before file or transcript changes.
5. Home backups exclude `.tempod/`, including SQLite outbox credential data, WAL/SHM files and temporary bundles. Adapter session data remains included. Aborted RPCs release listeners; stalled health probes obey both their own 60-second deadline and the op signal. Concurrent adapter starts preserve the configured process limit.
6. ACP remains v1 with SDK 1.8.0. Advertised category `mode` select options provide Tempo’s `modes`/`modeId`; grouped choices are flattened. Mode changes use `session/set_config_option` when advertised, with state refreshed from replies, updates and reloads. Agents exposing the session modes interface use `session/set_mode`. No deployed-client compatibility shim is needed. The experimental OpenCode TUI-v2 snapshot exposes the same interface and was not adopted; production remains pinned to 1.18.35.
7. `/api/v1/meta` adds the owner-approved optional `latestMacClientSha256` (64 lowercase hex characters) from a valid latest release record. Existing no-hash responses remain valid. Effect schema, JSON schema, Rust types and shared fixtures were regenerated. No browser or native views were changed.
8. Image builds can mount a combined CA as a temporary BuildKit secret while retaining TLS verification. Tests can mount frozen Linux dependencies/source read-only into the complete production image as uid 1000 under tini. Deployment `--prepare` builds/checks/generates review configuration before creating secret files or deploying.

The relevant specs and implementation notes change in the same diff. The shared metadata addition needs integration with both client owners before freezing their releases.

## Commands and results

All evidence was produced in this task’s cloud Linux environment with pinned Bun 1.4.2 and frozen-lockfile dependencies.

| Command / check                                                                        | Result                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile`                                                        | Pass; lockfile unchanged.                                                                                                                                                                                                                                                                                  |
| `bun run typecheck`                                                                    | Pass, all seven workspace tasks plus root TypeScript.                                                                                                                                                                                                                                                      |
| `bun run lint`                                                                         | Pass.                                                                                                                                                                                                                                                                                                      |
| `bun run format:check`                                                                 | Pass.                                                                                                                                                                                                                                                                                                      |
| `bun run check:versions`                                                               | Pass; container pins unchanged.                                                                                                                                                                                                                                                                            |
| `TURBO_FORCE=true bun run test`                                                        | Pass, seven uncached tasks. Worker 729, UI logic 294, components 16, protocol 201, settings 9, cities 3; daemon host 116 passed with 3 image-only skips. Adapter suite skipped 40 without configured binaries; hosted e2e skipped 44 without a URL. These skips are not acceptance evidence.               |
| `bun run build`                                                                        | Pass, application and compiled Linux daemon.                                                                                                                                                                                                                                                               |
| `bun run protocol:gen` and `bun run protocol:fixtures` plus fixture check              | Pass; 370 generated fixture outputs checked.                                                                                                                                                                                                                                                               |
| `cargo test -p tempo-protocol -p protocol-gen`                                         | Pass, 16 tests on pinned Rust 1.97.0.                                                                                                                                                                                                                                                                      |
| `TEMPO_TEST_MOUNT_SOURCE=1 TEMPO_BUILD_CA=<combined-CA> bun run test:tempod:container` | Final image built at 3,171,713,879 bytes (under 6 GB), id `sha256:021277d3cdb454ebb8d532ed3ba98cc885fd1575dd744b1ab67bb08208a630b9`. Docker could not create the test container: `no space left on device`. Final-source image test execution is blocked on runner capacity; it is not recorded as passed. |
| Offline pinned OpenCode host conformance                                               | 5 passed, 3 live skips, 0 failed. Actual ACP v1 initialize/new/mode setter/load/cancel checks.                                                                                                                                                                                                             |
| Experimental `0.0.0-tui-v2-202606261840` evaluation                                    | Initially 3 passed / 2 failed under the old session modes assertion. With advertised ACP mode options: 5 passed / 3 live skips / 0 failed. Same interface as 1.18.35; no production upgrade.                                                                                                               |
| `bun scripts/deploy-worker.ts --prepare` with review placeholders                      | Pass; generated configuration, no deploy or secret file.                                                                                                                                                                                                                                                   |

The prior complete pinned production image was 3,171,709,181 bytes (under 6 GB), id `sha256:0996f62ba19d8fefec90ab7e5ca4cc1762ffd785fc55b7dc52108b6867854744`. Its full daemon suite passed 117 tests, zero failures, before the final mode changes. Its offline real-adapter conformance was Claude 5 pass, Pi 5 pass, Codex 1 pass / 4 authentication failures, OpenCode 3 pass / 2 old-interface failures; each had 3 live skips. These historical failures are recorded rather than hidden. The OpenCode interface failures are addressed and independently retested above; Codex requires a real login before `session/new`.

Sanitized adapter reports are committed under `docs/evidence/core/`; host reports name their environment distinctly. Reports omit stderr and credentials. Full command output was retained in the task execution environment. No hosted URL exists and no repeated-run evidence was produced.

## Acceptance and security evidence

| Gate / IDs                                       | Status and remaining proof                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Gate A, S1–S10 and additional Mac spikes S11–S16 | Blocked. Local image/adapter results are partial evidence only. Cloudflare start/exec/PTY/proxy/snapshot/destroy loops, private-repo egress, real subscription/provider turns and refresh sync, 10,000-event redeploy recovery, wake timings and memory measurements remain unproved. Mac spike evidence belongs with the Mac owner. |
| Gate B, AT-1–AT-8                                | No hosted runs. Needs owner/non-owner login, creation/streaming/permissions/checkpoints, sleep/wake and loss/fresh-path recovery, each passing three consecutive runs.                                                                                                                                                               |
| Gate C, AT-9–AT-16                               | No hosted runs. Needs simultaneous workspaces, all adapters, cross-container Codex refresh, review/revert, Conductor mapping, PTY reconnect and preview/Playwright, each passing three consecutive runs.                                                                                                                             |
| Gate D, AT-17–AT-22 and credential-leak audit    | No hosted runs. Needs GitHub PR/merge, archive/restore, egress policy, browser/phone/shortcut cases, plus zero credential matches in Worker logs, SQLite events and unpacked R2 objects.                                                                                                                                             |
| Gate E, AT-23–AT-37                              | Needs the Mac owner, macOS/platform access and deployed core; no native manual acceptance claimed.                                                                                                                                                                                                                                   |

Worker tests cover failure/replay ordering, empty credential event receipts, required safety checkpoints, metadata validation and backup exclusions. Daemon tests cover immutable checkpoint retry and process limits; mode tests cover config-only adapters, grouped choices, failed setters, reload and config updates. The diff was reviewed for credential persistence and propagation boundaries. No real credential was configured, so a production credential-leak audit cannot be claimed. The failed concurrent image attempts and final single-container attempt exhausted this runner’s vfs Docker storage. Docker reported zero remaining containers after the failures; deleting this task’s images and pruning build cache recovered working space, but failed vfs clones prevented a final test container from fitting. Incomplete health smoke output is not evidence of success.

## Required inputs to complete the goal

A concrete review configuration and preparation instructions are committed under `docs/deployment/`. Its `.invalid` hosts, zero owner id and zero D1 UUID are explicit placeholders.

1. Provide a clean/larger Docker runner that can create a full 3.17 GB production-image container, then run the final daemon suite and all four offline adapters sequentially in it. The earlier image suite and current host checks do not waive this requirement.
2. Choose and explicitly authorize an isolated Cloudflare test account with Workers Paid; supply account id, owned `APP_HOST` and separate `PREVIEW_DOMAIN`, owner GitHub numeric id and a disposable GitHub repository. Configure Cloudflare credentials through the supported cloud credential configuration. Allow the Cloudflare API and chosen test hosts in the environment network policy.
3. Authorize test deployment/provisioning and paid live evaluations. Supply Claude/Codex real logins and required provider credentials through Tempo’s credential flow, never in reports or repository files.
4. Run the specified spikes and each included Gate B–D test three consecutive times against that deployment. Collect the actual environment URL, run IDs, timings, outcomes and credential-leak audit evidence.
5. Integrate the optional metadata field with both client owners, complete shared reconnect/security acceptance, and obtain native/manual Gate E evidence with the Mac owner. Browser Run/private-preview design decisions remain pending; this change does not adopt either proposal.

Missing access and evidence are blockers to completion, not waived requirements. No gate should be marked complete from this report’s local tests.
