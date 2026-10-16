# 12 App Deploy

The owner asked for a Cloudflare control plane that deploys the owner's applications from Tempo-hosted ("native") repositories. A deploy runs in a dedicated container, like a CI job (10). It supports Alchemy v2 (`alchemy.run.ts`) and the Cloudflare CLI's typed configuration (`cloudflare.config.ts`). Tempo holds one owner master token and mints a short-lived, scoped token for each deployment from what the project's deploy configuration declares. This tab extends 09 and 10. GitHub projects are not in this stage. [13 Loop](13%20Loop.md) changes this tab (owner-approved 2026-10-15): gradual deploys with Durable Object rules, a Rollback action and deploy events (L-ADR-4, L-ADR-7). Where they differ, 13 is correct.

## Scope

In scope:

- An owner-approved deploy configuration per native project, written in YAML and stored by Tempo. A branch cannot change its own deploy configuration.
- Named targets (for example `production` and `preview`), each mapped to an Alchemy stage or a `cf` mode.
- Three triggers: the owner (web and Mac), an agent through the `tempo` MCP server, and an automatic deploy after a successful CI run on a target branch (on merge).
- One container per deployment, with read-only repository access and a Cloudflare token that never enters the container.
- Bounded, stored logs. Web and Mac clients.

Not in this stage (recorded in `IMPLEMENTATION_NOTES.md`):

- GitHub projects. Deploys need the native clone path and CI ingestion.
- Application secrets and environment variables in deploys. The deploy command gets no secrets except the Cloudflare token swap below.
- Container applications and anything else that needs Docker. The workspace image has no Docker (05).
- Rollback to an earlier deployment as its own action. **Redeploy** of an earlier deployment is the rollback path. Changed by 13, L-ADR-4: Rollback becomes its own action.
- Lifecycle events for deployments. Agents read state with the deploy tools. Changed by 13, L-ADR-7.
- Tempo-managed Alchemy state. The project's `alchemy.run.ts` chooses its own state store; see Tools.

## Components

| Component | Owns | Boundary |
| --- | --- | --- |
| `AppDeployDO` | One per native project, addressed by name `<projectId>`. Configuration revisions, deployments, admission and token revocation. | Only it writes its own SQLite. It reads D1 `projects`. It never writes D1. |
| Deploy runner | A `WorkspaceDO` instance with name `deploy:<deploymentId>` and no `workspace` row. It runs one deployment in its own container, like a CI runner (10). | Only it writes its own SQLite. It holds no credential. |
| `TempoOutbound` (deploy mode) | Egress for deploy containers. | Read-only repository access and the Cloudflare token swap; see Egress. |
| `CredentialDO` (owner) | The master token and each deployment's minted token. | Secrets stay here (05). |

`AppDeployDO` is a new Durable Object class with SQLite storage, bound as `APP_DEPLOY`. Rule 4 is unchanged.

## Owner settings

The owner saves one Cloudflare account and one master token in Settings. They are stored in the owner's `CredentialDO` under keys `cloudflare.deploy_token` and `cloudflare.account_id`. The account ID is not a secret; it is stored there so both values change together.

- The account ID matches `^[0-9a-f]{32}$`. The token is 1–512 characters after trim.
- Save checks the token with `GET https://api.cloudflare.com/client/v4/accounts/<accountId>/tokens/permission_groups`. A response other than 2xx with `success: true` fails with `DEPLOY_TOKEN_INVALID` and changes nothing.
- The master token must be able to create account-owned API tokens (`Account API Tokens Write`) and must hold every permission group that the projects declare. Tempo never uses the master token in a container or for a deploy command.
- Delete removes the key. Deployments that start later fail with `DEPLOY_ACCOUNT_NOT_SET`.

## Deploy configuration

The owner edits the configuration in Tempo. It is not read from the repository. The source is YAML 1.2, parsed with the existing `yaml` 2.9.1 package, at most 16 KiB.

```yaml
version: 1
tool: alchemy
root: apps/web
install: bun install --frozen-lockfile
build: bun run build
timeout_minutes: 20
egress_allowlist: ["pkg.example.com"]
targets:
  production:
    branch: main
    stage: production
    auto: true
  preview:
    stage: preview
    agent: true
```

