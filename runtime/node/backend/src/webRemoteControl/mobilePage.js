'use strict';

/**
 * mobilePage.js — 手机侧单页（由本服务直出，免安装、无外部资源）。
 *
 * 文案真源：apps/khyos-desktop/zcode-analysis/i18n-zh.json 的 webRemoteControl.*
 * （ZCode 1:1 复刻件），凡原案缺「目标 + 进度」的（规则 2）在本页补齐。
 * 渲染一律走 textContent —— 模型输出与工具结果是不可信文本，不拼 innerHTML。
 */

const COPY = {
  title: '移动端远程控制',
  connecting: '正在连接桌面端 · {url}',
  pairPending: '等待桌面端确认配对 · 设备 {name}（10 分钟内有效）',
  waiting: '等待手机连接 · 请用手机扫码或打开链接',
  active: '手机已连接 · 角色 {role}，已接收 {count} 条事件',
  tasks: '任务列表',
  tasksLoading: '正在读取任务列表（第 {attempt} 次）',
  noTasks: '当前桌面窗口没有可展示的任务',
  backToTasks: '返回任务列表',
  inputPlaceholder: '发消息给桌面端…',
  send: '发送',
  sendDisabledHint: '当前是 viewer 角色，只能查看；需要发消息请在桌面端设备列表改为 operator',
  sending: '已发送 · 等待模型回复',
  toolCall: '工具 {name} 执行中',
  toolResult: '工具 {name} 返回',
  reconnecting: '正在自动重连… 第 {attempt}/{max} 次',
  stopped: '桌面端已断开，远程控制结束。',
  approve: '同意',
  deny: '拒绝',
  controlTitle: '桌面端请求批准工具调用',
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function renderMobilePage(opts = {}) {
  const heartbeatMs = Number(opts.heartbeatIntervalMs) > 0 ? Number(opts.heartbeatIntervalMs) : 10000;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<title>${esc(COPY.title)}</title>
<style>
:root{--bg:#181818;--fg:#e6e6e6;--mut:#8a8a8a;--line:#2c2c2c;--brand:#4c8dff;--card:#202020}
@media(prefers-color-scheme:light){:root{--bg:#fff;--fg:#1a1a1a;--mut:#6b6b6b;--line:#e5e5e5;--card:#f6f6f6}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 14px;display:flex;gap:8px;align-items:center;z-index:5}
header b{font-size:15px}
#status{margin-left:auto;font-size:12px;color:var(--mut);text-align:right;max-width:60%}
main{padding:12px 14px 96px}
.row{padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:var(--card);margin-bottom:8px}
.row small{display:block;color:var(--mut);font-size:12px;margin-top:3px}
button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:8px;padding:7px 12px}
button.primary{background:var(--brand);border-color:var(--brand);color:#fff}
footer{position:fixed;bottom:0;left:0;right:0;background:var(--bg);border-top:1px solid var(--line);padding:10px 14px;display:flex;gap:8px}
footer input{flex:1;min-width:0;background:var(--card);border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:10px}
.msg{white-space:pre-wrap;word-break:break-word;padding:9px 11px;border-left:2px solid var(--line);margin:0 0 8px}
.msg.user{border-left-color:var(--brand)}
.msg.tool{color:var(--mut);font-size:13px}
.err{color:#ff7b72;font-size:13px;padding:9px 11px;border-left:2px solid #ff7b72}
.hide{display:none}
</style>
</head>
<body>
<header><b id="hdr">${esc(COPY.title)}</b><span id="status">${esc(COPY.waiting)}</span></header>
<main><div id="view"></div></main>
<footer class="hide" id="bar">
  <input id="box" placeholder="${esc(COPY.inputPlaceholder)}" autocomplete="off">
  <button class="primary" id="send">${esc(COPY.send)}</button>
</footer>
<script>
(function(){
var COPY=${JSON.stringify(COPY)};
var HB=${heartbeatMs};
var ws=null,token=sessionStorage.getItem('khywr.token')||'',role=null,seq=0,events=0,paired=false;
var attempt=0,MAX_ATTEMPT=20;
var view=document.getElementById('view'),bar=document.getElementById('bar'),box=document.getElementById('box');
var statusEl=document.getElementById('status');
function st(t){statusEl.textContent=t}
function el(tag,cls,txt){var n=document.createElement(tag);if(cls)n.className=cls;if(txt!=null)n.textContent=txt;return n}
function clear(){while(view.firstChild)view.removeChild(view.firstChild)}
function pairCode(){var m=/[?&]p=([A-Za-z0-9]+)/.exec(location.hash.slice(1)||location.hash);if(m)return m[1].toUpperCase();var h=location.hash.replace(/^#/,'');var q=/p=([A-Za-z0-9]+)/.exec(h);return q?q[1].toUpperCase():''}
function deviceName(){var ua=navigator.userAgent;var m=/((?:iPhone|iPad|Android|HarmonyOS|Macintosh|Windows)[^;)]*)/i.exec(ua);return (m?m[1]:'手机').slice(0,48)}
function send(o){if(ws&&ws.readyState===1){o.requestId=o.requestId||('r'+(++seq));ws.send(JSON.stringify(o));return true}return false}
function connect(){
  var proto=location.protocol==='https:'?'wss:':'ws:';
  st(COPY.connecting.replace('{url}',location.host));
  ws=new WebSocket(proto+'//'+location.host+'/r/ws');
  ws.onopen=function(){attempt=0;send({khy_type:'khy_bootstrap_request',token:token||undefined,pairCode:token?undefined:pairCode(),theme:matchMedia('(prefers-color-scheme: light)').matches?'light':'dark',deviceInfo:{name:deviceName(),ua:navigator.userAgent.slice(0,160)}})};
  ws.onmessage=function(e){var m;try{m=JSON.parse(e.data)}catch(x){return};handle(m)};
  ws.onclose=function(){
    // 这一轮连接从没拿到过 bootstrap_response 却揣着 token ⇒ token 已作废
    // （桌面端重启或刷新过二维码）。不清掉就会拿着它无限重连。
    if(!paired&&token&&pairCode()){token='';sessionStorage.removeItem('khywr.token')}
    if(attempt++>=MAX_ATTEMPT){st(COPY.stopped);return}
    st(COPY.reconnecting.replace('{attempt}',attempt).replace('{max}',MAX_ATTEMPT));
    setTimeout(connect,Math.min(1000*attempt,8000));
  };
}
setInterval(function(){send({khy_type:'khy_heartbeat',client_ts:Date.now()})},HB);
function handle(m){
  if(m.type==='khy_error'){
    var d=el('div','err',m.message||('错误 '+m.code));clear();view.appendChild(d);
    // 旧 token 作废（桌面端重启或刷新过二维码）时清掉它，让 onclose 的自动重连
    // 改用链接里的配对码重新申请——否则手机页会永远停在失效凭据上。
    if((m.code==='SESSION_EXPIRED'||m.code==='SESSION_NOT_FOUND'||m.code==='KICKED')&&pairCode()){
      token='';sessionStorage.removeItem('khywr.token');
    }
    return
  }
  if(m.type==='khy_pair_pending'){st(COPY.pairPending.replace('{name}',deviceName()));return}
  if(m.type==='khy_bootstrap_response'){
    if(!m.ok)return;
    paired=true;
    role=m.result&&m.result.role;token=m.result&&m.result.token||token;
    if(m.result&&m.result.token)sessionStorage.setItem('khywr.token',m.result.token);
    st(COPY.active.replace('{role}',role||'-').replace('{count}',events));
    bar.classList.remove('hide');
    if(role!=='operator'){box.disabled=true;box.placeholder=COPY.sendDisabledHint;document.getElementById('send').disabled=true}
    // bootstrap 只带工作区，任务列表另发一帧（与桌面端同一 RPC，避免两条真源）。
    send({khy_type:'khy_task_list_request'});return;
  }
  if(m.type==='khy_task_list_response'){showTasks(m.result);return}
  if(m.type==='khy_session_messages_response'){showSession(m.result);return}
  if(m.type==='khy_stream'){onStream(m.event);return}
  if(m.type==='khy_control_request'){onControl(m);return}
}
function showTasks(list){
  clear();var head=el('div','row');head.appendChild(el('b',null,COPY.tasks));
  var back=el('button',null,COPY.backToTasks);back.style.marginLeft='8px';back.onclick=function(){send({khy_type:'khy_task_list_request'})};
  head.appendChild(back);view.appendChild(head);
  if(!list||!list.length){view.appendChild(el('div','row',COPY.noTasks));return}
  list.forEach(function(t){
    var r=el('div','row');
    // 会话真源的 title 常是 '(untitled)'，人话在 firstUserMessage —— 与桌面侧栏同一回退顺序。
    var label=(t.title&&t.title!=='(untitled)')?t.title:(t.firstUserMessage||t.sessionId||'未命名任务');
    var b=el('button','primary',String(label).slice(0,60));
    b.onclick=function(){window.__sid=t.sessionId;send({khy_type:'khy_session_messages_request',sessionId:t.sessionId})};
    r.appendChild(b);r.appendChild(el('small',null,(t.updatedAt?new Date(t.updatedAt).toLocaleString():'')+' · '+(t.sessionId||'')));
    view.appendChild(r);
  });
}
function showSession(s){
  clear();if(!s)return;
  (s.messages||[]).forEach(function(msg){
    var txt=typeof msg.content==='string'?msg.content:(msg.content&&msg.content.text)||JSON.stringify(msg.content||'');
    view.appendChild(el('div','msg '+(msg.role==='user'?'user':''),(msg.role==='user'?'我：':'AI：')+txt));
  });
  var live=el('div','msg');live.id='live';view.appendChild(live);
}
function onStream(ev){
  events++;var live=document.getElementById('live');
  if(!live){clear();live=el('div','msg');live.id='live';view.appendChild(live)}
  if(ev.kind==='chunk'){live.textContent+=ev.text||''}
  else if(ev.kind==='tool_call'){view.appendChild(el('div','msg tool',COPY.toolCall.replace('{name}',ev.tool||'?')));view.appendChild(live)}
  else if(ev.kind==='tool_result'){view.appendChild(el('div','msg tool',COPY.toolResult.replace('{name}',ev.tool||'?')));view.appendChild(live)}
  else if(ev.kind==='end'){document.getElementById('status').textContent=COPY.active.replace('{role}',role||'-').replace('{count}',events)}
}
function onControl(m){
  var r=el('div','row');r.appendChild(el('b',null,COPY.controlTitle));
  r.appendChild(el('small',null,(m.request&&(m.request.tool_name||m.request.toolName)||'工具')+' · '+JSON.stringify((m.request&&m.request.input)||{}).slice(0,180)));
  var ok=el('button','primary',COPY.approve),no=el('button',null,COPY.deny);
  ok.onclick=function(){send({khy_type:'khy_control_response',requestId:m.requestId,response:{behavior:'allow'}});r.remove()};
  no.onclick=function(){send({khy_type:'khy_control_response',requestId:m.requestId,response:{behavior:'deny'}});r.remove()};
  r.appendChild(ok);r.appendChild(no);view.appendChild(r);
}
document.getElementById('send').onclick=function(){
  var v=box.value.trim();if(!v)return;
  box.value='';
  view.appendChild(el('div','msg user','我：'+v));
  st(COPY.sending);
  send({khy_type:'khy_session_send_request',sessionId:(window.__sid||undefined),text:v});
};
box.onkeydown=function(e){if(e.key==='Enter'){e.preventDefault();document.getElementById('send').click()}};
connect();
})();
</script>
</body>
</html>`;
}

module.exports = { renderMobilePage, COPY };
