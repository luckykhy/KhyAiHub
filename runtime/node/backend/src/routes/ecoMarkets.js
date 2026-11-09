'use strict';

/**
 * ecoMarkets.js — 生态市场编目 HTTP 路由（只读，GET-only）。
 *
 *   GET /           市场快照：静态编目 + 实时来源 + 已安装标注 + 新鲜度
 *   GET /:eco       单市场全量：marketplaces / entries / blocked / uncertainties
 *
 * 鉴权挂在挂载点（authenticateToken），与 proxy-subscriptions / gui-eval 同款；
 * 信封统一走 utils/apiResponse，不手写 res.json（API-001）。编目读不到时不 500：
 * 清单端点返回降级载荷（前端据此显示可修复提示），单市场端点返回带修复建议的
 * 错误——二者都含问题 + 识别码 + 修复建议。
 *
 * 装配统一走 services/marketCatalog（桌面端与终端同一份），本路由只决定
 * 「要不要触发刷新」：默认返回上次快照并后台刷新，`?refresh=1` 立刻触发一次
 * 后台刷新但不阻塞响应——一次上游拉取可能要 30s+，请求线程不该等它。
 */

const express = require('express');
const router = express.Router();

const apiResponse = require('../utils/apiResponse');
const {
  findEcoMarket,
  buildDegraded,
  degradedReason,
} = require('../services/ecoMarkets');
const { getMarketCatalog } = require('../services/marketCatalog');

const UNKNOWN_ECO_CODE = 'ECO_MARKET_UNKNOWN_ECO';
const REFRESHING_CODE = 'ECO_MARKET_REFRESHING';

function _wantsRefresh(req) {
  const raw = String((req.query && req.query.refresh) || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function _loadPayload(req) {
  try {
    return getMarketCatalog({ force: _wantsRefresh(req) });
  } catch (err) {
    // Same degraded shape as an unreadable catalog root: the page stays usable
    // and shows a fixable reason instead of a bare 500.
    return buildDegraded(degradedReason(err && err.message));
  }
}

function _unknownEcoMessage(eco, payload) {
  const known = (payload.ecosystems || []).map((item) => item.eco).join('、');
  const available = known ? `（当前可用：${known}）` : '';
  return (
    `未知生态市场「${eco || '(空)'}」：编目里没有这个生态（识别码 ${UNKNOWN_ECO_CODE}）。` +
    `修复：先请求 GET /api/eco-markets 取回生态清单，再用其中的 eco 重试${available}。`
  );
}

router.get('/', (req, res) => {
  const payload = _loadPayload(req);
  const opts = payload.degraded ? { message: 'degraded' } : {};
  return apiResponse.success(res, payload, opts);
});

router.get('/:eco', (req, res) => {
  const eco = String((req.params && req.params.eco) || '').trim();
  const payload = _loadPayload(req);
  if (payload.degraded) {
    return apiResponse.fail(res, 'IO_FAILED', payload.degraded, {
      status: 503,
      hint: '按提示修复编目数据根后重试；清单端点仍可打开',
    });
  }
  const market = findEcoMarket(payload, eco);
  if (!market) {
    // The live sources are still being fetched on the first request: the eco
    // probably exists upstream and this is a 503, not a 404.
    if (payload.refreshing) {
      return apiResponse.fail(
        res,
        'UNAVAILABLE',
        `生态市场快照仍在拉取实时来源，暂未包含「${eco || '(空)'}」（识别码 ${REFRESHING_CODE}）。` +
          '修复：等待 GET /api/eco-markets 返回 refreshing=false 后重试。',
        { status: 503, hint: '轮询清单端点直至 refreshing=false' }
      );
    }
    return apiResponse.fail(res, 'INVALID_ARGUMENT', _unknownEcoMessage(eco, payload), {
      status: 404,
      hint: 'eco 取自 GET /api/eco-markets 响应 data.ecosystems[].eco',
    });
  }
  const single = {
    ...market,
    rules: payload.rules,
    licenseGate: payload.licenseGate,
    generatedAt: payload.generatedAt,
    fetchedAt: payload.fetchedAt,
    refreshing: payload.refreshing,
    source: (payload.sources || []).find((item) => item && item.eco === market.eco) || null,
  };
  return apiResponse.success(res, single);
});

module.exports = router;
