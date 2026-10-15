# 10 Project CI

The owner asked for stage 5 of `CLOUDFLARE-CODE-HOSTING-PLAN.md`: declarative CI for Artifacts-hosted ("native") projects, with checks that work without a pull request. This tab extends 09 and takes precedence over its statement that native check runs are empty. GitHub projects keep GitHub checks (03, Status polling). Nothing in this tab applies to them.

## Scope

In scope:

- An owner-approved pipeline per native project, written in YAML and stored by Tempo. A branch cannot change its own pipeline or merge requirements.
- Runs for an exact commit: on Tempo pushes and merges, on branch changes found by reconciliation, and on owner request (run, rerun, cancel).
- Isolated jobs, one container each, with read-only access to the project's repository and no credentials.
- Bounded, stored logs; check results tied to commit, pipeline revision and attempt.
- Merge gating for native pull requests, workspace checks, lifecycle check events, and web and Mac clients.

Not in this stage (recorded in `IMPLEMENTATION_NOTES.md`):

- Custom CI images and runtime releases (plan stages 2 and 4). Jobs use the pinned workspace image of this deployment.
- Dependency caches. Every job starts from a clean checkout.
- Artifacts push-event subscriptions. They need Queues, which are not in the D7 stack. Reconciliation replaces them.
- Merge-candidate checks (plan stage 6). The gate checks the PR head commit. The change-flow study (`evals/change-flow/README.md`) measured textual conflicts in 59% of nearby PR pairs on this repository; with many agents, a merge queue that tests the merge candidate becomes the main limit on throughput. It stays out of this stage.
- Project secrets and environment variables in jobs. Jobs get no secrets.
- Programmable (JS/TS) pipelines.

## Components

| Component | Owns | Boundary |
| --- | --- | --- |
| `RepositoryCiDO` | One per native project, addressed by name `<projectId>`. Pipeline revisions, runs, jobs, branch baselines and admission. | Only it writes its own SQLite. It reads D1 `projects`. It never writes D1. |
| CI runner | A `WorkspaceDO` instance with name `ci:<runId>:<jobKey>` and no `workspace` row. It runs one job in its own container, like the model-discovery instance (01). | Only it writes its own SQLite. It holds no project credential. |
| `TempoOutbound` (CI mode) | Egress for CI containers. | Read-only repository access; see Egress. |

Rule 4 (only a WorkspaceDO writes its own SQLite and workspace row) is unchanged. `RepositoryCiDO` is a new Durable Object class with SQLite storage, bound as `REPOSITORY_CI`.

## Pipeline file

The owner edits the pipeline in Tempo. It is not read from the repository. The source is YAML 1.2, parsed with the existing `yaml` 2.9.1 package, at most 64 KiB.

```yaml
version: 1
jobs:
  lint:
    run: bun install --frozen-lockfile && bun run lint
  test:
    name: Tests
    needs: [lint]
    timeout_minutes: 30
    run: |
      bun install --frozen-lockfile
      bun test
required: [test]
egress_allowlist: ["*.example.com"]
```

| Key | Rule |
| --- | --- |
| `version` | Required. Exactly `1`. |
| `jobs` | Required map with 1–10 entries. Keys match `^[a-z0-9][a-z0-9_-]{0,39}$`. |
| `jobs.<key>.run` | Required. A nonempty string, at most 16,384 characters. Runs with `bash -lc` in the checkout root. |
| `jobs.<key>.name` | Optional. 1–64 characters after trim. Default: the key. |
| `jobs.<key>.needs` | Optional list of other job keys. No self reference, no duplicates, no cycles. |
| `jobs.<key>.timeout_minutes` | Optional integer 1–60. Default 20. |
| `required` | Optional list of job keys whose success a merge needs. Default: every job. An empty list means no merge gate. |
| `egress_allowlist` | Optional list of at most 50 host patterns (`host.example` or `*.example`), added to the built-in hosts. |
| `risk` | Proposed, not yet accepted by the parser: optional map with keys `high` and `low`, each a list of at most 100 path patterns. See Risk tiers. |

Any other key, a wrong type or a broken rule fails with `CI_PIPELINE_INVALID`. Its detail names the first problem, for example `jobs.test.needs: unknown job "build"`.

