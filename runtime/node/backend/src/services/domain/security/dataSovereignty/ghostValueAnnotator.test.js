'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GhostValueAnnotator,
  GhostPollutionError,
  GHOST_MARK
} = require('./ghostValueAnnotator.js');

const a = new GhostValueAnnotator();

test('GHOST_MARK 常量就是 __ghost', () => {
  assert.equal(GHOST_MARK, '__ghost');
});

test('annotate 产出完整只读幽灵（P3 落败被 P1 否决）', () => {
  const ghost = a.annotate(
    { param: 'temperature', value: 0.7, source: 'model-reasoning', tier: 'P3' },
    { source: 'user-directive', tier: 'P1' }
  );
  assert.deepEqual(ghost, {
    __ghost: true,
    param: 'temperature',
    ghost_value: 0.7,
    source: 'model-reasoning',
    tier: 'P3',
    tierLabel: '推理演算',
    reason: '被更高主权阶层 P1(意志注入) 否决——保留供模型反思，不参与执行',
    overriddenBy: { source: 'user-directive', tier: 'P1' },
    readOnly: true,
  });
  assert.equal(Object.isFrozen(ghost), true);
});

test('annotate 冻结后写入即抛（严格模式下副作用被物理屏障挡住）', () => {
  const ghost = a.annotate({ param: 'p', value: 1, source: 's', tier: 'P3' }, { source: 'w', tier: 'P1' });
  assert.throws(() => {
    ghost.param = 'hacked';
  }, TypeError);
  assert.throws(() => {
    ghost.extra = 1;
  }, TypeError);
  assert.equal(ghost.param, 'p');
});

test('annotate 对 param 做 String 归一（数字 0 变 "0"）', () => {
  const ghost = a.annotate({ param: 0, value: 'v', source: 's', tier: 'P3' }, { source: 'w', tier: 'P1' });
  assert.equal(ghost.param, '0');
  assert.equal(ghost.ghost_value, 'v');
});

test('annotate 缺 winner 时溯源字段是 undefined（键仍存在，非空对象）', () => {
  const ghost = a.annotate({ param: 'p', value: 2, source: 's', tier: 'P3' });
  assert.deepEqual(Object.keys(ghost.overriddenBy), ['source', 'tier']);
  assert.equal(ghost.overriddenBy.source, undefined);
  assert.equal(ghost.overriddenBy.tier, undefined);
  assert.equal(ghost.reason, '被更高主权阶层 ?(未知阶层) 否决——保留供模型反思，不参与执行');
});

test('annotate winner 传字符串（非对象）时不抛错，溯源两键皆为 undefined', () => {
  const ghost = a.annotate({ param: 'p', value: 2, source: 's', tier: 'P3' }, 'w');
  assert.equal(ghost.overriddenBy.source, undefined);
  assert.equal(ghost.overriddenBy.tier, undefined);
});

test('KNOWN-DEFECT: annotate 的 source || 回退吞掉合法空串与 0', () => {
  // input source '' -> measured 'unknown'; input source 0 -> measured 'unknown'
  assert.equal(a.annotate({ param: 'p', value: 1, source: '', tier: 'P3' }).source, 'unknown');
  assert.equal(a.annotate({ param: 'p', value: 1, source: 0, tier: 'P3' }).source, 'unknown');
  assert.equal(a.annotate({ param: 'p', value: 1, source: false, tier: 'P3' }).source, 'unknown');
  assert.equal(a.annotate({ param: 'p', value: 1, source: 'real', tier: 'P3' }).source, 'real');
});

test('KNOWN-DEFECT: winner.tier 为数字 0 时被 reason 里的 || 吞成 "?"，但 overriddenBy 仍保留 0', () => {
  const ghost = a.annotate({ param: 'p', value: 1, source: 's', tier: 'P3' }, { source: 'w', tier: 0 });
  assert.equal(ghost.overriddenBy.tier, 0);
  assert.equal(ghost.reason, '被更高主权阶层 ?(未知阶层) 否决——保留供模型反思，不参与执行');
});

test('KNOWN-DEFECT: annotate 传数字阶层时 tier 原样保留但标签是"未知阶层"（阶层只认字符串 P0-P4）', () => {
  const ghost = a.annotate({ param: 'p', value: 1, source: 's', tier: 3 }, { source: 'w', tier: 1 });
  assert.equal(ghost.tier, 3);
  assert.equal(ghost.tierLabel, '未知阶层');
  assert.equal(ghost.reason, '被更高主权阶层 1(未知阶层) 否决——保留供模型反思，不参与执行');
});

test('KNOWN-DEFECT: annotate 对字符串入参不抛错，反而产出 param "undefined" 的幽灵', () => {
  // input 'str' -> measured no-throw, param 'undefined', ghost_value undefined
  const ghost = a.annotate('str');
  assert.equal(ghost.param, 'undefined');
  assert.equal(ghost.ghost_value, undefined);
  assert.equal(ghost.source, 'unknown');
  assert.equal(ghost.tierLabel, '未知阶层');
});

test('KNOWN-DEFECT: annotate(undefined) 抛出属性读取 TypeError 而非契约错误', () => {
  assert.throws(() => a.annotate(null), {
    name: 'TypeError',
    message: "Cannot read properties of null (reading 'param')",
  });
  assert.throws(() => a.annotate(undefined), {
    name: 'TypeError',
    message: "Cannot read properties of undefined (reading 'param')",
  });
});

