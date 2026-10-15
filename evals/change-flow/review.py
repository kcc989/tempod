"""Replays one review case under one condition.

Claude models run as Claude Code (`claude -p`) in a worktree at the head commit, with read-only tools, as a Tempo
Claude run would. Other models run through a small read-only tool loop on an OpenAI-compatible endpoint
(Cloudflare Workers AI or OpenRouter).

usage: python3 -I evals/change-flow/review.py <case-id> <condition> [--out DIR]

Conditions:
  baseline     the starter `reviewer` (packages/agents-starter) with tab 08 run texts, on the author's model family
  design       the proposed cold-context `verifier` on a different model family, with evidence checks
  design-same  the proposed verifier prompt on the baseline model (ablation: prompt only)
  design-exec  design-same plus permission to run tests and scratch probes (ablation: execution verifier)
"""

import json
import os
import pathlib
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
HERE = pathlib.Path(__file__).resolve().parent
WT_ROOT = pathlib.Path(os.environ.get("CHANGE_FLOW_WORKTREES", "/tmp/change-flow-worktrees"))
DIFF_CAP = 256 * 1024  # 08 Runs step 6: one block is at most 256 KiB
TOOL_CAP = 16 * 1024
MAX_STEPS = int(os.environ.get("CHANGE_FLOW_MAX_STEPS", "30"))

BASE_MODEL = "claude-cli:claude-opus-5-5"
CROSS_MODEL = {"claude": os.environ.get("CHANGE_FLOW_CROSS_MODEL", "workers-ai:@cf/moonshotai/kimi-k2.7-code"), "codex": BASE_MODEL}
CLAUDE_TOOLS = ["Read", "Grep", "Glob", "Bash(ls:*)", "Bash(wc:*)"] + [f"Bash(git {c}:*)" for c in ("diff", "show", "log", "blame", "grep", "ls-files")]
EXEC_TOOLS = ["Bash(bun:*)", "Bash(bunx:*)", "Bash(node:*)", "Bash(cargo test:*)", "Bash(cat:*)", "Bash(mkdir -p /tmp/:*)"]
EXEC_TEXT = (
    "You may also execute code to check behavior: run the repository's tests for the changed area, and write scratch "
    "probes under /tmp (for example with bun -e) that load the real installed SDKs and call the changed functions. "
    "Prefer an executed probe over reading when a claim depends on how a real dependency behaves. Do not change files "
    "under the repository."
)

STARTER_PROMPT = (
    "Review the diff against the plan. Report each problem as a finding. Mark a finding blocking when the change "
    "must not merge with it. Set status pass when no finding is blocking, else fail."
)
RUN_HEADER = (
    'You are running as the Tempo agent "Reviewer" for this change: '
    "Reviews the branch diff against the plan and reports blocking issues."
)
READ_ONLY = (
    "This agent is read-only. Do not create, change, move or delete files under /workspace, and do not run commands "
    "that do, such as formatters, code generators or git commands that change the branch. You may read files and run "
    "commands that only read. Tempo compares the files before and after each turn and shows a warning if they differ."
)
REVIEW_KIND = (
    'When you finish, call the report_result tool once with a status of "pass", "fail" or "blocked", a summary, and '
    "each problem as a finding. Mark a finding blocking when the change must not merge with it. Do not end your turn "
    "before you call it."
)

VERIFIER_PROMPT = (HERE / "verifier-prompt.txt").read_text()
VERIFIER_HEADER = (
    'You are running as the Tempo agent "Verifier" for this change: '
    "Independently verifies the change at its head SHA and reports blocking findings with evidence."
)
VERIFIER_KIND = (
    'When you finish, call the report_result tool once with a status of "pass", "fail" or "blocked", a summary, '
    "`checked` (each risk you checked and the paths you read for it), and each problem as a finding. Every blocking "
    "finding needs evidence: a quote copied exactly from a file at the head commit and why it fails. Tempo checks "
    "each quote and each checked path against this run's trace; unsupported claims do not count. Do not end your "
    "turn before you call it."
)

READ_CMDS = {"git", "rg", "ls", "cat", "sed", "head", "tail", "wc", "find", "grep"}
GIT_READ = {"diff", "show", "log", "blame", "ls-files", "grep", "rev-parse", "cat-file"}


def sh(args, cwd=ROOT, check=True):
    return subprocess.run(args, cwd=cwd, check=check, capture_output=True, text=True).stdout


def load_case(case_id):
    cases = json.loads((HERE / "cases.json").read_text())["cases"]
    return next(c for c in cases if c["id"] == case_id)


