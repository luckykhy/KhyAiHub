#!/usr/bin/env node
/**
 * 采集「真实运行」图片证据：终端会话截图 + 界面截图。
 *
 * 两条纪律：
 * 1. **绝不摆拍**——终端图里的每个字符都是子进程真实 stdout（含 ANSI 颜色），
 *    界面图是本地静态站真实渲染结果。渲染方式在清单里如实写明。
 * 2. **绝不出呼**——只跑只读、离线的命令；任何会走 AI 网关（外呼 + 计费）的命令不采集。
 *
 * 重跑：node scripts/evidence/capture-runtime.js
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const IMG_ROOT = path.join(REPO, 'evidence', '03_图片');
const SRC_DIR = path.join(IMG_ROOT, 'HTML源码');
const BIN = path.join(REPO, 'runtime', 'node', 'backend', 'bin', 'khy.js');
const PROFILE_DIR = path.join(REPO, 'works', 'data', 'khy', 'tmp', 'evidence-browser-profile');
const VIEWPORT = { w: 1500, h: 1000 };
const CMD_TIMEOUT_MS = 45000;
const RENDER_SETTLE_MS = 25000;
const BROWSER_START_MS = 20000;

function findBrowser() {
  const fromEnv = process.env.KHY_EVIDENCE_BROWSER;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const roots = [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(Boolean);
  const names = ['Microsoft/Edge/Application/msedge.exe', 'Google/Chrome/Application/chrome.exe'];
  for (const r of roots) for (const n of names) {
    const p = path.join(r, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function fileUrl(p) {
  return 'file:///' + p.replace(/\\/g, '/').replace(/ /g, '%20');
}

function shot(browser, target, pngPath) {
  fs.mkdirSync(path.dirname(pngPath), { recursive: true });
  execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--force-device-scale-factor=1', `--window-size=${VIEWPORT.w},${VIEWPORT.h}`,
    `--screenshot=${pngPath}`, target,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
  if (!fs.existsSync(pngPath)) throw new Error('截图未落盘: ' + pngPath);
  const buf = fs.readFileSync(pngPath);
  if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('输出不是合法 PNG: ' + pngPath);
  return { 宽: buf.readUInt32BE(16), 高: buf.readUInt32BE(20), 字节: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

const CSS_BASE = 'body{margin:0;background:#fff;font-family:"Microsoft YaHei","Segoe UI",sans-serif;padding:26px 32px;color:#111827}'
  + 'h1{font-size:24px;margin:0 0 4px}.sub{font-size:13.5px;color:#4b5563;margin-bottom:18px}'
  + '.src{font-size:12px;color:#6b7280;margin-top:20px;border-top:1px solid #e5e7eb;padding-top:10px;line-height:1.7}';

// ── ANSI → HTML（只解释 SGR，其余转义序列丢弃）─────────────────────────────
const FG = { 30: '#0b0b0b', 31: '#e5484d', 32: '#46a97a', 33: '#e8b152', 34: '#5aa7f0', 35: '#c586e0', 36: '#4bb8c9', 37: '#d4d4d4', 90: '#7c7c7c', 91: '#ff6b6b', 92: '#6ee7a0', 93: '#ffd866', 94: '#7cb7ff', 95: '#e39ff5', 96: '#7ae4f5', 97: '#ffffff' };

function ansiToHtml(raw) {
  const text = String(raw).replace(/\r/g, '');
  let html = '';
  let color = null;
  let bold = false;
  const re = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
  let last = 0;
  let m;
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  while ((m = re.exec(text)) !== null) {
    html += esc(text.slice(last, m.index));
    last = re.lastIndex;
    if (m[1] === undefined) continue;
    const codes = m[1].split(';').map((x) => (x === '' ? 0 : Number(x)));
    for (const c of codes) {
      if (c === 0) { color = null; bold = false; }
      else if (c === 1) bold = true;
      else if (FG[c]) color = FG[c];
    }
  }
  html += esc(text.slice(last));
  const style = `color:${color || '#e6e6e6'};font-weight:${bold ? '700' : '400'}`;
  return { body: `<span style="${style}">${html}</span>`, plain: text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '') };
}

function terminalPage(opts) {
  const screen = `<div style="background:#0f172a;border-radius:10px;overflow:hidden;box-shadow:0 8px 26px rgba(2,6,23,.35)">
  <div style="background:#1e293b;color:#cbd5e1;font-size:13px;padding:9px 14px;font-family:Consolas,monospace;display:flex;justify-content:space-between">
    <span>${opts.windowTitle}</span><span>${opts.meta}</span></div>
  <pre style="margin:0;padding:16px 18px;font-family:Consolas,'Courier New',monospace;font-size:13.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:760px;overflow:hidden">${opts.body}</pre>
</div>`;
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>${CSS_BASE}</style></head><body>
<h1>${opts.title}</h1><div class="sub">${opts.subtitle}</div>${screen}
<div class="src">${opts.source}</div></body></html>`;
}

// ── A. 终端会话：跑真命令，抓真 stdout ─────────────────────────────────────
const TERMINAL_CASES = [
  { 名: '01_version', args: ['--version'], 说明: '版本自检（G1 版本轨道的运行时读数）' },
  { 名: '02_commands', args: ['commands'], 说明: '命令面自述：CLI 路由器实际注册的命令清单' },
  { 名: '03_hq_status', args: ['hq', 'status'], 说明: '任务/Bug 台账读数（.ai/hq 状态真源）' },
  { 名: '04_storage_status', args: ['storage', 'status'], 说明: '数据存储位置自述（各数据落点的寻址读数）' },
  {
    名: '05_gateway_status',
    args: ['gateway', 'status'],
    说明: 'AI 网关通道面读数：已启用适配器清单 + 逐通道连通状态（多供应商通道的运行时证据；名称改版后本图不再是名称载体，改由 06 承载）',
    外呼: true,
  },
  {
    名: '06_trajectory_list',
    args: ['trajectory', 'list'],
    说明: '执行轨迹记录与链路校验读数：逐会话轨迹条数 + 链完整性判定（「完整(n)」由 verifyTraceChain() 算出）。'
      + '登记全称中「执行轨迹记录」「链路校验」两词的运行时证据',
  },
];

function captureTerminals(browser, records) {
  for (const c of TERMINAL_CASES) {
    const cmdLine = 'khy ' + c.args.join(' ');
    let raw = '';
    let status = 'ok';
    try {
      raw = execFileSync(process.execPath, [BIN, ...c.args], {
        cwd: REPO,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        timeout: CMD_TIMEOUT_MS,
        env: Object.assign({}, process.env, { FORCE_COLOR: '1', NO_COLOR: '', KHY_NO_SPINNER: '1', CI: '' }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      raw = String((e && (e.stdout || '')) || '') + String((e && (e.stderr || '')) || '');
      status = e && e.code === 'ETIMEDOUT' ? `超时（>${CMD_TIMEOUT_MS / 1000}s，已如实记录）` : `退出码 ${e && e.status}`;
    }
    const rendered = ansiToHtml(raw);
    const trimmed = rendered.plain.split('\n').slice(0, 46).join('\n');
    const name = '终端截图/' + c.名 + '.png';
    const pngPath = path.join(IMG_ROOT, '终端截图', c.名 + '.png');
    const htmlPath = path.join(SRC_DIR, '终端截图', c.名 + '.html');
    fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
    const html = terminalPage({
      windowTitle: `khy-os — ${cmdLine}`,
      meta: `Windows 11 · Node ${process.version} · ${new Date().toISOString().slice(0, 10)}`,
      title: `终端真实输出：${cmdLine}`,
      subtitle: c.说明 + `　｜　进程状态：${status}`,
      body: ansiToHtml(trimmed).body,
      source: `采集方式：<code>node ${path.relative(REPO, BIN).replace(/\\/g, '/')} ${c.args.join(' ')}</code> 捕获子进程 stdout（保留 ANSI 颜色），包进终端外观后由 ${path.basename(browser)} 无头截图。<br>`
        + '字符内容未经改写。'
        + (c.外呼
          ? '注意：本命令会对外探测已启用通道的连通性，且部分通道的探测会触发一次最小模型调用'
            + '（实测输出出现「已收到模型响应」字样），因此**可能产生少量费用**——本底档不宣称零成本，只如实标注。'
          : '本命令为只读离线命令，不外呼网络。'),
    });
    fs.writeFileSync(htmlPath, html, 'utf8');
    try {
      const info = shot(browser, fileUrl(htmlPath), pngPath);
      records.push({
        图片: name, 页面标题: `终端真实输出：${cmdLine}`, 判据: '软件可运行（C-MAT1「前 30 页 = 可运行的完整软件」）',
        数据来源: `子进程 stdout：${cmdLine}`, 进程状态: status, 输出行数: trimmed.split('\n').length,
        渲染方式: '真实 stdout + 终端外观包装 + Edge 无头截图',
        对外探测: !!c.外呼,
        HTML源码: '03_图片/HTML源码/终端截图/' + c.名 + '.html',
        PNG: { 宽: info.宽, 高: info.高, 字节: info.字节, sha256: info.sha256 },
      });
      process.stdout.write(`终端 ${cmdLine} —— ${status}，${trimmed.split('\n').length} 行输出\n`);
    } catch (e) {
      process.stderr.write(`终端截图失败 ${cmdLine}: ${e.message}\n`);
    }
  }
}

// ── B. 界面截图：本地静态站真实渲染 ────────────────────────────────────────
const UI_TARGETS = [
  { app: 'apps/ai-frontend', root: 'dist', 名: '01_ai管理台', 路径: '/login', 说明: 'L3 平台自带管理前端（AI 平台 UI）构建产物' },
  { app: 'apps/khyos-desktop', root: 'dist', 名: '02_桌面端', 路径: '/', 说明: '桌面端渲染层构建产物（标题栏 + 侧栏 + 会话列表）' },
  { app: 'apps/provider-hub', root: 'dist', 名: '03_provider-hub', 路径: '/', 说明: '模型通道管理端构建产物' },
];

function serveStatic(rootDir) {
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json' };
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent((req.url || '/').split('?')[0]);
      let p = path.join(rootDir, rel);
      if (!p.startsWith(path.resolve(rootDir))) { res.writeHead(403); res.end(); return; }
      if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(rootDir, 'index.html');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
    });
    srv.on('error', reject);
    // 端口 0 = 让系统分配，不硬编码（规则 1）
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── CDP 驱动的页面截图：等「页面真的渲染出内容」再拍 ──────────────────────
// 为什么不用 `--screenshot` 一次性命令：那是「等页面 load 完就拍」，对 Vue/React
// 异步挂载的单页应用会拍到**空白页**（实测 6.6KB 全白 PNG）。空白图当证据 = 假证据，
// 所以这里改为：连上调试端口 → 轮询 document.body.innerText 长度 → 有内容才拍。
class HeadlessPage {
  constructor(browser) {
    this.browser = browser;
    this.proc = null;
    this.port = null;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async start() {
    try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch { /* 上一轮未释放，下面 mkdir 会复用 */ }
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    // 端口 0 = 系统分配，实际端口从 DevToolsActivePort 读回（规则 1：不硬编码）
    this.proc = require('child_process').spawn(this.browser, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--no-first-run', '--no-default-browser-check',
      `--remote-debugging-port=0`, `--user-data-dir=${PROFILE_DIR}`,
      `--window-size=${VIEWPORT.w},${VIEWPORT.h}`, 'about:blank',
    ], { detached: true, stdio: 'ignore' });
    this.proc.unref();
    const portFile = path.join(PROFILE_DIR, 'DevToolsActivePort');
    const deadline = Date.now() + BROWSER_START_MS;
    while (!fs.existsSync(portFile)) {
      if (Date.now() > deadline) throw new Error(`浏览器 ${BROWSER_START_MS / 1000}s 内未写出 DevToolsActivePort`);
      await sleep(200);
    }
    this.port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0].trim());
    if (!this.port) throw new Error('DevToolsActivePort 内容为空，拿不到调试端口');
  }

  async newTarget(url) {
    const res = await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    if (!res.ok) throw new Error(`/json/new 返回 ${res.status}（CDP HTTP 接口不可用）`);
    const info = await res.json();
    if (!info.webSocketDebuggerUrl) throw new Error('目标缺少 webSocketDebuggerUrl');
    return info;
  }

  attach(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => reject(new Error('CDP 连接 10s 未建立')), 10000);
      ws.onopen = () => { clearTimeout(timer); this.ws = ws; resolve(); };
      ws.onerror = (e) => { clearTimeout(timer); reject(new Error('CDP 连接失败: ' + (e.message || 'socket error'))); };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(String(ev.data)); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(`${msg.error.code}: ${msg.error.message}`)); else res(msg.result);
        }
      };
    });
  }

  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页内求值异常: ' + (r.exceptionDetails.text || ''));
    return r.result && r.result.value;
  }

  /** @returns 页面渲染后的实测读数（标题 / 可见文本长度 / 主体文本），用于证明「不是空白页」 */
  async render(url) {
    const target = await this.newTarget(url);
    await this.attach(target.webSocketDebuggerUrl);
    try {
      await this.send('Page.enable');
      await this.send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.w, height: VIEWPORT.h, deviceScaleFactor: 1, mobile: false });
      const probe = () => {
        const raw = this.evaluate(
          'JSON.stringify({title: document.title, text: (document.body && document.body.innerText || "").replace(/\\s+/g," ").trim().slice(0,300), len: (document.body && document.body.innerText || "").trim().length, nodes: document.getElementsByTagName("*").length})'
        );
        return raw.then((s) => JSON.parse(s));
      };
      let snap = null;
      const deadline = Date.now() + RENDER_SETTLE_MS;
      // 轮询而非固定等待：内容一出现就走（规则 3：以进度为条件，不到点不截）
      for (;;) {
        try { snap = await probe(); } catch { snap = null; }
        if (snap && snap.len >= 20 && snap.nodes > 30) break;
        if (Date.now() > deadline) break;
        await sleep(500);
      }
      if (!snap || !Number.isFinite(snap.len) || !Number.isFinite(snap.nodes) || snap.len < 20 || snap.nodes <= 30) {
        throw new Error(`页面渲染后仍无可见内容（文本长度 ${snap ? snap.len : 'null'}，节点 ${snap ? snap.nodes : 'null'}）—— 拒绝提交空白截图`);
      }
      const img = await this.send('Page.captureScreenshot', { format: 'png' });
      return { base64: img.data, 页面标题: snap.title, 可见文本长度: snap.len, 元素数: snap.nodes, 文本抽样: snap.text, targetId: target.id };
    } finally {
      try { await fetch(`http://127.0.0.1:${this.port}/json/close/${target.id}`); } catch { /* 关闭失败不影响已落盘截图 */ }
      if (this.ws) { this.ws.close(); this.ws = null; }
    }
  }

  async stop() {
    // 走 CDP 的 Browser.close 让浏览器自己退出：直接 kill 在 Windows 上会留下
    // 子进程握着档案目录，随后的 rm 就会 EBUSY。
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/version`);
      const info = await res.json();
      if (info.webSocketDebuggerUrl) {
        await this.attach(info.webSocketDebuggerUrl);
        this.ws.send(JSON.stringify({ id: this.nextId++, method: 'Browser.close' }));
        await sleep(500);
      }
    } catch { /* 关不掉就走下面的兜底 kill */ }
    if (this.proc && this.proc.exitCode === null) {
      const exited = new Promise((r) => this.proc.once('exit', r));
      try { this.proc.kill('SIGTERM'); } catch { /* 已退出 */ }
      await Promise.race([exited, sleep(4000)]);
    }
    for (let i = 0; i < 12; i++) {
      try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); return; } catch { await sleep(500); }
    }
    process.stdout.write(`浏览器档案目录暂未释放，留待下次运行清理：${path.relative(REPO, PROFILE_DIR).replace(/\\/g, '/')}\n`);
  }
}

function writePng(pngPath, base64) {
  fs.mkdirSync(path.dirname(pngPath), { recursive: true });
  const buf = Buffer.from(base64, 'base64');
  fs.writeFileSync(pngPath, buf);
  if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('输出不是合法 PNG: ' + pngPath);
  return { 宽: buf.readUInt32BE(16), 高: buf.readUInt32BE(20), 字节: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}


async function captureUi(browser, records) {
  const page = new HeadlessPage(browser);
  let started = false;
  for (const t of UI_TARGETS) {
    const rootDir = path.join(REPO, t.app, t.root);
    if (!fs.existsSync(path.join(rootDir, 'index.html'))) {
      process.stdout.write(`跳过 ${t.app}：无 ${t.root}/index.html（未构建）\n`);
      continue;
    }
    const builtMtime = fs.statSync(path.join(rootDir, 'index.html')).mtime.toISOString().slice(0, 10);
    let served = null;
    try {
      if (!started) { await page.start(); started = true; }
      served = await serveStatic(rootDir);
      const rendered = await page.render(`http://127.0.0.1:${served.port}${t.路径}`);
      const name = '界面截图/' + t.名 + '.png';
      const info = writePng(path.join(IMG_ROOT, '界面截图', t.名 + '.png'), rendered.base64);
      records.push({
        图片: name, 页面标题: `真实运行界面：${t.app}`, 判据: 'C-MAT3：界面标题须与登记全称一致（本张为过程证据，见下方风险标注）',
        数据来源: `${t.app}/${t.root}（构建产物，index.html 时间戳 ${builtMtime}），入口路由 ${t.路径}`,
        浏览器内标题: rendered.页面标题,
        渲染后元素数: rendered.元素数, 渲染后可见文本长度: rendered.可见文本长度,
        可见文本抽样: rendered.文本抽样,
        渲染方式: `本地静态站（端口由系统分配）→ ${path.basename(browser)} 无头 CDP 渲染，轮询到页面出现可见内容后才截`,
        非空白证明: `innerText 长度 ${rendered.可见文本长度} ≥ 20 且元素数 ${rendered.元素数} > 30；不满足则本条不会生成`,
        风险标注: '本张为**未连接后端的静态托管渲染**（无登录态：可能停在登录页，或显示前端内置的演示数据，状态栏可见「未连接」），'
          + '且浏览器内标题若与 COPYRIGHT.json 登记的软件全称不一致，则**只能作为开发过程证据，不得作为登记材料截图**；改名（阶段 2）后须重拍。',
        PNG: { 宽: info.宽, 高: info.高, 字节: info.字节, sha256: info.sha256 },
      });
      process.stdout.write(`界面 ${t.app} —— 标题「${rendered.页面标题}」，${rendered.元素数} 个元素，${info.宽}x${info.高}\n`);
    } catch (e) {
      process.stderr.write(`界面截图失败 ${t.app}: ${e.message}\n`);
    } finally {
      if (served) served.srv.close();
    }
  }
  if (started) await page.stop();
}

