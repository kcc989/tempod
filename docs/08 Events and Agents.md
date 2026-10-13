# 08 Events and Agents

An **agent** is the one saved definition concept in Tempo. An agent is one row of data in the user's library. A project **attaches** the agents it uses. Each attachment has **hooks**. When a hook's event happens, a decision model (Cloudflare Clef) answers one question and Tempo runs the agent only on "yes". A run shows as a **run card** in the chat that caused it.

No agent definition and no wiring is a file. The owner can change all of it in the app, through the API or by asking in chat, without a deploy.

## Owner decisions

These are fixed. Do not reopen them. If the code or the spec conflicts with one, stop and ask.

| # | Decision |
| --- | --- |
| A1 | One concept: **agent**. Custom agents and roles merge. The words "role" and "custom agent" leave the product, the spec and the wire types. |
| A2 | Agents are data: one library per user, in D1. No agent files in the repo, no Artifacts store and no YAML. Tempo stops reading `.tempo/roles/`. |
| A3 | Built-in agents are **starters**: rows that Tempo copies into each user's library once. The user can edit or delete them. A later starter change does not change existing rows. |
| A4 | A project **attaches** agents. One D1 row per project and agent. All wiring lives there. `roles.*` leaves the settings file. |
| A5 | A hook is an event type and an optional question. Tempo matches the event type exactly, then asks the question. No question means "always". |
| A6 | The decision model is Clef-flash on Workers AI (`@cf/cloudflare/clef-flash`) through a Worker `AI` binding. The owner approves this binding. Add no other library. |
| A7 | A run has its own session. The session is hidden from the tab bar. The run shows as a `run` item (the run card) in the chat that caused the change. |
| A8 | The result comes from a `report_result` tool call on the `tempo` MCP server. No result file. |
| A9 | Read-only uses the agent's own controls. Tempo's tree compare becomes a warning on the card, not a failure. |
| A10 | Limits: `max_runs` per attachment per change, and a timeout per run. Remove rounds, continues, chain depth, runs per change and both token caps. |
| A11 | The user can create and change agents and attachments by asking in chat. The agent proposes; the owner applies in the app, as with `propose_environment_change`. |
| A12 | The decision state may hold the change's prompt text, cut to 4 KiB and redacted. It never holds file contents, env values or secrets. |

## Vocabulary

These words join tab 00. Use them exactly.

| Term | Meaning | Code name |
| --- | --- | --- |
| Agent | A saved definition in the user's library | `agent` |
| Starter | A built-in agent definition that Tempo copies into a library | `starter` |
| Attachment | One project's use of one agent, with its hooks and limits | `attachment` |
| Hook | An event type and an optional question on an attachment | `hook` |
| Decision | Clef's answer for one hook and one event | `decision` |
| Run | One execution of one agent for one change | `run` |
| Run card | The `run` item in the chat that caused the change | `run` item |
| Output kind | The shape and the UI of a run's result: `plan`, `review` or `note` | `outputKind` |

A change is one user prompt or agent request, and every turn and run it causes. A lifecycle event is one typed fact in the workspace log; raw daemon events remain in the existing `events` table.

## Lifecycle events

**Envelope.** In `packages/protocol` as the Effect Schema `LifecycleEvent`.

| Field | Type | Rule |
| --- | --- | --- |
| `id` | ULID | Lowercase (02, Conventions) |
| `type` | One of the types below | A closed union. An unknown type or a bad payload is rejected with `EVENT_INVALID`. |
| `source` | `agent`, `tempo` or `run` | Who caused it |
| `occurredAt` | integer ms | 02, Conventions |
| `workspaceId` | ULID | |
| `changeId` | ULID, optional | |
| `turnId` | ULID, optional | |
| `runId` | ULID, optional | |
| `sessionId` | ULID, optional | The Tempo session id |
| `agent` | Agent id, optional | |
| `causationId` | ULID, optional | The event that caused this one |
| `dedupeKey` | string | Unique in the log |
| `payload` | object | Validated against the type's schema |

**Types**

