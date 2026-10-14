"""Build a screen case folder from saved desktop captures.

Usage: python3 evals/design/assemble_screen.py <spec.json>

spec.json: {
  "case": "evals/design/.../changes/dark", "theme": "dark", "tokensRev": "<git rev>",
  "screen": {"name": "...", "purpose": "..."},
  "quads": [tl, tr, bl, br],            # zooms at 2x the AX frame
  "crops": [{"name": "rail", "legend": "crop of the Changes tool", "box": [x0, y0, x1, y1]}],  # in 2x pixels
  "interactions": [{"action": "...", "before": "file", "after": "file"}],
  "known": {"ai": false, ...},  "knownSource": "...",
  "axStates": {"default": "ax/default.txt", "tools-open": "ax/default.txt"}
}
page_text is the AX titles of ax/default.txt that are not withheld.
"""

import json
import re
import shutil
import sys
from pathlib import Path

from PIL import Image

spec = json.loads(Path(sys.argv[1]).read_text())
case = Path(spec["case"])
ims = [Image.open(q).convert("RGB") for q in spec["quads"]]
w, h = ims[0].size
full = Image.new("RGB", (2 * w, 2 * h))
for i, im in enumerate(ims):
    full.paste(im, ((i % 2) * w, (i // 2) * h))
full.save(case / "full.png", optimize=True)
images, legend = ["full.png"], ["Image 1: the full screen"]
for i, crop in enumerate(spec["crops"]):
    full.crop(tuple(crop["box"])).save(case / f"{crop['name']}.png", optimize=True)
    images.append(f"{crop['name']}.png")
    legend.append(f"Image {i + 2}: {crop['legend']}")
(case / "interactions").mkdir(exist_ok=True)
interactions = []
for n, it in enumerate(spec["interactions"]):
    before, after = f"interactions/{n}-before.jpg", f"interactions/{n}-after.jpg"
    shutil.copy(it["before"], case / before)
    shutil.copy(it["after"], case / after)
    interactions.append({"action": it["action"], "before": before, "after": after})
titles = re.findall(r'\] AX\S+ \[[^\]]+\] "(.*)"$', (case / "ax/default.txt").read_text(), re.M)
context = {
    "app": {"name": "Tempo", "category": "Agent coding workspace", "platform": "desktop", "primary_user": "Developer", "primary_job": "Direct coding agents in project workspaces and review their work"},
    "screen": spec["screen"],
    "image_legend": legend,
    "page_text": "\n".join(titles),
}
(case / "context.json").write_text(json.dumps(context, indent=2, ensure_ascii=False))
capture = {
    "context": "context.json",
    "images": images,
    "interactions": interactions,
    "known": spec["known"],
    "knownSource": spec["knownSource"],
    "theme": spec["theme"],
    "tokensRev": spec["tokensRev"],
    "framePixels": [1456, 822],
    "windowPoints": [1492, 842],
    "axStates": spec.get("axStates", {"default": "ax/default.txt", "tools-open": "ax/default.txt"}),
}
(case / "capture.json").write_text(json.dumps(capture, indent=2))
print(case, full.size, len(images), "images", len(interactions), "interactions")
