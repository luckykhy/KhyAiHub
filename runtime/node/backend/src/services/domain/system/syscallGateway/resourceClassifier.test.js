'use strict';

/**
 * resourceClassifier.test.js — 三级审批矩阵分级契约（纯函数、零 IO、确定性）。
 *
 * fail 方向：**保守优先** = fail-closed。缺失意图 / 未知动作一律落 L2（红灯，宁可多问一次）。
 * 关键冲突裁决：只读短路先于 critical / isDestructive —— 即便工具静态标 risk:'critical'
 * 或自报 isDestructive，只要 action==='read'（或 isReadOnly===true）就不会被强推到 L2。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { classify, LEVELS, isExemptible } = require('./resourceClassifier');

test('LEVELS 导出非空三档', () => {
  assert.ok(Object.keys(LEVELS).length > 0);
  assert.deepStrictEqual(LEVELS, { L0: 'L0', L1: 'L1', L2: 'L2' });
});

test('classify null 意图 fail-closed 落 L2', () => {
  const r = classify(null);
  assert.strictEqual(r.level, LEVELS.L2);
  assert.deepStrictEqual(r.reasons, ['意图缺失，按最高危处理']);
});

test('classify 未知动作 fail-closed 落 L2', () => {
  assert.strictEqual(classify({ action: 'zzz', scope: 'na' }).level, LEVELS.L2);
});

test('classify 全部天然红线动作无论作用域一律 L2', () => {
  const redActions = ['delete', 'kill', 'env', 'install', 'listen', 'exec', 'sandbox_escape'];
  assert.ok(redActions.length > 0);
  for (const action of redActions) {
    assert.strictEqual(
      classify({ action, scope: 'project' }).level,
      LEVELS.L2,
      `${action} 应为红灯`
    );
  }
});

test('classify 项目内只读落绿灯 L0', () => {
  assert.strictEqual(classify({ action: 'read', scope: 'project' }).level, LEVELS.L0);
});

test('classify isReadOnly=true 非系统级同样落 L0', () => {
  assert.strictEqual(
    classify({ action: 'process', scope: 'project', isReadOnly: true }).level,
    LEVELS.L0
  );
});

test('classify 读取系统级路径落黄灯 L1', () => {
  assert.strictEqual(classify({ action: 'read', scope: 'system' }).level, LEVELS.L1);
});

test('classify 写入按作用域细分：项目黄灯 / 系统红灯', () => {
  assert.strictEqual(classify({ action: 'write', scope: 'project' }).level, LEVELS.L1);
  assert.strictEqual(classify({ action: 'write', scope: 'system' }).level, LEVELS.L2);
});

test('classify 网络出站落黄灯 L1', () => {
  assert.strictEqual(classify({ action: 'network', scope: 'network' }).level, LEVELS.L1);
});

test('classify 起本地进程落黄灯 L1', () => {
  assert.strictEqual(classify({ action: 'process', scope: 'process' }).level, LEVELS.L1);
});

test('classify critical 风险但只读：只读短路先于 critical → L0', () => {
  assert.strictEqual(
    classify({ action: 'read', scope: 'project', risk: 'critical' }).level,
    LEVELS.L0
  );
});

test('classify critical 风险且改状态：非只读才生效 → L2', () => {
  assert.strictEqual(
    classify({ action: 'write', scope: 'project', risk: 'critical' }).level,
    LEVELS.L2
  );
});

test('classify 自报 isDestructive 非只读 → L2', () => {
  const r = classify({ action: 'write', scope: 'project', isDestructive: true });
  assert.strictEqual(r.level, LEVELS.L2);
  assert.ok(r.reasons.includes('工具自报 isDestructive，红灯'));
});

test('classify 自报 isDestructive 但动作是 read：只读短路胜出 → L0', () => {
  assert.strictEqual(
    classify({ action: 'read', scope: 'project', isDestructive: true }).level,
    LEVELS.L0
  );
});

test('isExemptible 仅 L0/L1 可免审，L2 与非法值不可（L2 硬不变量）', () => {
  assert.strictEqual(isExemptible(LEVELS.L0), true);
  assert.strictEqual(isExemptible(LEVELS.L1), true);
  assert.strictEqual(isExemptible(LEVELS.L2), false);
  assert.strictEqual(isExemptible('bogus'), false);
  assert.strictEqual(isExemptible(undefined), false);
});
