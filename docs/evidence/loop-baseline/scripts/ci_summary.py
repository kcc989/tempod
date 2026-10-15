"""Summarize GitHub Actions runs by workflow and day.

Input: one or more JSON pages from GET /repos/{owner}/{repo}/actions/runs?status=completed&per_page=100.
Usage: python3 -I ci_summary.py page1.json page2.json ... > ci.json
Duration is run_started_at to updated_at, so it includes setup. It is not billed runner minutes.
"""
import json, statistics as st, sys
from collections import defaultdict
from datetime import datetime

runs = {}
for f in sys.argv[1:]:
    for r in json.load(open(f))['workflow_runs']:
        runs[r['id']] = r
g = defaultdict(list)
for r in runs.values():
    a = datetime.fromisoformat(r['run_started_at'].replace('Z', '+00:00'))
    b = datetime.fromisoformat(r['updated_at'].replace('Z', '+00:00'))
    g[(r['name'], r['created_at'][:10])].append((r['conclusion'], (b - a).total_seconds() / 60))
rows = []
for (name, day), v in sorted(g.items()):
    ms = sorted(x for _, x in v)
    rows.append(dict(workflow=name, day=day, runs=len(v), success=sum(c == 'success' for c, _ in v),
                     failure=sum(c == 'failure' for c, _ in v), median_min=round(st.median(ms), 1),
                     p90_min=round(ms[int(.9 * (len(ms) - 1))], 1)))
json.dump(dict(runs=len(runs), rows=rows), sys.stdout, indent=2)
