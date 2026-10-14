#!/bin/bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "$0")/.." && pwd)"
variant="standalone"
team_id=""
configuration="Debug"
custom_output=""
unsigned_build_only=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --variant)
      if [ "$#" -lt 2 ]; then
        printf '%s\n' 'Missing value for --variant.' >&2
        exit 1
      fi
      variant="$2"
      shift 2
      ;;
    --configuration|--output-dir)
      if [ "$#" -lt 2 ]; then
        printf 'Missing value for %s.\n' "$1" >&2
        exit 1
      fi
      if [ "$1" = --configuration ]; then configuration="$2"; else custom_output="$2"; fi
      shift 2
      ;;
    --unsigned-build-only)
      unsigned_build_only=true
      shift
      ;;
    --*)
      printf 'Unknown option: %s\n' "$1" >&2
      exit 1
      ;;
    *)
      if [ -n "$team_id" ]; then
        printf '%s\n' 'Usage: build-safari.sh [--variant standalone|with-helper] [TEAM_ID]' >&2
        exit 1
      fi
      team_id="$1"
      shift
      ;;
  esac
done
case "$configuration" in Debug|Release) ;; *) printf '%s\n' 'Configuration must be Debug or Release.' >&2; exit 1 ;; esac
if [ "$unsigned_build_only" = true ] && [ -n "$team_id" ]; then
  printf '%s\n' '--unsigned-build-only cannot be combined with a signing team.' >&2
  exit 1
fi
case "$variant" in
  standalone)
    build_root="$project_root/build/safari"
    output_root="$project_root/dist/safari"
    app_name="Panopto Downloader"
    bundle_id="org.panoptodownloader.Panopto-Downloader"
    ;;
  with-helper)
    build_root="$project_root/build/with-helper/safari"
    output_root="$project_root/dist/with-helper/safari"
    app_name="Panopto Downloader Helper"
    bundle_id="org.panoptodownloader.Panopto-Downloader-Helper"
    ;;
  *)
    printf '%s\n' 'Variant must be standalone or with-helper.' >&2
    exit 1
    ;;
esac
if [ -n "$custom_output" ]; then
  mkdir -p "$custom_output"
  output_root="$(cd -- "$custom_output" && pwd)"
fi
derived_data="$(mktemp -d "${TMPDIR:-/tmp}/panopto-safari-build.XXXXXX")"
trap 'rm -rf -- "$derived_data"' EXIT

# Source release bundles set PANOPTO_EXTENSION_SOURCE to their selected
# extension/ directory; repository builds select extension/ or extension-helper/.
extension_source="$output_root/extension"
if [ -n "$custom_output" ]; then
  node --input-type=module - "$project_root/scripts/package.mjs" "$variant" "$derived_data/packages" <<'NODE'
import {pathToFileURL} from 'node:url';
const {packageVariant} = await import(pathToFileURL(process.argv[2]));
await packageVariant({variant: process.argv[3], outputRoot: process.argv[4]});
NODE
  extension_source="$derived_data/packages/safari/extension"
else
  node "$project_root/scripts/package.mjs" --variant "$variant"
fi
extension_version="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version)' "$extension_source/manifest.json")"

if ! xcrun --find safari-web-extension-packager >/dev/null 2>&1; then
  packager=safari-web-extension-converter
else
  packager=safari-web-extension-packager
fi

mkdir -p "$build_root"
xcrun "$packager" "$extension_source" \
  --project-location "$build_root/project" \
  --app-name "$app_name" \
  --bundle-identifier "$bundle_id" \
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
release_settings=()
if [ "$configuration" = Release ]; then
  release_settings=(ONLY_ACTIVE_ARCH=NO "ARCHS=arm64 x86_64")
fi
if [ -n "$team_id" ]; then
  signing=("DEVELOPMENT_TEAM=$team_id" CODE_SIGN_STYLE=Automatic)
fi
xcodebuild -project "$project_file" -scheme "$app_name" \
  -configuration "$configuration" -derivedDataPath "$derived_data" \
  "MARKETING_VERSION=$extension_version" "CURRENT_PROJECT_VERSION=$extension_version" \
  MACOSX_DEPLOYMENT_TARGET=12.0 \
  ENABLE_HARDENED_RUNTIME=YES \
  "${signing[@]}" ${release_settings[@]+"${release_settings[@]}"} build

mkdir -p "$output_root"
compiled_app="$derived_data/Build/Products/$configuration/$app_name.app"
if [ -n "$team_id" ]; then
  codesign --verify --deep --strict "$compiled_app"
fi
# Package the verified app before a cloud file provider can attach Finder data.
if [ "$unsigned_build_only" = false ]; then
  ditto --noextattr --norsrc -c -k --keepParent "$compiled_app" \
    "$output_root/panopto-downloader-macos.zip"
fi
ditto --noextattr "$compiled_app" "$output_root/$app_name.app"
# Preserve quarantine and security attributes; remove only signing-incompatible
# Finder/resource-fork metadata that cloud file providers can add.
xattr -dr com.apple.FinderInfo "$output_root/$app_name.app" 2>/dev/null || true
xattr -dr com.apple.ResourceFork "$output_root/$app_name.app" 2>/dev/null || true
printf '\nBuilt: %s\n' "$output_root/$app_name.app"
if [ -z "$team_id" ]; then
  printf '%s\n' 'Unsigned local build. Pass your Apple Development Team ID to build a signed local app.'
fi
