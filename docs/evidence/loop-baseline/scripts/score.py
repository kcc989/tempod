"""Split messages for labelling, then score the labels and write aggregate results.

Usage:
  python3 -I score.py split <out-dir>          # writes batch0..3.jsonl and sample_ids.json
  python3 -I score.py score <out-dir> <json>   # reads labels0..3.jsonl and hand_labels.json
  python3 -I score.py lost <out-dir> <json>    # minutes lost to each friction code

The output JSON holds only counts. It holds no message text.
"""
import json, os, random, re, statistics as st, sys
from datetime import datetime
from collections import Counter, defaultdict

OBS = ['STACK', 'CF_PERMS', 'API_KEYS', 'CI_SLOW', 'UNCLEAR_IMPL', 'PLAN_VERBOSE', 'DESIGN',
       'DESIGN_IGNORED', 'ACCESS_UNAWARE', 'VERIFY', 'HEADLESS']
FRICTION = [c for c in OBS if c not in ('DESIGN', 'HEADLESS')]
# PLAN_VERBOSE labels whose reason is about length; the rest are about direction.
LENGTH = re.compile(r'(?i)verbos|long|concise|short|simpl|clear|overkill|too (much|big|complex)|scope')
NO_ACCESS = re.compile(
    r"(?i)\b(i|we) (?:do not|don't|can't|cannot|am unable to) (?:have )?(?:access|reach|authenticate|use the|see your)"
    r"|\bno access to\b|not (?:available|accessible) (?:in|from) (?:this|my) (?:environment|session|sandbox)"
    r"|permission (?:was )?denied|(?:don't|do not) have (?:the )?(?:credentials|permission|a token|an api key)")


def load(path):
    return [json.loads(l) for l in open(path)]


def med(x):
    return st.median(x) if x else 0


def p90(x):
    x = sorted(x)
    return x[int(.9 * (len(x) - 1))] if x else 0


def split(out):
    m = load(os.path.join(out, 'messages.jsonl'))
    for i in range(4):
        with open(os.path.join(out, f'batch{i}.jsonl'), 'w') as f:
            for x in m[i::4]:
                f.write(json.dumps(dict(id=x['id'], project=x['project'], agent_before=x['prev_assistant'][-700:],
                                        images=x['images'], after_interrupt=x['after_interrupt'],
                                        text=x['text'][:2000])) + '\n')
    random.seed(7)
    json.dump(sorted(random.sample(range(len(m)), 40)), open(os.path.join(out, 'sample_ids.json'), 'w'))


def score(out, dest):
    m = load(os.path.join(out, 'messages.jsonl'))
    a = load(os.path.join(out, 'assistant.jsonl'))
    th = json.load(open(os.path.join(out, 'threads.json')))
    L = {x['id']: x for i in range(4) for x in load(os.path.join(out, f'labels{i}.jsonl'))}
    assert set(L) == set(range(len(m))), 'every message needs one label line'
    n, nt = len(m), len(th)
    r = dict(messages=n, threads=nt, period=[m[0]['ts'][:10], m[-1]['ts'][:10]],
             by_source=Counter(x['source'] for x in m))

    H = {int(k): set(v) for k, v in json.load(open(os.path.join(out, 'hand_labels.json'))).items()}
    tp = fp = fn = 0
    for c in OBS:
        tp += sum(1 for i in H if c in H[i] and c in L[i]['codes'])
        fp += sum(1 for i in H if c not in H[i] and c in L[i]['codes'])
        fn += sum(1 for i in H if c in H[i] and c not in L[i]['codes'])
    r['agreement'] = dict(sample=len(H), precision=round(tp / (tp + fp), 2), recall=round(tp / (tp + fn), 2),
                          exact=sum(1 for i in H if H[i] & set(OBS) == set(L[i]['codes']) & set(OBS)))

    msgs, threads = Counter(), defaultdict(set)
    proj = defaultdict(Counter)
    for i, x in L.items():
        for c in x['codes']:
            msgs[c] += 1
            threads[c].add(m[i]['thread'])
            proj[m[i]['project'].split('-')[0]][c] += 1
    r['codes'] = {c: dict(messages=msgs[c], per_100=round(100 * msgs[c] / n, 1), threads=len(threads[c]))
                  for c in OBS + ['NEW_TASK', 'OTHER']}
    r['friction_messages'] = sum(1 for x in L.values() if set(x['codes']) & set(FRICTION))
    plan = [x for x in L.values() if 'PLAN_VERBOSE' in x['codes']]
    r['plan_corrections'] = dict(total=len(plan), about_length=sum(1 for x in plan if LENGTH.search(x['why'])))
    r['by_project'] = {p: dict(messages=sum(1 for x in m if x['project'].split('-')[0] == p),
                               **{c: proj[p][c] for c in OBS if proj[p][c]})
                       for p in sorted(proj, key=lambda p: -sum(proj[p].values()))[:6]}

    last = defaultdict(dict)
    for x in a:
        last[x['thread']][x['after_human']] = x
    fw = [v['words'] for d in last.values() for v in d.values()]
    gaps = [x['gap_s'] / 60 for x in m if x['gap_s'] is not None and x['idx'] > 0]
    tools = [x['tools_before'] for x in m if x['idx'] > 0]
    r['loop'] = dict(
        final_reply_words=dict(median=med(fw), p90=p90(fw)),
        human_messages_per_thread=dict(median=med([t['human'] for t in th]), p90=p90([t['human'] for t in th])),
        minutes_to_next_human_message=dict(median=round(med(gaps), 1), p90=round(p90(gaps), 1)),
        tool_calls_between_human_messages=dict(median=med(tools), p90=p90(tools)),
        messages_after_interrupt=sum(x['after_interrupt'] > 0 for x in m),
        messages_with_screenshots=sum(x['images'] > 0 for x in m),
        screenshots=sum(x['images'] for x in m),
        agent_no_access_replies=sum(1 for x in a if NO_ACCESS.search(x['text'])))
    json.dump(r, open(dest, 'w'), indent=2)
    print(json.dumps(r['agreement']), r['friction_messages'], 'friction messages of', n)