| Key | Rule |
| --- | --- |
| `version` | Required. Exactly `1`. |
| `tool` | Required. `alchemy` or `cloudflare-config`. |
| `root` | Optional. The project directory, relative to the checkout root. Segments match `^[A-Za-z0-9._-]+$`, joined by `/`, no `.` or `..` segment, at most 200 characters. Default: the checkout root. |
| `install` | Optional. A nonempty string, at most 4,096 characters. Default: `bun install --frozen-lockfile` when `root` has `bun.lock` or `bun.lockb`, else `npm ci` when it has `package-lock.json`. With neither file and no `install`, the deployment fails with summary `No lockfile found. Set install in the deploy configuration.` |
| `build` | Optional. A nonempty string, at most 4,096 characters. Runs after install and before the deploy command. |
| `permissions` | Not accepted (owner-requested 2026-10-16). Permissions come from the project's grant (Access requests and grants). |
| `timeout_minutes` | Optional integer 1–60. Default 20. |
| `egress_allowlist` | Optional list of at most 50 host patterns (`host.example` or `*.example`), added to the built-in hosts. |
| `auto_fix` | Optional boolean, default `false`. A new production error starts its fix workspace with no owner action (Production errors). |
| `targets` | Required map with 1–10 entries. Keys match `^[a-z0-9][a-z0-9_-]{0,39}$`. |
| `targets.<key>.stage` | Optional. Matches `^[a-z0-9][a-z0-9_-]{0,39}$`. Default: the key. |
| `targets.<key>.branch` | Optional. A valid branch name (09). When set, the target deploys only that branch. |
| `targets.<key>.auto` | Optional boolean, default `false`. Needs `branch`. Deploys after a successful CI run on that branch; see Triggers. |
| `targets.<key>.agent` | Optional boolean, default `false`. Agents may start deployments of this target. |
| `targets.<key>.rollout` | Optional. `full` (default: the tool deploys at 100%) or `gradual` (Gradual rollout, below). |
| `targets.<key>.workers` | Optional list of 1–10 Worker script names, each matching `^[a-z0-9][a-z0-9_-]{0,62}$`, no duplicates. Required when `rollout` is `gradual`. The first one serves the `smoke` URLs. |
| `targets.<key>.smoke` | Optional list of at most 5 `https://` URLs, each at most 2,048 characters. Only with `rollout: gradual`. |

Any other key, a wrong type or a broken rule fails with `DEPLOY_CONFIG_INVALID`. Its detail names the first problem, for example `targets.production.auto: needs branch`.

- Each successful save makes a new revision. Revisions start at 1 and never repeat. Saving an empty (whitespace-only) source disables deploys and also makes a new revision.
- A save sends the revision it edited. If the current revision is different, the save fails with `DEPLOY_CONFIG_CHANGED` and changes nothing.
- The DO keeps the newest 20 revisions. A deployment records the revision it used and keeps its own copy of the commands, stage, permissions, rollout, Workers and smoke URLs.

### Permissions

Each permission maps to Cloudflare permission groups. Account-scope groups use the resource `com.cloudflare.api.account.<accountId>`. Zone-scope groups use `{"com.cloudflare.api.account.<accountId>": {"com.cloudflare.api.account.zone.*": "*"}}`.

| Permission | Groups | Scope |
| --- | --- | --- |
| `workers` | `Workers Scripts Write`, `Account Settings Read` | account |
| `kv` | `Workers KV Storage Write` | account |
| `d1` | `D1 Write` | account |
| `r2` | `Workers R2 Storage Write` | account |
| `queues` | `Queues Write` | account |
| `vectorize` | `Vectorize Write` | account |
| `hyperdrive` | `Hyperdrive Write` | account |
| `secrets_store` | `Secrets Store Write` | account |
| `routes` | `Workers Routes Write`, `DNS Write`, `Zone Read` | zone |

Tempo looks up group IDs by exact name and scope from the permission groups endpoint at mint time. A missing group fails the deployment with summary `Cloudflare has no permission group "<name>".`

### Access requests and grants (owner-requested 2026-10-16)

The project's permissions are a **grant** that the owner approves; they are not part of the deploy configuration. `workers` is always granted. The master token mints every token from the grant, for one use, and the token is revoked after it (Tokens; 13, L-ADR-8).

