'use strict';

/**
 * a2a.js — A2A 服务端任务面的 REST 绑定（S3 的传输层）。
 *
 * 挂在 `server.js` 的 `app.use('/v1', require('./src/routes/a2a'))`，与
 * `app.use('/.well-known', ...)`（Agent Card 发现）相邻 —— 两者合起来才构成
 * 「可被标准 A2A 客户端**发现**且**调用**」的完整 agent（此前只有发现、没有调用）。
 *
 * 端点（标准 A2A v0.3.0 REST 绑定）：
 *   POST   /v1/message:send        message/send（建任务 + 跑 executor）
 *   POST   /v1/message/send        ↑ 的 express 友好别名（避开路由里的 `:` 歧义，便于手测）
 *   GET    /v1/tasks/:id           tasks/get
 *   POST   /v1/tasks/:id:cancel    tasks/cancel
 *   POST   /v1/tasks/:id/cancel    ↑ 别名
 *
 * 为什么 `/v1` 而不是 `/`：agent card 的 `url` 是 base，标准 REST 绑定把 `/v1/...`
 * 拼在 base 之后；`/v1` 正好对上出站客户端 `services/a2a/index.js` 用的路径
 * （`/v1/message:send`、`/v1/tasks/{id}`、`/v1/tasks/{id}:cancel`）。
 *
 * 为什么**不套** `{success,data}` 信封（同 wellKnown.js）：这是协议边界，响应体必须
 * 逐字段符合 A2A `task` schema；`sendJson` 直接写字符串体，绕开 envelopeMiddleware
 * （它只对带 `success` 字段的对象生效，字符串不会被动包装）。
 *
 * 鉴权：门控 `KHY_A2A_API_KEY`。配置了 → 必须 `Authorization: Bearer <key>`；
 * 未配置 → 放行（默认仅 loopback 可达，等同内网可信）。这与 wellKnown 的公开发现
 * 互补：发现公开、调用可按需加 key。
 *
 * 门控 KHY_A2A_ENABLED（default-on）：关 → 全部 404（与 wellKnown 同口径）。
 *
 * executor 接线：默认回显（`serverMethods.js` 的 defaultExecutor，诚实占位）。门控
 * KHY_A2A_EXECUTOR（default-off）下由启动代码经 {@link setServerMethods} 注入真
 * executor（`services/a2a/executor.js`：一次 runToolUseLoop，审批 / shell 安全 /
 * 循环检测全走循环正门，无绕开后门）。未设门控时本文件行为与接线前逐字节一致。
 *
 * @module routes/a2a
 */

const express = require('express');
const router = express.Router();

const { createServerMethods, A2aNotFoundError } = require('../services/a2a/serverMethods');
const agentCardSpec = require('../services/a2a/agentCardSpec');

// 单例（一次启动一个服务端任务面）。executor 默认占位；真接 agent 运行时时由启动代码
// 经 setServerMethods() 重建并挂进来（门控 KHY_A2A_EXECUTOR，default-off；未设时
// 下面这行无参构造的默认回显行为逐字节不变）。
let methods = createServerMethods();

/**
 * 用注入了 executor 的方法组替换当前方法组（启动代码专用）。
 *
 * 只在启动期调用：运行期热换会让在途请求落到另一份任务存储上，tasks/get 随之查不到
 * 自己刚建的任务。门控关时启动代码根本不调用它，默认回显路径不受影响。
 * @param {{ messageSend: Function }} next
 * @returns {{ store: object, messageSend: Function, tasksGet: Function, tasksCancel: Function }}
 */
function setServerMethods(next) {
  if (next && typeof next.messageSend === 'function') {
    methods = next;
  }
  return methods;
}

/** 读取开关：A2A 服务端任务面是否启用（与 wellKnown 同门控）。 */
function isEnabled(env = process.env) {
  return agentCardSpec.isPublishEnabled(env);
}

/** 发纯 JSON 字符串体（显式不套信封）。 */
function sendJson(res, status, body) {
  res.status(status).type('application/json; charset=utf-8').send(JSON.stringify(body));
}

/** 可选 Bearer 鉴权（KHY_A2A_API_KEY 未配置则放行）。 */
function maybeAuth(req, res, next) {
  const key = String(process.env.KHY_A2A_API_KEY || '').trim();
  if (!key) return next();
  const auth = String(req.headers['authorization'] || '');
  if (auth === `Bearer ${key}`) return next();
  return sendJson(res, 401, { error: 'unauthorized: missing or invalid bearer token' });
}

router.post('/message\\:send', maybeAuth, async (req, res) => {
  if (!isEnabled()) return sendJson(res, 404, { error: 'A2A server task surface is disabled' });
  try {
    const task = await methods.messageSend(req.body || {});
    return sendJson(res, 200, task);
  } catch (err) {
    return sendJson(res, 400, { error: err && err.message ? err.message : 'message/send failed' });
  }
});

router.post('/message/send', maybeAuth, async (req, res) => {
  if (!isEnabled()) return sendJson(res, 404, { error: 'A2A server task surface is disabled' });
  try {
    const task = await methods.messageSend(req.body || {});
    return sendJson(res, 200, task);
  } catch (err) {
    return sendJson(res, 400, { error: err && err.message ? err.message : 'message/send failed' });
  }
});

router.get('/tasks/:id', maybeAuth, (req, res) => {
  if (!isEnabled()) return sendJson(res, 404, { error: 'A2A server task surface is disabled' });
  try {
    const task = methods.tasksGet({ id: req.params.id });
    return sendJson(res, 200, task);
  } catch (err) {
    if (err instanceof A2aNotFoundError) {
      return sendJson(res, 404, { error: err.message, id: err.taskId });
    }
    return sendJson(res, 500, { error: err && err.message ? err.message : 'tasks/get failed' });
  }
});

router.post('/tasks/:id\\:cancel', maybeAuth, (req, res) => {
  if (!isEnabled()) return sendJson(res, 404, { error: 'A2A server task surface is disabled' });
  try {
    const task = methods.tasksCancel({ id: req.params.id });
    return sendJson(res, 200, task);
  } catch (err) {
    if (err instanceof A2aNotFoundError) {
      return sendJson(res, 404, { error: err.message, id: err.taskId });
    }
    return sendJson(res, 500, { error: err && err.message ? err.message : 'tasks/cancel failed' });
  }
});

router.post('/tasks/:id/cancel', maybeAuth, (req, res) => {
  if (!isEnabled()) return sendJson(res, 404, { error: 'A2A server task surface is disabled' });
  try {
    const task = methods.tasksCancel({ id: req.params.id });
    return sendJson(res, 200, task);
  } catch (err) {
    if (err instanceof A2aNotFoundError) {
      return sendJson(res, 404, { error: err.message, id: err.taskId });
    }
    return sendJson(res, 500, { error: err && err.message ? err.message : 'tasks/cancel failed' });
  }
});

module.exports = router;
module.exports.setServerMethods = setServerMethods;
// 活读取方法组：注入之后读它要拿到注入后的那份，而不是模块加载期的快照。
Object.defineProperty(module.exports, 'methods', { get: () => methods, enumerable: true, configurable: true });
