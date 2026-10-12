# 02 Data and API Contracts

This tab is the contract. Every table, column, message type and error code here is exact.

## Conventions

One set of rules for every store and every wire format.

| Topic | Rule |
| --- | --- |
| IDs | ULIDs, stored and sent in lowercase (26 chars from `[0-9a-hjkmnp-tv-z]`). Generate with a monotonic ULID factory, then lowercase. No prefixes. |
| Workspace DO name | The workspace id. `env.WORKSPACE.getByName(workspaceId)`. |
| User DO names | The Better Auth user id, for `UserHubDO` and `CredentialDO`. |
| Time | Integer milliseconds since the Unix epoch, UTC. Columns end in `_at`. |
| Booleans | `INTEGER` 0 or 1 in SQLite; `true` or `false` in JSON. |
| Enums | `TEXT` with a `CHECK` that lists every value. The lists here are exact. |
| JSON columns | `TEXT`, name ends in `_json`, validated with Effect Schema on every read and write. |
| Wire format | JSON objects with a `type` field. Every schema lives once in `packages/protocol` (Effect Schema) and both sides import it. |
| Protocol versions | `v: 1` in every `hello`. A side that gets an unknown `v` closes with code 4400. |
| ORM | Drizzle. D1 migrations run at deploy with `drizzle-kit`. DO migrations run in the DO constructor inside `blockConcurrencyWhile`. |
| Slugs | Lowercase `a` to `z`, `0` to `9`, and `-`. Workspace slugs come from a fixed list of city names; a repeat gets `-2`, `-3`, and so on. |

## D1 schema

D1 holds lists and summaries. Better Auth owns its own tables (`user`, `session`, `account`, `verification`); generate them with the Better Auth CLI and do not edit them by hand.

```sql
CREATE TABLE github_installations (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  installation_id  INTEGER NOT NULL UNIQUE,
  account_login    TEXT NOT NULL,
  account_type     TEXT NOT NULL CHECK (account_type IN ('User','Organization')),
  suspended_at     INTEGER,
  created_at       INTEGER NOT NULL
);

CREATE TABLE projects (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  installation_id  INTEGER NOT NULL REFERENCES github_installations(installation_id),
  repo_id          INTEGER NOT NULL,
  repo_owner       TEXT NOT NULL,
  repo_name        TEXT NOT NULL,
  default_branch   TEXT NOT NULL,
  settings_json    TEXT NOT NULL DEFAULT '{}',
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (user_id, repo_id)
);

CREATE TABLE workspaces (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  slug             TEXT NOT NULL,
  title            TEXT NOT NULL DEFAULT '',
  branch           TEXT NOT NULL,
  base_branch      TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('creating','starting','setting_up','ready','working',
                                                  'stopping','sleeping','archiving','archived','error')),
  attention        TEXT NOT NULL DEFAULT 'none' CHECK (attention IN ('none','unread','needs_input','error')),
  default_agent    TEXT NOT NULL CHECK (default_agent IN ('claude','codex','opencode','pi')),
  pr_number        INTEGER,
  pr_state         TEXT CHECK (pr_state IN ('open','draft','merged','closed')),
  checks_state     TEXT CHECK (checks_state IN ('pending','success','failure')),
  pinned           INTEGER NOT NULL DEFAULT 0,
  last_activity_at INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  archived_at      INTEGER,
  summary_rev      INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX workspaces_active_slug   ON workspaces(project_id, slug)   WHERE archived_at IS NULL;
CREATE UNIQUE INDEX workspaces_active_branch ON workspaces(project_id, branch) WHERE archived_at IS NULL;
CREATE INDEX workspaces_by_activity ON workspaces(user_id, archived_at, last_activity_at DESC);
```

**Write rules for `workspaces`**

- The `createWorkspace` server function inserts the row with `state = 'creating'` and `summary_rev = 0`. After that, only the row's WorkspaceDO writes it.
- Every DO write increments `summary_rev` and uses `UPDATE … WHERE id = ? AND summary_rev < ?`. A stale write changes nothing.
- `setPinned` is not an exception: it calls the WorkspaceDO, which writes `pinned` and publishes the summary.

## WorkspaceDO schema

Each WorkspaceDO holds the full record of one workspace. Everything the UI shows for a workspace comes from here.

