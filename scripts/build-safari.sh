#!/bin/bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "$0")/.." && pwd)"
build_root="$project_root/build/safari"
app_name="Panopto Downloader"
team_id="${1:-}"
derived_data="$(mktemp -d "${TMPDIR:-/tmp}/panopto-safari-build.XXXXXX")"
trap 'rm -rf -- "$derived_data"' EXIT

# The Safari package removes browser APIs that Safari does not support.
# Always regenerate it so the app includes the current extension source.
node "$project_root/scripts/package.mjs"
extension_version="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version)' "$project_root/dist/safari/extension/manifest.json")"

if ! xcrun --find safari-web-extension-packager >/dev/null 2>&1; then
  packager=safari-web-extension-converter
else
  packager=safari-web-extension-packager
fi

mkdir -p "$build_root"
xcrun "$packager" "$project_root/dist/safari/extension" \
  --project-location "$build_root/project" \
  --app-name "$app_name" \
  --bundle-identifier "org.panoptodownloader.Panopto-Downloader" \
  --swift --macos-only --copy-resources --no-open --no-prompt --force

project_file="$build_root/project/$app_name/$app_name.xcodeproj"
if [ ! -d "$project_file" ]; then
  project_file="$build_root/project/$app_name.xcodeproj"
fi
if [ ! -d "$project_file" ]; then
  echo "Generated Xcode project not found. Inspect $build_root/project." >&2
  exit 1
fi

signing=(CODE_SIGNING_ALLOWED=NO)
if [ -n "$team_id" ]; then
  signing=("DEVELOPMENT_TEAM=$team_id" CODE_SIGN_STYLE=Automatic)
fi
xcodebuild -project "$project_file" -scheme "$app_name" \
  -configuration Debug -derivedDataPath "$derived_data" \
  "MARKETING_VERSION=$extension_version" "CURRENT_PROJECT_VERSION=$extension_version" \
  "${signing[@]}" build

mkdir -p "$project_root/dist/safari"
compiled_app="$derived_data/Build/Products/Debug/$app_name.app"
if [ -n "$team_id" ]; then
  codesign --verify --deep --strict "$compiled_app"
fi
# Package the verified app before a cloud file provider can attach Finder data.
ditto --noextattr --norsrc -c -k --keepParent "$compiled_app" \
  "$project_root/dist/safari/panopto-downloader-macos.zip"
ditto --noextattr "$compiled_app" "$project_root/dist/safari/$app_name.app"
# Cloud-synced folders can add Finder bundle metadata after a clean copy.
# Remove only signing-incompatible Finder/resource-fork metadata, preserving
# quarantine and all other security-related extended attributes.
xattr -dr com.apple.FinderInfo "$project_root/dist/safari/$app_name.app" 2>/dev/null || true
xattr -dr com.apple.ResourceFork "$project_root/dist/safari/$app_name.app" 2>/dev/null || true
printf '\nBuilt: %s\n' "$project_root/dist/safari/$app_name.app"
if [ -z "$team_id" ]; then
  printf '%s\n' 'Unsigned build. Pass your Apple Development Team ID to build a signed local app.'
fi
