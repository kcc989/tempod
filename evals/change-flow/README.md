# Change flow study

Evidence for the proposed Verification design (08), Risk tiers (10) and Change metrics (09). Run from the repository root:

```sh
python3 -I evals/change-flow/review.py <case> <baseline|design|design-same>   # one replay
python3 -I evals/change-flow/judge.py                                         # scores.json and the table
python3 -I evals/change-flow/simulate.py --measure                            # conflicts, tiers, throughput
```

`review.py` needs the `claude` CLI for Claude models and `CLOUDFLARE_ACCOUNT_ID` with a Cloudflare credential for Workers AI models. Worktrees go to `$CHANGE_FLOW_WORKTREES`. The reviewer never sees the defect text in `cases.json`.

## 1. Failure taxonomy

Sources: the seven fix PRs (#28, #45, #53, #60, #61, #62, #63), their parent commits, the commits that introduced each defect (`git log -S`), the owner-approved corrections in tabs 08 to 10 and `docs/IMPLEMENTATION_NOTES.md`. The owner's agent transcripts were not read: this session has no connection to the owner's computer.

### Code and test defects (12 in 7 fix PRs)

| Class                                                      | Count | Defects (fix PR, introduced by)                                                                                                                                                                                                                                                                                                                                                               | Found by                           |
| ---------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| A. Real dependency differs from the fake or the assumption | 5     | F1 Codex device sign-in from the Worker fails and the Mac masks the error (#28, 459a617). F3 workerd WebSocket frames arrive as `Blob` (#53, 68910d4). F5 Artifacts `log({ref})` rejects `refs/heads/…`; fakes strip it (#60, #51). F10 empty Effect struct is not an object schema; Claude Code rejects `tools/list` (#62, #51). F11 Sandbox `readFile` throws `ENOENT`, not 404 (#63, #49). | Deployed forge demo 3, owner use 2 |
| B. Nondeterministic tests                                  | 4     | F2 deferred-turn reconnect race (#45, de82a91). F8 `sleep(300)` and timing assertion under concurrency (#61, eaf0b28). F9 `mockRejectedValueOnce` on a shared binding under concurrency (#61, #57). F12 1 s role query over 50 comments (#63, #51).                                                                                                                                           | Main CI 4                          |
| C. Build and runtime environment                           | 2     | F7 `COPY --chmod=0644` makes `/opt/tempo` untraversable (#61, #51). F6 Node 24 reporter prints `ℹ fail 0` (#60, #59).                                                                                                                                                                                                                                                                         | Image test 1, deployed demo 1      |
| D. UI interaction                                          | 1     | F4 terminal fit, focus and readiness (#53).                                                                                                                                                                                                                                                                                                                                                   | Owner use 1                        |

- One PR (#51, 33,507 added lines, 1.47 MB diff) introduced 4 of the 12. Four of the eight introducing changes are larger than the 256 KiB diff block, so the starter `reviewer` gets a cut diff.
- Detection lag: 10 to 12 hours for the #51 defects, 27 hours for F11, 3 days for F3.
- Every class A defect has its real contract in reach: F5's is in `apps/tempo/worker-runtime.d.ts` ("Branch, tag, or commit ID"), F10's in the MCP client's error, F11's in the Sandbox SDK. Test fakes agreed with the code, not with the dependency.

### Spec corrections (owner-approved, 11 in tabs 08 to 10 and the notes)

| Class                                    | Count | Items                                                                                                                                                                       |
| ---------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spec silent                              | 5     | Send to chat correlation; long-prompt truncation; invalid handles, duplicate names and imports above 50; flat Session agent fields; empty model selects the adapter default |
| External contract found during the build | 2     | Clef rejects colons in question ids (S22); `report_result` needs request/response frames outside the raw event log                                                          |
| Names and texts                          | 2     | `AgentAttachment` (clash with uploaded attachments); access texts (A1, A9)                                                                                                  |
| Owner changed scope or policy            | 2     | Legacy Artifacts import waiver; redacted file-derived text allowed in run results (A12)                                                                                     |

Tab 10 also lists 7 plan items that the stack rules replaced (no Workflows, no `@cloudflare/ci` SDK, no push events, no caches, no merge-candidate checks, no PR-less check events, the YAML parser).

### What a verifier or an explainer would catch

| Who                                                                     | Would catch                                                                                                                                                                               | Count                                                            |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Static cold verifier that checks real contracts (V2, risk list 1, 5, 6) | B: F2, F8, F9, F12. C: F7. A: F5, F10 (contract in the repository).                                                                                                                       | 7 of 12 in principle. In the replay: 0 of 11, in every condition |
| Pre-merge execution verifier on `high` (deployed smoke, image test)     | A: F5, F10, F11. C: F6, F7. These were found after merge by exactly these suites.                                                                                                         | 5 of 12                                                          |
| Neither                                                                 | F1 (needs a real OpenAI sign-in), F3 and F4 (need a real browser terminal), unless the smoke suite types in a terminal                                                                    | 3 of 12                                                          |
| Explainer (plan or Guide)                                               | The 5 spec-silent corrections, which surfaced mid-build as owner questions; F1's design choice (sign-in from the Worker) is visible in a plan explanation. It does not find code defects. | 5 spec items                                                     |

## 2. Verifier benchmark

### Method

- **Cases.** 8 fix-PR replays: the reviewer reviews the change that introduced each defect, at that change's head, with the diff against its parent. (For a fix PR, "the parent commit" holds the defect; the introducing change is what a reviewer would have seen before merge.) 8 seeded defects on `f1b8a67` (`seeds/`). 6 clean PRs with no known defect.
- **Conditions.** `baseline`: the starter `reviewer` prompt as its system prompt, with the tab 08 run header, read-only text, `review` output text, request text and the diff cut at 256 KiB, on Claude Opus 5.5 through Claude Code (the owner's default agent). `design`: the proposed verifier prompt (`verifier-prompt.txt`), cold context, `checked` and evidence fields, and the evidence check, on a family outside the author's: Workers AI Kimi K2.7 Code for Claude-authored changes, Claude Opus for Codex-authored ones. `design-same`: the same verifier prompt on Claude Opus for every case. `design-exec`: `design-same`, plus it may run tests and scratch probes.
- **Scoring.** A defect counts as caught only when a blocking finding names the same cause. A third-family judge (Workers AI DeepSeek V4 Pro) scored this; I checked each miss and hold by hand. A clean PR counts as held when the status is not `pass`, because that closes a fail-closed gate. Score = recall − clean hold rate.
- **Environment.** Each worktree links the main checkout's installed packages, so verifiers can read the real SDK sources. A first pass without them is kept in `results-no-deps/`. Each case ran once per condition.

### Baseline numbers (starter `reviewer`, before any design)

| Measure                                                | Value                                                                                                                               |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Fix PRs where the reviewer raised any blocking finding | 2 of 8 (#53's `68910d4`: no tests; #61's `eaf0b28`: a different race in the same test group). Neither is the defect that was fixed. |
| Real escaped defects caught                            | **0 of 11** (F4 has no single introducing change)                                                                                   |
| Seeded defects caught                                  | **8 of 8**                                                                                                                          |
| Clean PRs held                                         | 0 of 6 (1 of 6 in the first pass)                                                                                                   |
| Replay score                                           | **0.42** (0.25 in the first pass)                                                                                                   |
| Tokens and time per review                             | 0.45 M tokens processed (mostly cache reads), 0.7 minutes                                                                           |

### All conditions

| Condition   | Real defects | Seeded | Clean held | Score    | Tokens per run | Minutes per run |
| ----------- | ------------ | ------ | ---------- | -------- | -------------- | --------------- |
| baseline    | 0/11         | 8/8    | 0/6        | **0.42** | 0.45 M         | 0.7             |
| design      | 0/11         | 5/8    | 1/6        | 0.10     | 1.18 M         | 2.7             |
| design-same | 0/11         | 8/8    | 1/6        | 0.25     | 1.63 M         | 1.8             |
| design-exec | 0/11         | 8/8    | 1/6        | 0.25     | 2.06 M         | 2.2             |

Coverage of changed source files on the 4 cut-diff cases: median 0.51 to 0.55 in every condition.

✓ marks a defect caught by a confirmed blocking finding.

| Case      | Kind  | Diff cut | baseline  | design                 | design-same | design-exec |
| --------- | ----- | -------- | --------- | ---------------------- | ----------- | ----------- |
| R-459a617 | fix   | no       | pass      | blocked                | pass        | pass        |
| R-de82a91 | fix   | no       | pass      | blocked                | pass        | pass        |
| R-68910d4 | fix   | yes      | fail      | blocked                | fail        | fail        |
| R-41372df | fix   | yes      | pass      | blocked                | pass        | no result   |
| R-8f23c85 | fix   | no       | pass      | block (invalid status) | pass        | pass        |
| R-eaf0b28 | fix   | no       | fail      | pass                   | fail        | pass        |
| R-2bbfc39 | fix   | yes      | pass      | pass                   | pass        | no result   |
| R-2ff48c5 | fix   | yes      | pass      | pass                   | fail        | pass        |
| S1        | seed  | no       | fail ✓ S1 | blocked                | fail ✓ S1   | fail ✓ S1   |
| S2        | seed  | no       | fail ✓ S2 | fail ✓ S2              | fail ✓ S2   | fail ✓ S2   |
| S3        | seed  | no       | fail ✓ S3 | fail ✓ S3              | fail ✓ S3   | fail ✓ S3   |
| S4        | seed  | no       | fail ✓ S4 | pass                   | fail ✓ S4   | fail ✓ S4   |
| S5        | seed  | no       | fail ✓ S5 | fail ✓ S5              | fail ✓ S5   | fail ✓ S5   |
| S6        | seed  | no       | fail ✓ S6 | pass                   | fail ✓ S6   | fail ✓ S6   |
| S7        | seed  | no       | fail ✓ S7 | fail ✓ S7              | fail ✓ S7   | fail ✓ S7   |
| S8        | seed  | no       | fail ✓ S8 | blocked ✓ S8           | fail ✓ S8   | fail ✓ S8   |
| C-8159759 | clean | no       | pass      | pass                   | pass        | pass        |
| C-f29c2bc | clean | no       | pass      | pass                   | pass        | fail        |
| C-1ec4cc3 | clean | no       | pass      | blocked                | pass        | pass        |
| C-f1b8a67 | clean | no       | pass      | pass                   | blocked     | pass        |
| C-ee1e5f7 | clean | no       | pass      | pass                   | pass        | pass        |
| C-bfb05a8 | clean | no       | pass      | pass                   | pass        | pass        |

### What the replay says

1. **The design does not beat the baseline.** The done criterion "the new design beats the baseline replay score" is **not met**.
2. **No static reviewer catches the defects that escaped.** All 11 real defects were missed in every condition, including the one that can run tests and probes. Every seeded defect except three in `design` was caught. Seeded defects sit in a 13 to 29 line diff; real ones sit in changes of 36 KB to 2.8 MB, half of them cut.
3. **The second family available here is weaker.** Kimi K2.7 Code found 5 of 8 seeded defects; Opus found 8 of 8. Kimi found S1 and marked it not blocking; it passed S4 and S6 with wrong reasoning. V3 only pays off with a qualified family (V11). A Codex login was not available to test.
4. **Fail closed has a price.** Each verifier condition held 1 of 6 clean PRs: twice because it could not confirm an SDK contract and chose `blocked`, once on a false typecheck claim (`Promise.withResolvers`; hosted CI passed on that head). Two `design-exec` runs and one Kimi run returned no valid report within 40 steps; in Tempo that is `RUN_RESULT_MISSING`, which keeps the gate closed.
5. **The evidence check rarely fired.** It downgraded 1 finding in 66 verifier runs. It cost nothing in quality, but did not measurably reduce false holds.
6. **Variance is large.** For Codex-authored cases, `design` and `design-same` are the same setup and disagree on 4 of 6 cases. With one run per cell, differences of one case are noise.
7. **Cost.** The verifier prompt reads 3.6 times as many tokens as the starter (4.6 times with execution).

Spend: $51.36 Claude-equivalent for the reported pass and $33.59 for the first pass (Claude Code session usage); Workers AI neurons on the connected Cloudflare account; $14.66 of OpenRouter credit, used up by a first attempt that gave no usable results.

## 3. Design

See `docs/08 Events and Agents.md` (Verification), `docs/10 Project CI.md` (Risk tiers, merge gate inputs), `docs/09 Git Forge.md` (Change metrics), and the Guide paragraphs in tabs 04 and 07.

## 4. Simulation

`simulate.py` is a discrete-event model of one native project over 24 hours, averaged over 8 seeds. Each agent owns one workspace and keeps one change until it merges, so the one-write-run-per-workspace rule holds: rework after a conflict or a finding is a write run in the same workspace.

**Measured inputs**

| Input                      | Value                                                                                                                     | Source                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Author time per change     | lognormal, median 25 minutes                                                                                              | PR open time, #1 to #63 (`prs.json`)                  |
| CI run                     | 4.1 runner minutes                                                                                                        | Hosted runs in #53 and #61 (209.5 to 269 s)           |
| CI slots                   | 2 per project                                                                                                             | 10, Runs and jobs                                     |
| Conflict, adjacent PR pair | 0.356 code conflicts (0.59 within 5 PRs; 0.69 including docs and generated files)                                         | `git merge-tree` over 285 pairs in the last 60 merges |
| Hot conflict files         | `IMPLEMENTATION_NOTES.md` (69 of 197 conflicting pairs), spec tabs 07 and 04, `docs/CI.md`, Mac views, generated protocol | same                                                  |
| Tier mix                   | 5% low, 45% medium, 50% high                                                                                              | the example `risk` rules over the last 60 merges      |
| Escaped defects            | 12 in 55 feature PRs                                                                                                      | taxonomy                                              |
| Verifier                   | `design-same`: real-defect recall 0, clean hold 0.17, 1.63 M tokens, 1.8 minutes per run                                  | replay                                                |

Assumptions to replace with Change metrics: 25% of author time per rework; owner minutes of 5 (high) and 2 (medium) per Guide and 2 per finding. `0.05` conflict is a sensitivity case for areas that agents lease, not a measurement.

**Results** (real-defect recall; the seeded-recall upper bound is in `results/simulation.design-same.json`)

| Agents | Conflict | Flow                   | Merged per hour | Lead p50 (min) | CI wait p50 (min) | CI min per merge | Conflicts per merge | Verifier runs per merge | Verifier tokens per merge | Escaped per 100 | Owner min per merge |
| ------ | -------- | ---------------------- | --------------- | -------------- | ----------------- | ---------------- | ------------------- | ----------------------- | ------------------------- | --------------- | ------------------- |
| 10     | 0.356    | baseline               | 4.5             | 40             | 0                 | 9.2              | 1.2                 | 0                       | 0                         | 19              | 0                   |
| 10     | 0.356    | design                 | 4.1             | 42             | 0                 | 11.7             | 1.3                 | 7.7                     | 12.5 M                    | 19              | 4.6                 |
| 100    | 0.356    | baseline               | 2.2             | 509            | 174               | 54.3             | 12.2                | 0                       | 0                         | 20              | 0                   |
| 100    | 0.356    | design                 | 2.0             | 516            | 175               | 61.2             | 11.1                | 41                      | 66.6 M                    | 23              | 8.7                 |
| 100    | 0.356    | design + batch-4 queue | 8.4             | 265            | 25                | 14.4             | 10.2                | 35                      | 57.2 M                    | 20              | 8.8                 |
| 10     | 0.05     | baseline               | 6.4             | 33             | 0                 | 5.3              | 0.3                 | 0                       | 0                         | 20              | 0                   |
| 100    | 0.05     | baseline               | 8.5             | 353            | 162               | 14.1             | 2.4                 | 0                       | 0                         | 18              | 0                   |
| 100    | 0.05     | design + batch-4 queue | 31.8            | 70             | 8                 | 3.8              | 1.8                 | 9.4                     | 15.2 M                    | 19              | 4.8                 |

What it says:

1. **Conflicts limit 10 agents.** At the measured rate, each merge needs about 1.2 conflict reworks. Throughput is 4.5 merges per hour, not 10 × 60 / 25 = 24.
2. **CI slots limit 100 agents.** Two slots give 29 runs per hour. Demand is far higher, so lead time goes to 8.5 hours and CI uses all 120 runner minutes each hour. Each run stays within the 5-minute budget, but a merged change costs 54 runner minutes because every rework reruns CI.
3. **Verification without real recall is cost only.** With real-defect recall of 0, the design adds 2.5 CI minutes, about 8 verifier runs and 12.5 M tokens per merge at 10 agents, and does not change escaped defects. Each rework creates a new head SHA, so V4 reruns every verifier.
4. **What would help:** a batching merge queue (4 times the throughput at 100 agents), splitting the append-only notes file and areas that agents lease (conflict 0.05: 32 merges per hour), and verifiers only after the recall is real (V11, V12).

## 5. Prior art

| System                                                                   | Take                                                                                                                                                                                                               | Reject                                                                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| [Scion](https://github.com/GoogleCloudPlatform/scion) (Google, Apr 2026) | One container, worktree and identity per agent: Tempo already has a workspace per agent and goes further, with no credentials in the container. Its mixed agent harnesses (Gemini, Claude Code, Codex) support V3. | Letting the models decide how to coordinate. Merge decisions stay deterministic and fail closed (V4).    |
| Antique                                                                  | Not assessed. I found no public source for a system with this name; it needs a link.                                                                                                                               | —                                                                                                        |
| Piper and Critique (Google)                                              | Analyzer findings shown inside review, with a "not useful" signal and a false-positive budget that turns noisy analyzers off (Tricorder). Path-based ownership maps to risk tiers. Presubmit before submit.        | Monorepo-scale infrastructure and human readability approvals; Tempo has one owner.                      |
| Sapling (Meta)                                                           | Small, stacked commits as the review unit. The replay shows why: the reviewer sees a cut diff for 4 of 8 introducing changes and reads about half of their source files.                                           | A new VCS client. Tempo stays on Git and Artifacts.                                                      |
| Gerrit                                                                   | Patch sets and labels: votes reset on a new patch set, and submit requirements combine `Verified` (CI) with review labels. This is the head-SHA keying and the gate inputs of V4 and V6.                           | Its manual rebase and relation-chain UI.                                                                 |
| Graphite stacks                                                          | Stack-aware PRs and a stack-aware merge queue for later, when stacks exist.                                                                                                                                        | Dependence on GitHub; the gate is for native projects.                                                   |
| Merge queues (GitHub merge queue, Bors, Zuul, Uber SubmitQueue)          | Test the merge candidate, batch candidates and bisect on failure. The simulation needs this at 100 agents.                                                                                                         | Speculative parallel pipelines now: they multiply CI minutes beyond the CI budget and the two job slots. |

## 6. Done criteria

| Criterion                                                                                      | Status                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The new design beats the baseline replay score                                                 | **Not met.** Baseline 0.42; best design condition 0.25. Tab 08 now says not to build V1–V7 as a required gate, and adds V10–V12.                                                   |
| Gate I and S23 pass with real logins                                                           | **Not run.** This environment has no agent logins, no hosted sign-in and no deployed Tempo to test against. Gate V depends on Gate I.                                              |
| A plan to track fix PRs per feature PR, owner minutes, tokens and CI minutes per merged change | **Done in the spec**: 09, Change metrics (`fixes_number`, `recordAttention`, token and CI sums, `getChangeMetrics`). Until it ships, this directory reports them from Git history. |
| A Guide comprehension test is defined                                                          | **Done in the spec**: 08, Tests, Guide comprehension.                                                                                                                              |

Smallest first experiment: 06, Verification, milestone V0. It needs no product code: one library agent on a Codex base, attached in shadow mode for 14 days, with `Fixes #<n>` on fix PRs and a weekly replay.