```sql
-- Exactly one row, id = 1.
CREATE TABLE workspace (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  workspace_id        TEXT NOT NULL,
  project_id          TEXT NOT NULL,
  user_id             TEXT NOT NULL,
  slug                TEXT NOT NULL,
  title               TEXT NOT NULL DEFAULT '',
  default_agent       TEXT NOT NULL,
  pinned              INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  archived_at         INTEGER,
  branch              TEXT NOT NULL,
  base_branch         TEXT NOT NULL,
  source_json         TEXT NOT NULL,   -- {"kind":"new"} | {"kind":"branch"} | {"kind":"pr","number":12}
  state               TEXT NOT NULL,   -- same values as D1 workspaces.state
  state_since         INTEGER NOT NULL,
  error_code          TEXT,
  error_detail        TEXT,
  attention           TEXT NOT NULL DEFAULT 'none',
  setup_status        TEXT NOT NULL DEFAULT 'none'
                      CHECK (setup_status IN ('none','running','succeeded','failed','skipped')),
  preview_token       TEXT NOT NULL,
  settings_json       TEXT NOT NULL DEFAULT '{}',  -- effective settings, last read
  pushed              INTEGER NOT NULL DEFAULT 0,  -- branch exists on origin
  pr_number           INTEGER,
  pr_state            TEXT,
  checks_state        TEXT,
  last_activity_at    INTEGER NOT NULL,
  last_viewed_at      INTEGER,
  tempod_token        TEXT,            -- TEMPOD_TOKEN of the current container; null when none runs
  tempod_incarnation  TEXT,
  last_pushed_sha     TEXT,
  force_push_lease    INTEGER NOT NULL DEFAULT 0,  -- set by revert; next push uses --force-with-lease
  auto_restarts_json  TEXT NOT NULL DEFAULT '[]',  -- times of unplanned restarts in the last hour
  tempod_acked_seq    INTEGER NOT NULL DEFAULT 0,
  image_ref           TEXT,
  summary_rev         INTEGER NOT NULL DEFAULT 0,
  items_rev           INTEGER NOT NULL DEFAULT 0
);

-- Step runner (03).
CREATE TABLE ops (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('create','wake','sleep','archive','restore','revert',
                                             'commit_push','housekeeping')),
  step          TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending','running','done','failed','cancelled')),
  attempt       INTEGER NOT NULL DEFAULT 0,
  next_run_at   INTEGER NOT NULL,
  input_json    TEXT NOT NULL DEFAULT '{}',
  state_json    TEXT NOT NULL DEFAULT '{}',
  error_code    TEXT,
  error_detail  TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX ops_due ON ops(status, next_run_at);

CREATE TABLE sessions (
  id                   TEXT PRIMARY KEY,
  agent                TEXT NOT NULL CHECK (agent IN ('claude','codex','opencode','pi')),
  title                TEXT NOT NULL DEFAULT '',
  acp_session_id       TEXT,
  status               TEXT NOT NULL CHECK (status IN ('starting','idle','running','closed','broken')),
  mode_id              TEXT,
  config_json          TEXT NOT NULL DEFAULT '{}',  -- {configId: value} chosen by the user
  modes_json           TEXT NOT NULL DEFAULT '[]',  -- as reported by the agent
  config_options_json  TEXT NOT NULL DEFAULT '[]',
  commands_json        TEXT NOT NULL DEFAULT '[]',
  capabilities_json    TEXT NOT NULL DEFAULT '{}',
  usage_json           TEXT NOT NULL DEFAULT '{}',  -- last usage_update
  handoff_pending      INTEGER NOT NULL DEFAULT 0,
  pending_note         TEXT,                        -- added to the next prompt, then cleared
  general_prompt_sent  INTEGER NOT NULL DEFAULT 0,
  sort_order           INTEGER NOT NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  closed_at            INTEGER
);

CREATE TABLE turns (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  seq            INTEGER NOT NULL UNIQUE,  -- 1, 2, 3 … per workspace
  queue_pos      INTEGER,                  -- set only while queued
  steering_pending INTEGER NOT NULL DEFAULT 0 CHECK (steering_pending IN (0, 1)), -- durable live-delivery reservation
  status         TEXT NOT NULL CHECK (status IN ('queued','running','completed','cancelled','failed','interrupted')),
  prompt_json    TEXT NOT NULL,            -- {text, mentions, attachmentIds, reviewCommentIds}
  stop_reason    TEXT,                     -- ACP stopReason
  error_code     TEXT,
  error_detail   TEXT,
  checkpoint_id  TEXT,
  reverted       INTEGER NOT NULL DEFAULT 0,
  queued_at      INTEGER NOT NULL,
  started_at     INTEGER,
  ended_at       INTEGER
);
CREATE INDEX turns_by_status ON turns(status, queue_pos);

CREATE TABLE items (
  id            TEXT PRIMARY KEY,           -- tempod assigns agent item ids; the DO assigns ids of items it makes
  session_id    TEXT NOT NULL,
  turn_id       TEXT,
  kind          TEXT NOT NULL CHECK (kind IN ('user_message','agent_message','agent_thought','tool_call',
                                             'plan','permission','notice','handoff','revert_marker','error')),
  status        TEXT NOT NULL CHECK (status IN ('streaming','pending','in_progress','completed','failed','cancelled')),
  content_json  TEXT NOT NULL,
  rev           INTEGER NOT NULL,           -- workspace.items_rev at the last change
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX items_by_session ON items(session_id, created_at);
CREATE INDEX items_by_rev ON items(rev);

-- Raw tempod events, kept 7 days for replay and debugging.
CREATE TABLE events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  incarnation   TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  received_at   INTEGER NOT NULL,
  UNIQUE (incarnation, seq)
);

CREATE TABLE checkpoints (
  id            TEXT PRIMARY KEY,
  turn_id       TEXT,
  reason        TEXT NOT NULL CHECK (reason IN ('turn_end','pre_revert','pre_sleep','pre_archive','sigterm')),
  commit_sha    TEXT NOT NULL,
  tree_sha      TEXT NOT NULL,
  parent_sha    TEXT NOT NULL,
  base_sha      TEXT NOT NULL,
  r2_key        TEXT,
  bundle_bytes  INTEGER,
  local_only    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE snapshots (
  id                TEXT PRIMARY KEY,       -- id returned by snapshotContainer
  name              TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL,
  image_ref         TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  last_restored_at  INTEGER,
  unusable          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE home_backups (
  id           TEXT PRIMARY KEY,            -- DirectoryBackup record id
  record_json  TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE review_comments (
  id            TEXT PRIMARY KEY,
  path          TEXT NOT NULL,
  line_start    INTEGER,                    -- null = whole file
  line_end      INTEGER,
  side          TEXT CHECK (side IN ('old','new')),
  body          TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('draft','sent','resolved')),
  sent_turn_id  TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE script_runs (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('setup','run','archive')),
  script_id    TEXT,                        -- run script id; null for setup and archive
  command      TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('running','exited','killed','failed_to_start','timed_out')),
  exit_code    INTEGER,
  signal       TEXT,
  log_tail     TEXT NOT NULL DEFAULT '',    -- last 1 MiB
  r2_key       TEXT,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER
);

CREATE TABLE ports (
  port           INTEGER PRIMARY KEY,
  first_seen_at  INTEGER NOT NULL
);

CREATE TABLE permissions (
  request_id        TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  turn_id           TEXT NOT NULL,
  item_id           TEXT NOT NULL,
  options_json      TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('pending','answered','cancelled')),
  chosen_option_id  TEXT,
  created_at        INTEGER NOT NULL,
  answered_at       INTEGER
);

CREATE TABLE attachments (
  id              TEXT PRIMARY KEY,
  turn_id         TEXT,
  name            TEXT NOT NULL,
  mime            TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  r2_key          TEXT NOT NULL,
  container_path  TEXT,                     -- set once copied into the container
  created_at      INTEGER NOT NULL
);

-- Newest 10,000 rows only.
CREATE TABLE egress_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  method  TEXT NOT NULL,
  host    TEXT NOT NULL,
  path    TEXT NOT NULL,
  status  INTEGER NOT NULL,
  ms      INTEGER NOT NULL,
  rule    INTEGER NOT NULL
);
```

