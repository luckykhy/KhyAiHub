/**
 * 数据缓存路由
 */
const express = require('express');

const router = express.Router();
const cacheController = require('../controllers/cacheController');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

// 整条路由都要认证。此前两个 POST 端点没有任何鉴权闸（server.js:661 挂载处也没有），
// 于是未认证请求可以：① 写行情缓存与 instruments 表（污染后续策略/回测读到的数据）；
// ② 用一次 batch-save 把 N 个标的放大成 N 次第三方数据源外呼（SEC-03）。
router.use(authMiddleware);

// 保存单个标的数据（写库 + 外呼数据源 —— 收窄到管理员）
router.post(
  '/save-instrument-data',
  adminMiddleware,
  cacheController.saveInstrumentData.bind(cacheController)
);

// 批量保存标的数据（写库 + 外呼数据源 —— 收窄到管理员）
router.post(
  '/batch-save',
  adminMiddleware,
  cacheController.batchSaveInstruments.bind(cacheController)
);

// 获取缓存的K线数据
router.get('/kline-data/:symbol', cacheController.getCachedKlineData.bind(cacheController));

// 获取缓存统计信息
router.get('/stats/:symbol', cacheController.getCacheStats.bind(cacheController));

module.exports = router;
