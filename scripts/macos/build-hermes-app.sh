#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
build_dir="$repo_root/build/macos"
app_dir="$build_dir/Hermes.app"
iconset_dir="$build_dir/AppIcon.iconset"
logo="$repo_root/packages/client/src/assets/logo.png"

rm -rf "$app_dir" "$iconset_dir"
mkdir -p "$app_dir/Contents/MacOS" "$app_dir/Contents/Resources" "$iconset_dir"

cp "$repo_root/scripts/macos/Info.plist" "$app_dir/Contents/Info.plist"

clang "$repo_root/scripts/macos/HermesApp.m" \
  -fobjc-arc \
  -framework Cocoa \
  -framework WebKit \
  -o "$app_dir/Contents/MacOS/Hermes"

sizes=(16 32 128 256 512)
for size in "${sizes[@]}"; do
  /usr/bin/sips -z "$size" "$size" "$logo" --out "$iconset_dir/icon_${size}x${size}.png" >/dev/null
  double_size=$((size * 2))
  /usr/bin/sips -z "$double_size" "$double_size" "$logo" --out "$iconset_dir/icon_${size}x${size}@2x.png" >/dev/null
done

if ! /usr/bin/iconutil -c icns "$iconset_dir" -o "$app_dir/Contents/Resources/AppIcon.icns" >/dev/null 2>&1; then
  /usr/bin/plutil -remove CFBundleIconFile "$app_dir/Contents/Info.plist" >/dev/null 2>&1 || true
fi
rm -rf "$iconset_dir"

chmod +x "$app_dir/Contents/MacOS/Hermes"
echo "$app_dir"
