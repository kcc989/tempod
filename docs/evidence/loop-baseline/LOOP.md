# Phase 0: loop evidence (Oct 5–15, 2026)

This file extends the baseline in `README.md`. It does not redo it. It adds Tempo's own data, CI runs, Cloudflare deployments and git history for the loop:

intent → preview → merge → deploy → production error → fix

Inputs were read on 2026-10-15. Only aggregates and IDs are in the repo.

## Sources

| Source | What was read | Count |
|---|---|---|
| Tempo D1 (`tempo` database, production) | `workspaces`, `projects`, `pull_requests`, `issues` | 7 workspaces, 5 projects, 0 Tempo PRs, 0 issues |
| Tempo WorkspaceDO SQLite (`events`, lifecycle events, runs) | Not read. See Gaps. | — |
| Cloudflare Workers Versions and Deployments API | `tempo`, `farstep-web-staging`, `farstep-core-staging` | 14, 91 and 71 versions |
| Workers Observability telemetry API | All Workers, Oct 8–15 (the retention limit cut Oct 5–7) | All error events |
| GitHub `kcc989/tempod` | PRs, PR commits, Actions runs | 67 PRs (66 merged), 287 runs |
| Git history | First-parent `main` since Oct 11 | 48 commits |

`scripts/loop_steps.py` makes `data/loop-steps.json`. The command list is in its docstring.

## Time for each step

Minutes. p90 uses the nearest-rank rule of `score.py`. All PRs are in `kcc989/tempod` (Oct 11–15). Other projects are not in scope for this session's GitHub access.

| Step | Measured as | n | Median | p90 |
|---|---|---|---|---|
| Intent → first reply | Owner message to next agent event | 468 msgs | see README (`minutes_to_next_human_message`: 1.0 / 28.8) | |
| Intent → preview | Not measurable. No preview event exists in any source. | 0 | — | — |
| Work → PR open | First commit authored → PR opened (a proxy; it misses the time before the first commit) | 66 | 2.2 | 85.6 |
| PR open → merge | PR opened → merged | 66 | 23.6 | 131.3 |
| CI | First CI run on the PR → first green run on the final head | 63 | 12.9 | 53.6 |
| CI failures | Failed CI runs per PR | 66 | 0 | 2 |
| Merge → deploy | Merge → next `tempo` Worker version (manual `wrangler deploy`) | 57 | 157.2 | 1,062.4 |
| Deploy → production error | Version live → first error | 1 | 2.0 | — |
| Production error → fix live | First error → next version live | 1 | 10.7 | — |

- 31 of 66 PRs (47%) had at least one failed CI run.
- 14 `tempo` versions served 66 merges. Every deployment in all three Workers went to 100% in one step (`strategy: percentage`, one version at 100%). There was no gradual deployment and no rollback.
- No deployment was made by Tempo. `tempo` versions come from `wrangler`; `farstep-*` versions come from the API (`source: api`). Tempo D1 has 0 PRs and no App Deploy data; App Deploy (12) was merged on Oct 15.

## Production errors

**"Production error → fix" stays a hypothesis for the owner's apps.** The owner's messages contain no production errors (README).

**Tempo's own data shows one real production error.** It is in Workers Observability, not in Tempo's UI:

| Field | Value |
|---|---|
| Worker | `tempo` |
| Version | `eaeb14fe-ab1b-4974-8fda-e71250abf193`, live 2026-10-12 22:19:00 UTC |
| Errors | `Rollback` (`DrizzleError` in a `WorkspaceDO` transaction) 690, `request failed` 230, `server function failed` 20 (sampled counts) |
| Trigger | `GET /api/ws/workspace/01m4rdanmb0rsvbvp6z1ycjgk7` (the `farstep` workspace) |
| First and last error | 22:21:00 and 22:31:43 UTC |
| Next version | `62a6628d`, live 22:31:42 UTC. No error on any later version. |
| Seen in Tempo | No. Tempo has no view of its own errors or of an app's errors. |
| Fixed through Tempo | No. The next version came from `wrangler`. |

The other errors on the account (Oct 8–15) are scanner requests (`/.env`, `wp-admin`, `*.php`) on `skillit-qa`, `costitch` and `stett-website-prod`, plus 3 search errors on `skillit-prod`. None is in a project that Tempo manages.

## Time lost to each friction code

**Not computed here.** The raw messages stay on the owner's machine and are not in the repo. `score.py lost` computes it from the same files as `score.py score`:

```sh
python3 -I scripts/score.py lost <out> data/time-lost.json
```

Method: a friction message costs the owner's time to notice and write it (its gap after the agent's last event, at most 30 minutes) plus the agent's rework until its last event before the next owner message (at most 60 minutes). A message with several codes splits its minutes evenly. PLAN_VERBOSE is split into DIRECTION and PLAN_LENGTH by its reason, as in the README. The output has messages, minutes, minutes per 100 messages, and the median and p90 per message.

The owner runs it once and commits `data/time-lost.json`. Phase 1 targets use it to rank codes by time.

## Gaps