- Each successful save makes a new revision. Revisions start at 1 and never repeat. Saving an empty (whitespace-only) source disables CI and also makes a new revision.
- A save sends the revision it edited. If the current revision is different, the save fails with `CI_PIPELINE_CHANGED` and changes nothing.
- The DO keeps the newest 20 revisions. A run records the revision it used and keeps its job list after newer revisions.

## Risk tiers

**Status: proposed on 2026-10-15 with 08, Verification. Not implemented.**

```yaml
risk:
  high: ["container/**", "packages/protocol/**", "**/migrations/**"]
  low: ["docs/**", "**/*.md"]
```

- A pattern is a repository-relative path. `*` matches within one path segment and `**` matches any number of segments.
- The tier of a head SHA comes from its changed paths against the PR base (`git diff --name-only <base>...<head>`), under the current pipeline revision: `high` if any path matches a `high` pattern; else `low` if every path matches a `low` pattern; else `medium`.
- No `risk` key, or no pipeline, gives `medium` for every head.
- The WorkspaceDO computes the tier at `tempo.branch.pushed`, from the same `git.changes {scope: "branch"}` call that the decision state uses, and the pipeline from `getCiPipeline`. It stores the tier on the gate runs and sends it with `reportVerification`. `RepositoryCiDO` keeps the tier for each SHA and revision.

## Runs and jobs

A run is one pipeline revision at one commit SHA of one branch. A job is one pipeline job in that run.

- Run identity is `(sha, revision, attempt)`, unique per project. Runs also have a project-wide `number` that starts at 1 and never repeats.
- `trigger` is `push` (Tempo push, merge or reconciliation), `manual` (`startCiRun`) or `rerun` (`rerunCiRun`).
- Automatic triggers use attempt 1. If any run already exists for that SHA and revision, the trigger does nothing. Manual run and rerun use the next attempt for that SHA and revision.
- When a branch gets a new automatic run, every queued or running run of an older SHA on that branch is cancelled.
- Ref deletions never start runs. A branch whose tip SHA cannot be read is skipped.

Run status: `queued`, `running`, `completed`. Run conclusion (only when completed): `success`, `failure`, `cancelled`.
Job status: `queued`, `running`, `completed`. Job conclusion: `success`, `failure`, `cancelled`, `timed_out`, `skipped`.

- A queued job starts when all its `needs` succeeded. If a need ends without success, the job completes as `skipped`.
- At most 2 jobs run at the same time per project. Others wait, oldest run first.
- A run completes when all its jobs completed. Conclusion: `cancelled` if it was cancelled; else `failure` if any job is `failure` or `timed_out`; else `success`.
- Cancelling a run marks its queued and running jobs `cancelled` and stops their containers. Results that arrive later are ignored.
- A job result is accepted only from the runner and job token that the DO started. A result for a completed job or an old token is ignored.
- A job that does not finish by its timeout plus 5 minutes is completed as `timed_out` by the DO. A job whose container stops without a result completes as `failure` with summary `The CI container stopped.`
- The DO keeps the newest 200 runs. Older runs, their jobs and their R2 logs are deleted.

## Ingestion and reconciliation

- After a `commit_push` operation succeeds, the WorkspaceDO sends `{branch, sha}` to the project's `RepositoryCiDO`. After a native merge succeeds, it sends the base branch and the merge commit.
- While a pipeline is enabled, the DO reads the branch tips every 2 minutes through Git ref advertisement (09). A changed tip starts an automatic run. A new branch is a change.
- When CI is first enabled (a revision with jobs after none), the DO records the current tips as its baseline and starts no runs. The owner can start a run for any branch.
- Ingestion failures (Artifacts unavailable) never fail the push or merge. Reconciliation catches up.

## Execution

Each job runs in a new container started by its runner:

1. Start the workspace image with `enableInternet: false`, a new `TEMPOD_TOKEN`, the default instance type, and labels `{purpose: "ci"}`. Intercept all outbound HTTP and HTTPS with `TempoOutbound` in CI mode.
2. Wait for health, connect and send `hello` with `workspace: {id: <runner name>, slug: "ci", branch, baseBranch: branch, repo: {owner: "tempo", name: <repo>}}` and `env: {}`.
3. Send `ci.checkout` `{url, branch, sha}` → `{sha}` (10 minute timeout). tempod empties `/workspace`, clones the branch without checkout, and checks out the exact SHA detached. It fails with `CLONE_FAILED` if the result is not that SHA.
4. Send `script.start` with kind `run`, `scriptId: "ci"`, cwd `""` and the job timeout. The job command never gets credentials, project variables or the `tempo` MCP server.
5. On `script.exited`: exit code 0 is `success`; a timeout is `timed_out`; anything else is `failure`. Upload the log, report the result to `RepositoryCiDO`, and destroy the container.

