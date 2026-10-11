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

`bun run mac:dev` opens the native app on a Mac. Its sign-in and live view wiring are not complete.

With Docker available, `bun run test:tempod:container` builds the pinned Linux workspace image and runs daemon tests in a derived test image as user `tempo`. It checks the production image's 6 GB size limit. On shared engines, serialize this command with other full CI runs.

Deployed e2e and adapter conformance tests skip until their environments and logins are configured. They remain required for the gates in [`06 Build Plan`](docs/06%20Build%20Plan.md). Deployment requires a Workers Paid account and explicit owner approval.