| Rule | Value |
| --- | --- |
| Request | The `tempo` MCP tool `request_cloudflare_access {permissions, reason}` in a chat with no run. `permissions`: 1–9 distinct values of `DeployPermission`; `reason`: 1–500 characters. Permissions already granted are left out; when none are left, the tool answers `Already granted: <list>.` Otherwise the WorkspaceDO stores a request and answers `Tempo asked the owner for <list>. End your turn; you will get the answer as a message.` A second request in the same chat while one is pending is refused: `A Cloudflare access request is already waiting for the owner.` |
| Card | One `cloudflare_access` item in the chat: each permission with its Cloudflare groups (Permissions, above), the reason, and **Approve** and **Deny**. The workspace needs input while a request is pending. |
| Decide | `decideCloudflareAccess {workspaceId, requestId, approve}`. Approve adds the permissions to the project's grant (`AppDeployDO.grant`) and queues the turn `The owner approved Cloudflare access: <list>.` in the same chat; Deny queues `The owner denied Cloudflare access: <list>.` A repeat does nothing. |
| Storage | WorkspaceDO table `cloudflare_access_requests`: `id`, `session_id`, `item_id`, `permissions_json`, `reason`, `status` (`pending`, `approved`, `denied`), `created_at`, `decided_at`. AppDeployDO table `grants`: `permission` (primary key), `granted_at`, `workspace_id`, `request_id`. |
| List and remove | `listCloudflareGrants {projectId}` returns `[{permission, grantedAt}]`, `workers` first. `removeCloudflareGrant {projectId, permission}` removes one (not `workers`) and returns the list; removed access ends the sessions that held it (14, C-ADR-1). The repository's Deploys tab lists the grant with **Remove** on web and Mac. |
| Use | A deployment records the grant at admission as its permissions. The agent's Cloudflare API token (13, L-ADR-8) and the manifest's `cloudflare.permissions` (14) use the current grant. |
| Earlier configurations | A saved configuration's `permissions` were approved by the owner when saved, so migration `0003_grants` copies them into `grants` once. The key is no longer accepted in a configuration. |

## Tools

The deploy command runs with `bash -lc` in `root`. Tempo builds it from the deployment's stored values; the owner writes only `install` and `build`.

| `tool` | Required file in `root` | Deploy command |
| --- | --- | --- |
| `alchemy` | `alchemy.run.ts` | `npx --no -- alchemy deploy --stage <stage> --yes` |
| `cloudflare-config` | `cloudflare.config.ts` | `npx --no -- cf deploy --mode <stage>` |

- A missing required file fails before install with exit code 2 and summary `<file> was not found in <root or "the repository root">.`
- Both tools come from the project's own dependencies (`alchemy` 2.x and `cf`). Tempo installs neither. `npx --no` never downloads a package.
- `cf` loads `cloudflare.config.ts` only on Node.js 22.18 or later and refuses Bun. The workspace image's Node.js 24 runs it.
- Alchemy v2 stacks declare their own state store. A deploy container is new each time, so a stack that keeps only local state loses it. Projects should use a remote store such as `Cloudflare.state()`, which needs `secrets_store`.
- The command's environment adds exactly: `CI=1`, `CF_SEND_TELEMETRY=false`, `DO_NOT_TRACK=1`, `CLOUDFLARE_ACCOUNT_ID=<accountId>`, `CLOUDFLARE_API_TOKEN=tempo-placeholder`, `TEMPO_DEPLOY_TARGET=<target>` and `TEMPO_DEPLOY_STAGE=<stage>`. With `rollout: gradual` it also adds `TEMPO_DEPLOY_TRAFFIC=0` (Gradual rollout). The placeholder is the fixed `PLACEHOLDER` (01) and is not a secret.

## Deployments

A deployment is one target at one commit SHA of one branch.

