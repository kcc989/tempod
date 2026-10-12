# 08 Events and Roles

This tab defines two features. **Lifecycle events** put all agent, platform, role and human activity on one typed bus per workspace. **Roles** are TypeScript files, stored as data and loaded at runtime in Cloudflare Dynamic Workers, that start agent sessions when an event or a person asks for them. A new or changed role never needs a redeploy.

Built-in roles use the same path as user roles. The host has no code for any one role.

| # | Decision | Choice | Reason |
| --- | --- | --- | --- |
| E1 | Source of agent events | Map the `tempod` events that the WorkspaceDO already receives. No CLI hooks. | Covers all four agents. Needs no new `tempod` protocol for observation. Works with old `tempod` binaries (05, Upgrades). |
| E2 | Where events live | One ordered log per workspace in WorkspaceDO SQLite. Events with no workspace go to the user's UserHubDO. | The WorkspaceDO is already the source of truth for a workspace (00). |
| E3 | When events are written | In the same SQLite transaction that applies the `tempod` event. Dispatch runs after the commit. | A dispatch failure cannot lose an event. |
| E4 | Role code | Runs in a Dynamic Worker with no bindings and `globalOutbound: null` | Untrusted code, no redeploy, no network |
| E5 | Role run | A new session in the same workspace, through the existing session and turn code | One container per workspace (00). Turns stay serialized. |
| E6 | Access | Read-only roles are guided by a fixed prompt and checked after each turn. Agents keep their default mode (01). | ACP plan and read-only modes differ per agent and block the output file. |
| E7 | Revision | A revision is a checkpoint (01, Durability) with reason `role_pin` | Checkpoints never touch the branch, `HEAD` or the index |
| E8 | Output validation | Inside the role's isolate, with the role's Effect Schema. The host checks only the shape of the result. | No JSON Schema library in the host |
| E9 | Unit of work | A **change**: one user prompt or role request plus every role run it causes | Groups the trace and the budgets |

## Vocabulary

These words join the vocabulary in 00. Use them exactly.

| Term | Meaning | Code name |
| --- | --- | --- |
| Lifecycle event | One typed fact on the bus, in the envelope below. Not the same as an `events` row, which is a raw `tempod` event (02). | `lifecycleEvent` |
| Change | One user prompt or role request, and every role run, turn and event it causes. Not the same as a changed file (`getChanges`, `git.changed`). | `change` |
| Revision | The checkpoint pinned at the start of a role turn. The first one is the role run's revision. | `revision` |
| Role | A named TypeScript file built with `@tempo/roles` | `role` |
| Role version | One build of a role, keyed by the SHA-256 of its source | `roleVersion` |
| Role run | One execution of one role version in one session | `roleRun` |
| Gate | A role's answer to a decision event | `gate` |

## Envelope

Every lifecycle event uses this envelope. It lives in `packages/protocol` as an Effect Schema, as `LifecycleEvent`.

| Field | Type | Rule |
| --- | --- | --- |
| `id` | ULID | Lowercase (02, Conventions) |
| `type` | string | A registered type |
| `version` | integer | The payload schema version. `1` for every type in this tab. |
| `source` | `agent`, `tempo`, `role` or `human` | Who caused it |
| `occurredAt` | integer ms | 02, Conventions |
| `userId` | string | The owner |
| `workspaceId` | ULID, optional | Absent only for events in UserHubDO |
| `changeId` | ULID, optional | The change the event belongs to |
| `revision` | ULID, optional | A checkpoint id |
| `turnId` | ULID, optional | The turn the event belongs to |
| `roleRunId` | ULID, optional | Set on every event of a role run and of its session |
| `agent` | `claude`, `codex`, `opencode` or `pi`, optional | The agent of the session |
| `sessionId` | ULID, optional | The Tempo session id, never the ACP session id |
| `causationId` | ULID, optional | The event that caused this one. Absent for an origin event. |
| `correlationId` | ULID | `changeId` when set, else `id` |
| `chainDepth` | integer | The number of `role.run.started` events in the causation chain, this one included |
| `dedupeKey` | string | Unique per workspace log (below) |
| `payload` | object | Validated against the type's schema |

**Dedupe keys**

| Origin | Key |
| --- | --- |
| A `tempod` event | `tempod:<incarnation>:<seq>:<type>` |
| A DO request it sends itself (prompt, steer, session start) | `req:<request id>:<type>` |
| An op step | `op:<opId>:<step>:<type>` |
| A role run | `run:<roleRunId>:<type>:<n>`, where `n` counts that type within the run |
| A server function | `fn:<call id>:<type>`, where the call id is a ULID made by the function |

**Rules**

- Write a lifecycle event for a `tempod` event only when the raw `events` insert stored a row. A duplicate `(incarnation, seq)` writes nothing.
- `incarnation.changed` deletes raw `events` rows of that incarnation (02). It MUST NOT delete lifecycle events.
- A payload MUST NOT copy transcript text, tool `rawInput` or `rawOutput`, file contents, prompts or env. It refers to them by `itemId` or `turnId`. Role outputs and request text are the only free text, and each is capped at 64 KiB.
- Secrets MUST NOT be in a lifecycle event (05).

## Registry

The registry lives in `packages/protocol`. Each entry has a type, a version, an Effect Schema for the payload, and, for a decision event, a decision schema, a deadline and a default answer.

- An event with an unknown type, or a payload that fails its schema, is rejected with `EVENT_INVALID`. Nothing is written.
- The SDK uses the same registry, so `on("role.run.completed", (e) => …)` gets a typed payload.
- Namespaces: `agent.*`, `tempo.*`, `role.*`, `human.*` and `custom.<role>.*`.
- A role declares its custom types in its manifest, with a JSON Schema for each. Tempo registers them when the role version is approved. A custom payload is decoded in the emitting role's isolate before it leaves the isolate; the host checks the type, the role and the 64 KiB cap.

## Event vocabulary

**Agent events** (`source: "agent"`), mapped by the WorkspaceDO from what it already sends and receives.

