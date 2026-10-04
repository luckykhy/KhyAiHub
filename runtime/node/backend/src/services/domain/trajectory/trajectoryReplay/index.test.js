'use strict';

/**
 * index.test.js — 钉死 trajectoryReplay 桶文件（barrel）契约：恰导出六个子模块命名空间、
 * 每个命名空间与直接 require 同一进程同一实例（无第二份模块状态）、子模块导出面非空。
 *
 * 实测如实：barrel 不导出内部纯叶子 replayArtifactGuards / replayStepPolicy——它们只被
 * replayEngine 重组绑定后经引擎面透出，这是刻意收敛而非遗漏，此处一并钉住防表面漂移。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const barrel = require('./index');

test('barrel 恰导出 6 个子模块命名空间，不多不少', () => {
  assert.deepStrictEqual(Object.keys(barrel).sort(), [
    'artifactHash',
    'envFingerprint',
    'replayBundle',
    'replayEngine',
    'replayLedger',
    'tierRegistry',
  ]);
});

test('每个命名空间都是 require 对应源文件返回的同一实例（单进程无克隆状态）', () => {
  assert.strictEqual(barrel.replayLedger, require('./replayLedger'));
  assert.strictEqual(barrel.tierRegistry, require('./tierRegistry'));
  assert.strictEqual(barrel.artifactHash, require('./artifactHash'));
  assert.strictEqual(barrel.envFingerprint, require('./envFingerprint'));
  assert.strictEqual(barrel.replayBundle, require('./replayBundle'));
  assert.strictEqual(barrel.replayEngine, require('./replayEngine'));
});

test('六个命名空间各自的导出面非空（反空转：桶里不许是空对象）', () => {
  for (const key of Object.keys(barrel)) {
    assert.ok(barrel[key] && typeof barrel[key] === 'object', `${key} 必须是对象`);
    assert.ok(Object.keys(barrel[key]).length > 0, `${key} 导出面不得为空`);
  }
});

test('关键函数经桶可达且类型正确', () => {
  assert.strictEqual(typeof barrel.replayLedger.recordToolTurn, 'function');
  assert.strictEqual(typeof barrel.tierRegistry.effectiveTier, 'function');
  assert.strictEqual(typeof barrel.artifactHash.hashFile, 'function');
  assert.strictEqual(typeof barrel.envFingerprint.capture, 'function');
  assert.strictEqual(typeof barrel.replayBundle.verifyBundle, 'function');
  assert.strictEqual(typeof barrel.replayEngine.replay, 'function');
});

test('内部纯叶子 replayArtifactGuards/replayStepPolicy 不经桶暴露（当前表面如实钉住）', () => {
  assert.strictEqual('replayArtifactGuards' in barrel, false);
  assert.strictEqual('replayStepPolicy' in barrel, false);
  // 其能力经引擎重组绑定后可达：
  assert.strictEqual(typeof barrel.replayEngine._preconditionCheck, 'function');
  assert.strictEqual(typeof barrel.replayEngine._shellAllowList, 'function');
});

test('桶的 tier 常量与账本常量经两条路径读得同一值（一致性契约）', () => {
  assert.strictEqual(barrel.tierRegistry.TIER.NETWORK_AI, require('./tierRegistry').TIER.NETWORK_AI);
  assert.strictEqual(barrel.replayLedger.LEDGER_EXT, '.replay-ledger.jsonl');
  assert.strictEqual(barrel.replayBundle.BUNDLE_DIR_SUFFIX, '.replaybundle');
});

test('仅 require 桶不产生回放数据目录写入（无加载期副作用泄漏到数据根）', () => {
  const replayRoot = require('path').join(
    process.env.KHY_PROJECT_DATA_HOME || require('path').join(process.cwd(), '.khy-nonexistent-probe'),
    'trajectory_replay',
  );
  const existedBefore = require('fs').existsSync(replayRoot);
  delete require.cache[require.resolve('./index')];
  const again = require('./index');
  assert.ok(again.replayLedger);
  assert.strictEqual(require('fs').existsSync(replayRoot), existedBefore);
});