- Deployments have a project-wide `number` that starts at 1 and never repeats.
- `trigger` is `manual` (`startDeployment`), `agent` (`deploy_app`), `auto` (Triggers) or `redeploy` (`redeploy`).
- Status: `queued`, `running`, `completed`. Conclusion (only when completed): `success`, `failure`, `cancelled`, `timed_out`.
- At most 1 deployment runs at a time per project. Others wait, oldest first.
- A new queued deployment of a target cancels the older queued deployments of that target. A running deployment is never superseded.
- Cancelling a queued deployment completes it as `cancelled`. Cancelling a running deployment also stops its container and revokes its token. Results that arrive later are ignored.
- A result is accepted only from the runner and token that the DO started. A result for a completed deployment or an old token is ignored.
- A deployment that does not finish by its timeout plus 5 minutes is completed as `timed_out` by the DO. A deployment whose container stops without a result completes as `failure` with summary `The deploy container stopped.`
- Exit code 0 is `success`. A timeout is `timed_out`. Anything else is `failure`.
- The DO keeps the newest 200 deployments. Older deployments and their R2 logs are deleted. Unlinking also deletes the Issues webhook secret.

## Triggers

- **Owner.** `startDeployment {projectId, target, branch?}`. A target with `branch` deploys that branch; a different `branch` input fails with `VALIDATION_FAILED`, detail `Target <key> deploys only branch <branch>.` A target without `branch` needs the input. The DO reads the branch tip (09); a missing branch returns `NOT_FOUND`.
- **Agent.** The `deploy_app` tool (below) deploys the workspace's branch at its current tip. The target must have `agent: true`, else `FORBIDDEN`. The branch rule above applies to the workspace branch.
- **Auto (on merge).** For each target with `auto: true`, when `RepositoryCiDO` completes a `push` run with conclusion `success` on that target's branch, it sends `{branch, sha}` to `AppDeployDO`. When the project has no enabled CI pipeline, `RepositoryCiDO` sends the `{branch, sha}` of each Tempo push or merge (10, Ingestion) instead. An auto deployment for a target, SHA and revision that already exists does nothing. Ingestion failures never fail the CI run, push or merge.
- **Redeploy.** `redeploy {projectId, deploymentId}` deploys the same target, branch and SHA with the current revision. Redeploy of a queued or running deployment returns `WORKSPACE_BUSY`. A target that the current revision no longer has returns `NOT_FOUND`.

## Tokens

For each deployment, at admission, `AppDeployDO`:

1. Reads the master token and account ID. Missing settings complete the deployment as `failure` with summary `Add a Cloudflare account and token in Settings first.`
2. Creates an account-owned token with `POST /client/v4/accounts/<accountId>/tokens`: name `tempo-deploy-<projectId>-<number>`, one policy per scope with the permission groups of the project's grant at admission (Access requests and grants), and `expires_on` set to the start time plus the timeout plus 15 minutes (whole seconds, UTC).
3. Stores the token value in the owner's `CredentialDO` under key `deploy.<deploymentId>.token` and the token ID in its own SQLite. The value never enters D1, R2, logs, events or the container.
4. Starts the runner. A mint failure completes the deployment as `failure` with summary `Cloudflare did not create a deploy token: <status>.`

When the deployment completes, for any reason, the DO deletes the `CredentialDO` key and revokes the token with `DELETE /client/v4/accounts/<accountId>/tokens/<tokenId>`. A 2xx or 404 answer completes revocation. Other answers are retried by the alarm every 30 seconds until the token expires. The DO records `tokenRevoked`.

## Execution

Each deployment runs in a new container started by its runner, as a CI job does (10, Execution), with these differences:

1. Start the workspace image with `enableInternet: false`, a new `TEMPOD_TOKEN`, the default instance type, and labels `{purpose: "deploy"}`. Intercept all outbound HTTP and HTTPS with `TempoOutbound` in deploy mode.
2. Send `hello` with `workspace: {id: <runner name>, slug: "deploy", branch, baseBranch: branch, repo: {owner: "tempo", name: <repo>}}` and `env: {}`.
3. Send `ci.checkout` `{url, branch, sha}` → `{sha}` (10 minute timeout).
4. Send `script.start` with kind `run`, `scriptId: "deploy"`, cwd `""`, the timeout, and the command: exports of the environment above, `cd` to `root`, the required file check, install, build when set, and the deploy command, joined so the first failure stops it.
5. On `script.exited`, upload the log, report the result to `AppDeployDO`, and destroy the container.

The runner reconnects after a lost socket and checks its deployment every 30 seconds, as in 10.

## Egress

`TempoOutbound` gets props `{workspaceId: <runner name>, userId, deploy: true}`. In deploy mode:

