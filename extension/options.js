(async function () {
  'use strict';
  const E = globalThis.PanoptoExt, M = globalThis.PanoptoMedia, $ = id => document.getElementById(id);
  const canChooseDirectory = typeof globalThis.showDirectoryPicker === 'function';
  const hasDownloadsApi = Boolean(E.api?.downloads?.download);
  let selectedDirectory = false, pickedDirectory = null;
  function status(text, error = false) { $('status').textContent = text; $('status').className = `status${error ? ' error' : ''}`; }
  async function send(action, data = {}) {
    const response = await E.call('runtime', 'sendMessage', {action, ...data});
    if (!response?.ok) throw new Error(response?.error || '확장 기능에 연결하지 못했습니다.');
    return response.data;
  }
  function updateMode() {
    const directory = $('mode').value === 'directory';
    $('directoryField').hidden = !directory;
    $('subfolder').disabled = directory;
    $('askEveryTime').disabled = directory;
  }
  function safeSubfolder(value) {
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (/^[\/\\]|^[a-z]:/i.test(trimmed) || trimmed.includes('\\') || /[\x00-\x1f<>:"|?*]/.test(trimmed) || trimmed.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('하위 폴더는 Panopto/강의명 형식으로 입력해 주세요. 절대 경로와 ..는 사용할 수 없습니다.');
    return trimmed;
  }
  async function save() {
    const settings = {saveMode: $('mode').value, subfolder: safeSubfolder($('subfolder').value), askEveryTime: $('askEveryTime').checked, directoryName: selectedDirectory ? $('directoryName').textContent : ''};
    if (settings.saveMode === 'directory' && !selectedDirectory) throw new Error('저장할 폴더를 먼저 선택해 주세요.');
    const handle = settings.saveMode === 'directory' ? pickedDirectory : null;
    const previous = handle ? await M.getDirectory() : null;
    if (handle) await M.setDirectory(handle);
    let data;
    try { data = await send('configure', {settings}); }
    catch (error) { if (handle) await M.setDirectory(previous).catch(() => {}); throw error; }
    if (handle && pickedDirectory === handle) pickedDirectory = null;
    status(`설정을 저장했습니다. 저장 위치: ${data.outputDir || (settings.saveMode === 'directory' ? '직접 선택한 폴더' : '브라우저 다운로드 폴더')}`);
  }
  $('directoryOption').hidden = !canChooseDirectory;
  $('chromeSettings').hidden = !hasDownloadsApi;
  $('safariHint').hidden = hasDownloadsApi;
  $('mode').addEventListener('change', updateMode);
  $('form').addEventListener('submit', event => { event.preventDefault(); save().catch(error => status(E.safeError(error), true)); });
  $('chooseFolder').addEventListener('click', async () => {
    try {
      const handle = await globalThis.showDirectoryPicker({id: 'panopto-downloads', mode: 'readwrite', startIn: 'downloads'});
      const permission = await handle.requestPermission({mode: 'readwrite'});
      if (permission !== 'granted') throw new Error('선택한 폴더의 쓰기 권한을 허용해 주세요.');
      pickedDirectory = handle;
      selectedDirectory = true; $('directoryName').textContent = handle.name;
      status('폴더를 선택했습니다. 「설정 저장」을 누르면 적용됩니다.');
    } catch (error) { if (error.name !== 'AbortError') status(E.safeError(error), true); }
  });
  $('default').addEventListener('click', async () => {
    $('mode').value = 'browser'; $('subfolder').value = ''; $('askEveryTime').checked = false; updateMode();
    try { await save(); } catch (error) { status(E.safeError(error), true); }
  });
  $('downloads').addEventListener('click', event => { event.preventDefault(); send('openDownloads').catch(error => status(E.safeError(error), true)); });
  try {
    const data = await send('options'), settings = data.settings || {};
    $('mode').value = settings.saveMode === 'directory' && canChooseDirectory ? 'directory' : 'browser';
    $('subfolder').value = settings.subfolder || ''; $('askEveryTime').checked = Boolean(settings.askEveryTime);
    if (canChooseDirectory && typeof M?.getDirectory === 'function') {
      const handle = await M.getDirectory();
      selectedDirectory = Boolean(handle); $('directoryName').textContent = handle?.name || '아직 선택하지 않았습니다.';
    } else if ($('mode').value === 'directory') {
      selectedDirectory = true; $('directoryName').textContent = '이전에 선택한 폴더';
    }
    updateMode(); status(`저장 위치: ${data.outputDir || '브라우저 다운로드 폴더'}`);
  } catch (error) { status(E.safeError(error), true); }
})();