| Type | From | Payload |
| --- | --- | --- |
| `agent.session.started` | `session.start` result | `sessionId, reloaded, handoff` |
| `agent.prompt.submitted` | The DO sends `session.prompt`, or `session.steer` returns `injected` | `turnId, delivery: "prompt" or "steer", origin: "user", "role" or "continue"` |
| `agent.plan.updated` | `item.created` or `item.updated` on a `plan` item | `itemId` |
| `agent.tool.started` | `item.created` with kind `tool_call` | `itemId, toolKind` |
| `agent.tool.finished` | A `tool_call` item reaches `completed` or `failed`, in `item.created` or `item.updated` | `itemId, toolKind, status` |
| `agent.tool.before` (decision) | `permission.requested` | `requestId, itemId, optionKinds` |
| `agent.usage.updated` | `session.updated` with `usage`, at most one per session per 10 s | `usage` (as reported) |
| `agent.turn.ended` (decision) | `turn.ended` | `turnId, status: "completed", "cancelled", "failed" or "interrupted", stopReason, errorCode?, usage?` |
| `agent.process.exited` | `agent.exited` | `reason: "crashed", "evicted" or "cancelled", code, signal` |
| `agent.session.ended` | `closeSession` | `sessionId` |
| `agent.role.requested` | `role.requested` from the `run_role` tool (Explicit triggers) | `role, text, turnId` |

`status` in `agent.turn.ended` uses the turn status rules in 03. `agent.usage.updated` is for display only: an ACP usage update reports context use, not spent tokens. Budgets use `TurnUsage` from `agent.turn.ended`.

**Platform events** (`source: "tempo"`)

| Type | When | Payload |
| --- | --- | --- |
| `tempo.workspace.created` | `WorkspaceDO.init` | `projectId, branch, baseBranch, sourceKind` |
| `tempo.change.created` | A turn is queued in a session with no `role_run_id`; or a role request arrives (Explicit triggers) | `changeId, originSessionId?, origin: "prompt" or "request"` |
| `tempo.change.ended` | A change has no queued or running role run, no pending decision, and its last event has been dispatched | `changeId, status: "done", "failed" or "cancelled"` |
| `tempo.revision.pinned` | A `role_pin` checkpoint row is written | `checkpointId, commitSha, treeSha, roleRunId` |
| `tempo.branch.pushed` | A `commit_push` op ends `done` | `branch, commitSha` |
| `tempo.check.passed`, `tempo.check.failed` | `checks_state` changes to `success` or `failure` (03, Status polling) | `prNumber` |
| `tempo.run.timed_out` | A role run passes its deadline | `roleRunId` |

Status polling runs only while a UI socket is open (03). So `tempo.check.*` arrives only then.

**Role events** (`source: "role"`)

| Type | When | Payload |
| --- | --- | --- |
| `role.run.started` | A role run passes its limits and is inserted | `role, sourceHash, round, agent, access, args?` |
| `role.run.completed` | The output is valid, after `transform` | `role, sourceHash, round, revision, resultRevision, output` |
| `role.run.failed` | Any failure (Error codes) | `role, sourceHash, round, errorCode, detail?` |
| `custom.<role>.<name>` | `emit` from that role's `transform` | As declared |

**Human events** (`source: "human"`)

| Type | When | Payload |
| --- | --- | --- |
| `human.requested` | `requestRole` | `role, text?, args?, sessionId?` |
| `human.approved`, `human.rejected` | `approveRoleVersion`, `rejectRoleVersion` | `role, sourceHash, scope` |

Approval events with no workspace go to UserHubDO.

**Causation**

- `tempo.change.created` is an origin event. It has no `causationId`.
- `agent.prompt.submitted` is caused by `tempo.change.created` (first turn of a change), `role.run.started` (first turn of a run), or the `agent.turn.ended` that decided to continue.
- Other agent events of a turn are caused by that turn's `agent.prompt.submitted`.
- `role.run.started` is caused by the event that matched, or by the request event.
- `role.run.completed` and `role.run.failed` are caused by the event that ended the run.

## Decision events

Two event types wait for an answer.

| Type | Answers | Merge: most restrictive wins | Deadline | Default |
| --- | --- | --- | --- | --- |
| `agent.tool.before` | `allow`, `deny` or `ask` | `deny` > `ask` > `allow` | 5 s | `allow` |
| `agent.turn.ended` | `accept`, or `continue` with a reason | `continue` > `accept`; reasons are joined, one per line | 10 s | `accept` |

- Subscribers are the active roles with a gate on that type (Manifest). A gate answers through `decide(event, ctx)`.
- A gate that throws or passes the deadline gives the default, unless its manifest sets `onFailure: "block"`. Then it gives `deny`, or for `agent.turn.ended` it fails the role run of that session with `ROLE_GATE_FAILED` (in a user session, it shows a notice and gives `accept`).
- The result is stored in `decisions` and is shown in the trace.

**`agent.tool.before`**

- In their default modes (01), agents seldom send `session/request_permission`. This event fires only when one does.
- With no gate, or with the result `ask`, the request goes to the user as before (03, While it runs).
- `allow` answers with the first option of kind `allow_once`. `deny` answers with the first option of kind `reject_once`. If that kind is not offered, the request goes to the user. Tempo MUST NOT choose `allow_always` or `reject_always`.

**`agent.turn.ended`**

- The agent has already stopped. The decision only says what the DO queues next.
- In a role session, the run rules (Role run lifecycle, step 7) run first. Gates are asked only when the run would end.
- While a decision is pending, the queue runner MUST NOT start a turn (03, Queue runner).
- `continue` inserts a turn on the same session at the head of the queue: `origin: "continue"`, prompt text = the joined reasons. It is not the first prompt of the session, so the turn-summary rule and `prompts.general` are not added again (01).

## Storage

**WorkspaceDO SQLite** (migration `0006_lifecycle`)

