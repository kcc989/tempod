# 08 Events and Roles

This tab defines two features. **Lifecycle events** record what happens in a workspace as a small set of typed facts. **Roles** are markdown files that start agent sessions when an event or a person asks for them, for example plan → code → CI → review. A new or changed role never needs a redeploy.

Built-in roles use the same path as user roles. The host has no code for any one role.

| # | Decision | Choice | Reason |
| --- | --- | --- | --- |
| E1 | Role format | A markdown file with YAML front matter. The body is the prompt. | Claude Code, OpenCode, Copilot and Factory define agents the same way. YAML uses `yaml`, as the settings file does (01). |
| E2 | Role sources | Built-in files, user roles in D1, and `.tempo/roles/*.md` on the workspace branch | No redeploy for user or repo roles |
| E3 | Triggers | Exact filters on event type and a few payload fields | Static filters are enough for the chain. GitHub Actions `on:` works the same way. |
| E4 | Agent events | Only `agent.turn.ended`. Tool, plan and usage detail stays in the existing `events` and `items` tables. | Small vocabulary, no new `tempod` protocol |
| E5 | Where events live | One ordered log per workspace in WorkspaceDO SQLite, written in the same transaction as the event's cause. Dispatch runs after the commit. | A dispatch failure cannot lose an event |
| E6 | Role run | A new session in the same workspace, through the existing session and turn code | One container per workspace (00). Turns stay serialized. |
| E7 | Access | Read-only roles are guided by a fixed prompt and checked after each turn. Agents keep their default mode (01). | Works the same for all four agents |
| E8 | Result | One fixed JSON shape in one file per run | One check for every role. No per-role schemas. |
| E9 | Trust | No approval step. Limits bound every run. | One trusted owner (00) |

## Vocabulary

These words join the vocabulary in 00. Use them exactly.

| Term | Meaning | Code name |
| --- | --- | --- |
| Lifecycle event | One typed fact in the workspace log, in the envelope below. Not the same as an `events` row, which is a raw `tempod` event (02). | `lifecycleEvent` |
| Change | One user prompt or role request, and every turn and role run it causes. Not the same as a changed file (`getChanges`, `git.changed`). | `change` |
| Role | A named markdown file that defines an agent's job | `role` |
| Role run | One execution of one role in one session | `roleRun` |
| Result | The JSON a role run writes when it ends | `result` |

## Lifecycle events

**Envelope.** In `packages/protocol` as the Effect Schema `LifecycleEvent`.

| Field | Type | Rule |
| --- | --- | --- |
| `id` | ULID | Lowercase (02, Conventions) |
| `type` | One of the types below | A closed union. An unknown type or a bad payload is rejected with `EVENT_INVALID`. |
| `source` | `agent`, `tempo` or `role` | Who caused it |
| `occurredAt` | integer ms | 02, Conventions |
| `workspaceId` | ULID | |
| `changeId` | ULID, optional | |
| `turnId` | ULID, optional | |
| `roleRunId` | ULID, optional | |
| `sessionId` | ULID, optional | The Tempo session id |
| `agent` | Agent id, optional | |
| `causationId` | ULID, optional | The event that caused this one |
| `dedupeKey` | string | Unique in the log |
| `payload` | object | Validated against the type's schema |

**Types**

| Type | Source | When | Payload | Caused by |
| --- | --- | --- | --- | --- |
| `tempo.change.created` | `tempo` | A turn is queued in a session with no `role_run_id`, or `requestRole` is called | `origin: "prompt" or "request"`, `role?`, `text?` | Nothing (origin) |
| `agent.turn.ended` | `agent` | `turn.ended` from `tempod` | `status: "completed", "cancelled", "failed" or "interrupted"`, `stopReason`, `errorCode?`, `usage?` | The change's `tempo.change.created`, or the run's `role.run.started` |
| `role.run.started` | `role` | A role run is inserted | `role, scope, roleSha, round, agent, access` | The event that triggered it |
| `role.run.completed` | `role` | A valid result is stored | `role, round, result` | The run's last `agent.turn.ended` |
| `role.run.failed` | `role` | Any failure (Error codes) | `role, round, errorCode, detail?` | The event that ended the run |
| `tempo.change.ended` | `tempo` | The change has no queued or running turn or role run, and all its events are dispatched | `status: "done", "failed" or "cancelled"` | The change's last event |
| `tempo.branch.pushed` | `tempo` | A `commit_push` op ends `done` | `branch, commitSha` | — |
| `tempo.check.passed`, `tempo.check.failed` | `tempo` | `checks_state` changes to `success` or `failure` (03, Status polling) | `prNumber` | — |

