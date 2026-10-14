const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const vm = require('node:vm');
const E = require('../extension/common.js');
const M = require('../extension/media.js');
const ORIGIN = 'https://kaist.ap.panopto.com';
const ID = '11111111-1111-4111-8111-111111111111';
let temp;
before(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'panopto-standalone-media-'));
  const base = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=128x72:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-c:a', 'aac', '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod'];
  for (const name of ['single', 'pieces', 'transport']) {
    const args = [...base];
    if (name !== 'transport') args.push('-hls_segment_type', 'fmp4');
    if (name === 'single') args.push('-hls_flags', 'single_file');
    args.push(path.join(temp, `${name}.m3u8`)); execFileSync('ffmpeg', args);
  }
});
after(() => fs.rmSync(temp, {recursive: true, force: true}));
function fixture(entry, override) {
  const requests = [], saved = [], sinks = [];
  const fetcher = async (url, options) => {
    requests.push({url, ...options});
    assert.equal(options.credentials, 'include');
    if (override) { const response = await override(url, options); if (response) return response; }
    const filename = path.basename(new URL(url).pathname);
    const data = fs.readFileSync(path.join(temp, filename));
    if (options.headers.Range) {
      const [, start, end] = /bytes=(\d+)-(\d+)/.exec(options.headers.Range).map(Number);
      return new Response(data.subarray(start, end + 1), {status: 206, headers: {'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': String(end - start + 1)}});
    }
    return new Response(data, {headers: {'Content-Length': String(data.length)}});
  };
  const createSink = async (_, name) => {
    const chunks = [], sink = {name, aborted: false, write: async bytes => chunks.push(Buffer.from(bytes)), finish: async () => ({file: new Blob(chunks), cleanup: async () => {}, direct: false}), abort: async () => { sink.aborted = true; chunks.length = 0; }};
    sinks.push(sink); return sink;
  };
  const saver = async (result, name) => { saved.push({name, data: Buffer.from(await result.file.arrayBuffer())}); return true; };
  return {payload: {pageUrl: `${ORIGIN}/Panopto/Pages/Viewer.aspx?id=${ID}`, title: '강의/테스트', streams: [{url: `${ORIGIN}/${entry}?signed=private`, name: '화면'}]}, options: {fetcher, createSink, saver}, requests, saved, sinks};
}
function verify(saved, extension) {
  assert.ok(saved.name.endsWith(`.${extension}`));
  const output = path.join(temp, `result.${extension}`); fs.writeFileSync(output, saved.data);
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', output], {encoding: 'utf8'}));
  assert.ok(Number(info.format.duration) >= 1.9);
  assert.ok(info.streams.some(s => s.codec_name === 'h264'));
  assert.ok(info.streams.some(s => s.codec_name === 'aac'));
  // Decode every frame, not just the container headers.
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-xerror', '-i', output, '-f', 'null', '-']);
}
test('single-file fMP4 byte ranges download once and produce playable H264/AAC', async () => {
  const f = fixture('single.m3u8'), progress = [];
  const result = await M.download(f.payload, {...f.options, onProgress: p => progress.push(p)});
  assert.equal(result.handoff, true); assert.equal(result.files.length, 1);
  assert.equal(f.requests.length, 2); assert.ok(f.requests[1].headers.Range);
  verify(f.saved[0], 'mp4'); assert.equal(progress.at(-1).phase, 'handedOff');
});
test('separate fMP4 initialization and fragments form a playable MP4', async () => {
  const f = fixture('pieces.m3u8'); await M.download(f.payload, f.options);
  verify(f.saved[0], 'mp4'); assert.ok(f.requests.length >= 4);
});
test('MPEG-TS segments remain TS and include playable video and audio', async () => {
  const f = fixture('transport.m3u8'); const result = await M.download(f.payload, f.options);
  assert.equal(result.files[0].format, 'ts'); verify(f.saved[0], 'ts');
});
test('master playlist selects highest bandwidth and inherits signed query', async () => {
  const f = fixture('master.m3u8', url => url.includes('/master.m3u8') ? new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\ntransport.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900\npieces.m3u8\n') : null);
  await M.download(f.payload, f.options);
  assert.ok(f.requests[1].url.includes('/pieces.m3u8?signed=private')); verify(f.saved[0], 'mp4');
});
test('incomplete, encrypted, external-audio and discontinuous playlists fail explicitly', () => {
  const base = '#EXTM3U\n#EXTINF:1,\nseg.ts\n#EXT-X-ENDLIST\n';
  assert.throws(() => M.parsePlaylist(base.replace('#EXT-X-ENDLIST', ''), ORIGIN), /실시간/);
  assert.throws(() => M.parsePlaylist(base.replace('#EXTINF', '#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF'), ORIGIN), /암호화/);
  assert.throws(() => M.parsePlaylist(base.replace('#EXTINF', '#EXT-X-DISCONTINUITY\n#EXTINF'), ORIGIN), /시간축/);
  assert.throws(() => M.parsePlaylist('#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=AES-128,URI="key"\n#EXT-X-STREAM-INF:BANDWIDTH=1\na.m3u8', ORIGIN), /암호화/);
  assert.throws(() => M.parsePlaylist('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="a.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"\nv.m3u8', ORIGIN), /별도 오디오/);
});
test('implicit byte ranges need a preceding segment on the same resource', () => {
  assert.throws(() => M.parsePlaylist('#EXTM3U\n#EXT-X-BYTERANGE:12\na.ts\n#EXT-X-ENDLIST', ORIGIN), /시작 위치/);
  const parsed = M.parsePlaylist('#EXTM3U\n#EXT-X-BYTERANGE:10@0\na.ts\n#EXT-X-BYTERANGE:20\na.ts\n#EXT-X-ENDLIST', ORIGIN);
  assert.deepEqual(parsed.segments.map(s => s.range.start), [0, 10]);
});
test('ignored or incorrect Range responses are rejected without saving corrupt output', async () => {
  for (const status of [200, 206]) {
    const f = fixture('single.m3u8', (url, options) => options.headers.Range ? new Response('not the requested byte range', {status, headers: {'Content-Range': 'bytes 1-5/10'}}) : null);
    await assert.rejects(M.download(f.payload, f.options), /바이트 범위/);
    assert.equal(f.saved.length, 0); assert.equal(f.sinks[0].aborted, true);
  }
});
test('truncated bodies, HTML responses and sink errors never publish successful files', async () => {
  for (const body of ['<html>login</html>', Buffer.from([0, 0, 0, 16, ...Buffer.from('ftyp'), 0, 0, 0, 0])]) {
    const f = fixture('direct.mp4', () => new Response(body, {headers: {'Content-Length': '500'}}));
    await assert.rejects(M.download(f.payload, f.options), /로그인|중간에 끊겼/);
    assert.equal(f.saved.length, 0); assert.equal(f.sinks[0].aborted, true);
  }
  const f = fixture('single.m3u8'); f.options.createSink = async () => ({write: async () => { throw new Error('Disk full'); }, abort: async () => {}});
  await assert.rejects(M.download(f.payload, f.options), /Disk full/);
  assert.ok(f.requests.at(-1).signal.aborted); assert.equal(f.saved.length, 0);
});
test('a later HLS segment returning a login page fails before publishing a corrupt video', async () => {
  for (const playlist of ['pieces.m3u8', 'transport.m3u8']) {
    let segments = 0;
    const f = fixture(playlist, url => {
      if (/\.(m4s|ts)(?:$|\?)/.test(url) && ++segments === 2) return new Response('<html>Login expired</html>', {headers: {'Content-Type': 'application/octet-stream'}});
      return null;
    });
    await assert.rejects(M.download(f.payload, f.options), /로그인 화면|지원하지 않는 형식/);
    assert.equal(f.saved.length, 0); assert.equal(f.sinks[0].aborted, true);
  }
});
test('cancellation during transfer aborts fetch and removes the partial file', async () => {
  const f = fixture('single.m3u8'), controller = new AbortController();
  await assert.rejects(M.download(f.payload, {...f.options, signal: controller.signal, onProgress: () => controller.abort()}), {name: 'AbortError'});
  assert.equal(f.sinks[0].aborted, true); assert.equal(f.saved.length, 0); assert.ok(f.requests.at(-1).signal.aborted);
});
test('unsafe URLs, traversing folder paths and hostile filenames are rejected or sanitized', () => {
  for (const url of ['http://kaist.ap.panopto.com/v.mp4', 'https://evil.test/v.mp4', 'https://a.panopto.com@evil.test/v.mp4']) assert.throws(() => M.resource(url), /HTTPS/);
  for (const value of ['/etc', '../private', 'a/../b', 'C:/data']) assert.throws(() => M.folderPath(value), /상대 경로/);
  assert.equal(M.folderPath('Panopto/Week1'), 'Panopto/Week1');
  assert.ok(!M.filename('../가나다/테스트', ID, 'a/b', 0, 2, 'mp4').includes('/'));
  assert.ok(Buffer.byteLength(M.filename('강의'.repeat(200), ID, '한글'.repeat(200), 0, 2, 'mp4')) + 39 < 255);
});
test('Chrome saver waits for confirmed completion and cancels a pending browser save', async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController(), calls = [], f = fixture('single.m3u8');
    let cleaned = 0;
    const context = vm.createContext({URL, Blob, DOMException, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
      PanoptoExt: {...E, api: {downloads: {download: true}}, call: async (area, method, ...args) => {
        calls.push({area, method, args});
        if (method === 'download') { if (cancel) controller.abort(); return 42; }
        if (method === 'search') return [{state: 'complete'}];
        if (method === 'cancel') return;
        throw new Error('Unexpected API');
      }}});
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/media.js'), 'utf8'), context);
    const original = f.options.createSink;
    f.options.createSink = async (...args) => {
      const sink = await original(...args), finish = sink.finish;
      sink.finish = async () => ({...await finish(), cleanup: async () => { cleaned++; }}); return sink;
    };
    delete f.options.saver;
    const work = context.PanoptoMedia.download(f.payload, {...f.options, signal: controller.signal, settings: {subfolder: 'Courses', askEveryTime: true}});
    if (cancel) { await assert.rejects(work, {name: 'AbortError'}); assert.ok(calls.some(call => call.method === 'cancel')); }
    else { const result = await work; assert.equal(result.handoff, false); assert.ok(calls.some(call => call.method === 'search')); }
    assert.equal(calls[0].args[0].saveAs, true); assert.ok(calls[0].args[0].filename.startsWith('Courses/'));
    assert.equal(context.PanoptoMedia.pendingHandoffs(), 0); assert.ok(cleaned >= 1);
  }
});
