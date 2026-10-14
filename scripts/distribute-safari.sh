#!/bin/bash
# This command produces public distribution apps, never development builds.
set -euo pipefail
umask 077
project_root="$(cd -- "$(dirname -- "$0")/.." && pwd)"
identity=""
team_id=""
notary_profile=""
variant="all"
output_root="$project_root/dist/release"
log_root="${PANOPTO_DISTRIBUTION_LOG_DIR:-$HOME/Library/Logs/PanoptoDownloader}"
usage() {
  printf '%s\n' 'Usage: distribute-safari.sh --identity "Developer ID Application: NAME (TEAM)" --team-id TEAM --notary-profile PROFILE [--variant all|standalone|with-helper] [--output-dir DIR]'
}
fail() { printf '%s\n' "$1" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --help) usage; exit 0 ;;
    --identity|--team-id|--notary-profile|--variant|--output-dir)
      [ "$#" -ge 2 ] || fail "Missing value for $1."
      case "$1" in
        --identity) identity="$2" ;;
        --team-id) team_id="$2" ;;
        --notary-profile) notary_profile="$2" ;;
        --variant) variant="$2" ;;
        --output-dir) output_root="$2" ;;
      esac
      shift 2 ;;
    *) usage >&2; fail "Unknown option: $1" ;;
  esac
done
case "$identity" in 'Developer ID Application: '*) ;; *) fail 'A Developer ID Application identity is required. Apple Development, ad-hoc and unsigned apps are not distribution builds.' ;; esac
[[ "$team_id" =~ ^[A-Z0-9]{10}$ ]] || fail 'A ten-character Apple Developer Team ID is required.'
[ -n "$notary_profile" ] || fail 'A notarytool Keychain profile is required; never pass passwords or private keys to this script.'
case "$variant" in all) variants=(standalone with-helper) ;; standalone|with-helper) variants=("$variant") ;; *) fail 'Variant must be all, standalone or with-helper.' ;; esac
[ "$(uname -s)" = Darwin ] || fail 'Safari distribution requires macOS and full Xcode.'
for tool in node security codesign xcrun spctl ditto plutil lipo; do
  command -v "$tool" >/dev/null || fail "Missing required tool: $tool"
done
xcrun --find notarytool >/dev/null || fail 'notarytool is unavailable; select a full Xcode installation.'
xcrun --find stapler >/dev/null || fail 'stapler is unavailable; select a full Xcode installation.'
version="$(node -e 'const v=require(process.argv[1]).version;if(!/^\d+\.\d+\.\d+$/.test(v))process.exit(1);process.stdout.write(v)' "$project_root/package.json")"
node - "$project_root" "$version" "${variants[@]}" <<'NODE'
const fs = require('node:fs'), path = require('node:path');
const [root, version, ...variants] = process.argv.slice(2);
for (const variant of variants) {
  const source = variant === 'standalone' ? 'extension' : 'extension-helper';
  if (JSON.parse(fs.readFileSync(path.join(root, source, 'manifest.json'), 'utf8')).version !== version) throw new Error('Package and extension versions must match.');
}
NODE
mkdir -p "$output_root" "$log_root"
output_root="$(cd -- "$output_root" && pwd)"
for selected in "${variants[@]}"; do
  [ ! -e "$output_root/panopto-$version-safari-$selected-macos.zip" ] || fail 'A distribution ZIP already exists. Use a fresh output directory; existing release assets are never overwritten.'
done
[ ! -e "$output_root/SAFARI-SHA256SUMS" ] || fail 'SAFARI-SHA256SUMS already exists. Use a fresh output directory.'
logs="$(mktemp -d "$log_root/distribution.XXXXXX")"
work="$(mktemp -d "${TMPDIR:-/tmp}/panopto-distribution.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
trap 'printf "Distribution stopped. Private diagnostics: %s\n" "$logs" >&2' ERR
security find-identity -v -p codesigning > "$logs/identities.txt"
fingerprint="$(node - "$logs/identities.txt" "$identity" <<'NODE'
const fs = require('node:fs');
const wanted = process.argv[3];
const matches = fs.readFileSync(process.argv[2], 'utf8').split('\n').map(line => /\b([A-Fa-f0-9]{40}) \x22([^\x22\n]+)\x22/.exec(line)).filter(match => match && match[2] === wanted);
if (matches.length !== 1) throw new Error('Exactly one valid matching Developer ID Application identity with a private key is required.');
process.stdout.write(matches[0][1]);
NODE
)"
# Confirm the Keychain profile before spending time building. Credentials stay
# in the Keychain; this output is a private local diagnostic, not a release asset.
xcrun notarytool history --keychain-profile "$notary_profile" --output-format json > "$logs/notary-history.json" 2> "$logs/notary-history.stderr"
cat > "$work/extension-entitlements.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.app-sandbox</key><true/>
<key>com.apple.security.files.user-selected.read-only</key><true/>
<key>com.apple.security.get-task-allow</key><false/>
</dict></plist>
PLIST
cat > "$work/app-entitlements.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.app-sandbox</key><true/>
<key>com.apple.security.files.user-selected.read-only</key><true/>
<key>com.apple.security.network.client</key><true/>
<key>com.apple.security.get-task-allow</key><false/>
</dict></plist>
PLIST
verify_bundle() {
  local target="$1" log_prefix="$2"
  local expected_bundle="$bundle_id" executable
  case "$target" in *.appex) expected_bundle="$bundle_id.Extension" ;; esac
  plutil -convert json -o "$log_prefix.info.json" "$target/Contents/Info.plist"
  executable="$(node - "$log_prefix.info.json" "$expected_bundle" "$version" <<'NODE'
