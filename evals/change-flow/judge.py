"""Scores review results against the known defects in cases.json.

usage: python3 -I evals/change-flow/judge.py [results-dir]

A defect is caught when a blocking finding names the same failure. Clean cases count a false positive when any
blocking finding is raised. The judge sees the defect text and the findings; the reviewer never saw the defect text.
"""

import json
import os
import subprocess
import pathlib
import sys
import time
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
JUDGE_MODEL = "@cf/deepseek-ai/deepseek-v4-pro-0813"  # Workers AI; a third model family, neither reviewer's
CONDITIONS = ["baseline", "design", "design-same", "design-exec"]


def ask(prompt):
    body = json.dumps({"model": JUDGE_MODEL, "messages": [{"role": "user", "content": prompt}], "temperature": 0, "max_tokens": 16000}).encode()
    url = f"https://api.cloudflare.com/client/v4/accounts/{os.environ['CLOUDFLARE_ACCOUNT_ID']}/ai/v1/chat/completions"
    for attempt in range(8):
        # The session proxy adds the Cloudflare credential.
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                text = json.loads(r.read())["choices"][0]["message"]["content"]
            return json.loads(text[text.find("{"): text.rfind("}") + 1])
        except Exception as e:  # a 502, or no JSON in the answer; ask again
            print(f"judge retry {attempt + 1}: {str(e)[:200]}", file=sys.stderr)
            time.sleep(min(2 ** (attempt + 1), 60))
    raise RuntimeError("judge failed")


SKIP = ("docs/", "bun.lock", "Cargo.lock", "generated.rs", "packages/protocol/schema/", ".md", ".png", ".json")


def coverage(case, result):
    """Share of changed source files the reviewer saw: in the uncut part of the diff block, or read in its trace."""
    wt = pathlib.Path(os.environ.get("CHANGE_FLOW_WORKTREES", "/tmp/change-flow-worktrees")) / case["id"]
    head = result["head"]
    git = lambda *a: subprocess.run(["git", *a], cwd=wt, capture_output=True, text=True).stdout
    files = [f for f in git("diff", "--name-only", f"{head}^", head).split() if not f.endswith(SKIP) and not f.startswith(SKIP)]
    if not files:
        return None
    shown = git("diff", f"{head}^", head).encode()[: 256 * 1024].decode(errors="ignore")
    seen = {f for f in files if f"diff --git a/{f} " in shown}
    text = json.dumps(result.get("trace", []))
    seen |= {f for f in files if f in text}
    return len(seen) / len(files)


def judge(case, result):
    findings = [f for f in (result.get("report") or {}).get("findings") or [] if f.get("blocking")]
    if not case["defects"]:
        return {}
    if not findings:
        return {d["id"]: False for d in case["defects"]}
    listing = "\n".join(f"[{i}] {f.get('path')}:{f.get('line', '')} {f.get('text')}" for i, f in enumerate(findings))
    defects = "\n".join(f"{d['id']}: ({', '.join(d['paths'])}) {d['text']}" for d in case["defects"])
    prompt = (
        "Known defects:\n" + defects + "\n\nBlocking findings from a code review:\n" + listing + "\n\n"
        "For each defect, answer true only if at least one finding identifies the same failure (same cause, not just "
        'the same file). Reply as JSON: {"<defect id>": {"caught": true|false, "finding": <index or null>}}'
    )
    answer = ask(prompt)
    return {d["id"]: bool((answer.get(d["id"]) or {}).get("caught")) for d in case["defects"]}


def main():
    results = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "results"
    cases = json.loads((HERE / "cases.json").read_text())["cases"]
    rows = []
    for case in cases:
        for cond in CONDITIONS:
            path = results / f"{case['id']}.{cond}.json"
            if not path.exists():
                continue
            result = json.loads(path.read_text())
            report = result.get("report") or {}
            blocking = [f for f in report.get("findings") or [] if f.get("blocking")]
            rows.append({
                "case": case["id"], "kind": case["kind"], "condition": cond, "model": result["model"],
                "status": report.get("status"), "blocking": len(blocking),
                "caught": judge(case, result), "tokens": result["usage"]["prompt_tokens"] + result["usage"]["completion_tokens"],
                "cost": round(result["usage"]["cost"], 3), "steps": result["steps"], "diffCut": result["diffCut"], "seconds": result["seconds"],
                "coverage": coverage(case, result),
                "unsupported": sum(1 for f in report.get("findings") or [] if f.get("unsupported")),
            })
    (results / "scores.json").write_text(json.dumps(rows, indent=2))

    summary = {}
    print("| Condition | Fix-PR defects caught | Fix PRs with any blocking finding | Seeded caught | Clean PRs held | Recall | FPR | Score (recall - FPR) | Tokens | Cost |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for cond in CONDITIONS:
        r = [x for x in rows if x["condition"] == cond]
        if not r:
            continue
        fix = [v for x in r if x["kind"] == "fix" for v in x["caught"].values()]
        seed = [v for x in r if x["kind"] == "seed" for v in x["caught"].values()]
        fix_any = [x["blocking"] > 0 for x in r if x["kind"] == "fix"]
        # A clean PR is held when the result would close a merge gate: any status other than pass.
        clean = [x["status"] != "pass" for x in r if x["kind"] == "clean"]
        recall = (sum(fix) + sum(seed)) / max(len(fix) + len(seed), 1)
        fpr = sum(clean) / max(len(clean), 1)
        summary[cond] = {"recall": recall, "fix_recall": sum(fix) / max(len(fix), 1), "seed_recall": sum(seed) / max(len(seed), 1), "fpr": fpr, "score": recall - fpr, "tokens_per_run": sum(x["tokens"] for x in r) / len(r),
                         "minutes_per_run": sum(x["seconds"] for x in r) / len(r) / 60, "runs": len(r)}
        print(
            f"| {cond} | {sum(fix)}/{len(fix)} | {sum(fix_any)}/{len(fix_any)} | {sum(seed)}/{len(seed)} | {sum(clean)}/{len(clean)} | "
            f"{recall:.2f} | {fpr:.2f} | {recall - fpr:.2f} | {sum(x['tokens'] for x in r):,} | ${sum(x['cost'] for x in r):.2f} |"
        )

    print("\nCoverage of changed source files (cut-diff cases):")
    for cond in CONDITIONS:
        cov = [x["coverage"] for x in rows if x["condition"] == cond and x["diffCut"] and x["coverage"] is not None]
        if cov:
            print(f"- {cond}: median {sorted(cov)[len(cov) // 2]:.2f}, min {min(cov):.2f}, over {len(cov)} cases")
    (results / "summary.json").write_text(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
