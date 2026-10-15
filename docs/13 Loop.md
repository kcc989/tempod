# 13 Loop

Status: **Draft.** The owner has not approved the targets (Targets) or answered the open questions (Open questions). Do not build from this tab until both are done. Phase 3 also waits for one week of the friction log (`docs/evidence/friction-log/`).

Tempo becomes the owner's command center to build and run apps on Cloudflare. This tab defines one closed loop and makes it measurable. It extends 01, 04, 07, 08 and 12. It does not add features outside the loop (Kill list).

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

## Architecture decisions

### L-ADR-1. The intent check is a Tempo gate, not an agent feature

**Context.** 50 of 55 plan corrections were about direction, not length. Plan mode exists only in some agents: Claude and OpenCode `plan`, Codex `read-only`, Pi none (01, Agent profiles). The `ExitPlanMode` permission is Claude-only. ACP `elicitation` is forbidden by 02.

**Decision.**

1. A change with `origin: "prompt"` starts its session read-only, through the existing read-only path (08, Read-only).
2. Add the tool `propose_intent` to the `tempo` MCP server. Input: `goal`, `approach`, `not_doing`. Together they are at most 5 lines, each line at most 160 characters. The WorkspaceDO refuses a longer input with the tool error `Intent must be at most 5 lines.`, so the agent corrects it in the same turn.
3. The chat shows an intent card with two actions: **Confirm** (one click or ⌘↩) and **Correct** (a text field; sending it is the one action).
4. **Confirm** switches the session to write with `session/set_config_option` (category `mode`), or removes the profile's edit-tool deny list, and queues the turn `Intent confirmed. Do the work.`
5. **Correct** queues the correction as a user turn. The agent calls `propose_intent` again.
6. The fixed prompt text that asks for the intent is given with the first turn of the change, as the run header is in 08.

**Not chosen.** Plan mode only (not the same for four agents). ACP elicitation (needs a change to 02, and SDK 1.8.0 support is not verified). A free-text plan (the length is not enforceable).

**Reduces.** DIRECTION.

### L-ADR-2. Proof is a stored object that Tempo checks, not a claim

**Decision.**

1. Add the tool `submit_proof` to the `tempo` MCP server. Input:
   - `summary`: what changed, at most 5 lines.
   - `screens`: one entry per changed screen: `{route, viewport: "desktop" | "phone", theme: "light" | "dark", image: path, recording?: path}`.
   - `checklist`: one entry per open checklist item: `{itemId, resolved: true, screen: index, note}`.
2. Images and recordings are published as artifacts (01, Artifacts) and linked from the proof. They stay readable while the workspace sleeps.
3. `checks` are not reported by the agent. When the proof is submitted, `tempod` runs the project profile's `checks` (L-ADR-3) itself and records each command, exit code and duration. The agent cannot change these results.
4. A proof is **complete** only when every changed screen has an image, every open checklist item is resolved, and every check exited 0. The preview pane shows the proof above the preview. An incomplete proof shows what is missing.
5. **Changed screens** come from the profile's `screens` map: `{route, files: [glob]}`. A route is changed when the branch diff touches one of its files. Without a map entry for a changed file, the agent names the routes.
6. **Checklist.** When the owner sends a message with design critique, Tempo shows **Add to checklist** on that message. Each item is stored on the workspace with `open` status, the message ID and the text. The next proof must resolve each open item. The owner can reopen an item with one action.

**Not chosen.** Proof as free Markdown (cannot be checked). A full MCP Apps proof panel (Kill list).

**Reduces.** VERIFY, UNCLEAR_IMPL, DESIGN_IGNORED.

### L-ADR-3. One project profile, given to every session

**Decision.** Each project has one profile, edited in Tempo and stored by Tempo, with revisions as in 12. It holds:

