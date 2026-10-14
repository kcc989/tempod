"""Measured spacing, layout and color checks for a Mac capture.

Usage: python3 evals/design/measure.py <case-dir>

Reads from the case directory:
  capture.json  "theme" (dark|light), "framePixels" [w, h] of the AX coordinate frame,
                "windowPoints" [w, h] of the window, and "axStates" {state: file}
  ax/<state>.txt  the AX summary lines from the desktop tool for each state
  full.png      the window at 2x the AX frame
Writes measured.json. Thresholds come from WCAG 2.2 and tab 07; nothing is tuned to a result.
"""

import json
import re
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
TOKENS = ROOT / "apps/mac/src/views/tokens.rs"
LINE = re.compile(r"\[(\d+)\] (\S+) \[(-?\d+),(-?\d+) (\d+)×(\d+)\](?: \"(.*)\")?")
SLOTS = ["background", "sidebar", "panel", "surface", "popup", "hover", "selected", "text", "muted", "border", "primary", "on_primary"]


def palette(theme):
    src = TOKENS.read_text()
    block = src[src.index("let (\n                background,"):]
    hexes = re.findall(r'"(#[0-9a-fA-F]{6})"', block)[:24]
    values = hexes[:12] if theme == "dark" else hexes[12:24]
    return dict(zip(SLOTS, values))


def luminance(hex_):
    def channel(v):
        v = v / 255
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4

    r, g, b = (int(hex_[i : i + 2], 16) for i in (1, 3, 5))
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def contrast(a, b):
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return round((la + 0.05) / (lb + 0.05), 2)


def read_ax(path, scale):
    out = []
    for line in Path(path).read_text().splitlines():
        m = LINE.search(line)
        if not m:
            continue
        _, role, x, y, w, h, title = m.groups()
        out.append({"role": role, "title": title, "x": int(x) * scale, "y": int(y) * scale, "w": int(w) * scale, "h": int(h) * scale})
    return out


def near_multiple(value, step=4, tolerance=1.0):
    return abs(value - step * round(value / step)) <= tolerance


def header_one_row(states):
    detail = {}
    ok = True
    for name, elems in states.items():
        header = [e for e in elems if e["role"].startswith("AXButton/AXUnknown") and e["y"] < 39 and e["x"] > 180]
        centers = [e["y"] + e["h"] / 2 for e in header]
        bottoms = [e["y"] + e["h"] for e in header]
        spread = round(max(centers) - min(centers), 1) if centers else 0
        lowest = round(max(bottoms), 1) if bottoms else 0
        passed = spread <= 3 and lowest <= 41
        ok &= passed
        detail[name] = {"controls": len(header), "centerSpreadPt": spread, "lowestBottomPt": lowest, "pass": passed}
    return ok, detail


def spec_row_heights(elems):
    rows = [e for e in elems if e["x"] <= 13 and e["w"] >= 170 and e["h"] >= 28]
    bad = [{"title": e["title"], "heightPt": round(e["h"], 1)} for e in rows if abs(e["h"] - 36) > 1]
    return not bad, {"rows": len(rows), "expectedPt": 36, "offSpec": bad}


def text_left_edge(img, box, bg, step):
    x0, y0, x1, y1 = (round(v * step) for v in box)
    px = img.load()
    for x in range(x0 + 2, x1):
        for y in range(y0 + 2, y1 - 2):
            if sum(abs(a - b) for a, b in zip(px[x, y][:3], bg)) > 90:
                return x / step
    return None


def footer_rows(elems, img, bg, frame_to_px, scale):
    footer = sorted((e for e in elems if e["x"] <= 13 and e["w"] >= 170 and e["y"] > 600 * scale), key=lambda e: e["y"])
    edges = []
    for e in footer:
        box = (e["x"] / scale, e["y"] / scale, (e["x"] + e["w"]) / scale, (e["y"] + e["h"]) / scale)
        left = text_left_edge(img, box, bg, frame_to_px)
        edges.append({"title": e["title"], "leftPt": None if left is None else round(left * scale, 1), "heightPt": round(e["h"], 1)})
    lefts = [d["leftPt"] for d in edges if d["leftPt"] is not None]
    heights = [d["heightPt"] for d in edges]
    aligned = bool(lefts) and max(lefts) - min(lefts) <= 2
    same_height = bool(heights) and max(heights) - min(heights) <= 1
    return aligned and same_height, {"rows": edges, "leftSpreadPt": round(max(lefts) - min(lefts), 1) if lefts else None, "heightSpreadPt": round(max(heights) - min(heights), 1) if heights else None}


def spacing_on_scale(elems):
    column = sorted((e for e in elems if e["x"] <= 13 and e["w"] >= 170), key=lambda e: e["y"])
    gaps = []
    for a, b in zip(column, column[1:]):
        gap = b["y"] - (a["y"] + a["h"])
        if 0 <= gap < 40:
            gaps.append({"between": [a["title"], b["title"]], "gapPt": round(gap, 1), "onScale": near_multiple(gap)})
    heights = [{"title": e["title"], "heightPt": round(e["h"], 1), "onScale": near_multiple(e["h"])} for e in column]
    ok = all(g["onScale"] for g in gaps) and all(h["onScale"] for h in heights)
    return ok, {"step": 4, "tolerancePt": 1, "gaps": gaps, "heights": heights}


