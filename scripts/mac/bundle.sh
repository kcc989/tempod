#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
  echo 'Build the Mac bundle on macOS.' >&2
  exit 1
fi

repo_dir="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_dir"
cargo build --release -p tempo-mac --bins --target aarch64-apple-darwin
app_dir="$repo_dir/dist/mac/Tempo.app"
mkdir -p "$app_dir/Contents/MacOS" "$app_dir/Contents/Resources"
cp target/aarch64-apple-darwin/release/Tempo "$app_dir/Contents/MacOS/Tempo"
cp target/aarch64-apple-darwin/release/tempo "$app_dir/Contents/MacOS/tempo"
cp apps/mac/resources/Info.plist "$app_dir/Contents/Info.plist"
if [[ -f apps/mac/resources/AppIcon.icns ]]; then
  cp apps/mac/resources/AppIcon.icns "$app_dir/Contents/Resources/AppIcon.icns"
fi
sign_identity="${TEMPO_MAC_SIGN_IDENTITY:--}"
codesign --force --options runtime --sign "$sign_identity" "$app_dir/Contents/MacOS/tempo"
codesign --force --options runtime --entitlements apps/mac/resources/Tempo.entitlements --sign "$sign_identity" "$app_dir"
echo "Built $app_dir"