function collectOnly(kind, browser, records) {
  if (kind === '终端截图') { captureTerminals(browser, records); return Promise.resolve(); }
  if (kind === '界面截图') return captureUi(browser, records);
  captureTerminals(browser, records);
  return captureUi(browser, records);
}

async function main() {
  const browser = findBrowser();
  if (!browser) throw new Error(`找不到浏览器，可设 ${'KHY_EVIDENCE_BROWSER'}=<路径>`);
  const only = /^--only=(终端截图|界面截图)$/.exec(process.argv.slice(2).join(' ') || '');
  const kind = only ? only[1] : null;
  const fresh = [];
  process.stdout.write(`采集器: ${path.basename(browser)}（动态发现）${kind ? `　只采${kind}` : ''}\n`);
  await collectOnly(kind, browser, fresh);

  const out = path.join(IMG_ROOT, '运行截图清单.json');
  const prev = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
  const kept = (prev && Array.isArray(prev.条目) ? prev.条目 : []).filter((r) => !kind || !String(r.图片).startsWith(kind + '/'));
  // 同名图片以本轮为准，避免历史条目与本轮条目并存
  const byName = new Map(kept.map((r) => [r.图片, r]));
  for (const r of fresh) byName.set(r.图片, r);
  const records = [...byName.values()].sort((a, b) => String(a.图片).localeCompare(String(b.图片)));
  fs.writeFileSync(out, JSON.stringify({
    生成时间: new Date().toISOString(),
    生成器: 'scripts/evidence/capture-runtime.js',
    说明: '本目录图片来自真实运行的软件：终端图的正文全是子进程 stdout 原文；界面图是本地静态站经 CDP 渲染、且实测到可见内容后才截。渲染方式与风险标注逐条写明，不接受「摆拍」。',
    条目数: records.length,
    条目: records,
  }, null, 2) + '\n', 'utf8');
  process.stdout.write(`落盘 03_图片/运行截图清单.json —— ${records.length} 张\n`);
  if (!records.length) {
    process.stderr.write('采集到 0 张运行截图 —— 采集器没读到真实输出，不许当作已完成\n');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  process.stderr.write(`采集失败: ${e && e.message}\n`);
  process.exit(1);
});
