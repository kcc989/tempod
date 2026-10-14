"""Usage: python3 evals/design/calibrate.py <calibration-dir> [rubric-subdir] -> writes analysis.json; prints per-area AUC and per-question separation."""
import json, os, sys, itertools
D = sys.argv[1]
R = sys.argv[2] if len(sys.argv) > 2 else ""
spec = json.load(open(os.path.join(os.path.dirname(__file__), R, "design-eval.questions.json")))
pol = json.load(open(os.path.join(os.path.dirname(__file__), "acceptance.v1.json")))
qdef = {**spec["screen"], **spec["visual"], **spec["slop"]}
def norm(q, a):
    if a["type"] == "noul":
        return 1 - a["noul"] if q.startswith(("slop_", "quality_")) else a["noul"]
    if a["type"] == "score":
        return a["score"] / (len(qdef[q]["criteria"]) - 1)
    return None
def auc(r, p):
    pairs = [(x > y) + 0.5 * (x == y) for x, y in itertools.product(r, p)]
    return sum(pairs) / len(pairs) if pairs else None
cases = {}
for c in sorted(os.listdir(D)):
    p0 = os.path.join(D, c)
    if not os.path.isdir(p0): continue
    p = os.path.join(p0, R)
    cases[c] = dict(label="ref" if c.startswith("ref") else "poor",
        areas=json.load(open(f"{p}/areas.json")), result=json.load(open(f"{p}/result.json")),
        acc=json.load(open(f"{p}/acceptance.json")),
        ans={k: v for a in pol["areas"] for k, v in json.load(open(f"{p}/{a}.answers.json"))["response"]["result"]["answers"].items() if k in qdef})
refs = [c for c in cases if cases[c]["label"] == "ref"]; poor = [c for c in cases if cases[c]["label"] == "poor"]
out = {"overall": {}, "areas": {}, "questions": {}, "refFailReasons": {}}
s = lambda c: cases[c]["result"]["score"]
out["overall"] = dict(auc=auc([s(c) for c in refs], [s(c) for c in poor]), ref=[s(c) for c in refs], poor=[s(c) for c in poor])
for a in pol["areas"]:
    r = [cases[c]["areas"][a]["score"] for c in refs]; q = [cases[c]["areas"][a]["score"] for c in poor]
    out["areas"][a] = dict(auc=auc(r, q), ref=r, poor=q, refPass=sum(cases[c]["areas"][a]["status"] == "pass" for c in refs), poorPass=sum(cases[c]["areas"][a]["status"] == "pass" for c in poor))
for q in qdef:
    if q.startswith("applies_"): continue
    r = [norm(q, cases[c]["ans"][q]) for c in refs if q in cases[c]["ans"]]; p = [norm(q, cases[c]["ans"][q]) for c in poor if q in cases[c]["ans"]]
    r = [x for x in r if x is not None]; p = [x for x in p if x is not None]
    if r and p: out["questions"][q] = dict(auc=round(auc(r, p), 3), refMean=round(sum(r)/len(r), 3), poorMean=round(sum(p)/len(p), 3), refMin=round(min(r), 3))
    else:
        ch = {c: cases[c]["ans"][q].get("choice") for c in cases if q in cases[c]["ans"]}
        out["questions"][q] = dict(choices=ch)
for c in refs: out["refFailReasons"][c] = cases[c]["acc"]["reasons"]
json.dump(out, open(os.path.join(D, f"analysis{"-" + R if R else ""}.json"), "w"), indent=2)
print("overall", out["overall"])
for a, v in out["areas"].items(): print(a, v)
print("\nquestions that rank problems at or above references (auc<=0.5):")
for q, v in sorted(out["questions"].items(), key=lambda kv: kv[1].get("auc", 9)):
    if v.get("auc", 9) <= 0.5: print(" ", q, v)
print("\nref fail reasons:")
for c, r in out["refFailReasons"].items(): print(c, r)
