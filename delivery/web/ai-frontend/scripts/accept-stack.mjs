#!/usr/bin/env node
/**
 * accept-stack.mjs — operational acceptance for the running KHY dev stack.
 *
 * Covers what unit tests cannot: that the *live* processes behind the Vite
 * proxy actually answer. Written for the 2026-09-26 incident where
 * `backend_runtime.json` described a dead-but-recycled pid and every
 * non-daemon `/api/*` call 500'd through the proxy while unit tests stayed
 * green.
 *
 * Four checks (each PASS/FAIL, exit 1 if any FAIL):
 *   S1 backend runtime apiPort is actually reachable (stale-file / PID-reuse detector)
 *   S2 the four proxy endpoints answer without 5xx through the frontend origin
 *   S3 /ws/cross-platform completes an HTTP upgrade handshake through the proxy
 *   S4 /vendor/khyos-muya.js is served (200), i.e. predev vendor sync ran
 *
 * Endpoints are discovered (runtime files + env), never hardcoded —
 * KHY_FRONTEND_URL overrides the frontend origin when set.
 * Run: `npm run accept:stack` (workdir apps/ai-frontend).
 *
 * @pattern Builder
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveDataHomes, isTargetReachable } from '../backendDiscovery.mjs';
import { FRONTEND_RUNTIME_FILENAME, primaryDataHome } from '../frontendRuntime.mjs';

const env = process.env;
const PROBE_TIMEOUT_MS = 4000;
const REQUEST_TIMEOUT_MS = 5000;

const results = [];
function record(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`);
}

function readJsonEverywhere(filename) {
  for (const home of resolveDataHomes(env)) {
    try {
      const file = path.join(home, filename);
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object') return { file, raw };
    } catch {
      /* missing/corrupt — try next home */
    }
  }
  return null;
}

async function checkBackendRuntime() {
  const found = readJsonEverywhere('backend_runtime.json');
  if (!found) {
    record('S1', false, 'backend_runtime.json 未找到 — web 后端未启动过 (node services/backend/server.js)');
    return;
  }
  const port = parseInt(String(found.raw.apiPort ?? ''), 10);
  const pid = found.raw.pid;
  if (!Number.isFinite(port) || port <= 0) {
    record('S1', false, `${found.file} apiPort 非法 — 删除该文件后重启后端`);
    return;
  }
  const ok = await isTargetReachable(`http://127.0.0.1:${port}`, PROBE_TIMEOUT_MS);
  record(
    'S1',
    ok,
    ok
      ? `后端 apiPort=${port} 可达 (${found.file}, pid=${pid})`
      : `apiPort=${port} 不可达 (pid=${pid}) — 运行时文件陈旧或后端已死，重启 node services/backend/server.js 并重启 Vite`
  );
}

function frontendOrigin() {
  if (env.KHY_FRONTEND_URL) return env.KHY_FRONTEND_URL;
  const found = readJsonEverywhere(FRONTEND_RUNTIME_FILENAME);
  if (found?.raw?.host && found.raw.port) return `http://${found.raw.host}:${found.raw.port}`;
  // process.env fallback keeps this within the RUNTIME-001 localhost exemption.
  const host = env.KHY_FRONTEND_HOST || '127.0.0.1';
  const port = env.KHY_FRONTEND_PORT;
  return port ? `http://${host}:${port}` : null;
}