- `status` in `agent.turn.ended` uses the turn status rules in 03.
- `tempo.change.ended` status: `cancelled` if the user cancelled the change's last run; else `failed` if its last role run failed; else `done`.
- Status polling runs only while a UI socket is open (03), so `tempo.check.*` arrives only then.
- `tempo.branch.pushed` and `tempo.check.*` belong to the newest open change, if one exists.

**Dedupe keys**

| Origin | Key |
| --- | --- |
| `turn.ended` from `tempod` | `tempod:<incarnation>:<seq>` |
| A turn or request | `change:<changeId>:created` |
| A role run | `run:<roleRunId>:<type>` |
| A change end | `change:<changeId>:ended` |
| An op | `op:<opId>:<type>` |
| A checks change | `checks:<prNumber>:<headSha>:<type>` |

**Rules**

- Write `agent.turn.ended` only when the raw `events` insert for that `turn.ended` stored a row. A duplicate `(incarnation, seq)` writes nothing. `incarnation.changed` MUST NOT delete lifecycle events.
- A payload MUST NOT hold transcript text, tool input or output, file contents, prompts or env. Request `text` and role results are the only free text, each at most 64 KiB.
- Secrets MUST NOT be in a lifecycle event (05).

## Roles

**File format.** YAML front matter between two `---` lines, then the prompt as markdown.

```markdown
---
description: Reviews the branch diff against the plan and reports blocking issues.
agent: other
access: read-only
inputs: [diff, plan, "result:coder"]
requestable: true
on:
  - event: role.run.completed
    role: coder
    status: done
limits:
  rounds: 2
  continues: 2
  timeout: 20m
  tokens: 2000000
---
Review the diff against the plan. Report each problem as a finding.
Mark a finding blocking when the change must not merge with it.
Set status "pass" when no finding is blocking, else "fail".
```

**Fields.** Validated with the Effect Schema `RoleFile` in `packages/protocol`. Unknown keys are errors.

| Field | Values | Default |
| --- | --- | --- |
| `description` | Text, at most 500 characters | Required |
| `agent` | `claude`, `codex`, `opencode`, `pi`, `auto` or `other` | `auto` |
| `model` | `default`, or a model value | `default`: `agent.models.<agent>` from the effective settings |
| `access` | `read-only` or `write` | `read-only` |
| `inputs` | `prompt`, `diff`, `plan`, `result:<role>` | None |
| `requestable` | `true`: the role can be started by `/role` or `@` | `false` |
| `on` | Triggers (below) | None |
| `limits.rounds` | Runs of this role per change, 1 to 10 | 1 |
| `limits.continues` | Follow-up prompts per run, 0 to 10 | 2 |
| `limits.timeout` | `<n>m` or `<n>h`, at most `2h` | `20m` |
| `limits.tokens` | Total tokens per run; 0 = no cap | 0 |

- The role's name is the file name without `.md` for built-in and repo roles, and the stored name for user roles. A name matches `^[a-z][a-z0-9-]{1,31}$`.
- Parse the front matter with `yaml` as YAML 1.2, so the key `on` is a string, not a boolean.
- The body is sent as it is. Tempo does not fill in templates.
- A role needs `on`, or `requestable = true`, or both.
- A file that fails to parse or validate is listed with its error and never runs.

**Triggers.** Each entry in `on` matches an event when every key in the entry matches.

