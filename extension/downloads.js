(async function () {
  'use strict';
  const E = globalThis.PanoptoExt, M = globalThis.PanoptoMedia, $ = id => document.getElementById(id);
  const labels = {pending:'대기', preparing:'준비 중', downloading:'다운로드 중', saving:'저장 중', cancelling:'취소 중', completed:'저장 완료', handedOff:'브라우저로 전달', interrupted:'중단됨', failed:'실패', cancelled:'취소'};
  const engine = new globalThis.PanoptoQueueEngine({
    read: () => E.call('storage', 'get', ['standaloneBatches', 'standaloneSettings']),
    write: value => E.call('storage', 'set', value),
    migrate: () => E.call('storage', 'remove', ['config', 'batches', 'token']),
    tab: id => E.call('tabs', 'get', id),
    message: async (id, message) => {
      let response;
      try { response = await E.call('tabs', 'sendMessage', id, message); }
      catch (_) { throw new Error('강의 페이지의 확장 기능에 연결할 수 없습니다. 해당 탭을 새로고침하고 재시도해 주세요.'); }
      if (!response?.ok) throw new Error(response?.error || '강의 페이지에서 응답하지 않았습니다.');
      return response.data;
    },
    download: (payload, options) => M.download(payload, options)
  });
  function node(tag, text, className) { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; }
  function error(error) { $('status').textContent = E.safeError(error); $('status').className = 'error'; }
  let renderedState = '';
  function pump() { engine.tick().catch(error).finally(render); }
  async function sourceTab(batch) {
    try { const tab = await E.call('tabs', 'get', batch.tabId); if (E.pageInfo(tab.url)?.origin === batch.origin) return tab.id; } catch (_) {}
    const tabs = await E.call('tabs', 'query', {});
    return tabs.find(tab => E.pageInfo(tab.url)?.origin === batch.origin)?.id;
  }
  function render() {
    const state = engine.snapshot(); $('location').textContent = `저장 위치: ${state.connection.outputDir}`;
    $('cleanup').disabled = engine.busy || !$('cleanup-confirm').checked;
    const signature = JSON.stringify(state.batches);
    if (signature === renderedState) return;
    renderedState = signature;
    const list = $('batches'); list.replaceChildren();
    if (!state.batches.length) { list.appendChild(node('p', 'Panopto 강의 페이지에서 영상 또는 폴더 전체 다운로드를 시작해 주세요.', 'empty')); return; }
    for (const batch of [...state.batches].reverse()) {
      const section = node('section', undefined, 'batch'), heading = node('div', undefined, 'batchhead');
      heading.appendChild(node('strong', batch.title));
      const complete = batch.items.filter(item => item.status === 'completed').length, handed = batch.items.filter(item => item.status === 'handedOff').length;
      heading.appendChild(node('span', `저장 ${complete}/${batch.items.length}${handed ? ` · 브라우저 전달 ${handed}` : ''}`, 'muted')); section.appendChild(heading);
      if (batch.blockedError) section.appendChild(node('p', batch.blockedError, 'error'));
      const controls = node('div', undefined, 'controls');
      if (batch.items.some(item => !E.TERMINAL.has(item.status))) {
        const cancel = node('button', '대기열 취소'); cancel.type = 'button';
        cancel.addEventListener('click', async () => { cancel.disabled = true; try { await engine.cancel(batch.id); render(); } catch (failure) { error(failure); } }); controls.appendChild(cancel);
      }
      if (batch.blockedError || batch.items.some(item => ['failed','cancelled','interrupted'].includes(item.status))) {
        const retry = node('button', '재시도'); retry.type = 'button';
        retry.addEventListener('click', async () => { retry.disabled = true; try { const id = await sourceTab(batch); if (!id) throw new Error('같은 Panopto 사이트에 로그인한 강의 탭을 먼저 열어 주세요.'); await engine.retry(batch.id, id); pump(); render(); } catch (failure) { error(failure); retry.disabled = false; } }); controls.appendChild(retry);
      }
      if (controls.children.length) section.appendChild(controls);
      for (const item of batch.items) {
        const row = node('div', undefined, 'item'), top = node('div', undefined, 'itemtop');
        top.appendChild(node('span', item.title)); top.appendChild(node('span', `${labels[item.status] || item.status}${['downloading','saving'].includes(item.status) ? ` ${Math.round(item.progress || 0)}%` : ''}`, `badge${['failed','interrupted'].includes(item.status) ? ' error' : ''}`)); row.appendChild(top);
        if (!E.TERMINAL.has(item.status)) { const progress = node('progress'); progress.max = 100; progress.value = item.progress || 0; progress.setAttribute('aria-label', `${item.title} 진행률`); row.appendChild(progress); }
        if (item.error) row.appendChild(node('p', item.error, 'error'));
        if (item.status === 'handedOff') row.appendChild(node('p', 'Safari 다운로드 목록에서 저장 완료 여부를 확인해 주세요.', 'muted'));
        if (item.files?.length) { const files = node('ul', undefined, 'files'); for (const file of item.files) files.appendChild(node('li', `${file.name} · ${(file.size / 1048576).toFixed(1)} MB`)); row.appendChild(files); }
        section.appendChild(row);
      }
      list.appendChild(section);
    }
  }
  const current = await E.call('tabs', 'getCurrent');
  const claim = await E.call('runtime', 'sendMessage', {action: 'runnerClaim', tabId: current?.id});
  if (!claim?.ok || !claim.data?.claimed) {
    $('status').textContent = '다운로드 작업 탭이 이미 열려 있습니다. 기존 작업 탭을 사용하고 이 탭은 닫아 주세요.';
    $('settings').addEventListener('click', () => E.call('runtime', 'sendMessage', {action: 'openDownloads'}).catch(error));
    return;
  }
  if (typeof M.cleanupOrphans === 'function') await M.cleanupOrphans();
  await engine.init();
  E.api.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== E.api.runtime.id || message?.target !== 'runner') return;
    if (sender.tab && !sender.url?.startsWith(E.api.runtime.getURL(''))) return;
    (async () => {
      switch (message.action) {
        case 'ping': return {};
        case 'state': return engine.snapshot();
        case 'startVideo': case 'startFolder': { const result = await engine.start(message.tabId, message.action === 'startVideo' ? 'video' : 'folder'); pump(); return result; }
        case 'cancel': await engine.cancel(message.batchId); return {};
        case 'retry': await engine.retry(message.batchId, message.tabId); pump(); return {};
        case 'configure': return engine.configure(message.settings || message);
        default: throw new Error('지원하지 않는 작업 요청입니다.');
      }
    })().then(data => { render(); respond({ok: true, data}); }).catch(failure => respond({ok: false, error: E.safeError(failure)}));
    return true;
  });
  $('settings').addEventListener('click', () => E.call('runtime', 'openOptionsPage').catch(error));
  $('cleanup-confirm').addEventListener('change', render);
  $('cleanup').addEventListener('click', async () => {
    if (engine.busy || !$('cleanup-confirm').checked) return;
    $('cleanup').disabled = true;
    try { await M.releaseDownloads(); $('status').textContent = '임시 파일을 정리했습니다.'; $('status').className = ''; $('cleanup-confirm').checked = false; }
    catch (failure) { error(failure); } finally { render(); }
  });
  window.addEventListener('beforeunload', event => {
    if (engine.busy || M.pendingHandoffs?.()) { event.preventDefault(); event.returnValue = ''; }
  });
  await E.call('runtime', 'sendMessage', {action: 'runnerReady'}).catch(error);
  render(); setInterval(render, 1000);
})();
