const {test, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync, execFileSync} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const fixtures = [];
const identity = 'Developer ID Application: Test Person (ABCDEFGHIJ)';
const mockTool = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const tool = path.basename(process.argv[1]), args = process.argv.slice(2), env = process.env;
fs.appendFileSync(env.TEST_EVENTS, JSON.stringify({tool, args}) + '\\n');
const mode = env.TEST_MODE || '';
if (tool === 'uname') console.log('Darwin');
else if (tool === 'security') {
  if (mode !== 'missing-certificate') console.log('  1) ' + 'A'.repeat(40) + ' "' + env.TEST_IDENTITY + '"');
} else if (tool === 'codesign') {
  if (args.includes('--display') && args.includes('--verbose=4')) {
    console.log('Authority=' + env.TEST_IDENTITY);
    console.log('TeamIdentifier=' + (mode === 'wrong-team' ? 'WRONGTEAMXX' : 'ABCDEFGHIJ'));
    console.log('CodeDirectory flags=0x10000(runtime)');
    if (mode !== 'missing-timestamp') console.log('Timestamp=Oct 14, 2026');
  } else if (args.includes('--entitlements') && args.includes('--display')) {
    console.log('<plist><dict><key>com.apple.security.get-task-allow</key><' + (mode === 'debug-entitlement' ? 'true' : 'false') + '/></dict></plist>');
  }
} else if (tool === 'xcrun') {
  if (args[0] === '--find') console.log('/mock/' + args[1]);
  else if (args[0] === 'notarytool') {
    if (args[1] === 'history') { if (mode === 'bad-credentials') process.exit(1); console.log('{}'); }
    else if (args[1] === 'submit') console.log(JSON.stringify({id:'12345678-1234-1234-1234-123456789abc', status: mode === 'rejected' || (mode === 'second-rejected' && args[2].includes('with-helper')) ? 'Invalid' : 'Accepted'}));
    else if (args[1] === 'log') fs.writeFileSync(args.at(-1), '{}');
  } else if (args[0] === 'stapler') {
    const target = args.at(-1), ticket = path.join(target, '.ticket');
    if (args[1] === 'staple') fs.writeFileSync(ticket, 'attached');
    if (args[1] === 'validate' && (!fs.existsSync(ticket) || (mode === 'extraction-broken' && target.includes('/extracted-')))) process.exit(1);
  }
} else if (tool === 'spctl') { if (mode === 'gatekeeper-rejected') process.exit(1); }
else if (tool === 'plutil') {
  const source = args.at(-1), extension = source.includes('.appex/'), helper = source.includes('Panopto Downloader Helper');
  const id = 'org.panoptodownloader.Panopto-Downloader' + (helper ? '-Helper' : '') + (extension ? '.Extension' : '');
  fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify({CFBundleIdentifier:mode === 'wrong-bundle' ? 'wrong.bundle' : id,CFBundleVersion:mode === 'wrong-version' ? '1.1.0' : '1.2.0',CFBundleShortVersionString:'1.2.0',LSMinimumSystemVersion:mode === 'wrong-minimum-os' ? '27.0' : '12.0',CFBundleExecutable:'executable'}));
} else if (tool === 'lipo') console.log(mode === 'single-architecture' ? 'arm64' : 'x86_64 arm64');
else if (tool === 'ditto') {
  const source = args.at(-2), target = args.at(-1);
  if (args.includes('-x')) {
    fs.mkdirSync(target, {recursive:true});
    cp.execFileSync('unzip', ['-q', source, '-d', target]);
  } else {
    const parent = args.includes('--keepParent');
    cp.execFileSync('zip', ['-q', '-r', '-X', target, parent ? path.basename(source) : '.'], {cwd: parent ? path.dirname(source) : source});
  }
}
`;

function fixture(mode = '') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panopto-distribution-test-'));
  fixtures.push(directory);
  for (const name of ['scripts', 'bin', 'extension', 'extension-helper']) fs.mkdirSync(path.join(directory, name));
  fs.copyFileSync(path.join(root, 'scripts/distribute-safari.sh'), path.join(directory, 'scripts/distribute-safari.sh'));
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({version:'1.2.0'}));
  for (const name of ['extension', 'extension-helper']) fs.writeFileSync(path.join(directory, name, 'manifest.json'), JSON.stringify({version:'1.2.0'}));
  fs.writeFileSync(path.join(directory, 'scripts/build-safari.sh'), `#!/bin/bash