1. Rules 0 (APP_HOST) and 1 (plain HTTP goes to the policy) apply as usual.
2. The project's trusted remote is read-only, exactly as in CI mode (10, Egress rule 2).
3. For `api.cloudflare.com` over HTTPS, a request whose `Authorization` header is exactly `Bearer tempo-placeholder` is forwarded with `Authorization: Bearer <minted token>` and manual redirects. Without a live token for the runner's deployment it is blocked with 403 `tempo: credential not set`. Other requests to that host are forwarded unchanged.
4. Any other request that carries a placeholder is refused (rule 7). Rules 3–6 and 11–14 never apply. No GitHub token, API key, environment secret, injector or MCP header is added.
5. The policy is `allowlist` with the built-in hosts (01), `api.cloudflare.com`, `*.workers.dev` and the configuration's `egress_allowlist`. Deploy egress is logged with `log()` and not stored in an `egress_log` table.

Trust boundary: install, build and deploy run the branch's code, and that code can use the minted token through the proxy. The minted token's permissions, the target's `branch` and `agent` settings, and the owner-only configuration are the controls. Give agent-enabled targets a separate stage.

## Gradual rollout

13, L-ADR-4, owner-approved 2026-10-15. Applies only to a target with `rollout: gradual`. The project's `alchemy.run.ts` passes `TEMPO_DEPLOY_TRAFFIC` to each Worker's `version.traffic`, so the tool uploads new versions and does not move traffic. Tempo then moves traffic with the Versions and Deployments API and the deployment's minted token, which `workers` always grants (`Workers Scripts Write`).

The deployment stays `running` until the rollout ends. It has a `phase`: `null` while the container runs, then `canary`, then it completes. Its minted token expires at the start time plus the timeout plus the observe window (10 minutes) plus 15 minutes, and is revoked when the deployment completes, as before.

**1. Record.** After exit code 0, for each Worker in `workers`, in order:

- Read its deployments. The newest is live.
- If the live deployment was created after the deployment started and has one version at 100%, the tool deployed that Worker at 100% (for example a Durable Object class migration). Record that version as `versionId`, that deployment as `cloudflareDeploymentId`, and the version with the largest share in the newest deployment created before the start as `previousVersionId` (null when none).
- Else read its versions. The newest version created after the start is `versionId`. None fails the deployment with summary `No new version of <worker> was uploaded. Pass TEMPO_DEPLOY_TRAFFIC to version.traffic.` `previousVersionId` is the version with the largest share in the live deployment.
- Write one `deploy.version.uploaded` event per Worker.

If any Worker went to 100%, Tempo moves every other Worker to 100% at once (step 4), and the deployment completes `success` with summary `<worker> deployed at 100% without a gradual rollout.` Else:

**2. Canary.** For each Worker with a `previousVersionId`, create a deployment with `versionId` at 10% and `previousVersionId` at 90%. A Worker with no `previousVersionId` goes to 100%. Set `phase` to `canary` and `canaryUntil` to now plus the observe window (10 minutes). Write `deploy.traffic.changed` per Worker.

**3. Smoke test.** For each `smoke` URL, send a `GET` with `Cloudflare-Workers-Version-Overrides: <first worker>="<its versionId>"`, a 10-second timeout and manual redirects. A status of 500 or more, or no answer, fails the gate.

**4. Promote.** When `canaryUntil` passes and the gate has not failed, create a deployment with `versionId` at 100% for each Worker, write `deploy.traffic.changed`, and complete `success`.

**5. Roll back.** When the gate fails during `canary`, or the owner cancels it, create a deployment with `previousVersionId` at 100% for each Worker that has one, write `deploy.rolled_back`, and complete `failure` with summary `Rolled back: <reason>.` (a cancel completes `cancelled`). A Cloudflare error during a rollback is stored in the summary; it does not stop the other Workers.

The gate also fails when 13, L-ADR-5 reports a new Issue on a `versionId` (slice 4). Every step checks the phase and token first, so a repeat does nothing (rule 5). The watchdog skips a deployment in `canary`; the alarm runs steps 4 and 5.

**Owner rollback.** `rollbackDeployment {projectId, deploymentId}` rolls back a completed `success` deployment of a `gradual` target:

