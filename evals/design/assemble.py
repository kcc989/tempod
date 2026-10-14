"""Build a workspace case folder from saved desktop captures.

Usage: python3 evals/design/assemble.py <case-dir> <theme> <q1> <q2> <q3> <q4> <info-before> <info-after> <changes-after> <tab-before> <tab-after>
q1..q4 are the four quadrant zooms (top-left, top-right, bottom-left, bottom-right) at 2x the AX frame.
Expects <case-dir>/ax/default.txt and ax/tools-open.txt. page_text is the AX titles that are not withheld.
"""

import json
import re
import shutil
import sys
from pathlib import Path

from PIL import Image

case, theme, *files = sys.argv[1:]
case = Path(case)
quads, (info_b, info_a, changes_a, tab_b, tab_a) = files[:4], files[4:]
ims = [Image.open(q).convert("RGB") for q in quads]
w, h = ims[0].size
full = Image.new("RGB", (2 * w, 2 * h))
for i, im in enumerate(ims):
    full.paste(im, ((i % 2) * w, (i // 2) * h))
full.save(case / "full.png", optimize=True)
for name, box in {"sidebar": (0, 0, 520, 1644), "header": (0, 0, 2912, 420), "composer": (540, 1380, 2240, 1644)}.items():
    full.crop(box).save(case / f"{name}.png", optimize=True)
(case / "interactions").mkdir(exist_ok=True)
for src, dst in [(info_b, "info-before"), (info_a, "info-after"), (changes_a, "changes-after"), (tab_b, "tab-before"), (tab_a, "tab-after")]:
    shutil.copy(src, case / "interactions" / f"{dst}.jpg")
titles = re.findall(r'\] AX\S+ \[[^\]]+\] "(.*)"$', (case / "ax/default.txt").read_text(), re.M)
context = {
    "app": {"name": "Tempo", "category": "Agent coding workspace", "platform": "desktop", "primary_user": "Developer", "primary_job": "Direct coding agents in project workspaces and review their work"},
    "screen": {"name": "Workspace", "purpose": "Read the agent's reply in a workspace chat, send the next message, and switch between workspaces"},
    "image_legend": ["Image 1: the full screen", "Image 2: crop of the sidebar", "Image 3: crop of the header, chat tabs and the top of the conversation", "Image 4: crop of the message field"],
    "page_text": "\n".join(titles),
}
(case / "context.json").write_text(json.dumps(context, indent=2, ensure_ascii=False))
capture = {
    "context": "context.json",
    "images": ["full.png", "sidebar.png", "header.png", "composer.png"],
    "interactions": [
        {"action": 'Clicked "Workspace info" in the header', "before": "interactions/info-before.jpg", "after": "interactions/info-after.jpg"},
        {"action": 'Clicked "Changes" in the Info panel', "before": "interactions/info-after.jpg", "after": "interactions/changes-after.jpg"},
        {"action": "Pressed Tab", "before": "interactions/tab-before.jpg", "after": "interactions/tab-after.jpg"},
    ],
    "related": {"images": ["interactions/changes-after.jpg", "interactions/tab-before.jpg"], "image_legend": ["Workspace with the Changes tool open", "Workspace with the Tools picker open"]},
    "known": {"ai": True, "async": False, "collection": True, "editing": True, "empty": False, "errors": False, "limits": False},
    "knownSource": f"Verified in the running Mac app ({theme} theme): finished agent reply with a collapsed step line; no agent turn running; workspace list; editable message field; no empty area, error or usage limit in the main capture.",
    "theme": theme,
    "framePixels": [1456, 822],
    "windowPoints": [1492, 842],
    "axStates": {"default": "ax/default.txt", "tools-open": "ax/tools-open.txt"},
}
(case / "capture.json").write_text(json.dumps(capture, indent=2))
print(case, full.size)
