import {readFile, writeFile, readdir, mkdir, copyFile, rm} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

export const projectRoot = fileURLToPath(new URL('..', import.meta.url));
export const variants = ['standalone', 'with-helper'];

export function requireVariant(value) {
  if (!variants.includes(value)) throw new Error('Variant must be standalone or with-helper.');
  return value;
}

// Only extension source files belong in distributable archives. Hidden files,
// editor state and unrelated file types never enter the copied source tree.
export async function copyExtension(from, to, relative = '') {
  await mkdir(to, {recursive: true});
  for (const item of await readdir(from, {withFileTypes: true})) {
    if (item.name.startsWith('.')) continue;
    const entry = path.posix.join(relative, item.name);
    if (item.isDirectory()) {
      if (entry !== 'icons') throw new Error(`Unexpected extension directory: ${entry}`);
      await copyExtension(path.join(from, item.name), path.join(to, item.name), entry);
    } else if (item.isFile()) {
      if (!/^(?:manifest\.json|[^/]+\.(?:js|html|css)|icons\/(?:16|32|48|128)\.png)$/.test(entry)) {
        throw new Error(`Unexpected extension file: ${entry}`);
      }
      await copyFile(path.join(from, item.name), path.join(to, item.name));
    } else throw new Error(`Unsupported extension entry: ${entry}`);
  }
}

export function createZip(directory, archive) {
  if (process.platform === 'darwin') {
    execFileSync('/usr/bin/ditto', ['--noextattr', '--norsrc', '-c', '-k', directory, archive]);
  } else {
    execFileSync('zip', ['-q', '-r', '-X', archive, '.'], {cwd: directory});
  }
}

export async function packageVariant({variant = 'standalone', source, outputRoot} = {}) {
  requireVariant(variant);
  source ||= process.env.PANOPTO_EXTENSION_SOURCE || path.join(projectRoot, variant === 'standalone' ? 'extension' : 'extension-helper');
  outputRoot ||= path.join(projectRoot, 'dist', ...(variant === 'with-helper' ? ['with-helper'] : []));
  const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
  if (manifest.manifest_version !== 3) throw new Error('Manifest V3 is required.');
  if (!/^[0-9]+(?:\.[0-9]+){0,3}$/.test(manifest.version)) throw new Error('Invalid extension version.');
  const results = {};
  for (const browser of ['chrome', 'safari']) {
    const destination = path.join(outputRoot, browser);
    await mkdir(destination, {recursive: true});
    const unpacked = path.join(destination, 'extension');
    await rm(unpacked, {recursive: true, force: true});
    await copyExtension(source, unpacked);
    // Safari saves through its browser save flow. Do not request Chrome's
    // unsupported downloads permission, while preserving all other permissions.
    const packagedManifest = structuredClone(manifest);
    if (browser === 'safari') {
      packagedManifest.permissions = (packagedManifest.permissions || []).filter(permission => permission !== 'downloads');
    }
    await writeFile(path.join(unpacked, 'manifest.json'), `${JSON.stringify(packagedManifest, null, 2)}\n`);
    const archive = path.join(destination, `panopto-downloader-${manifest.version}.zip`);
    await rm(archive, {force: true});
    createZip(unpacked, archive);
    results[browser] = {unpacked, archive, manifest: packagedManifest};
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  let variant = 'standalone';
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--variant') throw new Error('Usage: node scripts/package.mjs [--variant standalone|with-helper]');
    variant = requireVariant(args[1]);
  }
  const results = await packageVariant({variant});
  for (const result of Object.values(results)) console.log(result.archive);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
