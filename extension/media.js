(function (root) {
  'use strict';
  const E = root.PanoptoExt || (typeof require === 'function' && require('./common.js'));
  const heldDownloads = new Set();
  const MEMORY_LIMIT = 256 * 1024 * 1024;
  function aborted(signal) { if (signal?.aborted) throw new DOMException('다운로드를 취소했습니다.', 'AbortError'); }
  function resource(value, base) {
    const url = E.streamUrl(value, base);
    if (!url) throw new Error('Panopto HTTPS 주소만 다운로드할 수 있습니다.');
    // Panopto signs playlist URLs; relative children sometimes inherit that query.
    const result = new URL(url), parent = base && new URL(base);
    if (parent && !/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith('//') && !result.search && result.origin === parent.origin) result.search = parent.search;
    return result.href;
  }
  function attributes(text) {
    const result = {};
    const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)(?:,|$)/g;
    let match;
    while ((match = pattern.exec(text))) result[match[1]] = match[2].replace(/^"|"$/g, '');
    return result;
  }
  function byteRange(value, previous, url) {
    const match = /^(\d+)(?:@(\d+))?$/.exec(value || '');
    if (!match) throw new Error('올바르지 않은 HLS 바이트 범위입니다.');
    const length = Number(match[1]);
    const start = match[2] === undefined ? (previous?.url === url ? previous.end + 1 : NaN) : Number(match[2]);
    const end = start + length - 1;
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(end)) throw new Error('HLS 바이트 범위의 시작 위치를 확인할 수 없습니다.');
    return {start, end, length};
  }
  function parsePlaylist(text, base) {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines[0] !== '#EXTM3U') throw new Error('HLS 재생 목록이 아닙니다. 로그인을 확인해 주세요.');
    const variants = [], audio = new Map();
    let variant;
    for (const line of lines) {
      if ((line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) && attributes(line.slice(line.indexOf(':') + 1)).METHOD !== 'NONE') throw new Error('암호화된 HLS는 지원하지 않습니다.');
      if (line.startsWith('#EXT-X-MEDIA:')) {
        const a = attributes(line.slice(13));
        if (a.TYPE === 'AUDIO' && a.URI) audio.set(a['GROUP-ID'], true);
      }
      if (line.startsWith('#EXT-X-STREAM-INF:')) variant = attributes(line.slice(18));
      else if (!line.startsWith('#') && variant) {
        variants.push({url: resource(line, base), bandwidth: Number(variant['AVERAGE-BANDWIDTH'] || variant.BANDWIDTH) || 0, audio: variant.AUDIO}); variant = null;
      }
    }
    if (variants.length) {
      variants.sort((a, b) => b.bandwidth - a.bandwidth);
      const selected = variants[0];
      if (selected.audio && audio.has(selected.audio)) throw new Error('별도 오디오를 합쳐야 하는 HLS는 이 버전에서 지원하지 않습니다.');
      return {variant: selected.url};
    }
    if (!lines.includes('#EXT-X-ENDLIST')) throw new Error('완료되지 않은 실시간 HLS는 다운로드할 수 없습니다.');
    const segments = [];
    let map = null, pendingRange, previous = null, duration = 0, pendingDuration = 0;
    for (const line of lines) {
      if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) {
        if (attributes(line.slice(line.indexOf(':') + 1)).METHOD !== 'NONE') throw new Error('암호화된 HLS는 지원하지 않습니다.');
      } else if (line === '#EXT-X-DISCONTINUITY') throw new Error('시간축이 끊긴 HLS는 이 버전에서 합칠 수 없습니다.');
      else if (line.startsWith('#EXT-X-MAP:')) {
        const a = attributes(line.slice(11));
        if (!a.URI) throw new Error('HLS 초기화 파일 주소가 없습니다.');
        const url = resource(a.URI, base), next = {url, range: a.BYTERANGE ? byteRange(a.BYTERANGE, null, url) : null};
        if (map && JSON.stringify(map) !== JSON.stringify(next)) throw new Error('초기화 파일이 바뀌는 HLS는 이 버전에서 지원하지 않습니다.');
        map = next;
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) pendingRange = line.slice(17);
      else if (line.startsWith('#EXTINF:')) { pendingDuration = Number(line.slice(8).split(',')[0]); if (!Number.isFinite(pendingDuration) || pendingDuration < 0) throw new Error('HLS 재생 시간이 올바르지 않습니다.'); }
      else if (!line.startsWith('#')) {
        if (segments.length >= 200000) throw new Error('HLS 조각이 너무 많습니다.');
        const url = resource(line, base), range = pendingRange ? byteRange(pendingRange, previous, url) : null;
        segments.push({url, range, duration: pendingDuration});
        previous = range ? {url, end: range.end} : null; pendingRange = undefined; duration += pendingDuration; pendingDuration = 0;
      }
    }
    if (!segments.length || pendingRange) throw new Error('완전한 HLS 영상 조각 목록이 없습니다.');
    // A single contiguous fMP4 resource can be streamed in one request. No remux needed.
    const parts = map ? [map, ...segments] : segments;
    let end = -1;
    const contiguous = Boolean(map) && parts.every(part => {
      if (!part.range || part.url !== parts[0].url || part.range.start !== end + 1) return false;
      end = part.range.end; return true;
    });
    return {map, segments, duration, format: map ? 'mp4' : 'ts', ...(contiguous ? {single: {url: parts[0].url, range: {start: 0, end, length: end + 1}}} : {})};
  }
  async function request(url, {fetcher, signal, range} = {}) {
    aborted(signal);
    const controller = new AbortController();
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, {once: true});
    let timer = setTimeout(abort, 60000);
    const reset = () => { clearTimeout(timer); timer = setTimeout(abort, 60000); };
    const release = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    try {
      const response = await (fetcher || root.fetch)(resource(url), {credentials: 'include', signal: controller.signal, headers: range ? {Range: `bytes=${range.start}-${range.end}`} : {}});
      if (response.url) resource(response.url);
      if (!response.ok) throw new Error(`영상 요청 실패 (${response.status}). 로그인 또는 사이트 접근 권한을 확인해 주세요.`);
      if (range) {
        const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(response.headers.get('Content-Range') || '');
        if (response.status !== 206 || !match || Number(match[1]) !== range.start || Number(match[2]) !== range.end) throw new Error('서버가 요청한 영상 바이트 범위를 반환하지 않았습니다.');
      }
      return {response, reset, release, cancel: () => { controller.abort(); release(); }};
    } catch (error) {
      release();
      if (controller.signal.aborted && !signal?.aborted) throw new Error('영상 서버 응답이 60초 동안 없어 중단했습니다. 다시 시도해 주세요.');
      if (error.name === 'TypeError') throw new Error('영상 서버에 연결할 수 없습니다. Safari에서는 확장 아이콘의 추가 사이트 접근을 허용하고 재시도해 주세요. 네트워크 연결도 확인해 주세요.');
      throw error;
    }
  }
  async function playlist(url, options) {
    const req = await request(url, options);
    try {
      const size = Number(req.response.headers.get('Content-Length'));
      if (size > 8 * 1024 * 1024) throw new Error('HLS 재생 목록이 너무 큽니다.');
      const reader = req.response.body?.getReader();
      if (!reader) throw new Error('HLS 재생 목록을 읽을 수 없습니다.');
      const decoder = new TextDecoder(); let text = '', bytes = 0;
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        req.reset(); bytes += chunk.value.byteLength;
        if (bytes > 8 * 1024 * 1024) throw new Error('HLS 재생 목록이 너무 큽니다.');
        text += decoder.decode(chunk.value, {stream: true});
      }
      text += decoder.decode();
      return parsePlaylist(text, req.response.url || url);
    } finally { req.cancel(); }
  }
  async function resolvePlan(url, options = {}) {
    url = resource(url);
    if (!/\.m3u8(?:$|\?)/i.test(url)) return {format: /\.m4a(?:$|\?)/i.test(url) ? 'm4a' : /\.webm(?:$|\?)/i.test(url) ? 'webm' : 'mp4', parts: [{url, range: null}], duration: 0};
    const seen = new Set();
    for (let depth = 0; depth < 8; depth++) {
      if (seen.has(url)) throw new Error('HLS 재생 목록이 순환합니다.'); seen.add(url);
      const plan = await playlist(url, options);
      if (plan.variant) { url = plan.variant; continue; }
      return {...plan, parts: plan.single ? [plan.single] : [...(plan.map ? [plan.map] : []), ...plan.segments]};
    }
    throw new Error('HLS 재생 목록의 중첩이 너무 깊습니다.');
  }
  function filename(title, id, streamName, index, count, format) {
    const clean = (value, limit) => {
      const text = String(value).replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '_').trim();
      let result = '', size = 0;
      for (const character of text) { const bytes = new TextEncoder().encode(character).length; if (size + bytes > limit) break; result += character; size += bytes; }
      return result.replace(/[. ]+$/g, '');
    };
    // Reserve space for the UUID used by direct directory saves (255-byte limit).
    return `${clean(title, 90) || 'Panopto'} [${id}]${count > 1 ? ` ${index + 1}-${clean(streamName, 35) || '화면'}` : ''}.${format}`;
  }
  function folderPath(value) {
    const path = String(value || '').trim().replace(/\\/g, '/');
    if (path.startsWith('/') || path.split('/').some(part => part === '.' || part === '..' || /[\x00-\x1f:*?"<>|]/.test(part)) || path.length > 200) throw new Error('다운로드 하위 폴더는 상대 경로로 입력해 주세요.');
    return path.split('/').filter(Boolean).join('/');
  }
  async function directoryStore(write, handle) {
    if (!root.indexedDB) throw new Error('브라우저에서 폴더 선택을 저장할 수 없습니다.');
    return new Promise((resolve, reject) => {
      const opening = root.indexedDB.open('panopto-standalone', 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore('settings');
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const db = opening.result, tx = db.transaction('settings', write ? 'readwrite' : 'readonly');
        const request = write ? tx.objectStore('settings').put(handle, 'directory') : tx.objectStore('settings').get('directory');
        let result; request.onsuccess = () => { result = request.result; };
        tx.oncomplete = () => { db.close(); resolve(write ? handle : result); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }
  const getDirectory = () => directoryStore(false);
  const setDirectory = handle => directoryStore(true, handle);
  async function unusedName(directory, name) {
    for (let i = 0; i < 10000; i++) {
      const candidate = i ? name.replace(/(\.[^.]+)$/, ` (${i})$1`) : name;
      try { await directory.getFileHandle(candidate); }
      catch (error) { if (error.name === 'NotFoundError') return candidate; throw error; }
    }
    throw new Error('같은 이름의 파일이 너무 많습니다.');
  }
  async function createSink(settings, proposedName, chosenDirectory) {
    let parent, handle, writable, name = proposedName, direct = false;
    if (settings.saveMode === 'directory') {
      parent = chosenDirectory || await getDirectory();
      if (!parent || await parent.queryPermission({mode: 'readwrite'}) !== 'granted') throw new Error('설정에서 저장 폴더를 다시 선택하고 쓰기 권한을 허용해 주세요.');
      // The picker API has no exclusive-create flag. A fresh unguessable suffix
      // prevents another writer from claiming the name between check and create.
      const unique = proposedName.replace(/(\.[^.]+)$/, ` (${root.crypto.randomUUID()})$1`);
      name = await unusedName(parent, unique); handle = await parent.getFileHandle(name, {create: true}); direct = true;
    } else if (root.navigator?.storage?.getDirectory) {
      try {
        parent = await (await root.navigator.storage.getDirectory()).getDirectoryHandle('panopto-temporary', {create: true});
        const tempName = `video-${root.crypto.randomUUID()}`;
        handle = await parent.getFileHandle(tempName, {create: true});
        if (!handle.createWritable) { await parent.removeEntry(tempName); parent = handle = null; }
      } catch (_) { parent = handle = null; }
    }
    if (handle) {
      try { writable = await handle.createWritable(); }
      catch (error) { await parent.removeEntry(handle.name).catch(() => {}); throw new Error('브라우저 임시 저장 공간에 쓸 수 없습니다. 디스크 여유 공간을 확인해 주세요.'); }
      let closed = false, size = 0;
      return {name, write: async bytes => { await writable.write(bytes); size += bytes.byteLength; }, finish: async () => { await writable.close(); closed = true; return {file: direct ? null : await handle.getFile(), size, direct, cleanup: () => parent.removeEntry(handle.name).catch(() => {})}; }, abort: async () => { if (!closed) await writable.abort().catch(() => {}); await parent.removeEntry(handle.name).catch(() => {}); }};
    }
    const chunks = []; let size = 0;
    return {name, write: async bytes => { if (size + bytes.byteLength > MEMORY_LIMIT) throw new Error('이 브라우저는 디스크 임시 저장을 지원하지 않아 256 MiB 이상 영상을 처리할 수 없습니다. Safari 26 이상 또는 최신 Chrome을 사용해 주세요.'); chunks.push(bytes.slice()); size += bytes.byteLength; }, finish: async () => ({file: new Blob(chunks), size, direct: false, cleanup: async () => { chunks.length = 0; }}), abort: async () => { chunks.length = 0; }};
  }
  function validHeader(bytes, format) {
    if (format === 'ts') return bytes[0] === 0x47;
    if (format === 'webm') return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
    const box = String.fromCharCode(...bytes.slice(4, 8));
    return ['ftyp', 'styp', 'moov', 'moof', 'sidx', 'emsg', 'prft', 'free'].includes(box);
  }
  async function appendPart(part, sink, format, options, onBytes) {
    const req = await request(part.url, {...options, range: part.range});
    let received = 0, probe = [], probeLength = 0, checked = false;
    const expectedHeader = req.response.headers.get('Content-Length');
    const expected = part.range?.length ?? (expectedHeader && /^\d+$/.test(expectedHeader) ? Number(expectedHeader) : null);
    try {
      if (/^(?:text\/|application\/(?:json|xml|xhtml\+xml|problem\+json))/i.test(req.response.headers.get('Content-Type') || '')) throw new Error('영상 대신 로그인 화면 또는 텍스트 응답이 반환되었습니다.');
      const reader = req.response.body?.getReader();
      if (!reader) throw new Error('브라우저에서 영상 스트림을 읽을 수 없습니다.');
      while (true) {
        aborted(options.signal);
        const {done, value} = await reader.read(); if (done) break; req.reset();
        received += value.byteLength;
        if (expected !== null && received > expected) { await reader.cancel(); throw new Error('서버가 예상보다 많은 영상 데이터를 반환했습니다.'); }
        if (!checked) {
          probe.push(value); probeLength += value.byteLength;
          if (probeLength < 8) continue;
          const header = new Uint8Array(8); let offset = 0;
          for (const chunk of probe) { const take = Math.min(chunk.length, 8 - offset); header.set(chunk.subarray(0, take), offset); offset += take; if (offset === 8) break; }
          if (!validHeader(header, format)) { await reader.cancel(); throw new Error('영상 데이터 대신 로그인 화면 또는 지원하지 않는 형식이 반환되었습니다.'); }
          for (const chunk of probe) await sink.write(chunk); probe = []; checked = true;
        } else await sink.write(value);
        onBytes(received, expected);
      }
      if (!checked || received === 0 || (expected !== null && received !== expected)) throw new Error('영상 데이터가 중간에 끊겼습니다. 다시 시도해 주세요.');
      return received;
    } finally { req.cancel(); }
  }
  async function saveBrowser(result, name, settings, signal) {
    aborted(signal);
    const objectUrl = URL.createObjectURL(result.file);
    const entry = {objectUrl, cleanup: result.cleanup}; heldDownloads.add(entry);
    const dispose = async () => { URL.revokeObjectURL(objectUrl); heldDownloads.delete(entry); await result.cleanup(); };
    if (E.api?.downloads?.download) {
      let id;
      try {
        const folder = folderPath(settings.subfolder);
        id = await E.call('downloads', 'download', {url: objectUrl, filename: `${folder ? folder + '/' : ''}${name}`, saveAs: Boolean(settings.askEveryTime), conflictAction: 'uniquify'});
        await new Promise((resolve, reject) => {
          let settled = false;
          const finish = error => { if (settled) return; settled = true; clearInterval(timer); signal?.removeEventListener('abort', cancel); error ? reject(error) : resolve(); };
          const cancel = () => { E.call('downloads', 'cancel', id).catch(() => {}).finally(() => finish(new DOMException('다운로드를 취소했습니다.', 'AbortError'))); };
          const check = async () => { try { const [item] = await E.call('downloads', 'search', {id}); if (item?.state === 'complete') finish(); else if (item?.state === 'interrupted') finish(new Error(`브라우저 저장이 중단되었습니다 (${item.error || '알 수 없는 오류'}).`)); } catch (error) { finish(error); } };
          const timer = setInterval(check, 1000); signal?.addEventListener('abort', cancel, {once: true}); if (signal?.aborted) cancel(); else check();
        });
        return false;
      } finally { await dispose(); }
    }
    try {
      const anchor = root.document.createElement('a'); anchor.href = objectUrl; anchor.download = name; anchor.hidden = true;
      root.document.body.appendChild(anchor); anchor.click(); anchor.remove();
      // Safari has no downloads API. Hold the source until the user confirms the
      // browser finished copying it; an anchor click is not proof of disk save.
      return true;
    } catch (error) { await dispose(); throw error; }
  }
  async function releaseDownloads() {
    const entries = [...heldDownloads];
    for (const entry of entries) { URL.revokeObjectURL(entry.objectUrl); await entry.cleanup(); heldDownloads.delete(entry); }
    return entries.length;
  }
  async function cleanupOrphans() {
    // Called only at startup of the single job tab, before any new transfer.
    if (heldDownloads.size || !root.navigator?.storage?.getDirectory) return;
    try {
      const parent = await (await root.navigator.storage.getDirectory()).getDirectoryHandle('panopto-temporary');
      for await (const [name, handle] of parent.entries()) if (handle.kind === 'file' && /^video-[a-f0-9-]+$/i.test(name)) await parent.removeEntry(name);
    } catch (_) { /* The directory may not exist yet or storage may be disabled. */ }
  }
  async function download(payload, options = {}) {
    const page = E.pageInfo(payload?.pageUrl);
    if (page?.kind !== 'video' || !Array.isArray(payload.streams) || !payload.streams.length) throw new Error('다운로드할 영상 정보가 올바르지 않습니다.');
    const settings = options.settings || {}, onProgress = options.onProgress || (() => {}), files = [];
    const chosenDirectory = settings.saveMode === 'directory' ? await getDirectory() : null;
    if (settings.saveMode === 'directory' && !chosenDirectory) throw new Error('설정에서 저장할 폴더를 선택해 주세요.');
    let handoff = false;
    for (let index = 0; index < payload.streams.length; index++) {
      aborted(options.signal);
      const stream = payload.streams[index], plan = await resolvePlan(stream.url, options);
      const name = filename(payload.title, page.id, stream.name, index, payload.streams.length, plan.format);
      const sink = await (options.createSink || createSink)(settings, name, chosenDirectory);
      let size = 0, finished = null;
      try {
        for (let partIndex = 0; partIndex < plan.parts.length; partIndex++) {
          const part = plan.parts[partIndex];
          const before = size;
          size += await appendPart(part, sink, plan.format, options, (bytes, total) => {
            const fraction = total ? bytes / total : 0;
            onProgress({phase: 'downloading', progress: 95 * (index + (partIndex + fraction) / plan.parts.length) / payload.streams.length, bytes: before + bytes, total});
          });
        }
        aborted(options.signal); finished = await sink.finish();
        onProgress({phase: 'saving', progress: 95 + 5 * index / payload.streams.length, bytes: size, total: size});
        if (!finished.direct) handoff = (await (options.saver || saveBrowser)(finished, sink.name || name, settings, options.signal)) || handoff;
        files.push({name: sink.name || name, size, format: plan.format});
      } catch (error) { await sink.abort(); if (finished && !finished.direct) await finished.cleanup(); throw error; }
    }
    onProgress({phase: handoff ? 'handedOff' : 'completed', progress: 100});
    return {files, handoff};
  }
  const exported = {download, parsePlaylist, resolvePlan, resource, filename, folderPath, getDirectory, setDirectory, releaseDownloads, cleanupOrphans, pendingHandoffs: () => heldDownloads.size, MEMORY_LIMIT};
  root.PanoptoMedia = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this);
