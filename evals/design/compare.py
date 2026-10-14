"""Compare two denoised v3 runs with the noise band from acceptance.v2.json.

Usage: python3 evals/design/compare.py <before-case> <after-case> [--out file.json]
A dimension drops only when after - before < -max(noiseFloor, 2 * sqrt(sdBefore^2 + sdAfter^2)).
"""

import json
import math
import sys
from pathlib import Path

policy = json.loads((Path(__file__).parent / "acceptance.v2.json").read_text())["denoise"]
before, after = (Path(p) for p in sys.argv[1:3])


def load(case):
    v3 = case / "v3"
    return {
        "noise": json.loads((v3 / "noise.json").read_text()),
        "result": json.loads((v3 / "result.json").read_text()),
        "areas": json.loads((v3 / "areas.json").read_text()),
        "acceptance": json.loads((v3 / "acceptance.json").read_text()),
        "measured": {k: v["pass"] for k, v in json.loads((case / "measured.json").read_text())["checks"].items()},
    }


a, b = load(before), load(after)
dims = sorted(set(a["noise"]["dimensions"]) | set(b["noise"]["dimensions"]))
rows = []
for d in dims:
    x, y = a["noise"]["dimensions"].get(d), b["noise"]["dimensions"].get(d)
    if not x or not y:
        rows.append({"dimension": d, "before": x and round(x["mean"], 3), "after": y and round(y["mean"], 3), "change": None, "band": None, "verdict": "not comparable"})
        continue
    band = max(policy["noiseFloor"], 2 * math.sqrt(x["sd"] ** 2 + y["sd"] ** 2))
    change = y["mean"] - x["mean"]
    verdict = "drop" if change < -band else "gain" if change > band else "within noise"
    rows.append({"dimension": d, "before": round(x["mean"], 3), "after": round(y["mean"], 3), "change": round(change, 3), "band": round(band, 3), "verdict": verdict})
score_band = max(policy["noiseFloor"], 2 * math.sqrt(a["noise"]["score"]["sd"] ** 2 + b["noise"]["score"]["sd"] ** 2))
out = {
    "before": str(before),
    "after": str(after),
    "score": {"before": round(a["noise"]["score"]["mean"], 3), "after": round(b["noise"]["score"]["mean"], 3), "band": round(score_band, 3)},
    "dimensions": rows,
    "drops": [r["dimension"] for r in rows if r["verdict"] == "drop"],
    "gains": [r["dimension"] for r in rows if r["verdict"] == "gain"],
    "measured": {k: {"before": a["measured"].get(k), "after": b["measured"].get(k)} for k in sorted(set(a["measured"]) | set(b["measured"]))},
    "areas": {k: {"before": a["areas"][k]["status"], "after": b["areas"][k]["status"]} for k in a["areas"]},
    "blockers": {"before": a["result"]["blockers"], "after": b["result"]["blockers"]},
    "issues": {"before": a["result"]["issues"], "after": b["result"]["issues"]},
    "reasons": {"before": a["acceptance"]["reasons"], "after": b["acceptance"]["reasons"]},
}
if "--out" in sys.argv:
    Path(sys.argv[sys.argv.index("--out") + 1]).write_text(json.dumps(out, indent=2))
print(json.dumps({k: out[k] for k in ["score", "drops", "gains", "measured", "areas", "blockers", "issues"]}, indent=1))
