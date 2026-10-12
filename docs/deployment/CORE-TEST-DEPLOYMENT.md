# Core test deployment prepared for review

The generated [Wrangler configuration](./core-test.wrangler.jsonc) uses the specified `tempo` Worker, D1 `tempo`, R2 `tempo-data`, three SQLite Durable Objects, `durable_object` container scheduling, the pinned full image and observability. Its `.invalid` domains, zero owner id and zero D1 UUID are conspicuous placeholders, not a deployable account configuration.

Use an isolated Cloudflare test account with Workers Paid and domains owned by the test operator. The deployment needs the following non-secret inputs: Cloudflare account id, `APP_HOST`, separate `PREVIEW_DOMAIN`, owner GitHub numeric id and a disposable GitHub repository. Authentication must be supplied through the supported environment credential configuration. No credential belongs in this document or the review JSON.

`bun scripts/deploy-worker.ts --prepare` builds the daemon, checks versions and writes `apps/tempo/wrangler.deploy.jsonc`, then exits before creating a secret file or deploying. It requires `APP_HOST`, `PREVIEW_DOMAIN`, `TEMPO_OWNER_GITHUB_ID`, `TEMPO_D1_DATABASE_NAME`, `TEMPO_D1_DATABASE_ID` and `TEMPO_R2_BUCKET_NAME`. Review the generated file. Normal `bun run deploy` retains the existing Alchemy provisioning, migrations, generated secrets, Worker/image deployment and GitHub App setup flow. Actual deployment and paid evaluations require the owner's explicit authorization.

For this cloud runner, the complete image can be built with `TEMPO_TEST_MOUNT_SOURCE=1 TEMPO_BUILD_CA=/etc/ssl/certs/ca-certificates.crt bun run test:tempod:container`. The combined CA is a temporary BuildKit secret, not an image layer. The mounted mode runs the tests in the full production Linux image with the frozen Linux dependency tree and current source mounted read-only; it avoids duplicating the image on the runner’s `vfs` Docker storage. Keep the inherited proxy configuration and TLS verification enabled. A writable Docker client config directory may be needed; preserve its existing proxy and registry configuration.