```sql
CREATE TABLE lifecycle_events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,  -- log order
  id             TEXT NOT NULL UNIQUE,
  type           TEXT NOT NULL,
  version        INTEGER NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('agent','tempo','role','human')),
  occurred_at    INTEGER NOT NULL,
  change_id      TEXT,
  revision       TEXT,
  turn_id        TEXT,
  role_run_id    TEXT,
  agent          TEXT,
  session_id     TEXT,
  causation_id   TEXT,
  correlation_id TEXT NOT NULL,
  chain_depth    INTEGER NOT NULL DEFAULT 0,
  dedupe_key     TEXT NOT NULL UNIQUE,
  payload_json   TEXT NOT NULL,
  dispatched_at  INTEGER                          -- null until dispatch finished
);
CREATE INDEX lifecycle_by_correlation ON lifecycle_events(correlation_id, seq);
CREATE INDEX lifecycle_by_causation ON lifecycle_events(causation_id);
CREATE INDEX lifecycle_undispatched ON lifecycle_events(seq) WHERE dispatched_at IS NULL;

CREATE TABLE changes (
  id               TEXT PRIMARY KEY,
  status           TEXT NOT NULL CHECK (status IN ('open','done','failed','cancelled')),
  origin_event_id  TEXT NOT NULL,
  origin_session_id TEXT,
  tokens           INTEGER NOT NULL DEFAULT 0,
  role_runs        INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  ended_at         INTEGER
);

CREATE TABLE role_runs (
  id                 TEXT PRIMARY KEY,
  change_id          TEXT NOT NULL,
  role_name          TEXT NOT NULL,
  source_hash        TEXT NOT NULL,
  sdk_version        TEXT NOT NULL,
  scope              TEXT NOT NULL CHECK (scope IN ('builtin','user','repo')),
  trigger_event_id   TEXT NOT NULL,
  session_id         TEXT,                        -- set when the session is created
  agent              TEXT,
  access             TEXT NOT NULL CHECK (access IN ('read-only','write')),
  status             TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled','timed_out')),
  args_json          TEXT NOT NULL DEFAULT '{}',
  round              INTEGER NOT NULL,             -- nth run of this role in the change
  revision           TEXT,                         -- first role_pin checkpoint
  result_revision    TEXT,                         -- checkpoint at the end of the last turn
  continues_used     INTEGER NOT NULL DEFAULT 0,
  validation_retries INTEGER NOT NULL DEFAULT 0,
  tokens             INTEGER NOT NULL DEFAULT 0,
  output_json        TEXT,
  error_code         TEXT,
  error_detail       TEXT,
  deadline_at        INTEGER,
  created_at         INTEGER NOT NULL,
  started_at         INTEGER,
  ended_at           INTEGER
);
CREATE INDEX role_runs_by_change ON role_runs(change_id, created_at);

CREATE TABLE role_matches (
  event_id     TEXT NOT NULL,
  source_hash  TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('trigger','gate')),
  role_name    TEXT NOT NULL,
  result       TEXT NOT NULL CHECK (result IN ('matched','not_matched','skipped','error')),
  reason       TEXT,                              -- from match, or the guard rail that skipped it
  ms           INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (event_id, source_hash, kind)
);

CREATE TABLE decisions (
  event_id     TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending','answered','timed_out')),
  deadline_at  INTEGER NOT NULL,
  answers_json TEXT NOT NULL DEFAULT '[]',        -- [{sourceHash, role, answer, reason?, ms}]
  result_json  TEXT,
  created_at   INTEGER NOT NULL,
  decided_at   INTEGER
);

-- The role versions this workspace uses, one per name (Build and store, Precedence).
CREATE TABLE workspace_roles (
  role_name     TEXT PRIMARY KEY,
  source_hash   TEXT NOT NULL,
  sdk_version   TEXT NOT NULL,
  scope         TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  loaded_at     INTEGER NOT NULL
);

ALTER TABLE sessions ADD COLUMN role_run_id TEXT;
ALTER TABLE turns ADD COLUMN change_id TEXT;
ALTER TABLE turns ADD COLUMN origin TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user','role','continue'));
```

`checkpoints.reason` gains `role_pin`. The CHECK constraint needs a table rebuild, as in migration `0004_drop_unused_statuses`.

- Lifecycle events, changes, role runs, matches and decisions are kept until the workspace is deleted. The `housekeeping` op does not prune them.
- An event's `seq` gives the log order. Readers MUST order by `seq`, not `occurred_at`.

**UserHubDO SQLite** (migration `0001_roles`)

```sql
CREATE TABLE user_events (            -- lifecycle events with no workspace; same columns as lifecycle_events
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, type TEXT NOT NULL, version INTEGER NOT NULL,
  source TEXT NOT NULL, occurred_at INTEGER NOT NULL, correlation_id TEXT NOT NULL, causation_id TEXT,
  dedupe_key TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL
);
CREATE TABLE run_slots (
  role_run_id  TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  expires_at   INTEGER NOT NULL         -- run deadline plus 10 min; an expired slot is free
);
CREATE TABLE daily_usage (
  project_id TEXT NOT NULL,
  day        TEXT NOT NULL,             -- UTC, YYYY-MM-DD
  tokens     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, day)
);
```

UserHubDO RPC adds `appendEvent(event)`, `acquireRunSlot(roleRunId, workspaceId, expiresAt)` → `boolean`, `releaseRunSlot(roleRunId)`, and `addUsage(projectId, tokens)` → `{dayTokens}`.

**D1** (migration `0001_roles`)

```sql
CREATE TABLE roles (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  scope       TEXT NOT NULL CHECK (scope IN ('builtin','user','repo')),
  project_id  TEXT NOT NULL DEFAULT '',  -- set only for repo roles
  name        TEXT NOT NULL,
  active_hash TEXT,                      -- builtin and user only; repo roles use the version on the branch
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  retired_at  INTEGER,
  UNIQUE (user_id, scope, project_id, name)
);

CREATE TABLE role_versions (
  user_id         TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  source_hash     TEXT NOT NULL,         -- SHA-256 of the source text, hex
  role_id         TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  status          TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
  sdk_version     TEXT NOT NULL,         -- the SDK of the newest build
  manifest_json   TEXT,                  -- null when the build failed
  source_text     TEXT,                  -- builtin and user roles; null for repo roles
  source_ref_json TEXT,                  -- repo roles: {path, commitSha}
  bundle_r2_key   TEXT,
  build_error     TEXT,
  graph_json      TEXT,                  -- last graph check result
  created_at      INTEGER NOT NULL,
  decided_at      INTEGER,
  PRIMARY KEY (user_id, source_hash)
);

CREATE TABLE lifecycle_index (           -- cross-workspace listing only
  event_id     TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  change_id    TEXT,
  type         TEXT NOT NULL,
  role_name    TEXT,
  occurred_at  INTEGER NOT NULL
);
CREATE INDEX lifecycle_index_by_user ON lifecycle_index(user_id, occurred_at DESC);
```

**Write rules**

- `roles` and `role_versions`: the role server functions write them. A WorkspaceDO MAY insert a repo role version as `pending` (Build and store). Only `approveRoleVersion` and `rejectRoleVersion` change `status`.
- `lifecycle_index`: each WorkspaceDO inserts its own rows with `INSERT OR IGNORE`, for `tempo.change.*`, `role.run.*` and `human.*` events. A failed insert is logged at `warn` and is not retried.
- Deleting a workspace deletes its `lifecycle_index` rows.

