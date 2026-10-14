(function () {
  'use strict';
  const E = globalThis.PanoptoExt;
  if (!E || document.getElementById('panopto-extension-tools')) return;
  let desiredRate = 1, applying = false, starting = false, currentPage;
  const host = document.createElement('div');
  host.id = 'panopto-extension-tools';
  const shadow = host.attachShadow({mode: 'closed'});
  shadow.innerHTML = `<style>
    :host{all:initial;position:fixed;right:18px;bottom:18px;z-index:2147483647;color:#e9eef8;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    *{box-sizing:border-box}section{width:300px;background:#162130;border:1px solid #33465e;border-radius:14px;box-shadow:0 8px 30px #0005;overflow:hidden}
    header{display:flex;align-items:center;justify-content:space-between;padding:10px 13px;font-weight:650;background:#1e2d40}button,select{font:inherit;cursor:pointer}button{border:0;border-radius:8px;color:inherit;background:#2c415b;padding:8px 11px}button:hover{background:#395473}button:disabled{opacity:.55;cursor:wait}.toggle{background:transparent;padding:0 4px;font-size:18px}
    .body{padding:12px}.actions{display:flex;gap:7px}.primary{background:#88d9bf;color:#102c24;font-weight:650;flex:1}.primary:hover{background:#a5e6d0}.speed{display:flex;align-items:center;justify-content:space-between;margin-top:11px}select{background:#22354b;color:#f4f8ff;border:1px solid #4a627e;border-radius:7px;padding:4px 7px}p{margin:9px 0 0;color:#aebed2;font-size:12px;overflow-wrap:anywhere}.error{color:#ffc6b8}a{color:#a5e6d0;text-decoration:none}.links{display:flex;gap:13px;margin-top:9px;font-size:12px}[hidden]{display:none!important}
    :host([hidden]){display:none!important}@media(max-width:480px){:host{right:8px;bottom:8px}section{width:270px}}
    </style><section aria-label="Panopto 다운로드 확장"><header><span>Panopto 다운로드</span><button class="toggle" aria-label="도구 접기" aria-expanded="true">−</button></header><div class="body"><div class="actions"><button class="primary" id="download"></button></div><label class="speed">재생 속도<select aria-label="재생 속도"></select></label><p id="status" role="status">브라우저에서 바로 다운로드합니다.</p><div class="links"><a id="downloads" href="#">다운로드 현황 ↗</a><a id="settings" href="#">설정</a></div></div></section>`;
  document.documentElement.appendChild(host);
  const $ = selector => shadow.querySelector(selector);
  const select = $('select');
  for (const value of E.RATES) { const option = document.createElement('option'); option.value = value; option.textContent = `${value}배`; select.appendChild(option); }
  function applyAll() {
    if (applying) return;
    applying = true;
    try { for (const media of document.querySelectorAll('video, audio')) E.applyRate(media, desiredRate); }
    finally { applying = false; }
  }
  function updateRate(value) { desiredRate = E.rate(value); select.value = String(desiredRate); applyAll(); }
  E.call('storage', 'get', 'playbackRate').then(saved => updateRate(saved.playbackRate || 1)).catch(() => {});
  E.api.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.playbackRate) updateRate(changes.playbackRate.newValue || 1); });
  document.addEventListener('loadedmetadata', applyAll, true);
  document.addEventListener('ratechange', applyAll, true);
  const mediaObserver = new MutationObserver(records => { if (records.some(record => [...record.addedNodes].some(node => node.nodeType === 1 && (node.matches('video,audio') || node.querySelector('video,audio'))))) applyAll(); });
  mediaObserver.observe(document.documentElement, {childList: true, subtree: true});
  async function send(action, data = {}) {
    const response = await E.call('runtime', 'sendMessage', {action, ...data});
    if (!response?.ok) throw new Error(response?.error || '확장 기능에 연결하지 못했습니다. 페이지를 새로고침해 주세요.');
    return response.data;
  }
  function status(text, error = false) { $('#status').textContent = text; $('#status').className = error ? 'error' : ''; }
  async function panoptoFetch(path, options) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(path, {...options, credentials: 'include', signal: controller.signal});
      if (!response.ok) throw new Error(`Panopto 요청 실패 (${response.status}). 강의 탭의 로그인 상태를 확인해 주세요.`);
      try { return await response.json(); } catch (_) { throw new Error('Panopto 로그인 화면이 반환되었습니다. 다시 로그인해 주세요.'); }
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Panopto 응답 시간이 초과되었습니다. 다시 시도해 주세요.');
      throw error;
    } finally { clearTimeout(timer); }
  }
  async function metadata(sessionId) {
    if (!E.guid(sessionId)) throw new Error('올바른 영상 ID가 아닙니다.');
    const info = await panoptoFetch('/Panopto/Pages/Viewer/DeliveryInfo.aspx', {method: 'POST', body: new URLSearchParams({deliveryId: sessionId, responseType: 'json', isLiveNotes: 'false', isActiveBroadcast: 'false', isEditing: 'false', isEmbed: 'false'})});
    return E.deliveryPayload(info, location.origin, sessionId);
  }
  async function enumerate(folderId) {
    const page = E.pageInfo(location.href);
    if (page?.kind !== 'folder' || page.id !== E.guid(folderId)) throw new Error('현재 열린 강의 폴더를 확인하지 못했습니다.');
    const csrf = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith('csrfToken='))?.slice('csrfToken='.length);
    return E.enumerateFolder(folderId, query => panoptoFetch('/Panopto/Services/Data.svc/GetSessions', {method: 'POST', headers: {'Content-Type': 'application/json', ...(csrf ? {'X-Csrf-Token': csrf} : {})}, body: JSON.stringify(query)}), progress => status(`폴더 전체 목록 확인 중 · ${progress.scanned}/${progress.total}개`));
  }
  E.api.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== E.api.runtime.id || !['metadata', 'enumerate', 'rate'].includes(message?.action)) return;
    (async () => {
      if (message.action === 'metadata') return metadata(message.sessionId);
      if (message.action === 'enumerate') return enumerate(message.folderId);
      updateRate(message.rate); return {rate: desiredRate};
    })().then(data => respond({ok: true, data})).catch(error => respond({ok: false, error: E.safeError(error)}));
    return true;
  });
  function updatePage() {
    currentPage = E.pageInfo(location.href);
    host.hidden = !currentPage;
    $('#download').textContent = currentPage?.kind === 'video' ? '이 영상 다운로드' : '폴더 전체 다운로드';
    $('#download').disabled = starting || !currentPage?.id;
    $('.speed').hidden = currentPage?.kind !== 'video';
    if (currentPage?.kind === 'folder' && !currentPage.id) status('다운로드할 강의 폴더를 먼저 선택해 주세요.');
  }
  $('#download').addEventListener('click', async () => {
    starting = true; updatePage(); status(currentPage.kind === 'folder' ? '폴더 전체 목록을 확인하고 있습니다…' : '다운로드 준비 중…');
    try {
      const result = await send(currentPage.kind === 'folder' ? 'startFolder' : 'startVideo');
      status(result.duplicate ? '이미 다운로드 대기열에 있는 영상입니다.' : `${result.count}개 영상을 대기열에 추가했습니다. 강의 탭과 다운로드 작업 탭을 열어 두세요.`);
    } catch (error) { status(E.safeError(error), true); }
    finally { starting = false; updatePage(); }
  });
  select.addEventListener('change', async () => { updateRate(select.value); try { await send('setRate', {rate: desiredRate}); } catch (error) { status(E.safeError(error), true); } });
  $('.toggle').addEventListener('click', () => { const hidden = !$('.body').hidden; $('.body').hidden = hidden; $('.toggle').textContent = hidden ? '+' : '−'; $('.toggle').setAttribute('aria-expanded', String(!hidden)); $('.toggle').setAttribute('aria-label', hidden ? '도구 펼치기' : '도구 접기'); });
  $('#downloads').addEventListener('click', event => { event.preventDefault(); send('openDownloads').catch(error => status(E.safeError(error), true)); });
  $('#settings').addEventListener('click', event => { event.preventDefault(); send('openOptions').catch(error => status(E.safeError(error), true)); });
  async function poll() {
    updatePage();
    if (starting || !currentPage?.id) return;
    try {
      const state = await send('state');
      const batch = [...state.batches].reverse().find(batch => batch.origin === currentPage.origin && (currentPage.kind === 'folder' ? batch.folderId === currentPage.id : batch.items.some(item => item.id === currentPage.id)));
      if (!batch) { status('다운로드 중에는 강의 탭과 다운로드 작업 탭을 열어 두세요.'); return; }
      if (batch.blockedError) { status(batch.blockedError, true); return; }
      const done = batch.items.filter(item => item.status === 'completed').length, handedOff = batch.items.filter(item => item.status === 'handedOff').length, failed = batch.items.filter(item => item.status === 'failed').length, cancelled = batch.items.filter(item => item.status === 'cancelled').length, interrupted = batch.items.filter(item => item.status === 'interrupted').length;
      status(`저장 완료 ${done}/${batch.items.length}${handedOff ? ` · 브라우저에 전달 ${handedOff}` : ''}${failed ? ` · 실패 ${failed}` : ''}${cancelled ? ` · 취소 ${cancelled}` : ''}${interrupted ? ` · 중단 ${interrupted}` : ''} · 브라우저 전달 후에는 다운로드 목록에서 저장 결과를 확인하세요.`, failed > 0 || interrupted > 0);
    } catch (error) { status(E.safeError(error), true); }
  }
  window.addEventListener('hashchange', updatePage);
  updatePage(); poll(); setInterval(poll, 5000);
})();