set -euo pipefail
variant='' output=''
while [ "$#" -gt 0 ]; do
  case "$1" in --variant) variant="$2"; shift 2 ;; --output-dir) output="$2"; shift 2 ;; *) shift ;; esac
done
printf '%s\\n' "$PANOPTO_EXTENSION_SOURCE" >> "$TEST_SOURCES"
if [ "$variant" = standalone ]; then app='Panopto Downloader'; else app='Panopto Downloader Helper'; fi
mkdir -p "$output/$app.app/Contents/PlugIns/$app Extension.appex/Contents/MacOS"
mkdir -p "$output/$app.app/Contents/Frameworks/Example.framework"
printf fake-binary > "$output/$app.app/Contents/PlugIns/$app Extension.appex/Contents/MacOS/extension"
`);
  fs.writeFileSync(path.join(directory, 'scripts/package-release.mjs'), `import fs from 'node:fs/promises';import path from 'node:path';export async function addHelper(dir) { await fs.mkdir(path.join(dir,'helper'));await fs.writeFile(path.join(dir,'helper','start.command'),'helper launcher');await fs.writeFile(path.join(dir,'helper','README.md'),'helper instructions'); }`);
  for (const tool of ['uname', 'security', 'codesign', 'xcrun', 'spctl', 'ditto', 'plutil', 'lipo']) fs.writeFileSync(path.join(directory, 'bin', tool), mockTool, {mode:0o755});
  const eventsFile = path.join(directory, 'events.jsonl');
  const output = path.join(directory, 'output');
  const run = (extra = []) => spawnSync('bash', [path.join(directory, 'scripts/distribute-safari.sh'),
    '--identity', identity, '--team-id', 'ABCDEFGHIJ', '--notary-profile', 'test-profile', '--output-dir', output, ...extra], {
    env:{...process.env, PATH:`${path.join(directory, 'bin')}${path.delimiter}${process.env.PATH}`, TEST_EVENTS:eventsFile, TEST_SOURCES:path.join(directory,'sources.txt'), TEST_IDENTITY:identity, TEST_MODE:mode, PANOPTO_EXTENSION_SOURCE:path.join(directory,'wrong-source'), PANOPTO_DISTRIBUTION_LOG_DIR:path.join(directory,'private-logs')}, encoding:'utf8', maxBuffer:1024*1024
  });
  return {directory, output, run, events:() => fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile,'utf8').trim().split('\n').map(line=>JSON.parse(line)) : []};
}
after(() => fixtures.forEach(directory => fs.rmSync(directory, {recursive:true, force:true})));

test('production Safari lifecycle signs inside out, notarizes, staples, verifies extracted ZIPs and includes helper only when selected', () => {
  const f = fixture(), result = f.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const names = ['standalone','with-helper'].map(variant => `panopto-1.2.0-safari-${variant}-macos.zip`);
  assert.deepEqual(fs.readdirSync(f.output).sort(), [...names,'SAFARI-SHA256SUMS'].sort());
  for (const name of names) {
    const entries = execFileSync('unzip',['-Z1',path.join(f.output,name)],{encoding:'utf8'}).trim().split('\n');
    assert.ok(entries.some(entry => entry.endsWith('.app/.ticket')), name);
    assert.equal(entries.includes('helper/start.command'), name.includes('with-helper'));
    assert.ok(!entries.some(entry => /(?:notary|identities|entitlements|private-logs|\.p12|\.key|\.cer)/.test(entry)), name);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(f.output,name))).digest('hex');
    assert.ok(fs.readFileSync(path.join(f.output,'SAFARI-SHA256SUMS'),'utf8').includes(`${digest}  ${name}`));
  }
  const events = f.events();
  assert.deepEqual(fs.readFileSync(path.join(f.directory,'sources.txt'),'utf8').trim().split('\n'), [path.join(f.directory,'extension'),path.join(f.directory,'extension-helper')], 'production must ignore an inherited source override');
  const signing = events.filter(event => event.tool === 'codesign' && event.args.includes('--sign'));
  assert.equal(signing.length,6);
  assert.ok(signing[0].args.at(-1).endsWith('.appex'));
  assert.ok(signing[2].args.at(-1).endsWith('.app'));
  for (const event of signing) {
    assert.ok(event.args.includes('--timestamp'));
    assert.ok(event.args.includes('runtime'));
    assert.ok(!event.args.includes('--deep'));
  }
  const submissions = events.filter(event => event.tool === 'xcrun' && event.args[1] === 'submit');
  assert.equal(submissions.length,2);
  assert.ok(submissions.every(event => event.args.includes('--keychain-profile') && event.args.includes('--wait') && event.args.includes('json')));
  const extractedChecks = events.filter(event => event.tool === 'spctl' && event.args.at(-1).includes('/extracted-'));
  assert.equal(extractedChecks.length,2);
  for (const name of ['standalone','with-helper']) {
    const staple = events.findIndex(event => event.tool === 'xcrun' && event.args[1] === 'staple' && event.args.at(-1).includes(`/${name}/`));
    const finalZip = events.findIndex(event => event.tool === 'ditto' && event.args.at(-1).endsWith(`safari-${name}-macos.zip`) && !event.args.includes('-x'));
    assert.ok(staple >= 0 && finalZip > staple);
  }
});

test('Safari build configuration keeps the host and extension on macOS 12 and builds all Release architectures', () => {
  const source = fs.readFileSync(path.join(root,'scripts/build-safari.sh'),'utf8');
  assert.match(source,/MACOSX_DEPLOYMENT_TARGET=12\.0/);
  assert.match(source,/release_settings=\(ONLY_ACTIVE_ARCH=NO "ARCHS=arm64 x86_64"\)/);
  assert.match(source,/-configuration "\$configuration"/);
});

for (const mode of ['missing-certificate','bad-credentials','wrong-bundle','wrong-version','wrong-minimum-os','single-architecture','wrong-team','missing-timestamp','debug-entitlement','rejected','second-rejected','gatekeeper-rejected','extraction-broken']) {
  test(`production Safari fails closed without publishing files: ${mode}`, () => {
    const f = fixture(mode), result = f.run();
    assert.notEqual(result.status,0, result.stdout);
    assert.deepEqual(fs.readdirSync(f.output),[]);
    if (['missing-certificate','bad-credentials'].includes(mode)) assert.ok(!f.events().some(event => event.tool === 'codesign'));
  });
}

test('development identities and pre-existing release assets are rejected without altering existing downloads', () => {
  const f = fixture();
  const invalid = f.run(['--identity','Apple Development: Test Person (ABCDEFGHIJ)']);
  assert.notEqual(invalid.status,0);
  assert.deepEqual(f.events(),[]);
  fs.mkdirSync(f.output);
  const existing = path.join(f.output,'panopto-1.2.0-safari-standalone-macos.zip');
  fs.writeFileSync(existing,'existing public asset');
  const result = f.run();
  assert.notEqual(result.status,0);
  assert.equal(fs.readFileSync(existing,'utf8'),'existing public asset');
  assert.ok(!fs.existsSync(path.join(f.output,'SAFARI-SHA256SUMS')));
});
