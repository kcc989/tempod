# 13 Loop

Status: **Approved** on 2026-10-15 (Decisions log). The owner asked to start building on 2026-10-15. The friction-log week (`docs/evidence/friction-log/`) still sets the exit baseline; it runs before any loop feature is used for real work.

Tempo becomes the owner's command center to build and run apps on Cloudflare. This tab defines one closed loop and makes it measurable. It changes 12 (gradual deploys, rollback, deploy events) and extends 01, 04, 07 and 08. It adds no feature outside the loop (Kill list).

```
prompt → intent check → preview with proof → merge → deploy (gradual, one-action rollback) → observe → production error into a workspace session
```

## Evidence

From `docs/evidence/loop-baseline/` (README and LOOP.md). Rates are per 100 owner messages, Oct 5–15, 2026.

| Code | Rate | Loop step that causes it |
|---|---|---|
| DIRECTION | 10.7 | Prompt → work: the agent starts before it shares its reading of the intent |
| VERIFY | 8.8 | Preview: the owner checks by hand that it works and looks right |
| UNCLEAR_IMPL | 6.8 | Preview: the owner cannot tell what changed |
| STACK | 4.9 | Every session: the stack is restated |
| CI_SLOW | 4.1 | Merge |
| DESIGN_IGNORED | 3.4 | Preview: critique is lost between turns |
| CF_PERMS | 2.6 | Deploy |
| API_KEYS | 2.4 | Every session |
| ACCESS_UNAWARE | 1.7 | Every session: the agent does not know what it can use |

| Step | Median min | p90 min | Note |
|---|---|---|---|
| PR open → merge | 23.6 | 131.3 | 66 PRs, `tempod` |
| First CI run → green on final head | 12.9 | 53.6 | 47% of PRs had a failed run |
| Merge → next Worker version | 157.2 | 1,062.4 | Manual `wrangler`; always 100% at once |
| Production error → fix live | 10.7 | — | n = 1, outside Tempo, not seen in Tempo |
| Intent → preview | — | — | No event exists |

## Words

| Word | Meaning |
|---|---|
| Task | A change (08): the work that starts with a new owner prompt and ends with `tempo.change.ended` |
| Project profile | The facts about a project that the owner writes once: stack, services, credential names, checks, screens (L-ADR-3) |
| Capability manifest | What Tempo makes from the profile for one agent session: the exact list of what that agent may read, call and deploy. `TempoOutbound` enforces it (14). |
| Proof | The evidence an agent gives that a preview works and looks right (L-ADR-2) |
| Observe window | The time a new version runs at a traffic step before Tempo moves to the next step |

## First project

The loop is first proven on one new native (Artifacts) project, built with Tempo: a **smart todo list**. It uses the standard stack (00, D7) and is deployed with Alchemy v2 (12).

| Feature | Rule |
|---|---|
| Todos | Create, edit, complete, delete and order todos. Web UI at desktop and phone width. |
| MCP | The app is a remote MCP server. Agents (Claude, Codex and others) can list, create, update, complete and tag todos with MCP tools. |
| Smart tagging | When a todo is created or changed, Jev picks tags from the owner's tag list with one `choice` question per tag group, and says if a new tag is needed. |
| Background research | A todo can have a research job. It searches with the Cloudflare Web Search API (`env.AI.websearch`, no API key) and attaches the best results to the todo, ranked by Jev. |
| User | Only the owner (owner-confirmed 2026-10-15) |
| Durable Objects | The research job runs in a Durable Object, so the project exercises graceful Durable Object deploys (L-ADR-4). |

The owner confirmed the user, Jev, the web search API and OAuth sign-in for MCP (through Better Auth) on 2026-10-15. Tempo's own repo, `tempod`, joins the loop after the todo app meets the targets.

## Architecture decisions

### L-ADR-1. The intent check is a Tempo gate, not an agent feature

**Context.** 50 of 55 plan corrections were about direction, not length. Plan mode exists only in some agents: Claude and OpenCode `plan`, Codex `read-only`, Pi none (01, Agent profiles). The `ExitPlanMode` permission is Claude-only. ACP `elicitation` is forbidden by 02.

**Decision.**

