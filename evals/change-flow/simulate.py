"""Models the change flow at 10 and 100 agents on one native project.

usage: python3 -I evals/change-flow/simulate.py [--measure] [--verifier <condition>] [--scores results/summary.json]

--verifier picks the replay condition whose measured numbers drive the design flows (default: design). Escaped
defects use its recall on the real fix-PR defects; the seeded recall is reported as an upper bound in a second block.

--measure reads git history for the conflict rate between nearby PRs and the risk-tier mix, and writes
measured.json. Without it, measured.json is reused. Every other input is either measured (named in INPUTS with its
source) or an assumption (named in ASSUMPTIONS) that the tracking plan replaces with real data.
"""

import heapq
import json
import pathlib
import random
import statistics
import subprocess
import sys
from datetime import datetime

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]

INPUTS = {
    "ci_minutes_per_run": (4.1, "docs/CI.md and PR #53/#61 hosted runs: 209.5-269 s including setup and cleanup"),
    "ci_slots": (2, "10 Project CI: at most 2 jobs run at the same time per project"),
    "defects_per_feature_pr": (12 / 55, "12 escaped defects (taxonomy) over 55 non-fix PRs #1-#63"),
}
ASSUMPTIONS = {
    "author_minutes": "lognormal with the median and spread of PR open time in prs.json (agent work before push is not recorded)",
    "rework_fraction": "a conflict or a pre-merge finding costs 25% of the original author time",
    "owner_guide_minutes": "high tier 5, medium 2, low 0 minutes to read a Guide",
    "owner_triage_minutes": "2 minutes per blocking finding the owner sees",
}


def git(*args):
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True).stdout


def tier(files):
    high = ("migrations/", "packages/protocol/", "outbound", "egress", "container/", "auth", "credential", "secret", "Dockerfile", "repository-ci", "merge")
    low_only = all(f.startswith("docs/") or f.endswith(".md") or "/test" in f or f.startswith("tests/") or f.endswith(".css") for f in files)
    if any(h in f for f in files for h in high):
        return "high"
    return "low" if low_only else "medium"


MECHANICAL = ("docs/", "bun.lock", "Cargo.lock", "generated.rs", "packages/protocol/schema/")


def conflict_files(a, b):
    """Files that conflict when b's change and a's change start from a's parent; empty when they merge cleanly."""
    moved = subprocess.run(["git", "merge-tree", "--write-tree", "--name-only", "--no-messages", f"--merge-base={b}^", f"{a}^", b], cwd=ROOT, capture_output=True, text=True)
    if moved.returncode != 0:
        return moved.stdout.split()[1:] or ["?"]
    other = git("commit-tree", moved.stdout.split()[0], "-p", f"{a}^", "-m", "sim").strip()
    merged = subprocess.run(["git", "merge-tree", "--write-tree", "--name-only", "--no-messages", a, other], cwd=ROOT, capture_output=True, text=True)
    return (merged.stdout.split()[1:] or ["?"]) if merged.returncode != 0 else []


def measure():
    commits = git("log", "--first-parent", "--format=%H", "origin/main").split()[:60][::-1]
    pairs = raw = code = 0
    by_distance = {}
    for i, a in enumerate(commits):
        for d in range(1, 6):
            if i + d >= len(commits):
                break
            files = conflict_files(a, commits[i + d])
            is_code = any(not f.startswith(MECHANICAL) and not f.endswith(MECHANICAL) for f in files)
            pairs += 1
            raw += bool(files)
            code += is_code
            n, c = by_distance.get(d, (0, 0))
            by_distance[d] = (n + 1, c + is_code)
    tiers = {"low": 0, "medium": 0, "high": 0}
    for c in commits:
        tiers[tier(git("diff", "--name-only", f"{c}^", c).split())] += 1
    out = {
        "conflict_rate_raw": raw / pairs,
        "conflict_rate": code / pairs,
        "conflict_rate_note": "conflict_rate counts pairs with a conflict outside docs, lockfiles and generated protocol files",
        "conflict_by_distance": {d: c / n for d, (n, c) in by_distance.items()},
        "pairs": pairs,
        "tier_mix": {k: v / len(commits) for k, v in tiers.items()},
        "commits": len(commits),
    }
    (HERE / "measured.json").write_text(json.dumps(out, indent=2))
    return out