| Key | Matches | Allowed with |
| --- | --- | --- |
| `event` | The event type. Required. | `role.run.completed`, `role.run.failed`, `agent.turn.ended`, `tempo.branch.pushed`, `tempo.check.passed`, `tempo.check.failed`, `tempo.change.created` |
| `role` | `payload.role` | `role.run.*` |
| `status` | `payload.result.status` for `role.run.completed`; `payload.status` for `agent.turn.ended` | `role.run.completed`, `agent.turn.ended` |
| `session` | `user` (a session with no `role_run_id`) or `role` | `agent.turn.ended`; default `user` |

**Agent choice**

- `auto` is the project's default agent.
- `other` is the first agent in this list that is not the trigger's agent, has its credential set, and, for `opencode` and `pi`, has a model: the project's default agent, then `claude`, `codex`, `opencode`, `pi`. The trigger's agent is the `agent` field of the trigger event. With no trigger agent, `other` is `auto`.
- If no agent qualifies, the run fails with `ROLE_NO_AGENT`.

**Sources and precedence**

| Scope | Where | When Tempo reads it |
| --- | --- | --- |
| `repo` | `.tempo/roles/*.md` on the workspace branch, read with `fs.list` and `fs.read` | After `repo.clone`, after a fresh-disk wake, and on `reloadRoles`. Not on file changes. |
| `user` | D1 `user_roles` | On every load of the workspace's roles, and after `putUserRole` or `deleteUserRole` |
| `builtin` | `packages/roles-builtin/*.md`, embedded in the Worker build | At DO start |

When two scopes have a role with the same name, the workspace uses `repo`, then `user`, then `builtin`. The WorkspaceDO keeps the parsed roles in memory and stores each run's `roleSha` (SHA-256 of the file text), so the trace shows the exact file that ran.

## Storage

**WorkspaceDO SQLite** (migration `0006_lifecycle`)

```sql
CREATE TABLE lifecycle_events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,  -- log order
  id             TEXT NOT NULL UNIQUE,
  type           TEXT NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('agent','tempo','role')),
  occurred_at    INTEGER NOT NULL,
  change_id      TEXT,
  turn_id        TEXT,
  role_run_id    TEXT,
  session_id     TEXT,
  agent          TEXT,
  causation_id   TEXT,
  dedupe_key     TEXT NOT NULL UNIQUE,
  payload_json   TEXT NOT NULL,
  dispatched_at  INTEGER                              -- null until dispatch finished
);
CREATE INDEX lifecycle_by_change ON lifecycle_events(change_id, seq);
CREATE INDEX lifecycle_by_causation ON lifecycle_events(causation_id);
CREATE INDEX lifecycle_undispatched ON lifecycle_events(seq) WHERE dispatched_at IS NULL;

CREATE TABLE role_runs (
  id                TEXT PRIMARY KEY,
  change_id         TEXT NOT NULL,
  parent_run_id     TEXT,                            -- the run whose event triggered this one
  depth             INTEGER NOT NULL,                -- parent depth + 1; 1 with no parent
  role_name         TEXT NOT NULL,
  scope             TEXT NOT NULL CHECK (scope IN ('builtin','user','repo')),
  role_sha          TEXT NOT NULL,
  trigger_event_id  TEXT NOT NULL,
  session_id        TEXT,
  agent             TEXT,
  access            TEXT NOT NULL CHECK (access IN ('read-only','write')),
  status            TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled','timed_out')),
  round             INTEGER NOT NULL,
  continues_used    INTEGER NOT NULL DEFAULT 0,
  tokens            INTEGER NOT NULL DEFAULT 0,
  pin_checkpoint_id TEXT,                            -- role_pin checkpoint of the current turn
  result_json       TEXT,
  error_code        TEXT,
  error_detail      TEXT,
  deadline_at       INTEGER,
  created_at        INTEGER NOT NULL,
  started_at        INTEGER,
  ended_at          INTEGER,
  UNIQUE (trigger_event_id, role_name)
);
CREATE INDEX role_runs_by_change ON role_runs(change_id, created_at);

ALTER TABLE sessions ADD COLUMN role_run_id TEXT;
ALTER TABLE turns ADD COLUMN change_id TEXT;
ALTER TABLE turns ADD COLUMN origin TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user','role','continue'));
```

