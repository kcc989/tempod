# Loop baseline (Oct 5–15, 2026)

This folder measures the owner's loop with coding agents before Tempo becomes the command center for Cloudflare apps. Use it as the "before" number for each loop target.

It holds scripts, the label prompt and aggregate counts only. It holds no message text: the raw logs contain personal content and stay out of the repo.

## Sources

| Source | What | Count |
|---|---|---|
| Claude Code `~/.claude/projects` | Main threads (no subagents) | 299 messages |
| Codex `~/.codex/sessions` and `archived_sessions` | Threads the user started (`thread_source: user`) | 169 messages |
| GitHub Actions, `kcc989/tempod` | Completed runs, Oct 11–15 | 285 runs |

A "message" is text the user typed. The parser drops task notifications, system prompts, tool results, command output and interrupt markers. It keeps pasted text and `!` shell input. Interrupts, screenshots and `/login` runs are counted on the next message.

## Method

1. `scripts/parse.py` reads the exported logs and writes `messages.jsonl`, `assistant.jsonl` and `threads.json`.
2. `scripts/score.py split` makes four batches. Four agents label them with `label-prompt.md`.
3. A person labels 40 random messages (seed 7) by hand, before reading the agent labels, in `hand_labels.json`.
4. `scripts/score.py score` checks the agent labels against the hand labels and writes `data/agent-logs.json`.
5. `scripts/ci_summary.py` reads GitHub Actions run pages and writes `data/ci-runs.json`.

Label quality on the 40-message sample: precision 0.86, recall 0.90, and 35 of 40 matched exactly.

## Results

468 messages in 55 threads. **193 messages (41%) correct friction.**

| Code | Observation | Per 100 messages | Threads |
|---|---|---|---|
| PLAN_VERBOSE | Not aligned on the agent's plan | 11.8 | 21 |
| VERIFY | Hard to verify that the feature works and looks right | 8.8 | 12 |
| UNCLEAR_IMPL | Unclear what the agent built | 6.8 | 17 |
| STACK | Restating the tech stack | 4.9 | 15 |
| CI_SLOW | CI takes too long or fails | 4.1 | 9 |
| DESIGN_IGNORED | Agent does not apply design critique | 3.4 | 2 |
| CF_PERMS | Cloudflare deploy access | 2.6 | 3 |
| API_KEYS | Setting up API keys | 2.4 | 6 |
| ACCESS_UNAWARE | Agent does not know what it can access | 1.7 | 4 |

Findings:

- **Plan friction is about direction, not length.** Only 5 of 55 PLAN_VERBOSE messages are about length. The other 50 correct a misread intent (10.7 per 100).
- **VERIFY and DESIGN are mostly in `tempod`** (30 of 41 and 59 of 73). The user sent 130 screenshots in 53 messages.
- **DESIGN_IGNORED is concentrated:** 16 messages in 2 threads.
- **CF_PERMS, API_KEYS and CI_SLOW are mostly in `farstep`.**
- **No production errors appear in the logs.** The "production error → fix" step has no baseline.

Loop shape:

| Metric | Median | p90 |
|---|---|---|
| Words in the agent's last reply of a turn | 326 | 627 |
| User messages per thread | 5 | 17 |
| Minutes from the last event to the next user message | 1.0 | 28.8 |
| Agent tool calls between user messages | 8 | 53 |

19 messages came right after an interrupt. No thread used plan mode, so plan length is measured from reply length.

CI (`CI` workflow; the time includes setup):

| Day | Runs | Failed | Median min | p90 min |
|---|---|---|---|---|
| Oct 11 | 21 | 6 | 3.8 | 4.3 |
| Oct 12 | 65 | 20 | 5.1 | 6.3 |
| Oct 13 | 97 | 29 | 5.1 | 6.6 |
| Oct 14 | 29 | 15 | 4.6 | 5.9 |
| Oct 15 | 15 | 2 | 3.1 | 4.5 |

`Daemon image tests`: 58 runs, 0 failed, median 3.8–4.2 min.

## Limits

- The data covers 11 days. Some projects have few threads.
- The labels come from agents. Use them to rank problems, not as exact counts.
- PLAN_VERBOSE mixes length and direction. The split uses a keyword match on each label's reason.
- The data does not include the time lost to each problem.
- Only local agent logs are included. It does not include Tempo's WorkspaceDO events or Conductor's own logs.

## Run it again

```sh
python3 -I scripts/parse.py <claude-export> <codex-export> <out>
python3 -I scripts/score.py split <out>
# label batch0..3 with label-prompt.md, hand-label the ids in sample_ids.json into hand_labels.json
python3 -I scripts/score.py score <out> data/agent-logs.json
python3 -I scripts/ci_summary.py runs-page*.json > data/ci-runs.json
```

Keep the codes and the seed the same so that the new numbers compare with this baseline.
