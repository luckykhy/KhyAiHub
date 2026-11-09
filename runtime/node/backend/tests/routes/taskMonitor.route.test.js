'use strict';

/**
 * taskMonitor 路由契约（HTTP 层）。
 *
 * 本仓已经栽过一次「页面在、端点没接」的坑（marketplace/plugins 只挂在闲置的
 * server.js 上，守护进程只回 404）。任务监控的两处挂载都要被钉住：
 *
 *   1. 守护进程（aiManagementServer 的手写分发器）—— 网页端会话就在它进程里；
 *   2. web 后端（server.js 的 Express 挂载）—— 换后端/直连时仍有读数。
 *
 * 这里验：真 express + 临时端口打真请求的信封形状、未带令牌被挂载点 401 拦住，
 * 以及两处接线在源码里确实存在、且分发器分支排在兜底 404 之前。
 *
 * 跑法：node --test tests/routes/taskMonitor.route.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const express = require('express');

const routes = require('../../src/routes/taskMonitor');
const svc = require('../../src/services/taskMonitorService');

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const DAEMON_SRC = fs.readFileSync(path.join(BACKEND_ROOT, 'src', 'services', 'aiManagementServer.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(BACKEND_ROOT, 'server.js'), 'utf8');

/** Fire one GET through a throwaway app on an ephemeral port. */
function request(app, urlPath) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app).listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      http
        .get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => {
            srv.close(() => resolve({ status: res.statusCode, headers: res.headers, body }));
          });
        })
        .on('error', (err) => srv.close(() => reject(err)));
    });
  });
}

test.beforeEach(() => {
  svc.reset();
});

test.after(() => {
  svc.reset();
});

test('GET /api/task-monitor/snapshot 返回统一信封，并带上本进程的在跑会话', async () => {
  const key = svc.beginRun({ scope: 'web', id: 'route-1', title: '路由探针' });
  svc.beginToolCall(key, { callId: 'c1', tool: 'read', input: 'a.js' });
  svc.endToolCall(key, { callId: 'c1', tool: 'read', success: true, elapsedMs: 7, result: 'ok' });

  const app = express();
  app.use('/api/task-monitor', routes.router);
  const res = await request(app, '/api/task-monitor/snapshot');

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers['cache-control'], 'no-store', '监控读数不得被缓存');
  const body = JSON.parse(res.body);
  assert.strictEqual(body.success, true);
  assert.ok(body.metadata && body.metadata.timestamp, '信封必须带 metadata.timestamp');
  assert.strictEqual(body.data.process.scope, 'web');
  assert.strictEqual(body.data.process.pid, process.pid);
  const run = body.data.runs.find((item) => item.id === 'route-1');
  assert.ok(run, '刚登记的运行必须出现在快照里');
  assert.strictEqual(run.toolCount, 1);
  assert.strictEqual(run.tools[0].elapsedMs, 7);
  // 队列任务是文件真源：读不到也必须返回空数组而不是 500（tasksError 另行报告）。
  assert.ok(Array.isArray(body.data.tasks));
});

test('只读端点只暴露 snapshot；别的子路径不伪装成功', async () => {
  const app = express();
  app.use('/api/task-monitor', routes.router);
  const res = await request(app, '/api/task-monitor/stop');
  assert.strictEqual(res.status, 404);
});

test('认证挂在挂载点：未带令牌的请求是 401 而不是 404（接线在位）', async () => {
  // authMiddleware 在无令牌时立即 401，不触库；这里只验证「挂载 + 鉴权在前」。
  const { authMiddleware } = require('../../src/middleware/auth');
  const app = express();
  app.use('/api/task-monitor', authMiddleware, routes.router);
  const res = await request(app, '/api/task-monitor/snapshot');
  assert.strictEqual(res.status, 401);
});

test('守护进程分发器认领该端点，且排在 /api/commands 之前（不会被兜底 404 吞掉）', () => {
  const branch = DAEMON_SRC.indexOf("pathname === '/api/task-monitor/snapshot'");
  assert.ok(branch > 0, '守护进程必须认领 /api/task-monitor/snapshot（否则网页端只看到 404）');
  assert.match(DAEMON_SRC.slice(branch, branch + 400), /getTaskMonitorHttp\(\)\.handleSnapshot\(req, res\)/);
  const fallback = DAEMON_SRC.indexOf("pathname.startsWith('/api/commands')");
  assert.ok(branch < fallback, '分支必须排在其它 /api 分支之前，保持与邻居同款顺序');
});

test('web 后端以认证中间件挂载同一路由器', () => {
  assert.match(
    SERVER_SRC,
    /app\.use\('\/api\/task-monitor', authMiddleware, taskMonitorRoutes\.router\)/
  );
  assert.match(SERVER_SRC, /require\('\.\/src\/routes\/taskMonitor'\)/);
});
