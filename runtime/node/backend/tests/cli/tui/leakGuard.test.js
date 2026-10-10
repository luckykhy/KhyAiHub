'use strict';

// leakGuard.test — TUI 内存泄漏检测器（[MGMT-RPT-031] P1-5）。
//
// 可确定性断言的部分（diff 算术、WeakRef 分拣、gc 不可用的诚实路径）在这里
// 用 node:test 覆盖；「跑完整个 TUI 会话不涨 Timeout」的端到端断言留给
// CI 的 --expose-gc 作业（挂上后把 snapshotResources/diffResources 接到
// replSession 生命周期前后即可，本文件注释即契约）。

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const leakGuard = require(path.join(__dirname, '..', '..', '..', 'src', 'cli', 'tui', 'leakGuard'));

test('diffResources：净增即疑似泄漏，净减进 released', () => {
  const before = { byType: { Timeout: 2, Immediate: 1, Socket: 3 } };
  const after = { byType: { Timeout: 5, Immediate: 1, Socket: 1 } };
  const d = leakGuard.diffResources(before, after);
  assert.equal(d.clean, false);
  assert.deepEqual(d.leaked, [{ type: 'Timeout', delta: 3 }]);
  assert.deepEqual(d.released, [{ type: 'Socket', delta: 2 }]);
});

test('diffResources：全等 → clean', () => {
  const before = { byType: { Timeout: 2 } };
  const after = { byType: { Timeout: 2 } };
  const d = leakGuard.diffResources(before, after);
  assert.equal(d.clean, true);
  assert.equal(d.leaked.length, 0);
});

test('diffResources：新增类型（before 没有）也算净增', () => {
  const d = leakGuard.diffResources({ byType: {} }, { byType: { TCPSocketWrap: 2 } });
  assert.equal(d.clean, false);
  assert.deepEqual(d.leaked, [{ type: 'TCPSocketWrap', delta: 2 }]);
});

test('diffResources：缺字段/空快照不抛（fail-soft）', () => {
  assert.doesNotThrow(() => leakGuard.diffResources(null, null));
  assert.equal(leakGuard.diffResources(null, null).clean, true);
});

test('snapshotResources：活进程必有活动资源且含 at 时间戳', () => {
  const s = leakGuard.snapshotResources();
  assert.ok(s.total > 0, '活进程至少有当前执行帧一类资源');
  assert.ok(s.at);
  assert.equal(typeof s.byType, 'object');
});

test('createSweep：gc 不可用 → sweep 如实报 gcUnavailable，不假装测过', () => {
  const sweep = leakGuard.createSweep();
  const held = { label: 'always-held' };
  sweep.track(held, 'held-by-local');
  const out = sweep.sweep(); // 本进程未 --expose-gc
  if (!out.gcAvailable) {
    assert.equal(out.gcUnavailable, true);
    assert.equal(out.retained.length, 1);
    assert.match(out.retained[0].reason, /gc 不可用/);
  } else {
    // 有 gc 的运行时（--expose-gci 测试机）：held 被局部变量持有 → 仍在 retained
    assert.ok(out.retained.some((r) => r.label === 'held-by-local'));
  }
});

test('createSweep：track 非对象/空值静默忽略', () => {
  const sweep = leakGuard.createSweep();
  assert.doesNotThrow(() => {
    sweep.track(null);
    sweep.track(42);
    sweep.track(undefined, 'x');
  });
  const out = sweep.sweep();
  assert.equal(out.retained.length, 0);
});

test('createSweep：显式可回收对象在 gc 可用时被分拣为 collected', () => {
  if (typeof global.gc !== 'function') {
    // 无 --expose-gc 的常规运行时：验证「登记后不持引用，sweep 不崩」即可，
    // 回收判定留给 expose-gc 作业。
    const sweep = leakGuard.createSweep();
    sweep.track({ big: new Array(1000).fill(0) }, 'transient');
    const out = sweep.sweep();
    assert.ok(out.gcUnavailable === true || typeof out.collected === 'number');
    return;
  }
  let transient = { big: new Array(1000).fill(0) };
  const sweep = leakGuard.createSweep();
  sweep.track(transient, 'transient');
  transient = null;
  const out = sweep.sweep();
  assert.ok(out.collected >= 1, 'gc 可用时 transient 应被分拣为已回收');
});

test('renderDiff：clean 输出一句话，leak 输出明细', () => {
  assert.match(leakGuard.renderDiff({ clean: true, leaked: [], released: [] }), /零净增/);
  const d = leakGuard.renderDiff({ clean: false, leaked: [{ type: 'Timeout', delta: 3 }], released: [] });
  assert.match(d, /Timeout \+3/);
});