After authorization and deployment, follow the [e2e setup guide](https://github.com/kcc989/tempod/blob/main/tests/e2e/README.md) and [adapter guide](https://github.com/kcc989/tempod/blob/main/tests/conformance/README.md). Configure real Claude/Codex logins and provider keys through Tempo. Run each included Gate B–D acceptance test three consecutive times, including manual cases; run native Gate E with the Mac owner. Collect Worker logs, event rows and unpacked R2 objects for the credential-leak audit. Preserve isolated test repositories and restore any settings the tests temporarily change. A skipped test cannot close a gate.


## Environment settings for running the app

For a normal deployment, configure these in the deployment shell/CI or your managed cloud environment settings. The API token belongs in the secret store; the other four values are configuration.

| Name | Set to |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | A token authorized to deploy Workers/Containers, manage D1/R2 and Worker routes/custom domains, and provision Alchemy’s remote state store in the selected account. Use the permissions required by those services, including Secrets Store for Alchemy state bootstrap. |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account containing the app and preview zones, with Workers Paid and Containers available. |
| `APP_HOST` | The app hostname, without scheme/path, for example `tempo.example.com`. |
| `PREVIEW_DOMAIN` | A separate Cloudflare zone apex, for example `example-previews.com`; not the app hostname or a parent of it. The route generator uses this value as `zone_name`. |
| `TEMPO_OWNER_GITHUB_ID` | The numeric GitHub user id of the account allowed to sign in. For `kcc989`, GitHub currently reports `3671149`; choose a different id if that is not the intended owner. |

Add a proxied wildcard DNS record in the preview zone: type `AAAA`, name `*`, value `100::`. The deployment registers the app custom domain and the preview wildcard Worker route. Make sure both zones are active in the selected account.

Use Bun 1.4.2 and a working Docker/BuildKit daemon that can build and run the full Linux image with sufficient disk space. For a managed runner, allow Cloudflare API access (`api.cloudflare.com`), the chosen app/preview hosts and the registry/package/browser-download hosts used by the pinned image. On a TLS-proxied runner, preserve the session proxy/CA configuration; `TEMPO_BUILD_CA` supports the local image test command, and must not be mistaken for a Wrangler deployment setting.

From the repository root, after setting those values:

```sh
bun install --frozen-lockfile
bun run deploy
```

On the first deployment, run `bun run deploy --yes --no-input` to approve the app plan and bootstrap only after preflight confirms the dedicated Tempo Worker is absent. On later deployments the same command approves the app plan while `TEMPO_STATE_BOOTSTRAP_ALLOWED=0` prevents automatic state bootstrap or upgrades. Always use the wrapper, fixed stage/profile, and patched SDK; do not run a generic provider bootstrap to work around a guard.

The normal deploy creates/migrates D1 `tempo`, creates R2 `tempo-data`, supplies `DB`/`DATA` and the three DO bindings, and generates `TEMPO_ENCRYPTION_KEY`, `BETTER_AUTH_SECRET` and `TEMPO_SETUP_TOKEN`. Do not rotate those secrets to fix a routine deploy, or manually replace the normal flow with the placeholder JSON. The extra `TEMPO_D1_DATABASE_ID`, `TEMPO_D1_DATABASE_NAME` and `TEMPO_R2_BUCKET_NAME` inputs are only needed when calling the lower-level preparation/deploy script yourself.

Open the setup URL saved privately by the deploy to create the GitHub App, install it on the repositories Tempo should access, then sign in as the configured owner. Claude/Codex logins and provider API keys can be linked manually later through Tempo; do not add them to the container start environment. Without agent credentials, app setup and owner sign-in can be completed, but live agent turns cannot be verified.

This checklist describes the current deployment implementation. The hosted container API/egress/snapshot paths and acceptance gates remain unverified until an actual deployment is exercised.

## Dedicated Tempo deployment

Always use `bun run deploy`: the wrapper fixes stage `production` and profile `tempo` across ephemeral runners. Bun applies `patches/alchemy@2.0.0-beta.81.patch` from the lockfile. The pinned patch changes both Bun source and Node runtime paths: Worker `tempo-state-store`, its own Worker-scoped Store DO namespace, bootstrap stack `TempoStateStore`, Secrets Store names `TempoStateStoreToken` and `TempoStateStoreEncryptionKey`, cache file `tempo-state-store-credentials`, and HTTP-state identity `tempo-cloudflare-http`. Bootstrap, hoisting, version probes, upgrades, and cold credential refresh all use these names. The account's single Secrets Store is shared infrastructure, but the two foreign Alchemy secrets must never be changed.

The wrapper checks only the dedicated Tempo store. Existing unhealthy stores fail closed; `--yes` approves the app plan while the SDK bootstrap/upgrade flag is disabled for existing stores. unfinished dedicated local bootstrap files also fail closed rather than replaying secrets. Preserve `.alchemy/state/TempoStateStore` on an interrupted bootstrap and finish its state hoist deliberately. After a successful bootstrap the SDK hoists bootstrap resources into the encrypted remote DO state; subsequent Tempo Random resources persist remotely before Worker deployment. Local credentials and private setup links are caches, never the only durable secret copy.

The unrelated `alchemy-state-store` probably belongs to another project. The previous attempt modified its `AlchemyStateStoreToken` and `AlchemyStateStoreEncryptionKey` at 2026-10-11 23:33 UTC after a blocked health probe was misinterpreted as absence. Whether saved state existed is unknown; recoverability is unverified. Do not touch, bootstrap, destroy, reuse, or recover it as part of Tempo deployment. Preserve any old private `.alchemy/state/CloudflareStateStore/` and `/workspace/alchemy-profile/` files if available. Their recovery is separate and is not a Tempo prerequisite.

The deployment saves the setup-token URL to mode-0600 `.alchemy/tempo-setup-link.txt`, never CLI output or stack outputs. Read that file privately in this workspace. If the runner is lost, the token persists in Tempo's encrypted remote state and normal deployment recreates the private link. Open it, submit the manifest, confirm **Create GitHub App**, follow **Install**, select repositories, and sign in at `https://tempod.dev/login` as `kcc989`. Link agent credentials only through Tempo Settings. No paid evaluations are authorized.


## Managed runner image builds

Pinned Wrangler cannot forward Docker BuildKit secrets. Set `TEMPO_BUILD_CA=/etc/ssl/certs/ca-certificates.crt` on a TLS-proxied runner: the deploy script builds the full pinned image with the existing temporary CA mount, tags it by the Docker image digest, pushes it with Wrangler's normal registry authentication, and passes that image to the Worker deploy. The CA stays out of image layers and TLS verification remains enabled. Preserve Docker proxy/registry configuration in a writable `DOCKER_CONFIG` directory. Set `ALCHEMY_HOME` to a writable dedicated cache directory if the inherited setting targets a read-only home.

The Wrangler command runs on every deployment (`memo: false`), including identical source on a fresh VM, so a successful deploy recreates the private setup-link file from the remotely persisted token. A missing dedicated Worker with surviving dedicated secrets or local bootstrap files fails preflight; inspect and recover that Tempo bootstrap instead of creating new keys.
