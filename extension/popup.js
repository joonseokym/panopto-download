(async function () {
  'use strict';
  const E = globalThis.PanoptoExt, $ = id => document.getElementById(id);
  let tab, page, starting = false, polling = false;
  const labels = {pending: '대기', preparing: '준비 중', downloading: '다운로드 중', saving: '저장 중', cancelling: '취소 중', completed: '저장 완료', handedOff: '브라우저에 전달', failed: '실패', cancelled: '취소', interrupted: '중단'};
  function status(text, error = false) { $('status').textContent = text; $('status').className = `status${error ? ' error' : ''}`; }
  async function send(action, data = {}) {
    const response = await E.call('runtime', 'sendMessage', {action, tabId: tab?.id, ...data});
    if (!response?.ok) throw new Error(response?.error || '확장 기능에 연결하지 못했습니다.');
    return response.data;
  }
  function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
  function render(state) {
    const container = $('batches'); container.replaceChildren();
    const batches = [...state.batches].reverse();
    if (!batches.length) { container.appendChild(element('p', 'empty', '다운로드를 시작하면 영상별 진행 상황이 표시됩니다.')); return; }
    for (const batch of batches) {
      const section = element('section', 'batch'), header = element('div', 'batchhead');
      header.appendChild(element('strong', '', batch.title));
      const done = batch.items.filter(item => item.status === 'completed').length, handedOff = batch.items.filter(item => item.status === 'handedOff').length, failed = batch.items.filter(item => item.status === 'failed').length, cancelled = batch.items.filter(item => item.status === 'cancelled').length, interrupted = batch.items.filter(item => item.status === 'interrupted').length;
      header.appendChild(element('div', 'counts', `저장 완료 ${done}/${batch.items.length}${handedOff ? ` · 브라우저에 전달 ${handedOff}` : ''}${failed ? ` · 실패 ${failed}` : ''}${cancelled ? ` · 취소 ${cancelled}` : ''}${interrupted ? ` · 중단 ${interrupted}` : ''}`));
      if (batch.blockedError) header.appendChild(element('p', 'error', batch.blockedError));
      const tools = element('div', 'batchtools');
      if (batch.items.some(item => !E.TERMINAL.has(item.status))) {
        const cancel = element('button', '', '대기열 취소');
        cancel.addEventListener('click', async () => { cancel.disabled = true; try { await send('cancel', {batchId: batch.id}); await refresh(); } catch (error) { status(E.safeError(error), true); cancel.disabled = false; } }); tools.appendChild(cancel);
      }
      if (batch.blockedError || failed || cancelled || interrupted) {
        const retry = element('button', '', '현재 탭에서 재시도'); retry.disabled = !page || page.origin !== batch.origin;
        retry.addEventListener('click', async () => { retry.disabled = true; try { await send('retry', {batchId: batch.id}); await refresh(); } catch (error) { status(E.safeError(error), true); retry.disabled = false; } }); tools.appendChild(retry);
      }
      if (tools.children.length) header.appendChild(tools);
      section.appendChild(header);
      for (const item of batch.items) {
        const row = element('div', 'item'), top = element('div', 'itemtop');
        top.appendChild(element('span', 'title', item.title));
        const suffix = item.status === 'downloading' || item.status === 'saving' ? ` ${Math.round(item.progress || 0)}%` : '';
        top.appendChild(element('span', `badge${item.status === 'completed' ? ' done' : item.status === 'failed' ? ' error' : ''}`, (labels[item.status] || item.status) + suffix)); row.appendChild(top);
        if (!E.TERMINAL.has(item.status) && Number.isFinite(item.progress)) { const progress = element('progress'); progress.max = 100; progress.value = item.progress || 0; progress.setAttribute('aria-label', `${item.title} 다운로드 진행률`); row.appendChild(progress); }
        if (item.error) row.appendChild(element('p', 'error', item.error));
        section.appendChild(row);
      }
      container.appendChild(section);
    }
  }
  async function refresh() {
    if (polling) return;
    polling = true;
    try {
      const state = await send('state'); render(state);
      if (!starting) {
        status(state.connection?.outputDir ? `저장 위치: ${state.connection.outputDir}` : '다운로드 작업 탭과 강의 탭을 열어 두세요.');
      }
    } catch (error) { status(E.safeError(error), true); }
    finally { polling = false; }
  }
  async function start(action) {
    starting = true; $('video').disabled = true; $('folder').disabled = true;
    status(action === 'startFolder' ? '모든 목록 페이지를 확인하고 있습니다…' : '다운로드를 준비하고 있습니다…');
    try { const result = await send(action); status(result.duplicate ? '이미 대기열에 있는 영상입니다.' : `${result.count}개 영상을 대기열에 추가했습니다.${result.alreadyQueued ? ` ${result.alreadyQueued}개는 이미 대기열에 있습니다.` : ''}`); }
    catch (error) { status(E.safeError(error), true); }
    finally { starting = false; $('video').disabled = page?.kind !== 'video'; $('folder').disabled = page?.kind !== 'folder' || !page.id; await refresh(); }
  }
  $('downloads').addEventListener('click', event => { event.preventDefault(); send('openDownloads').catch(error => status(E.safeError(error), true)); });
  $('settings').addEventListener('click', event => { event.preventDefault(); send('openOptions').catch(error => status(E.safeError(error), true)); });
  for (const value of E.RATES) { const option = element('option', '', `${value}배`); option.value = value; $('rate').appendChild(option); }
  try {
    [tab] = await E.call('tabs', 'query', {active: true, currentWindow: true}); page = E.pageInfo(tab?.url);
    $('page').textContent = page ? (page.kind === 'folder' && !page.id ? '먼저 다운로드할 강의 폴더를 선택해 주세요.' : tab.title || (page.kind === 'video' ? '현재 영상' : '현재 강의 폴더')) : 'Panopto 영상 또는 강의 폴더 탭을 열어 주세요.';
    $('video').disabled = page?.kind !== 'video'; $('folder').disabled = page?.kind !== 'folder' || !page.id; $('rate').disabled = page?.kind !== 'video';
    const saved = await E.call('storage', 'get', 'playbackRate'); $('rate').value = saved.playbackRate || 1;
  } catch (error) { status(E.safeError(error), true); }
  $('video').addEventListener('click', () => start('startVideo'));
  $('folder').addEventListener('click', () => start('startFolder'));
  $('rate').addEventListener('change', async () => { try { await send('setRate', {rate: $('rate').value}); } catch (error) { status(E.safeError(error), true); } });
  await refresh(); setInterval(refresh, 2500);
})();