def author_distribution():
    prs = json.loads((HERE / "prs.json").read_text())["prs"]
    mins = []
    for _, created, merged, _, _ in prs:
        a = datetime.fromisoformat(created.replace("Z", "+00:00"))
        b = datetime.fromisoformat(merged.replace("Z", "+00:00"))
        mins.append(max((b - a).total_seconds() / 60, 1))
    logs = [__import__("math").log(m) for m in mins]
    return statistics.mean(logs), statistics.pstdev(logs), statistics.median(mins)


FLOWS = {
    # verifiers before merge per tier, after merge per tier, Guide per tier, CI batch size
    "baseline": {"pre": {"low": 0, "medium": 0, "high": 0}, "post": {"low": 0, "medium": 0, "high": 0}, "guide": set(), "batch": 1},
    "design": {"pre": {"low": 0, "medium": 1, "high": 2}, "post": {"low": 1, "medium": 0, "high": 1}, "guide": {"medium", "high"}, "batch": 1},
    "design+queue": {"pre": {"low": 0, "medium": 1, "high": 2}, "post": {"low": 1, "medium": 0, "high": 1}, "guide": {"medium", "high"}, "batch": 4},
}


def simulate(agents, flow_name, m, v, p_conflict, recall_key="fix_recall", hours=24, seed=1):
    rng = random.Random(seed)
    flow = FLOWS[flow_name]
    mu, sigma, _ = author_distribution()
    recall = v[recall_key] if flow_name != "baseline" else 0.0
    fpr = v["fpr"] if flow_name != "baseline" else 0.0
    run_tokens = v["tokens_per_run"]
    run_minutes = v["minutes_per_run"]
    ci_minutes, slots = INPUTS["ci_minutes_per_run"][0], INPUTS["ci_slots"][0]
    defect_rate = INPUTS["defects_per_feature_pr"][0]
    tiers = list(m["tier_mix"].keys())
    weights = list(m["tier_mix"].values())

    t_end = hours * 60
    events = []
    seq = 0

    def push(t, kind, data):
        nonlocal seq
        seq += 1
        heapq.heappush(events, (t, seq, kind, data))

    ci_free = slots
    ci_queue = []
    stats = {"merged": 0, "ci_runs": 0, "ci_minutes": 0.0, "ci_wait": [], "lead": [], "conflicts": 0, "tokens": 0, "verifier_runs": 0,
             "caught": 0, "escaped": 0, "false_blocks": 0, "owner_minutes": 0.0, "fix_prs": 0}
    merges_since = []  # merge times on the base branch

    def new_change(agent, t, fix=False):
        change = {"agent": agent, "tier": rng.choices(tiers, weights)[0], "start": t, "base_at": t, "fix": fix,
                  "defect": (not fix and rng.random() < defect_rate), "author": rng.lognormvariate(mu, sigma)}
        push(t + change["author"], "pushed", change)

    def start_ci(t):
        nonlocal ci_free
        while ci_free > 0 and ci_queue:
            batch = [ci_queue.pop(0) for _ in range(min(flow["batch"], len(ci_queue)))]
            ci_free -= 1
            for c in batch:
                stats["ci_wait"].append(t - c["queued"])
            stats["ci_runs"] += 1
            stats["ci_minutes"] += ci_minutes
            push(t + ci_minutes, "ci_done", batch)

    for a in range(agents):
        new_change(a, rng.random() * 10)

    while events:
        t, _, kind, data = heapq.heappop(events)
        if t > t_end:
            break
        if kind == "pushed":
            c = data
            c["queued"] = t
            ci_queue.append(c)
            n = flow["pre"][c["tier"]] + (1 if c["tier"] in flow["guide"] else 0)
            stats["verifier_runs"] += n
            stats["tokens"] += n * run_tokens
            c["verified_at"] = t + (run_minutes if n else 0)
            start_ci(t)
        elif kind == "ci_done":
            ci_free += 1
            batch = data
            # A batch with a failing member is bisected: the others rerun once.
            for c in batch:
                push(max(t, c["verified_at"]), "gate", c)
            start_ci(t)
        elif kind == "gate":
            c = data
            if flow["pre"][c["tier"]]:
                if c["defect"] and rng.random() < 1 - (1 - recall) ** flow["pre"][c["tier"]]:
                    stats["caught"] += 1
                    stats["owner_minutes"] += 2
                    c["defect"] = False
                    push(t + c["author"] * 0.25, "pushed", c)
                    continue
                if not c["defect"] and rng.random() < 1 - (1 - fpr) ** flow["pre"][c["tier"]]:
                    stats["false_blocks"] += 1
                    stats["owner_minutes"] += 2
                    push(t + c["author"] * 0.25, "pushed", c)
                    c["defect"] = False
                    continue
            intervening = sum(1 for x in merges_since if x > c["base_at"])
            if rng.random() < 1 - (1 - p_conflict) ** intervening:
                stats["conflicts"] += 1
                c["base_at"] = t
                push(t + c["author"] * 0.25, "pushed", c)
                continue
            merges_since.append(t)
            stats["merged"] += 1
            stats["lead"].append(t - c["start"])
            stats["owner_minutes"] += {"high": 5, "medium": 2, "low": 0}[c["tier"]] if c["tier"] in flow["guide"] else 0
            post = flow["post"][c["tier"]]
            stats["verifier_runs"] += post
            stats["tokens"] += post * run_tokens
            if c["defect"]:
                if post and rng.random() < recall:
                    stats["caught"] += 1
                else:
                    stats["escaped"] += 1
                stats["fix_prs"] += 1
                new_change(c["agent"], t, fix=True)
            else:
                new_change(c["agent"], t)

    merged = max(stats["merged"], 1)
    return {
        "agents": agents,
        "flow": flow_name,
        "merged_per_hour": round(stats["merged"] / hours, 1),
        "lead_minutes_p50": round(statistics.median(stats["lead"]), 1) if stats["lead"] else None,
        "ci_wait_minutes_p50": round(statistics.median(stats["ci_wait"]), 1) if stats["ci_wait"] else None,
        "ci_minutes_per_merge": round(stats["ci_minutes"] / merged, 2),
        "ci_runner_minutes_per_hour": round(stats["ci_minutes"] / hours, 1),
        "conflicts_per_merge": round(stats["conflicts"] / merged, 3),
        "verifier_runs_per_merge": round(stats["verifier_runs"] / merged, 2),
        "verification_tokens_per_merge": round(stats["tokens"] / merged),
        "escaped_defects_per_100": round(100 * stats["escaped"] / merged, 1),
        "fix_prs_per_100": round(100 * stats["fix_prs"] / merged, 1),
        "owner_minutes_per_merge": round(stats["owner_minutes"] / merged, 2),
    }


