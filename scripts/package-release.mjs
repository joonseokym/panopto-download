import {readFile, writeFile, mkdir, copyFile, chmod, mkdtemp, rm, lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {packageVariant, copyExtension, createZip, projectRoot} from './package.mjs';

const helperFiles = ['panopto_download.py', 'static/index.html', 'bookmarklet.js'];
const helperLauncher = `#!/bin/bash
set -euo pipefail
helper_root="$(cd -- "$(dirname -- "$0")" && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
for dependency in python3 ffmpeg ffprobe; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    printf 'Missing dependency: %s. Install Python 3.9+ and FFmpeg before starting.\\n' "$dependency" >&2
    exit 1
  fi
done
if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'; then
  printf '%s\\n' 'Python 3.9 or newer is required.' >&2
  exit 1
fi
printf '%s\\n' 'Pair your extension at http://127.0.0.1:8765 after the helper starts.'
exec python3 "$helper_root/panopto_download.py" "$@"
`;
const helperCommand = `#!/bin/bash
set -euo pipefail
helper_root="$(cd -- "$(dirname -- "$0")" && pwd)"
exec /bin/bash "$helper_root/start-helper.sh" "$@"
`;

function renderTemplate(value, version, releaseBaseUrl) {
  const rendered = value.replaceAll('{{VERSION}}', version).replaceAll('{{RELEASE_BASE_URL}}', releaseBaseUrl);
  if (/\{\{[A-Z_]+\}\}/.test(rendered)) throw new Error('An unresolved placeholder remains in the release documentation.');
  return rendered;
}

async function copySource(relative, destination) {
  const source = path.join(projectRoot, relative);
  if (!(await lstat(source)).isFile()) throw new Error(`Release source is not a regular file: ${relative}`);
  await mkdir(path.dirname(destination), {recursive: true});
  await copyFile(source, destination);
}

async function addHelper(directory, version, releaseBaseUrl) {
  const destination = path.join(directory, 'helper');
  await mkdir(destination, {recursive: true});
  for (const relative of helperFiles) await copySource(relative, path.join(destination, relative));
  const instructions = await readFile(path.join(projectRoot, 'docs', 'helper.md'), 'utf8');
  await writeFile(path.join(destination, 'README.md'), renderTemplate(instructions, version, releaseBaseUrl));
  await writeFile(path.join(destination, 'start-helper.sh'), helperLauncher, {mode: 0o755});
  await writeFile(path.join(destination, 'start.command'), helperCommand, {mode: 0o755});
}

async function addSafariBuildSource(directory, variant, version) {
  await mkdir(path.join(directory, 'scripts'), {recursive: true});
  for (const relative of ['scripts/package.mjs', 'scripts/build-safari.sh']) {
    await copySource(relative, path.join(directory, relative));
  }
  await chmod(path.join(directory, 'scripts', 'build-safari.sh'), 0o755);
  const metadata = {
    name: `panopto-safari-${variant}-source`,
    version,
    private: true,
    description: 'Local Safari build source; no distributable signed app is included.',
    engines: {node: '>=20'},
    scripts: {package: `PANOPTO_EXTENSION_SOURCE=./extension node scripts/package.mjs --variant ${variant}`},
  };
  await writeFile(path.join(directory, 'package.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  const command = `#!/bin/bash
set -euo pipefail
package_root="$(cd -- "$(dirname -- "$0")" && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export PANOPTO_EXTENSION_SOURCE="$package_root/extension"
exec /bin/bash "$package_root/scripts/build-safari.sh" --variant ${variant} "$@"
`;
  await writeFile(path.join(directory, 'Build Safari.command'), command, {mode: 0o755});
}

export async function packageRelease({outputDirectory = process.env.RELEASE_OUTPUT_DIR || path.join(projectRoot, 'dist', 'release')} = {}) {
  outputDirectory = path.resolve(outputDirectory);
  const packageMetadata = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const version = packageMetadata.version;
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) throw new Error('A three-component release version is required.');
  const releaseBaseUrl = process.env.RELEASE_BASE_URL || `https://github.com/joonseokym/panopto-download/releases/download/v${version}`;
  const installation = renderTemplate(await readFile(path.join(projectRoot, 'release', 'INSTALL.md'), 'utf8'), version, releaseBaseUrl);
  const notes = renderTemplate(await readFile(path.join(projectRoot, 'release', 'release-notes.md'), 'utf8'), version, releaseBaseUrl);
  const stageRoot = await mkdtemp(path.join(os.tmpdir(), 'panopto-release-'));
  const names = [];
  try {
    // Package each variant independently from its tracked source. No state,
    // browser profile, downloaded lecture, or locally signed app is copied.
    for (const variant of ['standalone', 'with-helper']) {
      const source = path.join(projectRoot, variant === 'standalone' ? 'extension' : 'extension-helper');
      const packaged = await packageVariant({variant, source, outputRoot: path.join(stageRoot, 'packages', variant)});
      for (const browser of ['chrome', 'safari']) {
        if (packaged[browser].manifest.version !== version) throw new Error(`Version mismatch for ${variant}: package.json and manifest.json must match.`);
        const bundle = path.join(stageRoot, 'bundles', `${browser}-${variant}`);
        await mkdir(bundle, {recursive: true});
        await copyExtension(packaged[browser].unpacked, path.join(bundle, 'extension'));
        await writeFile(path.join(bundle, 'INSTALL.md'), installation);
        if (variant === 'with-helper') await addHelper(bundle, version, releaseBaseUrl);
        if (browser === 'safari') await addSafariBuildSource(bundle, variant, version);
        const name = `panopto-${version}-${browser}-${variant}${browser === 'safari' ? '-source' : ''}.zip`;
        const archive = path.join(stageRoot, name);
        createZip(bundle, archive);
        names.push(name);
      }
    }
    await writeFile(path.join(stageRoot, 'INSTALL.md'), installation);
    names.push('INSTALL.md');
    const checksums = [];
    for (const name of names) {
      const digest = createHash('sha256').update(await readFile(path.join(stageRoot, name))).digest('hex');
      checksums.push(`${digest}  ${name}`);
    }
    await writeFile(path.join(stageRoot, 'SHA256SUMS'), `${checksums.join('\n')}\n`);
    await writeFile(path.join(stageRoot, 'release-notes.md'), notes);
    await mkdir(outputDirectory, {recursive: true});
    for (const name of [...names, 'SHA256SUMS', 'release-notes.md']) {
      await copyFile(path.join(stageRoot, name), path.join(outputDirectory, name));
    }
    return {version, outputDirectory, assets: [...names, 'SHA256SUMS'].map(name => path.join(outputDirectory, name)), notes: path.join(outputDirectory, 'release-notes.md')};
  } finally {
    await rm(stageRoot, {recursive: true, force: true});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/package-release.mjs');
  const result = await packageRelease();
  for (const asset of result.assets) console.log(asset);
  console.log(result.notes);
}
