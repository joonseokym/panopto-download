const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const variants = [
  {browser: 'chrome', mode: 'standalone'},
  {browser: 'chrome', mode: 'with-helper'},
  {browser: 'safari', mode: 'standalone'},
  {browser: 'safari', mode: 'with-helper'}
].map(variant => ({...variant, name: `panopto-${version}-${variant.browser}-${variant.mode}${variant.browser === 'safari' ? '-source' : ''}.zip`}));
let output;

function archiveFile(variant, name) {
  return execFileSync('unzip', ['-p', path.join(output, variant.name), name], {maxBuffer: 16 * 1024 * 1024});
}
function archiveText(variant, name) { return archiveFile(variant, name).toString('utf8'); }
function files(variant) {
  return execFileSync('unzip', ['-Z1', path.join(output, variant.name)], {encoding: 'utf8'})
    .trim().split(/\r?\n/).filter(Boolean);
}

before(() => {
  output = fs.mkdtempSync(path.join(os.tmpdir(), 'panopto-release-test-'));
  execFileSync(process.execPath, [path.join(root, 'scripts/package-release.mjs')], {
    cwd: root, env: {...process.env, RELEASE_OUTPUT_DIR: output}, stdio: 'pipe', maxBuffer: 4 * 1024 * 1024
  });
});
after(() => { if (output) fs.rmSync(output, {recursive: true, force: true}); });

test('release builds four explicitly named browser and installation choices', () => {
  assert.deepEqual(fs.readdirSync(output).sort(), [
    ...variants.map(variant => variant.name), 'INSTALL.md', 'SHA256SUMS', 'release-notes.md'
  ].sort());
  for (const source of ['extension', 'extension-helper']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, source, 'manifest.json'), 'utf8'));
    assert.equal(manifest.version, version, `${source} must use the release version`);
  }
});

test('each release ZIP has the selected extension with all declared resources and appropriate permissions', () => {
  for (const variant of variants) {
    const entries = new Set(files(variant));
    const source = variant.mode === 'standalone' ? 'extension' : 'extension-helper';
    const expected = JSON.parse(fs.readFileSync(path.join(root, source, 'manifest.json'), 'utf8'));
    if (variant.browser === 'safari') expected.permissions = expected.permissions.filter(permission => permission !== 'downloads');
    const manifest = JSON.parse(archiveText(variant, 'extension/manifest.json'));
    assert.deepEqual(manifest, expected, variant.name);
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.version, version);
    assert.ok(!manifest.permissions.includes('nativeMessaging'));
    assert.ok(!manifest.permissions.includes('cookies'));
    assert.equal(manifest.host_permissions.some(host => host.includes('127.0.0.1')), variant.mode === 'with-helper');
    assert.equal(manifest.permissions.includes('downloads'), variant.browser === 'chrome' && variant.mode === 'standalone');
    const referenced = [
      manifest.background.service_worker, manifest.action.default_popup, manifest.options_ui.page,
      ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
      ...manifest.content_scripts.flatMap(script => [...(script.js || []), ...(script.css || [])])
    ];
    for (const name of referenced) assert.ok(entries.has(`extension/${name}`), `${variant.name} is missing ${name}`);
    for (const name of ['background.js', 'common.js', 'content.js']) {
      assert.deepEqual(archiveFile(variant, `extension/${name}`), fs.readFileSync(path.join(root, source, name)));
    }
    assert.ok(entries.has('INSTALL.md'));
    for (const icon of Object.values(manifest.icons)) {
      assert.deepEqual(archiveFile(variant, `extension/${icon}`).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }
  }
});