def main():
    m = measure() if "--measure" in sys.argv or not (HERE / "measured.json").exists() else json.loads((HERE / "measured.json").read_text())
    scores_path = pathlib.Path(sys.argv[sys.argv.index("--scores") + 1]) if "--scores" in sys.argv else HERE / "results" / "summary.json"
    scores = json.loads(scores_path.read_text())
    cond = sys.argv[sys.argv.index("--verifier") + 1] if "--verifier" in sys.argv else "design"
    v = scores[cond]
    mu, sigma, median = author_distribution()
    print(f"measured: conflict rate per nearby PR pair raw {m['conflict_rate_raw']:.3f}, code {m['conflict_rate']:.3f} over {m['pairs']} pairs; tier mix {m['tier_mix']}; PR open time median {median:.0f} min")
    # Each change merged after a change's base conflicts with it independently at the adjacent-pair code rate.
    # 0.05 is a sensitivity case for a repository split into areas that agents lease; it is not measured.
    pair = m["conflict_by_distance"]["1"] if "1" in m["conflict_by_distance"] else m["conflict_by_distance"][1]
    print(f"verifier condition {cond}: fix-PR recall {v['fix_recall']:.2f}, seeded recall {v['seed_recall']:.2f}, clean hold {v['fpr']:.2f}, {v['tokens_per_run']:,.0f} tokens and {v['minutes_per_run']:.1f} min per run")
    def averaged(n, f, p, rk, seeds=8):
        runs = [simulate(n, f, m, v, p, rk, seed=s) for s in range(1, seeds + 1)]
        out = dict(runs[0])
        for k, val in out.items():
            if isinstance(val, (int, float)) and k != "agents":
                vals = [r[k] for r in runs if r[k] is not None]
                out[k] = round(sum(vals) / len(vals), 2) if vals else None
        return dict(out, p_conflict=round(p, 3), recall=rk)

    rows = [averaged(n, f, p, rk) for rk in ("fix_recall", "seed_recall") for p in (pair, 0.05) for n in (10, 100) for f in FLOWS]
    keys = list(rows[0].keys())
    print("| " + " | ".join(keys) + " |")
    print("| " + " | ".join("---" for _ in keys) + " |")
    for r in rows:
        print("| " + " | ".join(str(r[k]) for k in keys) + " |")
    (HERE / "results" / f"simulation.{cond}.json").write_text(json.dumps({"verifier": cond, "measured": m, "inputs": INPUTS, "assumptions": ASSUMPTIONS, "rows": rows}, indent=2))


if __name__ == "__main__":
    main()