const info = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
if (info.CFBundleIdentifier !== process.argv[3] || info.CFBundleShortVersionString !== process.argv[4] || info.CFBundleVersion !== process.argv[4]) throw new Error('Built app bundle identity or version does not match the release.');
if (info.LSMinimumSystemVersion !== '12.0') throw new Error('The app and extension must support macOS 12.0.');
if (!/^[^/\\]+$/.test(info.CFBundleExecutable || '')) throw new Error('Invalid executable name.');
process.stdout.write(info.CFBundleExecutable);
NODE
)"
  lipo -archs "$target/Contents/MacOS/$executable" > "$log_prefix.architectures"
  node - "$log_prefix.architectures" <<'NODE'
const architectures = require('node:fs').readFileSync(process.argv[2], 'utf8').trim().split(/\s+/);
if (!architectures.includes('arm64') || !architectures.includes('x86_64')) throw new Error('Distribution apps must include Apple Silicon and Intel architectures.');
NODE
  codesign --verify --deep --strict "$target" > "$log_prefix.verify" 2>&1
  codesign --display --verbose=4 "$target" > "$log_prefix.signature" 2>&1
  codesign --display --entitlements :- "$target" > "$log_prefix.entitlements" 2> "$log_prefix.entitlements.stderr"
  node - "$log_prefix.signature" "$log_prefix.entitlements" "$identity" "$team_id" <<'NODE'
const fs = require('node:fs');
const [signature, entitlements, identity, team] = process.argv.slice(2);
const text = fs.readFileSync(signature, 'utf8');
const plist = fs.readFileSync(entitlements, 'utf8');
if (!text.split('\n').includes(`Authority=${identity}`) || !text.split('\n').includes(`TeamIdentifier=${team}`)) throw new Error('Unexpected signing authority or team.');
if (!/flags=.*\bruntime\b/.test(text) || !/^Timestamp=.+/m.test(text)) throw new Error('Hardened Runtime and secure timestamp are required.');
if (!/<key>com\.apple\.security\.get-task-allow<\/key>\s*<false\s*\/>/.test(plist)) throw new Error('Distribution must explicitly disable get-task-allow.');
NODE
}
for selected in "${variants[@]}"; do
  printf 'Building and notarizing Safari %s %s…\n' "$selected" "$version"
  selected_logs="$logs/$selected"
  mkdir -p "$selected_logs"
  bundle="$work/$selected"
  mkdir -p "$bundle"
  if [ "$selected" = standalone ]; then extension_source="$project_root/extension"; else extension_source="$project_root/extension-helper"; fi
  PANOPTO_EXTENSION_SOURCE="$extension_source" bash "$project_root/scripts/build-safari.sh" --variant "$selected" \
    --configuration Release --unsigned-build-only --output-dir "$bundle" > "$selected_logs/build.log" 2>&1
  if [ "$selected" = standalone ]; then
    app_name='Panopto Downloader'
    bundle_id='org.panoptodownloader.Panopto-Downloader'
  else
    app_name='Panopto Downloader Helper'
    bundle_id='org.panoptodownloader.Panopto-Downloader-Helper'
  fi
  app="$bundle/$app_name.app"
  [ -d "$app/Contents/PlugIns" ] || fail 'The built app is missing its Safari extension.'
  # Sign code from the inside out. --deep is used for verification only.
  find "$app" -depth \( -name '*.dylib' -o -name '*.framework' -o -name '*.xpc' -o -name '*.appex' -o -name '*.app' \) -print0 > "$work/signing-targets"
  count=0
  code_index=0
  while IFS= read -r -d '' target; do
    entitlements=()
    case "$target" in
      *.appex) entitlements=(--entitlements "$work/extension-entitlements.plist"); count=$((count + 1)) ;;
      *.app) entitlements=(--entitlements "$work/app-entitlements.plist") ;;
    esac
    codesign --force --sign "$fingerprint" --options runtime --timestamp \
      ${entitlements[@]+"${entitlements[@]}"} "$target" >> "$selected_logs/sign.log" 2>&1
    code_index=$((code_index + 1))
    case "$target" in *.appex|*.app) verify_bundle "$target" "$selected_logs/code-$code_index" ;; esac
  done < "$work/signing-targets"
  [ "$count" -ge 1 ] || fail 'No Safari extension was signed.'
  verify_bundle "$app" "$selected_logs/app"
  # The upload archive is temporary. The final ZIP is created only after the
  # ticket has been attached and Gatekeeper has accepted the resulting app.
  ditto --noextattr --norsrc -c -k --keepParent "$app" "$work/$selected-notary.zip"
  xcrun notarytool submit "$work/$selected-notary.zip" --keychain-profile "$notary_profile" \
    --wait --output-format json > "$selected_logs/notary-result.json" 2> "$selected_logs/notary-submit.stderr"
  submission="$(node - "$selected_logs/notary-result.json" <<'NODE'
