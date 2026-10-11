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

Alchemy may prompt to bootstrap its remote state store on the first interactive deployment. In CI, bootstrap the store first using Alchemy’s Cloudflare provider bootstrap command, or run `bun run deploy --yes` to authorize the bootstrap as part of the deployment. Keep the same account/profile/state store across deployments so generated secrets remain stable.

The normal deploy creates/migrates D1 `tempo`, creates R2 `tempo-data`, supplies `DB`/`DATA` and the three DO bindings, and generates `TEMPO_ENCRYPTION_KEY`, `BETTER_AUTH_SECRET` and `TEMPO_SETUP_TOKEN`. Do not rotate those secrets to fix a routine deploy, or manually replace the normal flow with the placeholder JSON. The extra `TEMPO_D1_DATABASE_ID`, `TEMPO_D1_DATABASE_NAME` and `TEMPO_R2_BUCKET_NAME` inputs are only needed when calling the lower-level preparation/deploy script yourself.

Open the setup URL printed by the deploy to create the GitHub App, install it on the repositories Tempo should access, then sign in as the configured owner. Claude/Codex logins and provider API keys can be linked manually later through Tempo; do not add them to the container start environment. Without agent credentials, app setup and owner sign-in can be completed, but live agent turns cannot be verified.

This checklist describes the current deployment implementation. The hosted container API/egress/snapshot paths and acceptance gates remain unverified until an actual deployment is exercised.