- `checkpoints.reason` gains `role_pin`. The CHECK constraint needs a table rebuild, as in migration `0004_drop_unused_statuses`.
- Lifecycle events and role runs are kept until the workspace is deleted. The `housekeeping` op does not prune them.
- Readers order events by `seq`, not `occurred_at`.

**D1** (migration `0001_user_roles`)

```sql
CREATE TABLE user_roles (
  user_id     TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  text        TEXT NOT NULL,          -- the whole role file, at most 64 KiB
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, name)
);
```

Only `putUserRole` and `deleteUserRole` write `user_roles`.

## Dispatch

After the transaction that writes events commits, the WorkspaceDO runs dispatch. One dispatch runs at a time.

1. Take undispatched events in `seq` order.
2. Find the roles with a trigger that matches the event. Skip all of them if `roles.enabled` is false.
3. Apply the limits (Limits). A role that fails a limit gets `role.run.failed` with `ROLE_LIMIT`.
4. Insert a role run for each match, with its `role.run.started`, in one transaction. `UNIQUE (trigger_event_id, role_name)` makes a repeat do nothing.
5. Set `dispatched_at`. Then check whether the event's change has ended.

A crash during dispatch leaves `dispatched_at` null. The DO constructor runs dispatch again.

## Role runs

1. **Admit.** Insert the run as `queued`. At most one `write` run is `running` per workspace; other write runs wait in creation order. Read-only runs do not wait.
2. **Session.** Choose the agent. Create a session with `role_run_id` set and title `<role> #<round>`. Set the run `running` and `deadline_at`.
3. **Pin.** Before each turn of the run, request `git.checkpoint {reason: "role_pin"}` and upload the bundle as for other checkpoints (03). Store its id in `pin_checkpoint_id`. An unchanged tree reuses the newest checkpoint.
4. **Prompt.** Queue the first turn with `origin: "role"`. Its content blocks, after the first-prompt blocks in 01: the role header, the access text, the result text, the role body, the request text (if any), then one text block per input. Each input is capped at 256 KiB, and all inputs together at 512 KiB. A cut input ends with `[cut by Tempo]`.
5. **Turn end.** At each `agent.turn.ended` of the run, in this order:
   1. Add `usage.totalTokens` to the run.
   2. If the turn status is not `completed`, fail the run with `ROLE_TURN_FAILED`.
   3. For a read-only run, compare the tree of `pin_checkpoint_id` with the tree of the turn's `turn_end` checkpoint (03). If they differ, fail the run with `ROLE_ACCESS_VIOLATION`.
   4. Read `/home/tempo/roles/<roleRunId>/result.json` with `Files`, and validate it (Result).
   5. If it is missing or invalid: if `continues_used < limits.continues` and the token limits allow it, queue a continue turn with the matching fixed text at the head of the queue, and add 1 to `continues_used`. Otherwise fail the run with `ROLE_RESULT_MISSING` or `ROLE_RESULT_INVALID`.
   6. Store the result and emit `role.run.completed`.
6. **End.** Send `session.close` to free the adapter. The session row stays, so its tab still shows the transcript.

**While a run is `running`**

- `sendPrompt` to its session returns `SESSION_BUSY`.
- Other sessions keep working. Their turns can run between the run's turns.
- `cancelRoleRun` cancels the running turn, deletes the session's queued turns, and sets the run `cancelled`.
- A continue turn is not the first prompt of the session, so the turn-summary rule and `prompts.general` are not added again (01).

**Timeout.** `deadline_at` joins the single alarm (03, Step runner). When it passes, send `session.cancel`, set the run `timed_out`, and emit `role.run.failed` with `ROLE_TIMED_OUT`.

**Read-only violations.** Tempo does not restore the files, because a restore can delete other work. The failed run adds a notice item to its session: `This read-only role changed files. Revert to the checkpoint before its turn to undo.`. The notice has an action that calls `revertToCheckpoint` with `pin_checkpoint_id`. Revert makes a safety checkpoint first (03). Files changed by a terminal or a run script during the turn also count.

**Result.** The Effect Schema `RoleResult` in `packages/protocol`:

