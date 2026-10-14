const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const E = require('../extension/common.js');
const {QueueEngine, settings} = require('../extension/queue.js');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const FOLDER = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'https://kaist.ap.panopto.com';
const folderUrl = `${ORIGIN}/Panopto/Pages/Sessions/List.aspx#folderID=%22${FOLDER}%22`;
const videoUrl = id => `${ORIGIN}/Panopto/Pages/Viewer.aspx?id=${id}`;
const payload = id => ({title: `Lecture ${id}`, pageUrl: videoUrl(id), duration: 60, streams: [{url: `${ORIGIN}/files/video.mp4?secret=signed-value`, name: 'Video'}]});
function fixture(saved = {}) {
  let storage = structuredClone(saved);
  const downloads = [], messages = [];
  const io = {
    read: async () => structuredClone(storage),
    write: async value => { storage = structuredClone(value); },
    tab: async () => ({id: 7, url: folderUrl, title: 'Course'}),
    message: async (_, message) => {
      messages.push(message);
      return message.action === 'enumerate' ? [{id: A, title: 'One'}, {id: B, title: 'Two'}] : payload(message.sessionId);
    },
    download: async (metadata, options) => { downloads.push({metadata, options}); options.onProgress({progress: 50, phase: 'downloading'}); return {files: [{name: 'lecture.mp4', size: 1234}], handoff: false}; }
  };
  return {engine: new QueueEngine(io), io, downloads, messages, stored: () => storage};
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; }
test('Chrome callback APIs use storage.local and correct method receivers', async () => {
  let saved = {standaloneSettings: {subfolder: 'Lectures'}, standaloneBatches: []};
  const chrome = {runtime: {}, storage: {local: {
    get(keys, callback) { assert.equal(this, chrome.storage.local); callback(structuredClone(saved)); },
    set(value, callback) { assert.equal(this, chrome.storage.local); saved = structuredClone(value); callback(); }
  }}};
  const context = vm.createContext({chrome, URL, URLSearchParams, Set, module: {exports: {}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/common.js'), 'utf8'), context);
  const api = context.PanoptoExt;
  const engine = new QueueEngine({read: () => api.call('storage', 'get', ['standaloneSettings', 'standaloneBatches']), write: value => api.call('storage', 'set', value)});
  await engine.init(); assert.equal(engine.settings.subfolder, 'Lectures');
  await engine.configure({subfolder: 'New'}); assert.equal(saved.standaloneSettings.subfolder, 'New');
  chrome.runtime.lastError = {message: 'Storage unavailable'};
  await assert.rejects(api.call('storage', 'get', 'standaloneBatches'), /Storage unavailable/);
});
test('Safari/browser Promise APIs use storage.local with the correct method receiver', async () => {
  let saved = {playbackRate: 2};
  const browser = {runtime: {}, storage: {local: {
    async get() { assert.equal(this, browser.storage.local); return saved; },
    async set(value) { assert.equal(this, browser.storage.local); saved = value; }
  }}};
  const context = vm.createContext({browser, URL, URLSearchParams, Set, module: {exports: {}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/common.js'), 'utf8'), context);
  assert.equal((await context.PanoptoExt.call('storage', 'get', 'playbackRate')).playbackRate, 2);
  await context.PanoptoExt.call('storage', 'set', {playbackRate: 3}); assert.equal(saved.playbackRate, 3);
});
test('page parsing handles quoted folder hashes and rejects host/path spoofing', () => {
  assert.equal(E.pageInfo(folderUrl).id, FOLDER);
  assert.equal(E.pageInfo(`${ORIGIN}/Panopto/Pages/Embed.aspx?ID=${A}`).id, A);
  assert.equal(E.pageInfo(`${ORIGIN}/Panopto/Pages/Sessions/List.aspx`).id, null);
  for (const url of [`https://panopto.com.evil.test/Panopto/Pages/Viewer.aspx?id=${A}`, `http://kaist.ap.panopto.com/Panopto/Pages/Viewer.aspx?id=${A}`, `${ORIGIN}/other?id=${A}`, `${ORIGIN}/Panopto/Pages/Viewer.aspx?id=bad`]) assert.equal(E.pageInfo(url), null);
});
test('folder pagination uses DeliveryID, counts raw duplicates, and excludes playlists', async () => {
  const queries = [];
  const items = await E.enumerateFolder(FOLDER, async query => {
    queries.push(query);
    return {d: {TotalNumber: 4, Results: query.queryParameters.page === 0 ? [{DeliveryID: A, SessionID: B, SessionName: 'One', PlayableObjectType: 0}, {DeliveryID: A, SessionName: 'One again', PlayableObjectType: 0}] : [{DeliveryID: B, SessionName: 'Two', PlayableObjectType: 2}, {DeliveryID: FOLDER, PlayableObjectType: 1}]}};
  });
  assert.deepEqual(items, [{id: A, title: 'One'}, {id: B, title: 'Two'}]);
  assert.deepEqual(queries.map(query => query.queryParameters.page), [0, 1]);
  assert.equal(queries[0].queryParameters.folderID, FOLDER);
  assert.equal(queries[0].queryParameters.searchSubfolders, false);
  assert.equal(queries[0].queryParameters.includeArchived, true);
});
test('incomplete, repeated and malformed folder pages fail explicitly', async () => {
  await assert.rejects(E.enumerateFolder(FOLDER, async query => ({d: {TotalNumber: 2, Results: query.queryParameters.page ? [] : [{DeliveryID: A}]}})), /중간에/);
  await assert.rejects(E.enumerateFolder(FOLDER, async () => ({d: {TotalNumber: 2, Results: [{DeliveryID: A}]}})), /반복/);
  await assert.rejects(E.enumerateFolder(FOLDER, async () => ({d: {TotalNumber: 1, Results: [{SessionID: A}]}})), /ID/);
  await assert.rejects(E.enumerateFolder(FOLDER, async () => ({d: {Results: []}})), /로그인/);
});
test('delivery extraction prefers official downloads and rejects unsafe or live streams', () => {
  const delivery = {SessionName: '<script>Title</script>', Duration: 60, Streams: [{StreamUrl: `${ORIGIN}/v.m3u8?sig=secret`}, {StreamUrl: `${ORIGIN}/v.m3u8?sig=secret`}, {StreamUrl: 'https://evil.test/v.mp4'}, {StreamUrl: 'file:///etc/passwd'}]};
  const data = E.deliveryPayload({Delivery: delivery}, ORIGIN, A);
  assert.equal(data.streams.length, 1); assert.equal(data.title, '<script>Title</script>');
  assert.equal(E.deliveryPayload({Delivery: delivery, DownloadUrl: `${ORIGIN}/download.mp4`}, ORIGIN, A).streams[0].url, `${ORIGIN}/download.mp4`);
  assert.throws(() => E.deliveryPayload({ErrorCode: 2}, ORIGIN, A), /로그인/);
  assert.throws(() => E.deliveryPayload({Delivery: {...delivery, IsActiveBroadcast: true}}, ORIGIN, A), /실시간/);
  assert.throws(() => E.deliveryPayload({Delivery: {Streams: [{StreamUrl: 'http://unsafe.panopto.com/v.mp4'}]}}, ORIGIN, A), /재생 파일/);
});
test('speed range and pitch are applied without redundant setters', () => {
  const media = {defaultPlaybackRate: 1, playbackRate: 1, preservesPitch: false, webkitPreservesPitch: false};
  E.applyRate(media, 4); assert.equal(media.playbackRate, 4); assert.equal(media.defaultPlaybackRate, 4); assert.equal(media.preservesPitch, true); assert.equal(media.webkitPreservesPitch, true);
  for (const value of [0, 5, NaN, 'invalid']) assert.throws(() => E.applyRate(media, value), /0.25/);
  const fixed = {get playbackRate() { return 2; }, set playbackRate(_) { throw Error('Redundant setter'); }, get defaultPlaybackRate() { return 2; }, set defaultPlaybackRate(_) { throw Error('Redundant default setter'); }};
  E.applyRate(fixed, 2);
});
test('standalone queue needs no connection and persists no signed media URLs', async () => {
  const f = fixture({config: {token: 'legacy-private'}, batches: [{id: 'old'}]});
  await f.engine.start(7, 'folder'); await f.engine.tick();
  assert.equal(f.downloads.length, 2);
  const stored = JSON.stringify(f.stored());
  for (const secret of ['signed-value', 'streams', 'pageUrl', 'legacy-private', 'token']) assert.ok(!stored.includes(secret), secret);
  assert.equal(f.engine.snapshot().configured, true); assert.equal(f.engine.snapshot().connection.ok, true);
  assert.equal(f.engine.batches.length, 1);
});
test('queue is sequential and only completes after the saver confirms writing', async () => {
  const f = fixture(), entered = deferred(), gate = deferred();
  await f.engine.start(7, 'folder');
  f.io.download = async (_, options) => { f.downloads.push(options); entered.resolve(); options.onProgress({progress: 61, phase: 'saving'}); await gate.promise; return {files: [{name: 'video.mp4', size: 999}], handoff: false}; };
  const pump = f.engine.tick(); await entered.promise;
  assert.equal(f.downloads.length, 1); assert.equal(f.engine.batches[0].items[0].status, 'saving');
  assert.equal(f.engine.batches[0].items[0].progress, 61); assert.equal(f.engine.batches[0].items[1].status, 'pending');
  gate.resolve(); await pump;
  assert.equal(f.downloads.length, 2); assert.ok(f.engine.batches[0].items.every(item => item.status === 'completed'));
});
test('Safari browser handoff stays distinct from verified disk completion', async () => {
  const f = fixture(); f.io.download = async () => ({files: [{name: 'lecture.mp4', size: 500}], handoff: true});
  await f.engine.start(7, 'folder'); await f.engine.tick();
  assert.ok(f.engine.batches[0].items.every(item => item.status === 'handedOff'));
  assert.ok(E.TERMINAL.has('handedOff'));
});
test('simultaneous duplicate folder clicks create only one live batch', async () => {
  const f = fixture(); const [first, second] = await Promise.all([f.engine.start(7, 'folder'), f.engine.start(7, 'folder')]);
  assert.equal(second.batchId, first.batchId); assert.equal(second.duplicate, true); assert.equal(f.engine.batches.length, 1);
});
test('closed source tab blocks pending jobs and a logged-in tab can retry', async () => {
  const f = fixture(); await f.engine.start(7, 'folder'); const tab = f.io.tab;
  f.io.tab = async () => { throw new Error('Tab closed'); }; await f.engine.tick();
  assert.match(f.engine.batches[0].blockedError, /탭이 닫혔습니다/); assert.equal(f.downloads.length, 0);
  f.io.tab = tab; await f.engine.retry(f.engine.batches[0].id, 9); await f.engine.tick();
  assert.equal(f.engine.batches[0].tabId, 9); assert.ok(f.engine.batches[0].items.every(item => item.status === 'completed'));
});
test('runner reopening marks unfinished work interrupted instead of silently downloading duplicates', async () => {
  const f = fixture(); await f.engine.start(7, 'folder');
  const saved = structuredClone(f.stored()); saved.standaloneBatches[0].items[0].status = 'downloading';
  const restarted = new QueueEngine({...f.io, read: async () => saved}); await restarted.tick();
  assert.equal(f.downloads.length, 0); assert.ok(restarted.batches[0].items.every(item => item.status === 'interrupted'));
  await restarted.retry(restarted.batches[0].id, 7); await restarted.tick(); assert.equal(f.downloads.length, 2);
});
test('cancel during metadata never starts downloading and preserves cancellation on metadata failure', async () => {
  for (const reject of [false, true]) {
    const f = fixture(); await f.engine.start(7, 'folder'); const gate = deferred(), entered = deferred();
    f.io.message = async (_, message) => { entered.resolve(); await gate.promise; if (reject) throw new Error('Login expired'); return payload(message.sessionId); };
    const pump = f.engine.tick(); await entered.promise; await f.engine.cancel(f.engine.batches[0].id); gate.resolve(); await pump;
    assert.equal(f.downloads.length, 0); assert.ok(f.engine.batches[0].items.every(item => item.status === 'cancelled'));
  }
});
test('active media download gets AbortSignal cancellation and remaining items never start', async () => {
  const f = fixture(), entered = deferred(); await f.engine.start(7, 'folder');
  let receivedSignal;
  f.io.download = async (_, {signal}) => { receivedSignal = signal; entered.resolve(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted')), {once: true})); };
  const pump = f.engine.tick(); await entered.promise; await f.engine.cancel(f.engine.batches[0].id); await pump;
  assert.equal(receivedSignal.aborted, true); assert.ok(f.engine.batches[0].items.every(item => item.status === 'cancelled'));
});
test('retry rejects another origin and fetches fresh metadata for failed jobs', async () => {
  const f = fixture(); await f.engine.start(7, 'folder'); f.io.download = async () => { throw new Error(`Failure ${payload(A).streams[0].url}`); }; await f.engine.tick();
  assert.ok(f.engine.batches[0].items.every(item => item.status === 'failed' && !item.error.includes('signed-value')));
  const tab = f.io.tab; f.io.tab = async () => ({url: 'https://other.panopto.com/Panopto/Pages/Viewer.aspx?id=' + A});
  await assert.rejects(f.engine.retry(f.engine.batches[0].id, 7), /같은 Panopto/);
  f.io.tab = tab; f.io.download = async () => ({files: [{name: 'retry.mp4', size: 12}], handoff: false});
  await f.engine.retry(f.engine.batches[0].id, 7); await f.engine.tick();
  assert.equal(f.messages.filter(message => message.action === 'metadata').length, 4);
});
test('mismatched session or origin is rejected before download', async () => {
  for (const pageUrl of ['https://other.panopto.com/Panopto/Pages/Viewer.aspx?id=' + A, videoUrl(FOLDER)]) {
    const f = fixture(); await f.engine.start(7, 'folder'); f.io.message = async (_, message) => ({...payload(message.sessionId), pageUrl});
    await f.engine.tick(); assert.equal(f.downloads.length, 0); assert.ok(f.engine.batches[0].items.every(item => item.status === 'failed'));
  }
});
test('standalone settings reject absolute and parent paths and are captured per download', async () => {
  for (const subfolder of ['/tmp', '../secret', 'a/../b', 'C:\\temp', 'a\\b']) assert.throws(() => settings({subfolder}), /하위 폴더/);
  const f = fixture(); await f.engine.configure({subfolder: 'Courses/2026', askEveryTime: true}); await f.engine.start(7, 'folder'); await f.engine.tick();
  assert.equal(f.downloads[0].options.settings.subfolder, 'Courses/2026'); assert.equal(f.downloads[0].options.settings.askEveryTime, true);
});
test('standalone manifest has no helper or native messaging and includes the visible runner', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../extension/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.host_permissions, ['https://*.panopto.com/*']);
  assert.ok(manifest.permissions.includes('downloads')); assert.ok(!manifest.permissions.includes('nativeMessaging')); assert.ok(!manifest.permissions.includes('cookies'));
  const background = fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8');
  assert.ok(!background.includes('127.0.0.1')); assert.ok(!background.includes('fetch('));
  const runner = fs.readFileSync(path.join(__dirname, '../extension/downloads.html'), 'utf8');
  assert.ok(runner.includes('media.js')); assert.ok(runner.includes('queue.js')); assert.ok(runner.includes('downloads.js'));
});
function brokerFixture(initial = {}) {
  const extensionURL = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/';
  const tabs = [], listeners = [], forwarded = [], removed = [], writes = [];
  let saved = structuredClone(initial), creates = 0, runnerReady = false;
  const chrome = {
    runtime: {id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', getURL: file => extensionURL + file,
      onMessage: {addListener: listener => listeners.push(listener)},
      sendMessage(message, callback) {
        if (!message.target || message.target !== 'runner') throw new Error('Unexpected broker broadcast');
        forwarded.push(message);
        callback(runnerReady ? {ok: true, data: message.action === 'state' ? {configured: true, batches: [], settings: {}, runnerOpen: true} : {count: 2}} : undefined);
      }
    },
    storage: {local: {
      get(_, callback) { callback(structuredClone(saved)); },
      set(value, callback) { saved = {...saved, ...structuredClone(value)}; writes.push(value); callback(); },
      remove(keys, callback) { removed.push(...keys); for (const key of keys) delete saved[key]; callback(); }
    }},
    tabs: {
      query(_, callback) { callback(tabs.map(tab => ({...tab}))); },
      update(id, value, callback) { callback({...tabs.find(tab => tab.id === id), ...value}); },
      create(value, callback) {
        creates++; const tab = {id: 50, ...value}; tabs.push(tab); callback(tab);
        queueMicrotask(() => { runnerReady = true; listeners[0]({action: 'runnerReady'}, {id: chrome.runtime.id, url: extensionURL + 'downloads.html', tab}, () => {}); });
      }
    }
  };
  const context = vm.createContext({chrome, URL, URLSearchParams, Set, Map, AbortController, setTimeout, clearTimeout});
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8'), context));
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), context);
  function send(message, sender = {id: chrome.runtime.id, url: extensionURL + 'popup.html'}) {
    return new Promise(resolve => { const result = listeners[0](message, sender, resolve); if (result === undefined) resolve(undefined); });
  }
  return {send, tabs, forwarded, removed, writes, created: () => creates, saved: () => saved, url: extensionURL};
}
test('passive broker state and settings never open a runner and clear legacy credentials', async () => {
  const f = brokerFixture({config: {token: 'old-secret'}, batches: [{id: 'legacy'}]});
  const state = await f.send({action: 'state'});
  assert.equal(state.ok, true); assert.equal(state.data.runnerOpen, false); assert.equal(f.created(), 0);
  assert.ok(f.removed.includes('config')); assert.ok(!JSON.stringify(f.saved()).includes('old-secret'));
  await f.send({action: 'options'}); assert.equal(f.created(), 0); assert.equal(f.writes.length, 0);
});
test('rapid start messages share one visible runner and forward the authorized source tab', async () => {
  const f = brokerFixture();
  const sender = {id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', url: folderUrl, tab: {id: 7, url: folderUrl}};
  const results = await Promise.all([f.send({action: 'startFolder', tabId: 999}, sender), f.send({action: 'startFolder'}, sender)]);
  assert.ok(results.every(result => result.ok)); assert.equal(f.created(), 1);
  const starts = f.forwarded.filter(message => message.action === 'startFolder');
  assert.equal(starts.length, 2); assert.ok(starts.every(message => message.tabId === 7 && message.target === 'runner'));
});
test('broker ignores runner broadcasts and rejects unrelated page actions', async () => {
  const f = brokerFixture();
  assert.equal(await f.send({target: 'runner', action: 'state'}), undefined);
  assert.equal(await f.send({action: 'configure'}, {id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', url: folderUrl, tab: {id: 7, url: folderUrl}}), undefined);
  assert.equal(await f.send({action: 'startFolder'}, {id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', url: 'https://evil.test', tab: {id: 7, url: 'https://evil.test'}}), undefined);
  assert.equal(f.created(), 0);
});
test('only the first extension download tab can claim queue ownership', async () => {
  const f = brokerFixture();
  f.tabs.push({id: 3, url: f.url + 'downloads.html'}, {id: 4, url: f.url + 'downloads.html'});
  const first = await f.send({action: 'runnerClaim', tabId: 3}, {id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', url: f.url + 'downloads.html'});
  const second = await f.send({action: 'runnerClaim', tabId: 4}, {id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', url: f.url + 'downloads.html'});
  assert.equal(first.data.claimed, true); assert.equal(second.data.claimed, false);
});
test('offline settings mutations serialize without stale polling overwrites', async () => {
  const f = brokerFixture();
  const results = await Promise.all([
    f.send({action: 'configure', settings: {subfolder: 'One'}}),
    f.send({action: 'state'}),
    f.send({action: 'configure', settings: {subfolder: 'Two', askEveryTime: true}})
  ]);
  assert.ok(results.every(result => result.ok));
  assert.equal(f.saved().standaloneSettings.subfolder, 'Two');
  assert.equal(f.saved().standaloneSettings.askEveryTime, true); assert.equal(f.created(), 0);
});
