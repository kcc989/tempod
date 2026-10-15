"""Parse Claude Code and Codex session logs into messages.jsonl, assistant.jsonl and threads.json.

Usage: python3 -I parse.py <export-root>... <out-dir>
"""
import json, os, re, sys
from datetime import datetime
from collections import Counter

roots, out = sys.argv[1:-1], sys.argv[-1]
msgs, threads, asst = [], [], []


def t(ts):
    return datetime.fromisoformat(ts.replace('Z', '+00:00'))


def text_of(c):
    if isinstance(c, str):
        return c
    return ''.join(x.get('text', '') for x in c or [] if isinstance(x, dict) and x.get('type') in ('text', 'input_text'))


def noise(s):
    s = s.lstrip()
    if s.startswith(('<pasted_content', '<bash-input')):
        return False
    return (not s or s.startswith(('<', '# AGENTS', 'Caveat:', '[Request interrupted'))
            or 'This session is being continued' in s[:200])


def add_thread(src, path, project, items):
    items = sorted((i for i in items if i[0]), key=lambda i: i[0])
    if not items:
        return
    tid = os.path.basename(path).rsplit('.', 1)[0]
    last_asst, tools_since, last_ts, n_h = '', 0, None, 0
    pend = Counter()
    for ts, kind, txt in items:
        if kind in ('interrupt', 'image', 'login'):
            pend[kind] += 1
            continue
        if kind == 'human':
            msgs.append(dict(source=src, thread=tid, project=project, ts=ts, idx=n_h, text=txt[:4000],
                             prev_assistant=last_asst[-1500:], tools_before=tools_since,
                             gap_s=None if last_ts is None else (t(ts) - t(last_ts)).total_seconds(),
                             after_interrupt=pend['interrupt'], images=pend['image'] + txt.count('[Image'),
                             logins_before=pend['login']))
            pend = Counter()
            n_h += 1
            tools_since = 0
        elif kind == 'assistant':
            last_asst = txt
            if txt.strip():
                asst.append(dict(source=src, thread=tid, project=project, ts=ts, after_human=n_h - 1,
                                 words=len(txt.split()), text=txt[:6000]))
        else:
            tools_since += 1
        last_ts = ts
    if n_h:
        threads.append(dict(source=src, thread=tid, project=project, start=items[0][0], end=items[-1][0],
                            human=n_h, interrupts=sum(1 for i in items if i[1] == 'interrupt'), images=sum(1 for i in items if i[1] == 'image'), tools=sum(1 for i in items if i[1] == 'tool')))


def claude(path):
    if '/subagents/' in path:
        return
    proj = path.split('/projects/')[1].split('/')[0]
    proj = re.sub(r'^-Users-[^-]+-', '', proj).split('--claude-worktrees')[0]
    proj = proj.replace('projects-', '').replace('conductor-workspaces-', '')
    items = []
    for line in open(path, errors='ignore'):
        try:
            e = json.loads(line)
        except Exception:
            continue
        m = e.get('message') or {}
        if e.get('type') == 'user' and not e.get('isSidechain'):
            c = m.get('content')
            if isinstance(c, list) and any(isinstance(x, dict) and x.get('type') == 'tool_result' for x in c):
                continue
            s = text_of(c)
            ts = e.get('timestamp')
            if isinstance(c, list):
                for x in c:
                    if isinstance(x, dict) and x.get('type') == 'image':
                        items.append((ts, 'image', ''))
            if s.lstrip().startswith('[Request interrupted'):
                items.append((ts, 'interrupt', ''))
            elif '<command-name>/login' in s:
                items.append((ts, 'login', ''))
            elif e.get('isMeta') and s.lstrip().startswith('[Image'):
                pass
            elif not noise(s):
                items.append((ts, 'human', s))
        elif e.get('type') == 'assistant' and isinstance(m.get('content'), list):
            for x in m['content']:
                if x.get('type') == 'tool_use':
                    items.append((e.get('timestamp'), 'tool', ''))
                elif x.get('type') == 'text':
                    items.append((e.get('timestamp'), 'assistant', x['text']))
    add_thread('claude', path, proj, items)


def codex(path, src):
    meta, items = None, []
    for line in open(path, errors='ignore'):
        try:
            e = json.loads(line)
        except Exception:
            continue
        p = e.get('payload') or {}
        if e.get('type') == 'session_meta' and meta is None:
            meta = p
        if e.get('type') == 'event_msg' and p.get('type') == 'turn_aborted':
            items.append((e['timestamp'], 'interrupt', ''))
        if e.get('type') != 'response_item':
            continue
        if p.get('type') == 'message':
            s = text_of(p.get('content'))
            if p.get('role') == 'user' and '<turn_aborted>' in s:
                items.append((e['timestamp'], 'interrupt', ''))
            elif p.get('role') == 'user' and not noise(s):
                for x in p.get('content') or []:
                    if isinstance(x, dict) and x.get('type') == 'input_image':
                        items.append((e['timestamp'], 'image', ''))
                items.append((e['timestamp'], 'human', s))
            elif p.get('role') == 'assistant':
                items.append((e['timestamp'], 'assistant', s))
        elif p.get('type') in ('function_call', 'custom_tool_call', 'local_shell_call'):
            items.append((e['timestamp'], 'tool', ''))
    if not meta or meta.get('thread_source') not in (None, 'user'):
        return
    add_thread(src, path, (meta.get('cwd') or '').rstrip('/').split('/')[-1], items)


for r in roots:
    for d, _, fs in os.walk(r):
        for f in fs:
            if not f.endswith('.jsonl'):
                continue
            p = os.path.join(d, f)
            if '/.claude/' in p:
                claude(p)
            elif '/.codex/' in p:
                codex(p, 'codex-archived' if 'archived' in r else 'codex')

msgs.sort(key=lambda m: m['ts'])
with open(os.path.join(out, 'messages.jsonl'), 'w') as fh:
    for i, m in enumerate(msgs):
        m['id'] = i
        fh.write(json.dumps(m) + '\n')
with open(os.path.join(out, 'assistant.jsonl'), 'w') as fh:
    for a in sorted(asst, key=lambda a: a['ts']):
        fh.write(json.dumps(a) + '\n')
json.dump(threads, open(os.path.join(out, 'threads.json'), 'w'), indent=1)
print(len(threads), 'threads', len(msgs), 'human messages', len(asst), 'assistant messages')
print(Counter(m['source'] for m in msgs))
print(Counter(m['project'] for m in msgs).most_common(15))