| Field | Type |
| --- | --- |
| `status` | `done`, `pass`, `fail` or `blocked` |
| `summary` | Text, at most 4,000 characters |
| `findings` | Optional, at most 200: `{path, line?, text, blocking}` |

The file must be at most 64 KiB of JSON. For a write role, `done` means the work is complete.

**Fixed texts.** Exact. `<…>` is filled in.

| Text | Value |
| --- | --- |
| Role header | `You are working as the Tempo role "<name>": <description>` |
| Access, read-only | `This role is read-only. Do not create, change, move or delete files under /workspace, and do not run commands that do, such as formatters, code generators or git commands that change the branch. You may read files and run commands that only read. Tempo compares the files before and after each turn and fails the run if they differ.` |
| Access, write | `This role may change files under /workspace. Do not commit, push or change the branch. Tempo does that.` |
| Result | `When you finish, write your result to /home/tempo/roles/<roleRunId>/result.json as JSON: {"status": "done" or "pass" or "fail" or "blocked", "summary": "<text>", "findings": [{"path": "<path>", "line": <number>, "text": "<text>", "blocking": true or false}]}. "findings" is optional. Use "done" only when the work is complete.` |
| Continue, no result | `Tempo did not find your result at /home/tempo/roles/<roleRunId>/result.json. Finish the work if it is not complete, write the result, then end your turn.` |
| Continue, invalid result | `Your result at /home/tempo/roles/<roleRunId>/result.json is not valid: <problem>. Fix the file, then end your turn.` |

**Inputs**

| Name | Text |
| --- | --- |
| `prompt` | The text of the turn or request that created the change |
| `diff` | `git.changes {scope: "branch"}` plus `git.fileDiff` for each file |
| `plan` | The newest `plan` item in the change, else the newest result of a role named `planner` in the change |
| `result:<role>` | The newest result of `<role>` in the change, as JSON |

A missing input is the text `(none)`.

## Requests

- **Composer.** In a chat tab, `/role <name> <text>`, or an `@<name>` role chip, sends a request instead of a prompt. The `@` menu shows requestable roles in a group named `Roles`, above files. Tempo reserves `/role` and does not send it to the agent. One role per message.
- **`requestRole {workspaceId, role, text?, sessionId?}`** creates a change (`origin: "request"`), then a role run caused by `tempo.change.created`. The trigger's agent is the agent of `sessionId`, if given.
- A request skips triggers. It does not skip limits.

## Limits

| Limit | Rule |
| --- | --- |
| Rounds | At most `limits.rounds` runs of a role per change |
| Chain depth | A run's `depth` is at most `roles.max_chain_depth` |
| Runs per change | At most `roles.max_runs_per_change` |
| Tokens | `limits.tokens` per run; `roles.max_tokens_per_change` per change. Checked before each turn of a run. 0 means no cap. |
| Timeout | `limits.timeout` per run |
| Logins | Role runs MUST NOT change agent login files or the static agent config files (01) |

A limit hit fails the run with `ROLE_LIMIT` and names the limit in `detail`.

Project settings gain a `roles` section in `.tempo/settings.yaml` (01):

```yaml
roles:
  enabled: true               # false: no triggers and no requests in this project
  max_chain_depth: 10
  max_runs_per_change: 20
  max_tokens_per_change: 0    # 0 = no cap
```

## Built-in roles

`packages/roles-builtin/` holds four role files. They use only the public format.

| Role | Access | Triggers | Inputs |
| --- | --- | --- | --- |
| `planner` | read-only | Requestable only | `prompt` |
| `coder` | write | `role.run.completed` from `planner` with `done`; `role.run.completed` from `reviewer` with `fail`; `role.run.completed` from `ci` with `fail`. Rounds 3. | `prompt`, `plan`, `result:reviewer`, `result:ci` |
| `ci` | read-only | `role.run.completed` from `coder` with `done` | `diff` |
| `reviewer` | read-only, agent `other` | `role.run.completed` from `ci` with `pass`. Also requestable. Rounds 3. | `diff`, `plan`, `result:coder` |

The chain starts only when the owner asks for it with `/role planner <text>`. No built-in role runs on a plain prompt.

## Trace

