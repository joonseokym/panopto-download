'use strict';
if (typeof importScripts === 'function') importScripts('common.js', 'queue.js');
(function (root) {
  const E = root.PanoptoExt;
  if (!E?.api) return;
  const runnerURL = E.api.runtime.getURL('downloads.html');
  const migration = E.call('storage', 'remove', ['config', 'batches', 'token']).catch(() => {});
  let opening, mutations = Promise.resolve();
  const readyWaiters = new Set();
  function mutate(operation) {
    const result = mutations.catch(() => {}).then(operation);
    mutations = result; return result;
  }
  async function requestRunner(message) {
    const response = await E.call('runtime', 'sendMessage', {...message, target: 'runner'});
    if (!response?.ok) throw new Error(response?.error || '다운로드 작업 탭에 연결하지 못했습니다.');
    return response.data;
  }
  async function findRunner() {
    const tabs = await E.call('tabs', 'query', {});
    return tabs.find(tab => tab.url?.split('#')[0] === runnerURL);
  }
  async function ensureRunner(focus = false) {
    if (opening) return opening;
    opening = (async () => {
      let tab = await findRunner();
      if (tab) {
        try { await requestRunner({action: 'ping'}); if (focus) await E.call('tabs', 'update', tab.id, {active: true}); return tab; }
        catch (_) { /* An existing tab may still be loading after browser restart. */ }
      }
      let timer, ready;
      const wait = new Promise((resolve, reject) => {
        ready = resolve; readyWaiters.add(ready);
        timer = setTimeout(() => reject(new Error('다운로드 작업 탭이 준비되지 않았습니다. 작업 탭을 새로고침해 주세요.')), 15000);
      });
      try {
        if (!tab) tab = await E.call('tabs', 'create', {url: runnerURL, active: true});
        if (focus && tab) await E.call('tabs', 'update', tab.id, {active: true});
        // Readiness can arrive between the first probe and registering the waiter.
        requestRunner({action: 'ping'}).then(ready).catch(() => {});
        await wait;
        await requestRunner({action: 'ping'});
        return tab;
      } finally { clearTimeout(timer); readyWaiters.delete(ready); }
    })();
    try { return await opening; } finally { opening = null; }
  }
  async function passiveState() {
    try { if (await findRunner()) return await requestRunner({action: 'state'}); } catch (_) { /* Closed runner: report interrupted work. */ }
    const saved = await E.call('storage', 'get', ['standaloneBatches', 'standaloneSettings']);
    // Read-only UI polling must never overwrite a newer runner/settings write.
    const engine = new root.PanoptoQueueEngine({read: async () => saved, write: async () => {}});
    await engine.init(); return {...engine.snapshot(), runnerOpen: false};
  }
  E.api.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== E.api.runtime.id || !message || typeof message.action !== 'string' || message.target === 'runner') return;
    const extensionSender = sender.url?.startsWith(E.api.runtime.getURL(''));
    const fromContent = Boolean(sender.tab) && !extensionSender;
    if (fromContent && (!E.pageInfo(sender.tab.url) || !['state', 'startVideo', 'startFolder', 'setRate', 'cancel', 'retry', 'openOptions', 'openDownloads'].includes(message.action))) return;
    if (message.action === 'runnerReady') {
      if (sender.url?.split('#')[0] !== runnerURL) return;
      for (const ready of readyWaiters) ready();
      respond({ok: true, data: {}}); return;
    }
    (async () => {
      await migration;
      const tabId = fromContent ? sender.tab.id : message.tabId;
      switch (message.action) {
        case 'state': return passiveState();
        case 'runnerClaim': {
          if (sender.url?.split('#')[0] !== runnerURL) throw new Error('올바른 다운로드 작업 탭이 아닙니다.');
          if (sender.tab && sender.tab.id !== message.tabId) throw new Error('다운로드 작업 탭 ID가 일치하지 않습니다.');
          if (!opening) await mutations.catch(() => {});
          const first = await findRunner();
          return {claimed: first?.id === message.tabId};
        }
        case 'startVideo': case 'startFolder': case 'retry':
          return mutate(async () => { await ensureRunner(true); return requestRunner({...message, tabId}); });
        case 'cancel': return mutate(async () => {
          const state = await passiveState();
          if (state.runnerOpen) return requestRunner({...message, tabId});
          if (await findRunner()) { await ensureRunner(); return requestRunner({...message, tabId}); }
          const engine = new root.PanoptoQueueEngine({read: () => E.call('storage', 'get', ['standaloneBatches', 'standaloneSettings']), write: value => E.call('storage', 'set', value)});
          await engine.cancel(message.batchId); return {};
        });
        case 'options': { const state = await passiveState(); return {settings: state.settings, ...state.settings, outputDir: state.connection.outputDir}; }
        case 'configure': return mutate(async () => {
          const state = await passiveState();
          if (state.runnerOpen) return requestRunner(message);
          if (await findRunner()) { await ensureRunner(); return requestRunner(message); }
          const engine = new root.PanoptoQueueEngine({read: () => E.call('storage', 'get', ['standaloneBatches', 'standaloneSettings']), write: value => E.call('storage', 'set', value)});
          return engine.configure(message.settings || message);
        });
        case 'connect': return (await passiveState()).connection;
        case 'setRate': {
          const value = E.rate(message.rate);
          await E.call('storage', 'set', {playbackRate: value});
          if (!fromContent && tabId) await E.call('tabs', 'sendMessage', tabId, {action: 'rate', rate: value});
          return {rate: value};
        }
        case 'openOptions': await E.call('runtime', 'openOptionsPage'); return {};
        case 'openDownloads': return mutate(async () => { await ensureRunner(true); return {}; });
        default: throw new Error('지원하지 않는 요청입니다.');
      }
    })().then(data => respond({ok: true, data})).catch(error => respond({ok: false, error: E.safeError(error)}));
    return true;
  });
})(globalThis);
