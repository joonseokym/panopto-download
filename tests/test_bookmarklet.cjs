'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const source = readFileSync(new URL('../bookmarklet.js', `file://${__filename}`), 'utf8');
const pageUrl = 'https://kaist.ap.panopto.com/Panopto/Pages/Viewer.aspx?id=11111111-2222-4333-8444-555555555555';
async function run(info, url=pageUrl, options={}) {
  const state={alerts:[],requests:[],messages:[],opened:0,closed:0,listeners:new Set()};
  const location=new URL(url);
  const document={title:'강의',body:{append(){}},createElement(tag){
    throw new Error('Download data must use postMessage, never an insecure form.');
  }};
  const window={
    addEventListener(type,listener){state.listeners.add(listener);},
    removeEventListener(type,listener){state.listeners.delete(listener);},
    open(){
      state.opened++;
      if(options.blockPopup)return null;
      const popup={close(){state.closed++;},postMessage(data,origin){state.messages.push({data,origin});}};
      queueMicrotask(()=>{for(const listener of state.listeners)listener({origin:'__BASE_URL__',source:popup,data:{type:'panopto-download-ready'}});});
      return popup;
    },
  };
  await vm.runInNewContext(source,{
    location,document,window,URL,URLSearchParams,AbortSignal,Error,Date,setTimeout,clearTimeout,
    alert(message){state.alerts.push(message);},
    async fetch(url,request){state.requests.push({url,request});return {ok:true,json:async()=>info};},
  });
  state.payload=state.messages[0]?.data.payload;
  return state;
}
test('uses authenticated viewer metadata and messages only the minimum download metadata to the local origin',async()=>{
  const url='https://s-cloudfront.cdn.ap.panopto.com/video/master.m3u8?Policy=private';
  const state=await run({Delivery:{SessionName:'경제학 강의',Duration:120,Streams:[{StreamUrl:url,StreamTypeName:'Archival'},{StreamUrl:url},{StreamUrl:'https://s-cloudfront.cdn.ap.panopto.com/preview.jpg'}]}});
  assert.equal(state.requests.length,1);
  assert.equal(state.requests[0].request.credentials,'same-origin');
  assert.equal(state.requests[0].request.body.get('responseType'),'json');
  assert.equal(state.payload.title,'경제학 강의');
  assert.equal(state.payload.streams.length,1);
  assert.equal(state.payload.streams[0].url,url);
  assert.deepEqual(Object.keys(state.payload).sort(),['duration','pageUrl','streams','title']);
  assert.equal(state.messages[0].origin,'__BASE_URL__');
  assert.equal(state.messages[0].data.type,'panopto-download');
  assert.equal(state.listeners.size,0);
});
test('prefers the official combined download when provided',async()=>{
  const state=await run({DownloadUrl:'/Panopto/Podcast/Download.mp4',Delivery:{Streams:[{StreamUrl:'https://cdn.panopto.com/master.m3u8'}]}});
  assert.equal(state.payload.streams.length,1);
  assert.equal(state.payload.streams[0].name,'통합 영상');
  assert.equal(state.payload.streams[0].url,'https://kaist.ap.panopto.com/Panopto/Podcast/Download.mp4');
});
test('does not post credentials, unsupported URLs or external media hosts',async()=>{
  for(const url of ['http://cdn.panopto.com/a.mp4','https://panopto.com.evil.invalid/a.mp4','https://user:pass@cdn.panopto.com/a.mp4','file:///a.mp4']){
    const state=await run({Delivery:{Streams:[{StreamUrl:url}]}});
    assert.equal(state.messages.length,0);
    assert.equal(state.closed,1);
    assert.equal(state.alerts.length,1);
  }
});
test('explains login failures and refuses live broadcasts',async()=>{
  for(const info of [{ErrorCode:2},{Delivery:{IsActiveBroadcast:true}}]){
    const state=await run(info);
    assert.equal(state.messages.length,0);
    assert.equal(state.closed,1);
    assert.equal(state.alerts.length,1);
  }
});
test('running on a list or another site makes no request',async()=>{
  for(const url of ['https://kaist.ap.panopto.com/Panopto/Pages/Sessions/List.aspx','https://example.com/Panopto/Pages/Viewer.aspx?id=11111111-2222-4333-8444-555555555555']){
    const state=await run({},url);
    assert.equal(state.requests.length,0);
    assert.equal(state.opened,0);
    assert.equal(state.alerts.length,1);
  }
});
test('a blocked popup leaves the original page and gives a useful error',async()=>{
  const state=await run({},pageUrl,{blockPopup:true});
  assert.equal(state.requests.length,0);
  assert.match(state.alerts[0],/팝업/);
});