def link_dependencies(wt):
    """Links the main checkout's installed packages, as a Tempo workspace has them after setup. Versions follow the
    main checkout, not the case's commit."""
    for nm in [ROOT / "node_modules", *ROOT.glob("apps/*/node_modules"), *ROOT.glob("packages/*/node_modules"), *ROOT.glob("tests/*/node_modules")]:
        target = wt / nm.relative_to(ROOT)
        if nm.is_dir() and target.parent.is_dir() and not target.exists():
            target.symlink_to(nm)


def prepare(case):
    """Returns (worktree, base, head, change_text)."""
    wt = WT_ROOT / case["id"]
    if not wt.exists():
        WT_ROOT.mkdir(parents=True, exist_ok=True)
        sh(["git", "worktree", "add", "-f", "--detach", str(wt), case["head"]])
        if case["kind"] == "seed":
            sh(["git", "apply", str(HERE / "seeds" / f"{case['patch']}.patch")], cwd=wt)
            sh(["git", "-c", "user.name=seed", "-c", "user.email=seed@example.invalid", "commit", "-qam", case["message"]], cwd=wt)
    link_dependencies(wt)
    head = sh(["git", "rev-parse", "HEAD"], cwd=wt).strip()
    base = sh(["git", "rev-parse", "HEAD^"], cwd=wt).strip()
    change = case.get("message") or sh(["git", "show", "-s", "--format=%B", head], cwd=wt)
    change = re.sub(r"(?m)^(Co-Authored-By|Co-authored-by|Claude-Session):.*$", "", change).strip()
    return wt, base, head, change


def cut(text, cap):
    data = text.encode()
    if len(data) <= cap:
        return text
    return data[:cap].decode(errors="ignore") + "\n[Tempo: cut at 256 KiB]"


def run_cmd(wt, command):
    import shlex

    command = command.replace("/workspace/", "").replace("/workspace", ".")
    try:
        argv = shlex.split(command)
    except ValueError as e:
        return f"error: {e}"
    if not argv or argv[0] not in READ_CMDS or any(t in command for t in [">", "|", ";", "&", "`", "$("]):
        return "error: only single read-only commands are allowed: " + ", ".join(sorted(READ_CMDS))
    if argv[0] == "git" and (len(argv) < 2 or argv[1] not in GIT_READ):
        return "error: git subcommand not allowed"
    if argv[0] == "sed" and "-i" in argv:
        return "error: sed -i is not allowed"
    try:
        out = subprocess.run(argv, cwd=wt, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        return "error: timeout"
    text = (out.stdout + out.stderr)
    return cut(text, TOOL_CAP) if text else f"(exit {out.returncode}, no output)"


def in_repo(wt, path):
    """In Tempo the repository is /workspace; the replay maps that prefix to the worktree."""
    for prefix in ("/workspace/", str(wt) + "/"):
        if path.startswith(prefix):
            return path[len(prefix):]
    return "." if path in ("/workspace", str(wt)) else path


def read_file(wt, path, start=1, end=None):
    p = (wt / in_repo(wt, path)).resolve()
    if not str(p).startswith(str(wt.resolve())) or not p.is_file():
        return "error: no such file"
    lines = p.read_text(errors="replace").splitlines()
    end = min(end or start + 399, len(lines))
    body = "\n".join(f"{i}\t{lines[i - 1]}" for i in range(max(start, 1), end + 1))
    return cut(body, TOOL_CAP) + (f"\n[{len(lines)} lines total]" if end < len(lines) else "")


def tools(design):
    finding = {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "line": {"type": "integer", "minimum": 1},
            "text": {"type": "string"},
            "blocking": {"type": "boolean"},
        },
        "required": ["path", "text", "blocking"],
    }
    report = {"status": {"type": "string", "enum": ["pass", "fail", "blocked"]}, "summary": {"type": "string"}, "findings": {"type": "array", "items": finding}}
    required = ["status", "summary"]
    if design:
        finding["properties"]["evidence"] = {
            "type": "object",
            "properties": {"quote": {"type": "string"}, "why": {"type": "string"}},
            "required": ["quote", "why"],
        }
        report["checked"] = {
            "type": "array",
            "items": {"type": "object", "properties": {"risk": {"type": "string"}, "paths": {"type": "array", "items": {"type": "string"}}}, "required": ["risk", "paths"]},
        }
        required.append("checked")
    fn = lambda name, desc, props, req: {"type": "function", "function": {"name": name, "description": desc, "parameters": {"type": "object", "properties": props, "required": req}}}
    return [
        fn("read_file", "Read lines of a repository file at the head commit.", {"path": {"type": "string"}, "start": {"type": "integer"}, "end": {"type": "integer"}}, ["path"]),
        fn("shell", "Run one read-only command in the repository root: git diff/show/log/blame/grep, rg, ls, cat, sed -n, head, tail, wc, find, grep. No pipes.", {"command": {"type": "string"}}, ["command"]),
        fn("report_result", "Report the review result.", report, required),
    ]