`getTrace {workspaceId, eventId}` returns:

- `chain`: the events from the origin of the causation chain to this event, in order;
- `children`: the events this event caused;
- `runs`: the role runs this event started, with `role_name`, `scope`, `role_sha` and the trigger that matched.

Why a role did not match follows from its `on` filters and the event. The UI shows both.

## API

Server functions (02 rules apply). The `/api/v1` routes for native clients mirror them (07).

| Function | Input | Output | Errors |
| --- | --- | --- | --- |
| `listRoles` | `{workspaceId?}` | `[{name, scope, sha, description, agent, access, requestable, on, limits, error?, shadowedBy?}]`. With `workspaceId`, all three scopes as that workspace sees them; without it, `builtin` and `user`. | — |
| `getRoleText` | `{name, scope, workspaceId?}` | `{text}` | `NOT_FOUND` |
| `putUserRole` | `{name, text}` | The parsed role | `ROLE_INVALID` |
| `deleteUserRole` | `{name}` | `{}` | `NOT_FOUND` |
| `reloadRoles` | `{workspaceId}` | Same as `listRoles` | `CONTAINER_NOT_READY` |
| `requestRole` | `{workspaceId, role, text?, sessionId?}` | `{changeId, roleRunId}` | `ROLE_NOT_FOUND`, `ROLE_NOT_REQUESTABLE`, `ROLE_LIMIT`, `WORKSPACE_ARCHIVED` |
| `cancelRoleRun` | `{workspaceId, roleRunId}` | `{}` | `NOT_FOUND` |
| `listRoleRuns` | `{workspaceId, changeId?}` | `RoleRun[]`, newest first, at most 200 | — |
| `listLifecycleEvents` | `{workspaceId, changeId?, beforeSeq?, limit?}` | `{events, nextBeforeSeq}`, newest first, at most 500 | — |
| `getTrace` | `{workspaceId, eventId}` | Trace | `NOT_FOUND` |

- `putUserRole` and `deleteUserRole` call `rolesChanged()` on every live WorkspaceDO of the user.
- Workspace channel: a new message, `roleRun {run: RoleRun}`, when a run changes. `Session` gains `roleRunId?`.
- `tempod`: `fs/read_text_file` and `fs/write_text_file` also allow `/home/tempo/roles/` (01). Nothing else changes in the `tempod` protocol.

## UI

Web (04) and Mac (07) change in the same milestone.

| Where | What |
| --- | --- |
| Settings → Roles (personal) | All roles by scope, with errors and which file shadows which. User roles: add, edit as plain text, delete. Built-in and repo roles: view only. |
| Chat tabs | A role session's tab shows the role name and run status. Its composer is disabled while the run is `running`, with Cancel run. |
| Composer | `/role` and the `Roles` group in the `@` menu |
| Notices | Run failures as notice items in the role session, with the Revert action for read-only violations |
| Diagnostics | An Events panel: the newest 500 lifecycle events, filtered by change. Selecting one shows its trace. |

## Error codes

These join the table in 02.

| Code | Meaning | UI message |
| --- | --- | --- |
| `EVENT_INVALID` | Unknown event type or bad payload | (Logged only.) |
| `ROLE_NOT_FOUND` | No role with that name | No role with that name. |
| `ROLE_NOT_REQUESTABLE` | `requestable` is false | This role can't be started by hand. |
| `ROLE_INVALID` | The role file failed to parse or validate | The role file is not valid. |
| `ROLE_LIMIT` | A limit stopped the run | A role limit stopped this run. |
| `ROLE_NO_AGENT` | No agent qualifies | No agent can run this role. Add a login in Settings. |
| `ROLE_TURN_FAILED` | A turn of the run did not complete | The role's agent stopped before it finished. |
| `ROLE_RESULT_MISSING` | No result after the last continue | The role did not report a result. |
| `ROLE_RESULT_INVALID` | The result failed validation after the last continue | The role's result was not valid. |
| `ROLE_ACCESS_VIOLATION` | A read-only run changed files | This read-only role changed files. |
| `ROLE_TIMED_OUT` | The run passed its deadline | The role ran out of time. |

## Files

