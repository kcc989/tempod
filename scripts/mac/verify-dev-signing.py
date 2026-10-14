#!/usr/bin/env python3
"""Check the development helper identity without touching Keychain items."""
import pathlib
import subprocess
import sys


def requirement(path):
    result = subprocess.run(
        ["/usr/bin/codesign", "-d", "-r-", str(path)],
        capture_output=True, text=True, check=True,
    )
    for line in (result.stdout + "\n" + result.stderr).splitlines():
        if line.startswith("designated => "):
            return line.removeprefix("designated => ")
    raise SystemExit("Missing designated signing requirement.")


app = pathlib.Path(sys.argv[1])
helper = app / "Contents/Helpers/TempoKeychain"
app_rule = requirement(app)
helper_rule = requirement(helper)
helper_id = 'identifier "dev.tempo.mac.keychain"'
app_id = 'identifier "dev.tempo.mac"'
if not helper_rule.startswith(helper_id) or "certificate leaf" not in helper_rule:
    raise SystemExit("Wrong Keychain helper signature. Sign it as dev.tempo.mac.keychain.")
if helper_rule.replace(helper_id, app_id, 1) != app_rule:
    raise SystemExit("Tempo and its Keychain helper need matching signing certificates.")
print("Development app and Keychain helper identities match.")
