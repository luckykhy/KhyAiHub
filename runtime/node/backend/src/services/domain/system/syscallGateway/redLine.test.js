'use strict';

/**
 * redLine.test.js — 钉住「L2 红灯」人类可读契约：委托 resourceClassifier，绝不另立判据。
 *
 * fail 方向：isRedLine 对缺失/异常输入一律 fail-**closed**（判定失败按红线 = true）。
 * describe 对 null/缺失同样 fail-closed 返回 L2，但对「intent.action 取值即抛」的畸形
 * 对象会**抛出**——因为 `const action = intent && intent.action;` 落在 try/catch 之外
 * （见本文件末条用例，钉住真实行为，非期望行为）。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const mod = require('./redLine');

test('RED_LINE_ACTION_LABELS 非空且覆盖 7 类红线动作', () => {
  const labels = mod.RED_LINE_ACTION_LABELS;
  assert.ok(Object.keys(labels).length > 0, '红线动作清单不得为空');
  assert.deepStrictEqual(
    Object.keys(labels).sort(),
    ['delete', 'env', 'exec', 'install', 'kill', 'listen', 'sandbox_escape'].sort()
  );
});

test('DESTRUCTIVE_SUMMARY 是非空中文说明串', () => {
  assert.strictEqual(typeof mod.DESTRUCTIVE_SUMMARY, 'string');
  assert.ok(mod.DESTRUCTIVE_SUMMARY.length > 0);
});

test('LEVELS 导出三档 L0/L1/L2', () => {
  assert.deepStrictEqual(mod.LEVELS, { L0: 'L0', L1: 'L1', L2: 'L2' });
});

test('isRedLine 对删除动作判为红线（allow=红线成立）', () => {
  assert.strictEqual(mod.isRedLine({ action: 'delete', scope: 'project' }), true);
});

test('isRedLine 对项目内只读判为非红线（deny=非红线）', () => {
  assert.strictEqual(mod.isRedLine({ action: 'read', scope: 'project' }), false);
});

test('isRedLine 对 null 输入 fail-closed 返回 true', () => {
  assert.strictEqual(mod.isRedLine(null), true);
});

test('isRedLine 对判定异常输入 fail-closed 返回 true', () => {
  const throwing = {
    get action() {
      throw new Error('boom');
    },
  };
  assert.strictEqual(mod.isRedLine(throwing), true);
});

test('describe 删除动作给出红线级摘要与 label 文案', () => {
  const d = mod.describe({ action: 'delete', scope: 'project' });
  assert.strictEqual(d.isRedLine, true);
  assert.strictEqual(d.level, 'L2');
  assert.ok(d.summary.includes('删除 / 覆盖数据'));
  assert.ok(Array.isArray(d.reasons) && d.reasons.length > 0);
});

test('describe 只读动作给出非红线 L0 文案', () => {
  const d = mod.describe({ action: 'read', scope: 'project' });
  assert.strictEqual(d.isRedLine, false);
  assert.strictEqual(d.level, 'L0');
  assert.ok(d.summary.includes('只读 / 低风险'));
});

test('describe 项目内写入给出黄灯 L1 文案', () => {
  const d = mod.describe({ action: 'write', scope: 'project' });
  assert.strictEqual(d.level, 'L1');
  assert.strictEqual(d.isRedLine, false);
  assert.ok(d.summary.includes('有限影响'));
});

test('describe 自报破坏性触达 DESTRUCTIVE_SUMMARY 分支', () => {
  const d = mod.describe({ action: 'write', scope: 'project', isDestructive: true });
  assert.strictEqual(d.isRedLine, true);
  assert.strictEqual(d.level, 'L2');
  assert.strictEqual(d.summary, `红线操作：${mod.DESTRUCTIVE_SUMMARY}`);
});

test('describe 对 null fail-closed 返回 L2 红线', () => {
  const d = mod.describe(null);
  assert.strictEqual(d.isRedLine, true);
  assert.strictEqual(d.level, 'L2');
  assert.deepStrictEqual(d.reasons, ['意图缺失，按最高危处理']);
});

test('describe 对红线但无 label 的动作落到通用高危文案', () => {
  // write/system 是 L2，但 write 不在 RED_LINE_ACTION_LABELS，且未标 isDestructive
  const d = mod.describe({ action: 'write', scope: 'system' });
  assert.strictEqual(d.isRedLine, true);
  assert.strictEqual(d.summary, '红线操作：高危 / 不可逆，需明确确认');
});

test('describe 对取值即抛的 intent 实际会抛出（钉住真实行为，与文件头 fail-closed 相悖）', () => {
  const throwing = {
    get action() {
      throw new Error('getter-boom');
    },
  };
  assert.throws(() => mod.describe(throwing), /getter-boom/);
});