**Rules**

- Every change to `items` increments `workspace.items_rev` by 1 and sets `items.rev` to the new value, in the same transaction.
- Each `checkpoints.id` is a ULID. Its git ref is `refs/tempo/checkpoints/<checkpoint id>`.
- Delete `events` rows older than 7 days in the daily `housekeeping` op.

## CredentialDO and UserHubDO

CredentialDO is the only place secrets are stored. UserHubDO only fans out sidebar updates.

**CredentialDO** (one per user)

```sql
CREATE TABLE secrets (
  key         TEXT PRIMARY KEY,
  ciphertext  BLOB NOT NULL,
  iv          BLOB NOT NULL,            -- 12 random bytes per write
  version     INTEGER NOT NULL DEFAULT 1,
  meta_json   TEXT NOT NULL DEFAULT '{}',  -- codex: {"lastRefresh": <ms>}
  updated_at  INTEGER NOT NULL
);

CREATE TABLE codex_leases (
  workspace_id  TEXT PRIMARY KEY,
  since         INTEGER NOT NULL
);
```

Secret keys are exactly:

| Key | Value |
| --- | --- |
| `claude.oauth_token` | Token from `claude setup-token` |
| `codex.auth_json` | The full `auth.json` text |
| `openrouter.api_key` | OpenRouter key |
| `anthropic.api_key` | Anthropic API key (API-key mode) |
| `openai.api_key` | OpenAI API key (API-key mode) |
| `project.<projectId>.env.<NAME>` | One project secret env var |

One more CredentialDO instance is named `system`. It holds the GitHub App config under the keys `github_app.id`, `github_app.slug`, `github_app.private_key`, `github_app.client_id` and `github_app.client_secret` (05, Secrets). Its HKDF salt is `system`.

**Encryption.** `TEMPO_ENCRYPTION_KEY` is 32 random bytes, base64. Derive the AES-256-GCM key with HKDF-SHA256: salt = the user id, info = `tempo-secrets-v1`. Use the secret's key name as additional authenticated data, so a ciphertext cannot be moved to another key. Use WebCrypto only.

**RPC methods**

| Method | Returns |
| --- | --- |
| `getSecret(key)` | Plain value or `null`. `On a user instance, only WorkspaceDO and TempoOutbound may call it; server functions MUST NOT`. |
| `putSecret(key, value, meta?)` | `{version}` |
| `deleteSecret(key)` | `void` |
| `status()` | `[{key, updatedAt, meta}]`, never values |
| `listProjectEnv(projectId)` | `{NAME: value}` for that project |
| `offerCodexAuth(content, lastRefresh, fromWorkspaceId)` | `{accepted, version}` |
| `getCodexAuth()` | `{content, version, lastRefresh}` or `null`. WorkspaceDO only. |
| `getGithubAppConfig()` | `{appId, slug, privateKey, clientId, clientSecret}` or `null`. On the `system` instance only. Only the Worker's `auth/` and `github/` modules call it. |
| `startCodexLogin()` | `Result<{loginId, verificationUrl, userCode, expiresAt, intervalMs}>`; one active in-memory attempt per owner |
| `pollCodexLogin(loginId)` | `Result<{status: "pending" \| "connected" \| "expired"}>`; tokens stay inside CredentialDO |
| `cancelCodexLogin(loginId)` | `void`; idempotent and scoped to the matching attempt |
| `addCodexLease(workspaceId)`, `dropCodexLease(workspaceId)` | `void` |

**UserHubDO** (one per user)

```sql
CREATE TABLE summaries (
  workspace_id  TEXT PRIMARY KEY,
  summary_json  TEXT NOT NULL,   -- WorkspaceSummary
  rev           INTEGER NOT NULL
);
```

- UI sockets use hibernation (`ctx.acceptWebSocket`).
- `publish(summary)` stores the summary if `rev` is newer and sends it to every socket. `remove(workspaceId)` deletes the stored summary and sends `workspace.removed` to every socket.
- On a new socket, send `hello` with every stored summary. If the table is empty, load it once from D1 first.

## R2 layout

One bucket, `tempo-data`, binding `DATA`. Keys are exact.

| Key | Content | Written by | Kept |
| --- | --- | --- | --- |
| `checkpoints/<workspaceId>/<checkpointId>.bundle` | Git bundle of one checkpoint | WorkspaceDO | Newest 20 per workspace |
| `homes/<workspaceId>/<recordId>.tar.zst` | `DirectoryBackup` of `/home/tempo` | `DirectoryBackup` | Newest 3 per workspace |
| `attachments/<workspaceId>/<attachmentId>/<file name>` | Files the user attached to a prompt | Worker | Until the workspace is deleted |
| `logs/<workspaceId>/<runId>.log` | Full script log, at most 50 MiB | WorkspaceDO | 30 days |

- The daily `housekeeping` op in each WorkspaceDO applies these limits.
- Deleting a workspace deletes every key under its id, in all four prefixes.

