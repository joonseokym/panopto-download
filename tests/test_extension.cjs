const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const E = require('../extension/common.js');
const {QueueEngine} = require('../extension/background.js');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const FOLDER = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'https://kaist.ap.panopto.com';
const folderUrl = `${ORIGIN}/Panopto/Pages/Sessions/List.aspx#folderID=%22${FOLDER}%22`;
const videoUrl = id => `${ORIGIN}/Panopto/Pages/Viewer.aspx?id=${id}`;
const payload = id => ({title: `Lecture ${id}`, pageUrl: videoUrl(id), duration: 60, streams: [{url: `${ORIGIN}/files/video.mp4?secret=signed-value`, name: 'Video'}]});
function fixture(saved = {}) {
  let storage = structuredClone({config: {token: 'private-token'}, ...saved});
  const posts = [], cancels = [], requestCancels = [], serverJobs = [], tombstones = new Set();
  const io = {
    read: async () => structuredClone(storage),
    write: async value => { storage = structuredClone(value); },
    tab: async () => ({id: 7, url: folderUrl, title: 'Course'}),
    message: async (_, message) => message.action === 'enumerate' ? [{id: A, title: 'One'}, {id: B, title: 'Two'}] : payload(message.sessionId),
    helper: async (route, token, options = {}) => {
      assert.equal(token, 'private-token');
      if (route === '/health') return {protocolVersion: 1};
      if (route === '/api/settings') return {outputDir: '/Users/example/Downloads', defaultOutputDir: '/Users/example/Downloads'};
      if (route === '/api/cancel-request') {
        const requestId = options.body.requestId; requestCancels.push(requestId); tombstones.add(requestId);
        const job = serverJobs.find(job => job.requestId === requestId);
        if (job && !E.TERMINAL.has(job.status)) job.status = 'cancelled';
        return {ok: true, requestId, job: job ? structuredClone(job) : null};
      }
      if (route.endsWith('/cancel')) { cancels.push(route); const id = route.split('/')[3]; const job = serverJobs.find(job => job.id === id); if (job) job.status = 'cancelled'; return {ok: true}; }
      if (route === '/api/jobs' && options.method === 'POST') {
        posts.push(structuredClone(options.body));
        if (tombstones.has(options.body.requestId)) { const error = new Error('Request cancelled'); error.status = 409; throw error; }
        let job = serverJobs.find(job => job.requestId === options.body.requestId);
        if (!job) { job = {id: `job-${serverJobs.length}`, title: options.body.title, requestId: options.body.requestId, status: 'queued', progress: 0}; serverJobs.push(job); }
        return structuredClone(job);
      }
      if (route === '/api/jobs') return {jobs: structuredClone(serverJobs)};
      throw new Error(`Unexpected route ${route}`);
    }
  };
  return {engine: new QueueEngine(io), io, posts, cancels, requestCancels, serverJobs, stored: () => storage};
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; }
test('Chrome callback APIs use storage.local and initialize the queue worker', async () => {
  let saved = {config: {token: 'chrome-token'}, batches: []};
  const chrome = {runtime: {}, storage: {local: {
    get(keys, callback) { assert.equal(this, chrome.storage.local); callback(structuredClone(saved)); },
    set(value, callback) { assert.equal(this, chrome.storage.local); saved = structuredClone(value); callback(); }
  }}};
  const context = vm.createContext({chrome, URL, URLSearchParams, Set, module: {exports: {}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/common.js'), 'utf8'), context);
  const api = context.PanoptoExt;
  const engine = new QueueEngine({read: () => api.call('storage', 'get', ['config', 'batches']), write: value => api.call('storage', 'set', value)});
  await engine.init(); assert.equal(engine.config.token, 'chrome-token');
  engine.config.token = 'updated'; await engine.save(); assert.equal(saved.config.token, 'updated');
  chrome.runtime.lastError = {message: 'Storage unavailable'};
  await assert.rejects(api.call('storage', 'get', 'config'), /Storage unavailable/);
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
  const engine = new QueueEngine({read: () => context.PanoptoExt.call('storage', 'get', ['config', 'batches'])});
  await engine.init(); assert.deepEqual(engine.batches, []);
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
test('errors remove signed URLs and queue storage contains no streams', async () => {
  assert.equal(E.safeError(new Error(`Failed ${payload(A).streams[0].url}`)), 'Failed [주소 숨김]');
  const f = fixture(); await f.engine.start(7, 'folder'); await f.engine.tick();
  assert.equal(f.posts.length, 2);
  const stored = JSON.stringify(f.stored());
  assert.ok(!stored.includes('signed-value')); assert.ok(!stored.includes('streams')); assert.ok(!stored.includes('pageUrl'));
  assert.equal(f.engine.snapshot().configured, true); assert.ok(!JSON.stringify(f.engine.snapshot()).includes('private-token'));
});
test('queue remains active after submission and only becomes complete on helper completion', async () => {
  const f = fixture(); await f.engine.start(7, 'folder'); await f.engine.tick();
  assert.deepEqual(f.engine.batches[0].items.map(item => item.status), ['queued', 'queued']);
  f.serverJobs[0].status = 'downloading'; f.serverJobs[0].progress = 50; await f.engine.tick();
  assert.equal(f.engine.batches[0].items[0].progress, 50);
  f.serverJobs.forEach(job => { job.status = 'completed'; job.progress = 100; }); await f.engine.tick();
  assert.ok(f.engine.batches[0].items.every(item => item.status === 'completed'));
});
test('duplicate folder clicks reuse queued items and closed tabs pause with an actionable error', async () => {
  const f = fixture(); const first = await f.engine.start(7, 'folder');
  const second = await f.engine.start(7, 'folder'); assert.equal(second.batchId, first.batchId); assert.equal(second.duplicate, true);
  f.io.tab = async () => { throw new Error('Tab closed'); }; await f.engine.tick();
  assert.match(f.engine.batches[0].blockedError, /탭이 닫혔습니다/); assert.equal(f.posts.length, 0); assert.equal(f.engine.batches[0].items[0].status, 'pending');
});
test('helper backpressure and temporary disconnect retain pending items', async () => {
  const f = fixture(); await f.engine.start(7, 'folder'); const base = f.io.helper;
  f.io.helper = async (route, token, options) => { if (options?.method === 'POST') { const error = new Error('Capacity'); error.status = 429; throw error; } return base(route, token, options); };
  await f.engine.tick(); assert.equal(f.engine.batches[0].items[0].status, 'pending');
  f.io.helper = async () => { const error = new Error('Offline'); error.helperUnavailable = true; throw error; };
  await f.engine.tick(); assert.equal(f.engine.batches[0].items[0].status, 'pending'); assert.equal(f.engine.connection.ok, false);
});
test('worker restart retries a submission with the same idempotency key', async () => {
  const f = fixture(); await f.engine.start(7, 'folder'); await f.engine.tick();
  const saved = structuredClone(f.stored()); saved.batches[0].items[0].status = 'submitting'; delete saved.batches[0].items[0].jobId;
  const resumed = new QueueEngine({...f.io, read: async () => saved}); await resumed.tick();
  assert.equal(f.posts[0].requestId, f.posts[2].requestId); assert.equal(f.serverJobs.length, 2);
});
test('cancellation during metadata never submits the job', async () => {
  const f = fixture(); await f.engine.start(7, 'folder'); const gate = deferred(), entered = deferred();
  f.io.message = async (_, message) => { entered.resolve(); await gate.promise; return payload(message.sessionId); };
  const pump = f.engine.tick(); await entered.promise; await f.engine.cancel(f.engine.batches[0].id); gate.resolve(); await pump;
  assert.equal(f.posts.length, 0); assert.ok(f.engine.batches[0].items.every(item => item.status === 'cancelled'));
});
test('metadata rejection after cancellation preserves the cancelled state', async () => {
  const f = fixture(); await f.engine.start(7, 'folder'); const gate = deferred(), entered = deferred();
  f.io.message = async () => { entered.resolve(); await gate.promise; throw new Error('Login expired'); };
  const pump = f.engine.tick(); await entered.promise; await f.engine.cancel(f.engine.batches[0].id); gate.resolve(); await pump;
  assert.equal(f.posts.length, 0); assert.ok(f.engine.batches[0].items.every(item => item.status === 'cancelled'));
});
test('cancellation with no matching job tombstones the request and rejects a late POST', async () => {
  const f = fixture(); await f.engine.start(7, 'folder'); const gate = deferred(), entered = deferred(), base = f.io.helper;
  f.io.helper = async (route, token, options) => { if (route === '/api/jobs' && options?.method === 'POST') { entered.resolve(); await gate.promise; } return base(route, token, options); };
  const pump = f.engine.tick(); await entered.promise; await f.engine.cancel(f.engine.batches[0].id); gate.resolve(); await pump;
  assert.equal(f.posts.length, 1); assert.equal(f.serverJobs.length, 0); assert.equal(f.requestCancels.length, 1); assert.equal(f.engine.batches[0].items[0].status, 'cancelled');
  await f.engine.tick(); assert.ok(f.engine.batches[0].items.every(item => item.status === 'cancelled'));
});
test('accepted POST with a lost response stays uncertain until requestId reconciliation cancels it', async () => {
  const f = fixture(); await f.engine.start(7, 'folder'); const gate = deferred(), accepted = deferred(), base = f.io.helper;
  f.io.helper = async (route, token, options) => {
    if (route === '/api/cancel-request') { const error = new Error('Cancel response lost'); error.helperUnavailable = true; throw error; }
    if (route === '/api/jobs' && options?.method === 'POST') {
      await base(route, token, options); accepted.resolve(); await gate.promise;
      const error = new Error('Response lost'); error.helperUnavailable = true; throw error;
    }
    return base(route, token, options);
  };
  const pump = f.engine.tick(); await accepted.promise; await assert.rejects(f.engine.cancel(f.engine.batches[0].id), /Cancel response lost/); gate.resolve(); await pump;
  assert.equal(f.posts.length, 1); assert.equal(f.engine.batches[0].items[0].status, 'reconciling');
  assert.equal(f.engine.batches[0].items[0].jobId, undefined); assert.equal(f.serverJobs[0].status, 'queued');
  await f.engine.tick(); assert.equal(f.cancels.length, 1); assert.equal(f.engine.batches[0].items[0].status, 'cancelling');
  await f.engine.tick(); assert.ok(f.engine.batches[0].items.every(item => item.status === 'cancelled'));
});
test('a cancellation acknowledgement stays terminal when the accepted POST response is later lost', async () => {
  const f = fixture(); await f.engine.start(7, 'folder'); const gate = deferred(), accepted = deferred(), base = f.io.helper;
  f.io.helper = async (route, token, options) => {
    if (route === '/api/jobs' && options?.method === 'POST') {
      await base(route, token, options); accepted.resolve(); await gate.promise;
      const error = new Error('Response lost'); error.helperUnavailable = true; throw error;
    }
    return base(route, token, options);
  };
  const pump = f.engine.tick(); await accepted.promise; await f.engine.cancel(f.engine.batches[0].id); gate.resolve(); await pump;
  assert.equal(f.requestCancels.length, 1); assert.equal(f.serverJobs[0].status, 'cancelled');
  assert.ok(f.engine.batches[0].items.every(item => item.status === 'cancelled'));
});
test('a suspended helper submission is reconciled on worker restart before cancellation', async () => {
  const f = fixture(); await f.engine.start(7, 'folder'); await f.engine.tick(); const saved = structuredClone(f.stored());
  saved.batches[0].cancelRequested = true; saved.batches[0].items[0].status = 'submitting'; saved.batches[0].items[0].submissionPhase = 'helper'; delete saved.batches[0].items[0].jobId;
  const restarted = new QueueEngine({...f.io, read: async () => saved}); await restarted.tick();
  assert.equal(restarted.batches[0].items[0].jobId, f.serverJobs[0].id); assert.equal(restarted.batches[0].items[0].status, 'cancelling');
  await restarted.tick(); assert.ok(restarted.batches[0].items.every(item => item.status === 'cancelled'));
});
test('metadata from a different origin is rejected before helper submission', async () => {
  const f = fixture(); await f.engine.start(7, 'folder'); f.io.message = async (_, message) => ({...payload(message.sessionId), pageUrl: `https://other.panopto.com/Panopto/Pages/Viewer.aspx?id=${message.sessionId}`});
  await f.engine.tick(); assert.equal(f.posts.length, 0); assert.ok(f.engine.batches[0].items.every(item => item.status === 'failed'));
});
test('manifest permissions stay limited to Panopto and the local helper', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../extension/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.permissions, ['storage', 'activeTab', 'alarms']);
  assert.deepEqual(manifest.host_permissions, ['https://*.panopto.com/*', 'http://127.0.0.1:8765/*']);
  assert.ok(!manifest.permissions.includes('cookies')); assert.ok(!manifest.permissions.includes('downloads'));
});
