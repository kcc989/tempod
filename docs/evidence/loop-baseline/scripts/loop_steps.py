"""Measure the steps of the loop from GitHub and Cloudflare exports.

Usage: python3 -I loop_steps.py <in-dir> > data/loop-steps.json

<in-dir> holds:
  prs.jsonl         gh api repos/{o}/{r}/pulls?state=all --jq '.[] | {n:.number, created:.created_at, merged:.merged_at, head:.head.ref, merge_sha:.merge_commit_sha}'
  pr_commits.jsonl  per PR: {n, first: min author date, count, shas}
  runs.jsonl        gh api repos/{o}/{r}/actions/runs --jq '.workflow_runs[] | {id, name, event, sha:.head_sha, c:.conclusion, created:.created_at, started:.run_started_at, updated:.updated_at, attempt:.run_attempt}'
  versions.json     GET /accounts/{a}/workers/scripts/{name}/versions
  incidents.json    [{version, deployed, first_error, last_error, fix_version, fix_deployed, errors}] from the telemetry query API

Times are minutes. p90 uses the same nearest-rank rule as score.py.
"""
import json, os, statistics as st, sys
from collections import defaultdict
from datetime import datetime

d = sys.argv[1]


def load(f):
    return [json.loads(l) for l in open(os.path.join(d, f))]


def t(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00'))


def mins(a, b):
    return (t(b) - t(a)).total_seconds() / 60


def stat(x):
    x = sorted(x)
    if not x:
        return dict(n=0)
    return dict(n=len(x), median=round(st.median(x), 1), p90=round(x[int(.9 * (len(x) - 1))], 1))


prs = {p['n']: p for p in load('prs.jsonl')}
commits = {c['n']: c for c in load('pr_commits.jsonl')}
runs = [r for r in load('runs.jsonl') if r['name'] == 'CI' and r['c'] in ('success', 'failure')]
by_sha = defaultdict(list)
for r in runs:
    by_sha[r['sha']].append(r)
v = json.load(open(os.path.join(d, 'versions.json')))['result']
versions = sorted((x['metadata']['created_on'] for x in v.get('items', v)))

merged = [p for p in prs.values() if p['merged']]
work, review, ci_wait, ci_fail, merge_deploy = [], [], [], [], []
failed_prs = 0
for p in merged:
    c = commits[p['n']]
    if t(c['first']) <= t(p['created']):
        work.append(mins(c['first'], p['created']))
    review.append(mins(p['created'], p['merged']))
    pr_runs = [r for s in c['shas'] for r in by_sha[s] if r['event'] == 'pull_request']
    if pr_runs:
        fails = [r for r in pr_runs if r['c'] == 'failure']
        ci_fail.append(len(fails))
        failed_prs += bool(fails)
        green = [r for r in by_sha[c['shas'][-1]] if r['c'] == 'success' and r['event'] == 'pull_request']
        if green:
            ci_wait.append(mins(min(r['created'] for r in pr_runs), min(r['updated'] for r in green)))
    later = [x for x in versions if t(x) >= t(p['merged'])]
    if versions and t(p['merged']) >= t(versions[0]) and later:
        merge_deploy.append(mins(p['merged'], later[0]))

incidents = json.load(open(os.path.join(d, 'incidents.json')))
json.dump(dict(
    prs=dict(total=len(prs), merged=len(merged)),
    first_commit_to_pr_open=stat(work),
    pr_open_to_merge=stat(review),
    first_ci_run_to_green_on_final_head=stat(ci_wait),
    failed_ci_runs_per_pr=stat(ci_fail),
    prs_with_a_failed_ci_run=failed_prs,
    prs_with_ci_runs=len(ci_fail),
    merge_to_next_worker_version=stat(merge_deploy),
    worker_versions=len(versions),
    incidents=[dict(i, deploy_to_first_error=round(mins(i['deployed'], i['first_error']), 1),
                    first_error_to_fix_deployed=round(mins(i['first_error'], i['fix_deployed']), 1))
               for i in incidents],
), sys.stdout, indent=2)
