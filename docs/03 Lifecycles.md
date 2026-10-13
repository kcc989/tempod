# 03 Lifecycles and Flows

This tab defines every state, every transition and every multi-step flow. Each step lists what runs where and what happens when it fails.

## Workspace states

&#91;embedded content: Workspace states · 10 states, the ready and sleeping loop\]

A workspace has exactly one of these 10 states, stored in WorkspaceDO `workspace.state` and copied to D1. `ready` is the resting state while the container runs; `sleeping` is the resting state while it does not. Errors are not drawn as arrows: any step that fails for good moves the workspace to `error`.

## Transitions

Only these transitions are allowed. Any other change of `workspace.state` is a bug and MUST throw.

| From | Trigger | To | Op |
| --- | --- | --- | --- |
| `creating` | `init` RPC from `createWorkspace` | `starting` | `create` |
| `starting` | Health OK and `hello` done, disk came from a snapshot | `ready` | `create`, `wake` |
| `starting` | Health OK and `hello` done, fresh disk | `setting_up` | `create`, `wake` |
| `setting_up` | Repo ready, settings read, setup done (any exit code) or no setup script | `ready` | `create`, `wake` |
| `ready` | The queue runner starts a turn | `working` | — |
| `working` | The turn ends and the queue is empty | `ready` | — |
| `working` | The turn ends and another turn is queued | `working` | — |
| `ready` | Idle for `sleep_after_idle_minutes`, or `sleepWorkspace` | `stopping` | `sleep` |
| `stopping` | Snapshot attempted and container destroyed | `sleeping` | `sleep` |
| `sleeping` | Any wake trigger (below) | `starting` | `wake` |
| `ready`, `working`, `sleeping`, `error` | `archiveWorkspace` | `archiving` | `archive` |
| `archiving` | Container destroyed and final data saved | `archived` | `archive` |
| `archived` | `restoreWorkspace` | `sleeping` | `restore` |
| `error` | Any wake trigger (below), including `wakeWorkspace` (the UI's Retry) | `starting` | `wake` |
| `ready`, `working`, `setting_up` | Container stopped without Tempo asking | `starting` | `wake` |
| Any state except `archived` | A step fails for good | `error` | — |

**Activity.** A workspace is active, and MUST NOT go to `stopping` on its own, while any of these is true:

- A turn is running or queued.
- The setup script or a run script is running.
- A terminal WebSocket is open.
- A preview request arrived in the last 5 minutes.
- A permission request is pending.

Open UI sockets do not count. A tab left open all day MUST NOT keep a container running.

**Wake triggers:** `sendPrompt`, `createSession`, a terminal WebSocket, a preview request, `wakeWorkspace`, `rerunSetup`, `runScript`. Read calls that need the container (`getChanges`, `getFileDiff`, `listFiles`, `readFile`, `searchFiles`) return `CONTAINER_NOT_READY` and also start a wake. The one exception is `sleeping`: there `listFiles` and `readFile` are not wake triggers. They use the DO's last synced file cache (02, WorkspaceDO schema). Cache misses return `CONTAINER_NOT_READY` without waking; the user can explicitly wake to browse current files. In every other state, `error` included, these two calls need a ready container and are wake triggers, as the other read calls are.

**Unplanned restarts.** At most 3 in any 60 minutes, tracked in `workspace.auto_restarts_json`. The 4th goes to `error` with `CONTAINER_START_FAILED`.

**Attention** is computed, not set by hand. Recompute it after every change, in this priority order:

1. `needs_input`: a permission request is pending.
2. `error`: state is `error`, or `setup_status` is `failed`, or the newest turn ended `failed`.
3. `unread`: a turn ended after `last_viewed_at`.
4. `none`.

## Step runner

Every multi-step flow is an op in the WorkspaceDO `ops` table, run one step per alarm, as in SAM's TaskRunner.

**Rules**

- At most one op is `running` at a time. Ops wait as `pending` and start in creation order. `housekeeping` starts only when no other op is `pending`.
- A checkpoint step persists its request checkpoint id in the op state before asking the daemon. Retries reuse that id; an existing checkpoint ref is immutable and regenerates its original bundle.
- Each step is an idempotent function. It MUST check the current state before it acts (for example, `ctx.container.running` before `start()`).
- `alarm()` takes the oldest due op, sets it `running`, runs its current step with an `AbortSignal` that fires at the step's timeout, and saves the result.
- On success: set the next step, or `done`, and set the alarm to now.
- On a transient error: `attempt += 1`, `next_run_at = now + min(1 s × 2^(attempt − 1), 60 s)` with ±20% jitter. After the step's max attempts, the error is permanent.
- On a permanent error: the op becomes `failed`. For `create`, `wake`, `sleep`, `archive` and `restore`, the workspace goes to `error` with the step's error code. The user starts `revert` and `commit_push`, so they do not change the state: the server function that started the op waits for it to end and returns its result or its error code.
- A step that waits for an event (for example, `setup.run` waits for `script.exited`) ends its alarm run without finishing. The event handler finishes the step and sets the alarm to now.
- In the DO constructor: every op with status `running` goes back to `pending` with `next_run_at = now`. Its step runs again.
- One alarm serves everything. Set it to the earliest of: the next due op, the next heartbeat, the next idle check, the next housekeeping run.
- Heartbeat: every 30 s while the container runs. It checks `ctx.container.running` and that the `tempod` socket is open.
- Idle check: every 60 s while the container runs.
- Housekeeping: once every 24 hours.

**Ops and their steps**

| Op | Steps, in order |
| --- | --- |
| `create` | `container.start` → `tempod.connect` → `repo.clone` → `settings.read` → `setup.run` → `done` |
| `wake` | `container.start` → `tempod.connect` → if fresh disk: `repo.clone` → `repo.applyCheckpoint` → `home.restore` → `settings.read` → `setup.run`; then `sessions.markReload` → `artifacts.resume` → `done` |
| `sleep` | `turns.check` → `git.checkpoint` (`pre_sleep`) → `bundle.upload` → `home.backup` → `artifacts.upload` → `tempod.shutdown` → `container.snapshot` → `container.destroy` → `done` |
| `archive` | `turns.cancel` → `script.archive` → `git.checkpoint` (`pre_archive`) → `bundle.upload` → `home.backup` → `artifacts.upload` → `tempod.shutdown` → `container.snapshot` → `container.destroy` → `github.deleteBranch` → `done` |
| `restore` | `branch.check` → `done` |
| `revert` | `git.checkpoint` (`pre_revert`) → `bundle.upload` → `git.revert` → `transcript.mark` → `done` |
| `commit_push` | `git.commitAndPush` → `done` |
| `housekeeping` | `events.prune` → `r2.retention` → `egress.trim` → `done` |

When the container is not running, `archive` skips every step that needs it and goes straight to `github.deleteBranch`.

**Step limits**

| Step | Timeout | Max attempts | Permanent error code |
| --- | --- | --- | --- |
| `container.start` | 60 s to healthy | 3 | `CONTAINER_START_FAILED` |
| `tempod.connect` | 10 s | 5 | `TEMPOD_UNREACHABLE` |
| `repo.clone` | 10 min | 3 | `CLONE_FAILED` |
| `repo.applyCheckpoint` | 5 min | 2 | Skip; log `warn` and continue without it |
| `home.restore` | 5 min | 2 | Skip; sessions hand off |
| `settings.read` | 10 s | 3 | Use defaults; show the error in the Setup tab |
| `setup.run` | 30 min | 1 | Not an error: set `setup_status = 'failed'` |
| `script.archive` | 120 s | 1 | Continue; `warn` notice |
| `git.checkpoint` | 2 min | 3 | For `revert`, fail with `INTERNAL` without reverting; otherwise skip and log `warn` |
| `bundle.upload` | 5 min | 3 | Mark `local_only` |
| `home.backup` | 5 min | 2 | Skip; log `warn` |
| `artifacts.upload` | 5 min | 2 | Skip; log `warn`. Rows stay `uploading`; the snapshot keeps their staged copies. |
| `artifacts.resume` | 30 s | 1 | Continue; the next wake tries again |
| `tempod.shutdown` | 45 s | 1 | Continue |
| `container.snapshot` | 5 min | 2 | Continue; the next wake uses the fresh path |
| `container.destroy` | 30 s | 3 | `INTERNAL` |
| `git.revert` | 2 min | 1 | `INTERNAL`; the safety checkpoint is kept |
| `git.commitAndPush` | 5 min | 1 | `PUSH_REJECTED` or `INTERNAL` |
| `github.deleteBranch` | 30 s | 3 | Skip; log `warn` |
| Any other step | 30 s | 3 | `INTERNAL` |

## Create a workspace

The server function does the checks and the D1 insert; the WorkspaceDO does everything after that.

**In the `createWorkspace` server function**

1. Validate input. Load the project.
2. Pick the slug: the first animal name in the fixed list that no non-archived workspace in this project uses. If all are used, add `-2`, `-3`, and so on to the first name.
3. Pick the branch:
   - `source.kind = "new"`: `<git.branch_prefix><slug>`, for example `tempo/otter`.
   - `source.kind = "branch"`: `source.branch`. It MUST exist on origin.
   - `source.kind = "pr"`: the PR's `head.ref` from `GET /repos/{owner}/{repo}/pulls/{number}`. If `head.repo.id` is not the project's repo id, fail with `VALIDATION_FAILED` and the message "Pull requests from forks are not supported." Keep the PR's number, title and state (as in Status polling).
4. Insert the D1 row with `state = 'creating'`. For `source.kind = "pr"`, also set `pr_number` and `pr_state`. The partial unique index on `(project_id, branch)` rejects a branch in use; map that to `BRANCH_IN_USE`.
5. Call `WorkspaceDO.init(...)` and return its `WorkspaceSummary`.

**In `WorkspaceDO.init`**

1. Write the `workspace` row. Make `preview_key` (32 random bytes from `crypto.getRandomValues`, base64url). For `source.kind = "pr"`, set `pr_number` and `pr_state`, and keep the PR title as `refreshPullRequest` does, from the server function's values, so the workspace shows the PR at once and status polling starts. Set `title` to the first 60 characters of the prompt, or to the slug.
2. With a prompt, assign a prompt-based branch as described below. Always create the first session (agent = input agent or project default, selected model in `config_json`). With a prompt, its status is `starting`; create a turn (`queued`, `seq = 1`) and its `user_message` item. Without a prompt, its status is `idle`; do not create a turn or message.
3. Insert the `create` op. Set state `starting`. Set the alarm to now.
4. Publish the summary to UserHubDO.

**`repo.clone` in `tempod`**

```bash
git clone --filter=blob:none https://github.com/<owner>/<repo>.git /workspace
cd /workspace
git config user.name "<author.name>"
git config user.email "<author.email>"
# new:    git checkout -b <branch> origin/<baseBranch>
# branch: git checkout -b <branch> --track origin/<branch>
# pr:     git checkout -b <branch> --track origin/<branch>
```

`author` comes from the `repo.clone` params. The DO sets `name` to the owner's GitHub name, else the login, and `email` to `<id>+<login>@users.noreply.github.com`.

- For `branch` and `pr`, set `pushed = 1` and `last_pushed_sha` to the remote head.
- The base branch for `branch` and `pr` is the project's default branch, unless the PR has another base; then it is the PR's `base.ref`.

**After `setup.run`.** The state becomes `ready`, and the queue runner starts (below). The workspace's first turn starts the session and sends the prompt.

## Prompt and turn

A prompt becomes a queued turn at once. The queue runner sends it when the workspace is free.

**`sendPrompt`**

1. Check: the session is not `closed`; the agent's credential is set (else `CREDENTIAL_MISSING`).
2. Insert the turn: `status = 'queued'`, next `seq`, next `queue_pos`.
3. Insert its `user_message` item. Mark the selected draft review comments `sent` with this turn id.
4. Broadcast `turn` and `item.upsert`.
5. If the state is `sleeping` or `error`, insert a `wake` op.
6. Run the queue runner.

**First-prompt branch naming.** New workspaces begin with `<git.branch_prefix><animal-slug>`. Once the first prompt is accepted, derive a branch suffix by applying Unicode NFKD normalization, lowercasing, removing combining accents, replacing runs outside `[a-z0-9]` with `-`, truncating to 60 characters, and trimming edge hyphens. Keep the animal branch if this is empty. Preserve the configured branch prefix; append `-2`, `-3`, etc. if another active workspace uses the name. A prompt supplied at creation sets the branch before cloning; a later prompt renames it before its first turn starts, once setup/wake finishes. Persist the first prompt's naming decision independently of queued-turn edits or deletion. Never automatically rename existing-branch or PR workspaces, pushed branches, or a branch manually named through `renameBranch`, including a save of its current name. Subsequent prompts do not change the branch. Existing workspaces with prior turns keep their branch.

**Live steering.** `sendPrompt` accepts optional `delivery: "queue" | "steer"`; the default is `queue`. A steering message is first saved as a queued turn and user message. When the same chat has a running turn and its adapter advertised steering, reserve the queued turn with `steering_pending = 1` and pause the queue runner while sending `session.steer`. The daemon uses the ACP v1 `_session/steering` extension with `_meta.steering.idleBehavior = "promptRequired"`. It checks the target turn and deduplicates the message id.

- `injected`: move the saved user message, attachments and sent review comments to the running turn, then delete the reserved turn. Do not cancel or restart the running turn.
- Unsupported adapter, no running turn, or `promptRequired`: clear the reservation and keep the message queued for normal delivery.
- Unconfirmed delivery, including a DO restart with a reservation: mark the message's turn failed, clear its queue position and reservation, and show that delivery could not be confirmed. Do not replay it automatically; the user must check the response before retrying.

Reserved messages cannot be edited, deleted or reordered until delivery settles. The reservation is durable so a restart cannot send the same text as a new prompt after the agent already received it.

**Queue runner.** It runs after any change to state, turns, sessions or `setup_status`. It starts the lowest `queue_pos` turn only if all of these are true:

- `state` is `ready`.
- `setup_status` is `none`, `succeeded` or `skipped`. `continueAfterSetupFailure` sets it from `failed` to `skipped`.
- No turn is `running`.
- No op is `pending` or `running`, except `housekeeping`.
- A continue turn of a run (08, Runs) goes to the head of the queue.

**Start the turn**

1. If the session has no live adapter process, send `session.start` (01, Sessions). Store what it returns.
2. Build the content blocks (01, Sessions). Copy each attachment from R2 into the container with `Files.writeFile` at `/home/tempo/attachments/<turnId>/<name>`.
3. Send `session.prompt`. Set the turn `running`, the session `running`, the state `working`, `started_at = now`, `queue_pos = null`.

**While it runs.** Apply `item.*` events to `items` and broadcast them. Apply `session.updated`. Store `permission.requested` in `permissions`, create a `permission` item, recompute attention.

**`turn.ended`**

| ACP `stopReason` | Turn status |
| --- | --- |
| `end_turn`, `max_tokens`, `max_turn_requests`, `refusal` | `completed` (the reason is stored) |
| `turn.ended` carries `interrupted: true` (check this first) | `interrupted` |
| `cancelled` | `cancelled` |
| `turn.ended` carries `error` | `failed` |

Then, in order:

1. Close open items in the turn. Set the session `idle`.
2. Request `git.checkpoint {reason: "turn_end"}`. On a result, insert the checkpoint row, upload the bundle, and set `turns.checkpoint_id` to the new id. On `{unchanged: true}`, insert no row and set `turns.checkpoint_id` to the newest existing checkpoint.
3. Run `home.backup` if the last one is older than 60 s.
4. Request `git.changes {scope: "branch"}` and broadcast `changes`.
5. Set `last_activity_at = now`. Recompute attention. Publish the summary.
6. Run the queue runner. If no turn starts, the state goes back to `ready`.

Steps 2 to 4 run as background work inside the DO. They MUST NOT block the next queued turn longer than the checkpoint request itself (at most 2 min).

**Viewed.** The UI calls `markViewed` when the workspace view is visible and focused, and again whenever a turn ends while it is. `markViewed` sets `last_viewed_at = now`.

## Sleep and wake

Sleep saves everything, then destroys the container. Wake picks the fastest restore path that is still valid.

**Sleep** (`sleep` op)

1. `turns.check`: if a turn is running or queued, cancel the op. The workspace is not idle.
2. `git.checkpoint` with reason `pre_sleep`, then `bundle.upload`.
3. `home.backup`.
4. `artifacts.upload`: upload every `artifacts` row still `uploading` (01, Artifacts, Upload), and wait for the uploads already running.
5. `tempod.shutdown`: the DO first attempts a final file cache sync (02, WorkspaceDO schema). Then `tempod` stops scripts and agents and flushes its outbox. It keeps running, so the snapshot can still be taken.
6. `container.snapshot`: `snapshotContainer({ name })`. Insert the `snapshots` row.
7. `container.destroy`: `ctx.container.destroy()`. Set `tempod_token = null`. Close all terminal sockets with code 1001.
8. State `sleeping`. Drop the Codex lease in CredentialDO.

**Wake** (`wake` op)

1. `container.start`:
   - Pick the newest snapshot that is usable (01, Durability). If there is one, start from it.
   - Else start from the image.
   - If a start from a snapshot fails, mark the snapshot `unusable` and start from the image at once. That retry does not count as an attempt.
2. `tempod.connect`: open `/v1/connect`, send `hello` with the stored incarnation and `tempod_acked_seq`.
3. Fresh disk only: `repo.clone`, `repo.applyCheckpoint` (newest checkpoint with an R2 bundle), `home.restore`, `settings.read`, `setup.run`.
4. `sessions.markReload`: mark every non-closed session as having no live process. The next prompt reloads it.
5. `artifacts.resume`: start the upload of every `artifacts` row still `uploading`. On a fresh disk the staged copies are gone, so those rows become `lost` and their items `failed`.
6. State `ready` (or `setting_up` until setup ends).

**Timing targets** (spike S6 measures them)

| Path | Target |
| --- | --- |
| Wake from a snapshot to `ready` | Under 30 s |
| Wake on a fresh disk to `ready`, before setup | Under 90 s |
| New workspace to first agent output | Under 120 s |

## Revert to a checkpoint

Revert puts the files back to the end of an earlier turn. It never deletes data: a safety checkpoint is made first.

1. Allowed only when no turn is running or queued. Else `WORKSPACE_BUSY`.
2. `git.checkpoint` with reason `pre_revert`, then upload. This is the safety checkpoint. If the checkpoint cannot be made after three attempts, fail with `INTERNAL`; do not revert files or mark the transcript. An unchanged tree may reuse the newest checkpoint. A bundle upload failure keeps the safety checkpoint locally (`local_only`).
3. `git.revert {checkpointId}` runs in `/workspace`:

```bash
git clean -fd                              # remove untracked files that are not ignored
git reset --hard "$CKPT^1"                 # branch back to HEAD at that time
git read-tree -u --reset "$CKPT"           # working tree = the checkpoint
git reset -q                               # unstage; keep the working tree
```

4. Mark every turn with `seq` greater than the checkpoint's turn as `reverted = 1`. Insert a `revert_marker` item.
5. For every non-closed session, set `pending_note` to exactly: `Note: the user reverted the files to the state after turn <seq>. Changes made after that point are gone.`
6. If `HEAD` is now behind `last_pushed_sha`, set a flag so the next push uses `--force-with-lease=<branch>:<last_pushed_sha>`.

The agents' own context is not rewound. The note tells them what changed. A revert can itself be undone by reverting to the safety checkpoint.

## Commit, push, pull request, merge

The container commits and pushes; the Worker talks to the GitHub API. All GitHub calls use the installation token.

**Commit and push** (`commit_push` op, `git.commitAndPush` in `tempod`)

1. `git add -A`. If anything is staged, `git commit -m "<message>"`.
2. If nothing was committed and the branch is not ahead of `origin/<branch>`, fail with `NOTHING_TO_COMMIT`.
3. `git push -u origin <branch>`, or with `--force-with-lease=<branch>:<last_pushed_sha>` if a revert set the flag.
4. On success, set `pushed = 1` and `last_pushed_sha`. Clear the force flag.
5. A rejected push fails with `PUSH_REJECTED` and the remote's message.

**Create a pull request** (`createPullRequest`)

- Requires `pushed = 1`, else `NOT_PUSHED`.
- `POST /repos/{owner}/{repo}/pulls` with `{title, head: <branch>, base: <base_branch>, body, draft}`.
- Default title: the workspace title. Default body: `Created with Tempo.`, a blank line, then the first line of each turn's prompt as a list, at most 20.
- A `422` that says a PR exists maps to `PR_EXISTS`. Store `pr_number` and `pr_state`.

**Status polling**

- While any UI socket is open on the workspace and `pr_number` is set: every 60 s, and on `refreshPullRequest`.
- `GET /repos/{owner}/{repo}/pulls/{number}` sets `pr_state`: `merged` if `merged`, else `closed` if `state = closed`, else `draft` if `draft`, else `open`.
- `GET /repos/{owner}/{repo}/commits/{head_sha}/check-runs` sets `checks_state`: `pending` if any run is `queued` or `in_progress`; else `failure` if any conclusion is `failure`, `cancelled`, `timed_out` or `action_required`; else `success`.
- No check runs at all leaves `checks_state = null`.

**Merge** (`mergePullRequest`)

- `PUT /repos/{owner}/{repo}/pulls/{number}/merge` with `{merge_method}`. Default `squash`.
- `405` or `409` maps to `PR_NOT_MERGEABLE`.
- On success, set `pr_state = 'merged'`. If `git.archive_on_merge` is true, insert an `archive` op.

## Archive and restore

Archive frees the branch and the container; restore brings the workspace back as `sleeping`.

**Archive** (`archive` op)

1. `turns.cancel`: cancel the running turn and delete queued turns. Answer pending permission requests as cancelled.
2. `script.archive`: run the archive script, 120 s timeout. A failure is a `warn` notice only.
3. `git.checkpoint` with reason `pre_archive`, upload, `home.backup`, `artifacts.upload`, `tempod.shutdown`, `container.snapshot`, `container.destroy`, as in sleep.
4. `github.deleteBranch`: only if `git.delete_branch_on_archive` is true, `pushed = 1`, and there is no open PR. `DELETE /repos/{owner}/{repo}/git/refs/heads/<branch>`.
5. Set `archived_at = now` in the DO and in D1. State `archived`. Drop the Codex lease.

The UI shows an Undo toast for 8 s. Undo during that time calls `restoreWorkspace`.

If the `archive` op is still running, `restoreWorkspace` queues the `restore` op. It starts when `archive` ends.

**Restore** (`restore` op)

1. `branch.check`: no other non-archived workspace in the project uses the branch or the slug. Else `BRANCH_IN_USE`. If only the slug is taken, give the workspace a new slug; keep the branch.
2. If the branch was deleted on GitHub, the next wake recreates it from the newest checkpoint and sets `pushed = 0`.
3. Clear `archived_at`. State `sleeping`. The container starts on the next wake trigger.

**Delete** (`deleteWorkspace`, archived only): save a final project conversation artifact to R2 first; if it fails, stop without deleting workspace data. Delete the workspace R2 keys (02, R2 layout), the D1 row, and every row in the DO (`ctx.storage.deleteAll()`). Keep the project conversation artifact indefinitely for history.

Then call `UserHubDO.remove(workspaceId)`, so every open sidebar drops the workspace.

## Failure handling

Every known failure has one detector and one response. The user always sees the result as a notice item, a banner or a state.

| Failure | Detected by | Response |
| --- | --- | --- |
| `start()` throws | `container.start` step | Retry with backoff, 3 attempts, then `error` / `CONTAINER_START_FAILED` |
| Health never returns 200 | 60 s poll in `container.start` | `destroy()`, then retry as above |
| Start from snapshot fails | `container.start` step | Mark the snapshot `unusable`; start from the image at once |
| `tempod` socket closes while the container runs | WebSocket close | Reconnect up to 5 times (1, 2, 4, 8, 16 s). Then `destroy()` and wake. |
| Container stops on its own (host restart, out of memory) | Heartbeat sees `running = false` | Running turn becomes `interrupted`; notice item; wake, within the 3-per-hour limit |
| `tempod` gets SIGTERM | `tempod` | `tempod` sends `tempod.stopping`, and the running turn ends `interrupted`. The DO attempts a file cache sync, requests `git.checkpoint {reason: "sigterm"}`, uploads the bundle, runs `home.backup`, uploads artifacts still `uploading`, then sends `shutdown`. When the container stops, the row above applies. |
| Adapter exits during a turn | `agent.exited` | Turn `failed` / `AGENT_CRASHED`; notice with `stderrTail`; next prompt reloads |
| `session/load` fails | `session.start` result | Handoff (01, Sessions) |
| Credential rejected | `turn.ended` error, or `credential.invalid` | Turn `failed` / `CREDENTIAL_INVALID`; banner in the UI |
| Clone fails | `repo.clone` | 3 attempts, then `error` / `CLONE_FAILED` |
| Setup fails | `script.exited` with a non-zero code | `setup_status = 'failed'`; queue waits for `Rerun setup` or `Continue anyway` |
| Checkpoint bundle upload fails | `bundle.upload` | 3 attempts, then `local_only` |
| Home backup fails | `home.backup` | `warn` log; continue |
| GitHub API returns 5xx | Any GitHub call | 3 attempts with backoff, then `GITHUB_API_ERROR` |
| GitHub API returns 4xx | Any GitHub call | No retry. Map to the matching code, else `GITHUB_API_ERROR` |
| DO restarts during an op | DO constructor | `running` op back to `pending`; its step runs again |
| Deploy while containers run | DO restart | Running containers keep their old image and env. The DO reconnects with `workspace.tempod_token`. |
| Artifact upload fails | Upload (01, Artifacts) | Retry with backoff, 5 attempts; the row stays `uploading` and the item `pending` until a later wake or sleep uploads it |
| Staged artifact copy lost | `artifacts.resume` on a fresh disk | Row `lost`, item `failed` |
| Outbox overflow | `outbox.overflow` | Notice item: some live events were lost; the transcript may have gaps |
| Egress blocked | `TempoOutbound` rule 10 | 403 to the container; row in `egress_log` |
