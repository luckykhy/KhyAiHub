#!/usr/bin/env node
'use strict';

/**
 * start-daemon.js — 带 .env 加载的 daemon 启动器
 * 用法: node start-daemon.js [port]
 * 
 * 解决 daemonEntry.js 不加载 .env 的问题：
 * 1. 先调用 init() 加载 .env + ~/.khy/.env overlay
 * 2. 再 require daemonEntry（继承当前 process.env）
 */

// ── V8 compile cache: reuse bytecode across launches (Node >= 22.8) ──
// Mirrors the block at the top of bin/khy.js so that entry points which do NOT
// go through bin/khy.js (this daemon launcher, server.js, bridgeServer.js, the
// tray app) share the same on-disk compile cache instead of recompiling the
// require graph from scratch on every launch.
//
// Benefit is UNVERIFIED and must not be assumed: it needs a controlled A/B to
// settle. Local measurements so far are neutral-to-slightly-negative, and an
// earlier measurement in the repo already concluded "no stable gain, do not
// enable" — hence this is structural parity only, and no millisecond figure
// should be quoted from it. Rollback is three-layered: this call is fail-soft
// (try/catch, no-op when the API is missing), NODE_DISABLE_COMPILE_CACHE=1 opts
// out at the Node level, and deleting the cache directory resets everything.
try {
  const nodeModule = require('module');
  if (typeof nodeModule.enableCompileCache === 'function') nodeModule.enableCompileCache();
} catch { /* compile cache is a best-effort accelerator */ }

const path = require('path');

async function main() {
  // 1. 加载 .env
  try {
    const { init } = require('./src/bootstrap/init');
    await init();
    console.log('[start-daemon] .env loaded via init()');
  } catch (err) {
    // 内联兜底：直接 dotenv
    try {
      const envPath = path.resolve(__dirname, '.env');
      require('dotenv').config({ path: envPath });
      console.log('[start-daemon] .env loaded via dotenv fallback');
    } catch {
      console.warn('[start-daemon] .env load skipped:', err.message);
    }
  }

  // 2. 设置端口（CLI 参数 > KHY_DAEMON_PORT > serviceDefaults 的 9090）
  //
  // 曾经这里兜底成 '3000'，而 web 后端（server.js）的 BACKEND_PORT 也是
  // `PORT || 3000`，于是两个服务抢同一个端口。更要命的是 daemon 绑
  // 127.0.0.1、web 后端绑 0.0.0.0：Windows 下更具体的绑定优先，所以
  // 浏览器访问 127.0.0.1:3000 全部落到 daemon 上 —— 表现为
  // /api/auth/* 404、/ws/cross-platform 握手挂断、user-gateway 500 一整片。
  // 端口真源是 serviceDefaults.AI_BACKEND_DEFAULT_PORT（9090），
  // delivery/web/ai-frontend/backendDiscovery.mjs 也镜像了同一个值。
  //
  // 注意：这里刻意不把 process.env.PORT 纳入优先级 —— PORT 是 web 后端的
  // 环境变量，让 daemon 也读它会把两个服务钉在同一个端口上。
  const { AI_BACKEND_DEFAULT_PORT } = require('./src/constants/serviceDefaults');
  const port = parseInt(
    process.argv[2] || process.env.KHY_DAEMON_PORT || String(AI_BACKEND_DEFAULT_PORT),
    10,
  );
  process.env.KHY_DAEMON_PORT = String(port);
  
  // 确保 PID_FILE 路径存在
  if (!process.env.KHY_DAEMON_PID_FILE) {
    const os = require('os');
    const dataHome = path.join(os.homedir(), '.khyquant');
    process.env.KHY_DAEMON_PID_FILE = path.join(dataHome, 'daemon.pid');
  }

  console.log(`[start-daemon] Starting daemon on port ${port}...`);

  // 3. 启动 daemonEntry（会继承当前 process.env）
  require('./src/services/daemonEntry');
}

main().catch(err => {
  console.error('[start-daemon] Fatal:', err.message);
  process.exit(1);
});