- The runner reconnects to tempod after a lost socket and resumes from its last acknowledged event (02, tempod protocol).
- A runner alarm checks the job every 30 seconds. A runner is idle and has no alarm when it has no job.

## Egress

`TempoOutbound` gets props `{workspaceId: <runner name>, userId, ci: true}`. In CI mode:

1. Rules 0 (APP_HOST) and 1 (plain HTTP goes to the policy) apply as usual.
2. Only for the project's trusted remote (same checks as 09 rule 2): `info/refs` with `service=git-upload-pack` and `git-upload-pack` are forwarded with a **read** repository token. Every other endpoint of that remote, including `git-receive-pack`, is blocked with 403.
3. Rules 3–7 and 11–14 never apply. Placeholders are refused (rule 7). No GitHub token, API key, environment secret, injector or MCP header is added.
4. The policy is `allowlist` with the built-in hosts (01) and the pipeline's `egress_allowlist`. CI egress is logged with `log()` and not stored in an `egress_log` table.

## Logs

- The runner keeps the last 1 MiB of job output (stdout and stderr in arrival order). Earlier output is dropped and the log starts with `[tempo: earlier output dropped]`.
- Known credential values are redacted with the lifecycle redactor before storage. Jobs never receive such values, so this is a second defense.
- At completion, the log goes to R2 at `ci/<projectId>/<runId>/<jobKey>.log`. While a job runs, `getCiJobLog` returns the live tail from the runner.

## Wire types

All are in `packages/protocol` (Effect Schema). Timestamps are Unix milliseconds.

- `CiPipeline`: `projectId`, `revision` (0 when never saved), `source`, `enabled`, `jobs` (`CiJobSpec[]`), `required` (job keys), `egressAllowlist`, `updatedAt` (nullable).
- `CiJobSpec`: `key`, `name`, `needs`, `timeoutMinutes`.
- `CiRun`: `id`, `projectId`, `number`, `branch`, `sha`, `revision`, `attempt`, `trigger`, `status`, `conclusion` (nullable), `createdAt`, `startedAt` (nullable), `completedAt` (nullable), `url`. The URL is `/repositories?project=<id>&tab=checks&run=<runId>` on the app host.
- `CiJob`: `key`, `name`, `needs`, `status`, `conclusion` (nullable), `exitCode` (nullable), `summary` (nullable), `startedAt` (nullable), `completedAt` (nullable).
- `CiRunDetail`: `run` and `jobs`.

## API

Every function uses owner authentication, schema validation, the Result envelope and both wrappers. Each requires an owned Artifacts project; other projects return `VALIDATION_FAILED`, missing ones `NOT_FOUND`.

| Function | Method | Input | Output |
| --- | --- | --- | --- |
| `getCiPipeline` | GET | `{projectId}` | `CiPipeline` |
| `updateCiPipeline` | POST | `{projectId, source, revision}` | `CiPipeline` |
| `listCiRuns` | GET | `{projectId, branch?, offset?}` | `CiRun[]` |
| `getCiRun` | GET | `{projectId, runId}` | `CiRunDetail` |
| `startCiRun` | POST | `{projectId, branch}` | `CiRun` |
| `rerunCiRun` | POST | `{projectId, runId}` | `CiRun` |
| `cancelCiRun` | POST | `{projectId, runId}` | `CiRun` |
| `getCiJobLog` | GET | `{projectId, runId, job}` | `{text, truncated}` |

- `listCiRuns` returns at most 50 runs, newest number first. Offset is a nonnegative safe integer.
- `startCiRun` validates the branch (09; `BRANCH_INVALID`) and reads its tip. A missing branch returns `NOT_FOUND`. No enabled pipeline returns `CI_NOT_CONFIGURED`.
- `rerunCiRun` uses the current revision. Rerun of a queued or running run returns `WORKSPACE_BUSY`. No enabled pipeline returns `CI_NOT_CONFIGURED`.
- `cancelCiRun` of a completed run returns it unchanged.
- CI only reads Git, so read-only repositories can run CI.

New error codes:

