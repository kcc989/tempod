#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mode=${1:---open}
case "$mode" in --open|--build-only|--check-workspace) ;; *) echo 'Usage: dev.sh [--open|--build-only|--check-workspace]' >&2; exit 2;; esac
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || { echo 'Build on an Apple silicon Mac.' >&2; exit 1; }
identity=${TEMPO_MAC_SIGN_IDENTITY:-Tempo Development}
if [[ "$mode" != --check-workspace ]] && pgrep -x Tempo >/dev/null; then
  echo 'Quit Tempo before rebuilding it.' >&2
  exit 1
fi
if ! security find-identity -v -p codesigning | python3 -c 'import sys; identity=sys.argv[1]; rows=sys.stdin.read().splitlines(); sys.exit(0 if any(("\""+identity+"\"") in r or identity in r.split("\"")[0].split() for r in rows) else 1)' "$identity"; then
  echo "No valid signing identity named $identity. Run bash scripts/mac/setup-dev-signing.sh once, or set TEMPO_MAC_SIGN_IDENTITY to an installed signing identity." >&2
  exit 1
fi
cargo build --locked -p tempo-mac
target_dir=$(cargo metadata --format-version 1 --no-deps | python3 -c 'import json, sys; print(json.load(sys.stdin)["target_directory"])')
app="dist/mac/dev/Tempo.app"
if [[ "$mode" == --check-workspace ]]; then
  app="dist/mac/check/Tempo.app"
fi
helper_cache="dist/mac/keychain-helper"
mkdir -p "$helper_cache" "$app/Contents/Helpers"
helper_key=$(python3 - "$identity" <<'PYHELPER'
import hashlib, pathlib, subprocess, sys
identity=sys.argv[1]
rows=subprocess.check_output(["security","find-identity","-v","-p","codesigning"],text=True).splitlines()
matching=[r.split()[1] for r in rows if ('"'+identity+'"') in r or identity in r.split('"')[0].split()]
if len(matching)!=1: raise SystemExit("Use an unambiguous Tempo signing identity.")
h=hashlib.sha256(matching[0].encode())
for name in ["crates/tempo-keychain/Cargo.toml","crates/tempo-keychain/src/main.rs","Cargo.lock"]:
    h.update(pathlib.Path(name).read_bytes())
print(h.hexdigest())
PYHELPER
)
if [[ ! -f "$helper_cache/$helper_key" || ! -f "$helper_cache/TempoKeychain" ]]; then
  cargo build --locked -p tempo-keychain
  cp "$target_dir/debug/TempoKeychain" "$helper_cache/TempoKeychain"
  codesign --force --sign "$identity" --identifier dev.tempo.mac.keychain "$helper_cache/TempoKeychain"
  touch "$helper_cache/$helper_key"
fi
codesign --verify --strict "$helper_cache/TempoKeychain"
cp "$helper_cache/TempoKeychain" "$app/Contents/Helpers/TempoKeychain"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$target_dir/debug/Tempo" "$app/Contents/MacOS/Tempo"
cp "$target_dir/debug/tempo" "$app/Contents/MacOS/tempo"
codesign --force --sign "$identity" --identifier dev.tempo.mac.terminal "$app/Contents/MacOS/tempo"
cp apps/mac/resources/Info.plist "$app/Contents/Info.plist"
python3 scripts/mac/icon.py dist/mac/dev/Tempo.iconset
iconutil --convert icns --output "$app/Contents/Resources/AppIcon.icns" dist/mac/dev/Tempo.iconset
codesign --force --sign "$identity" --entitlements apps/mac/resources/Tempo.entitlements --identifier dev.tempo.mac "$app"
codesign --verify --deep --strict "$app"
python3 scripts/mac/verify-dev-signing.py "$app"
printf 'Built %s\n' "$app"
if [[ "$mode" == --open ]]; then
  open -W "$app"
elif [[ "$mode" == --check-workspace ]]; then
  "$app/Contents/MacOS/Tempo" --check-workspace
fi