## Item model

The transcript is a list of items. `tempod` turns ACP updates into items; the WorkspaceDO stores them; the UI renders them. Raw ACP never reaches the UI.

**`content_json` per item kind**

| Kind | `content_json` |
| --- | --- |
| `user_message` | `{text, mentions: [{path}], attachments: [{id, name, mime}], reviewCommentIds: []}` |
| `agent_message` | `{text}`, Markdown. Non-text ACP content goes in `blocks: [ContentBlock]`. |
| `agent_thought` | `{text}` |
| `tool_call` | `{toolCallId, title, toolKind, locations: [{path, line?}], content: [ToolCallContent], rawInput?, rawOutput?}` |
| `plan` | `{entries: [{content, priority, status}]}` |
| `permission` | `{requestId, toolCallId, title, options: [{optionId, name, kind}], chosenOptionId?}` |
| `notice` | `{level: "info" or "warning" or "error", text}` |
| `handoff` | `{text}`, the exact handoff block that was sent |
| `revert_marker` | `{checkpointId, toTurnSeq}` |
| `error` | `{code, detail}` |

`toolKind`, `ToolCallContent` (`content`, `diff`, `terminal`) and `ContentBlock` are the ACP v1 types, copied as is.

**ACP update to item**

| ACP `session/update` | What happens |
| --- | --- |
| `user_message_chunk` | Ignored. Tempo writes `user_message` items itself. |
| `agent_message_chunk` | Append text to the turn's open `agent_message` item. If the last item in the turn is not an `agent_message`, create one. |
| `agent_thought_chunk` | Same, with `agent_thought` |
| `tool_call` | Create a `tool_call` item. Map its `toolCallId` to the new item id. |
| `tool_call_update` | Update that item: merge `title`, `status`, `locations`; replace `content` when it is sent. |
| `plan` | Create the turn's `plan` item, or replace its `entries` |
| `available_commands_update` | `sessions.commands_json` |
| `current_mode_update` | `sessions.mode_id` |
| `config_option_update` | `sessions.config_options_json` |
| `session_info_update` | `sessions.title`, when a title is sent |
| `usage_update` | `sessions.usage_json` |
| `notice` | Create a `notice` item |
| Anything else | Log at `warn` and drop |

**Status**

- `agent_message` and `agent_thought` are `streaming` until the next item starts or the turn ends, then `completed`.
- `tool_call` status copies the ACP status: `pending`, `in_progress`, `completed`, `failed`.
- When a turn ends as `cancelled`, `failed` or `interrupted`, every open item in it becomes `cancelled`.

**Capabilities `tempod` advertises:** `fs.readTextFile`, `fs.writeTextFile`, `session.notices`. It MUST NOT advertise `terminal`, `elicitation` or `session.compaction` in version 1.

## Server functions

All mutations go through TanStack Start server functions. Live updates come only over WebSockets (below).

**Rules for every server function**

- Created with `createServerFn`. Input and output are Effect Schemas from `packages/protocol`.
- An auth middleware runs first. No session, or a user who is not the owner, returns `UNAUTHENTICATED` or `FORBIDDEN`.
- A function that takes `workspaceId` checks that the workspace belongs to the user, then calls the WorkspaceDO by RPC. It MUST NOT write WorkspaceDO data itself.
- Errors use the shape `{code, message, detail?}` with a code from the error table. Any function MAY also return `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_FAILED` or `INTERNAL`. Any function that needs the container (03, wake triggers) MAY also return `CONTAINER_NOT_READY`. The tables below list only the other codes.
- `GET` for reads, `POST` for writes.

**WorkspaceDO RPC.** One method per workspace server function, with the same name and the same input minus `workspaceId`. Plus these internal methods: `init(input)`, `previewFetch(request, port, token)`, `getGithubToken()`, `getEgressConfig()` (returns `{owner, repo, policy, allowlist}` for `TempoOutbound`), `logEgress(row)`, `pushCodexAuth(content, version)`.

**Projects and GitHub**

| Function | Input | Output | Errors |
| --- | --- | --- | --- |
| `listInstallationRepos` | `{installationId}` | `[{repoId, owner, name, defaultBranch, private}]` | `GITHUB_API_ERROR` |
| `listInstallations` | `{}` | `[{installationId, accountLogin, accountType}]`. First syncs D1 with `GET /app/installations` (05). | `GITHUB_API_ERROR` |
| `linkProject` | `{installationId, repoId}` | `Project` | `PROJECT_EXISTS`, `REPO_NOT_ACCESSIBLE` |
| `listProjects` | `{}` | `Project[]` | — |
| `updateProjectSettings` | `{projectId, settings}` | `Project` | `SETTINGS_INVALID` |
| `unlinkProject` | `{projectId}` | `{}` | `PROJECT_HAS_WORKSPACES` |
| `listBranches` | `{projectId, query?}` | `[{name}]`, at most 100 | `GITHUB_API_ERROR` |
| `listOpenPullRequests` | `{projectId}` | `[{number, title, headBranch}]` | `GITHUB_API_ERROR` |

**Workspaces**