async function getStatus(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'manual' });
    return { status: res.status };
  } catch (err) {
    return { status: 0, error: (err && err.message) || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function checkProxyEndpoints(base) {
  const paths = ['/api/auth/sessions', '/api/commands', '/api/ai/projects', '/api/ai-gateway/models'];
  const failures = [];
  for (const p of paths) {
    const { status, error } = await getStatus(`${base}${p}`);
    if (status === 0 || status >= 500) failures.push(`${p} → ${error || `HTTP ${status}`}`);
  }
  record(
    'S2',
    failures.length === 0,
    failures.length === 0
      ? `4 个代理端点均无 5xx (${base})`
      : `代理端点异常: ${failures.join('; ')} — 检查 vite 代理 target (backend_runtime) 与后端存活`
  );
}

function wsHandshake(origin) {
  return new Promise((resolve) => {
    const url = new URL(origin);
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    const key = crypto.randomBytes(16).toString('base64');
    const req =
      `GET /ws/cross-platform HTTP/1.1\r\n` +
      `Host: ${url.hostname}:${port}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\n` +
      `Sec-WebSocket-Version: 13\r\n\r\n`;
    let settled = false;
    const done = (ok, detail) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      setImmediate(() => socket.destroy());
      resolve({ ok, detail });
    };
    const socket = net.connect({ port, host: url.hostname });
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => done(false, '握手超时 — /ws 代理未响应'));
    socket.once('error', (err) => done(false, `连接失败: ${err.message}`));
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const m = buf.match(/^HTTP\/1\.[01] (\d{3})/);
      if (!m) return;
      const code = parseInt(m[1], 10);
      // Any HTTP response proves the proxy routed the upgrade attempt; 101 is
      // the full success, 4xx still proves the backend chain is alive.
      done(code === 101 || (code >= 400 && code < 500), `握手响应 HTTP ${code}`);
    });
    socket.once('close', () => done(false, '连接在响应前关闭 — 后端 /ws 目标不可达'));
    socket.on('connect', () => socket.write(req));
  });
}

async function checkWs(base) {
  const { ok, detail } = await wsHandshake(base);
  record('S3', ok, ok ? `/ws/cross-platform ${detail}` : `/ws/cross-platform ${detail}`);
}

async function checkVendor(base) {
  // The dev server answers a missing /vendor/* path with the SPA fallback
  // (200 + text/html index.html) — a bare status check would false-PASS, so
  // require a script content-type AND a non-trivial body (the real artifact
  // is ~11 MB of bundled JS).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let status = 0;
  let ctype = '';
  let bytes = 0;
  let error = '';
  try {
    const res = await fetch(`${base}/vendor/khyos-muya.js`, { signal: ctrl.signal });
    status = res.status;
    ctype = res.headers.get('content-type') || '';
    bytes = Number(res.headers.get('content-length') || 0);
    if (!bytes) {
      const buf = await res.arrayBuffer();
      bytes = buf.byteLength;
    }
  } catch (err) {
    error = (err && err.message) || String(err);
  } finally {
    clearTimeout(timer);
  }
  const ok = status === 200 && /javascript/.test(ctype) && bytes > 100000;
  record(
    'S4',
    ok,
    ok
      ? `/vendor/khyos-muya.js → 200 ${ctype} (${bytes} bytes)`
      : `/vendor/khyos-muya.js → ${error || `HTTP ${status} ${ctype} ${bytes}B`} — 运行 node extensions/tools/khy-markdown/muya-embed/ensure-vendor.mjs && npm run sync-md-vendor`
  );
}

async function main() {
  await checkBackendRuntime();
  const base = frontendOrigin();
  if (!base) {
    record('S2', false, `前端 origin 未发现 (${FRONTEND_RUNTIME_FILENAME} 缺失) — 设置 KHY_FRONTEND_URL 或先启动 Vite`);
    record('S3', false, '前端 origin 未发现，跳过握手');
    record('S4', false, '前端 origin 未发现，跳过 vendor 检查');
  } else {
    await checkProxyEndpoints(base);
    await checkWs(base);
    await checkVendor(base);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\naccept-stack: ${results.length - failed}/${results.length} PASS — ${base || 'origin 未发现'}`);
  // Exit via exitCode (not process.exit): a hard exit while libuv handles are
  // still closing aborts with 0xC0000409 on Windows. The unref'd watchdog is
  // only for a stranded handle — the normal path drains and exits on its own.
  process.exitCode = failed === 0 ? 0 : 1;
  const watchdog = setTimeout(() => process.exit(process.exitCode || 1), 8000);
  watchdog.unref();
}

main().catch((err) => {
  console.error(`accept-stack 崩溃: ${(err && err.stack) || err}`);
  process.exitCode = 1;
});