def endpoint(model):
    provider, name = model.split(":", 1)
    if provider == "workers-ai":
        account = os.environ["CLOUDFLARE_ACCOUNT_ID"]
        # The session proxy adds the Cloudflare credential.
        return f"https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1/chat/completions", name, {}
    return "https://openrouter.ai/api/v1/chat/completions", name, {"Authorization": f"Bearer {os.environ['OPENROUTER_API_KEY']}"}


def chat(model, messages, tool_defs, force_report=False):
    url, name, auth = endpoint(model)
    req_body = {"model": name, "messages": messages, "tools": tool_defs, "usage": {"include": True}, "max_tokens": 8000}
    if force_report:
        req_body["tool_choice"] = {"type": "function", "function": {"name": "report_result"}}
    body = json.dumps(req_body).encode()
    for attempt in range(8):
        req = urllib.request.Request(url, data=body, headers={**auth, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                data = json.loads(r.read())
            if "choices" in data:
                return data
            err = data
        except urllib.error.HTTPError as e:  # the loop retries the same request
            err = f"{e} {e.read()[:300]!r} body={len(body)}B"
        except Exception as e:
            err = str(e)
        print(f"retry {attempt + 1}: {err}", file=sys.stderr)
        time.sleep(min(2 ** (attempt + 1), 60))
    raise RuntimeError(f"{url} failed: {err}")


def run_claude(model, wt, system, user, design, extra_tools=()):
    schema = json.dumps(tools(design)[-1]["function"]["parameters"])
    prompt = (
        user + "\n\nThe report_result tool is not connected in this replay. Instead, end with one fenced json block "
        "that holds exactly the input you would pass to report_result, with this JSON Schema: " + schema
    )
    cmd = ["claude", "-p", "--model", model.split(":", 1)[1], "--system-prompt", system, "--strict-mcp-config",
           "--output-format", "stream-json", "--verbose", "--max-turns", str(MAX_STEPS),
           "--allowedTools", *CLAUDE_TOOLS, *extra_tools, "--disallowedTools", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Agent", "Task"]
    out = subprocess.run(cmd, cwd=wt, input=prompt, capture_output=True, text=True, timeout=3600)
    trace, trace_paths, usage, text = [], set(), {"prompt_tokens": 0, "completion_tokens": 0, "cost": 0.0}, ""
    for line in out.stdout.splitlines():
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        if e.get("type") == "assistant":
            for b in e["message"]["content"]:
                if b.get("type") == "tool_use":
                    args = b.get("input") or {}
                    trace.append({"tool": b["name"], "args": args})
                    for k in ("file_path", "path"):
                        if args.get(k):
                            trace_paths.add(str(args[k]).replace(str(wt) + "/", ""))
                    trace_paths.update(t for t in str(args.get("command", "")).split() if "/" in t or "." in t)
        if e.get("type") == "result":
            text = e.get("result") or ""
            u = e.get("usage") or {}
            usage["prompt_tokens"] = u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
            usage["completion_tokens"] = u.get("output_tokens", 0)
            usage["cost"] = e.get("total_cost_usd") or 0.0
    blocks = re.findall(r"```json\s*(\{.*?\})\s*```", text, re.S)
    report = None
    for raw in reversed(blocks or [text[text.find("{"): text.rfind("}") + 1]]):
        try:
            report = json.loads(raw)
            break
        except json.JSONDecodeError:
            continue
    return report, trace, trace_paths, usage


def evidence_check(wt, report, trace_paths):
    """Downgrades unsupported blocking findings and fails closed on an unsupported pass (design only)."""
    notes = []
    for f in report.get("findings") or []:
        if not f.get("blocking"):
            continue
        quote = (f.get("evidence") or {}).get("quote", "").strip()
        p = (wt / in_repo(wt, f.get("path", ""))).resolve()
        ok = bool(quote) and p.is_file() and str(p).startswith(str(wt.resolve()))
        if ok:
            text = re.sub(r"\s+", " ", p.read_text(errors="replace"))
            ok = re.sub(r"\s+", " ", quote) in text
        if not ok:
            f["blocking"] = False
            f["unsupported"] = True
            notes.append(f"unsupported: {f.get('path')}")
    if report.get("status") == "pass":
        checked = [p for c in report.get("checked") or [] for p in c.get("paths", [])]
        if not checked or not any(any(t.endswith(p.lstrip("./")) or p in t for t in trace_paths) for p in checked):
            report["status"] = "blocked"
            notes.append("pass without trace-backed checks: blocked")
    if report.get("status") == "fail" and not any(f.get("blocking") for f in report.get("findings") or []):
        report["status"] = "blocked"
        notes.append("fail with no supported blocking finding: blocked")
    return notes


def main():
    case_id, condition = sys.argv[1], sys.argv[2]
    out_dir = pathlib.Path(sys.argv[sys.argv.index("--out") + 1]) if "--out" in sys.argv else HERE / "results"
    out_dir.mkdir(parents=True, exist_ok=True)
    case = load_case(case_id)
    wt, base, head, change = prepare(case)
    diff = sh(["git", "diff", base, head], cwd=wt)
    design = condition.startswith("design")
    model = CROSS_MODEL[case["author"]] if condition == "design" else BASE_MODEL

    if design:
        stat = sh(["git", "diff", "--stat=200", base, head], cwd=wt)
        system = VERIFIER_PROMPT
        blocks = [
            VERIFIER_HEADER,
            READ_ONLY,
            VERIFIER_KIND,
            f"Base {base}, head {head}. Page any file's full diff with: git diff {base} {head} -- <path>",
            "Files changed:\n" + stat,
            "The branch diff:\n" + cut(diff, DIFF_CAP),
        ]
    else:
        system = STARTER_PROMPT
        blocks = [RUN_HEADER, READ_ONLY, REVIEW_KIND, "The change's request:\n" + change, "The branch diff:\n" + cut(diff, DIFF_CAP)]

    messages = [{"role": "system", "content": system}, {"role": "user", "content": "\n\n".join(blocks)}]
    tool_defs = tools(design)
    usage = {"prompt_tokens": 0, "completion_tokens": 0, "cost": 0.0}
    trace, trace_paths, report, started = [], set(), None, time.time()

    if condition == "design-exec":
        blocks.insert(3, EXEC_TEXT)
    if model.startswith("claude-cli:"):
        extra = EXEC_TOOLS if condition == "design-exec" else ()
        report, trace, trace_paths, usage = run_claude(model, wt, system, "\n\n".join(blocks), design, extra)

    for step in range(0 if model.startswith("claude-cli:") else MAX_STEPS):
        if step == int(MAX_STEPS * 0.75):
            # Tool-loop models have no turn end; this stands in for the run timeout's pressure.
            messages.append({"role": "user", "content": "You have used most of this run's budget. Finish your checks and call the report_result tool soon."})
        if step == MAX_STEPS - 1:
            messages.append({"role": "user", "content": "Tempo did not get your result. Finish the work if it is not complete, call the report_result tool, then end your turn."})
        tool_msgs = [m for m in messages if m["role"] == "tool"]
        for old in tool_msgs[:-8]:
            old["content"] = "[Tempo replay: older tool output dropped to fit the context window]"
        data = chat(model, messages, tool_defs, force_report=step == MAX_STEPS - 1)
        for k in ("prompt_tokens", "completion_tokens"):
            usage[k] += data.get("usage", {}).get(k, 0)
        usage["cost"] += data.get("usage", {}).get("cost", 0) or 0
        usage["neurons"] = usage.get("neurons", 0) + (data.get("usage", {}).get("neurons", 0) or 0)
        msg = data["choices"][0]["message"]
        calls = msg.get("tool_calls") or []
        messages.append({"role": "assistant", "content": msg.get("content") or "", **({"tool_calls": calls} if calls else {})})
        if not calls:
            messages.append({"role": "user", "content": "Tempo did not get your result. Finish the work if it is not complete, call the report_result tool, then end your turn."})
            continue
        for call in calls:
            name = call["function"]["name"]
            try:
                args = json.loads(call["function"].get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {}
            if name == "report_result":
                report = args
                result = "ok"
            elif name == "read_file":
                trace_paths.add(in_repo(wt, args.get("path", "")))
                result = read_file(wt, args.get("path", ""), int(args.get("start") or 1), args.get("end") and int(args["end"]))
            elif name == "shell":
                trace_paths.update(t for t in args.get("command", "").split() if "/" in t or "." in t)
                result = run_cmd(wt, args.get("command", ""))
            else:
                result = "error: unknown tool"
            trace.append({"tool": name, "args": args if name != "report_result" else "(report)"})
            messages.append({"role": "tool", "tool_call_id": call["id"], "content": result})
        if report is not None:
            break

    notes = evidence_check(wt, report, trace_paths) if (design and report) else []
    out = {
        "case": case_id,
        "condition": condition,
        "model": model,
        "head": head,
        "diffBytes": len(diff.encode()),
        "diffCut": len(diff.encode()) > DIFF_CAP,
        "steps": len(trace),
        "seconds": round(time.time() - started, 1),
        "usage": usage,
        "report": report,
        "evidenceNotes": notes,
        "trace": trace,
    }
    (out_dir / f"{case_id}.{condition}.json").write_text(json.dumps(out, indent=2))
    blocking = sum(1 for f in (report or {}).get("findings") or [] if f.get("blocking"))
    print(f"{case_id} {condition} {model} status={(report or {}).get('status')} blocking={blocking} steps={len(trace)} cost=${usage['cost']:.2f}")


if __name__ == "__main__":
    main()
