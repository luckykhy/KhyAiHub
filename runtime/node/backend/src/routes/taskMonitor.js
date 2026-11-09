'use strict';

/**
 * 任务监控只读端点。两种载体共用同一份快照：
 *   • 守护进程（aiManagementServer，裸 http）——网页端的聊天/工具事件就在它的进程里；
 *   • web 后端（server.js，Express）——按 vite 代理兜底挂载，避免换后端就 404。
 *
 * 路由模块同时导出 router 与 handleSnapshot：前者给 Express，后者给裸 http 分派。
 * 不在本模块做鉴权，两个挂载点各自在前面套 auth。
 */

const express = require('express');

const taskMonitor = require('../services/taskMonitorService');
const apiResponse = require('../utils/apiResponse');

function _sendSuccess(req, res, data) {
  res.setHeader('Cache-Control', 'no-store');
  if (typeof res.json === 'function') {
    return apiResponse.success(res, data);
  }
  const body = {
    success: true,
    data,
    metadata: { timestamp: new Date().toISOString() },
  };
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'close',
  });
  res.end(JSON.stringify(body));
}

function handleSnapshot(req, res) {
  let data;
  try {
    data = taskMonitor.snapshot({ scope: 'web' });
  } catch (err) {
    // 规则 2.2：说明问题 + 原因 + 修复建议（快照本身已对任务台账读取做了隔离，
    // 走到这里只可能是登记表自身出错）。
    const message = `任务监控快照失败：${String((err && err.message) || err)}，请重启服务后重试`;
    res.setHeader('Cache-Control', 'no-store');
    if (typeof res.status === 'function' && typeof res.json === 'function') {
      return apiResponse.fail(res, 'INTERNAL', message);
    }
    res.writeHead(500, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ success: false, error: { message }, metadata: { timestamp: new Date().toISOString() } }));
    return;
  }
  return _sendSuccess(req, res, data);
}

const router = express.Router();
router.get('/snapshot', handleSnapshot);

module.exports = { router, handleSnapshot };
