(async function () {
  'use strict';
  const E = globalThis.PanoptoExt, $ = id => document.getElementById(id);
  let defaultOutput = '~/Downloads';
  function status(text, error = false) { $('status').textContent = text; $('status').className = `status${error ? ' error' : ''}`; }
  async function send(action, data = {}) {
    const response = await E.call('runtime', 'sendMessage', {action, ...data});
    if (!response?.ok) throw new Error(response?.error || '확장 기능에 연결하지 못했습니다.');
    return response.data;
  }
  async function configure(savePath) {
    const buttons = document.querySelectorAll('button'); buttons.forEach(button => { button.disabled = true; });
    status('로컬 도우미 연결을 확인하고 있습니다…');
    try {
      const data = await send('configure', {token: $('token').value, ...(savePath ? {outputDir: $('output').value.trim() || '~/Downloads'} : {})});
      $('output').value = data.outputDir; defaultOutput = data.defaultOutputDir || '~/Downloads';
      status(`${savePath ? '설정을 저장했습니다.' : '연결되었습니다.'} 저장 위치: ${data.outputDir}`);
    } catch (error) { status(E.safeError(error), true); }
    finally { buttons.forEach(button => { button.disabled = false; }); }
  }
  $('dashboard').href = E.HELPER;
  $('form').addEventListener('submit', event => { event.preventDefault(); configure(true); });
  $('test').addEventListener('click', () => configure(false));
  $('default').addEventListener('click', () => { $('output').value = defaultOutput; status('기본 다운로드 폴더를 선택했습니다. 「저장 · 연결」을 누르면 적용됩니다.'); });
  $('reveal').addEventListener('click', () => { const hidden = $('token').type === 'password'; $('token').type = hidden ? 'text' : 'password'; $('reveal').textContent = hidden ? '숨기기' : '보기'; });
  try {
    const data = await send('options'); $('token').value = data.token; $('output').value = data.outputDir || '~/Downloads'; defaultOutput = data.defaultOutputDir || '~/Downloads';
    status(data.error || (data.token ? '로컬 도우미에 연결되었습니다.' : '연결 토큰을 입력해 주세요.'), Boolean(data.error));
  } catch (error) { status(E.safeError(error), true); }
})();