- It must be the newest completed `success` deployment of its target, no deployment of the project may be queued or running, and every Worker must have a `previousVersionId`. Else `VALIDATION_FAILED` with detail `Nothing to roll back to.` or `WORKSPACE_BUSY`.
- Tempo mints a token with `workers` that expires in 15 minutes, creates a deployment with `previousVersionId` at 100% for each Worker, revokes the token, and sets the deployment's `rolledBackAt`. A token that fails to revoke expires on its own.
- Writes `deploy.rolled_back`. Returns the deployment.

**Events.** `AppDeployDO` keeps rollout events in its own SQLite table `events` (`id`, `deployment_id`, `type`, `at`, `payload_json`), the newest 2,000. Payloads hold the Worker, the version and Cloudflare deployment IDs and the percentages, never a token. 13, L-ADR-7 reads them.

## Production errors

13, L-ADR-5 and L-ADR-6, owner-approved 2026-10-15. Workers Issues sends each new issue of the project's Workers to Tempo by a generic webhook. The owner sets the webhook up once, in the Cloudflare dashboard or with `cf`, because Cloudflare documents no REST API for Issues automations.

**Webhook.**

- `getIssuesWebhook {projectId}` returns `{url, secretSet}`. `url` is `https://<APP_HOST>/api/hooks/cloudflare-issues/<projectId>`.
- `rotateIssuesWebhook {projectId}` makes a new random secret (32 bytes, base64url), stores it in the owner's `CredentialDO` under `issues.<projectId>.webhook_secret`, and returns `{url, secret}`. Only this answer holds the secret. The owner pastes it into the destination's secret field.
- `POST /api/hooks/cloudflare-issues/<projectId>` needs no session. It answers 404 unless the project is a native project, the secret is set, and the `cf-webhook-auth` header equals it (constant-time compare). A body over 256 KiB answers 413. A body that is not the Notifications envelope (a JSON object with string `text`) answers 400. Else it hands the payload to the project's `AppDeployDO` and answers 204.

**Ingest.** The envelope is `{name, text, data, ts, alert_type, alert_correlation_id, ...}`; `data` varies by alert type and Cloudflare does not document it for Issues (spike L-S2). `AppDeployDO` reads, without failing on a missing key:

| Field | Read from |
| --- | --- |
| `issueKey` | The first string at any depth of `data` under a key `issue_id`, else `alert_correlation_id`, else the SHA-256 of `text` |
| `worker` | The first string under `script_name`, `worker_name`, `worker` or `service`, when it is one of the project's configured Workers; else null |
| `versionId` | The first string under `version_id`, `script_version_id` or `versionId`; else null |
| `title` | `name`, cut to 200 characters |
| `text` | `text` with bearer tokens and `token=`, `key=`, `secret=` and `password=` values replaced by `[redacted]`, cut to 4 KiB |

It never stores `data` itself, headers or request bodies. A known `issueKey` adds one occurrence and updates `lastSeenAt`; else it inserts a production error and writes `prod.error.seen`. The DO keeps the newest 500 errors and deletes errors last seen more than 90 days ago.

**Gate.** A deployment in `canary` fails its gate (Gradual rollout) when an error arrives whose `versionId` is one of its new versions, or whose `versionId` is null and whose `worker` is one of its Workers. Without a known version, Tempo cannot tell an old version's error from a new one; it rolls back to be safe.

**Fix.** `startErrorFix {projectId, errorId}` creates a workspace with `createWorkspace` on a new branch from the base branch of the error's deployment (the project's default branch when none is known), with the default agent and this first prompt:

```
Fix this production error in <worker or "the app">.
<title>
<text>
Deployment #<number> (<target>), version <versionId or "unknown">, commits <previous sha>..<sha>.
Seen <occurrences> times between <first> and <last> (UTC).
```

It stores the workspace ID on the error and returns `{workspaceId}`. A second call returns the same workspace. With `auto_fix: true`, Tempo calls it for each new error on its own, as the owner. A fix that fails to start is logged and the error card shows **Start fix** again.

**Fixed.** When a deployment completes `success` after a fix workspace was created, and the error has no new occurrence for the observe window (10 minutes) after that completion, Tempo sets `fixedAt` and writes `prod.error.fixed`. A later occurrence clears `fixedAt` and writes `prod.error.seen` again.