test('standalone archives omit the helper and helper archives contain its runnable files', () => {
  for (const variant of variants) {
    const entries = files(variant);
    const helperFiles = entries.filter(name => name.startsWith('helper/'));
    if (variant.mode === 'standalone') {
      assert.deepEqual(helperFiles, [], variant.name);
      for (const name of entries.filter(name => /^extension\/.*\.js$/.test(name))) {
        assert.ok(!archiveText(variant, name).includes('127.0.0.1:8765'), `${variant.name}: ${name}`);
      }
      for (const name of ['media.js', 'queue.js', 'downloads.js', 'downloads.html']) {
        assert.ok(entries.includes(`extension/${name}`), `${variant.name}: ${name}`);
      }
    } else {
      for (const name of ['panopto_download.py', 'static/index.html', 'bookmarklet.js', 'start-helper.sh', 'start.command', 'README.md']) {
        assert.ok(entries.includes(`helper/${name}`), `${variant.name}: helper/${name}`);
      }
      for (const name of ['panopto_download.py', 'static/index.html', 'bookmarklet.js']) {
        assert.deepEqual(archiveFile(variant, `helper/${name}`), fs.readFileSync(path.join(root, name)));
      }
      assert.match(archiveText(variant, 'extension/common.js'), /127\.0\.0\.1:8765/);
      assert.match(archiveText(variant, 'helper/start-helper.sh'), /panopto_download\.py/);
    }
  }
});

test('Safari packages are self-contained build sources, explicitly distinguished from signed apps', () => {
  for (const variant of variants) {
    const entries = files(variant);
    if (variant.browser === 'safari') {
      for (const name of ['package.json', 'scripts/package.mjs', 'scripts/build-safari.sh', 'Build Safari.command']) {
        assert.ok(entries.includes(name), `${variant.name}: ${name}`);
      }
      const bundledPackage = JSON.parse(archiveText(variant, 'package.json'));
      assert.equal(bundledPackage.version, version);
      assert.match(archiveText(variant, 'Build Safari.command'), /PANOPTO_EXTENSION_SOURCE/);
      assert.match(archiveText(variant, 'Build Safari.command'), /build-safari\.sh/);
      assert.ok(!entries.some(name => /\.app(?:\/|$)/i.test(name)));
      assert.match(archiveText(variant, 'INSTALL.md'), /(?:공증|notari)/i);
      assert.match(archiveText(variant, 'INSTALL.md'), /Xcode/);
    } else {
      assert.ok(!entries.includes('Build Safari.command'));
      assert.ok(!entries.includes('scripts/build-safari.sh'));
    }
  }
});

test('release archives exclude local credentials, state, media, build products, and unsafe paths', () => {
  const forbiddenPart = /^(?:\.git|\.state|\.env(?:\..*)?|node_modules|__MACOSX|dist|build|DerivedData|__pycache__)$/i;
  const forbiddenFile = /(?:\.(?:mp4|m4v|m4a|webm|m3u8|ts|pyc|p12|pfx|pem|key|cer|mobileprovision|provisionprofile)|\.DS_Store)$/i;
  for (const variant of variants) {
    for (const name of files(variant)) {
      assert.ok(!name.startsWith('/') && !name.includes('\\') && !/^[A-Za-z]:/.test(name), `${variant.name}: ${name}`);
      const parts = name.split('/');
      assert.ok(!parts.some(part => part === '..' || forbiddenPart.test(part)), `${variant.name}: ${name}`);
      assert.ok(!forbiddenFile.test(name), `${variant.name}: ${name}`);
      assert.ok(!/\.(?:app|xcodeproj|xcworkspace)(?:\/|$)/i.test(name), `${variant.name}: ${name}`);
    }
  }
});

test('SHA256SUMS covers precisely the downloadable ZIPs and installation guide', () => {
  const expected = [...variants.map(variant => variant.name), 'INSTALL.md'].sort();
  const lines = fs.readFileSync(path.join(output, 'SHA256SUMS'), 'utf8').trim().split(/\r?\n/);
  const checked = [];
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    assert.ok(match, `Invalid checksum line: ${line}`);
    const [, digest, name] = match;
    assert.ok(expected.includes(name), `Unexpected checksum entry: ${name}`);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(output, name))).digest('hex'), digest, name);
    checked.push(name);
  }
  assert.deepEqual(checked.sort(), expected);
  const notes = fs.readFileSync(path.join(output, 'release-notes.md'), 'utf8');
  for (const variant of variants) assert.ok(notes.includes(variant.name), `Release notes omit ${variant.name}`);
});