test('shouldDemote 只对 P0-P3 为真，P4 与非法阶层为假', () => {
  assert.equal(a.shouldDemote('P0'), true);
  assert.equal(a.shouldDemote('P3'), true);
  assert.equal(a.shouldDemote('P4'), false);
  assert.equal(a.shouldDemote('P9'), false);
  assert.equal(a.shouldDemote(undefined), false);
  assert.equal(a.shouldDemote(3), false);
});

test('isGhost 只认 __ghost === true', () => {
  assert.equal(a.isGhost(null), false);
  assert.equal(a.isGhost(undefined), false);
  assert.equal(a.isGhost(0), false);
  assert.equal(a.isGhost('s'), false);
  assert.equal(a.isGhost({}), false);
  assert.equal(a.isGhost({ __ghost: 1 }), false);
  assert.equal(a.isGhost({ __ghost: true }), true);
  assert.equal(a.isGhost(a.annotate({ param: 'p', value: 1, source: 's', tier: 'P3' })), true);
});

test('buildGhostBag 按 param 分桶、同 param 追加、P4 静默丢弃', () => {
  const bag = a.buildGhostBag(
    [
      { param: 'p', value: 1, source: 'x', tier: 'P3' },
      { param: 'p', value: 9, source: 'y', tier: 'P2' },
      { param: 'r', value: 3, source: 'z', tier: 'P4' },
    ],
    { p: { source: 'w', tier: 'P1' } }
  );
  assert.deepEqual(Object.keys(bag), ['p']);
  assert.equal(bag.p.length, 2);
  assert.equal(bag.p[0].ghost_value, 1);
  assert.equal(bag.p[0].tierLabel, '推理演算');
  assert.deepEqual(bag.p[0].overriddenBy, { source: 'w', tier: 'P1' });
  // second entry shares the same param, so it reuses that param's winner row
  assert.deepEqual(bag.p[1].overriddenBy, { source: 'w', tier: 'P1' });
  assert.equal(bag.p[1].tierLabel, '环境语境');
  assert.equal(Object.isFrozen(bag.p[0]), true);
});

test('KNOWN-DEFECT: 落败阶层 P0/P1/P2 同样入袋（JSDoc 声称"仅 P3 及以上"）', () => {
  const bag = a.buildGhostBag([
    { param: 'a', value: 1, source: 's', tier: 'P0' },
    { param: 'b', value: 2, source: 's', tier: 'P1' },
    { param: 'c', value: 3, source: 's', tier: 'P2' },
    { param: 'd', value: 4, source: 's', tier: 'P4' },
  ]);
  assert.deepEqual(Object.keys(bag), ['a', 'b', 'c']);
});

test('KNOWN-DEFECT: buildGhostBag 的 bag[param] 原型键查找让 param=constructor/toString/__proto__ 直接抛 TypeError', () => {
  for (const param of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    assert.throws(
      () => a.buildGhostBag([{ param, value: 1, source: 's', tier: 'P3' }]),
      (err) => {
        assert.equal(err.name, 'TypeError');
        assert.match(err.message, /push is not a function/);
        return true;
      },
      `expected throw for param ${param}`
    );
  }
});

test('buildGhostBag 空数组得空袋；null/undefined 抛不可迭代；字符串可迭代但不抛', () => {
  assert.deepEqual(a.buildGhostBag([]), {});
  assert.throws(() => a.buildGhostBag(null), { name: 'TypeError', message: 'defeatedList is not iterable' });
  assert.throws(() => a.buildGhostBag(), { name: 'TypeError', message: 'defeatedList is not iterable' });
  // 'ab' iterates single chars, each lacking tier -> nothing demoted
  assert.deepEqual(a.buildGhostBag('ab'), {});
});

test('sanitizeForExecution 无幽灵时返回冻结副本', () => {
  const clean = a.sanitizeForExecution({ x: 1, y: 'str' });
  assert.deepEqual(clean, { x: 1, y: 'str' });
  assert.equal(Object.isFrozen(clean), true);
  assert.throws(() => {
    clean.x = 2;
  }, TypeError);
  assert.deepEqual(a.sanitizeForExecution(), {});
});

test('sanitizeForExecution 幽灵渗入即抛 GhostPollutionError（含部位与 code）', () => {
  const ghost = a.annotate({ param: 'y', value: 1, source: 's', tier: 'P3' }, { source: 'w', tier: 'P1' });
  let caught;
  try {
    a.sanitizeForExecution({ ok: 1, y: ghost });
  } catch (err) {
    caught = err;
  }
  assert.equal(caught instanceof GhostPollutionError, true);
  assert.equal(caught instanceof Error, true);
  assert.equal(caught.name, 'GhostPollutionError');
  assert.equal(caught.code, 'ERR_GHOST_POLLUTION');
  assert.equal(caught.param, 'y');
  assert.equal(
    caught.message,
    '幽灵污染：参数 "y" 的执行值是只读 ghost_value，绝无权限参与逻辑流转（防呆②）'
  );
});

test('sanitizeForExecution 对手搓的 {__ghost:true} 同样拦截（只认标记不认出身）', () => {
  assert.throws(
    () => a.sanitizeForExecution({ z: { __ghost: true, ghost_value: 5 } }),
    { name: 'GhostPollutionError', param: 'z' }
  );
});

test('GhostPollutionError 直接构造时 message/param 一致', () => {
  const e = new GhostPollutionError('temp');
  assert.equal(e.param, 'temp');
  assert.equal(e.code, 'ERR_GHOST_POLLUTION');
  assert.match(e.message, /参数 "temp"/);
});
