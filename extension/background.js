'use strict';
if (typeof importScripts === 'function') importScripts('common.js');
(function (root) {
  const E = root.PanoptoExt || (typeof require === 'function' && require('./common.js'));
  const {TERMINAL, safeError} = E;
  class QueueEngine {
    constructor(io) { this.io = io; this.batches = []; this.config = {}; this.jobs = []; this.connection = {ok: false, error: ''}; this.busy = false; }
    init() {
      if (!this.ready) this.ready = (async () => {
        const saved = await this.io.read();
        this.config = saved.config || {};
        this.batches = Array.isArray(saved.batches) ? saved.batches : [];
        for (const batch of this.batches) for (const item of batch.items) if (item.status === 'submitting') {
          item.status = item.submissionPhase === 'helper' ? 'reconciling' : batch.cancelRequested ? 'cancelled' : 'pending';
        }
      })();
      return this.ready;
    }
    async save() { await this.io.write({config: this.config, batches: this.batches}); }
    requestId(batch, item) { return `${batch.id}:${item.id}:${item.attempt || 0}`; }
    async cancelRequest(batch, item) {
      let response;
      try { response = await this.request('/api/cancel-request', {method: 'POST', body: {requestId: this.requestId(batch, item)}}); }
      catch (error) {
        if (error.status === 404) throw new Error('접수 중인 작업을 안전하게 취소하려면 로컬 도우미를 최신 버전으로 다시 실행해 주세요.');
        throw error;
      }
      if (response?.ok !== true) throw new Error('로컬 도우미에서 작업 취소를 확인하지 못했습니다.');
      item.cancelAcknowledged = true; delete item.submissionPhase;
      if (response.job) {
        item.jobId = response.job.id; item.title = response.job.title || item.title;
        item.progress = Number(response.job.progress) || 0;
        item.status = TERMINAL.has(response.job.status) ? response.job.status : 'cancelling';
        item.error = response.job.error ? safeError(response.job.error) : null;
      } else { item.status = 'cancelled'; item.error = null; }
      await this.save();
    }
    async request(path, options) { return this.io.helper(path, this.config.token, options); }
    async connect() {
      await this.init();
      if (!this.config.token) throw new Error('확장 설정에서 로컬 도우미의 연결 토큰을 입력해 주세요.');
      const health = await this.request('/health');
      if (health.protocolVersion !== undefined && health.protocolVersion !== 1) throw new Error('로컬 도우미를 최신 버전으로 다시 실행해 주세요.');
      const settings = await this.request('/api/settings');
      this.connection = {ok: true, error: '', outputDir: settings.outputDir, defaultOutputDir: settings.defaultOutputDir};
      return settings;
    }
    async configure(token, outputDir) {
      await this.init();
      if (typeof token !== 'string' || !token.trim() || token.length > 256) throw new Error('로컬 도우미 화면의 연결 토큰을 입력해 주세요.');
      this.config.token = token.trim();
      await this.save();
      await this.connect();
      if (outputDir !== undefined) {
        const settings = await this.request('/api/settings', {method: 'POST', body: {outputDir}});
        this.connection = {...this.connection, ...settings};
      }
      return this.connection;
    }
    async start(tabId, kind) {
      await this.init();
      await this.connect();
      const tab = await this.io.tab(tabId), page = E.pageInfo(tab.url);
      if (!page || page.kind !== kind || (kind === 'folder' && !page.id)) throw new Error(kind === 'folder' ? '다운로드할 강의 폴더를 먼저 열어 주세요.' : '다운로드할 Panopto 영상을 먼저 열어 주세요.');
      const sessions = kind === 'video' ? [{id: page.id, title: tab.title || 'Panopto 영상'}] : await this.io.message(tabId, {action: 'enumerate', folderId: page.id});
      if (!Array.isArray(sessions) || !sessions.length) throw new Error('이 폴더에 다운로드할 영상이 없습니다.');
      const existing = new Map(this.batches.filter(b => b.origin === page.origin).flatMap(b => b.items.filter(i => !TERMINAL.has(i.status)).map(i => [i.id, b.id])));
      const items = [];
      for (const item of sessions) {
        const id = E.guid(item.id);
        if (!id) throw new Error('강의 목록에 올바르지 않은 영상 ID가 있습니다.');
        if (!existing.has(id) && !items.some(i => i.id === id)) items.push({id, title: String(item.title || 'Panopto 영상'), status: 'pending', progress: 0, error: null});
      }
      if (!items.length) return {batchId: existing.get(sessions[0].id), duplicate: true};
      const id = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      this.batches.push({id, origin: page.origin, tabId, folderId: kind === 'folder' ? page.id : null, title: kind === 'folder' ? '강의 폴더' : items[0].title, createdAt: Date.now(), blockedError: null, cancelRequested: false, items});
      // Retain a bounded history without dropping any active queue.
      const finished = this.batches.filter(b => b.items.every(i => TERMINAL.has(i.status)));
      for (const old of finished.slice(0, Math.max(0, finished.length - 30))) this.batches.splice(this.batches.indexOf(old), 1);
      await this.save();
      return {batchId: id, count: items.length, alreadyQueued: sessions.length - items.length};
    }
    async retry(batchId, tabId) {
      await this.init();
      const batch = this.batches.find(b => b.id === batchId);
      if (!batch) throw new Error('다운로드 기록을 찾을 수 없습니다.');
      const page = E.pageInfo((await this.io.tab(tabId)).url);
      if (!page || page.origin !== batch.origin) throw new Error('같은 Panopto 사이트에 로그인한 강의 탭을 열어 주세요.');
      batch.tabId = tabId; batch.blockedError = null; batch.cancelRequested = false;
      for (const item of batch.items) if (item.status === 'failed' || item.status === 'cancelled') { item.status = 'pending'; item.error = null; item.progress = 0; delete item.jobId; delete item.cancelAcknowledged; delete item.submissionPhase; item.attempt = (item.attempt || 0) + 1; }
      await this.save();
    }
    async cancel(batchId) {
      await this.init();
      const batch = this.batches.find(b => b.id === batchId);
      if (!batch) return;
      batch.blockedError = null; batch.cancelRequested = true;
      for (const item of batch.items) {
        if (item.status === 'pending' || item.status === 'submitting') item.status = item.submissionPhase === 'helper' && !item.jobId ? 'reconciling' : 'cancelled';
      }
      await this.save();
      for (const item of batch.items) if (!TERMINAL.has(item.status)) {
        if (!item.jobId && item.status === 'reconciling') await this.cancelRequest(batch, item);
        else if (item.jobId) {
          await this.request(`/api/jobs/${encodeURIComponent(item.jobId)}/cancel`, {method: 'POST', body: {}});
          item.status = 'cancelling';
        }
      }
      await this.save();
    }
    async tick() {
      await this.init();
      if (this.busy || !this.config.token) return;
      this.busy = true;
      try {
        const result = await this.request('/api/jobs');
        if (!Array.isArray(result.jobs)) throw new Error('로컬 도우미의 작업 목록 응답이 올바르지 않습니다. 최신 버전으로 다시 실행해 주세요.');
        this.jobs = result.jobs;
        this.connection.ok = true; this.connection.error = '';
        const jobs = new Map(this.jobs.map(job => [job.id, job]));
        const requests = new Map(this.jobs.filter(job => job.requestId).map(job => [job.requestId, job]));
        for (const batch of this.batches) for (const item of batch.items) {
          if (!item.jobId && item.status === 'reconciling') {
            const recovered = requests.get(this.requestId(batch, item));
            if (recovered) item.jobId = recovered.id;
            else if (!batch.cancelRequested) item.status = 'pending';
          }
          if (item.jobId && !TERMINAL.has(item.status)) {
            const job = jobs.get(item.jobId);
            if (job) { item.status = job.status; item.progress = Number(job.progress) || 0; item.error = job.error ? safeError(job.error) : null; }
            else { item.status = 'failed'; item.error = '로컬 도우미에서 작업을 찾지 못했습니다. 도우미를 다시 실행했다면 재시도해 주세요.'; }
          }
        }
        let active = this.jobs.filter(job => !TERMINAL.has(job.status)).length;
        for (const batch of this.batches) {
          if (batch.blockedError) continue;
          if (batch.cancelRequested) {
            for (const item of batch.items) if (!TERMINAL.has(item.status)) {
              if (!item.jobId && item.status === 'reconciling') await this.cancelRequest(batch, item);
              else if (item.jobId) {
                await this.request(`/api/jobs/${encodeURIComponent(item.jobId)}/cancel`, {method: 'POST', body: {}});
                item.status = 'cancelling';
              }
            }
            continue;
          }
          for (const item of batch.items) {
            if (item.status !== 'pending' || active >= 20) continue;
            let tab;
            try { tab = await this.io.tab(batch.tabId); } catch (_) { batch.blockedError = '강의 탭이 닫혔습니다. 같은 사이트의 강의 탭을 열고 「현재 탭에서 재시도」를 눌러 주세요.'; break; }
            const page = E.pageInfo(tab.url);
            if (!page || page.origin !== batch.origin) { batch.blockedError = '강의 탭이 다른 사이트로 이동했습니다. 같은 Panopto 사이트의 강의 탭에서 재시도해 주세요.'; break; }
            try {
              item.status = 'submitting'; item.submissionPhase = 'metadata'; await this.save();
              const metadata = await this.io.message(batch.tabId, {action: 'metadata', sessionId: item.id});
              if (batch.cancelRequested) { item.status = 'cancelled'; await this.save(); continue; }
              // Revalidate across the content/background boundary before contacting the helper.
              const canonical = E.pageInfo(metadata?.pageUrl);
              if (!canonical || canonical.origin !== batch.origin || canonical.id !== item.id || !Array.isArray(metadata.streams) || !metadata.streams.length || metadata.streams.some(s => !E.streamUrl(s.url, batch.origin))) throw new Error('영상 정보를 검증하지 못했습니다.');
              item.submissionPhase = 'helper'; await this.save();
              if (batch.cancelRequested) { item.status = 'cancelled'; delete item.submissionPhase; await this.save(); continue; }
              const job = await this.request('/api/jobs', {method: 'POST', body: {...metadata, requestId: this.requestId(batch, item)}});
              if (batch.cancelRequested && item.cancelAcknowledged) { item.jobId = job.id; await this.save(); continue; }
              item.jobId = job.id; item.title = job.title || metadata.title; item.status = job.status || 'queued'; item.progress = job.progress || 0; item.error = null;
              delete item.submissionPhase;
              if (batch.cancelRequested && !TERMINAL.has(item.status)) {
                item.status = 'cancelling';
                await this.request(`/api/jobs/${encodeURIComponent(item.jobId)}/cancel`, {method: 'POST', body: {}});
              }
              active++;
              await this.save();
            } catch (error) {
              if (batch.cancelRequested && item.cancelAcknowledged) { await this.save(); continue; }
              if (batch.cancelRequested && item.submissionPhase !== 'helper' && !item.jobId) { item.status = 'cancelled'; delete item.submissionPhase; await this.save(); continue; }
              if (batch.cancelRequested && error.status === 409 && item.submissionPhase === 'helper') { await this.cancelRequest(batch, item); continue; }
              if (error.status === 429) { item.status = batch.cancelRequested ? 'cancelled' : 'pending'; delete item.submissionPhase; await this.save(); return; }
              if (error.helperUnavailable || error.status === 401) {
                if (item.jobId) item.status = batch.cancelRequested ? 'cancelling' : 'queued';
                else item.status = item.submissionPhase === 'helper' && error.status !== 401 ? 'reconciling' : batch.cancelRequested ? 'cancelled' : 'pending';
                await this.save(); throw error;
              }
              item.status = 'failed'; item.error = safeError(error); await this.save();
            }
          }
        }
        await this.save();
      } catch (error) { this.connection = {...this.connection, ok: false, error: safeError(error)}; }
      finally { this.busy = false; }
    }
    snapshot() { return {configured: Boolean(this.config.token), connection: this.connection, batches: this.batches}; }
  }
  root.PanoptoQueueEngine = QueueEngine;
  if (typeof module !== 'undefined' && module.exports) { module.exports = {QueueEngine}; return; }
  const engine = new QueueEngine({
    read: () => E.call('storage', 'get', ['config', 'batches']),
    write: value => E.call('storage', 'set', value),
    tab: id => E.call('tabs', 'get', id),
    message: async (id, message) => {
      let response;
      try { response = await E.call('tabs', 'sendMessage', id, message); }
      catch (_) { throw new Error('강의 페이지의 확장 기능에 연결할 수 없습니다. 해당 탭을 새로고침하고 재시도해 주세요.'); }
      if (!response?.ok) throw new Error(response?.error || '강의 페이지에서 응답하지 않았습니다.');
      return response.data;
    },
    helper: async (path, token, options = {}) => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
      try {
        const response = await fetch(E.HELPER + path, {method: options.method || 'GET', signal: controller.signal,
          headers: {'X-Panopto-Token': token || '', ...(options.body !== undefined ? {'Content-Type': 'application/json'} : {})},
          ...(options.body !== undefined ? {body: JSON.stringify(options.body)} : {})});
        const data = await response.json();
        if (!response.ok) { const error = new Error(response.status === 401 ? '연결 토큰이 올바르지 않습니다. 확장 설정에서 다시 저장해 주세요.' : data.error || `도우미 요청 실패 (${response.status})`); error.status = response.status; throw error; }
        return data;
      } catch (error) {
        if (error.status) throw error;
        const unavailable = new Error('로컬 도우미에 연결할 수 없습니다. start.command를 실행해 주세요.'); unavailable.helperUnavailable = true; throw unavailable;
      } finally { clearTimeout(timer); }
    }
  });
  let pumpTimer;
  function trigger() {
    engine.tick().finally(() => {
      clearTimeout(pumpTimer);
      if (engine.batches.some(b => b.items.some(i => !TERMINAL.has(i.status)))) pumpTimer = setTimeout(trigger, 4000);
    });
  }
  E.api.runtime.onMessage.addListener((message, sender, respond) => {
    const fromContent = Boolean(sender.tab) && !sender.url?.startsWith(E.api.runtime.getURL(''));
    if (sender.id !== E.api.runtime.id || !message || typeof message.action !== 'string') return;
    if (fromContent && (!E.pageInfo(sender.tab.url) || !['state', 'startVideo', 'startFolder', 'setRate', 'cancel', 'retry', 'openOptions'].includes(message.action))) return;
    (async () => {
      await engine.init();
      const tabId = fromContent ? sender.tab.id : message.tabId;
      switch (message.action) {
        case 'state': trigger(); return engine.snapshot();
        case 'startVideo': { const result = await engine.start(tabId, 'video'); trigger(); return result; }
        case 'startFolder': { const result = await engine.start(tabId, 'folder'); trigger(); return result; }
        case 'cancel': await engine.cancel(message.batchId); trigger(); return {};
        case 'retry': await engine.retry(message.batchId, tabId); trigger(); return {};
        case 'setRate': {
          const value = E.rate(message.rate);
          await E.call('storage', 'set', {playbackRate: value});
          if (!fromContent && tabId) await E.call('tabs', 'sendMessage', tabId, {action: 'rate', rate: value});
          return {rate: value};
        }
        case 'options': return {token: engine.config.token || '', ...await engine.connect().catch(error => ({outputDir: engine.connection.outputDir || '~/Downloads', error: safeError(error)}))};
        case 'configure': { const result = await engine.configure(message.token, message.outputDir); trigger(); return result; }
        case 'connect': return await engine.connect();
        case 'openOptions': await E.call('runtime', 'openOptionsPage'); return {};
        default: throw new Error('지원하지 않는 요청입니다.');
      }
    })().then(data => respond({ok: true, data})).catch(error => respond({ok: false, error: safeError(error)}));
    return true;
  });
  E.api.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'panopto-queue') trigger(); });
  E.api.runtime.onStartup.addListener(trigger);
  E.api.runtime.onInstalled.addListener(() => { E.api.alarms.create('panopto-queue', {periodInMinutes: 0.5}); trigger(); });
  E.api.alarms.create('panopto-queue', {periodInMinutes: 0.5});
  trigger();
})(globalThis);