**R2.** `roles/<userId>/<sourceHash>/<sdkVersion>.json` holds a bundle: `{mainModule, modules}`. It is kept while its version is not `rejected`.

## The `@tempo/roles` SDK

`packages/roles` is the SDK. A role file has one default export.

```ts
import { ask, defineRole, gate, on, Schema } from "@tempo/roles";

const Finding = Schema.Struct({ path: Schema.String, line: Schema.optional(Schema.Number), text: Schema.String, blocking: Schema.Boolean });

export default defineRole({
  name: "reviewer",
  description: "Reviews a diff against its plan and reports blocking issues.",
  triggers: [
    on("role.run.completed", { from: ["coder"] }, (e) => e.payload.output?.done === true),
    ask({ focus: Schema.optional(Schema.String) }),
  ],
  agent: "other",
  model: "default",
  access: "read-only",
  inputs: ["diff", "plan", "transcript:coder"],
  output: Schema.Struct({ findings: Schema.Array(Finding) }),
  limits: { rounds: 2, continues: 2, timeout: "20m", tokens: 2_000_000 },
  prompt: ({ args }) => `Review the diff against the plan.${args.focus ? ` Focus on ${args.focus}.` : ""}`,
});
```

**Exports**

| Export | Meaning |
| --- | --- |
| `defineRole(def)` | Returns the `Role` WorkerEntrypoint class. Users never write the class. |
| `on(type, filter?, predicate?)` | An event trigger. `filter` is static data: `from` (role names, for `role.*` types) and `sessions` (`"user"`, `"role"` or `"any"`, for `agent.*` types; default `"user"`). `predicate` returns `boolean` or `{matched, reason}`. |
| `ask(argsFields)` | The role can be requested by name. `argsFields` become the ask-args schema. |
| `gate(type, decide, options?)` | A gate on a decision event. `options.onFailure` is `"allow"` (default) or `"block"`. `options.sessions` as in `on`. |
| `event(name, schema)` | Declares `custom.<role>.<name>` |
| `Schema` | Re-exported from `effect` |
| Types | `RoleDefinition`, `LifecycleEvent`, `EventOf<T>`, `MatchContext`, `PromptInput`, `RunContext`, `Manifest` |

**Definition fields**

| Field | Values | Default |
| --- | --- | --- |
| `name` | `^[a-z][a-z0-9-]{1,31}$` | Required |
| `description` | Text, at most 500 characters | Required |
| `triggers` | `on(…)` and at most one `ask(…)` | Required, at least one |
| `gates` | `gate(…)` | None |
| `agent` | An agent id, `"other"` or `"auto"` | `"auto"` |
| `model` | `"default"` or a model value | `"default"`: `agent.models.<agent>` from the effective settings |
| `access` | `"read-only"` or `"write"` | `"read-only"` |
| `inputs` | `"prompt"`, `"diff"`, `"plan"`, `"transcript:<role>"`, `"output:<role>"` | None |
| `output` | An Effect Schema | None: the run needs no output file |
| `limits.rounds` | Runs of this role per change, 1 to 10 | 1 |
| `limits.continues` | Follow-up prompts per run, 0 to 10 | 2 |
| `limits.timeout` | `"<n>m"` or `"<n>h"`, at most `"2h"` | `"20m"` |
| `limits.tokens` | Total tokens per run | None |
| `events` | `event(…)` declarations | None |
| `prompt` | `(input: PromptInput) => string` | Required |
| `transform` | `(output, run: RunContext) => output`, may call `run.emit` | None |

**Agent choice**

- `"auto"` is the project's default agent.
- `"other"` is the first agent in this list that is not the trigger's agent, has its credential set, and, for `opencode` and `pi`, has a model: the project's default agent, then `claude`, `codex`, `opencode`, `pi`. The trigger's agent is the `agent` field of the trigger event, or of the run named in its payload. With no trigger agent, `"other"` is `"auto"`.
- If no agent qualifies, the run fails with `ROLE_NO_AGENT`.
- The choice goes through an `AgentChooser` interface: `choose({role, triggerAgent, candidates}) → agent`. v1 has only the rule above.

**The `Role` entrypoint.** All arguments and results are plain data or RPC stubs.

| Method | Called | Returns |
| --- | --- | --- |
| `manifest()` | At build | `Manifest` |
| `match(event, ctx: MatchContext)` | Dispatch, for each subscribed trigger | `{matched, reason?}` |
| `decide(event, ctx: MatchContext)` | Dispatch, for each subscribed gate | `{answer, reason?}` |
| `prompt(input: PromptInput)` | Run start | `{text}` |
| `validate(output: unknown)` | Each output check | `{ok: true, value}` or `{ok: false, issues: string[]}` |
| `transform(output, run: RunContext)` | After a valid output | `{output}` |

- `MatchContext` is data: `{workspace: {id, projectId, branch, baseBranch, defaultAgent}, change: {id, runs: [{role, status, round}]}, roundsUsed}`.
- `PromptInput` is data: `{args, inputs: {<name>: text}, change: {id}, revision}`.
- `RunContext` is an RPC stub of the host WorkerEntrypoint `RoleRunContext`, made with `ctx.exports.RoleRunContext({props: {workspaceId, roleRunId, sourceHash, customTypes}})`. Its only method is `emit(type, payload)`. Role code never sees the props.

**Manifest.** Plain data, in `packages/protocol` as `RoleManifest`: `name, description, sdkVersion, sourceHash, triggers: [{type, from?, sessions?}], ask: {argsSchema} | null, gates: [{type, sessions?, onFailure}], agent, model, access, inputs, outputSchema | null, limits: {rounds, continues, timeoutMs, tokens | null}, events: [{type, schema}]`. JSON Schemas come from the role's Effect Schemas, generated in the isolate.

The host routes, lists and graph-checks from the manifest only. It does not call role code for these.

## Build and store

**Sources**

| Scope | Where the source is | When Tempo reads it |
| --- | --- | --- |
| `builtin` | `packages/roles-builtin/*.ts`, embedded in the Worker build as text | On the first `listRoles` after a deploy |
| `user` | `role_versions.source_text` in D1 | On `putUserRole` |
| `repo` | `.tempo/roles/*.ts` on the workspace branch, read with `fs.list` and `fs.read` | After `repo.clone`, after a fresh-disk wake, and on `reloadRepoRoles`. Not on file changes, so an agent that edits a role does not make a new version on each save. |

