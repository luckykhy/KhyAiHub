'use strict';

/**
 * 顶层副作用守卫（[DESIGN-ARCH-178] E1 / P0）。
 *
 * cacheService 在模块顶层不得触发 redis 加载 —— 否则任何一次 require 都会同步
 * 加载整棵 redis 客户端树（542 模块 / 实测 20.4s），卡住 TUI 首帧。
 *
 * 判据是「结构事实」（require.cache 里有没有 redis），不是耗时（耗时抖动 400~700ms，
 * 不可靠）。双向对照：require 后不得加载；首次 get() 后必须加载 —— 后者证明惰性
 * 初始化真的接上了，否则首次 get 会读到空内存缓存（静默降级，比慢更糟）。
 *
 * 用 node:test 而非 jest：既有 cacheService.test.js 用 jest.mock('redis') 桩掉了
 * redis，顶层副作用在那种桩下测不出来。
 */

const test = require('node:test');
const assert = require('node:assert');

const CACHE_PATH = '@khy/shared/services/cacheService';

function redisModulesInCache() {
  return Object.keys(require.cache).filter((k) => /[\\/]node_modules[\\/]@?redis[\\/]/.test(k));
}

test('require cacheService 后不得加载 redis（顶层无副作用）', () => {
  assert.equal(redisModulesInCache().length, 0, '前置：require 之前 redis 本就不该被加载');
  const cacheService = require(CACHE_PATH);
  assert.equal(typeof cacheService.get, 'function', '导出面应包含 get');
  const loaded = redisModulesInCache();
  assert.equal(
    loaded.length,
    0,
    `require cacheService 后 redis 不得进 cache；实际加载了 ${loaded.length} 个: ${loaded.slice(0, 3).join(', ')}`
  );
});

test('require 后 isRedisConnected() 为 false（尚未初始化）', () => {
  const cacheService = require(CACHE_PATH);
  assert.equal(cacheService.isRedisConnected(), false);
});

test('首次 get() 触发初始化（反向对照：redis 此时才进 cache）', async () => {
  const cacheService = require(CACHE_PATH);
  await cacheService.get('arch178:probe');
  assert.ok(
    redisModulesInCache().length > 0,
    '首次 get() 后 redis 应已被 require —— 否则惰性初始化没接上，缓存会静默降级'
  );
});