**Clients.** The Deploys tab shows a **Production errors** list above the deployments: title, Worker, version, occurrences, last seen, and **Start fix** or the fix workspace link, and fixed errors greyed. The Configuration section of the Deploys tab shows the webhook URL, whether a secret is set, and **New secret**, which shows the secret once.

## Logs

- The runner keeps the last 1 MiB of output, as in 10 (`[tempo: earlier output dropped]`).
- Known credential values, including the deployment's minted token, are redacted before storage.
- At completion, the log goes to R2 at `deploy/<projectId>/<deploymentId>.log`. While a deployment runs, `getDeploymentLog` returns the live tail from the runner.

## Wire types

All are in `packages/protocol` (Effect Schema). Timestamps are Unix milliseconds.

- `DeployTool`: `alchemy`, `cloudflare-config`.
- `DeployPermission`: `workers`, `kv`, `d1`, `r2`, `queues`, `vectorize`, `hyperdrive`, `secrets_store`, `routes`.
- `DeployTrigger`: `manual`, `agent`, `auto`, `redeploy`. `DeployStatus`: `queued`, `running`, `completed`. `DeployConclusion`: `success`, `failure`, `cancelled`, `timed_out`.
- `DeployTarget`: `key`, `stage`, `branch` (nullable), `auto`, `agent`, `rollout` (`full` or `gradual`), `workers` (string list), `smoke` (string list).
- `DeployRollout`: `phase` (`canary`, `promoted`, `full`, `rolled_back`), `canaryUntil` (nullable), `rolledBackAt` (nullable), `workers`: list of `{name, versionId, previousVersionId (nullable), percentage, cloudflareDeploymentId (nullable)}`.
- `DeployConfig`: `projectId`, `revision` (0 when never saved), `source`, `enabled`, `tool` (nullable), `root`, `permissions` (always includes `workers` when enabled), `timeoutMinutes`, `egressAllowlist`, `targets` (`DeployTarget[]`), `updatedAt` (nullable).
- `Deployment`: `id`, `projectId`, `number`, `target`, `stage`, `branch`, `sha`, `revision`, `trigger`, `status`, `conclusion` (nullable), `exitCode` (nullable), `summary` (nullable), `workspaceId` (nullable; set for `agent`), `createdAt`, `startedAt` (nullable), `completedAt` (nullable), `url`, `rollout` (`DeployRollout`, nullable; set once versions are recorded). The URL is `/repositories?project=<id>&tab=deploys&deployment=<deploymentId>` on the app host.
- `DeploySettings`: `accountId` (nullable), `tokenSet`, `updatedAt` (nullable).
- `ProductionError`: `id`, `projectId`, `worker` (nullable), `versionId` (nullable), `deploymentId` (nullable), `deploymentNumber` (nullable), `title`, `text`, `occurrences`, `firstSeenAt`, `lastSeenAt`, `fixWorkspaceId` (nullable), `fixedAt` (nullable).
- `DeployConfig` adds `autoFix`.

## API

Every function uses owner authentication, schema validation, the Result envelope and both wrappers. The project functions require an owned Artifacts project; other projects return `VALIDATION_FAILED`, missing ones `NOT_FOUND`.

| Function | Method | Input | Output |
| --- | --- | --- | --- |
| `getDeploySettings` | GET | `{}` | `DeploySettings` |
| `updateDeploySettings` | POST | `{accountId, token}` | `DeploySettings` |
| `deleteDeploySettings` | POST | `{}` | `DeploySettings` |
| `getDeployConfig` | GET | `{projectId}` | `DeployConfig` |
| `updateDeployConfig` | POST | `{projectId, source, revision}` | `DeployConfig` |
| `listDeployments` | GET | `{projectId, target?, offset?}` | `Deployment[]` |
| `getDeployment` | GET | `{projectId, deploymentId}` | `Deployment` |
| `startDeployment` | POST | `{projectId, target, branch?}` | `Deployment` |
| `redeploy` | POST | `{projectId, deploymentId}` | `Deployment` |
| `cancelDeployment` | POST | `{projectId, deploymentId}` | `Deployment` |
| `rollbackDeployment` | POST | `{projectId, deploymentId}` | `Deployment` |
| `listProductionErrors` | GET | `{projectId}` | `ProductionError[]` (newest `lastSeenAt` first, at most 100) |
| `startErrorFix` | POST | `{projectId, errorId}` | `{workspaceId}` |
| `getIssuesWebhook` | GET | `{projectId}` | `{url, secretSet}` |
| `rotateIssuesWebhook` | POST | `{projectId}` | `{url, secret}` |
| `getDeploymentLog` | GET | `{projectId, deploymentId}` | `{text, truncated}` |