const result = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
if (result.status !== 'Accepted' || !/^[a-f0-9-]{36}$/i.test(result.id || '')) throw new Error('Apple notarization was not Accepted; nothing will be published.');
process.stdout.write(result.id);
NODE
)"
  xcrun notarytool log "$submission" --keychain-profile "$notary_profile" "$selected_logs/notary-log.json" > "$selected_logs/notary-log.stdout" 2> "$selected_logs/notary-log.stderr"
  xcrun stapler staple "$app" > "$selected_logs/staple.log" 2>&1
  xcrun stapler validate "$app" > "$selected_logs/staple-validate.log" 2>&1
  verify_bundle "$app" "$selected_logs/stapled-app"
  spctl --assess --type execute --verbose=2 "$app" > "$selected_logs/gatekeeper.log" 2>&1
  if [ "$selected" = with-helper ]; then
    node --input-type=module - "$project_root/scripts/package-release.mjs" "$bundle" "$version" <<'NODE'
import {pathToFileURL} from 'node:url';
const {addHelper} = await import(pathToFileURL(process.argv[2]));
await addHelper(process.argv[3], process.argv[4], `https://github.com/joonseokym/panopto-download/releases/download/v${process.argv[4]}`);
NODE
  fi
  cat > "$bundle/INSTALL.md" <<INSTALL
# Panopto Downloader $version — Safari $selected

Move "$app_name.app" to your Applications folder, open it, then enable its extension in Safari Settings → Extensions. Allow access to your Panopto website. Enable only one Panopto Downloader variant at a time.

This app is signed with Developer ID Application and has an Apple notarization ticket attached. Default downloads use your Downloads folder; Safari's standalone variant follows Safari Settings → General → File download location.
INSTALL
  if [ "$selected" = with-helper ]; then
    printf '\nThis bundle also contains helper source and launchers. Install Python 3.9+ and FFmpeg/FFprobe separately, then follow helper/README.md. Signing and notarization apply to the Safari app; these interpreter dependencies are not bundled.\n' >> "$bundle/INSTALL.md"
  fi
  ditto --noextattr --norsrc -c -k "$bundle" "$work/panopto-$version-safari-$selected-macos.zip"
  extracted="$work/extracted-$selected"
  mkdir -p "$extracted"
  ditto -x -k "$work/panopto-$version-safari-$selected-macos.zip" "$extracted"
  verify_bundle "$extracted/$app_name.app" "$selected_logs/extracted-app"
  xcrun stapler validate "$extracted/$app_name.app" > "$selected_logs/extracted-staple-validate.log" 2>&1
  spctl --assess --type execute --verbose=2 "$extracted/$app_name.app" > "$selected_logs/extracted-gatekeeper.log" 2>&1
done
# Publish locally only after every requested variant passed all checks. This
# script intentionally does not upload assets or replace an existing release.
node - "$work" "$output_root" "$version" "${variants[@]}" <<'NODE'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const [work, output, version, ...variants] = process.argv.slice(2);
const files = variants.map(variant => `panopto-${version}-safari-${variant}-macos.zip`);
const checksums = [];
for (const name of files) {
  const data = fs.readFileSync(path.join(work, name));
  checksums.push(`${crypto.createHash('sha256').update(data).digest('hex')}  ${name}`);
}
for (const name of files) fs.copyFileSync(path.join(work, name), path.join(output, name), fs.constants.COPYFILE_EXCL);
fs.writeFileSync(path.join(output, 'SAFARI-SHA256SUMS'), `${checksums.join('\n')}\n`, {flag: 'wx'});
NODE
printf 'Verified distribution files: %s\nPrivate diagnostics: %s\n' "$output_root" "$logs"