| Key | Holds |
|---|---|
| `stack` | Runtime, package manager, frameworks and libraries, with versions, as the owner states them |
| `services` | Each external service: name, purpose, hosts, and the name of the credential reference (never a value) |
| `cloudflare` | Account, the Workers that make up the app, and the deploy targets (12) |
| `checks` | The commands that prove a change: typecheck, lint, tests, build. Each has a timeout. |
| `screens` | Routes and the source files that change them (L-ADR-2) |
| `notes` | At most 40 lines of free text |

- Every session gets the profile as the first content block of its first turn, and the tool `get_project_profile`.
- The profile compiles to the session's capability manifest (14). The agent can use what the manifest grants, and Tempo tells it so.
- The agent can propose a profile change with a proposal card, like `propose_agent_change` (08). Only the owner applies it.

**Reduces.** STACK, API_KEYS, ACCESS_UNAWARE.

### L-ADR-4. Deploy uploads a version, then Tempo moves traffic

**Context.** Every deployment in the evidence went to 100% at once. 12 runs `alchemy deploy` or `cf deploy`, which deploy at 100%, and makes Redeploy the only rollback. The Versions API can split traffic and roll back in seconds with `Workers Scripts Write`, which the minted token already has.

**Decision (depends on Q4 and spike L-S1).**

1. The deploy container uploads a new version for each Worker of the target and does not deploy it.
2. `AppDeployDO` stores each Worker's new `version_id` and the version that was at 100% before, with annotations `workers/commit_sha` and `workers/message = tempo-deploy-<number>`.
3. Tempo smoke-tests the new version at 0% with `Cloudflare-Workers-Version-Overrides`, then moves traffic in steps: 10% for the observe window, then 100%. The steps and window are in Targets.
4. Between steps, the health gate (L-ADR-5) compares the new and old versions. A failed gate rolls back with no owner action and starts the production-error path.
5. **Rollback** is one action in web and Mac: `POST /deployments` with the previous version at 100%. It needs no container and no build. Tempo mints a short token for it, as for a deployment.
6. Tempo shows the Cloudflare deployment ID and version ID for each Tempo deployment, so they can be matched with the Cloudflare API (done-proof 2).

**Limits from Cloudflare.** A Durable Object migration needs `wrangler deploy`, not a version upload. Rollback does not revert D1, KV or R2 data, and is refused across a DO lifecycle change. These deployments go to 100% and Tempo marks them "no rollback".

**Reduces.** VERIFY, UNCLEAR_IMPL, CF_PERMS, EXIT_CF_DASHBOARD.

### L-ADR-5. Observe through the Workers Observability API

**Decision (depends on Q5).**

1. `AppDeployDO` reads errors for each deployed Worker with `POST /workers/observability/telemetry/query`, grouped by `scriptVersion.id`. It needs no change to the app. The app must have `observability.enabled`.
2. During the observe window it reads every 60 s. After it, every 5 minutes for 24 hours, then hourly.
3. Errors are grouped by fingerprint: Worker, exception name, the message with numbers and IDs replaced, and the first stack frame. Tempo stores counts, first and last time, version, request method and path without query, and one redacted stack. It stores no headers, bodies or log text other than the exception.
4. Workers Logs keep 7 days. Tempo keeps its own fingerprints for 90 days.
5. A new token permission `observability` (`Workers Observability Write`, the only group the query endpoint accepts) is added to 12, Permissions, for Tempo's own reads. The token never enters a container.