1. A task with `origin: "prompt"` starts its session read-only, through the existing read-only path (08, Read-only).
2. Add the tool `propose_intent` to the `tempo` MCP server. Input: `goal`, `approach`, `not_doing`. Together they are at most 5 lines, each line at most 160 characters. The WorkspaceDO refuses a longer input with the tool error `Intent must be at most 5 lines.`, so the agent corrects it in the same turn.
3. The chat shows an intent card with two actions: **Confirm** (one click or ⌘↩) and **Correct** (a text field; sending it is the one action).
4. **Confirm** switches the session to write with `session/set_config_option` (category `mode`), or removes the profile's edit-tool deny list, and queues the turn `Intent confirmed. Do the work.`
5. **Correct** queues the correction as a user turn. The agent calls `propose_intent` again.
6. **Risk decides who confirms (owner-approved 2026-10-15).** Exact rules below. Jev (L-ADR-9) judges each intent with the profile and the session's manifest as state. It asks three questions: does the work open new permissions or capabilities; does it add a security risk; how hard is it to roll back. When all three are low, Tempo confirms the intent itself (`loop.intent.confirmed` with `by: "judge"`) and the work starts. The card stays in the chat, and **Correct** still works. When any one is high, or Jev does not answer, the owner confirms as in step 3.
7. The intent check runs once at the start of each task. The agent calls `propose_intent` again, and the session goes back to read-only, when it plans work outside the confirmed `goal`. That new intent is judged again.
8. The fixed prompt text that asks for the intent is given with the first turn of the task, as the run header is in 08.

**Not chosen.** Plan mode only (not the same for four agents). ACP elicitation (needs a change to 02, and SDK 1.8.0 support is not verified). A free-text plan (the length is not enforceable).

**Reduces.** DIRECTION.

**Exact rules (owner-approved 2026-10-15; these are what the code does).**

| Rule | Value |
| --- | --- |
| When | The first prompt of each chat (session) with no run. Each message is its own change in Tempo (08), so later prompts in the same chat do not ask again; the agent proposes again when its work leaves the confirmed goal. A first prompt that starts with `/go` skips the check for that chat; Tempo removes `/go` from the text. |
| Read-only | Before that turn's prompt, when the session's modes include `PLAN_MODE` of its agent (Claude and OpenCode `plan`, Codex `read-only`), Tempo sets that mode with `session.setMode` and keeps the mode it replaced. Pi has no such mode; its intent has `enforced: false` and relies on the instruction. |
| Instruction | One text block before the prompt, exact: `Before you change any file, call the tempo tool propose_intent with the goal, your approach and what you will not do, in at most 5 lines in total. Then end your turn. Do not change files until Tempo confirms the intent.` |
| Tool | `propose_intent {goal, approach, notDoing}`, each a nonempty string. All lines together at most 5, each line at most 160 characters. Errors (tool errors, exact): `Intent must be at most 5 lines.`, `Each line must be at most 160 characters.`, `There is no task waiting for an intent.` Listed only in sessions with no run. |
| Storage | WorkspaceDO table `intents`, one row per chat: `id`, `session_id` (unique), `change_id` (the change it was last proposed in), `item_id`, `status` (`awaiting`, `proposed`, `confirmed`, `corrected`), `goal`, `approach`, `not_doing`, `decided_by` (`owner`, `judge` or null), `judge_json`, `prior_mode_id`, `enforced`, `created_at`, `decided_at`. One `intent` item per chat, updated in place. |
| Judge | After each proposal, Jev (L-ADR-9) judges it with the branch and the project name as context. Low risk: Tempo confirms with `decided_by: "judge"`. Else the workspace's attention is `needs_input`. |
| Tool answer | `Tempo confirmed the intent. End your turn; Tempo starts the work next.` or `The owner will confirm or correct the intent. End your turn now.` |
| Confirm | `confirmIntent {workspaceId, intentId}`, or the judge. Sets `confirmed`, restores the prior mode, and queues the turn `Intent confirmed. Do the work.` in the same session and change. Writes `loop.intent.confirmed` with `by`. A second confirm does nothing. |
| Correct | `correctIntent {workspaceId, intentId, text}` (1–4,000 characters). Sets `corrected` and queues the text as a turn in the same change. The mode stays read-only. Writes `loop.intent.corrected`. The agent proposes again. |
| Re-propose | A call in a chat whose intent is `confirmed` sets it back to `proposed` and the mode back to read-only, and is judged again. |

### L-ADR-2. Proof is a stored object that Tempo checks, not a claim