| Type | Source | When | Payload | Caused by |
| --- | --- | --- | --- | --- |
| `tempo.change.created` | `tempo` | A user-origin turn is queued (including in a retained chat after its agent ends), or `requestAgent` is called | `origin: "prompt", "request" or "event"`, `handle?`, `text?` | Nothing (origin) |
| `agent.turn.ended` | `agent` | `turn.ended` from `tempod` | `status: "completed", "cancelled", "failed" or "interrupted"`, `stopReason`, `errorCode?`, `usage?` | The change's `tempo.change.created`, or the run's `run.started` |
| `run.started` | `run` | A run is inserted | `agentId, handle, attachmentId?, agentVersion, agentSha, agent, access, outputKind` | The event that triggered it |
| `run.completed` | `run` | A valid result is stored | `agentId, handle, result` | The run's last `agent.turn.ended` |
| `run.failed` | `run` | Any failure (Error codes) | `agentId, handle, errorCode, detail?` | The event that ended the run |
| `run.decided` | `tempo` | A hook decision is recorded | `attachmentId, agentId, handle, hookIndex, hookEvent, outcome, p?, threshold` | The hook event |
| `tempo.change.ended` | `tempo` | The change has no queued or running turn or run, and all its events are dispatched | `status: "done", "failed" or "cancelled"` | The change's last event |
| `tempo.branch.pushed` | `tempo` | A `commit_push` op ends `done` | `branch, commitSha` | — |
| `tempo.check.passed`, `tempo.check.failed` | `tempo` | `checks_state` changes to `success` or `failure` (03, Status polling) | `prNumber` | — |

- `status` in `agent.turn.ended` uses the turn status rules in 03.
- `tempo.change.ended` status: `cancelled` if the user cancelled the change's last run; else `failed` if its last run failed; else `done`.
- Status polling runs only while a UI socket is open (03), so `tempo.check.*` arrives only then.
- `tempo.branch.pushed` and `tempo.check.*` belong to the newest open change. If none exists and an enabled attachment matches, create a change with `origin: "event"` in the same transaction, and use its created event as the cause.

**Dedupe keys**

| Origin | Key |
| --- | --- |
| `turn.ended` from `tempod` | `tempod:<incarnation>:<seq>` |
| A turn or request | `change:<changeId>:created` |
| A run | `run:<runId>:<type>` |
| A change end | `change:<changeId>:ended` |
| An op | `op:<opId>:<type>` |
| A checks change | `checks:<prNumber>:<headSha>:<type>` |

**Rules**

- Write `agent.turn.ended` only when the raw `events` insert for that `turn.ended` stored a row. A duplicate `(incarnation, seq)` writes nothing. `incarnation.changed` MUST NOT delete lifecycle events.
- A payload MUST NOT hold transcript text, tool input or output, file contents, prompts or env. Request `text` and run results are the only free text, each at most 64 KiB. The separate decision state may include the bounded, redacted change text specified below.
- Secrets MUST NOT be in a lifecycle event (05).

## Agent

**Definition.** The Effect Schema `AgentDefinition` in `packages/protocol`. Unknown keys are errors.

