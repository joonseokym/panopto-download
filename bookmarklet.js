(async () => {
  'use strict';
  const base = '__BASE_URL__';
  const token = '__TOKEN__';
  if (location.protocol !== 'https:' || !location.hostname.endsWith('.panopto.com') ||
      !/^\/Panopto\/Pages\/(Viewer|Embed)\.aspx$/i.test(location.pathname)) {
    alert('Panopto 목록에서 영상을 연 다음 「Panopto 다운로드」를 실행해 주세요.');
    return;
  }
  const params = new URL(location.href).searchParams;
  const sessionId = [...params].find(([key]) => key.toLowerCase() === 'id')?.[1];
  if (!/^[0-9a-f-]{36}$/i.test(sessionId || '')) {
    alert('이 페이지에서 영상 ID를 찾을 수 없습니다.');
    return;
  }
  const target = `panopto-download-${Date.now()}`;
  let dashboard;
  let markReady;
  const ready = new Promise(resolve => { markReady = resolve; });
  const onReady = event => {
    if (event.origin === base && event.source === dashboard &&
        event.data?.type === 'panopto-download-ready') markReady(true);
  };
  window.addEventListener('message', onReady);
  const readyTimeout = setTimeout(() => markReady(false), 30000);
  dashboard = window.open(`${base}/#waiting&origin=${encodeURIComponent(location.origin)}`, target);
  if (!dashboard) {
    clearTimeout(readyTimeout);
    window.removeEventListener('message', onReady);
    alert('다운로드 창이 열리지 않았습니다. Safari에서 이 사이트의 팝업을 허용하고 다시 실행해 주세요.');
    return;
  }
  try {
    const response = await fetch('/Panopto/Pages/Viewer/DeliveryInfo.aspx', {
      method: 'POST',
      credentials: 'same-origin',
      body: new URLSearchParams({
        deliveryId: sessionId,
        responseType: 'json',
        isLiveNotes: 'false',
        isActiveBroadcast: 'false',
        isEditing: 'false',
        isEmbed: 'false',
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`영상 정보 요청 실패 (HTTP ${response.status}).`);
    const info = await response.json();
    const messages = {
      2: 'Panopto 로그인이 만료되었습니다. 다시 로그인해 주세요.',
      3: '이 영상을 볼 수 있는 권한이 없습니다.',
      4: '이 영상의 재생 파일이 아직 준비되지 않았습니다.',
      6: '영상 정보를 찾을 수 없습니다.',
      8: '현재 공개된 영상이 아닙니다.',
    };
    if (info.ErrorCode) throw new Error(messages[info.ErrorCode] || 'Panopto에서 영상 정보를 제공하지 않았습니다.');
    const delivery = info.Delivery;
    if (!delivery) throw new Error('영상 정보를 받지 못했습니다. 로그인 상태를 확인해 주세요.');
    if (delivery.IsActiveBroadcast) throw new Error('진행 중인 실시간 방송은 지원하지 않습니다. 녹화가 완료된 뒤 실행해 주세요.');
    const normalize = (value) => {
      if (typeof value !== 'string' || !value) return null;
      const url = new URL(value, location.origin);
      if (url.protocol !== 'https:' || url.username || url.password ||
          !(url.hostname === 'panopto.com' || url.hostname.endsWith('.panopto.com'))) return null;
      return url.href;
    };
    let streams = [];
    const official = normalize(info.DownloadUrl);
    if (official) {
      streams.push({url: official, name: '통합 영상'});
    } else {
      const seen = new Set();
      for (const stream of delivery.Streams || []) {
        const url = normalize(stream.StreamUrl);
        if (!url || seen.has(url)) continue;
        if (!/\.(m3u8|mp4|m4v|m4a|webm)(?:$|\?)/i.test(url)) continue;
        seen.add(url);
        streams.push({url, name: stream.StreamTypeName === 'Archival' ? '발표자' : `화면 ${streams.length + 1}`});
      }
    }
    if (!streams.length) throw new Error('저장할 수 있는 MP4 또는 HLS 재생 주소가 없습니다.');
    const payload = {
      title: delivery.SessionName || document.title || 'Panopto 영상',
      pageUrl: `${location.origin}${location.pathname}?id=${encodeURIComponent(sessionId)}`,
      duration: delivery.Duration,
      streams,
    };
    if (!await ready) throw new Error('로컬 서버에 연결하지 못했습니다. start.command를 실행하고 다시 시도해 주세요.');
    dashboard.postMessage({type: 'panopto-download', token, payload}, base);
  } catch (error) {
    dashboard.close();
    alert(error instanceof Error && error.name === 'TimeoutError'
      ? '영상 정보 요청 시간이 초과되었습니다. 다시 실행해 주세요.'
      : `다운로드를 시작하지 못했습니다.\n${error.message || '다시 시도해 주세요.'}`);
  } finally {
    clearTimeout(readyTimeout);
    window.removeEventListener('message', onReady);
  }
})();
