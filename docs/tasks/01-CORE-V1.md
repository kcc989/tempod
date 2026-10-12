# Goal 1: complete Tempo core

## Objective

Complete the shared core of Tempo's full agent workspace product. Make the Worker, Durable Objects, daemon, container, agent adapters, shared protocol and deployment tooling meet the specification and work with both clients. Deliver implementation and acceptance evidence, not just a passing unit suite.

This is one of exactly three parallel goals: **core**, **web client**, and **Mac client**. Core owns shared contracts and integration. The web agent owns the complete browser client. The Mac agent owns the complete native client, including review and terminal features. There is no separate fourth coordinator.

## Start in the cloud

- Repository: [kcc989/tempod](https://github.com/kcc989/tempod).
- Integration branch: `claude/great-franklin-xc39l8`; [existing PR #1](https://github.com/kcc989/tempod/pull/1).
- Published reference at preparation: `63761dea83a7456addfeae18f88886309edc0e78`. This is a reference, not a claim that it remains the latest commit.
- Use the repository connected to your cloud task, or clone it into an isolated cloud checkout. Fetch the integration branch and agree on the starting commit with the other two agents. Do not use another agent's working directory or unpublished changes. Use your own `codex/` task branch.
- This goal has no dependency on the original author's computer, home directory, local worktrees, Colima engine, or local test logs. Record evidence produced in your own environment.

Read [AGENTS.md](https://github.com/kcc989/tempod/blob/claude/great-franklin-xc39l8/AGENTS.md), [PROGRESS.md](https://github.com/kcc989/tempod/blob/claude/great-franklin-xc39l8/docs/PROGRESS.md), and [IMPLEMENTATION_NOTES.md](https://github.com/kcc989/tempod/blob/claude/great-franklin-xc39l8/docs/IMPLEMENTATION_NOTES.md). The source of truth is [spec tabs 00–07](https://github.com/kcc989/tempod/tree/claude/great-franklin-xc39l8/docs). Read the relevant tab before changing an area; core primarily follows tabs 00, 01, 02, 03, 05 and 06, plus tab 07's server requirements. These GitHub references remain usable outside a local checkout.

## Ownership

Own the Worker backend: server functions, HTTP/API handlers, auth, Durable Objects, schemas/migrations, GitHub integration, egress and Worker entry. Also own the daemon, container, shared protocol, settings parser, shared protocol generation, adapter conformance, deployment configuration and core tests.

Do not implement browser components or native views. The web agent owns browser routes and client state; the Mac agent owns the native app, client transport and terminal crate. Coordinate files that mix browser pages with server handlers. Core owns final integration of shared manifests, lockfiles, CI, protocol generation and shared progress updates. Agree on exact shared-file edits before applying them.

## Required work

1. Audit the current implementation against every core requirement, lifecycle invariant, spike and gate in the spec. Inspect existing behavior before rebuilding it. Separate missing code from missing proof.
2. Complete workspace creation, setup, queue execution, streaming, permissions, cancellation, checkpoints, git operations, scripts, terminals, previews, sleep/wake, archive/restore and deletion. Test failure recovery and idempotency at each boundary.
3. Preserve both message paths: Enter queues a prompt; **Send now** injects steering into an active turn only when the adapter advertises support. Verify ordering, queue edit/delete/reorder, host-owned fallback when a turn settles, message deduplication and durable recovery after an uncertain acknowledgement or DO restart. Never replace live steering with stop-and-restart.
4. Complete authentication, owner enforcement, device sign-in, device revocation, cookie/bearer API rules, all three channels and Mac download/update server contracts. Supply both clients with generated, versioned contracts and compatible fixtures.
5. Verify the full container image and all four pinned agent adapters. Use ACP v1, the specified Sandbox SDK 1.0 APIs and the prescribed credential/egress boundaries. Complete required feasibility results and adapter conformance with real logins when authorized.
6. Complete migration, deployment, observability, diagnostics and operational recovery tooling. Prepare a concrete, reviewable test deployment. Select accounts, deploy, spend money or run paid model evaluations only with explicit authorization; continue independent implementation while required access is pending.
7. Coordinate shared API changes with both client agents before freezing them. Wire types live only in the shared protocol package; regenerate TypeScript/Rust contracts and fixtures. Update the relevant spec in the same change when behavior changes.
8. Run shared integration and security acceptance with both clients. Include reconnects, event replay, container loss, snapshot failure, setup failure, credential failures and the specified credential-leak audit. Private-preview/Browser Run proposals remain pending owner decisions; do not invent or silently adopt a design.

## Rules and verification

Follow repository instructions. Keep secrets out of logs, reports, D1, events, R2 and container start configuration except the specified per-start daemon token. Only the workspace's own DO writes its SQLite and workspace row, except the documented first insert. No daemon outbound request before `hello`. Ask before adding libraries and pin approved versions. If the spec is silent or inconsistent, state the conflict and ask instead of guessing.

Run root `bun run typecheck`, `bun run lint`, `bun run test`, `bun run format:check`, `bun run check:versions` and applicable builds. Every changed server function, op step and daemon request needs a test. DO tests use the specified Worker pool; daemon tests must run in the complete Linux container image. Read the installed Turbo documentation before changing task orchestration.

Use the [e2e setup guide](https://github.com/kcc989/tempod/blob/claude/great-franklin-xc39l8/tests/e2e/README.md) and [adapter conformance guide](https://github.com/kcc989/tempod/blob/claude/great-franklin-xc39l8/tests/conformance/README.md). Isolate test repositories and environments. Gates B–D require every included test to pass three consecutive runs against a deployed test environment with real logins. Gate A requires all specified spike results and matching specs. Coordinate native Gate E evidence with the Mac agent. Skips, mocks and unit tests do not close these gates.

## Deliverable and completion

Deliver commits and an integration-ready diff on your task branch. Provide a standalone Markdown report named **CORE-RESULTS.md** with the starting/final SHA, contract changes, commands and results, environment URLs, acceptance IDs and repeated-run evidence, security evidence and unresolved requirements. Use GitHub/HTTPS links, not workstation paths. Publish or merge only within the task's explicit authorization.

Core is complete only when its required behavior and acceptance evidence are proved and both clients can use the agreed contracts. Missing credentials, deployment approval, platform access or manual evidence are blockers to completion, not alternative definitions of done. Report their exact required input while completing all other available work.