**Decision.**

1. Add the tool `submit_proof` to the `tempo` MCP server. Input:
   - `summary`: what changed, at most 5 lines.
   - `screens`: one entry per changed screen: `{route, viewport: "desktop" | "phone", theme: "light" | "dark", image: path, recording?: path}`.
   - `checklist`: one entry per open checklist item: `{itemId, resolved: true, screen: index, note}`.
2. Images and recordings are published as artifacts (01, Artifacts) and linked from the proof. They stay readable while the workspace sleeps.
3. `checks` are not reported by the agent. When the proof is submitted, `tempod` runs the project profile's `checks` (L-ADR-3) itself and records each command, exit code and duration. The agent cannot change these results.
4. A proof is **complete** only when every changed screen has an image, every open checklist item is resolved, and every check exited 0. The preview pane shows the proof above the preview. An incomplete proof shows what is missing.
5. **Changed screens.** The profile has a `screens` map: `{route, files: [glob]}`. A route is changed when the branch diff touches one of its files. When a changed file is in no entry, the agent names the routes it changed, and the proof card says the list came from the agent.
6. **Checklist.** When the owner sends a message with design critique, Tempo shows **Add to checklist** on that message. Each item is stored on the workspace with `open` status, the message ID and the text. The next proof must resolve each open item. The owner can reopen an item with one action.

**Not chosen.** Proof as free Markdown (cannot be checked). A full MCP Apps proof panel (Kill list).

**Reduces.** VERIFY, UNCLEAR_IMPL, DESIGN_IGNORED.

**Exact rules (these are what the code does).**

