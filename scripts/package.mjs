import {readFile, readdir, mkdir, copyFile, rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = path.join(root, 'extension');
const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) throw new Error('Manifest V3 is required.');
if (!/^[0-9]+(?:\.[0-9]+){0,3}$/.test(manifest.version)) throw new Error('Invalid extension version.');

async function copyDirectory(from, to) {
  await mkdir(to, {recursive: true});
  for (const item of await readdir(from, {withFileTypes: true})) {
    if (item.name.startsWith('.')) continue;
    const destination = path.join(to, item.name);
    if (item.isDirectory()) await copyDirectory(path.join(from, item.name), destination);
    else if (item.isFile()) await copyFile(path.join(from, item.name), destination);
    else throw new Error(`Unsupported package entry: ${item.name}`);
  }
}

for (const browser of ['chrome', 'safari']) {
  const destination = path.join(root, 'dist', browser);
  await mkdir(destination, {recursive: true});
  const unpacked = path.join(destination, 'extension');
  await rm(unpacked, {recursive: true, force: true});
  await copyDirectory(source, unpacked);
  const archive = path.join(destination, `panopto-downloader-${manifest.version}.zip`);
  await rm(archive, {force: true});
  if (process.platform === 'darwin') execFileSync('/usr/bin/ditto', ['-c', '-k', unpacked, archive]);
  else execFileSync('zip', ['-q', '-r', archive, '.'], {cwd: unpacked});
  console.log(archive);
}