**Not chosen.** Tail Workers (change the app's configuration). Workers Issues webhooks (setup only in the dashboard or `cf`; no REST API found). Analytics Engine (needs app code).

**Reduces.** VERIFY, EXIT_CF_DASHBOARD.

### L-ADR-6. A production error becomes a workspace session

**Decision (depends on Q6).**

1. The first occurrence of a new fingerprint after a deployment, or a failed health gate, writes `prod.error.seen` and creates a workspace on a new branch from the deployed SHA.
2. Its first prompt holds: the fingerprint, counts, first and last time, the Tempo deployment, the Cloudflare version, the redacted stack, and the commit range from the previous version to this one.
3. The fix goes through the same loop: intent check, proof, merge, deploy. The deployment links to the error. When the new version runs for the observe window with no occurrence of the fingerprint, Tempo writes `prod.error.fixed`.

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
| `deploy.version.uploaded`, `deploy.traffic.changed`, `deploy.rolled_back` | `tempo` | 12 with L-ADR-4; payload has Cloudflare version and deployment IDs |
| `prod.error.seen`, `prod.error.fixed` | `tempo` | L-ADR-5 and L-ADR-6 |

These names are proposed. They are not final until the owner approves this tab.

`getLoopReport {from, to}` returns, for each step, n, median and p90 from these events. A weekly export writes the same numbers to `docs/evidence/loop-weekly/<date>.json`.

## Targets (proposed, not approved)

Times are from the events in L-ADR-7. "Owner time" excludes time the owner is away (a gap of more than 30 minutes).

| Step | From → to | Baseline | Target median | Target p90 |
|---|---|---|---|---|
| Intent shown | `tempo.change.created` → `loop.intent.proposed` | none | 1 min | 3 min |
| Intent agreed | `loop.intent.proposed` → `loop.intent.confirmed` | none | 1 correction or fewer per change | 2 corrections |
| Preview with proof | `loop.intent.confirmed` → first complete `loop.proof.submitted` | none | 20 min | 45 min |
| Proof → merge | complete proof → `tempo.pr.merged` | 23.6 / 131.3 (PR open → merge) | 15 min | 60 min |
| CI | first check run → green on final head | 12.9 / 53.6 | 6 min | 15 min |
| Merge → 100% live | `tempo.pr.merged` → last `deploy.traffic.changed` at 100% | 157.2 / 1,062.4 | 20 min | 30 min |
| Rollback | owner action → previous version at 100% | none | 30 s | 60 s |
| Error seen | first error in Cloudflare → `prod.error.seen` | not seen | 3 min | 6 min |
| Error fixed | `prod.error.seen` → `prod.error.fixed` | 10.7 (n = 1, outside Tempo) | 60 min | 4 h |

| Friction (per 100 messages) | Baseline | Target after 4 weeks |
|---|---|---|
| DIRECTION | 10.7 | ≤ 5.3 (owner's done-proof 4) |
| VERIFY | 8.8 | ≤ 4.4 (done-proof 4) |
| UNCLEAR_IMPL | 6.8 | ≤ 3.4 (done-proof 4) |
| STACK, API_KEYS, CF_PERMS, ACCESS_UNAWARE | 4.9, 2.4, 2.6, 1.7 | 0 (done-proof 4) |
| DESIGN_IGNORED | 3.4 | 0 (proposed: the checklist makes a repeat visible) |
| CI_SLOW | 4.1 | ≤ 2.0 (proposed) |
| PRs with a failed CI run | 47% | ≤ 20% (proposed) |
| EXIT_GITHUB, EXIT_CF_DASHBOARD | friction-log week | 0 rows in one week (done-proof 5) |

## Phase 3: fitness checks

- A fitness check fails CI when a loop contract breaks: an event is missing or out of order, the intent or summary is longer than 5 lines, a proof is complete with an open checklist item, a rollback needs more than one action. These run in the existing `check` job, inside its budget (CLAUDE.md, CI).
- Time targets come from production events, not from CI. Q8 decides where that check runs.
- Each week: run the label pipeline (`score.py`) on the owner's Tempo sessions, hand-check 40 messages (seed 7, as the baseline), and report each code against the baseline.

## Done means

From the owner's brief. Each needs no trust in the agent or the owner.

1. Event-log timestamps show each loop target is met.
2. Cloudflare API deployment and version IDs match what Tempo shows. One production rollback drill.
3. One real production error seen, fixed and redeployed from inside Tempo.
4. After four weeks: DIRECTION, VERIFY and UNCLEAR_IMPL each at most half the baseline; STACK, API_KEYS, CF_PERMS and ACCESS_UNAWARE zero.
5. The friction log shows zero exits to GitHub or the Cloudflare dashboard for one week.

## Kill list

Tempo will not build these while this loop is the goal.

| Item | Why | Condition to bring it back |
|---|---|---|
| A full extension contract for dynamic UI: the artifact runtime and `ui://` resources (MCP Apps) | ACP v1 has no standard way to carry `ui://`; it needs a sandbox proxy origin and Mac parity. Static proof covers VERIFY first. | Phase 3 is done (done-proofs 1–5 met), **and** the four-week label report shows VERIFY or DESIGN_IGNORED above target, **and** at least 3 friction-log rows say a static image or recording could not show the problem. |
| A general MCP Apps host for other servers | Same as above, plus agent-written HTML that can call tools | Same condition, and a named server the owner uses |
| ACP v2 and unstable v1 features (`plan_update`, `session/fork`, MCP over ACP) | CLAUDE.md rule 8 | ACP v2 becomes stable and the owner approves a spec change |
| Log search, metrics dashboards, traces UI | Only errors feed the loop | An error-to-fix that the fingerprint and stack cannot explain, three times |
| Alert channels (email, Slack, phone) | The loop ends in a workspace session, not a message | Owner asks |
| Analytics Engine metrics for apps | Needs app code and a new scope | The health gate misses a bad deploy that per-version counters would catch |
| Cloudflare Workflows for the deploy pipeline | `AppDeployDO` alarms do the same; a new primitive (rule 11) | Two pipeline bugs from hand-written alarm state |
| Deploys outside Cloudflare Workers (Pages, containers, other clouds) | One loop | Owner asks |
| Teams, sharing, more users | 00 non-goals | — |
| Automatic merge | The owner merges | — |

## Spikes

| ID | Question | Pass |
|---|---|---|
| L-S1 | Can Alchemy v2 and `cf` upload a version without deploying it, for each Worker of a stack? | A version ID is returned and traffic does not change |
| L-S2 | Does the telemetry query return `scriptVersion.id` and the exception for the owner's apps, with the minted token? | The Oct 12 `tempo` incident is found by version |
| L-S3 | Do Claude, Codex, OpenCode and Pi call `propose_intent` before they write, when the session starts read-only? | Each agent, 5 of 5 prompts |
| L-S4 | Can each agent make a phone and desktop screenshot of a route with the Playwright already in the image? | Images published with `submit_proof` |

## Open questions

The spec is silent or in conflict here. The owner decides each one before this tab is approved.

1. **Q1. Which projects run the loop first?** `tempod` is GitHub-linked and deployed with `wrangler`; 12 covers native (Artifacts) projects only. `farstep` holds most CF_PERMS, API_KEYS and CI_SLOW friction.
2. **Q2. When is the intent check required?** Every new change, or also each follow-up turn? Is there a way to skip it for a small change?
3. **Q3. Changed screens.** Is the profile's `screens` map acceptable, or must Tempo find changed screens another way?
4. **Q4. Gradual deploy.** Accept the change to 12 (upload only, then Tempo moves traffic; Rollback becomes its own action)? Approve the steps (0% smoke test, 10%, 100%) and the observe window?
5. **Q5. Observe.** Accept the polling of the telemetry query API and the new `observability` permission? Or use Workers Issues webhooks, set up once in the dashboard?
6. **Q6. Error sessions.** Does Tempo start the agent on a production error by itself, or create the workspace and wait for the owner's one action? Is an automatic rollback on a failed gate acceptable?
7. **Q7. Targets.** Approve, or change, each number in Targets.
8. **Q8. Time fitness.** Time targets need production events. Where does that check run: a scheduled Tempo job that writes the weekly report, or a second CI job (needs your approval under the CI budget)?
9. **Q9. Mac parity.** CLAUDE.md rule 17 requires each web change in the Mac client in the same phase. Does this hold for every loop screen (intent card, proof, checklist, rollback)?