| Function | Input | Output | Errors |
| --- | --- | --- | --- |
| `createWorkspace` | `{projectId, source, agent?, prompt?}`; `source` = `{kind: "new", baseBranch}` or `{kind: "branch", branch}` or `{kind: "pr", number}`; `prompt` = `{text}` | `WorkspaceSummary` | `BRANCH_IN_USE`, `NOT_FOUND` |
| `listWorkspaces` | `{includeArchived?}` | `WorkspaceSummary[]` | — |
| `getWorkspace` | `{workspaceId}` | `WorkspaceDetail` | `NOT_FOUND` |
| `renameWorkspace` | `{workspaceId, title}` | `{}` | — |
| `renameBranch` | `{workspaceId, branch}` | `{}` | `BRANCH_INVALID`, `BRANCH_IN_USE`, `BRANCH_ALREADY_PUSHED` |
| `setPinned` | `{workspaceId, pinned}` | `{}` | — |
| `markViewed` | `{workspaceId}` | `{}` | — |
| `wakeWorkspace`, `sleepWorkspace` | `{workspaceId}` | `{}` | `WORKSPACE_ARCHIVED`, `WORKSPACE_BUSY` |
| `archiveWorkspace` | `{workspaceId}` | `{}` | `WORKSPACE_BUSY` |
| `restoreWorkspace` | `{workspaceId}` | `{}` | `BRANCH_IN_USE` |
| `deleteWorkspace` | `{workspaceId}` (archived only) | `{}` | `WORKSPACE_NOT_ARCHIVED` |
| `rotatePreviewToken` | `{workspaceId}` | `{previewToken}` | — |
| setBaseBranch | {workspaceId, baseBranch}; allowed only while no PR exists | {} | PR\_EXISTS, NOT\_FOUND (branch not on origin) |
| getDiagnostics | {workspaceId} | {ops, container, logs, egress, sessions} as in 05, Observability | — |

**Sessions and turns**

| Function | Input | Output | Errors |
| --- | --- | --- | --- |
| `createSession` | `{workspaceId, agent, model?, modeId?}` | `Session` | `CREDENTIAL_MISSING`, `WORKSPACE_ARCHIVED` |
| `closeSession` | `{workspaceId, sessionId}` | `{}` | `SESSION_BUSY` |
| `renameSession` | `{workspaceId, sessionId, title}` | `{}` | — |
| `sendPrompt` | `{workspaceId, sessionId, text, mentions, attachmentIds, reviewCommentIds, delivery?: "queue" or "steer"}` | `Turn`; the running turn when steering is injected, otherwise the queued turn | `CREDENTIAL_MISSING`, `WORKSPACE_ARCHIVED`, `VALIDATION_FAILED` |
| `cancelTurn` | `{workspaceId, turnId}` | `{}` | `TURN_NOT_ACTIVE` |
| `editQueuedTurn` | `{workspaceId, turnId, text}` | `Turn` | `TURN_NOT_QUEUED` |
| `deleteQueuedTurn` | `{workspaceId, turnId}` | `{}` | `TURN_NOT_QUEUED` |
| `reorderQueue` | `{workspaceId, turnIds}` | `{}` | `VALIDATION_FAILED` |
| `setSessionMode` | `{workspaceId, sessionId, modeId}` | `{}` | `SESSION_BUSY` |
| `setSessionConfig` | `{workspaceId, sessionId, configId, value}` | `{}` | `SESSION_BUSY` |
| `respondPermission` | `{workspaceId, requestId, optionId}` | `{}` | `NOT_FOUND` |

Attachments use a plain route, not a server function: `POST /api/workspaces/<workspaceId>/attachments`, multipart, one file, at most 10 MiB. It returns `{attachmentId, name, mime, size}`.

`GET /api/workspaces/<workspaceId>/attachments/<attachmentId>` returns the original bytes after cookie/bearer owner and workspace checks. Unknown workspaces, attachments and missing objects return `NOT_FOUND`. Archived workspace attachments remain readable. The maximum is 10 MiB; the stored and actual sizes must match. PNG, JPEG, GIF and WebP use their stored image MIME and inline disposition; other types use `application/octet-stream` and attachment disposition. Responses use `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff` and a sandbox CSP. Clients construct this same-origin route from the workspace and attachment IDs; no object-storage credentials or agent remote URLs are sent. Metadata uses shared `Attachment {id, name, mime, size}`.

**Review and git**

| Function | Input | Output | Errors |
| --- | --- | --- | --- |
| `getChanges` | `{workspaceId, scope: "branch" or "uncommitted"}` | `{files: [{path, oldPath?, status, additions, deletions}], baseSha, headSha}` | `CONTAINER_NOT_READY` |
| `getFileDiff` | `{workspaceId, scope, path}` | `{diff}` (unified, 3 lines of context) | `NOT_FOUND` |
| `addReviewComment` | `{workspaceId, path, lineStart?, lineEnd?, side?, body}` | `ReviewComment` | — |
| `deleteReviewComment` | `{workspaceId, commentId}` | `{}` | — |
| `listReviewComments` | `{workspaceId}` | `ReviewComment[]` | — |
| `listCheckpoints` | `{workspaceId}` | `[{id, turnId, turnSeq, reason, createdAt}]` | — |
| `revertToCheckpoint` | `{workspaceId, checkpointId}` | `{}` | `CHECKPOINT_NOT_FOUND`, `WORKSPACE_BUSY` |
| `commitAndPush` | `{workspaceId, message}` | `{commitSha}` | `NOTHING_TO_COMMIT`, `PUSH_REJECTED` |
| `createPullRequest` | `{workspaceId, title, body, draft}` | `{number, url}` | `NOT_PUSHED`, `PR_EXISTS`, `GITHUB_API_ERROR` |
| `mergePullRequest` | `{workspaceId, method: "squash" or "merge" or "rebase"}` | `{}` | `PR_NOT_MERGEABLE` |
| `refreshPullRequest` | `{workspaceId}` | `{prNumber, prState, checksState, prTitle?}` | `GITHUB_API_ERROR` |
| `listCheckRuns` | `{workspaceId}` | `[{name, status, conclusion, url}]` for the PR head | `GITHUB_API_ERROR` |

**Files, scripts, terminals**