| Field | Values | Default |
| --- | --- | --- |
| `handle` | `^[a-z][a-z0-9-]{1,31}$`, unique per user among active agents. Used in `@handle`, `/agent` and the trace. | Required |
| `name` | 1 to 60 characters, unique per user among active agents | Required |
| `description` | At most 500 characters | `""` |
| `baseAgent` | `claude`, `codex`, `opencode`, `pi` or `auto` (the project's default agent) | `auto` |
| `model` | The agent's model config value; `""` is the agent's default | `""` |
| `thoughtLevel` | The agent's `thought_level` config value; `""` is the agent's default | `""` |
| `prompt` | At most 32,000 characters. Tempo applies it as the system prompt (tab 01, How `tempod` applies a profile). | `""` |
| `access` | `read-only` or `write` | `read-only` |
| `tools` | `{allow, deny}`, the profile rules in tab 01 | `{allow: [], deny: []}` |
| `mcp` | `{playwright, servers}`, the profile rules in tab 01, including `${NAME}` only | `{playwright: true, servers: []}` |
| `outputKind` | `plan`, `review` or `note` | `note` |

Limits stay as today: at most 50 active agents per user, 100 names in each tool list and 10 MCP servers. The whole definition is at most 64 KiB of JSON.

**D1** (migration `0005_agents`)

```sql
CREATE TABLE agents (
  id               TEXT PRIMARY KEY,                -- ULID
  user_id          TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  handle           TEXT NOT NULL,
  name             TEXT NOT NULL,
  definition_json  TEXT NOT NULL,                   -- AgentDefinition
  version          INTEGER NOT NULL,                -- +1 on each save
  sha              TEXT NOT NULL,                   -- SHA-256 of the canonical definition JSON
  starter          TEXT,                            -- starter id this row came from, or null
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER
);
CREATE UNIQUE INDEX agents_active_handle ON agents(user_id, handle) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX agents_active_name ON agents(user_id, name) WHERE deleted_at IS NULL;

CREATE TABLE project_agents (
  id           TEXT PRIMARY KEY,                    -- ULID
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  enabled      INTEGER NOT NULL DEFAULT 1,
  hooks_json   TEXT NOT NULL DEFAULT '[]',          -- AttachmentHook[]
  auto_send    INTEGER NOT NULL DEFAULT 0,
  max_runs     INTEGER NOT NULL DEFAULT 3,          -- per change, 1 to 10
  timeout      TEXT NOT NULL DEFAULT '20m',         -- <n>m or <n>h, at most 2h
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (project_id, agent_id)
);

CREATE TABLE agent_migrations (
  user_id      TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  migrated_at  INTEGER NOT NULL
);
```

- Only the agent and attachment server functions, the proposal apply path and the one-time migration write these tables.
- Delete sets `deleted_at`. An attachment whose agent is deleted stays, does not run, and shows "This agent was deleted." with a Remove action.
- A session that started from an agent keeps its profile, as today. A run freezes the definition text in WorkspaceDO storage, for every run, and stores `agent_version` and `agent_sha`.

**Starters.** `packages/agents-starter/` exports three definitions as TypeScript data: `planner` (plan, read-only), `reviewer` (review, read-only) and `check-fixer` (note, write). Write each prompt from the matching role file in `packages/roles-builtin/`. Tempo copies the starters into a library once, during the migration below, and sets `starter`. Tempo never attaches a starter to a project by itself.

## Attachments and hooks

**Hook.** The Effect Schema `AttachmentHook`. At most 8 hooks per attachment.

| Field | Values | Default |
| --- | --- | --- |
| `event` | A hook event (below) | Required |
| `when` | The question, 1 to 500 characters, or `null` for "always" | `null` |
| `threshold` | 0.05 to 0.95 | 0.5 |

**Hook events.** A closed set.

| Hook event | Lifecycle event | Also matches when |
| --- | --- | --- |
| `prompt` | `tempo.change.created` | `origin` is `prompt` |
| `turn.ended` | `agent.turn.ended` | The session has no run |
| `branch.pushed` | `tempo.branch.pushed` | |
| `check.passed` | `tempo.check.passed` | |
| `check.failed` | `tempo.check.failed` | |
| `run.completed` | `run.completed` | The run belongs to a different attachment |
| `run.failed` | `run.failed` | The run belongs to a different attachment |

**Requests.** The owner can request any active agent in the library by hand: `@handle` in the composer, `/agent <handle> <text>`, or `requestAgent`. A request skips hooks and the decision. It does not skip `max_runs`; an unattached agent uses the defaults in the table above. The `@` menu shows the project's attached agents first, then the rest of the library, in a group named `Agents`. Tempo reserves `/agent` and does not send it to the agent.

## Decision

1. **Match.** Dispatch (tab 08) takes each undispatched event in `seq` order. It finds every enabled attachment of the workspace's project whose agent is active and has a hook with a matching event. Read attachments from D1 when the DO loads them and again after `agentsChanged()`, which the agent and attachment server functions call on each live WorkspaceDO of the user.
2. **Always.** A hook with `when: null` decides "run" with no model call.
3. **Ask.** Tempo sends one Clef-flash call for the event, with one `noul` question per matched hook that has a question. If more than 64 hooks match, it splits them into calls of at most 64. The question id is `<attachmentId>.<hookIndex>` (owner-approved S22 correction; Clef rejects colons).
4. **State.** A JSON object built by Tempo, at most 32 KiB. Every text value passes through the lifecycle redactor first.

   | Key | Content |
   | --- | --- |
   | `event` | The lifecycle event type and its payload |
   | `change` | `origin`, and the change's prompt or request text cut to 4 KiB |
   | `branch` | The branch name |
   | `files` | Up to 500 changed paths from `git.changes {scope: "branch"}`, each with its added and removed line counts |
   | `checks` | For `check.*`: each check run's name and conclusion |
   | `run` | For `run.*`: the other run's handle, status and summary |

5. **Answer.** Run when the probability is at or above the hook's `threshold`. When two hooks of one attachment match one event, Tempo runs the attachment once, if either hook says run.
6. **Failure.** Use a 3-second timeout and one retry. If the call still fails, the decision is `error` and the agent does not run. Tempo adds a notice to the chat that caused the change: `<name> was not checked because the decision model did not answer.`, with a **Run anyway** action that calls `requestAgent`.
7. **Record.** Each decision appends one `run.decided` event, in the same transaction as the run it starts, if any.

**Confirmed binding contract (S22).** A deployed Worker returned all 50 measured answers, p95 878 ms, using a 4 KiB state and four questions. The binding returns the object directly, without the REST envelope:

```ts
const response = await env.AI.run("@cf/cloudflare/clef-flash", {
  model: "clef-flash",
  state,
  questions: {
    [attachmentId + "." + hookIndex]: { type: "noul", instructions: when },
  },
});
const p = response.answers[attachmentId + "." + hookIndex].noul;
```

Each answer has `type: "noul"` and `noul` in `[0, 1]`. A missing answer, wrong type, non-finite probability or probability outside this range is a call failure. Question IDs match `^[A-Za-z0-9_.-]{1,100}$`; the owner approved replacing the original colon with a dot. Decision dedupe keys retain their colons. See [S22](../spikes/S22.md) for timings, the first incomplete batch and the rejected colon probe.

## Runs

The run engine uses the existing session, turn, checkpoint and protected-file paths. The wire `Run.name` comes from the frozen definition; its SQLite columns stay as specified below. `CheckRun.summary?` carries GitHub's output summary for failed-check context. Legacy active runs preserve status and resume using their frozen migration data.

1. **Admit.** Insert the run as `queued`. `UNIQUE (trigger_event_id, handle)` makes a repeat do nothing. If the attachment already has `max_runs` runs in the change, fail the run with `RUN_LIMIT`. A `RUN_LIMIT` failure does not dispatch hooks. At most one `write` run is `running` per workspace, as today.
2. **Agent.** Use `baseAgent`, or the project's default agent for `auto`. If it has no login, or it is `opencode` or `pi` with no model, fail with `RUN_NO_AGENT`.
3. **Session.** Create a session with `run_id` set and title `<name>`. Start it with the frozen definition as its `AgentProfile`, through the existing profile path. Add `TEMPO_RUN_ID` and `TEMPO_RUN_OUTPUT_KIND` to the session env. Set the run `running` and `deadline_at`.
4. **Card.** Insert one `run` item, with content `{runId}`, in the **origin session**: the session of the change's first user turn, or the requesting session for a request. With neither, the run shows in the workspace activity list (Clients). Store the session id in `origin_session_id`.
5. **Pin.** Take one checkpoint with reason `run_pin` before the first turn of the run. Store its id in `pin_checkpoint_id`. Do not take one before each turn.
6. **Prompt.** The first turn's content blocks, in this order: the run header, the access text (tab 08, updated to match A1 and A9 by owner approval), the output kind text, the request text if any, then the context blocks for the hook event (below). Each block is at most 256 KiB and all blocks together at most 512 KiB, cut as today. The agent's `prompt` is the system prompt, not a content block.

   | Context | Sent for |
   | --- | --- |
   | The change's prompt or request text | Every run |
   | The branch diff, as the `diff` input today | Every hook event except `prompt` |
   | The newest result of each other agent in the change, as JSON | `run.*`, and every run of an agent with output kind `review` |
   | Each failed check run's name, conclusion and output summary | `check.failed` |

7. **Turn end.** In this order:
   1. Add `usage.totalTokens` to the run, for display only.
   2. If the turn status is not `completed`, fail with `RUN_TURN_FAILED`.
   3. Compare the protected login and config file hashes, as today. A change fails with `RUN_ACCESS_VIOLATION`.
   4. For a read-only run, compare the tree of `pin_checkpoint_id` with the tree of the turn's `turn_end` checkpoint. If they differ, set `warning = 'files_changed'`. The card shows `This read-only agent changed files.` with a **Revert** action that calls `revertToCheckpoint` with `pin_checkpoint_id`. The run continues.
   5. If the run has a stored report, complete the run (step 8).
   6. If not, and `follow_up_sent = 0`, queue one continue turn at the head of the queue with the follow-up text, and set `follow_up_sent = 1`. Otherwise fail with `RUN_RESULT_MISSING`.
8. **Complete.** Store the result, emit `run.completed` and close the session, as today. If the attachment has `auto_send`, call the Send to chat path (below) in the same step.
9. **Cancel and timeout.** As today, with the new names.

**Fixed texts.** Exact. `<…>` is filled in.

| Text | Value |
| --- | --- |
| Run header | `You are running as the Tempo agent "<name>" for this change: <description>` |
| Output kind, `plan` | `When you finish, call the report_result tool once with a status of "done" or "blocked", a summary, and the plan as steps. Do not end your turn before you call it.` |
| Output kind, `review` | `When you finish, call the report_result tool once with a status of "pass", "fail" or "blocked", a summary, and each problem as a finding. Mark a finding blocking when the change must not merge with it. Do not end your turn before you call it.` |
| Output kind, `note` | `When you finish, call the report_result tool once with a status of "done" or "blocked" and a summary. Do not end your turn before you call it.` |
| Follow-up | `Tempo did not get your result. Finish the work if it is not complete, call the report_result tool, then end your turn.` |

## Results: `report_result`

Add the tool `report_result` to the `tempo` MCP server. `tempod mcp` lists it only when `TEMPO_RUN_ID` is set, with the input schema of `TEMPO_RUN_OUTPUT_KIND`. Carry calls through request/response frames on the existing daemon socket. Tool arguments do not enter the raw event log; the WorkspaceDO validates and redacts reports before storing them. This transport correction was owner-approved on 2026-10-13.

| Output kind | Input (Effect Schema in `packages/protocol`) |
| --- | --- |
| `plan` | `status`: `done` or `blocked`; `summary`: at most 4,000 characters; `steps`: 1 to 50 of `{text, files?}`, `text` at most 1,000 characters, `files` at most 50 paths; `verify?`: at most 2,000 characters |
| `review` | `status`: `pass`, `fail` or `blocked`; `summary`; `findings?`: at most 200 of `{path, line?, text, blocking}`, as the finding fields below; `path` and `text` are strings and `line` is a positive integer |
| `note` | `status`: `done` or `blocked`; `summary` |

- The whole input is at most 64 KiB.
- The WorkspaceDO validates the input, redacts it with the lifecycle redactor and stores it on the run. An invalid input returns the validation problem to the agent as the tool error, so the agent can correct it in the same turn.
- A second valid call in the same run replaces the first.
- A call for a run that is not `running` returns `RUN_NOT_RUNNING` as the tool error.

## Send to chat

`sendRunToChat {workspaceId, runId}` queues one user turn in the run's origin session and stores its id in `sent_turn_id`. The turn's text, exact:

| Output kind | Text |
| --- | --- |
| `plan` | `Implement this plan from <name>:` and then the summary, the numbered steps and `verify` |
| `review` | `Fix these findings from <name>:` and then each blocking finding as `<path>:<line> <text>`, then the summary |
| `note` | `Result from <name>:` and then the summary |

The card's button reads **Approve** for `plan` and **Send to chat** for the others. A second call returns `RUN_ALREADY_SENT`. A run with no origin session returns `RUN_NO_CHAT`.

**Access texts (owner-approved correction to A1 and A9).**

| Access | Exact text |
| --- | --- |
| `read-only` | `This agent is read-only. Do not create, change, move or delete files under /workspace, and do not run commands that do, such as formatters, code generators or git commands that change the branch. You may read files and run commands that only read. Tempo compares the files before and after each turn and shows a warning if they differ.` |
| `write` | `This agent may change files under /workspace. Do not commit, push or change the branch. Tempo does that.` |

## Read-only

For a read-only run, the session start applies, in this order:

1. The agent's own mode that does not change files, when the agent advertises one. Spike S20 records the mode id for each agent in tab 01.
2. Else the base agent's edit tool names added to `tools.deny` in the run's profile, through the existing profile path. S20 records the names in tab 01.
3. Else the profile issue `access` (a new `ProfileIssue` value), shown on the card.

The tree warning in Runs step 7.4 applies in all three cases.

## Asking in chat

Add two tools to the `tempo` MCP server. Neither is listed when `TEMPO_RUN_ID` is set.

- `list_agents`: returns the user's active agents (handle, name, description, base agent, access, output kind) and this project's attachments with their hooks.
- `propose_agent_change`: input `{note, agent?, attach?, detach?}`. `agent` is an `AgentDefinition`; Tempo creates it, or replaces the active agent with the same handle. `attach` is `{handle, hooks, autoSend?, maxRuns?, timeout?}`. `detach` is a handle.

A proposal is stored as pending on the workspace, as environment proposals are (tab 01). The chat shows a proposal card with the full change. Only `resolveAgentProposal` with `apply: true` writes D1. A proposal never writes on its own.

## Lifecycle event migration

Migration `0010_agents` rewrites existing lifecycle events as follows.

| Today | New |
| --- | --- |
| `source: "role"` | `source: "run"` |
| `roleRunId` on the envelope | `runId` |
| `role.run.started {role, scope, roleSha, round, agent, access}` | `run.started {agentId, handle, attachmentId?, agentVersion, agentSha, agent, access, outputKind}` |
| `role.run.completed {role, round, result}` | `run.completed {agentId, handle, result}` |
| `role.run.failed {role, round, errorCode, detail?}` | `run.failed {agentId, handle, errorCode, detail?}` |
| None | `run.decided {attachmentId, agentId, handle, hookIndex, hookEvent, outcome: "run", "skip" or "error", p?, threshold}`, dedupe key `decide:<eventId>:<attachmentId>:<hookIndex>` |

`run.decided` holds no question text and no state. The trace UI joins the attachment for the question. `agentId` may be null only on rows migrated from roles.

Owner-approved Send to chat correlation (2026-10-13): queue the sent turn in the run's existing change, including auto-send, so all subsequent runs share the attachment's `max_runs` budget.

## WorkspaceDO SQLite (migration `0010_agents`)

Rebuild `role_runs` as `runs` and copy the rows.

```sql
CREATE TABLE runs (
  id                 TEXT PRIMARY KEY,
  change_id          TEXT NOT NULL,
  parent_run_id      TEXT,
  agent_id           TEXT,                 -- null only for runs migrated from roles
  attachment_id      TEXT,                 -- null for requests of unattached agents and migrated runs
  handle             TEXT NOT NULL,
  agent_version      INTEGER,
  agent_sha          TEXT NOT NULL,
  trigger_event_id   TEXT NOT NULL,
  decision_p         REAL,                 -- null when no question was asked
  session_id         TEXT,
  origin_session_id  TEXT,
  agent              TEXT,
  access             TEXT NOT NULL CHECK (access IN ('read-only','write')),
  output_kind        TEXT NOT NULL CHECK (output_kind IN ('plan','review','note')),
  status             TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled','timed_out')),
  follow_up_sent     INTEGER NOT NULL DEFAULT 0,
  tokens             INTEGER NOT NULL DEFAULT 0,
  pin_checkpoint_id  TEXT,
  warning            TEXT CHECK (warning IN ('files_changed')),
  result_json        TEXT,
  sent_turn_id       TEXT,
  error_code         TEXT,
  error_detail       TEXT,
  deadline_at        INTEGER,
  created_at         INTEGER NOT NULL,
  started_at         INTEGER,
  ended_at           INTEGER,
  UNIQUE (trigger_event_id, handle)
);
CREATE INDEX runs_by_change ON runs(change_id, created_at);
```

- `sessions.role_run_id` becomes `sessions.run_id`.
- `checkpoints.reason`: `role_pin` becomes `run_pin`. This needs the table rebuild pattern of migration `0004_drop_unused_statuses`.
- Copy each role run: `handle` from `role_name`, `agent_sha` from `role_sha`, `output_kind = 'review'` when its result has `findings`, else `'note'`.
- Rewrite each `role.*` lifecycle event to its new type and `source`. Rename the payload key `role` to `handle`, drop `scope` and `round`, and set `agentId: null`.

## Migration of existing agents

A one-time, idempotent step in the Worker. It runs for a user on the first `listAgents`, `saveAgent` or `listProjectAgents` call after deploy, when the user has no `agent_migrations` row.

1. For each active `custom_agents` row, read its file at `commit_sha` and write an `agents` row. Take the handle from the name: lowercase, runs of other characters become `-`, cut to 32 characters, and add `-2`, `-3` and so on for a repeat.
2. For each `user_roles` row that parses, write an `agents` row: the role body becomes `prompt`, `agent` becomes `baseAgent` (`other` becomes `auto`), and `access` and `model` copy. Use `review` as the output kind when the role name is `reviewer` or `ci`, else `note`. A row that does not parse is skipped and logged by name only.
3. Copy the starters (A3), skipping a handle that already exists.

Invalid derived handles use an `agent-` prefix or `agent` fallback. Duplicate names gain a suffix. Imports preserve all definitions even above 50; only new creates are blocked until the active count is below 50. The owner approved these migration rules and the `AgentAttachment` schema name on 2026-10-13.
4. Write the `agent_migrations` row in the same D1 batch as the last insert.

Owner-approved long-prompt policy (2026-10-13): truncate the copied prompt to 32,000 characters and, when needed, further to fit the 64 KiB definition limit. Preserve the full original in read-only legacy storage and log only the affected name.

Tempo creates no attachments in the migration. Old role triggers do not carry over.

## Server functions

The tab 02 rules apply. The `/api/v1` routes for native clients mirror them (tab 07).

| Function | Input | Output | Errors |
| --- | --- | --- | --- |
| `listAgents` | `{}` | `AgentSummary[]` | — |
| `getAgent` | `{agentId}` | `Agent` | `NOT_FOUND` |
| `saveAgent` | `{agentId?, definition}` | `Agent` | `AGENT_INVALID`, `AGENT_LIMIT`, `AGENT_NAME_TAKEN` |
| `deleteAgent` | `{agentId}` | `{}` | `NOT_FOUND` |
| `listProjectAgents` | `{projectId}` | `AgentAttachment[]` | `NOT_FOUND` |
| `putProjectAgent` | `{projectId, agentId, enabled, hooks, autoSend, maxRuns, timeout}` | `AgentAttachment` | `ATTACHMENT_INVALID`, `NOT_FOUND` |
| `deleteProjectAgent` | `{projectId, agentId}` | `{}` | `NOT_FOUND` |
| `requestAgent` | `{workspaceId, agentId, text?, sessionId?}` | `{changeId, runId}` | `NOT_FOUND`, `RUN_LIMIT`, `WORKSPACE_ARCHIVED` |
| `cancelRun` | `{workspaceId, runId}` | `{}` | `NOT_FOUND` |
| `listRuns` | `{workspaceId, changeId?}` | `Run[]`, newest first, at most 200 | — |
| `sendRunToChat` | `{workspaceId, runId}` | `{turnId}` | `NOT_FOUND`, `RUN_NOT_COMPLETED`, `RUN_ALREADY_SENT`, `RUN_NO_CHAT` |
| `resolveAgentProposal` | `{workspaceId, proposalId, apply}` | `{}` | `NOT_FOUND`, `AGENT_INVALID`, `ATTACHMENT_INVALID` |

`createSession` accepts `agentId`, and reads the definition from D1. `listLifecycleEvents` and `getTrace` stay. `getTrace` returns runs with `handle`, `agentSha` and the matched hook.

Workspace channel: `run {run}` reports each run change. `Session.runId?` marks a hidden run session.

**Error codes.** Remove the `ROLE_*` codes. Add these to tab 02.

| Code | UI message |
| --- | --- |
| `AGENT_INVALID` | The agent is not valid. |
| `AGENT_LIMIT` | You have the most agents allowed. Delete one first. |
| `AGENT_NAME_TAKEN` | Another agent has this name or handle. |
| `ATTACHMENT_INVALID` | The agent's hooks or limits are not valid. |
| `RUN_LIMIT` | This agent ran the most times allowed for this change. |
| `RUN_NO_AGENT` | No agent can run this. Add a login in Settings. |
| `RUN_TURN_FAILED` | The agent stopped before it finished. |
| `RUN_RESULT_MISSING` | The agent did not report a result. |
| `RUN_ACCESS_VIOLATION` | The agent changed protected login files. |
| `RUN_TIMED_OUT` | The agent ran out of time. |
| `RUN_NOT_RUNNING` | (Tool error only.) |
| `RUN_NOT_COMPLETED` | The run has no result yet. |
| `RUN_ALREADY_SENT` | This result is already in the chat. |
| `RUN_NO_CHAT` | This run has no chat to send to. |

## Clients

Web (tab 04) and Mac (tab 07) change in the same milestone.

| Where | What |
| --- | --- |
| Settings → Agents (personal) | One list replaces the Agents and Roles tabs. Add, edit, duplicate and delete. A form for every field, plus a read-only JSON view of the definition. |
| Project settings → Agents | The attached agents: enabled, hooks (event, question, threshold), auto-send, max runs, timeout. Add agent opens the library. |
| Chat transcript | The run card: handle, name, hook event, decision probability, base agent, access, status and time. While running: Cancel. When done: the result by output kind, then Approve or Send to chat, Open transcript, Dismiss. A `files_changed` warning shows with Revert. |
| Chat transcript | One quiet line per event that had skipped decisions: each handle with its probability. |
| Tab bar | Run sessions do not show. Open transcript shows one in a side panel. |
| Workspace activity | Runs with no origin session |
| Composer | `@handle` in a group named `Agents`, and `/agent`.  |
| Chat transcript | The agent proposal card, with Apply and Reject |
| Diagnostics → Events | `run.decided` rows show the question from the attachment, the probability and the threshold |

## Lifecycle storage and dispatch

Keep the ordered lifecycle outbox, envelope validation, causation and dedupe rules. Migration `0010_agents` rebuilds `lifecycle_events` with `source IN ('agent','tempo','run')` and renames `role_run_id` to `run_id`, preserving sequence numbers, IDs, causes, dedupe keys and dispatch state. Retain `turns.change_id`; migrate the old `role` turn origin to `run`, keeping `user` and `continue`.

After the cause transaction commits, one dispatch takes undispatched events in `seq` order. It matches attachments as described in Decision, records each decision and any admitted run in the same transaction, then marks the event dispatched. A restart replays undispatched events; run and decision dedupe keys prevent duplicates. `RUN_LIMIT` is terminal and does not dispatch hooks. A change ends only after its turns and runs are terminal and its events are dispatched. Lifecycle events and runs are kept until workspace deletion; housekeeping does not prune them.

At most one write run is running per workspace. Runs retain their frozen profile through reload and handoff. Credential-file protection, cancellation during startup, deferred credential updates and checkpoint crash recovery retain the existing engine's ordering. `sendPrompt` to a running run session returns `SESSION_BUSY`.

## Trace

`getTrace {workspaceId, eventId}` returns `chain` from the origin to the selected event, `children` caused by it, and `runs` it started. Runs show `handle`, `agentSha` and the matched hook. Decision rows join their attachment for the current question; the event stores no question text or decision state.

## Spikes

| ID | Question | Pass criteria |
| --- | --- | --- |
| S20 (extended) | For each of the four agents: which mode, or which denied tools, stops file changes? Can the agent still change files through its shell tool? | Each agent has a recorded mode id or tool list. A test prompt that asks for an edit leaves the tree unchanged, or the result is recorded as a known gap. |
| S22 | What are the exact `AI` binding request and response fields for `@cf/cloudflare/clef-flash` with `noul` questions? What is the latency from a Worker? | The call is written in tab 08. With a 4 KiB state and 4 questions, p95 is under 1 second over 50 calls. |
| S23 | Does each agent call `report_result` when the output kind text asks it to? | For each of the four agents and each output kind: a valid report in at most one follow-up. Replaces the result-file part of S21. |

## Milestones

Each milestone is one pull request and merges when its own tests pass.

| Milestone | Content | Demo |
| --- | --- | --- |
| M1 Spec | All spec changes above, with S22 done | The owner approves the spec |
| M2 Library | `agents`, `project_agents`, the migration, starters, agent and attachment functions, both Settings pages, chat sessions from an agent | A migrated definition starts a chat. A new agent attaches to a project with no deploy. |
| M3 Runs | `runs` rebuild, the run engine, `report_result`, the run card, Send to chat, read-only controls, requests | `@reviewer` shows a findings card, and Send to chat queues the turn |
| M4 Decisions | `AI` binding, the decision step, `run.decided`, skip lines, Diagnostics | A push that touches auth code runs the reviewer. A push that does not shows a skip line. |
| M5 Proposals | `list_agents`, `propose_agent_change`, the proposal card, `resolveAgentProposal` | "Make me an agent that checks migrations on push" ends with an applied agent and attachment |
| M6 Remove | Obsolete files, parsers, settings and storage clients; keep legacy D1 tables read-only until Gate I passes | One agent concept in code, wire types and spec; historical names appear only in migration code |

## Tests

Follow `docs/CI.md` and the CI and test budget rules in `AGENTS.md`. Every test proves one behavior and asserts an outcome.

- Unit: definition and hook validation, handle derivation, hook matching, decision batching at 64, threshold, the state builder's caps and redaction, each output kind schema, the Send to chat texts and the migration mapping.
- Worker integration with `@cloudflare/vitest-pool-workers` and a fake `AI` binding: ownership and CRUD for every new function; event → decision → run → `report_result` → `run.completed` → auto-send; the follow-up; `RUN_RESULT_MISSING`; timeout; cancel; the files-changed warning; protected files; `max_runs`; decision failure and Run anyway; proposal apply and reject; migration idempotency.
- `tempod`, in the container image: `report_result` is listed only with `TEMPO_RUN_ID` and uses the right schema; `list_agents` and `propose_agent_change` are hidden in run sessions.

## Gate I

Tab 06 rules: deployed, real logins, three runs in a row.

1. An agent saved in Settings and attached to a project runs on its hook in a workspace, with no deploy.
2. A `branch.pushed` hook with a question runs the agent for a matching change and skips it for a change that does not match. Both decisions show their probability in the trace.
3. `@planner` shows a plan card. Approve queues a turn in the chat with the plan.
4. A `review` run reports a blocking finding. Send to chat queues the fix request.
5. A read-only agent that edits a file shows the warning, and Revert restores the files.
6. A `check.failed` attachment with auto-send stops at `max_runs`.
7. `propose_agent_change` from a chat ends with an applied agent. A rejected proposal changes nothing.
8. Kill the container during a run: the run fails with `RUN_TURN_FAILED`, no event is lost, and dispatch resumes after the DO restarts.
9. A grep of lifecycle events, run results and decision logs for the test credentials finds nothing.

## Out of scope

Agents in the repository, `change.ended` hooks, `choice` and `score` questions for routing, cross-workspace decision history, per-day and per-user budgets, sharing agents between users, and approval of agent changes made in Settings.
