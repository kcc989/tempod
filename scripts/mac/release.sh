#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mode=${1:---adhoc}
case "$mode" in --adhoc|--release|--publish) ;; *) echo 'Usage: release.sh [--adhoc|--release|--publish]' >&2; exit 2;; esac
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || { echo 'Build on an Apple silicon Mac with macOS 15 or later.' >&2; exit 1; }
[[ $(sw_vers -productVersion | cut -d. -f1) -ge 15 ]] || { echo 'macOS 15 or later is required.' >&2; exit 1; }
version=$(python3 scripts/mac/manifest.py version)
out="dist/mac/$version"
mkdir -p "$out"
if [[ "$mode" != --adhoc ]]; then
  : "${TEMPO_MAC_SIGN_IDENTITY:?Set the authorized Developer ID Application identity}"
  : "${TEMPO_MAC_NOTARY_PROFILE:?Set the authorized notarytool Keychain profile}"
  [[ "$TEMPO_MAC_SIGN_IDENTITY" == 'Developer ID Application:'* ]] || { echo 'A Developer ID Application identity is required.' >&2; exit 1; }
  : "${TEMPO_MAC_BUCKET:?Set the owner R2 bucket}"
  bunx --no-install wrangler r2 object get "$TEMPO_MAC_BUCKET/clients/mac/latest.json" --remote --file "$out/previous.json"
  python3 scripts/mac/manifest.py newer "$version" "$out/previous.json"
fi
cargo build --locked --release -p tempo-mac --target aarch64-apple-darwin
app="$out/Tempo.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp target/aarch64-apple-darwin/release/Tempo "$app/Contents/MacOS/Tempo"
cp apps/mac/resources/Info.plist "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $version" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $version" "$app/Contents/Info.plist"
python3 scripts/mac/icon.py "$out/Tempo.iconset"
iconutil --convert icns --output "$app/Contents/Resources/AppIcon.icns" "$out/Tempo.iconset"
plutil -lint "$app/Contents/Info.plist" apps/mac/resources/Tempo.entitlements
if [[ "$mode" == --adhoc ]]; then
  codesign --force --sign - "$app"
else
  codesign --force --options runtime --timestamp --entitlements apps/mac/resources/Tempo.entitlements --sign "$TEMPO_MAC_SIGN_IDENTITY" "$app"
fi
codesign --verify --deep --strict --verbose=2 "$app"
dmg="$out/Tempo-$version.dmg"
hdiutil create -volname Tempo -srcfolder "$app" -ov -format UDZO "$dmg"
if [[ "$mode" != --adhoc ]]; then
  codesign --force --timestamp --sign "$TEMPO_MAC_SIGN_IDENTITY" "$dmg"
  codesign --verify --strict "$dmg"
  xcrun notarytool submit "$dmg" --keychain-profile "$TEMPO_MAC_NOTARY_PROFILE" --wait
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
  spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
fi
python3 scripts/mac/manifest.py manifest "$version" "$dmg" "$out/latest.json"
if [[ "$mode" == --publish ]]; then
  bunx --no-install wrangler r2 object put "$TEMPO_MAC_BUCKET/clients/mac/$version/Tempo-$version.dmg" --remote --file "$dmg" --content-type application/x-apple-diskimage
  bunx --no-install wrangler r2 object get "$TEMPO_MAC_BUCKET/clients/mac/$version/Tempo-$version.dmg" --remote --file "$out/uploaded.dmg"
  cmp "$dmg" "$out/uploaded.dmg"
  bunx --no-install wrangler r2 object put "$TEMPO_MAC_BUCKET/clients/mac/latest.json" --remote --file "$out/latest.json" --content-type application/json
fi
printf 'Built %s\n' "$dmg"