| Function | Input | Output | Errors |
| --- | --- | --- | --- |
| `listFiles` | `{workspaceId}` | `{paths}`: tracked plus untracked, not ignored, at most 50,000 | `CONTAINER_NOT_READY` |
| `readFile` | `{workspaceId, path}` | `{content, encoding: "utf8" or "base64", size}` | `FILE_TOO_LARGE` (over 1 MiB), `PATH_OUTSIDE_WORKSPACE` |
| `searchFiles` | `{workspaceId, query, regex?}` | `[{path, line, text}]`, at most 500 | — |
| `runScript` | `{workspaceId, scriptId}` | `ScriptRun` | `NOT_FOUND` |
| `stopScript` | `{workspaceId, runId}` | `{}` | — |
| `rerunSetup` | `{workspaceId}` | `ScriptRun` | `WORKSPACE_BUSY` |
| `continueAfterSetupFailure` | `{workspaceId}` | `{}` | — |
| `listTerminals` | `{workspaceId}` | `[{terminalId}]` | — |

**Credentials**

| Function | Input | Output | Errors |
| --- | --- | --- | --- |
| `getCredentialStatus` | `{}` | `{claude, codex, openrouter, anthropic, openai}`, each `{set, updatedAt}`; `codex` adds `lastRefresh` | — |
| `setClaudeToken` | `{token}`: no spaces, 20 to 4096 chars | `{}` | `VALIDATION_FAILED` |
| `setCodexAuth` | `{authJson}`: MUST parse and contain `tokens.access_token`, `tokens.refresh_token`, `last_refresh` | `{}` | `VALIDATION_FAILED` |
| `startCodexLogin` | `{}` | `{loginId, verificationUrl, userCode, expiresAt, intervalMs}` | `CREDENTIAL_INVALID` |
| `pollCodexLogin` | `{loginId}` | `{status: "pending" \| "connected" \| "expired"}` | `CREDENTIAL_INVALID` |
| `cancelCodexLogin` | `{loginId}` | `{}` | — |
| `setApiKey` | `{provider: "openrouter" or "anthropic" or "openai", key}` | `{}` | `VALIDATION_FAILED` |
| `deleteCredential` | `{key}` | `{}` | — |
| `setProjectSecret` | `{projectId, name, value}`; `name` matches `^[A-Z_][A-Z0-9_]*$` | `{}` | `VALIDATION_FAILED` |
| `deleteProjectSecret` | `{projectId, name}` | `{}` | — |
| `listProjectSecretNames` | `{projectId}` | `{names}` | — |

## Shared types and the workspace channel

The UI loads a workspace once over its WebSocket, then applies updates. Field names are camelCase on the wire.

**Shared types** (`packages/protocol`)

| Type | Fields |
| --- | --- |
| `Project` | `id, installationId, repoId, owner, name, defaultBranch, settings, sortOrder` |
| `WorkspaceSummary` | `id, projectId, slug, title, branch, baseBranch, state, attention, defaultAgent, prNumber, prState, checksState, pinned, lastActivityAt, createdAt, archivedAt, rev` |
| `WorkspaceDetail` | `WorkspaceSummary` plus `errorCode, errorDetail, setupStatus, pushed, previewToken, ports: [{port, url}], settings, runningTurnId, queue: [turnId], imageRef, op, prTitle?` |
| `Session` | `id, agent, title, status, modeId, modes, configOptions, config, commands, usage, sortOrder, steering?` (boolean; absent means unsupported) |
| `Turn` | `id, sessionId, seq, status, queuePos, prompt, stopReason, errorCode, checkpointId, reverted, queuedAt, startedAt, endedAt, steeringPending?` (boolean; absent means false) |
| `Item` | `id, sessionId, turnId, kind, status, content, rev, createdAt, updatedAt` |
| `ScriptRun` | `id, kind, scriptId, command, status, exitCode, signal, startedAt, endedAt` |
| `ReviewComment` | `id, path, lineStart, lineEnd, side, body, status, sentTurnId, createdAt` |
| `PermissionRequest` | `requestId, sessionId, turnId, itemId, title, options: [{optionId, name, kind}]` |
| `OpProgress` | `kind, status, step, steps: [{name, status, ms}]`. `WorkspaceDetail.op` is the running op, else the next pending op, else `null`. |

**Workspace channel.** `GET /api/ws/workspace/<workspaceId>?sinceRev=<n>`, upgraded to a WebSocket and handed to the WorkspaceDO. `sinceRev` is the highest item `rev` the client has; `0` on first load.

Server to client:

| `type` | Fields | When |
| --- | --- | --- |
| `hello` | `v: 1, workspace: WorkspaceDetail, sessions: Session[], turns: Turn[], itemsRev` | First message |
| `items` | `items: Item[], itemsRev, done` | Backlog with `rev > sinceRev`, 500 per message; `done: true` on the last |
| `item.upsert` | `item, itemsRev` | An item was created or changed |
| `item.delta` | `itemId, append: {text}, itemsRev` | Streaming text; live only |
| `workspace` | `workspace: WorkspaceDetail` | Any workspace field changed |
| `session` | `session: Session` | A session changed |
| `turn` | `turn: Turn` | A turn changed |
| `permission` | `request: PermissionRequest` | An agent asked for permission |
| `script.output` | `runId, stream: "stdout" or "stderr", data` | Script output |
| `script.run` | `run: ScriptRun` | A script started or ended |
| `changes` | `files, additions, deletions` | `git.changed` from `tempod` |
| `credential.invalid` | `provider` | A credential stopped working |
| `error` | `code, message` | A background step failed |
| `pong` | — | Reply to `ping` |

Client to server: only `{"type":"ping"}`, every 30 s. Everything else is a server function.

**Rules**

- `item.delta` is sent only to live sockets. A client that reconnects gets the full item in the backlog.
- After the backlog, the client MUST treat any message with `itemsRev` lower than its own as stale and drop it.
- UI sockets use hibernation (`ctx.acceptWebSocket`, tag `ui`).
- If a socket buffers more than 4 MiB, close it with code 4008. The client reconnects with its `sinceRev`.
- Client reconnect: 0.5 s, then double up to 10 s, with 20% jitter.