def chat_bar_inset(elems, img, frame_to_px, scale):
    tabs = [e for e in elems if e["role"] == "AXTabGroup/AXUnknown"]
    if not tabs:
        return None, {"reason": "no chat tab bar in AX"}
    bar = min(tabs, key=lambda e: e["x"])
    px = img.load()
    y = round(img.height * 0.6)
    lo, hi = round(150 * frame_to_px), round(bar["x"] / scale * frame_to_px)
    # The divider is a band drawn over the pane boundary; measure from its center.
    content = px[hi - 2, y][:3]
    band = [x for x in range(lo, hi) if abs(sum(px[x, y][:3]) - sum(content)) > 30]
    if not band:
        return None, {"reason": "no divider found"}
    divider_pt = (band[0] + band[-1] + 1) / 2 / frame_to_px * scale
    inset = round(bar["x"] - divider_pt, 1)
    return abs(inset - 12) <= 1, {"dividerPt": round(divider_pt, 1), "chatBarPt": round(bar["x"], 1), "insetPt": inset, "expectedPt": 12}


def target_size(elems):
    targets = [e for e in elems if e["role"].startswith(("AXButton/AXUnknown", "AXRadioButton", "AXCheckBox"))]
    small = [e for e in targets if e["w"] < 24 or e["h"] < 24]
    fails = []
    for e in small:
        cx, cy = e["x"] + e["w"] / 2, e["y"] + e["h"] / 2
        for o in targets:
            inside = o["x"] <= e["x"] and o["y"] <= e["y"] and e["x"] + e["w"] <= o["x"] + o["w"] and e["y"] + e["h"] <= o["y"] + o["h"]
            if o is e or inside:
                continue
            nx = min(max(cx, o["x"]), o["x"] + o["w"])
            ny = min(max(cy, o["y"]), o["y"] + o["h"])
            if (nx - cx) ** 2 + (ny - cy) ** 2 < 12**2:
                fails.append({"target": e["title"], "sizePt": [round(e["w"], 1), round(e["h"], 1)], "conflictsWith": o["title"]})
                break
    return not fails, {"undersized": len(small), "failingSpacingException": fails}


def colors(theme):
    p = palette(theme)
    text_bgs = ["background", "sidebar", "panel", "surface", "popup", "hover", "selected"]
    pairs = [{"fg": fg, "bg": bg, "ratio": contrast(p[fg], p[bg])} for fg in ("text", "muted") for bg in text_bgs]
    pairs.append({"fg": "on_primary", "bg": "primary", "ratio": contrast(p["on_primary"], p["primary"])})
    text_fail = [x for x in pairs if x["ratio"] < 4.5]
    ring = [{"fg": "primary", "bg": bg, "ratio": contrast(p["primary"], p[bg])} for bg in ("background", "sidebar", "surface", "popup")]
    inputs = []
    for container in ("background", "sidebar", "popup"):
        edge = max(contrast(p["border"], p[container]), contrast(p["surface"], p[container]))
        inputs.append({"input": "border or surface fill", "on": container, "ratio": round(edge, 2)})
    nontext_fail = [x for x in ring if x["ratio"] < 3] + [x for x in inputs if x["ratio"] < 3]
    info = {
        "selectedVsSidebar": contrast(p["selected"], p["sidebar"]),
        "surfaceVsBackground": contrast(p["surface"], p["background"]),
        "sidebarVsBackground": contrast(p["sidebar"], p["background"]),
    }
    return (
        not text_fail,
        {"palette": p, "textPairs": pairs, "failing": text_fail},
        not nontext_fail,
        {"focusRing": ring, "inputBoundaries": inputs, "failing": nontext_fail},
        info,
    )


def main(case):
    case = Path(case)
    cap = json.loads((case / "capture.json").read_text())
    fw, _ = cap["framePixels"]
    ww, _ = cap["windowPoints"]
    scale = ww / fw
    states = {name: read_ax(case / f, scale) for name, f in cap["axStates"].items()}
    default = states["default"]
    img = Image.open(case / "full.png").convert("RGB")
    frame_to_px = img.width / fw
    pal = palette(cap["theme"])
    sidebar_bg = tuple(int(pal["sidebar"][i : i + 2], 16) for i in (1, 3, 5))

    results = {}
    results["headerOneRow"] = header_one_row(states)
    results["specRowHeights"] = spec_row_heights(default)
    results["footerLeftAligned"] = footer_rows(default, img, sidebar_bg, frame_to_px, scale)
    results["spacingOnScale"] = spacing_on_scale(default)
    results["chatBarInset"] = chat_bar_inset(default, img, frame_to_px, scale)
    results["targetSize24px"] = target_size(default)
    text_ok, text_detail, nontext_ok, nontext_detail, info = colors(cap["theme"])
    results["textContrastAA"] = (text_ok, text_detail)
    results["nonTextContrast3"] = (nontext_ok, nontext_detail)

    checks = {k: {"pass": v[0], "detail": v[1]} for k, v in results.items()}
    out = {"checks": checks, "info": {"theme": cap["theme"], "pointsPerFramePixel": round(scale, 4), "surfaceRatios": info}}
    (case / "measured.json").write_text(json.dumps(out, indent=2))
    print(json.dumps({k: v["pass"] for k, v in checks.items()}))


if __name__ == "__main__":
    main(sys.argv[1])
