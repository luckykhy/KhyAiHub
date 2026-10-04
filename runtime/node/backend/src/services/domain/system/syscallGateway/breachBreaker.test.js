'use strict';

/**
 * breachBreaker.test.js — 越权熔断器契约（会话级、纯内存、killer 可注入，无真实进程操作）。
 *
 * fail 方向：**fail-closed 优先于一切**——跳闸后 shouldBlock() 恒 true（连 L0 也不放）。
 * 旁路注入零容忍（一次即跳闸）；L2 被拒累计达阈值跳闸；跳闸幂等不可在会话内自愈，仅 reset 归零。
 * 所有 killer 均为注入的假函数，绝不调用真实 process.kill。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { BreachBreaker } = require('./breachBreaker');

test('新建熔断器初始未跳闸、shouldBlock=false', () => {
  const b = new BreachBreaker();
  assert.strictEqual(b.tripped, false);
  assert.strictEqual(b.reason, null);
  assert.strictEqual(b.shouldBlock(), false);
});

test('reportBypass 空数组/null 不跳闸', () => {
  const b = new BreachBreaker();
  assert.strictEqual(b.reportBypass([]), false);
  assert.strictEqual(b.reportBypass(null), false);
  assert.strictEqual(b.tripped, false);
});

test('reportBypass 非空标记一次即跳闸（零容忍）', () => {
  const b = new BreachBreaker();
  assert.strictEqual(b.reportBypass(['key:force']), true);
  assert.strictEqual(b.tripped, true);
  assert.ok(b.reason.includes('key:force'));
  assert.strictEqual(b.shouldBlock(), true);
});

test('跳闸后重复 reportBypass 幂等，reason 不被覆盖', () => {
  const b = new BreachBreaker();
  b.reportBypass(['a']);
  assert.strictEqual(b.reportBypass(['b']), true);
  assert.ok(b.reason.includes('a'));
});

test('reportDeniedL2 累计达默认阈值 3 才跳闸', () => {
  const b = new BreachBreaker();
  assert.strictEqual(b.reportDeniedL2(), false);
  assert.strictEqual(b.reportDeniedL2(), false);
  assert.strictEqual(b.reportDeniedL2(), true);
  assert.ok(b.reason.includes('反复硬闯'));
});

test('reportDeniedL2 达阈值后再报不重复跳闸', () => {
  const b = new BreachBreaker({ l2RetryThreshold: 1 });
  assert.strictEqual(b.reportDeniedL2(), true);
  assert.strictEqual(b.tripped, true);
});

test('非法 l2RetryThreshold 回退默认 3', () => {
  const b = new BreachBreaker({ l2RetryThreshold: 0 });
  assert.strictEqual(b.reportDeniedL2(), false);
  assert.strictEqual(b.reportDeniedL2(), false);
  assert.strictEqual(b.reportDeniedL2(), true);
});

test('跳闸时以注入 killer 清场登记在册子进程', () => {
  const killed = [];
  const b = new BreachBreaker({ killer: (pid) => killed.push(pid) });
  b.registerChild(100);
  b.registerChild(200);
  b.reportBypass(['x']);
  assert.deepStrictEqual(killed.sort((a, c) => a - c), [100, 200]);
});

test('registerChild 忽略非法 pid，unregisterChild 移除合法 pid', () => {
  const killed = [];
  const b = new BreachBreaker({ killer: (pid) => killed.push(pid) });
  b.registerChild(-1);
  b.registerChild(0);
  b.registerChild('x');
  b.registerChild(300);
  b.unregisterChild(300);
  b.reportBypass(['x']);
  assert.deepStrictEqual(killed, []);
});

test('killer 抛错被吞掉，跳闸照常完成', () => {
  const b = new BreachBreaker({ killer: () => { throw new Error('killer boom'); } });
  b.registerChild(5);
  assert.strictEqual(b.reportBypass(['x']), true);
  assert.strictEqual(b.tripped, true);
});

test('onTrip 回调收到原因；回调抛错被吞', () => {
  const seen = [];
  const b1 = new BreachBreaker({ onTrip: (m) => seen.push(m) });
  b1.reportBypass(['z']);
  assert.strictEqual(seen.length, 1);
  assert.ok(seen[0].includes('z'));

  const b2 = new BreachBreaker({ onTrip: () => { throw new Error('cb'); } });
  assert.strictEqual(b2.reportBypass(['q']), true);
  assert.strictEqual(b2.tripped, true);
});

test('reset 归零熔断状态与被拒计数', () => {
  const b = new BreachBreaker();
  b.reportBypass(['x']);
  b.reset();
  assert.strictEqual(b.tripped, false);
  assert.strictEqual(b.reason, null);
  assert.strictEqual(b.shouldBlock(), false);
  // 被拒 L2 计数也归零：再报 2 次不跳闸
  assert.strictEqual(b.reportDeniedL2(), false);
  assert.strictEqual(b.reportDeniedL2(), false);
});
