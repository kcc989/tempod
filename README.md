# Tempo

Tempo is an owner-operated Git forge and agent workspace on Cloudflare. It hosts repositories in Cloudflare Artifacts, browses code and commit history, and manages pull requests and issues in Tempo. GitHub-linked repositories remain supported. Workspaces add a branch, a container, agent chats, checkpoints, terminals and previews. The web app runs on Workers; Tempo for Mac uses GPUI Kit.

The spec in [`docs/`](docs/00%20Overview.md) is the source of truth. [`09 Git Forge`](docs/09%20Git%20Forge.md) defines the Artifacts extension. See [`docs/PROGRESS.md`](docs/PROGRESS.md) for verified work, remaining work and acceptance gates. The product is still in development.

Open **Repositories** to create a repo, import a public HTTPS Git remote, or link an existing Artifacts repo. Native repos support folder and file browsing, branch/tag/commit refs, commit history, and pull request creation, editing, closing and reopening. Issues support creation and editing, close/reopen, comments, and colored labels in both clients. Open a PR in a workspace to review its diff and merge or squash it. Native merges preserve workspace edits and reject conflicts or concurrent remote changes. Artifacts repositories have no CI checks integration yet.

Agents can read, create, update, delete and comment on the workspace repository's issues through the `tempo` MCP tools. Write runs and interactive chats can change metadata; read-only runs can read it. Frozen tool permissions apply, and agents cannot override the project or author. Deleted issue numbers are never reused.

Deployment binds `ARTIFACTS` to `tempo-repos`; set `TEMPO_ARTIFACTS_NAMESPACE` to use another namespace. Artifacts requires Workers Paid. Apply the preservation-tested D1 and DO migrations and use Tempo for Mac 0.2.0 or newer. GitHub remains the owner sign-in provider, while native repo storage and PR operations do not require a GitHub repository or installation.

## Local development

Use Bun 1.4.2. Rust is pinned in `rust-toolchain.toml`.

```sh
bun install --frozen-lockfile
bun run dev
```

The web app needs the owner and GitHub App setup described in [`05 Security and Ops`](docs/05%20Security%20and%20Ops.md). Local tests use fake containers and test credentials; a local test pass does not prove a hosted agent session works.

Wrangler's Artifacts binding uses the real cloud service during local development; it has no local simulator. The test suite uses explicit fake capabilities.

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

## Local Mac terminal

The Mac process panel can open its cloud shell in Terminal.app or iTerm. After signing in to the Mac app, run `tempo terminal <workspace-id-or-slug> [t1..t9]` from any terminal to attach to the same cloud tmux session. Ctrl+C goes to the cloud shell; Ctrl+] disconnects locally.

`bun run mac:bundle` builds the signed development bundle with both the CLI and the stable Keychain helper. After installing Tempo.app, `bun run mac:install-cli` installs the CLI symlink in `~/.local/bin` without replacing an existing command; add that directory to PATH. The bundled executable can also be run directly as `/Applications/Tempo.app/Contents/MacOS/tempo terminal lisbon`.