| Rule | Value |
| --- | --- |
| Tool | `submit_proof {summary, screens, checklist}` on the `tempo` MCP server, in chats with no run. `summary`: at most 5 lines, each at most 160 characters. `screens`: 0–20 of `{route, viewport: "desktop" or "phone", theme: "light" or "dark", image, recording?}`; `image` and `recording` are paths the agent published with `publish_artifact` in this chat. `checklist`: 0–50 of `{itemId, note}`, each note at most 500 characters. |
| Tool errors | `Summary must be at most 5 lines.`, `Each line must be at most 160 characters.`, `Publish <path> with publish_artifact first.`, `Unknown checklist item <id>.` |
| Changed screens | The branch's changed files (`git.changes {scope: "branch"}`) are matched against each profile `screens[].files` glob (`*` within a path segment, `**` across segments). Each matched `route` must have at least one screen. |
| Checks | For each profile check, Tempo starts a script run (kind `run`, `scriptId` `check:<name>`, cwd `/workspace`, the check's timeout) and records its run ID on the proof. A check passes when its run exits 0. |
| Storage | WorkspaceDO table `proofs`: `id`, `session_id`, `change_id`, `item_id`, `summary`, `screens_json`, `checklist_json`, `checks_json`, `missing_json`, `complete`, `created_at`. One `proof` item per proof in the chat. |
| Complete | When every required route has a screen, every open checklist item is in `checklist`, and every check passed. Until the checks end, the proof is `checking`. `loop.proof.submitted` is written when the checks end, with `{proofId, complete}`. A proof's resolved checklist items become `resolved` only when the proof is complete. |
| Tool answer | `Tempo is running the checks. End your turn; the owner sees the proof when they finish.` |
| Checklist | WorkspaceDO table `checklist`: `id`, `text` (1–2,000 characters), `status` (`open` or `resolved`), `source_item_id`, `resolved_by` (proof ID or null), `created_at`. `addChecklistItem {workspaceId, itemId}` takes the text of that user message item. `reopenChecklistItem {workspaceId, checklistId}` sets it `open`. `WorkspaceDetail.checklist` lists all items. Each writes `loop.checklist.added` or `loop.checklist.reopened`. While items are open, each prompt carries one text block before the user's text: `Open design checklist:` and one line per item, `<id>: <text>`. |

### L-ADR-3. One project profile, given to every session

**Decision.** Each project has one profile. The owner edits it in Tempo, once. It is stored in the project's `AppDeployDO` with revisions, as the deploy configuration is (12), so one DO holds all owner-approved project configuration. It holds:

| Key | Holds |
|---|---|
| `stack` | Runtime, package manager, frameworks and libraries, with versions |
| `services` | Each external service: name, purpose, hosts, and the name of the credential (never a value) |
| `cloudflare` | A pointer to the deploy configuration (12), which names each target's Workers. The profile does not repeat them. |
| `checks` | The commands that prove a change: typecheck, lint, tests, build. Each has a timeout. |
| `screens` | Routes and the source files that change them (L-ADR-2) |
| `notes` | At most 40 lines of free text |

- Every session gets the profile as the first content block of its first turn, and the tool `get_project_profile`.
- The profile makes the session's capability manifest (14).
- The agent can propose a profile change with a proposal card, like `propose_agent_change` (08). Only the owner applies it.

**Reduces.** STACK, API_KEYS, ACCESS_UNAWARE.

**Exact rules (these are what the code does).**

The profile is YAML 1.2, parsed with the existing `yaml` package, at most 32 KiB. The owner edits it in the project's settings (web and Mac). It is not read from the repository.

```yaml
version: 1
stack:
  runtime: bun 1.3
  package_manager: bun
  frameworks: [TanStack Start, Effect v4]
  libraries: [drizzle-orm 0.45, better-auth 1.7]
services:
  - name: stripe
    purpose: Payments
    hosts: [api.stripe.com]
    credential: STRIPE_KEY
    methods: [GET, POST]
checks:
  - name: typecheck
    command: bun run typecheck
    timeout_minutes: 10
screens:
  - route: /todos
    files: ["src/routes/todos/**", "src/components/todo-*.tsx"]
notes: |
  Use Effect for errors. Keep UI copy short.
```

| Key | Rule |
| --- | --- |
| `version` | Required. Exactly `1`. |
| `stack` | Optional map. `runtime` and `package_manager`: strings of 1–100 characters. `frameworks` and `libraries`: lists of at most 30 strings of 1–100 characters. |
| `services` | Optional list of at most 20. `name` matches `^[a-z][a-z0-9-]{0,39}$`, unique. `purpose`: 1–200 characters. `hosts`: 1–20 host patterns (05). `credential`: optional environment secret name (`^[A-Z_][A-Z0-9_]*$`). `methods`: optional list of HTTP methods; empty means all. |
| `checks` | Optional list of at most 10. `name` matches `^[a-z][a-z0-9-]{0,39}$`, unique. `command`: 1–4,096 characters, run with `bash -lc` in `/workspace`. `timeout_minutes`: 1–30, default 10. |
| `screens` | Optional list of at most 50. `route` starts with `/`, at most 200 characters, unique. `files`: 1–20 glob patterns relative to the repository root. |
| `notes` | Optional string, at most 40 lines and 4 KiB. |

- A missing key, a wrong type or a broken rule fails with `PROFILE_INVALID`; its detail names the first problem, for example `services[0].hosts: 1 to 20 host patterns`. Unknown keys fail too.
- Each save makes a new revision, as the deploy configuration does (12). A save sends the revision it edited; a different current revision fails with `PROFILE_CHANGED`. The project's `AppDeployDO` keeps the newest 20 revisions. For a GitHub-linked project it stores only the profile.
- Server functions: `getProjectProfile {projectId}` → `ProjectProfile {projectId, revision (0 when never saved), source, updatedAt}`; `updateProjectProfile {projectId, source, revision}` → `ProjectProfile`.
- **Delivery.** On the first prompt of each chat, after the turn-summary rule and `prompts.general`, the WorkspaceDO adds one text block: `Project profile (revision <n>). Use this stack and these services; do not ask the owner to restate them.` followed by the profile source. With no saved profile it adds nothing. The `tempo` MCP tool `get_project_profile {}` returns the current source and revision.
- Error codes: `PROFILE_INVALID` (`The project profile is not valid.`) and `PROFILE_CHANGED` (`The project profile changed. Reload it and try again.`).

### L-ADR-4. Gradual deploys, also with Durable Objects

**Context.** Every deployment in the evidence went to 100% at once. 12 runs `alchemy deploy` or `cf deploy` at 100% and makes Redeploy the only rollback. The Versions API splits traffic and rolls back in seconds with `Workers Scripts Write`, which the minted token already has. Alchemy v2 (2.0.0-beta.81, `Worker.version.traffic`) can upload a version with `traffic: 0`, which does not change traffic, and forces Durable Object class migrations to 100%.

**Decision. This changes 12 (owner-approved 2026-10-15).**

1. **Upload.** A target with `rollout: gradual` (12) gets `TEMPO_DEPLOY_TRAFFIC=0`. The project's `alchemy.run.ts` passes it to each Worker's `version.traffic`, with `tag` = the commit SHA and `message` = `tempo-deploy-<number>`. Spike L-S1 confirms the same for `cf`.
2. **Record.** `AppDeployDO` reads each Worker's deployments with the minted token and stores the new `version_id` and the version that was at 100% before.
3. **Smoke test.** At the 10% step, Tempo calls the new version with `Cloudflare-Workers-Version-Overrides` on the target's smoke URLs. (The API refuses a 0% share, so the test runs at 10%.)
4. **Steps.** 10% for the observe window, then 100%. Each step is one `POST /deployments` with the new and old versions.
5. **Gate.** Between steps, Tempo checks for new Issues on the new version (L-ADR-5). A new Issue stops the rollout. When a rollback is possible (no migration deploy in between), Tempo rolls back with no owner action. Else it holds the rollout and asks the owner. This follows the owner's risk rule (L-ADR-1 step 6).
6. **Rollback** is one action in web and Mac: `POST /deployments` with the previous version at 100%. It needs no container and no build. Tempo mints a short token for it, as for a deployment.
7. **Match.** Tempo shows the Cloudflare deployment ID and version ID for each Tempo deployment (done-proof 2).
8. **Many Workers.** The target's `workers` list (12) names the Workers. Tempo moves them in list order at each step, and rolls back all of them together. 12, Gradual rollout has the exact steps.

**Durable Objects.**

| Change in the deploy | What Tempo does |
|---|---|
| DO code only (no class added, renamed or deleted) | Gradual, as above. Cloudflare pins each DO to one version for a deployment; Tempo only raises the new version's percentage and keeps the order of the versions, so no DO moves back during a rollout. |
| DO class migration (class added, renamed or deleted) | Alchemy deploys at 100%. Cloudflare refuses a rollback across it. Tempo splits the deploy: first a **migration deploy** that holds only the migration and code that does not use it yet, then the code that uses it as a normal gradual deploy. Rollback can then go back to the migration deploy. |
| DO SQLite schema change (Alchemy `withSqlMigrations`) | A rollback runs old code on the new schema. The migration must add, never drop or rename, until the next deploy. A check in the profile's `checks` refuses a migration that drops or renames. |
| D1, KV or R2 data | Not reverted by a rollback. The same add-only rule applies to D1 migrations. |

- Tempo shows "no rollback past this deploy" on a migration deploy.
- When the agent's change holds a DO class migration and the code that uses it, the proof step tells the agent to split it into two tasks.

**Reduces.** VERIFY, UNCLEAR_IMPL, CF_PERMS, EXIT_CF_DASHBOARD.

### L-ADR-5. Observe through Workers Issues webhooks

**Decision (owner-approved 2026-10-15).**

1. Each loop project's Workers enable `observability.issues.enabled` and `upload_source_maps`, in `alchemy.run.ts`.
2. For each project, Tempo makes a webhook URL on `APP_HOST`, `/api/hooks/cloudflare-issues/<projectId>`, and a random secret. The secret is stored in the owner's `CredentialDO` under `issues.<projectId>.webhook_secret`. Tempo shows the URL once and the steps to add a generic webhook destination and an automation (occurrence threshold 1) in the dashboard or with `cf`. Tempo cannot do this setup by API: Cloudflare documents no REST API for automations.
3. Tempo accepts a webhook only when its `cf-webhook-auth` header equals the secret, compared in constant time. Else 404.
4. `AppDeployDO` stores, per Issue: the Worker, the version, counts, first and last time, the request method and path without query, and one redacted stack. It stores no headers, bodies or logs. It keeps them for 90 days.
5. Tempo maps the version to its Tempo deployment and commit range.
6. Spike L-S2 records the exact webhook payload for an Issue. Until it passes, the stored fields above are the target, not a promise.

**Not chosen.** Polling the telemetry query API (needs a new `Workers Observability Write` permission). Tail Workers (change the app's configuration). Analytics Engine (needs app code).

**Reduces.** VERIFY, EXIT_CF_DASHBOARD.

### L-ADR-6. A production error becomes a workspace session

**Decision (owner-approved 2026-10-15).**

1. A new Issue writes `prod.error.seen` and shows an error card in the project with **Start fix**.
2. The deploy configuration key `auto_fix` (12, default off), shown as **Start fixes on their own**, decides what happens next:
   - Off: the owner selects **Start fix**. That one action creates the workspace and starts the agent.
   - On: Tempo creates the workspace and starts the agent with no owner action.
3. The workspace is on a new branch from the deployment's branch (12, Production errors has the exact rules). Its first prompt holds: the Issue, counts, first and last time, the Tempo deployment, the Cloudflare version, the redacted stack, and the commit range from the previous version.
4. The fix goes through the same loop: intent check, proof, merge, deploy. When the new version runs for the observe window with no new occurrence of the Issue, Tempo writes `prod.error.fixed`.

**Reduces.** VERIFY, EXIT_CF_DASHBOARD. It creates the "production error → fix" step that has no baseline today.

### L-ADR-7. Every loop step writes a timestamped event

Each step writes one lifecycle event (08), so loop times come from the event log alone (done-proof 1). New types:

| Type | Source | When |
|---|---|---|
| `loop.intent.proposed` | `agent` | `propose_intent` stored |
| `loop.intent.confirmed` | `tempo` | Owner confirms |
| `loop.intent.corrected` | `tempo` | Owner corrects |
| `loop.proof.submitted` | `agent` | `submit_proof` stored, with `complete: boolean` |
| `loop.checklist.added`, `loop.checklist.reopened` | `tempo` | Owner action |
| `tempo.pr.merged` | `tempo` | Merge seen |
| `deploy.version.uploaded`, `deploy.traffic.changed`, `deploy.rolled_back` | `tempo` | L-ADR-4; payload has Cloudflare version and deployment IDs |
| `prod.error.seen`, `prod.error.fixed` | `tempo` | L-ADR-5 and L-ADR-6 |

`getLoopReport {from, to}` returns, for each step, n, median and p90 from these events.

### L-ADR-8. Agents may call the Cloudflare API, inside the intent

**Decision (owner-approved 2026-10-15, details proposed).** An agent in a workspace may call `api.cloudflare.com`, for example to query a preview D1 database or to run `wrangler dev --remote`. A call is forwarded only when it is safe and matches the confirmed intent:

1. The agent sends `Authorization: Bearer tempo-placeholder`. `TempoOutbound` swaps it for a token that Tempo mints for the session from the manifest's `cloudflare` capability (14), as deploy mode does (12). The token never enters the container. It expires when the session ends.
2. `GET` requests to resources of this project pass.
3. A request that changes something passes only when all are true:
   - The resource belongs to this project (one of its Workers, databases, buckets or namespaces).
   - It is not a production target.
   - It is not on the hold list: delete a Worker, database, bucket, namespace, queue or token; change DNS, routes or a deployment's traffic.
   - It matches the task's confirmed intent, and it is safe. Jev (L-ADR-9) judges the request (method, path, resource) against the intent's `goal` and `approach`.
4. Anything else is held. The chat shows an approval card with the request and the reason. The owner allows it once or refuses it. The agent gets a 403 with `tempo: held for owner approval` until then.
5. Every Cloudflare call is in `egress_log` with the decision.

**Reduces.** CF_PERMS, ACCESS_UNAWARE.

### L-ADR-9. Jev judges safety and alignment

**Decision (owner-approved 2026-10-15).** Every safety and alignment check of the loop calls Jev, TypeSafe AI's System One model, directly through TypeSafe AI:

| Item | Value |
|---|---|
| Library | `@typesafe-ai/sdk` 0.7.0 (MIT), pinned. It has no dependencies and runs in the Worker. |
| Model | `jev-1.14.0` |
| Endpoint | `POST https://api.typesafe.ai/v1/systemone` (through the SDK) |
| Key | The owner's `CredentialDO`, key `typesafe.api_key`. It never enters a container, a log or an event. Server functions `getJudgeSettings {}` → `{keySet, updatedAt}`, `setJudgeKey {key}` and `deleteJudgeKey {}` (same output). Save checks the key with one Jev call; a refused key fails with `VALIDATION_FAILED`, detail `TypeSafe AI did not accept the key.` Settings has a **TypeSafe AI** section on web and Mac, next to Cloudflare, with a write-only key field. |
| Where it runs | The Worker and DOs only. Never in a container. |
| Timeout | 10 seconds per attempt, one retry. Measured on 2026-10-15 over 12 calls: median 0.7 s, p90 2.2 s, max 9.1 s. No answer counts as high risk: the owner decides. |
| Checks | Intent risk (L-ADR-1), Cloudflare API calls (L-ADR-8) |

- Each check stores the question ids, the answers and the model id on its event. It stores no state text beyond what the event already holds.
- The thresholds are in the question code, one per question: a `noul` at or above 0.5, or a `score` at or above the middle level, is high.
- Hook decisions in 08 keep using Clef. This tab does not change them.

## Targets (owner-approved 2026-10-15)

Times are from the events in L-ADR-7. Gaps of more than 30 minutes with no owner or agent activity are not counted.

| Step | From → to | Baseline | Target median | Target p90 |
|---|---|---|---|---|
| Intent shown | `tempo.change.created` → `loop.intent.proposed` | none | 1 min | 3 min |
| Intent agreed | `loop.intent.proposed` → `loop.intent.confirmed` | none | 1 correction or fewer per task | 2 corrections |
| Preview with proof | `loop.intent.confirmed` → first complete `loop.proof.submitted` | none | 20 min | 45 min |
| Proof → merge | complete proof → `tempo.pr.merged` | 23.6 / 131.3 (PR open → merge) | 15 min | 60 min |
| CI | first check run → green on final head | 12.9 / 53.6 | 6 min | 15 min |
| Merge → 100% live | `tempo.pr.merged` → last `deploy.traffic.changed` at 100% | 157.2 / 1,062.4 | 20 min | 30 min |
| Rollback | owner action → previous version at 100% | none | 30 s | 60 s |
| Error seen | first occurrence in Cloudflare → `prod.error.seen` | not seen | 3 min | 6 min |
| Error fixed | `prod.error.seen` → `prod.error.fixed` | 10.7 (n = 1, outside Tempo) | 60 min | 4 h |

The observe window is 10 minutes at 10%. A migration deploy (L-ADR-4) is counted in "Merge → 100% live" with the gradual deploy that follows it.

| Friction (per 100 messages) | Baseline | Target after 4 weeks |
|---|---|---|
| DIRECTION | 10.7 | ≤ 5.3 |
| VERIFY | 8.8 | ≤ 4.4 |
| UNCLEAR_IMPL | 6.8 | ≤ 3.4 |
| STACK, API_KEYS, CF_PERMS, ACCESS_UNAWARE | 4.9, 2.4, 2.6, 1.7 | 0 |
| DESIGN_IGNORED | 3.4 | 0 |
| CI_SLOW | 4.1 | ≤ 2.0 |
| PRs with a failed CI run | 47% | ≤ 20% |
| EXIT_GITHUB, EXIT_CF_DASHBOARD | friction-log week | 0 rows in one week |

## Phase 3: fitness checks

**Contract checks fail CI.** They run in the existing `check` job, inside its budget (CLAUDE.md, CI). A check fails when an event is missing or out of order, an intent or summary is longer than 5 lines, a proof is complete with an open checklist item, or a rollback needs more than one action.

**Time checks are reported in CI and handled in another process (owner-approved 2026-10-15).**

1. A scheduled loop report runs in Tempo each day. It calls `getLoopReport` for the last 7 days and compares each step with Targets.
2. It writes the result to R2 at `loop/<date>.json`, and the weekly result to `docs/evidence/loop-weekly/<date>.json` through a Tempo PR.
3. When a target is missed for 2 reports in a row, it opens a Tempo issue (09) in the project with the step, the numbers and the events behind them.
4. The `check` job prints the newest report from `docs/evidence/loop-weekly/` in the CI summary. A missed time target does not fail CI.

**Labels.** Each week: run the label pipeline (`score.py`) on the owner's Tempo sessions, hand-check 40 messages (seed 7, as the baseline), and report each code against the baseline.

## Clients

Each loop screen is in web (04) and Mac (07) in the same phase (CLAUDE.md rule 17, owner-confirmed 2026-10-15): the intent card, the proof, the checklist, the deploy steps and rollback, the error card and the Cloudflare approval card.

## Done means

From the owner's brief. Each needs no trust in the agent or the owner.

1. Event-log timestamps show each loop target is met.
2. Cloudflare API deployment and version IDs match what Tempo shows. One production rollback drill.
3. One real production error seen, fixed and redeployed from inside Tempo.
4. After four weeks: DIRECTION, VERIFY and UNCLEAR_IMPL each at most half the baseline; STACK, API_KEYS, CF_PERMS and ACCESS_UNAWARE zero.
5. The friction log shows zero exits to GitHub or the Cloudflare dashboard for one week. The one-time Issues automation setup (L-ADR-5) is not counted.

## Kill list

Tempo will not build these while this loop is the goal.

| Item | Why | Condition to bring it back |
|---|---|---|
| A full extension contract for dynamic UI: the artifact runtime and `ui://` resources (MCP Apps) | ACP v1 has no standard way to carry `ui://`; it needs a sandbox proxy origin and Mac parity. Static proof covers VERIFY first. | Phase 3 is done (done-proofs 1–5 met), **and** the four-week label report shows VERIFY or DESIGN_IGNORED above target, **and** at least 3 friction-log rows say a static image or recording could not show the problem. |
| A general MCP Apps host for other servers | Same as above, plus agent-written HTML that can call tools | Same condition, and a named server the owner uses |
| ACP v2 and unstable v1 features (`plan_update`, `session/fork`, MCP over ACP) | CLAUDE.md rule 8 | ACP v2 becomes stable and the owner approves a spec change |
| Log search, metrics dashboards, traces UI | Only errors feed the loop | An error-to-fix that the Issue and stack cannot explain, three times |
| Alert channels (email, Slack, phone) | The loop ends in a workspace session, not a message | Owner asks |
| Analytics Engine metrics for apps | Needs app code and a new scope | The Issues gate misses a bad deploy that per-version counters would catch |
| Cloudflare Workflows for the deploy pipeline | `AppDeployDO` alarms do the same; a new primitive (rule 11) | Two pipeline bugs from hand-written alarm state |
| Deploys outside Cloudflare Workers (Pages, containers, other clouds) | One loop | Owner asks |
| Teams, sharing, more users | 00 non-goals | — |
| Automatic merge | The owner merges | — |

## Spikes

| ID | Question | Pass |
|---|---|---|
| L-S1 | Does `version.traffic: 0` in Alchemy 2.0.0-beta.81 upload a version for each Worker of a stack with no traffic change, and force 100% for a DO class migration? Can `cf` do the same? | A version ID per Worker, traffic unchanged; a migration deploy at 100% |
| L-S2 | What does a Workers Issues generic webhook send for a new Issue? | The payload is recorded, with the Worker and version |
| L-S3 | Do Claude, Codex, OpenCode and Pi call `propose_intent` before they write, when the session starts read-only? | Each agent, 5 of 5 prompts |
| L-S4 | Can each agent make a phone and desktop screenshot of a route with the Playwright already in the image? | Images published with `submit_proof` |

## Decisions log

| Date | Question | Owner answer |
|---|---|---|
| 2026-10-15 | Targets | Approved. Gradual deploys must handle Durable Objects. |
| 2026-10-15 | First project | A smart todo list: MCP-enabled, smart tagging, background research by agents |
| 2026-10-15 | Gradual deploy (changes 12) | Approved |
| 2026-10-15 | Observe | Workers Issues webhooks |
| 2026-10-15 | Error sessions | An option: start on its own, or the owner starts it |
| 2026-10-15 | Time checks | Report in CI; handle in another process |
| 2026-10-15 | Secrets in containers | D11 logins and secrets with no `hosts` are named exceptions (14) |
| 2026-10-15 | Mac parity | Yes, every loop screen |
| 2026-10-15 | Cloudflare API from workspaces | Allowed, when the operation is safe and matches the owner's intent |
| 2026-10-15 | Intent check | Factor in the risk. New permissions, a security risk or a hard rollback: ask the owner. Else go on. |
| 2026-10-15 | Judge | Jev (`jev-1.14.0`) through the TypeSafe TypeScript SDK, for safety and alignment checks |
| 2026-10-15 | Todo app | Only the owner. Jev and the Cloudflare Web Search API. |
| 2026-10-15 | Removed access | Running sessions that hold it end (14) |
| 2026-10-15 | Call limits | HTTP methods are enough (14) |
| 2026-10-15 | Todo app MCP sign-in | OAuth through Better Auth |

## Open questions

None. The owner answered the last one on 2026-10-15 and asked the agent to keep building without the owner's involvement.