| Code | Message |
| --- | --- |
| `CI_PIPELINE_INVALID` | The CI pipeline is not valid. |
| `CI_PIPELINE_CHANGED` | The CI pipeline changed. Reload it and try again. |
| `CI_NOT_CONFIGURED` | Add a CI pipeline for this repository first. |

## Checks, merge and events

- Native `listCheckRuns` and `refreshPullRequest` read the newest run (highest attempt) for the PR head branch's current tip and the current revision. Each job is one `CheckRun`: `name` is the job name; `status` is `queued`, `in_progress` or `completed`; `conclusion` is the job conclusion; `url` is the run URL; `summary` is the job summary when present.
- `checksState` uses the 03 rule over those check runs. No pipeline or no run gives `null`; the UI never invents passing checks.
- When a run changes, `RepositoryCiDO` notifies each non-archived workspace of the project on that branch. A workspace with a PR refreshes its checks.
- Native `tempo.check.passed` and `tempo.check.failed` keep payload `{prNumber}` and add optional `commitSha`. The dedupe key stays `checks:<prNumber>:<sha>:<type>`. Workspaces without a PR get no check events in this stage.
- Merge gate: a native merge needs the newest run for the exact head SHA and the current revision, with every `required` job `success`. Otherwise it fails with `PR_NOT_MERGEABLE`, detail `Required checks have not passed for <sha7>.` No pipeline, a disabled pipeline or an empty `required` list means no gate. A merge already pushed (lost acknowledgement) is still recovered without the gate.
- Proposed merge gate inputs (08, Verification; not implemented). After the CI check, for the head's tier, in this order:
  1. Each enabled attachment with a required `pre_merge` gate for the tier has a reported run for the exact SHA with status `pass`. Otherwise detail `Required verifier <handle> has not passed for <sha7>.` An attachment whose agent is deleted still counts and keeps the gate closed until the owner removes or disables the attachment.
  2. No gate run reported for the SHA has a confirmed blocking finding. Otherwise detail `<handle> reported a blocking finding for <sha7>.`
  3. For `high`, a Guide acknowledgement for the SHA. Otherwise detail `Read the guide for <sha7> first.`
  A merge already pushed is still recovered without these inputs.
- Proposed storage. `RepositoryCiDO` migration `0001_verification` adds `verifications(sha, attachment_id, run_id, workspace_id, handle, tier, status, blocking, model_family, reported_at, PRIMARY KEY (sha, attachment_id, run_id))`, `guide_acks(sha PRIMARY KEY, acknowledged_at)` and `gates(pr_number, sha, tier, state, reasons_json, updated_at, PRIMARY KEY (pr_number, sha))`. For each attachment the newest reported run counts. It keeps rows for the newest 200 SHAs. It reads attachments and their gates from D1 and never writes D1.
- `RepositoryCiDO` recomputes the gate state after each run change, report, acknowledgement, push and merge. It notifies each non-archived workspace of the PR's head branch; the WorkspaceDO emits `tempo.gate.changed`. Both clients show the state and reasons beside the PR's checks.

## Clients

- Both clients add a **Checks** tab to native repositories (search key `tab=checks`, `run=<runId>`).
- The tab lists runs (number, branch, short SHA, trigger, status/conclusion, time) with a branch filter and paging, and a **Run checks** action for a selected branch.
- Run detail shows jobs with status, conclusion, exit code, duration and summary; **Cancel** for unfinished runs; **Rerun** for completed runs; and the selected job's log as plain text.
- A **Pipeline** section shows the current YAML with its revision. Save shows `CI_PIPELINE_INVALID` details in place and `CI_PIPELINE_CHANGED` with a reload action.
- Native PR detail shows the head commit's checks and links to the run.
- Workspace checks use the existing checks panel. Both clients use shared generated protocol types. No new dependency.

## Deployment and validation

Bind `REPOSITORY_CI` to `RepositoryCiDO` (SQLite storage) in local, test and deploy configs. No new secret or image. CI containers count toward the container instance limits of `WorkspaceDO`.

Required verification: pipeline validation and revision conflicts; ingestion dedupe; supersede and cancel; `needs` ordering and skips; concurrency limit; stale and late results; timeouts and lost containers; log bounds and redaction; read-only egress (receive-pack blocked, no credential rules); merge gate including the lost-acknowledgement path; workspace checks and events; `ci.checkout` in the pinned container; web and Mac flows. Live Artifacts and hosted container acceptance are separate from mocked local tests.
