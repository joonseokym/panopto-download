(function (root) {
  'use strict';
  const E = root.PanoptoExt || (typeof require === 'function' && require('./common.js'));
  const TERMINAL = new Set(['completed', 'handedOff', 'failed', 'cancelled', 'interrupted']);
  const DEFAULT_SETTINGS = {saveMode: 'browser', subfolder: '', askEveryTime: false};
  function settings(value = {}) {
    const subfolder = String(value.subfolder || '').trim();
    if (subfolder.length > 200 || subfolder.startsWith('/') || /[\\:\x00-\x1f]/.test(subfolder) || subfolder.split('/').some(part => part === '.' || part === '..')) throw new Error('다운로드 폴더 안의 하위 폴더 이름만 입력해 주세요.');
    return {saveMode: value.saveMode === 'directory' ? 'directory' : 'browser', subfolder, askEveryTime: Boolean(value.askEveryTime), ...(value.directoryName ? {directoryName: String(value.directoryName).slice(0, 200)} : {})};
  }
  function storedBatches(value) {
    if (!Array.isArray(value)) return [];
    return value.filter(batch => batch && typeof batch.id === 'string' && E.pageInfo(`${batch.origin}/Panopto/Pages/Viewer.aspx?id=11111111-1111-4111-8111-111111111111`) && Array.isArray(batch.items)).map(batch => ({
      id: batch.id.slice(0, 100), origin: batch.origin, tabId: Number.isInteger(batch.tabId) ? batch.tabId : null,
      folderId: E.guid(batch.folderId), title: String(batch.title || 'Panopto 영상').slice(0, 500),
      createdAt: Number(batch.createdAt) || Date.now(), blockedError: batch.blockedError ? E.safeError(batch.blockedError) : null,
      cancelRequested: Boolean(batch.cancelRequested),
      items: batch.items.filter(item => E.guid(item?.id)).map(item => ({id: E.guid(item.id), title: String(item.title || 'Panopto 영상').slice(0, 500),
        status: TERMINAL.has(item.status) ? item.status : 'interrupted', progress: Math.max(0, Math.min(100, Number(item.progress) || 0)),
        error: TERMINAL.has(item.status) ? item.error ? E.safeError(item.error) : null : '다운로드 작업 탭이 닫혀 작업이 중단되었습니다. 다시 시도하면 처음부터 받습니다.',
        ...(Array.isArray(item.files) ? {files: item.files.map(file => ({name: String(file.name || '').slice(0, 300), size: Math.max(0, Number(file.size) || 0)}))} : {})}))
    }));
  }
  class QueueEngine {
    constructor(io) { this.io = io; this.batches = []; this.settings = {...DEFAULT_SETTINGS}; this.busy = false; this.active = null; this.writes = Promise.resolve(); this.starts = Promise.resolve(); this.lastProgressSave = 0; }
    init() {
      if (!this.ready) this.ready = (async () => {
        const saved = await this.io.read();
        this.settings = settings(saved.standaloneSettings);
        this.batches = storedBatches(saved.standaloneBatches);
        if (this.io.migrate) await this.io.migrate();
        await this.save();
      })();
      return this.ready;
    }
    save() {
      // Signed media addresses live only in the current download call.
      const value = JSON.parse(JSON.stringify({standaloneSettings: this.settings, standaloneBatches: this.batches}));
      const writing = this.writes.catch(() => {}).then(() => this.io.write(value));
      this.writes = writing; return writing;
    }
    async configure(value) { await this.init(); this.settings = settings({...this.settings, ...value}); await this.save(); return {...this.settings, outputDir: this.outputDir()}; }
    outputDir() { return this.settings.saveMode === 'directory' ? (this.settings.directoryName || '선택한 폴더') : `브라우저 다운로드 폴더${this.settings.subfolder ? ` / ${this.settings.subfolder}` : ''}`; }
    snapshot() { return {configured: true, connection: {ok: true, outputDir: this.outputDir(), error: ''}, settings: {...this.settings}, batches: this.batches, runnerOpen: true}; }
    start(tabId, kind) {
      const started = this.starts.catch(() => {}).then(() => this.enqueue(tabId, kind));
      this.starts = started; return started;
    }
    async enqueue(tabId, kind) {
      await this.init();
      const tab = await this.io.tab(tabId), page = E.pageInfo(tab.url);
      if (!page || page.kind !== kind || !page.id) throw new Error(kind === 'folder' ? '다운로드할 강의 폴더를 먼저 열어 주세요.' : '다운로드할 Panopto 영상을 먼저 열어 주세요.');
      const sessions = kind === 'video' ? [{id: page.id, title: tab.title || 'Panopto 영상'}] : await this.io.message(tabId, {action: 'enumerate', folderId: page.id});
      if (!Array.isArray(sessions) || !sessions.length) throw new Error('이 폴더에 다운로드할 영상이 없습니다.');
      const existing = new Map(this.batches.filter(batch => batch.origin === page.origin).flatMap(batch => batch.items.filter(item => !TERMINAL.has(item.status)).map(item => [item.id, batch.id])));
      const items = [];
      for (const session of sessions) {
        const id = E.guid(session.id);
        if (!id) throw new Error('강의 목록에 올바르지 않은 영상 ID가 있습니다.');
        if (!existing.has(id) && !items.some(item => item.id === id)) items.push({id, title: String(session.title || 'Panopto 영상').slice(0, 500), status: 'pending', progress: 0, error: null});
      }
      if (!items.length) return {batchId: existing.get(E.guid(sessions[0].id)), duplicate: true};
      const id = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      this.batches.push({id, origin: page.origin, tabId, folderId: kind === 'folder' ? page.id : null, title: kind === 'folder' ? tab.title || '강의 폴더' : items[0].title, createdAt: Date.now(), blockedError: null, cancelRequested: false, items});
      const finished = this.batches.filter(batch => batch.items.every(item => TERMINAL.has(item.status)));
      for (const old of finished.slice(0, Math.max(0, finished.length - 30))) this.batches.splice(this.batches.indexOf(old), 1);
      await this.save(); return {batchId: id, count: items.length, alreadyQueued: sessions.length - items.length};
    }
    async retry(batchId, tabId) {
      await this.init();
      const batch = this.batches.find(batch => batch.id === batchId);
      if (!batch) throw new Error('다운로드 기록을 찾을 수 없습니다.');
      const page = E.pageInfo((await this.io.tab(tabId)).url);
      if (!page || page.origin !== batch.origin) throw new Error('같은 Panopto 사이트에 로그인한 강의 탭을 열어 주세요.');
      batch.tabId = tabId; batch.blockedError = null; batch.cancelRequested = false;
      const existing = new Set(this.batches.filter(other => other !== batch && other.origin === batch.origin).flatMap(other => other.items.filter(item => !TERMINAL.has(item.status)).map(item => item.id)));
      for (const item of batch.items) if (['failed', 'cancelled', 'interrupted'].includes(item.status)) {
        if (existing.has(item.id)) continue;
        item.status = 'pending'; item.error = null; item.progress = 0; delete item.files;
      }
      await this.save(); return {};
    }
    async cancel(batchId) {
      await this.init();
      const batch = this.batches.find(batch => batch.id === batchId);
      if (!batch) return;
      batch.cancelRequested = true; batch.blockedError = null;
      for (const item of batch.items) {
        if (item.status === 'pending') item.status = 'cancelled';
        else if (!TERMINAL.has(item.status)) item.status = 'cancelling';
      }
      if (this.active?.batch === batch) this.active.controller.abort();
      await this.save();
    }
    async tick() {
      await this.init(); if (this.busy) return;
      this.busy = true;
      try {
        while (true) {
          const batch = this.batches.find(batch => !batch.cancelRequested && !batch.blockedError && batch.items.some(item => item.status === 'pending'));
          if (!batch) break;
          const item = batch.items.find(item => item.status === 'pending');
          let tab;
          try { tab = await this.io.tab(batch.tabId); }
          catch (_) { batch.blockedError = '강의 탭이 닫혔습니다. 같은 사이트의 강의 탭을 열고 재시도해 주세요.'; await this.save(); continue; }
          const page = E.pageInfo(tab.url);
          if (!page || page.origin !== batch.origin) { batch.blockedError = '강의 탭이 다른 사이트로 이동했습니다. 같은 Panopto 사이트의 강의 탭에서 재시도해 주세요.'; await this.save(); continue; }
          const controller = new AbortController(); this.active = {batch, item, controller};
          item.status = 'preparing'; await this.save();
          try {
            const metadata = await this.io.message(batch.tabId, {action: 'metadata', sessionId: item.id});
            if (batch.cancelRequested || controller.signal.aborted) { item.status = 'cancelled'; continue; }
            const canonical = E.pageInfo(metadata?.pageUrl);
            if (!canonical || canonical.origin !== batch.origin || canonical.id !== item.id || !Array.isArray(metadata.streams) || !metadata.streams.length || metadata.streams.some(stream => !E.streamUrl(stream.url, batch.origin))) throw new Error('영상 정보를 검증하지 못했습니다.');
            item.title = String(metadata.title || item.title).slice(0, 500); item.status = 'downloading'; await this.save();
            const result = await this.io.download(metadata, {signal: controller.signal, settings: {...this.settings}, onProgress: event => {
              if (controller.signal.aborted) return;
              item.progress = Math.max(0, Math.min(100, Number(event.progress) || 0));
              item.status = event.phase === 'saving' ? 'saving' : 'downloading';
              if (Date.now() - this.lastProgressSave > 1000) { this.lastProgressSave = Date.now(); this.save().catch(() => {}); }
            }});
            if (!result || !Array.isArray(result.files) || !result.files.length) throw new Error('저장된 파일 정보를 받지 못했습니다.');
            item.files = result.files.map(file => ({name: String(file.name || '').slice(0, 300), size: Math.max(0, Number(file.size) || 0)}));
            item.status = result.handoff ? 'handedOff' : 'completed'; item.progress = 100; item.error = null;
          } catch (error) {
            item.status = controller.signal.aborted || batch.cancelRequested ? 'cancelled' : 'failed';
            item.error = item.status === 'cancelled' ? null : E.safeError(error);
          } finally { this.active = null; await this.save(); }
        }
      } finally { this.busy = false; }
    }
  }
  root.PanoptoQueueEngine = QueueEngine;
  if (typeof module !== 'undefined' && module.exports) module.exports = {QueueEngine, settings, storedBatches};
})(typeof globalThis !== 'undefined' ? globalThis : this);