| Path | Content |
| --- | --- |
| `packages/protocol/src/lifecycle.ts` | `LifecycleEvent`, `RoleFile`, `RoleResult`, `RoleRun` |
| `packages/roles-builtin/` | `planner.md`, `coder.md`, `ci.md`, `reviewer.md` |
| `apps/tempo/src/roles/` | `parse.ts` (front matter and validation), `match.ts`, `inputs.ts` |
| `apps/tempo/src/do/workspace/lifecycle.ts` | Append, dispatch, change end |
| `apps/tempo/src/do/workspace/role-runs.ts` | Run lifecycle, write lock, read-only check, result check |
| `apps/tempo/src/server/handlers/roles.ts` | Role server functions |
| `apps/tempo/src/db/` | D1 migration `0001_user_roles`, DO migration `0006_lifecycle` |
| `spikes/S21.md` | Spike result |

No new dependencies.

## Spike

| ID | Question | Pass criteria |
| --- | --- | --- |
| S21 | Does a follow-up prompt continue the same context, and does each agent write the result file? Needs real logins. | For each of the four agents: after a turn ends with `end_turn`, a second `session/prompt` that refers to the first turn gets an answer that uses it. A role prompt with the fixed texts produces a valid `result.json` in at most one continue. Record how often a read-only role changes files. |

## Phase 6 and gate H

Phase 6 adds this tab. It MAY run in parallel with phases 2 to 5. This doc change merges first. Each milestone merges when its own tests pass. Gate H needs gate B.

| Milestone | Content | Demo |
| --- | --- | --- |
| M1 Events | Protocol schemas; lifecycle events in the WorkspaceDO, written in the transaction of their cause; dispatch outbox; `listLifecycleEvents`, `getTrace`; Diagnostics Events panel (web and Mac) | A recorded `tempod` session's events show in the trace |
| M2 Roles and runs | Role files in all three scopes, `user_roles`, Settings → Roles, runs, pins, write lock, read-only check, result check, `/role` and `@` (web and Mac). Ship `reviewer` as a requestable built-in. | `/role reviewer focus on auth` runs on another agent and shows its findings |
| M3 Triggers and chain | Trigger matching, limits, timeouts, change end; the other built-ins | `/role planner …` → `coder` → `ci` → `reviewer`, with one `coder` round after a `reviewer` fail |

Build M1 against recorded `tempod` fixtures. Record real fixtures after S1 passes.

**Gate H** (06 rules: deployed, real logins, 3 runs in a row)

1. A user prompt makes `tempo.change.created`, and its `agent.turn.ended` shows in `getTrace`.
2. A user role saved in Settings runs in a workspace with no redeploy. A repo role with the same name shadows it.
3. The built-in chain runs to `tempo.change.ended` with status `done`.
4. A read-only role that edits a file fails with `ROLE_ACCESS_VIOLATION`, and Revert restores the files.
5. Two roles that trigger each other stop at their `rounds` limit.
6. A run past its timeout ends with `ROLE_TIMED_OUT`, and its turn is cancelled.
7. Kill the container during a role run: the run fails with `ROLE_TURN_FAILED`, no event is lost, and dispatch resumes after the DO restarts.
8. A grep of lifecycle events and role results for the test credentials finds nothing.

**Tests** (06, Definition of done)

- Unit: role file parsing; trigger matching; precedence; agent choice; each limit; result validation; dedupe keys.
- Integration (`@cloudflare/vitest-pool-workers`): ingest from fixtures to dispatch; one chain from `tempo.change.created` to `role.run.completed` with a fake `tempod`.

## Out of scope for version 1

Role code (predicates, computed prompts, transforms), custom events, decision events and gates, CLI hooks, approval of role files, per-day and per-user budgets, a cross-workspace index, a `run_role` tool for agents, a model-based router, and learned agent or model choice.

## Sources

- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents) and [hooks](https://code.claude.com/docs/en/hooks)
- [OpenCode agents](https://github.com/sst/opencode/blob/dev/packages/web/src/content/docs/agents.mdx)
- [ACP prompt turn](https://agentclientprotocol.com/protocol/prompt-turn)