1. **WorkspaceDO events were not read.** They live in each Durable Object's SQLite. No API reads them without an owner session, and the D1 MCP tool cannot reach them. The 7 workspaces were active for 16 s to 25 h (`created_at` to `last_activity_at`). Six are test projects (`slugger-*`) or under 15 minutes. Tempo is not yet used for the loop, so Tempo's event log has no baseline.
2. **Agent runs (08)** are in WorkspaceDO SQLite too. The D1 `agents` table holds 4 agent definitions and no runs.
3. **Intent → preview** has no event in any source. Phase 1 adds one.
4. **Observability keeps 7 days.** Oct 5–7 errors are lost. Phase 1 must store error data in Tempo.
5. **One project.** The GitHub data covers only `tempod`. `farstep` (CF_PERMS, API_KEYS and CI_SLOW are mostly there) is outside this session's GitHub scope.

## Sources for the loop, ranked

Read on 2026-10-15 from the raw sources: developers.cloudflare.com and its API reference (page dates below), ACP schema v1 at `agentclientprotocol/agent-client-protocol@7855bab` (changelog 1.11.0), MCP Apps spec `2026-01-26` at `modelcontextprotocol/ext-apps@82221c0`, and T3 Code at `pingdotgg/t3code@26fffe5`.

"Addressable rate" is the sum of the baseline rates (per 100 messages) of the codes that a source can reduce. It ranks sources. It does not predict a result. EXIT codes have no baseline yet, so they do not add to the sum. A source that adds a scope or a stack item lists that code under "Raises".

| Rank | Source | What Tempo can do with it that it cannot do now | Reduces | Raises | Addressable rate |
|---|---|---|---|---|---|
| 1 | Workers Observability: telemetry query API and Workers Issues (Issues page Oct 12, 2026; Query API) | Read errors per Worker version with no change to the app; a health gate after each deploy step; a webhook from an Issue into a new workspace session; an agent tool for production logs. It is the only path in this list for "production error → fix". | VERIFY, UNCLEAR_IMPL, ACCESS_UNAWARE, EXIT_CF_DASHBOARD | CF_PERMS (the query needs `Workers Observability Write`; no Read group is documented) | 17.3 |
| 2 | Workers Versions and Deployments API (Rollbacks page Jul 15, 2026) | Store the Cloudflare version and deployment ID for each Tempo deployment; one-action rollback in seconds with no rebuild; percentage splits; a 0% smoke test with `Cloudflare-Workers-Version-Overrides`; `workers/commit_sha` annotations. `Workers Scripts Write` is already in Tempo's minted token. | VERIFY, UNCLEAR_IMPL, EXIT_CF_DASHBOARD | — | 15.6 |
| 3 | ACP v1: plan mode, `session/request_permission`, `session/set_config_option` (stable) | An intent gate on the existing read-only path (08): start the change read-only, then switch to write after one confirm. The `ExitPlanMode` permission in `claude-agent-acp` 0.89.1 is already a one-action gate for Claude. A `tempo` MCP tool makes the gate the same for all four agents. | DIRECTION | — | 10.7 |
| 4 | T3 Code (MIT, so code may be reused with its notice) | Ideas for agent-driven preview tools with screen recording (`preview_open`, `snapshot`, `recording_start`), an HTML render self-check at phone width, a plan card with Implement and Refine, and approvals docked in the composer. | VERIFY, DESIGN_IGNORED, DIRECTION | — | 22.9 |
| 5 | ACP v1 `elicitation/create` (stable since 1.7.0) | Structured clarifying questions and an intent form. Spec 02 forbids advertising `elicitation` today, and support in the pinned SDK 1.8.0 is not verified. | DIRECTION, UNCLEAR_IMPL | — | 17.5 |
| 6 | Workers Previews, `wrangler preview` (Sep 24, 2026) | An isolated preview URL per branch, also for apps with Durable Objects. Version URLs do not work for those apps. Support in Alchemy v2 and `cf` is not verified. | VERIFY | — | 8.8 |
| 7 | MCP Apps, `ui://` resources (stable 2026-01-26) | Interactive proof and deploy panels in the chat. ACP v1 has no standard way to carry `ui://` to the client, and Tempo would need a sandbox proxy origin and Mac parity. | VERIFY, DESIGN_IGNORED, EXIT_CF_DASHBOARD | STACK | 12.2 |
| 8 | Cloudflare Workflows (Workers API page Oct 12, 2026) | A durable deploy pipeline with step history, sleeps and `waitForEvent` gates. `AppDeployDO` alarms already do this work, so it is optional. | UNCLEAR_IMPL | STACK | 6.8 |
| 9 | Workers Analytics Engine (Apr 23, 2026) | Per-version counters with 3-month retention. It needs a binding and code in each app. | VERIFY | STACK, CF_PERMS | 8.8 |
| — | Tail Workers and Logpush | Another way to get errors. It changes the app's configuration (`tail_consumers`) or needs `Logs Edit`. Rank 1 does the same with less setup. | as rank 1 | CF_PERMS | — |

The rank is not the addressable rate alone. T3 Code and elicitation have high rates, but T3 Code gives ideas, not a platform capability, and elicitation is blocked by spec 02. Ranks 1 and 2 are the only sources that make the deploy, observe and fix steps possible at all.

None of these sources reduces STACK, API_KEYS, CF_PERMS or CI_SLOW. Those need Tempo's own work: the project profile and the capability manifest (13 and 14).

Full notes, with URLs and the facts that were not verified: `sources/cloudflare.md` and `sources/acp-mcp-apps-t3code.md`.
