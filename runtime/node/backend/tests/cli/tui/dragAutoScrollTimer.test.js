'use strict';

// dragAutoScrollTimer —— 拖选时「指针停在视口边缘」的**持续**滚动契约。
//
// 背景(2026-09-24 用户主诉「我需要流畅的[单]选滚动页面复制」):
//   1002 只在指针**位置变化**时上报位移。只靠「每个位移事件滚一格」的实现,在指针
//   停住(或拖出窗口)的那一刻就再也不会滚 —— 跨页选择于是要么做不到、要么得不停
//   抖动鼠标。这个叶子负责把「指针停在边缘」这个事实变成**持续**的滚动。
//
// 最有价值的断言不是 happy path,而是**边界**:
//   H2  delta 0(指针离开边缘 / 已滚到底)必须**停表** —— 不停表会让视口在用户
//       松手后继续自己滚。
//   H3  同方向重复 note 不得重启 —— 重启会把节拍归零,「连续位移 + 定时器」互相
//       打断,反而更不流畅(这是把「修好」变成「更卡」的经典写法)。
//   H5  onRepeat 抛异常必须停表 —— 定时器里抛出去会打到 ink 的渲染循环上。
//   H7  接线断言:App.js 必须真的在 move 分支喂 delta、在 up/cancel 分支停表。
//       历史故障正是「叶子写好了但没人调」——各层单测全绿,行为一点没变。
//
// `node --test`。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_INTERVAL_MS, createHoldScroller } = require('../../../src/cli/tui/dragAutoScrollTimer');

