'use strict';

/**
 * skills.js — 生态市场安装/卸载的 HTTP 路由（POST-only）。
 *
 *   POST /install    按条目的 installSpec 安装（skill / mcp 两种 mode）
 *   POST /uninstall  按 market-installed.json 台账卸载
 *
 * 与只读市场的边界：编目的读取在 routes/ecoMarkets.js（GET-only），本文件只写。
 * 装机逻辑一行都不在这里——安装/卸载内部直调 services/marketInstallService，
 * 桌面 Electron IPC（terminalSources.ts 的 installMarketEntry）调的是同一个
 * 服务、写同一个台账。手机端只是把同一执行面对 HTTP 暴露一次，不新增第二套
 * 装机路径，也就不存在"两边装到不同目录"的分叉。
 *
 * 威胁扫描的现状（写明以免文档与行为矛盾）：marketInstallService 安装技能
 * 今天不过 skillThreatScanner——那道扫描只门在 skillLearningService 的 learn
 * 路径上，其自陈的 denylist 也不是隔离边界。要不要给安装路径补扫描是行为
 * 变更，单独评审决定，本路由不默认勾上。
 *
 * 鉴权挂在挂载点（authenticateToken，与 /api/eco-markets 同款）：安装会写
 * 用户的技能目录与 MCP 配置，不是公开端点。信封统一走 utils/apiResponse
 * （API-001）；安装服务的返回形状 {ok,mode,installed,partial,message} 原样
 * 透传，手机端与桌面端因此读到同一份结局，不在这一层改写。
 *
 * 挂载不在本文件里做（接线阶段在 aiManagementServer.js 统一办），缺了它请求
 * 会落到守护进程的 miss 分支 404，而手机端 installPath/uninstallPath 钉的
 * 就是这两个路径。要补的三处，照 eco-markets 的既有样式：
 *   1. getSkillsApp()：express() + express.json({ limit: '64kb' }) +
 *      a.use('/api/skills', authenticateToken, require('../routes/skills'));
 *   2. 命名空间分发器加 pathname.startsWith('/api/skills') 分支（同 :2393
 *      的 eco-markets 分支）；
 *   3. 可达性守卫：未带令牌访问 /api/skills/install 必须回 401 而不是 404
 *      （同 aiManagementServer.js:3772-3775 的 eco-markets 断言）。
 */

const express = require('express');
const router = express.Router();

const apiResponse = require('../utils/apiResponse');
const marketInstallService = require('../services/marketInstallService');

const INSTALL_HINT =
  'entry 取自 GET /api/eco-markets 响应 data.ecosystems[].entries[]，原样提交；'
  '仍失败可复制详情页命令在桌面端或终端执行。';

function _plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function _readRequest(req) {
  const body = _plainObject(req.body) ? req.body : {};
  if (!_plainObject(body.entry)) {
    return {
      error:
        '请求缺少 entry 对象：请把市场编目里的条目原样提交，不要在客户端重挑字段。',
    };
  }
  const values = body.values === undefined ? {} : body.values;
  if (!_plainObject(values)) {
    return { error: 'values 必须是对象（{env:{},headers:{}}）：必填项按名字收集后随安装提交。' };
  }
  return { entry: body.entry, values };
}

router.post('/install', async (req, res) => {
  const parsed = _readRequest(req);
  if (parsed.error) {
    return apiResponse.fail(res, 'INVALID_ARGUMENT', parsed.error, {
      status: 400,
      hint: INSTALL_HINT,
    });
  }
  try {
    const result = await marketInstallService.installEntry(parsed.entry, {
      values: parsed.values,
    });
    // partial 也是成功：多技能仓库装上一半时 ok=true、partial=true，
    // 形状原样透传，让界面说"装了一半"而不是"已安装"。
    if (!result || result.ok !== true) {
      const message = (result && result.error) || '安装失败：后端未返回原因。';
      return apiResponse.fail(res, 'INVALID_ARGUMENT', message, {
        status: 400,
        hint: INSTALL_HINT,
      });
    }
    return apiResponse.success(res, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return apiResponse.fail(res, 'INTERNAL', `安装失败：${message}`, {
      status: 500,
      hint: '查看后端日志；可复制详情页命令在桌面端或终端执行。',
    });
  }
});

router.post('/uninstall', async (req, res) => {
  const parsed = _readRequest(req);
  if (parsed.error) {
    return apiResponse.fail(res, 'INVALID_ARGUMENT', parsed.error, {
      status: 400,
      hint: INSTALL_HINT,
    });
  }
  try {
    const result = await marketInstallService.uninstallEntry(parsed.entry, {});
    if (!result || result.ok !== true) {
      const message = (result && result.error) || '卸载失败：后端未返回原因。';
      return apiResponse.fail(res, 'INVALID_ARGUMENT', message, {
        status: 400,
        hint: '刷新编目后重试；或到「技能」页、「MCP 服务器」页手动删除。',
      });
    }
    return apiResponse.success(res, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return apiResponse.fail(res, 'INTERNAL', `卸载失败：${message}`, {
      status: 500,
      hint: '查看后端日志；可到「技能」页、「MCP 服务器」页手动删除。',
    });
  }
});

module.exports = router;