## Hub and terminal channels

The hub channel feeds the sidebar for all workspaces. The terminal channel carries one PTY.

**Hub channel.** `GET /api/ws/hub`, handed to the user's UserHubDO.

| `type` | Fields |
| --- | --- |
| `hello` | `v: 1, workspaces: WorkspaceSummary[]` |
| `workspace` | `summary: WorkspaceSummary` |
| `workspace.removed` | `workspaceId` |
| `pong` | — |

The client sends only `{"type":"ping"}`. The WorkspaceDO calls `UserHubDO.publish(summary)` every time it increments `summary_rev`.

**Terminal channel.** `GET /api/ws/terminal/<workspaceId>/<terminalId>?cols=<n>&rows=<n>`, handed to the WorkspaceDO. Frames are defined in 01, Terminal. `terminalId` MUST match `^t[1-9]$`.

**Upgrade rules for all three channels**

- The Worker checks the Better Auth session cookie before it hands the request to a DO. No session returns 401.
- The `Origin` header MUST equal `https://<APP_HOST>`. Anything else returns 403.
- Close codes: 4001 replaced, 4008 too much buffered, 4400 bad protocol version, 4404 workspace not found.

## tempod protocol

The WorkspaceDO and `tempod` talk over one WebSocket, opened by the DO with `getTcpPort(7070).fetch()` to `/v1/connect`. The DO sends requests; `tempod` sends responses and events.

**Envelopes**

| Direction | Shape |
| --- | --- |
| DO to tempod | `{type: "hello", v: 1, incarnation, lastAckedSeq, workspace: {id, slug, branch, baseBranch, repo: {owner, name}}, env}` |
| DO to tempod | `{type: "ack", upTo}` |
| DO to tempod | `{type: "req", id, op, params}` |
| tempod to DO | `{type: "res", id, ok: true, result}` or `{type: "res", id, ok: false, error: {code, message}}` |
| tempod to DO | `{type: "event", seq, ts, event: {kind, ...}}` |

- `id` is a ULID made by the DO. Each request times out after the op's limit below; the DO then treats it as failed with `TEMPOD_TIMEOUT`.
- The DO acks events in batches: at most every 250 ms or every 100 events.
- Max message size: 1 MiB. `tempod` splits larger `script.output` data.
- `env` in `hello` holds the script env from 01 plus the project env vars and secrets known at that time. After `settings.read`, and whenever project env vars or secrets change, the DO sends `env.set`, which replaces it for scripts and agents started later. `tempod` passes it to scripts and agents only. `overrides` in `settings.read` is the project's D1 `settings_json` (precedence 1 in 01).

**Requests**

| `op` | `params` | `result` | Timeout |
| --- | --- | --- | --- |
| `repo.clone` | `{url, branch, baseBranch, source, author: {name, email}}` | `{headSha}` | 10 min |
| `repo.applyCheckpoint` | `{bundlePath, checkpointId, branch}` | `{headSha}` | 5 min |
| `settings.read` | `{overrides}` | `{effective, warnings, errors}` | 10 s |
| `env.set` | `{env}` | `{}` | 10 s |
| `script.start` | `{runId, kind, scriptId, command, cwd, timeoutMs}` | `{pid}` | 10 s |
| `script.stop` | `{runId}` | `{}` | 15 s |
| `session.start` | `{sessionId, agent, env, modeId?, model?, acpSessionId?}` | `{acpSessionId, modes, configOptions, availableCommands, capabilities, reloaded, handoff}` | 120 s |
| `session.prompt` | `{sessionId, turnId, content}` | `{accepted: true}`; the end comes as `turn.ended` | 30 s |
| `session.steer` | `{sessionId, turnId, messageId, content}` | `{outcome: "injected" or "promptRequired" or "unsupported"}`; the existing prompt owns the turn lifecycle | 30 s |
| `session.cancel` | `{sessionId, turnId}` | `{}` | 20 s |
| `session.setMode` | `{sessionId, modeId}` | `{}` | 30 s |
| `session.setConfig` | `{sessionId, configId, value}` | `{configOptions}` | 30 s |
| `session.close` | `{sessionId}` | `{}` | 15 s |
| `permission.respond` | `{requestId, optionId}`; `optionId: null` means cancelled | `{}` | 10 s |
| `credential.put` | `{provider, content, version}` | `{}` | 10 s |
| `git.changes` | `{scope}` | `{files, baseSha, headSha}` | 30 s |
| `git.fileDiff` | `{scope, path}` | `{diff}` | 30 s |
| `git.checkpoint` | `{checkpointId, turnId, reason}` | `{commit, tree, parent, base, bundlePath, bundleBytes}` or `{unchanged: true}` | 2 min |
| `git.revert` | `{checkpointId}` | `{headSha}` | 2 min |
| `git.commitAndPush` | `{message, branch, forceWithLeaseSha?}` | `{commitSha}` | 5 min |
| `git.renameBranch` | `{from, to}` | `{}` | 30 s |
| `fs.list` | `{}` | `{paths}` | 30 s |
| `fs.read` | `{path, maxBytes}` | `{content, encoding, size}` | 10 s |
| `fs.search` | `{query, regex, maxResults}` | `{matches}` | 30 s |
| `terminal.list` | `{}` | `{terminalIds}` | 10 s |
| `shutdown` | `{reason}` | `{}`, after it stops scripts and agents and flushes the outbox. tempod keeps running unless it is in SIGTERM mode (01) | 45 s |

**Events** (`event.kind`)