/** 确定性假定时器:不 sleep 真实时间,可精确断言「表在不在走」。 */
function fakeTimers() {
  let seq = 0;
  const timers = new Map();
  return {
    setTimer(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    /** 触发当前所有活着的表一次(死掉的表已从 map 移除,天然不会被触发)。 */
    tick() {
      const live = [...timers.values()];
      for (const t of live) t.fn();
      return live.length;
    },
    live: () => timers.size,
    intervals: () => [...timers.values()].map((t) => t.ms),
  };
}

test('H-01: 未见过边缘(delta 0)时不起表 —— 中段拖动不该有任何定时器', () => {
  const ft = fakeTimers();
  const sc = createHoldScroller({ onRepeat: () => {}, ...ft });
  assert.equal(sc.note(0), false);
  assert.equal(sc.active(), false);
  assert.equal(ft.live(), 0, '指针不在边缘时起表 = 视口会自己滚');
});

test('H-02: delta ±1 起表,并按 dir 反复回调(指针不动也能持续滚)', () => {
  const ft = fakeTimers();
  const dirs = [];
  const sc = createHoldScroller({ onRepeat: (d) => dirs.push(d), ...ft });
  assert.equal(sc.note(1), true);
  assert.equal(sc.active(), true);
  assert.deepEqual(ft.intervals(), [DEFAULT_INTERVAL_MS], '默认节拍必须是 60ms(见叶子常量注释)');
  ft.tick();
  ft.tick();
  ft.tick();
  assert.deepEqual(dirs, [1, 1, 1], '指针停在边缘 → 每次 tick 都要继续滚');
});

test('H-03: 同方向重复 note **不重启**(重启会把节拍归零,反而更卡)', () => {
  const ft = fakeTimers();
  const dirs = [];
  const sc = createHoldScroller({ onRepeat: (d) => dirs.push(d), ...ft });
  sc.note(1);
  const firstHandleAlive = ft.live();
  sc.note(1);
  sc.note(1);
  assert.equal(ft.live(), firstHandleAlive, '重复同向 note 不得再起一个表(泄漏)');
  ft.tick();
  assert.deepEqual(dirs, [1], '只应有一个表在跑');
});

test('H-04: 指针离开边缘(delta 0)必须停表 —— 否则松手后视口继续自己滚', () => {
  const ft = fakeTimers();
  let n = 0;
  const sc = createHoldScroller({ onRepeat: () => { n++; }, ...ft });
  sc.note(1);
  ft.tick();
  assert.equal(n, 1);
  assert.equal(sc.note(0), false);
  assert.equal(sc.active(), false);
  assert.equal(ft.live(), 0);
  ft.tick();
  assert.equal(n, 1, '停表后不得再回调');
});

test('H-05: 方向翻转必须换表(向下滚到向上滚)', () => {
  const ft = fakeTimers();
  const dirs = [];
  const sc = createHoldScroller({ onRepeat: (d) => dirs.push(d), ...ft });
  sc.note(1);
  sc.note(-1);
  assert.equal(sc.dir(), -1);
  ft.tick();
  assert.deepEqual(dirs, [-1]);
});

test('H-06: onRepeat 抛异常 → 自动停表(定时器里抛出去会打到 ink 渲染循环)', () => {
  const ft = fakeTimers();
  const sc = createHoldScroller({
    onRepeat: () => { throw new Error('boom'); },
    ...ft,
  });
  sc.note(1);
  assert.doesNotThrow(() => ft.tick());
  assert.equal(sc.active(), false, '抛过一次之后必须停表,不能每 60ms 抛一次');
});

test('H-07: 垃圾入参不抛;intervalMs 非法值回落到默认', () => {
  const ft = fakeTimers();
  const sc = createHoldScroller({ onRepeat: () => {}, intervalMs: -5, ...ft });
  assert.doesNotThrow(() => {
    sc.note(undefined);
    sc.note('x');
    sc.note(null);
    sc.note(NaN);
  });
  sc.note(1);
  assert.deepEqual(ft.intervals(), [DEFAULT_INTERVAL_MS]);
  assert.doesNotThrow(() => { sc.stop(); sc.stop(); });
  assert.equal(sc.active(), false);
});

test('H-08: 没有 onRepeat 时不得留下空转的表', () => {
  const ft = fakeTimers();
  const sc = createHoldScroller({ ...ft });
  sc.note(1);
  ft.tick();
  assert.equal(sc.active(), false, '没接回调的表只会空转,必须在第一次 tick 后停掉');
});

// ── H9:接线断言(源码级)─────────────────────────────────────────────────────
// 「叶子写好了但没人调」是本仓反复出现的失败形态:各层单测全绿、行为一点没变。
// 这条盯的是**默认路径真的接上了** —— 与 viewportDragEdgeScroll 的 T6 同一范式。
test('H-09: App.js 必须真的喂 delta 并在松手/取消时停表', () => {
  const app = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'src', 'cli', 'tui', 'ink-components', 'App.js'),
    'utf8'
  );
  assert.match(app, /createHoldScroller\(/, '必须构造 hold-to-scroll 表');
  assert.match(app, /hold\.note\(drag\.delta\)/, 'move 分支必须把边缘判定喂给表(否则表永远不转)');
  const up = app.slice(app.indexOf("if (kind === 'up')"));
  assert.match(up.slice(0, 2000), /_stopHoldScroll\(\)/, '松手必须停表');
  const cancel = app.slice(app.indexOf("if (kind === 'cancel')"));
  assert.match(cancel.slice(0, 800), /_stopHoldScroll\(\)/, '取消必须停表');
  assert.match(app, /_stopHoldScroll\(\);\s*\n\s*\/\/ BUG-18/, 'down 分支也要先停上一个手势遗留的表');
});

test('H-10: 丢事件兜底 —— 连续 tick 到上限必须自己停(否则流式内容会让视口无限滚)', () => {
  const ft = fakeTimers();
  let n = 0;
  const sc = createHoldScroller({ onRepeat: () => { n++; }, maxTicks: 5, ...ft });
  sc.note(1);
  for (let i = 0; i < 20; i++) ft.tick();
  assert.equal(n, 5, '上限之后不得再回调');
  assert.equal(sc.active(), false, '上限必须停表,不能只靠「滚到底」这个自然终止');
  assert.equal(ft.live(), 0);
});

test('H-11: 停表后再起表,失控计数必须归零(不能把上次的 tick 攒着)', () => {
  const ft = fakeTimers();
  let n = 0;
  const sc = createHoldScroller({ onRepeat: () => { n++; }, maxTicks: 3, ...ft });
  sc.note(1);
  ft.tick();
  ft.tick();
  sc.note(0); // 指针离开边缘
  sc.note(1); // 又回到边缘 —— 计数应从 0 开始
  ft.tick();
  ft.tick();
  ft.tick();
  assert.equal(n, 5, '第二次起表应有完整的 3 次配额');
});
