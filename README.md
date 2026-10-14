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

`bun run mac:dev` builds the app and terminal helper, then opens the native app on a Mac. After signing in, the Terminal panel can open a cloud shell in Terminal.app or iTerm.

To use any local terminal, run the bundled command:

```sh
/Applications/Tempo.app/Contents/MacOS/tempo terminal lisbon
/Applications/Tempo.app/Contents/MacOS/tempo terminal <workspace-id> t2
```

The command reuses the app's saved Keychain sign-in. Commands and files belong to the cloud workspace. Ctrl+C goes to the cloud shell; Ctrl+] disconnects locally and leaves tmux running. `bun run mac:bundle` builds a local app bundle containing both binaries. After installing the app, `bun run mac:install-cli` links the helper into `~/.local/bin`; add that directory to PATH to use `tempo terminal lisbon`.

With Docker available, `bun run test:tempod:container` builds the pinned Linux workspace image and runs daemon tests in a derived test image as user `tempo`. It checks the production image's 6 GB size limit. On shared engines, serialize this command with other full CI runs.

Deployed e2e and adapter conformance tests skip until their environments and logins are configured. They remain required for the gates in [`06 Build Plan`](docs/06%20Build%20Plan.md). Deployment requires a Workers Paid account and explicit owner approval.
