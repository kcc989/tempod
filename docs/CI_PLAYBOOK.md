# Linear CI playbook audit

Audited on 2026-10-13 against `d37ea1d7fdfc4dbf83eb0ad70dc61ddae8c7f3bb`.
The initial workspace checkout preceded the existing CI improvements; this audit
and the change use current main instead. The scope is the fifteen recommendations
in the supplied Linear/StarSling playbook, with their conditional guardrails.

## Evidence and limits

Read the latest 20 runs of each workflow with `gh run list`, `gh run view --json
jobs`, and the jobs API for runner labels and step timestamps. All sampled jobs
used `ubuntu-latest`. The CI snapshot contained 19 completed runs and one running
run; the image workflow had 20 completed runs, including one cancellation.
These runs span different commits, earlier CI configurations, and both code and
documentation changes. Their aggregate medians describe the sample, not a
controlled before/after comparison.

| Executed step | Samples | Median seconds | Maximum seconds |
| --- | ---: | ---: | ---: |
| CI checkout | 18 | 1 | 3 |
| CI dependency installation (named step) | 14 | 28 | 36 |
| CI task-cache restore | 14 | 2 | 5 |
| CI Chromium restore | 14 | 6 | 13 |
| CI task-cache save (explicit step) | 10 | 3 | 6 |
| Image checkout | 20 | 1 | 4 |
| Image dependency installation | 20 | 21.5 | 37 |
| Image build and tests | 20 | 218.5 | 283 |

The median prefix from job start to the check command was 48 seconds across the
14 code-path runs that restored the task cache. Repeating this setup on added
shards would add runner time; overlapping stage durations cannot be summed as
wall time. The existing controlled cold benchmark in [CI.md](CI.md) completed
in 240 seconds ([run 38430168102](https://github.com/kcc989/tempod/actions/runs/38430168102)).

Run-log downloads were blocked by the environment's destination policy for
GitHub's log-storage hosts. This prevents checking import/transform timings,
checkout progress pauses, and cache-hit versus cache-miss logs. Rulesets and
branch-protection reads returned HTTP 403. No check is de-scoped on the assumption
that it is advisory.

## Decisions in playbook order

| # | Recommendation | Decision |
| --- | --- | --- |
| 1 | Faster runners | Keep the runner: the sample has one runner class and a cheaper dependency-install improvement remains; no comparable runner benchmark exists. |
| 2 | Native type-checking | Already implemented with pinned TypeScript 7.0.2 and bounded checker/task concurrency. |
| 3 | Lint without types | Already uses Oxlint with syntax rules; no ESLint type graph to remove. |
| 4 | Oxlint | Already uses pinned Oxlint 1.87.0; retain every rule, including the vendored anti-slop plugin. |
| 5 | Lighter checkouts | Already shallow (CI depth 2, image default depth 1); both jobs consume the checkout and CI fetches missing diff bases on demand. |
| 6 | Resilient checkout | Withhold: checkout is 1 second median, at most 4 seconds, with no measured stall tail; progress logs are unavailable. |
| 7 | Move writes off the critical path | Keep the 3-second task-cache save in the single required job; an extra job would violate the approved design and add setup/artifact handoff, while required-check settings cannot be read. |
| 8 | Preinstall shared dependencies | No repeated setup across multiple PR jobs: PR CI has one job; its installed Bun and Chromium are used. |
| 9 | Filtered installs | Apply the equivalent Bun workspace filters to image-workflow and test-image installs; keep the full installation in PR CI, which uses every workspace. |
| 10 | Drop costly caches / fix unstable keys | Keep caches: no dependency archive exists, hit/miss log evidence is unavailable, and the unique Turbo archive key intentionally publishes new immutable cumulative task results with stable restore prefixes. |
| 11 | Schema snapshots | No separately measured expensive migration-replay step exists; preserve real migration and storage-isolation coverage. |
| 12 | Batch short checks | Already one PR job with overlapping independent commands; do not add concurrency without the required full cold-workload benchmark. |
| 13 | Balance shards | No homogeneous shard matrix to rebalance; existing bounded file/case concurrency already fits the controlled cold benchmark, and the single-job policy remains. |
| 14 | Share module state | Withhold: UI/component projects use VM pools, Worker cases require storage isolation, and import-bound log thresholds cannot be established. |
| 15 | Reduce setup before adding shards | Apply recommendation 9 to image checks first; no new PR shards or runner starts, and no claim of savings from additional shards. |

## Filtered installation

Both image installs now use:

```sh
bun install --frozen-lockfile --filter tempo --filter @tempo/tempod
```

`tempo` retains the root tools used by `check:versions` and `build:tempod`.
`@tempo/tempod` brings in `@tempo/protocol`, `@tempo/settings`, Effect and the ACP
SDK. Source/test imports and the image script use that closure; they do not use
the Worker, UI, or Playwright workspace dependencies. The full production image
still installs its pinned agent tools and Chromium, and all image tests remain.
No package manifest, lockfile, test selection, runtime deadline, or runner changes.

Fresh installations in two copies of the same commit on this managed Linux
machine installed **847 packages in 19.05 seconds** without filters and **251
packages in 14.98 seconds** with filters. Both used Bun 1.4.2, the frozen lockfile
and the same package-store configuration. This is one local comparison, not a
hosted median or a promised CI saving. Compare the image workflow's install step
on subsequent relevant main pushes; the image install may have different cache
and network costs. The install command can be reverted independently.

For a broader history-based audit, the optional upstream skill is available with
`npx skills add starslingdev/skills --skill ci-speedup`. It was not installed as
part of this change.