# A friction message costs the owner the time to notice and write it (its gap after the agent's last
# event, capped at NOTICE_CAP) plus the agent's rework until its last event before the next owner
# message (capped at REWORK_CAP). Longer gaps mean the owner was away. A message with several codes
# splits its minutes evenly. PLAN_VERBOSE is split into DIRECTION and PLAN_LENGTH by its reason.
NOTICE_CAP, REWORK_CAP = 30, 60


def lost(out, dest):
    m = load(os.path.join(out, 'messages.jsonl'))
    L = {x['id']: x for i in range(4) for x in load(os.path.join(out, f'labels{i}.jsonl'))}
    nxt = {}
    by_thread = defaultdict(list)
    for x in m:
        by_thread[x['thread']].append(x)
    for xs in by_thread.values():
        xs.sort(key=lambda x: x['idx'])
        for a, b in zip(xs, xs[1:]):
            nxt[a['id']] = b
    per = defaultdict(list)
    for x in m:
        codes = [c for c in L[x['id']]['codes'] if c in FRICTION]
        codes = [('PLAN_LENGTH' if LENGTH.search(L[x['id']]['why']) else 'DIRECTION') if c == 'PLAN_VERBOSE' else c
                 for c in codes]
        if not codes:
            continue
        notice = min((x['gap_s'] or 0) / 60, NOTICE_CAP)
        b = nxt.get(x['id'])
        rework = 0
        if b:
            rework = (datetime.fromisoformat(b['ts'].replace('Z', '+00:00')) -
                      datetime.fromisoformat(x['ts'].replace('Z', '+00:00'))).total_seconds() / 60 - (b['gap_s'] or 0) / 60
            rework = min(max(rework, 0), REWORK_CAP)
        for c in codes:
            per[c].append((notice + rework) / len(codes))
    n = len(m)
    r = dict(messages=n, notice_cap_min=NOTICE_CAP, rework_cap_min=REWORK_CAP,
             codes={c: dict(messages=len(v), minutes=round(sum(v), 1), minutes_per_100=round(100 * sum(v) / n, 1),
                            median=round(med(v), 1), p90=round(p90(v), 1))
                    for c, v in sorted(per.items(), key=lambda kv: -sum(kv[1]))})
    json.dump(r, open(dest, 'w'), indent=2)
    print(json.dumps({c: v['minutes'] for c, v in r['codes'].items()}))


if __name__ == '__main__':
    {'split': lambda: split(sys.argv[2]), 'score': lambda: score(sys.argv[2], sys.argv[3]),
     'lost': lambda: lost(sys.argv[2], sys.argv[3])}[sys.argv[1]]()
