(function (root) {
  'use strict';
  const HELPER = 'http://127.0.0.1:8765';
  const GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
  const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
  const api = root.browser || root.chrome;
  function call(area, method, ...args) {
    const namespace = area === 'storage' ? api?.storage?.local : api?.[area];
    if (!namespace?.[method]) return Promise.reject(new Error('확장 기능 API를 사용할 수 없습니다.'));
    if (root.browser) return Promise.resolve(namespace[method](...args));
    return new Promise((resolve, reject) => {
      namespace[method](...args, result => {
        const error = api.runtime?.lastError;
        if (error) reject(new Error(error.message)); else resolve(result);
      });
    });
  }
  function guid(value) { return typeof value === 'string' && GUID.test(value) ? value.toLowerCase() : null; }
  function pageInfo(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || !url.hostname.endsWith('.panopto.com') || url.username || url.password) return null;
      if (/^\/Panopto\/Pages\/(Viewer|Embed)\.aspx$/i.test(url.pathname)) {
        const id = [...url.searchParams].find(([key]) => key.toLowerCase() === 'id')?.[1];
        return guid(id) ? {kind: 'video', id: guid(id), origin: url.origin, url: `${url.origin}/Panopto/Pages/Viewer.aspx?id=${guid(id)}`} : null;
      }
      if (/^\/Panopto\/Pages\/Sessions\/List\.aspx$/i.test(url.pathname)) {
        const params = new URLSearchParams(url.hash.slice(1));
        const value = [...params, ...url.searchParams].find(([key]) => key.toLowerCase() === 'folderid')?.[1];
        const id = guid(value?.replace(/^"|"$/g, ''));
        return {kind: 'folder', id, origin: url.origin, url: id ? `${url.origin}${url.pathname}#folderID=${id}` : `${url.origin}${url.pathname}`};
      }
    } catch (_) { /* A page URL is untrusted input. */ }
    return null;
  }
  function streamUrl(value, origin) {
    try {
      const url = new URL(value, origin);
      return typeof value === 'string' && value && url.protocol === 'https:' && !url.username && !url.password &&
        (url.hostname === 'panopto.com' || url.hostname.endsWith('.panopto.com')) ? url.href : null;
    } catch (_) { return null; }
  }
  function deliveryPayload(info, origin, sessionId) {
    if (!guid(sessionId) || !pageInfo(`${origin}/Panopto/Pages/Viewer.aspx?id=${sessionId}`)) throw new Error('올바른 Panopto 영상 주소가 아닙니다.');
    const errors = {2: 'Panopto 로그인이 만료되었습니다. 강의 탭에서 다시 로그인해 주세요.', 3: '이 영상을 볼 권한이 없습니다.', 4: '영상 재생 파일이 아직 준비되지 않았습니다.', 6: '영상 정보를 찾을 수 없습니다.', 8: '현재 공개된 영상이 아닙니다.'};
    if (info?.ErrorCode) throw new Error(errors[info.ErrorCode] || 'Panopto가 영상 정보 요청을 거부했습니다.');
    const delivery = info?.Delivery;
    if (!delivery) throw new Error('영상 정보를 받지 못했습니다. 강의 탭의 로그인 상태를 확인해 주세요.');
    if (delivery.IsActiveBroadcast) throw new Error('녹화 중인 실시간 강의는 녹화 완료 후 다운로드할 수 있습니다.');
    const official = streamUrl(info.DownloadUrl, origin);
    const streams = [], seen = new Set();
    if (official) streams.push({url: official, name: '통합 영상'});
    else for (const stream of delivery.Streams || []) {
      const url = streamUrl(stream.StreamUrl, origin);
      if (!url || seen.has(url) || !/\.(m3u8|mp4|m4v|m4a|webm)(?:$|\?)/i.test(url)) continue;
      seen.add(url);
      streams.push({url, name: stream.StreamTypeName === 'Archival' ? '발표자' : `화면 ${streams.length + 1}`});
    }
    if (!streams.length) throw new Error('다운로드 가능한 MP4 또는 HLS 재생 파일이 없습니다.');
    return {title: String(delivery.SessionName || 'Panopto 영상'), pageUrl: `${origin}/Panopto/Pages/Viewer.aspx?id=${guid(sessionId)}`, duration: delivery.Duration, streams};
  }
  function sessionQuery(folderId, page, maxResults = 250) {
    if (!guid(folderId) || !Number.isInteger(page) || page < 0) throw new Error('올바른 강의 폴더가 아닙니다.');
    return {queryParameters: {query: null, sortColumn: 1, sortAscending: true, maxResults, page, startDate: null, endDate: null,
      folderID: guid(folderId), status: null, bookmarked: false, getFolderData: true, isSharedWithMe: false,
      isSubscriptionsPage: false, subscribableTypes: null, includeArchived: true, includeArchivedStateCount: true,
      sessionListOnlyArchived: false, includePlaylists: false, searchSubfolders: false}};
  }
  async function enumerateFolder(folderId, fetchPage, onProgress = () => {}) {
    const sessions = [], seen = new Set(), pages = new Set();
    let offset = 0, total = 0;
    for (let page = 0; page < 10000; page++) {
      const response = await fetchPage(sessionQuery(folderId, page));
      const data = response?.d ?? response;
      if (!Array.isArray(data?.Results) || !Number.isInteger(data.TotalNumber) || data.TotalNumber < 0) throw new Error('강의 목록 응답을 확인할 수 없습니다. 로그인 후 다시 시도해 주세요.');
      total = Math.max(total, data.TotalNumber);
      const rows = data.Results;
      const signature = JSON.stringify(rows.map(row => row.DeliveryID));
      if (!rows.length && offset < total) throw new Error(`강의 목록이 중간에 끊겼습니다 (${offset}/${total}). 다시 시도해 주세요.`);
      if (rows.length && pages.has(signature)) throw new Error('Panopto가 같은 목록 페이지를 반복했습니다. 전체 목록을 확인하지 못했습니다.');
      pages.add(signature);
      for (const row of rows) {
        if (Number(row.PlayableObjectType) === 1) continue;
        const id = guid(row.DeliveryID);
        if (!id) throw new Error('강의 목록에 올바른 영상 ID가 없는 항목이 있습니다.');
        if (!seen.has(id)) { seen.add(id); sessions.push({id, title: String(row.SessionName || row.DeliveryName || 'Panopto 영상')}); }
      }
      offset += rows.length;
      onProgress({scanned: offset, total, videos: sessions.length});
      if (offset >= total) return sessions;
    }
    throw new Error('강의 폴더가 너무 커서 전체 목록을 확인하지 못했습니다.');
  }
  function rate(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0.25 || parsed > 4) throw new Error('재생 속도는 0.25–4배 사이여야 합니다.');
    return parsed;
  }
  function applyRate(media, desired) {
    const value = rate(desired);
    if (media.defaultPlaybackRate !== value) media.defaultPlaybackRate = value;
    if (media.playbackRate !== value) media.playbackRate = value;
    if ('preservesPitch' in media) media.preservesPitch = true;
    if ('webkitPreservesPitch' in media) media.webkitPreservesPitch = true;
  }
  function safeError(error) {
    // Panopto fetch failures and helper errors must never expose signed stream URLs.
    return String(error?.message || error || '요청에 실패했습니다.').replace(/https?:\/\/[^\s<>"']+/gi, '[주소 숨김]').slice(0, 700);
  }
  const exported = {HELPER, GUID, RATES, TERMINAL, api, call, guid, pageInfo, streamUrl, deliveryPayload, sessionQuery, enumerateFolder, rate, applyRate, safeError};
  root.PanoptoExt = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this);