- `listDeployments` returns at most 50 deployments, newest number first. Offset is a nonnegative safe integer.
- `startDeployment` and `redeploy` with no enabled configuration return `DEPLOY_NOT_CONFIGURED`; an unknown target returns `NOT_FOUND`. Missing owner settings return `DEPLOY_ACCOUNT_NOT_SET` before a deployment is created.
- `cancelDeployment` of a completed deployment returns it unchanged.
- Deploys only read Git, so read-only repositories can deploy.
- Unlinking a project cancels its deployments, revokes their tokens and deletes all deploy data.

New error codes:

| Code | Message |
| --- | --- |
| `DEPLOY_CONFIG_INVALID` | The deploy configuration is not valid. |
| `DEPLOY_CONFIG_CHANGED` | The deploy configuration changed. Reload it and try again. |
| `DEPLOY_NOT_CONFIGURED` | Add a deploy configuration for this repository first. |
| `DEPLOY_ACCOUNT_NOT_SET` | Add a Cloudflare account and token in Settings first. |
| `DEPLOY_TOKEN_INVALID` | Cloudflare did not accept the deploy token. |

## Agent tools

The `tempo` MCP server (01) adds four tools. They act on the workspace's project, like the issue tools (09), and follow the same session, run and profile rules. Tool names match profile patterns as `<name>`, `tempo.<name>`, `mcp__tempo__<name>` and `mcp:tempo:<name>`.

| Tool | Input | Result | Mutates |
| --- | --- | --- | --- |
| `deploy_app` | `{target}` | `Deployment` | yes |
| `list_deployments` | `{target?, offset?}` | `{items: Deployment[], nextOffset}` | no |
| `get_deployment` | `{deploymentId}` | `Deployment` | no |
| `get_deployment_log` | `{deploymentId}` | `{text, truncated}` | no |

- `deploy_app` uses trigger `agent`, the workspace's branch and the workspace ID. Read-only runs fail with `FORBIDDEN`.
- `get_deployment_log` returns at most the last 64 KiB of the log, with `truncated: true` when it cut text.
- `ToolReq.op` adds the four names.

## Clients

- Both clients add a **Deploys** tab to native repositories (search key `tab=deploys`, `deployment=<deploymentId>`).
- The tab lists deployments (number, target, stage, branch, short SHA, trigger, status/conclusion, time) with a target filter and paging, and a **Deploy** action that picks a target and, for a target without `branch`, a branch.
- Deployment detail shows status, conclusion, exit code, duration, summary and trigger; **Cancel** for unfinished deployments; **Redeploy** for completed deployments; and the log as plain text.
- With a rollout, the detail also shows the phase, the time the canary ends, and each Worker's version ID, previous version ID, share and Cloudflare deployment ID; and **Roll back** when `rollbackDeployment` would accept it.
- A **Configuration** section shows the current YAML with its revision. Save shows `DEPLOY_CONFIG_INVALID` details in place and `DEPLOY_CONFIG_CHANGED` with a reload action.
- Settings adds a **Cloudflare** section: account ID, a write-only token field, Save, Remove, and whether a token is set. `DEPLOY_TOKEN_INVALID` shows in place.
- Both clients use shared generated protocol types. No new dependency.

## Deployment and validation

Bind `APP_DEPLOY` to `AppDeployDO` (SQLite storage) in local, test and deploy configs. No new Worker secret or image. Deploy containers count toward the container instance limits of `WorkspaceDO`.

Required verification: configuration validation and revision conflicts; permission mapping and missing groups; token mint, storage, redaction and revocation (including retry and the cancel path); admission and supersede; stale and late results; timeouts and lost containers; auto trigger after CI success and without CI; agent tool rules (target flag, branch, read-only run); egress (placeholder swap only for `api.cloudflare.com`, refusal elsewhere, receive-pack blocked); web and Mac flows. Live Cloudflare acceptance (real token mint, an Alchemy v2 deploy and a `cloudflare.config.ts` deploy) is separate from mocked local tests.
