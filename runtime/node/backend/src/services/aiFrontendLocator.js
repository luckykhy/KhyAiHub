'use strict';

/**
 * aiFrontendLocator — 找到「已经在跑的那个 KHY AI 前端」，而不是再起一个。
 *
 * 为什么需要它：8090 只是**基准端口**，不是「AI 前端一定在 8090」。若 8090 被别的
 * 进程占用，或者 KHY 前端早已在运行（手工 `npm run dev`、上一次守护会话留下的 dev
 * server、预构建 static dist），「再起一个」的后果是同一台机器上多出一个端口，而入口
 * 打开的 URL / 运行时文件 / 管理页链接仍指向 8090 —— 用户打开的可能是**别人的服务**，
 * 表现为「页面空白」或「串台」。所以入口与守护进程都必须先「认人」，再决定是否启动：
 *
 *   1. 读运行时文件 `ai_frontend_runtime.json`（前端监听成功后自己落盘，含 pid 供过期判定）；
 *   2. 逐个端口做**身份探测**（先 `/khy-frontend-identity.json`，回退看页面标题）；
 *   3. 认到就**复用**（managed:false，绝不杀别人的进程），认不到才去找一个**真正空闲**
 *      的端口启动，并把实际端口交给所有消费者。
 *
 * 契约（两侧必须一致，另一侧实现见 delivery/web/ai-frontend/frontendRuntime.mjs）：
 *   - 运行时文件名 `ai_frontend_runtime.json`
 *   - 身份端点    `/khy-frontend-identity.json` → { app: 'khy-ai-frontend', port, pid }
 *   - 页面标题含 `KHY`（老 dev server 没有身份端点时的回退判据）
 *
 * 全程 fail-soft：读不到、探不通、端口被占，都只是「这次没找到」，绝不抛。
 */

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const FRONTEND_APP_ID = 'khy-ai-frontend';
const FRONTEND_RUNTIME_FILENAME = 'ai_frontend_runtime.json';
const FRONTEND_IDENTITY_PATH = '/khy-frontend-identity.json';
// 老 dev server 没有身份端点，用页面标题兜底认人（apps/ai-frontend/index.html）。
const FRONTEND_TITLE_MARKER = /KHY/i;

const DEFAULT_SCAN = 20;
const DEFAULT_PROBE_TIMEOUT_MS = 900;

/** 运行时文件可能出现的所有数据家（便携部署只写主数据家，不落系统盘）。 */
function runtimeFileCandidates() {
  let homes = [];
  try {
    const { getDataHome, getLegacyDataHome, isPortableDeployment } = require('../utils/dataHome');
    homes = [getDataHome()];
    if (!isPortableDeployment()) {
      homes.push(getLegacyDataHome());
    }
  } catch {
    /* 数据家不可用 → 没有候选 */
  }
  const out = [];
  for (const home of homes) {
    if (!home) continue;
    const file = path.join(home, FRONTEND_RUNTIME_FILENAME);
    if (!out.includes(file)) out.push(file);
  }
  return out;
}

/** 记录里的 pid 是否还活着。没有 pid 记录时返回 true（不因缺字段就否定）。 */
function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return true;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    // EPERM = 进程存在但属于其他用户 → 视为活着。
    return !!err && err.code === 'EPERM';
  }
}

/**
 * 读「前端自己上报的运行态」。过期（记录的 pid 已死）视为不存在 —— 运行态文件会比
 * 进程活得久（被 SIGKILL 时没人清理），不判过期就会把入口永久钉在一个死端口上。
 * @returns {{host:string, port:number, pid:number|null, url:string, app:string, source:string}|null}
 */
function readFrontendRuntime() {
  for (const file of runtimeFileCandidates()) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const port = parseInt(String(raw?.port ?? ''), 10);
      if (!Number.isFinite(port) || port <= 0 || port > 65535) continue;
      if (!isPidAlive(raw?.pid)) continue;
      const host = String(raw?.host || '127.0.0.1').trim() || '127.0.0.1';
      return {
        host,
        port,
        pid: Number.isFinite(Number(raw?.pid)) ? Number(raw.pid) : null,
        url: String(raw?.url || frontendUrl(host, port)),
        app: String(raw?.app || ''),
        source: 'runtime-file',
      };
    } catch {
      /* 缺失/损坏 → 试下一个候选 */
    }
  }
  return null;
}

