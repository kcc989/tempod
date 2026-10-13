# Tempo

Tempo is a self-hosted agent workspace for one owner. Each workspace has a GitHub branch, a container, agent chats, checkpoints, terminals and previews. The web app runs on Cloudflare Workers; Tempo for Mac uses GPUI Kit.

The spec in [`docs/`](docs/00%20Overview.md) is the source of truth. See [`docs/PROGRESS.md`](docs/PROGRESS.md) for verified work, remaining work and acceptance gates. The product is still in development.

## Local development

Use Bun 1.4.2. Rust is pinned in `rust-toolchain.toml`.

```sh
bun install --frozen-lockfile
bun run dev
```

The web app needs the owner and GitHub App setup described in [`05 Security and Ops`](docs/05%20Security%20and%20Ops.md). Local tests use fake containers and test credentials; a local test pass does not prove a hosted agent session works.

```sh
bun run typecheck
bun run lint
bun run format:check
bun run check:versions
bun run test
bun run build
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

Oxlint and Oxfmt run through `bun run lint`, `bun run format`, and `bun run format:check`; CI runs both checks. Oxlint also enables all generic and Effect rules from [anti-slop](https://github.com/dmmulroy/anti-slop), vendored in `tools/oxlint/anti-slop/`. The plugin source, license, and upstream revision are recorded in its `UPSTREAM.md`. Oxlint and `@oxlint/plugins` are pinned to the same version and must be upgraded together. Agent assets and the vendored plugin are excluded from linting and formatting.

`bun run test:web` runs local browser acceptance across Chromium, Firefox, WebKit, dark mode and phone width. See [`Web acceptance`](docs/WEB_ACCEPTANCE.md) for the harness, coverage and the hosted test plan using keeled.

`bun run mac:dev` builds and opens the native app on an Apple silicon Mac with macOS 15 or later. First run `bash scripts/mac/setup-dev-signing.sh` to create a local development signing identity, or set `TEMPO_MAC_SIGN_IDENTITY` to an installed identity. Development builds reuse an unchanged `TempoKeychain` helper so UI rebuilds do not invalidate Keychain approval. Choose **Always Allow** for that helper once; it accepts only Tempo signed with the same certificate. Native and hosted acceptance is still pending.

With Docker available, `bun run test:tempod:container` builds the pinned Linux workspace image and runs daemon tests in a derived test image as user `tempo`. It checks the production image's 6 GB size limit. On shared engines, serialize this command with other full CI runs.

Deployed e2e and adapter conformance tests skip until their environments and logins are configured. They remain required for the gates in [`06 Build Plan`](docs/06%20Build%20Plan.md). Deployment requires a Workers Paid account and explicit owner approval.