| Kind | Fields |
| --- | --- |
| `item.created` | `sessionId, turnId, item` |
| `item.delta` | `sessionId, itemId, append: {text}` |
| `item.updated` | `sessionId, itemId, patch` |
| `session.updated` | `sessionId, patch` (mode, config options, commands, usage, title) |
| `turn.started` | `sessionId, turnId` |
| `turn.ended` | `sessionId, turnId, stopReason, error?, interrupted?` |
| `permission.requested` | `requestId, sessionId, turnId, itemId, title, options` |
| `agent.exited` | `sessionId, code, signal, stderrTail` |
| `script.output` | `runId, stream, data` |
| `script.exited` | `runId, exitCode, signal, timedOut` |
| `git.changed` | `files, additions, deletions` |
| `ports.changed` | `ports` |
| `settings.changed` | `effective, warnings, errors` |
| `credential.changed` | `provider, content, lastRefresh` |
| `credential.invalid` | `provider` |
| `incarnation.changed` | `incarnation` |
| `outbox.overflow` | `dropped` |
| `tempod.stopping` | `reason` |
| `log` | `level, msg, data` |

**Rules**

- `tempod` MUST answer every request exactly once.
- `turn.started` is durable proof that the queued prompt was accepted. A later prompt acknowledgement MUST NOT resurrect a turn that already ended.
- The DO MUST apply events in `seq` order and drop any `(incarnation, seq)` it has already stored. Local event mutations, their deduplication receipt and the applied sequence cursor commit in one SQLite transaction. If application fails, close the daemon socket and replay from the last committed cursor before applying later events. Credential refreshes are accepted by CredentialDO before their payload-free receipt and cursor commit.
- `credential.changed` carries a secret. The DO MUST NOT store it in `events`; it goes straight to CredentialDO. The same applies to `credential.put` and to `env` in `hello` and `session.start`: never logged, never stored outside CredentialDO.

## Error codes

Every error a user can see has one code and one message. Codes are exact; messages MAY be reworded in the UI.

| Code | Meaning | UI message |
| --- | --- | --- |
| `UNAUTHENTICATED` | No valid session | Sign in to continue. |
| `FORBIDDEN` | Not the owner | This Tempo belongs to someone else. |
| `NOT_FOUND` | No such object | Not found. |
| `VALIDATION_FAILED` | Input failed its schema | Check the highlighted fields. |
| `PROJECT_EXISTS` | Repo already linked | This repo is already a project. |
| `PROJECT_HAS_WORKSPACES` | Unlink with live workspaces | Archive this project's workspaces first. |
| `REPO_NOT_ACCESSIBLE` | App cannot reach the repo | Install the GitHub App on this repo. |
| `BRANCH_IN_USE` | Another live workspace has the branch | Another workspace uses this branch. |
| `BRANCH_INVALID` | Not a valid git branch name | That branch name is not valid. |
| `BRANCH_ALREADY_PUSHED` | Rename after push | You can't rename a branch after it is pushed. |
| `WORKSPACE_ARCHIVED` | Action needs a live workspace | Restore this workspace first. |
| `WORKSPACE_NOT_ARCHIVED` | Delete needs an archived workspace | Archive this workspace first. |
| `WORKSPACE_BUSY` | Another op is running | Wait for the current step to finish. |
| `SESSION_BUSY` | The session has a running turn | Wait for the agent to finish, or stop it. |
| `TURN_NOT_ACTIVE` | Cancel on a turn that is not running or queued | Nothing to stop. |
| `TURN_NOT_QUEUED` | Edit or delete on a turn that already started | That message was already sent. |
| `CONTAINER_START_FAILED` | `start()` threw or health never came | The container did not start. Retry. |
| `CONTAINER_NOT_READY` | Action needs a running container | The workspace is waking up. Try again in a moment. |
| `TEMPOD_UNREACHABLE` | WebSocket to `tempod` failed | Lost contact with the workspace. Reconnecting. |
| `TEMPOD_TIMEOUT` | A request ran past its timeout | The workspace did not answer in time. |
| `UNKNOWN_OP` | `tempod` does not know the op, because its image is older | This workspace needs a restart for that action. |
| `CLONE_FAILED` | `repo.clone` failed | Could not clone the repo. |
| `SETUP_FAILED` | Setup script exited non-zero | Setup failed. See the Setup tab. |
| `CREDENTIAL_MISSING` | Agent needs a credential that is not set | Add your \<agent> login in Settings. |
| `CREDENTIAL_INVALID` | The provider rejected the credential | Your \<agent> login stopped working. Add it again. |
| `AGENT_START_FAILED` | `session.start` failed | The agent did not start. |
| `AGENT_CRASHED` | Adapter exited during a turn | The agent stopped unexpectedly. |
| `NOTHING_TO_COMMIT` | Clean working tree | Nothing to commit. |
| `PUSH_REJECTED` | Remote refused the push | Push was rejected. Pull or rebase first. |
| `NOT_PUSHED` | PR before the branch is pushed | Push the branch first. |
| `PR_EXISTS` | A PR already exists for the branch | A pull request already exists. |
| `PR_NOT_MERGEABLE` | GitHub says the PR cannot merge | This pull request can't be merged yet. |
| `GITHUB_API_ERROR` | Any other GitHub API failure | GitHub returned an error. |
| `FILE_TOO_LARGE` | File over the read limit | This file is too large to show. |
| `PATH_OUTSIDE_WORKSPACE` | Path escapes the allowed folders | That path is outside the workspace. |
| `CHECKPOINT_NOT_FOUND` | No such checkpoint | That checkpoint no longer exists. |
| `SETTINGS_INVALID` | Settings failed validation | Settings are not valid. |
| `EGRESS_BLOCKED` | `TempoOutbound` refused a host | (Shown only in the egress log.) |
| `INTERNAL` | Anything else | Something went wrong. |

`WorkspaceDetail.prTitle` and `refreshPullRequest.prTitle` are the GitHub PR title regardless of open, closed or merged state; null means no title has been fetched. The WorkspaceDO persists it and sends detail updates when the title changes.