**Build** (`apps/tempo/src/roles/build.ts`, used by the server functions and the WorkspaceDO)

1. Hash the source text with SHA-256. If a version with that hash and the current SDK version has a bundle, stop.
2. The source MAY import only `@tempo/roles` and `effect` (its root only). Any other import fails with `ROLE_BUILD_FAILED`.
3. Bundle with `@cloudflare/worker-bundler`. `@tempo/roles` and `effect` stay external. The bundler MUST NOT fetch from npm (spike S18).
4. Add the prebuilt modules from `packages/roles` (`@tempo/roles` and `effect`) to `modules`. The host owns their versions, so every role builds against the host's SDK.
5. Load with `env.LOADER.load(…)`: no `env`, `globalOutbound: null`, `limits: {cpuMs: 100}`. Call `manifest()`. Validate it with `RoleManifest`. The manifest's `name` must equal the role's name in its scope.
6. Store the bundle in R2 and the version in D1 with status `pending`, unless the hash already exists. Changed code is a new hash, so it is a new `pending` version.
7. Run the graph check (Guard rails) and store its result in `graph_json`.

**SDK upgrades.** A deploy with a new SDK rebuilds a version on its next load, with the same hash. If the new manifest equals the stored one, the status stays. If it differs, the version goes back to `pending`.

**Status**

- `pending`: built, not trusted. It never runs and is never asked to match. `replayRoles` MAY load it.
- `approved`: the owner trusts this hash. Approval runs the graph check first; a failed check refuses approval with `ROLE_GRAPH_CYCLE`.
- `rejected`: never runs.
- Active: for `builtin` and `user` roles, `roles.active_hash`, set to the approved version on approval. For `repo` roles, the approved version that is on the workspace branch.

**Precedence.** When two scopes have a role with the same name, a workspace uses `repo`, then `user`, then `builtin`, and only versions that are approved. The WorkspaceDO writes its choice to `workspace_roles` after each source read and after every approval.

## Runtime

- Load with `env.LOADER.get("role:" + sourceHash + ":" + sdkVersion, loadFromR2)`, with no `env`, `globalOutbound: null` and `limits: {cpuMs: 100, subRequests: 10}`.
- The host stops waiting for any role call after 2 s, and counts it as an error.
- Pass per-run data and the `RunContext` stub as call arguments. Never in `env`: a cached Dynamic Worker keeps the `env` of its first load.
- The WorkspaceDO makes all role calls. Role code only decides and shapes text. The agent works in an ACP session through `tempod`.

## Dispatch

After the transaction that writes events commits, the WorkspaceDO runs dispatch. One dispatch runs at a time.

1. Take undispatched events in `seq` order.
2. For each event, find the entries in `workspace_roles` whose triggers or gates name its type, and whose `from` and `sessions` filters pass.
3. Apply the guard rails (below). A role that fails one gets a `role_matches` row with `result = 'skipped'` and the guard rail as `reason`.
4. Call `match` or `decide`. Write one `role_matches` row per call. An error or timeout writes `result = 'error'` and counts as not matched.
5. For each match, start a role run (Role run lifecycle).
6. Set `dispatched_at`.

A crash during dispatch leaves `dispatched_at` null. The DO constructor runs dispatch again. The primary key of `role_matches` makes each call's result written once; a role run is inserted only with its match row, in one transaction.

## Role run lifecycle

1. **Admit.** Check the limits (Guard rails). Take a run slot from UserHubDO. On failure, emit `role.run.failed` with `ROLE_LIMIT`. Else insert the run as `queued` and emit `role.run.started`.
2. **Lock.** At most one `write` run is `running` per workspace. Other write runs stay `queued`, in creation order. Read-only runs do not take the lock.
3. **Session.** Choose the agent. Create a session with `role_run_id` set and title `<role> #<round>`. Set the run `running` and `deadline_at`.
4. **Pin.** Before each turn of the run, request `git.checkpoint {reason: "role_pin"}` and upload the bundle as for other checkpoints. The first pin is the run's `revision`; emit `tempo.revision.pinned`. An unchanged tree reuses the newest checkpoint (03).
5. **Prompt.** Call `prompt(input)`. Queue the first turn with `origin: "role"`. Its content blocks, after the first-prompt blocks in 01: the role header, the access text, the output text and the done text (Fixed texts), then one text block per input. Each input is capped at 256 KiB, and all inputs together at 512 KiB; a cut input ends with `[cut by Tempo]`.
6. **Tokens.** At each `agent.turn.ended` of the run, add `usage.totalTokens` to the run, the change and `daily_usage`. A turn with no usage adds 0.
7. **Turn end.** At each `agent.turn.ended` of the run, in this order:
   1. If the turn status is not `completed`, fail the run with `ROLE_TURN_FAILED`.
   2. Read-only check: compare the tree of this turn's `role_pin` checkpoint with the tree of its `turn_end` checkpoint (03). If they differ, fail the run with `ROLE_ACCESS_VIOLATION`.
   3. Read `/home/tempo/roles/<roleRunId>/output.json` (if the role has an output) and, for a write role, `/home/tempo/roles/<roleRunId>/done`, with `Files`.
   4. If one is missing: if `continues_used < limits.continues` and the token limits allow, queue a continue turn with the matching fixed text; else fail with `ROLE_OUTPUT_MISSING`.
   5. Validate (Output validation). Retry once on failure.
   6. Call `transform`. Store the output. Set `result_revision` to this turn's checkpoint. Emit `role.run.completed`.
8. **End.** Release the lock and the run slot. Send `session.close` to free the adapter. The session row stays, so its tab still shows the transcript.

**While a run is `running`**

- `sendPrompt` to its session returns `SESSION_BUSY`.
- Other sessions keep working. Their turns can run between the run's turns.
- `cancelRoleRun` cancels the running turn, deletes queued turns of the session, and sets the run `cancelled`.

**Timeout.** `deadline_at` joins the single alarm (03, Step runner). When it passes: send `session.cancel`, set the run `timed_out`, emit `tempo.run.timed_out`, then `role.run.failed` with `ROLE_TIMED_OUT`.

**Read-only violations.** Tempo does not restore the files, because a restore can delete other work. The failed run adds a notice item to its session, `This read-only role changed files. Revert to revision <short sha> to undo.`, with an action that calls `revertToCheckpoint` with the run's last `role_pin` checkpoint. Revert makes a safety checkpoint first (03), so nothing is lost. Files changed by a terminal or a run script during the turn also count as a change.

