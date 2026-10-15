"""Summarize a friction log.

Usage: python3 -I summarize.py <log.csv> > summary.json
Each row: time (local ISO, minute precision), code, doing, minutes_lost. The output holds counts and
minutes only, so it can be committed. Keep the log itself out of the repo when "doing" is personal.
"""
import csv, json, sys
from collections import defaultdict

CODES = ['DIRECTION', 'VERIFY', 'UNCLEAR_IMPL', 'STACK', 'CI_SLOW', 'DESIGN_IGNORED', 'CF_PERMS', 'API_KEYS',
         'ACCESS_UNAWARE', 'EXIT_GITHUB', 'EXIT_CF_DASHBOARD', 'EXIT_OTHER']
rows = list(csv.DictReader(open(sys.argv[1])))
per, days = defaultdict(lambda: [0, 0.0]), set()
for i, r in enumerate(rows, 2):
    code = r['code'].strip().upper()
    if code not in CODES:
        sys.exit(f'line {i}: unknown code {code!r}')
    per[code][0] += 1
    per[code][1] += float(r['minutes_lost'])
    days.add(r['time'][:10])
json.dump(dict(rows=len(rows), days=sorted(days),
               codes={c: dict(rows=per[c][0], minutes=round(per[c][1], 1)) for c in CODES},
               exits=sum(per[c][0] for c in CODES if c.startswith('EXIT_'))), sys.stdout, indent=2)