function frontendUrl(host, port) {
  const h = String(host || '127.0.0.1').trim() || '127.0.0.1';
  return `http://${h}:${port}`;
}

/** 端口是否**真的**空闲（能绑定才算空闲：只有 bind 能发现被别的进程占着的情况）。 */
function canBindPort(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

/** 从 basePort 起找第一个真正空闲的端口；扫描窗口内没有则返回 null（不杜撰端口）。 */
async function findFreePort(host, basePort, { scan = DEFAULT_SCAN } = {}) {
  const start = parseInt(String(basePort), 10);
  if (!Number.isFinite(start) || start <= 0 || start > 65535) return null;
  for (let p = start; p < start + scan && p <= 65535; p += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await canBindPort(host, p)) return p;
  }
  return null;
}

// ── 端口被谁占着？ ──────────────────────────────────────────────────────────
// 基准端口被占用时，光「漂到下一个端口」还不够：用户需要知道是**谁**占的，才能决定
// 「关掉它」还是「让 KHY 换端口」。这里用操作系统自带的 netstat/ss 查监听者 pid，再取
// 进程名 —— 全部 fail-soft，任何一步查不到就返回空串（=「未知进程」），绝不阻塞启动。

/**
 * 解析 `netstat -ano -p tcp` 输出，返回在 `host:port` 上 LISTENING 的 pid。
 * 纯函数（便于测试）；host 传 127.0.0.1 时也认 [::1] 与通配地址（0.0.0.0/[::]）。
 */
function parseListeningPid(netstatOutput, { host = '127.0.0.1', port } = {}) {
  const p = parseInt(String(port), 10);
  if (!Number.isFinite(p) || p <= 0) return 0;
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '0.0.0.0' || host === '::';
  for (const line of String(netstatOutput || '').split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || !/^TCP$/i.test(cols[0]) || !/LISTEN/i.test(cols[3])) continue;
    const local = cols[1] || '';
    const portMatch = local.match(/:(\d+)$/);
    if (!portMatch || parseInt(portMatch[1], 10) !== p) continue;
    const addr = local.slice(0, local.length - portMatch[1].length - 1);
    const isLoopbackAddr = /^(127\.\d+\.\d+\.\d+|\[::1\]|\*|0\.0\.0\.0|\[::\])$/i.test(addr);
    if (!loopback && !addr.split('.').join('.').includes(String(host))) continue;
    if (loopback || isLoopbackAddr) {
      const pid = parseInt(cols[cols.length - 1], 10);
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
  }
  return 0;
}

/**
 * 从 `tasklist /fo csv /nh` 输出里取 pid 对应的进程名；找不到返回 ''。
 * CSV 行形如 `"node.exe","12345","Console",...`（纯函数）。
 */
function parseProcessNameFromCsv(csvOutput, pid) {
  const n = parseInt(String(pid), 10);
  if (!Number.isFinite(n) || n <= 0) return '';
  for (const line of String(csvOutput || '').split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)"\s*,\s*"(\d+)"/);
    if (m && parseInt(m[2], 10) === n) return m[1];
  }
  return '';
}

function _runCapture(command, args, timeoutMs = 3000) {
  return new Promise((resolve) => {
    try {
      require('child_process').execFile(
        command,
        args,
        { timeout: timeoutMs, windowsHide: true },
        (err, stdout) => resolve(err && !stdout ? '' : String(stdout || ''))
      );
    } catch {
      resolve('');
    }
  });
}

/**
 * 「这个端口现在被谁监听着？」—— 返回人类可读的一句话，例如
 * `端口 8090 被进程 node.exe（PID 1234）占用`；查不到返回 ''（= 未知进程）。
 * 只读操作，绝不杀进程。
 */