**Output validation**

1. The host refuses an output file over 64 KiB, or one that is not JSON, as invalid, with that issue.
2. The isolate's `validate` decodes it with the role's Effect Schema.
3. The host checks the result with a fixed Effect Schema: `{ok: true, value}` or `{ok: false, issues: string[]}`, at most 20 issues of 500 characters. Any other shape is a failure.
4. On `ok: false`, if `validation_retries` is 0, queue a continue turn with the invalid-output text and set `validation_retries = 1`. This does not count as a continue. Else fail the run with `ROLE_OUTPUT_INVALID`.

**Fixed texts.** Exact. `<…>` is filled in.

| Text | Value |
| --- | --- |
| Role header | `You are working as the Tempo role "<name>": <description>` |
| Access, read-only | `This role is read-only. Do not create, change, move or delete files under /workspace, and do not run commands that do, such as formatters, code generators or git commands that change the branch. You may read files and run commands that only read. Tempo compares the files before and after each turn and fails the run if they differ.` |
| Access, write | `This role may change files under /workspace. Do not commit, push or change the branch. Tempo does that.` |
| Output | `When you are done, write your result as JSON to /home/tempo/roles/<roleRunId>/output.json. It must match this JSON Schema:` followed by the schema |
| Done (write roles) | `When the work is complete, create the empty file /home/tempo/roles/<roleRunId>/done. Create it only when the work is complete.` |
| Continue, no output | `Tempo did not find your result at /home/tempo/roles/<roleRunId>/output.json. Write it now, then end your turn.` |
| Continue, not done | `The work is not marked complete. Continue. When it is complete, create the empty file /home/tempo/roles/<roleRunId>/done.` |
| Continue, invalid output | `Your result at /home/tempo/roles/<roleRunId>/output.json does not match the schema. Problems:` then one issue per line, then `Fix the file, then end your turn.` |

**Inputs**

| Name | Text |
| --- | --- |
| `prompt` | The text of the turn that created the change |
| `diff` | `git.changes {scope: "branch"}` plus `git.fileDiff` for each file, at the run's revision |
| `plan` | The newest `plan` item in the change, else the newest output of a role named `planner` in the change, as JSON |
| `transcript:<role>` | The `agent_message` texts of the newest run of `<role>` in the change, oldest first |
| `output:<role>` | The newest output of `<role>` in the change, as JSON |

A missing input is the text `(none)`.

## Triggers

**Event triggers.** Dispatch (above).

**Explicit triggers.** A request skips trigger predicates. It does not skip limits, approval, access or the trace. The role must have an `ask` trigger, else `ROLE_NOT_REQUESTABLE`.

- **Composer.** In a chat tab, `/role <name> <text>` or an `@<name>` role chip sends a request instead of a prompt. The `@` menu shows active requestable roles in a group named `Roles`, above files. `/role` is reserved by Tempo and is not sent to the agent. One role per message.
- **`run_role` MCP tool.** Every session gets a second MCP server, `tempo`: command `tempod`, args `["mcp"]`, env `TEMPOD_MCP_SESSION=<sessionId>`. `tempod mcp` speaks MCP over stdio and talks to the daemon through the socket `/home/tempo/.tempod/mcp.sock` (mode 0600). Its one tool is `run_role {role, text?}`. The daemon sends the event `role.requested {sessionId, turnId, role, text}`. The DO emits `agent.role.requested`, and the request goes on as below. At most 3 requests per turn; more return a tool error.
- **Request handling.** `requestRole {workspaceId, role, text?, sessionId?}` emits `human.requested`. It creates a new change, unless the request comes from the `run_role` tool, which uses the change of the calling turn. Text maps to the first string field of the ask-args schema; other fields stay absent.

**Router.** Names resolve through the `RoleRouter` interface: `route(text, roles) → {kind: "role", role} | {kind: "choose", candidates: [role, role]}`. v1 matches the exact name only. A future model-based router MUST NOT offer a "none" answer. On low confidence it returns the top two roles, and the UI asks.

## Guard rails

| Guard rail | Rule | Error code |
| --- | --- | --- |
| Approval | Only approved versions run, match or gate | — |
| Graph check | Nodes are roles. An edge A → B exists when an event that A's runs emit (`role.run.*` with `role = A`, A's custom events, `agent.*` from A's sessions, `tempo.revision.pinned`) is a trigger type of B whose filters accept it. A cycle is refused unless every role in it has `limits.rounds`. A role with `sessions: "role"` or `"any"` on an `agent.*` trigger has an edge to itself. | `ROLE_GRAPH_CYCLE` |
| Rounds | At most `limits.rounds` runs of a role per change | `ROLE_LIMIT` |
| Chain depth | An event with `chainDepth` ≥ `roles.max_chain_depth` (default 10) starts no run | `ROLE_LIMIT` |
| Runs per change | At most `roles.max_runs_per_change` (default 20) | `ROLE_LIMIT` |
| Tokens | `limits.tokens` per run; `roles.max_tokens_per_change` per change; `roles.max_tokens_per_day` per project per UTC day. Checked before each turn of a run. 0 means no cap. | `ROLE_LIMIT` |
| Concurrent runs | At most 3 `running` runs per user (UserHubDO run slots) | `ROLE_LIMIT` |
| Logins | Role runs MUST NOT change agent login files or the static agent config files (01) | — |
| Secrets | Never in role `env`, call arguments, lifecycle events, traces or role outputs that Tempo writes | — |

Project settings gain a `[roles]` table in `.tempo/settings.toml` (01):

```toml
[roles]
enabled = true                # false: no event triggers and no requests in this project
max_chain_depth = 10
max_runs_per_change = 20
max_tokens_per_change = 0     # 0 = no cap
max_tokens_per_day = 0        # 0 = no cap
```

## Trace and replay

**Trace.** `getTrace {workspaceId, eventId}` returns:

- `chain`: the events from the origin of the causation chain to this event, in order.
- `children`: the events this event caused.
- `matches`: the `role_matches` rows for this event, with role name, source hash, SDK version, scope, result and reason.
- `decision`: the `decisions` row, if any.
- `runs`: the role runs this event started.

**Dry-run replay.** `replayRoles {workspaceId, sourceHashes, changeId?}` loads the workspace's events (one change, or all) and calls `match` and `decide` for the given versions, `pending` ones included. It writes nothing, emits nothing, starts nothing, and returns `[{eventId, type, sourceHash, role, kind, result, reason}]`.

