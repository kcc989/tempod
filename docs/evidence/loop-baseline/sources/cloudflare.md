# Cloudflare primitives for Tempo's deploy → observe → fix loop

Research date 2026-10-15. Sources are raw Markdown from developers.cloudflare.com (`index.md` or `Accept: text/markdown`), fetched with curl. WebFetch could not resolve the host. Each "Updated" date is the page's own "Last updated" stamp. API permission lists come from each method's "Accepted Permissions (at least one required)" block.

## What Tempo has today (from the repo)

- **Deploys run a CLI in a container.** `docs/12 App Deploy.md` runs `alchemy deploy --stage <stage> --yes` or `cf deploy --mode <stage>` in a deploy container. A deployment is just "the command exited 0". Tempo stores no Cloudflare version ID or deployment ID.
- **Rollback is a full redeploy.** The spec says: "Rollback to an earlier deployment as its own action" is out of scope; "**Redeploy** … is the rollback path". That rebuilds an old SHA and takes minutes.
- **Lifecycle events are out of scope.** Tempo has no post-deploy health signal and no production-error ingestion.
- **Code under `apps/` and `packages/` makes three kinds of Cloudflare API call:**
  - `tokens/permission_groups`
  - token mint (`POST …/tokens`)
  - token revoke (`DELETE …/tokens/<id>`)
  
  All three are in `apps/tempo/src/deploy/cloudflare.ts`. There are no calls to `workers/scripts/*/versions`, `/deployments`, `/tails` or `observability/telemetry`. There is no `analytics_engine_datasets`, `tail_consumers`, `version_metadata` or `workflows` binding, and no `WorkflowEntrypoint`. The only hits for these names are in the generated `apps/tempo/worker-runtime.d.ts` (workerd 1.20261006.1).
- **Tempo's own Worker logs.** `wrangler.jsonc` and `scripts/deploy-worker.ts` set `observability.enabled: true` and `invocation_logs: false`, and `redact_query_string: true` in the deploy config (05; IMPLEMENTATION_NOTES).
- **Minted token permissions.** Permission `workers` grants only `Workers Scripts Write` and `Account Settings Read` (12, Permissions). It has no Tail, Observability or Analytics scope.
- **Friction codes.** These are defined in `docs/evidence/loop-baseline/label-prompt.md`. DIRECTION is read as the "direction" half of PLAN_VERBOSE (README finding). EXIT_GITHUB and EXIT_CF_DASHBOARD are not defined in the repo; they are read here as "user has to leave Tempo for GitHub / for the Cloudflare dashboard". The baseline notes: "No production errors appear in the logs. The 'production error → fix' step has no baseline."

---

## 1. Workers Versions & Deployments

### Endpoints

All endpoints are under `https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/scripts/{script_name}`. The Read permission set is `Workers Tail Read` / `Workers Scripts Read` / `Workers Scripts Write`, plus admin and editor roles. The Write set is `Workers Scripts Write`, `Workers Admin` or `Workers Editor`.

| Endpoint | Purpose | Token permissions | Source |
|---|---|---|---|
| `POST /versions` (multipart: `metadata` + modules) | Upload a version without deploying it. `metadata.main_module` is required (ES modules only). Optional query `bindings_inherit=strict`. | Write set, or `Individual Workers Admin/Editor` | [Upload Version](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/) |
| `GET /versions` (`deployable`, `page`, `per_page`) | List versions. `deployable=true` "Only return versions that can be used in a deployment. Ignores pagination." | Read set | [List Versions](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/list/) |
| `GET /versions/{version_id}` | Get one version. The response has `metadata.hasPreview`. | Read set | same |
| `POST /deployments` (query `force`) | Body `{strategy:"percentage", versions:[{version_id, percentage}], annotations?}`. Percentages must total 100; each is 0.01–100. `force=true` overrides blocks "such [as] rolling back to an older version when a secret has changed". | Write set | [Create Deployment](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create/) |
| `GET /deployments`, `GET /deployments/{id}` | List or get deployments. Fields: `id`, `created_on`, `source`, `strategy`, `versions[]`, `annotations`. | Read set | same |
| `DELETE /deployments/{id}` | Delete a deployment. | `Workers Scripts Write` / `Workers Admin` / `Individual Workers Admin/Editor` | [Delete Deployment](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/delete/) |