async function describePortOwner(port, { host = '127.0.0.1' } = {}) {
  const p = parseInt(String(port), 10);
  if (!Number.isFinite(p) || p <= 0) return '';
  const isWin = process.platform === 'win32';
  let pid = 0;
  if (isWin) {
    const netstat = await _runCapture('netstat', ['-ano', '-p', 'tcp']);
    pid = parseListeningPid(netstat, { host, port: p });
  } else {
    // ss -ltnp 输出形如: LISTEN 0 128 127.0.0.1:8090 users:(("node",pid=1234,fd=18))
    const line = String(await _runCapture('ss', ['-ltnp']) || '')
      .split(/\r?\n/)
      .find((l) => l.includes(`:${p} `) && /LISTEN/i.test(l));
    const pm = line && line.match(/pid=(\d+)/);
    pid = pm ? parseInt(pm[1], 10) : 0;
  }
  if (!pid) return '';
  let name = '';
  if (isWin) {
    name = parseProcessNameFromCsv(await _runCapture('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], 2500), pid);
    if (!name) {
      name = parseProcessNameFromCsv(await _runCapture('tasklist', ['/fo', 'csv', '/nh'], 4000), pid);
    }
  } else {
    name = String(await _runCapture('ps', ['-p', String(pid), '-o', 'comm='], 2000) || '').trim().split(/\s+/)[0] || '';
  }
  return `端口 ${p} 被进程 ${name || '未知进程'}（PID ${pid}）占用`;
}

/** 一次 GET，拿回响应体文本（超时/网络错误一律 null）。 */
function httpGetText(host, port, requestPath, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.request(
      { host, port, path: requestPath, method: 'GET', timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const status = Number(res.statusCode || 0);
          done(status >= 200 && status < 300 ? Buffer.concat(chunks).toString('utf8') : null);
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      done(null);
    });
    req.on('error', () => done(null));
    req.end();
  });
}

/**
 * 「这个端口上跑的是不是我们的 AI 前端？」
 * 先问身份端点（新前端都有），再回退看页面标题（老 dev server 也算自己人，
 * 否则升级本改动后会误判成陌生人而多起一个）。返回 false = 不是（或探不通）。
 */
async function isKhyFrontend(host, port, { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  const identity = await httpGetText(host, port, FRONTEND_IDENTITY_PATH, timeoutMs);
  if (identity) {
    try {
      const parsed = JSON.parse(identity);
      return String(parsed?.app || '') === FRONTEND_APP_ID;
    } catch {
      /* 形状不对 → 落到标题回退 */
    }
  }
  const html = await httpGetText(host, port, '/', timeoutMs);
  if (!html) return false;
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return !!title && FRONTEND_TITLE_MARKER.test(title[1]);
}

/**
 * 复用优先的发现：把「已经在跑的那个 KHY AI 前端」找出来。
 * 顺序：运行时文件记录的端口（最可信）→ 基准端口 → 基准端口起的一段窗口。
 * @returns {{host:string, port:number, url:string, source:string}|null}
 */
async function discoverKhyFrontend({
  host = '127.0.0.1',
  basePort,
  scan = DEFAULT_SCAN,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
} = {}) {
  const recorded = readFrontendRuntime();
  if (recorded && (await isKhyFrontend(recorded.host, recorded.port, { timeoutMs }))) {
    return { host: recorded.host, port: recorded.port, url: recorded.url, source: recorded.source };
  }

  const start = parseInt(String(basePort), 10);
  if (!Number.isFinite(start) || start <= 0 || start > 65535) return null;
  for (let p = start; p < start + scan && p <= 65535; p += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await isKhyFrontend(host, p, { timeoutMs })) {
      return { host, port: p, url: frontendUrl(host, p), source: 'scan' };
    }
  }
  return null;
}

module.exports = {
  FRONTEND_APP_ID,
  FRONTEND_RUNTIME_FILENAME,
  FRONTEND_IDENTITY_PATH,
  runtimeFileCandidates,
  readFrontendRuntime,
  frontendUrl,
  isPidAlive,
  canBindPort,
  findFreePort,
  isKhyFrontend,
  discoverKhyFrontend,
  parseListeningPid,
  parseProcessNameFromCsv,
  describePortOwner,
};