- `MatchContext` for each event is rebuilt from the log as it was at that event.
- Replay runs only direct matches against recorded events. It cannot replay the runs a match would start, or their outputs. A recorded log against the same versions MUST give the same matches as the stored `role_matches` rows.

## API

Server functions (02 rules apply). The `/api/v1` routes for native clients mirror them (07).

| Function | Input | Output | Errors |
| --- | --- | --- | --- |
| `listRoles` | `{projectId?}` | `[{id, scope, name, activeHash, versions: [{sourceHash, status, sdkVersion, manifest, buildError, graph, createdAt}]}]` | — |
| `getRoleSource` | `{sourceHash}` | `{text}`; repo roles read from GitHub at `source_ref_json` | `NOT_FOUND`, `GITHUB_API_ERROR` |
| `putUserRole` | `{source}` | The version | `ROLE_BUILD_FAILED` |
| `approveRoleVersion` | `{sourceHash}` | `{}` | `ROLE_GRAPH_CYCLE`, `NOT_FOUND` |
| `rejectRoleVersion` | `{sourceHash}` | `{}` | `NOT_FOUND` |
| `retireRole` | `{roleId}` | `{}` | — |
| `reloadRepoRoles` | `{workspaceId}` | `{versions}` | `CONTAINER_NOT_READY`, `ROLE_BUILD_FAILED` |
| `requestRole` | `{workspaceId, role, text?, sessionId?}` | `{changeId, roleRunId}` | `ROLE_NOT_FOUND`, `ROLE_NOT_REQUESTABLE`, `ROLE_LIMIT`, `WORKSPACE_ARCHIVED` |
| `cancelRoleRun` | `{workspaceId, roleRunId}` | `{}` | `NOT_FOUND` |
| `listChanges` | `{workspaceId}` | `[{id, status, createdAt, endedAt, tokens, runs: [RoleRun]}]` | — |
| `listLifecycleEvents` | `{workspaceId, changeId?, beforeSeq?, limit?}` | `{events, nextBeforeSeq}`; newest first, at most 500 | — |
| `getTrace` | `{workspaceId, eventId}` | Trace | `NOT_FOUND` |
| `replayRoles` | `{workspaceId, sourceHashes, changeId?}` | Replay result | `NOT_FOUND` |
| `listRoleRuns` | `{workspaceId?, limit?}` | From `lifecycle_index` when `workspaceId` is absent | — |

WorkspaceDO RPC gets one method per workspace function above (02, WorkspaceDO RPC), plus `rolesChanged()`, which the role server functions call on every live WorkspaceDO of the user after an approval, rejection or retirement.

**Workspace channel.** New messages: `roleRun {run: RoleRun}` when a run changes, and `change {change}` when a change changes. `Session` gains `roleRunId?`.

**tempod protocol** (additive, 05): the event `role.requested {sessionId, turnId, role, text}`; the MCP server `tempo` in every `session/new` and `session/load`; `fs/write_text_file` and `fs/read_text_file` also allow `/home/tempo/roles/`.

## UI

Web (04) and Mac (07) change in the same milestone.

| Where | What |
| --- | --- |
| Settings → Roles (personal) | Roles by scope. Each version shows status, manifest (triggers, gates, agent, access, inputs, limits), graph result and source (read-only). Approve and Reject on pending versions. An Import field takes pasted source for `putUserRole`. No editor. |
| Chat tabs | A role session's tab shows the role name and its run status. Its composer is disabled while the run is `running`, with Cancel run. |
| Composer | `/role` and the `Roles` group in the `@` menu (Explicit triggers) |
| Notices | Run failures as notice items in the role session, with the read-only Revert action |
| Diagnostics | An Events panel: the newest 500 lifecycle events, filtered by change. Selecting one shows its trace. |
| Sidebar | A workspace with a running role run shows `working`, as for any running turn |

## Error codes

These join the table in 02.

| Code | Meaning | UI message |
| --- | --- | --- |
| `EVENT_INVALID` | Unknown event type or bad payload | (Logged only.) |
| `ROLE_NOT_FOUND` | No active role with that name | No role with that name. |
| `ROLE_NOT_REQUESTABLE` | The role has no `ask` trigger | This role can't be started by hand. |
| `ROLE_BUILD_FAILED` | Bundle, import check or manifest failed | The role did not build. See its details in Settings → Roles. |
| `ROLE_GRAPH_CYCLE` | Approval would make a cycle without round limits | These roles would trigger each other without a limit. |
| `ROLE_LIMIT` | A guard rail stopped the run | A role limit stopped this run. |
| `ROLE_NO_AGENT` | No agent qualifies for the role | No agent can run this role. Add a login in Settings. |
| `ROLE_TURN_FAILED` | A turn of the run did not complete | The role's agent stopped before it finished. |
| `ROLE_OUTPUT_MISSING` | No output or done marker after the last continue | The role did not report a result. |
| `ROLE_OUTPUT_INVALID` | The output failed validation twice | The role's result was not valid. |
| `ROLE_ACCESS_VIOLATION` | A read-only run changed files | This read-only role changed files. |
| `ROLE_GATE_FAILED` | A blocking gate failed or timed out | A role check failed. |
| `ROLE_TIMED_OUT` | The run passed its deadline | The role ran out of time. |

## Cloudflare primitives

| Primitive | Use | Why |
| --- | --- | --- |
| Worker Loader binding `LOADER` (Dynamic Workers, open beta) | Load role bundles | Runs new code with no deploy; `globalOutbound: null` cuts the network; `get()` keeps warm isolates by id |
| `WorkerEntrypoint` with `ctx.exports` and props | `RoleRunContext` | A per-run capability stub that hides its props from role code |
| WorkspaceDO SQLite | Event log, changes, runs, matches, decisions | The ordered source of truth per workspace |
| UserHubDO SQLite | Events with no workspace, run slots, daily usage | Already one per user |
| D1 | Roles, role versions, the cross-workspace index | Lists across workspaces |
| R2 `tempo-data` | Role bundles | Bundles can be large; D1 rows stay small |
| The WorkspaceDO alarm | Run deadlines and decision deadlines | 03 has one alarm per DO |

The deploy config (`scripts/deploy-worker.ts`) and the test config add `"worker_loaders": [{"binding": "LOADER"}]`.