### Annotations

| Object | Annotations |
|---|---|
| Version | `workers/message` (≤1000 B)<br>`workers/tag` (≤100 B)<br>`workers/alias` (≤63)<br>`workers/commit_sha` (≤64)<br>`workers/pull_request_number` (≤20)<br>`workers/pull_request_title` (≤512)<br>`workers/pull_request_url` (≤512)<br>`workers/repository_url` (≤512) |
| Deployment | `workers/message` (≤1000 B)<br>`workers/triggered_by` |

Source: the API pages above.

### Facts and limits

| Fact | Source (page date) |
|---|---|
| A version captures code, assets, bindings and compat settings. KV, R2, DO and D1 state are not versioned. | [Versions & deployments](https://developers.cloudflare.com/workers/versions-and-deployments/) (Sep 22, 2026) |
| A deployment holds 1 version, or 2 for a split. `wrangler deploy`, Workers Builds and the Script Upload API create a version and deploy it at 100%. | same |
| You can deploy only the last 100 uploaded versions. The first upload must be `wrangler deploy`. Service-worker syntax is unsupported. Durable Object class lifecycle changes (`exports` / `migrations`) cannot go through `versions upload`; they need `wrangler deploy`. | [Deployment management](https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/) (Jul 15, 2026) |
| Rollback creates a new deployment at 100%. It works from a split too. You can roll back only to the 100 most recent versions. It is refused across a DO lifecycle change, or if a bound R2, KV or queue resource was deleted. Bound resources are not reverted. | [Rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) (Jul 15, 2026) |
| `wrangler rollback [VERSION_ID]` defaults to the version uploaded before the latest. | [wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/) (Oct 9, 2026) |
| Gradual deploys need Wrangler ≥3.40.0. Versions before 3.73.0 need `--x-versions`. Logpush `ScriptVersion {id,message,tag}` must be added via the Logpush API. | [Gradual deployments](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/) (Jul 3, 2026) |
| With Durable Objects, each DO is pinned to one version per deployment. If the order is kept and the percentage only grows, a DO does not flip back. | [With Durable Objects](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/) (Jul 15, 2026) |
| Version affinity: header `Cloudflare-Workers-Version-Key: <key>` is hashed to a version deterministically. It can be set with a Transform Rule (zone routes only, not `*.workers.dev`). | [Version affinity](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/version-affinity/) (Jul 3, 2026) |
| Version override: `Cloudflare-Workers-Version-Overrides: <worker-name>="<version-uuid>"` (an RFC 8941 dictionary). The version must be in the current deployment; 0% is allowed. Bad values fall back to the percentages silently. It works through `fetch()` service bindings, not RPC. | [Version overrides](https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/) (Jul 3, 2026) |
| Version URLs (formerly "preview URLs") are `<version-prefix>-<worker>.<subdomain>.workers.dev`, with alias form `<alias>-<worker>…`. Config key: `preview_urls`. They are public unless Access protects them. Only the 1000 most recent aliases are kept. **Not generated for Workers that implement a DO (incl. Containers/Sandbox).** **No Workers Logs, tail or Logpush for Version URLs.** | [Version URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/) (Sep 22, 2026) |
| **Workers Previews** (new): `wrangler preview [--name] [--tag] [--message] [--json]`. Needs Wrangler ≥4.135.0. Each branch gets isolated settings and auto-provisioned DO namespaces and container instances. It has a Preview URL (latest) and a Deployment URL (immutable). Limits: 100/500 previews per Worker (Free/Paid), 100 deployments per preview. Cloudflare recommends Previews over Version URLs for PR testing. | [Previews](https://developers.cloudflare.com/workers/previews/) (Sep 24, 2026), [Compare workflows](https://developers.cloudflare.com/workers/previews/compare-workflows/) (Sep 22, 2026) |
| CLI commands:<br>• `wrangler versions upload --tag --message --preview-alias --secrets-file --strict`<br>• `wrangler versions deploy <id>@<pct>% <id>@<pct>% -y [--message] [--version-tag]`<br>• `deployments list`, `deployments status` | [wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/) |
| Version metadata binding `version_metadata: {binding}` gives `{id, tag, timestamp}` at runtime. | [Version metadata](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/) (Jul 3, 2026) |

### (a) What it lets Tempo do

- **Record the Cloudflare version and deployment.** After the deploy command, `AppDeployDO` (which already holds the minted token) can call `GET /deployments` and store the active `version_id` per Tempo deployment. Today Tempo only knows exit code 0.
- **One-action rollback.** `POST /deployments {versions:[{prev, 100}]}` takes seconds and needs no container, build or new SHA. This would replace "Redeploy is the rollback path".
- **Gradual promotion from Tempo.** Steps of `[{new, p}, {old, 100-p}]`, a smoke test at 0% via the override header, and abort by rollback.
- **Traceability.** Writing `workers/commit_sha`, `workers/message` and `workers/triggered_by` (e.g. `tempo-deploy-<number>`) links Cloudflare versions to Tempo deployments and SHAs.
- **Preview targets.** `wrangler preview` gives each workspace branch an isolated URL, including DO and container apps. Version URLs cannot, because Tempo-style apps use DOs.

**Caveat (blocking).** The current deploy commands deploy at 100% immediately. A true gradual deploy needs the tool to upload a version only. It is UNVERIFIED that `alchemy deploy` or `cf deploy` can do that; I did not check their docs. The fallback is that, right after the CLI deploys, Tempo re-splits to `[{old, 100-p},{new, p}]`. That leaves a short 100% window, so it is not a true canary. A spec decision is needed (rule 1).

**Permissions.** The `workers` permission already includes `Workers Scripts Write`, which covers every endpoint above. Rollback needs a token at rollback time, so Tempo must mint one for the rollback action as well. Version upload and rollback are refused across DO lifecycle changes and deleted bindings; that error must be surfaced, and `force` is available.

### (b) Friction reduced

- **VERIFY:** version-pinned smoke test and Preview URL per branch.
- **EXIT_CF_DASHBOARD:** rollback, promote and the version list happen in Tempo.
- **UNCLEAR_IMPL:** a deployment shows the exact live version, SHA and message.
- **CF_PERMS:** no new scope needed for this part.

---

## 2. Workers Observability, Tail Workers, Logpush

### Endpoints

| Endpoint / binding | Purpose | Token permissions | Source |
|---|---|---|---|
| `POST /accounts/{id}/workers/observability/telemetry/query` | Body: `queryId`, `timeframe{from,to}` (ms), `view` (`events`, `calculations`, `invocations`, `requests`, `traces`, `agents`), `parameters{calculations, filters, groupBys, needle{value,isRegex,matchCase}, …}`, `limit` ≤2000, cursor `offset`, `dry`. Filter keys include `$metadata.service`, `$metadata.error`, `$metadata.trigger`. Results carry `scriptVersion{id,message,tag}`. | **`Workers Observability Write`** (the only listed group) | [Query API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/) |
| `POST …/telemetry/keys`, `…/telemetry/values` | Discover fields and values. | `Workers Observability Write` | API reference (same section) |
| `POST …/telemetry/live-tail`, `…/live-tail/heartbeat` | "Prepare websocket server for live tail". | `Workers Observability Write` | [Live tail](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/live_tail/) |
| `GET/POST …/observability/queries`, `…/destinations` | Saved queries, export destinations. | not checked | [Observability API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/) |
| `POST /accounts/{id}/workers/scripts/{name}/tails` → `{id, url, expires_at}`; `GET`, `DELETE …/tails/{id}` | Legacy `wrangler tail` WebSocket. | `Workers Tail Read` / `Workers Scripts Write` / admin / editor | [Start Worker Tail](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/tail/methods/create/) |
| Producer config `tail_consumers: [{service}]`; consumer `export default { tail(events, env, ctx) }` | Tail Worker. | (deploy-time) | [Tail Workers](https://developers.cloudflare.com/workers/observability/logs/tail-workers/) (Oct 2, 2026) |
| Logpush job: `POST /accounts/{id}/logpush/jobs`, dataset `workers_trace_events`; producer sets `logpush: true` | Export trace events. | Account `Logs Edit` | [Workers Logpush](https://developers.cloudflare.com/workers/observability/logs/logpush/) (Oct 12, 2026) |

`Workers Observability Read` is UNVERIFIED. It does not appear in the API reference or in the [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) page (Oct 12, 2026), and the query endpoint lists only Write. The `Individual Workers *` names appear in API "Accepted Permissions" lists but not on the token permissions page. Whether they are mintable token groups is UNVERIFIED.

### TraceItem shape (Tail handler)

**From the [Tail Handler doc](https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/) (Jun 15, 2026):**

- Item fields: `scriptName`, `event` (fetch: `request{cf, headers, method, url}` + `response{status}`), `eventTimestamp`, `logs[{timestamp, level, message}]`, `exceptions[{timestamp, name, message}]`, `outcome`.
- `outcome` values: `unknown`, `ok`, `exception`, `exceededCpu`, `exceededMemory`, `scriptNotFound`, `canceled`, `responseStreamDisconnected`.
- Headers and URL are redacted by default; `getUnredacted()` returns the raw values.

**Only in the generated workerd types (`apps/tempo/worker-runtime.d.ts`, workerd 1.20261006.1), not on the doc page:**

- `scriptVersion?: {id, tag?, message?}`
- `exceptions[].stack?`
- `cpuTime`, `wallTime`, `truncated`
- `entrypoint`, `durableObjectId`, `preview`, `scriptTags`, `executionModel`, `diagnosticsChannelEvents`

Treat these as verified from the runtime types but not from a docs page.

### Workers Issues (new, directly relevant)

| Fact | Source |
|---|---|
| Enable with `observability.issues.enabled: true` (Wrangler ≥4.134.0) or `worker.observability.issues.enabled` in `cloudflare.config.ts`. It groups uncaught exceptions, failed invocations, 5xx responses and error logs into issues. Each occurrence has the stack, related logs and traces, **the Worker version**, and request details. | [Issues](https://developers.cloudflare.com/workers/observability/issues/) (Oct 12, 2026), [Investigate](https://developers.cloudflare.com/workers/observability/issues/investigate/) (Sep 30, 2026) |
| Automations: an occurrence threshold or a recurrence after inactivity sends to destinations. Destination types: coding agent (Claude Code routine, Cursor, Devin), **generic webhook** (HTTPS + secret or mTLS, Notifications webhook payload), chat, or incident tool. Up to 3 hand-off attempts. 50 automations per account. Free in open beta. | [Automations](https://developers.cloudflare.com/workers/observability/issues/automations/) (Oct 10, 2026) |
| Configured "in the dashboard or with the Cloudflare CLI (`cf`)". I found **no Issues or automation REST endpoint** in the Workers API reference index. | API index at [/api/resources/workers/](https://developers.cloudflare.com/api/resources/workers/) |

### Limits and pricing

| Item | Value | Source |
|---|---|---|
| Workers Logs retention | 3 days (Free), 7 days (Paid) | [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) (Oct 12, 2026) |
| Workers Logs volume | 5B logs/account/day, then 1% sampling. 256 KB max per log, truncated beyond that with `$cloudflare.truncated`. | same |
| Workers Logs price | Free: 200k/day. Paid: 20M/month included, then $0.60/M. | same |
| Pricing change | **From Dec 1, 2026** Workers Logs, Traces and Issues move to shared Observability pricing. Paid: 50 GB ingestion and 10 GB-month storage included, then $0.25/GB and $0.10/GB-month. Free: 0.5 GB/day, 7-day retention. | [Observability pricing](https://developers.cloudflare.com/observability/pricing/) (Oct 15, 2026), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) (Oct 2, 2026) |
| Real-time logs / `wrangler tail` | Max 10 concurrent clients per Worker. Samples under high load. Filters: `--status`, `--version-id`, `--search`, … | [Real-time logs](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/) (Jun 25, 2026), [wrangler tail](https://developers.cloudflare.com/workers/wrangler/commands/workers/) |
| Tail Workers | Paid/Enterprise only. Billed by CPU time. | [Tail Workers](https://developers.cloudflare.com/workers/observability/logs/tail-workers/) |
| Logpush | Paid only. 10M/month included, then $0.05/M. Logs and exceptions together are truncated at 16,384 characters. | [Logpush](https://developers.cloudflare.com/workers/observability/logs/logpush/), [pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Source maps | `upload_source_maps: true` gives original stacks; it is needed for useful Issues stacks. | [Source maps](https://developers.cloudflare.com/workers/observability/source-maps/) (Oct 12, 2026) |
| Previews observability | Previews have separate logs, traces and `tail_consumers` from production. | [Previews test and debug](https://developers.cloudflare.com/workers/previews/test-and-debug/) (Oct 10, 2026) |

### (a) What it lets Tempo do

**Post-deploy health gate.** After a deploy, or at each gradual step, `AppDeployDO` queries `telemetry/query` with `view:"calculations"`. It counts `$metadata.error` or outcome≠ok, grouped by `scriptVersion.id`, and compares new against old to decide promote or rollback. Today Tempo has no signal after exit code 0.

**Production error → agent session.** There are three paths, ordered by how little Tempo has to build:

1. **Issues generic webhook → a Tempo ingest route → a new agent session.** Seeded with stack, version and logs, and mapped by `scriptVersion` → Tempo deployment → SHA. Cloudflare does the grouping. The automation has to be set up in the dashboard or with the `cf` CLI; I found no REST API.
2. **Polling `telemetry/query`** for new errors per deployed script, from a DO alarm. This is pure REST, so the token is the only setup.
3. **A Tail Worker** that Tempo injects as a `tail_consumers` entry. This changes the owner's app config, which conflicts with "owner-approved deploy configuration".

**Agent tools.** `get_deployment_errors` / `query_app_logs` could map to `telemetry/query`, so agents stop asking the user to paste dashboard logs.

**Constraints.**

- The minted token lacks `Workers Observability Write`. The spec's permission table (12) and the master-token requirements would need a new `observability` permission (rule 1/16).
- The webhook secret for Issues is a credential. It belongs in CredentialDO (rule 9).
- Issue payloads may contain user data. That needs a redaction decision before storing it in `events`.

### (b) Friction reduced

- **VERIFY:** health of the live version, with real errors.
- **UNCLEAR_IMPL:** an agent sees prod behaviour of the version it shipped.
- **EXIT_CF_DASHBOARD:** logs and errors appear in Tempo.
- **ACCESS_UNAWARE:** an explicit agent tool for logs.
- **CF_PERMS:** adds a scope, so friction goes up unless minted automatically.

---

## 3. Workers Analytics Engine

| Item | Value | Source (date) |
|---|---|---|
| Binding | `analytics_engine_datasets: [{binding, dataset}]`. The dataset is auto-created on first write. | [Get started](https://developers.cloudflare.com/analytics/analytics-engine/get-started/) (Apr 23, 2026) |
| Write API | `env.X.writeDataPoint({blobs: string[], doubles: number[], indexes: [string]})`. Not awaited. Exactly 1 index; more drops the point. | same |
| SQL API | `POST https://api.cloudflare.com/client/v4/accounts/{id}/analytics_engine/sql` with the SQL as body. Use `_sample_interval` for sampled aggregates. Also queryable via the Analytics SQL API as `events.analyticsEngine.<DATASET>`. | [SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/) (Oct 2, 2026) |
| Token | Account › **Account Analytics › Read** | same; [Permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) |
| Limits | 20 blobs, 20 doubles and 1 index per point. Blobs ≤16 KB per point. Index ≤96 B. 250 points per invocation. | [Limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/) (Apr 23, 2026) |
| Retention | 3 months | same |
| Price | Paid: 10M points/month (+$0.25/M) and 1M queries/month (+$1/M). Free: 100k points/day and 10k queries/day. **"Currently, you will not be billed."** | [Pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/) (Apr 23, 2026) |
| Version tagging | The documented pattern is `version_metadata` + `writeDataPoint({indexes:[versionId]})`. A Tail Worker can also write per-outcome points. | [Version metadata](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/), [Tail Workers](https://developers.cloudflare.com/workers/observability/logs/tail-workers/) |

### (a) What it lets Tempo do

- **Owner apps: per-version counters with 3-month retention.** Analytics Engine keeps 3 months, against 3–7 days for Workers Logs, which allows release-over-release comparison.
- **Owner apps: business metrics as a deploy gate.** Requests, errors and latency per `versionId` can gate a canary.
- **Owner apps: only with app instrumentation.** The app must include a binding and code. Tempo can only suggest that, or inject it through a Tail Worker.
- **Tempo itself: cheap metrics.** Deploy durations, agent turn metrics and CI times could go here instead of SQLite rows. That is a stack addition (rule 11).
- **Overlap.** Most error-rate gating is already covered by §2 `telemetry/query` with no app change. Analytics Engine is second priority.

### (b) Friction reduced

- **VERIFY:** quantitative before and after.
- **UNCLEAR_IMPL:** charts per version.
- **CF_PERMS / STACK:** increased. It needs the new `Account Analytics Read` group and a new binding.

---

## 4. Cloudflare Workflows

| Item | Value | Source (date) |
|---|---|---|
| Class | `class X extends WorkflowEntrypoint { run(event, step) }`. Binding `workflows: [{name, binding, class_name, limits?, default_retention?}]`. | [Workers API](https://developers.cloudflare.com/workflows/build/workers-api/) (Oct 12, 2026) |
| `step.do` | `step.do(name, config?, cb, rollbackOptions?)` with `config = {retries:{limit, delay, backoff:'constant'\|'linear'\|'exponential'}, timeout}`. **Default `{limit:5, delay:10000, backoff:'exponential'}, timeout '10 minutes'`.** `NonRetryableError` stops retries. `rollbackOptions.rollback` is a compensating action for a step that already succeeded. | same; [Sleeping and retrying](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/) (Sep 24, 2026) |
| Waits | `step.sleep(name, duration)` / `sleepUntil` (≤365 days; not counted as a step). `step.waitForEvent(name, {type, timeout})`: default timeout 24 h; type ≤100 chars, `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`. | [Workers API](https://developers.cloudflare.com/workflows/build/workers-api/) |
| Instance API | `create({id?, params})`, `createBatch`, `get(id)`, and on an instance: `status()`, `pause`, `resume`, `restart({from:{name,count}})`, `terminate`, `delete`, `sendEvent({type,payload})`, `subscribe({cursor, filter})`. Status values: `queued`, `running`, `paused`, `errored`, `terminated`, `complete`, `waiting`, `waitingForPause`, `unknown`, plus a `rollback{outcome,error}` field. | same |
| REST | Base: `/accounts/{id}/workflows/{name}/instances`. Methods: POST (create), GET (list/get), `PATCH …/{instance_id}/status`, `POST …/{instance_id}/events/{event_type}`, `GET …/step`. Event send needs `Workers Scripts Write`. | [Workflows API](https://developers.cloudflare.com/api/resources/workflows/) |
| Limits (Paid) | 30 s CPU per step by default, up to 5 min; wall time unlimited.<br>10,000 steps by default, up to 25,000.<br>1 MiB per step result or event.<br>1 GB state per instance.<br>50,000 concurrent instances.<br>Completed instances retained 30 days (Free: 3).<br>Instance ID ≤100 characters.<br>10,000 retries per step. | [Limits](https://developers.cloudflare.com/workflows/reference/limits/) (Sep 21, 2026) |
| Rules | Steps must be idempotent. No state outside steps. Name steps deterministically. Keep timeouts ≤30 min. | [Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/) (Oct 8, 2026) |
| Price | Workers CPU and requests, plus storage ($0.20/GB-month after 1 included) and steps (500k/month included, then $0.80 per 100k). Step and storage billing has applied since Aug 10, 2026. | [Pricing](https://developers.cloudflare.com/workflows/reference/pricing/) (Sep 21, 2026) |
| Previews | Preview Workers use existing (production) Workflows; there are no per-preview Workflows. | [Previews](https://developers.cloudflare.com/workers/previews/) |

### (a) What it lets Tempo do

The loop is long-running and has pauses. A Workflow per Tempo deployment could run:

1. mint token
2. run the container (via DO RPC)
3. record the version
4. split 10%
5. `step.sleep('10 minutes')`
6. telemetry gate
7. 50% → 100%, or rollback
8. revoke token

Steps 1–8 use per-step retries and compensation: `rollback` revokes the token or restores the old version. `waitForEvent('approve-promote')` gives owner or agent approval gates, and `waitForEvent('ci-success')` gives merge-to-deploy.

Today `AppDeployDO` does the same work with SQLite state plus alarms (12: the 30 s revoke retry, timeouts). That already satisfies rule 5 (idempotent steps). So Workflows is **not required**. It mainly removes hand-written alarm and state-machine code, and gives a step-history view and `restart({from})`.

**Constraints.**

- It is a new platform primitive outside the spec's named stack (CLAUDE rule 11, "ask before adding"), so it needs owner approval.
- Rule 4 and the DO-centric design would need the spec to say who owns the deployment state.
- Test support with `@cloudflare/vitest-pool-workers` is UNVERIFIED. The doc names `@cloudflare/vitest-plugin` ≥1.3.0 for `ctx.exports`, and IMPLEMENTATION_NOTES S-5 says the repo pins the deprecated pool package.

### (b) Friction reduced

- **UNCLEAR_IMPL:** step history shows exactly what the pipeline did.
- **VERIFY:** gates are explicit steps.
- **DIRECTION:** approval gates via `waitForEvent`.
- **STACK:** increased (new primitive).
- **CI_SLOW:** none directly.

---

## Summary matrix

| Capability | New for Tempo | Minted-token scope to add | Friction reduced | Priority |
|---|---|---|---|---|
| Versions/Deployments API (record version, one-action rollback, % split, overrides) | Yes. Today rollback = rebuild an old SHA. | None (`Workers Scripts Write` already granted) | VERIFY, EXIT_CF_DASHBOARD, UNCLEAR_IMPL | 1 |
| `wrangler preview` per branch | Yes. Isolated preview incl. DO/containers. | None (UNVERIFIED that Alchemy or `cf` expose it) | VERIFY, EXIT_GITHUB (PR review link in Tempo) | 2 |
| Telemetry query API (health gate, agent log tool) | Yes | `Workers Observability Write` (Read variant UNVERIFIED) | VERIFY, UNCLEAR_IMPL, ACCESS_UNAWARE, EXIT_CF_DASHBOARD; raises CF_PERMS | 1 |
| Workers Issues → webhook → agent session | Yes. Closes "prod error → fix". | None for the webhook. Setup is dashboard or `cf` CLI; no REST found. | VERIFY, EXIT_CF_DASHBOARD (after one-time setup) | 1 |
| Tail Worker / Logpush | Alternative ingest | Deploy-time config / `Logs Edit` | Same as above, with more config | 3 |
| Analytics Engine | Long-retention per-version metrics | `Account Analytics Read` | VERIFY; raises STACK, CF_PERMS | 3 |
| Workflows | Durable pipeline engine (replaces alarms) | `Workers Scripts Write` (REST events) | UNCLEAR_IMPL, DIRECTION; raises STACK | 3 (optional) |

API_KEYS, CI_SLOW and DESIGN_IGNORED are not materially affected by any of these.

## Spec questions to raise (rule 1)

1. Should deploys stop deploying at 100%? That means version upload, then Tempo-driven `POST /deployments`. Can the `alchemy` and `cf` tools upload a version only? (UNVERIFIED)
2. Add a "Rollback" action that is not a redeploy? This reverses 12's "not in this stage".
3. Add an `observability` DeployPermission (`Workers Observability Write`) and a new read-only token type for health checks and log tools outside a deploy?
4. Production-error ingestion: Issues webhook (needs a stored secret and dashboard setup) or REST polling? Where does issue data live, given the redaction rules?
5. Should Workflows be adopted (rule 11)? Or keep `AppDeployDO` alarms?
