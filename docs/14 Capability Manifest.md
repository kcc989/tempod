# 14 Capability Manifest

Status: **Draft.** Waits for the owner's answers to Open questions. It extends 01 (Credentials and egress, Environments, Agent profiles), 05 and 12, and 13 (L-ADR-3).

Each agent session gets one manifest. It tells the agent what it can read, call and deploy. `TempoOutbound` enforces it. The agent learns its access from the manifest, so it does not guess (ACCESS_UNAWARE), ask for keys (API_KEYS), restate the stack (STACK) or fight Cloudflare tokens (CF_PERMS).

Agents stay on ACP v1. The manifest reaches the agent through the `tempo` MCP server and the first content block. It adds no ACP method.

## Decisions

### C-ADR-1. Compiled, versioned and frozen per session

- Tempo compiles the manifest from the project profile (13), the workspace's environment (01), the deploy configuration (12) and the session kind.
- `schemaVersion` is the format. It is `1`. A change to the format adds a new number; old sessions keep theirs.
- `revision` counts changes for each project. `sha256` is the hash of the canonical JSON.
- A session stores `{revision, sha256}` when it starts and uses that manifest until it ends, as it does with its agent profile (01). A changed manifest applies to new sessions. The owner can apply it to a running session with one action, which starts the next turn with the new manifest.

### C-ADR-2. Capabilities, not hosts

A capability names something the agent can do. The egress rules in 01 become checks of a capability. A request that matches no granted capability is refused with a reason the agent can read.

### C-ADR-3. No secret value in the manifest or the container

The manifest names credentials by reference only. Values stay in CredentialDO. `TempoOutbound` swaps a placeholder for the value, as rules 4–6, 12 and 14 do today.

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

- A refusal returns 403 with body `tempo: capability <id> not granted for <host>`, or `tempo: no capability for <host>`. The agent reads this text, so it can tell the owner what to add.
- `egress_log` gets a new column `capability` with the id used, or empty.
- `deploy_app` checks `deploy[]` before 12's own checks.

## Open questions

1. **M-Q1. "No secret enters a container."** Today three kinds do: the Claude OAuth token (process env, D11), the Codex `auth.json` (a file, D11), and environment and project secrets with no `hosts` (01, Environments). Options: (a) keep D11 as a named exception, because each CLI owns its own login, and refuse secrets with no `hosts` for loop projects; (b) remove all three, which needs a proxy for the Claude and Codex logins and is not shown to work.
2. **M-Q2. Cloudflare from the workspace.** May an agent call `api.cloudflare.com` from a workspace (for example `wrangler dev --remote`, D1 queries on a preview database) with a minted token swapped by `TempoOutbound`, as in deploy mode? Or only through `tempo` MCP tools?
3. **M-Q3. Live changes.** Is frozen-per-session with an owner "apply" action right, or must a revoked capability stop at once in running sessions?
4. **M-Q4. Method limits.** Are `methods` enough for `call`, or do some services need path limits too?
5. **M-Q5. Where the profile and manifest are stored.** Rule 4 lets only a WorkspaceDO write its own SQLite. The profile is per project. A new project-level DO (like `AppDeployDO`), or D1 `projects.settings_json`?