Pricing ([source](https://developers.cloudflare.com/dynamic-workers/pricing/)): requests and CPU bill as Workers usage. A charge per Dynamic Worker created each day is announced but not active.

## Files and packages

| Path | Content |
| --- | --- |
| `packages/protocol/src/lifecycle.ts` | Envelope, registry, payload schemas, `RoleManifest`, `RoleRun`, `Change`, decision schemas |
| `packages/roles/` | `@tempo/roles`: the SDK source, and a build that writes the prebuilt `@tempo/roles` and `effect` modules |
| `packages/roles-builtin/` | `planner.ts`, `coder.ts`, `ci.ts`, `reviewer.ts`. They import only `@tempo/roles` and `effect`. |
| `apps/tempo/src/roles/` | `build.ts`, `loader.ts`, `run-context.ts`, `graph.ts`, `router.ts`, `chooser.ts`, `inputs.ts` |
| `apps/tempo/src/do/workspace/lifecycle.ts` | Mapping, append, dispatch |
| `apps/tempo/src/do/workspace/role-runs.ts` | Run lifecycle, lock, output check |
| `apps/tempo/src/do/workspace/decisions.ts` | Decision events and merging |
| `apps/tempo/src/server/handlers/roles.ts` | Role server functions |
| `packages/tempod/src/mcp.ts` | `tempod mcp` and the socket |
| `apps/tempo/src/db/` | D1 migration `0001_roles`, DO migrations `0006_lifecycle` and UserHubDO `0001_roles` |
| `spikes/S18.md`, `spikes/S19.md` | Spike results |

**New dependency:** `@cloudflare/worker-bundler`, pinned. Owner approved (decision 5 of the plan).

## Spikes

| ID | Question | Pass criteria |
| --- | --- | --- |
| S18 | Do Dynamic Workers work as this tab uses them? Local, no account needed. | In the local test runtime: `worker-bundler` bundles a role that imports `@tempo/roles` and `effect`, with both supplied as prebuilt modules and no npm request. `env.LOADER.get()` with `globalOutbound: null` loads it. `manifest()`, `match()` and `validate()` work; `validate` decodes with Effect Schema in the isolate. A `RoleRunContext` stub passed as an argument receives `emit`. `fetch()` in the role throws. Record bundle size, cold load and warm call times (p50 and p95 of 100 calls). If the local runtime has no Worker Loader, say so, and run the rest on a deployed test Worker. |
| S19 | Does a follow-up prompt continue the same context? Needs real logins. | For each of the four agents: after a turn ends with `end_turn`, a second `session/prompt` that refers to the first turn's content gets an answer that uses it. Also record how often each agent sends `session/request_permission` in its default mode. |

## Phase 5 and gate F

Phase 5 adds this tab. It MAY run in parallel with phases 2 to 4. The doc change merges first. Each milestone merges when its own tests pass. Gate F needs gate B.

| Milestone | Content | Demo |
| --- | --- | --- |
| M1 Events | Protocol schemas and registry; mapping in the WorkspaceDO in the `tempod` event transaction; `tempo.*` events; dedupe; `getTrace`, `listLifecycleEvents`; D1 index | A recorded `tempod` session's events show in the trace |
| M2 Role runtime | SDK, prebuilt modules, build, store, approval, `workspace_roles`, dispatch with `match`, in-isolate validation; Settings → Roles (web and Mac). Starts with S18; MAY run in parallel with M1, against synthetic events. | A role that matches `agent.turn.ended` records a match |
| M3 Role runs | Run lifecycle, pins, write lock, read-only check, output check, `role.run.*`, decision events; role tabs (web and Mac). Port `reviewer`. | `coder` done, then `reviewer` runs on another agent |
| M4 Guard rails | Graph check, chain depth, limits, run slots, timeouts, `replayRoles`; Diagnostics Events panel (web and Mac) | A cycle is refused; a replay gives the recorded matches |
| M5 Explicit triggers | `/role`, `@` roles, `requestRole`, `tempod mcp` and `run_role` (web and Mac) | `/role reviewer focus on auth` runs `reviewer` |
| M6 Built-ins | Port `planner`, `coder` and `ci` | `tempo.change.created` → `planner` → `coder` → `ci` → `reviewer` |

Build M1 against recorded `tempod` fixtures. Record real fixtures after S1 passes.

**Gate F** (06 rules: deployed, real logins, 3 runs in a row)

1. A user prompt makes `tempo.change.created`, and its turn's events show in `getTrace`.
2. A pending role never matches. After approval, it matches.
3. `coder` (write) ends with a done marker; `reviewer` (read-only) then runs on another agent and completes with a valid output.
4. A read-only role that edits a file fails with `ROLE_ACCESS_VIOLATION`, and Revert restores the files.
5. A role that loops on itself without `rounds` is refused at approval.
6. A run past its timeout ends with `ROLE_TIMED_OUT`, and its session's turn is cancelled.
7. `run_role` from inside an agent session starts the named role.
8. Kill the container during a role run: the run fails with `ROLE_TURN_FAILED`, no event is lost, and dispatch resumes after the DO restarts.
9. A grep of lifecycle events, traces and role bundles for the test credentials finds nothing.

**Tests** (06, Definition of done)

- Unit: registry validation; mapping per `tempod` event kind; dedupe keys; decision merging; graph check; each limit; precedence; agent choice.
- Integration (`@cloudflare/vitest-pool-workers`): Dynamic Worker load and RPC; ingest from fixtures to dispatch; one chain from `tempo.change.created` to `role.run.completed` with a fake `tempod`.
- Replay: a recorded log replays to the stored matches.

## Out of scope for version 1

CLI hooks and managed hook config (a later hard gate behind the `DecisionSource` interface, next to ACP permission requests), a model-based router, learned agent or model choice, a role editor, stateful roles (Durable Object Facets), and sharing roles between users. The `RoleRouter`, `AgentChooser` and `DecisionSource` interfaces stay so these can come later.

## Sources

- [Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/), [API reference](https://developers.cloudflare.com/dynamic-workers/api-reference/), [bindings](https://developers.cloudflare.com/dynamic-workers/usage/bindings/), [egress control](https://developers.cloudflare.com/dynamic-workers/usage/egress-control/), [limits](https://developers.cloudflare.com/dynamic-workers/usage/limits/)
- [ACP prompt turn](https://agentclientprotocol.com/protocol/prompt-turn) and [v1 schema](https://agentclientprotocol.com/protocol/v1/schema)
