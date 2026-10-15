# 14 Capability Manifest

Status: **Draft, partly approved** (2026-10-15). It extends 01 (Credentials and egress, Environments, Agent profiles), 05, 12 and 13 (L-ADR-3, L-ADR-8).

In short: the **project profile** (13) is what the owner writes once about a project. The **manifest** is what Tempo makes from it for one agent session: the exact list of what that agent may read, call and deploy. The agent reads the list, so it knows what it can use. `TempoOutbound` checks every request against the list, so the agent cannot use more.

Each agent session gets one manifest. It tells the agent what it can read, call and deploy. `TempoOutbound` enforces it. The agent learns its access from the manifest, so it does not guess (ACCESS_UNAWARE), ask for keys (API_KEYS), restate the stack (STACK) or fight Cloudflare tokens (CF_PERMS).

Agents stay on ACP v1. The manifest reaches the agent through the `tempo` MCP server and the first content block. It adds no ACP method.

## Decisions

### C-ADR-1. Compiled, versioned and frozen per session

- Tempo compiles the manifest from the project profile (13), the workspace's environment (01), the deploy configuration (12) and the session kind. The profile and deploy configuration are stored in the project's `AppDeployDO`.
- The WorkspaceDO stores the compiled manifest of each session in its own SQLite, with the session. No other DO writes it (rule 4).
- `schemaVersion` is the format. It is `1`. A change to the format adds a new number; old sessions keep theirs.
- `revision` counts changes for each project. `sha256` is the hash of the canonical JSON.
- A session stores `{revision, sha256}` when it starts and uses that manifest until it ends, as it does with its agent profile (01). A changed manifest applies to new sessions. The owner can apply it to a running session with one action, which starts the next turn with the new manifest.

### C-ADR-2. Capabilities, not hosts

A capability names something the agent can do. The egress rules in 01 become checks of a capability. A request that matches no granted capability is refused with a reason the agent can read.

### C-ADR-3. No secret value in the manifest or the container

The manifest names credentials by reference only. Values stay in CredentialDO. `TempoOutbound` swaps a placeholder for the value, as rules 4–6, 12 and 14 do today.

**Named exceptions (owner-approved 2026-10-15).** These enter the container, as 01 specifies today. The manifest lists each one under `exceptions`, so the agent and the owner can see them:

| Exception | Why |
|---|---|
| Claude OAuth token, as env of the adapter process (D11) | The `claude` CLI owns its login |
| Codex `auth.json`, as a 0600 file (D11) | The `codex` CLI owns its login and refresh |
| Environment and project secrets with no `hosts` (01, Environments) | Scripts that need a raw value; the UI marks them "visible to the agent" |

## Format

Effect Schema `CapabilityManifest` in `packages/protocol`.

```yaml
schemaVersion: 1
projectId: <projectId>
revision: 7
sha256: 3f1c…
session: {kind: chat, access: write}        # kind: chat | run | deploy | ci
stack:                                      # from the profile; text only
  runtime: bun 1.3
  frameworks: [TanStack Start, Effect v4]
read:
  - repo                                    # the workspace's own repository
  - deployments                             # list_deployments, get_deployment, get_deployment_log
  - prod_errors                             # get_prod_error (13, L-ADR-5)
call:
  - id: stripe
    hosts: [api.stripe.com]
    credential: {ref: STRIPE_KEY, placeholder: tempo-secret-STRIPE_KEY}
    methods: [GET, POST]
  - id: openrouter
    builtin: true                           # rules 4–6
cloudflare:                                 # 13, L-ADR-8
  resources: [farstep-web, farstep-core, farstep-app-db-preview]
  permissions: [workers, d1]                # 12, Permissions; read for all, write per L-ADR-8
exceptions: [claude_login, secrets_without_hosts]
deploy:
  - target: preview
    workers: [farstep-web, farstep-core]
    cloudflare: [workers, d1]               # 12, Permissions
    agent: true
```

| Field | Rule |
|---|---|
| `read` | Closed list: `repo`, `deployments`, `prod_errors`, `issues`, `pull_requests`, `ci_runs`. Each maps to `tempo` MCP tools. Tools not granted are not listed. |
| `call[]` | `id` unique. `hosts` are patterns as in 05. `credential.ref` names an environment secret or a built-in key. `methods` is optional; empty means all. |
| `cloudflare` | The project's Cloudflare resources and the permissions of the session token (13, L-ADR-8). Absent means the agent cannot call `api.cloudflare.com`. |
| `exceptions` | The named exceptions (C-ADR-3) that apply to this session |
| `deploy[]` | One entry per deploy target with `agent: true` in 12. `cloudflare` is a subset of the target's permissions. |
| Session kind | `run` sessions with `read-only` access get no `deploy` and no `call` methods other than `GET` and `HEAD`. `ci` and `deploy` sessions keep their rule sets from 10 and 12. |

## Delivery to the agent

1. The first content block of the first turn has a summary: the stack, each `read` item, each `call` id with its hosts, and each `deploy` target. At most 30 lines.
2. The `tempo` MCP tool `get_capabilities` returns the full manifest, without `sha256` detail.
3. Tools in the `tempo` MCP server that need a capability are listed only when it is granted.

## Enforcement in `TempoOutbound`

`getEgressConfig()` (01) returns the session's manifest with the rest of its config. The rules in 01 keep their order. Each rule that adds a credential or passes a host checks a capability first:

| 01 rule | Capability needed |
|---|---|
| 2, 3 (GitHub) | `read: repo` for fetch; a write session for push |
| 4, 5, 6 (model keys) | A `call` entry with `builtin: true` for that provider, or the agent's own login |
| 12 (MCP headers) | A `call` entry for that server's host |
| 13, 14 (injectors, secret swap) | A `call` entry whose `hosts` match and whose `credential.ref` names that secret |
| 9 (allowlist pass) | A `call` entry for the host, or a built-in agent host |
| New: `api.cloudflare.com` with `Bearer tempo-placeholder` | `cloudflare`; then the checks of 13, L-ADR-8 |

- A refusal returns 403 with body `tempo: capability <id> not granted for <host>`, or `tempo: no capability for <host>`. The agent reads this text, so it can tell the owner what to add.
- `egress_log` gets a new column `capability` with the id used, or empty.
- `deploy_app` checks `deploy[]` before 12's own checks.

## Open questions

Answered on 2026-10-15: M-Q1 (named exceptions, C-ADR-3), M-Q2 (Cloudflare API allowed with checks, 13 L-ADR-8), M-Q5 (storage, C-ADR-1).

1. **M-Q3. Live changes.** When the owner removes a capability, does it stop at once in running sessions, or only in new sessions (with an "apply now" action)? The draft says new sessions.
2. **M-Q4. Path limits.** Is a list of HTTP methods enough to limit a `call`, or do some services need path limits too?
