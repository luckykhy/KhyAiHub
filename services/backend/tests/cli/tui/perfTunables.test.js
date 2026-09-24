'use strict';

// perfTunables.test — the TUI timer cadence tunables leaf.
// Pure leaf: no IO, deterministic. Covers: defaults, per-knob env overrides,
// garbage rejection (NaN/0/negative/empty string), the KHY_TUI_LOW_POWER
// umbrella, and per-knob env winning over the umbrella.

const test = require('node:test');
const assert = require('node:assert');

const {
  spinnerFrameMs,
  heartbeatMs,
  heartbeatAlignDelayMs,
  topicBarAnimMs,
  suspendSettleMs,
  INK_THROTTLE_MS,
} = require('../../../src/cli/tui/perfTunables');

test('defaults (env unset): 160 / 1000 / 320', () => {
  assert.equal(spinnerFrameMs({}), 160);
  assert.equal(heartbeatMs({}), 1000);
  assert.equal(topicBarAnimMs({}), 320);
});

test('per-knob env overrides accept any finite positive number', () => {
  assert.equal(spinnerFrameMs({ KHY_SPINNER_FRAME_MS: '100' }), 100);
  assert.equal(heartbeatMs({ KHY_HEARTBEAT_MS: '1500' }), 1500);
  assert.equal(topicBarAnimMs({ KHY_TOPIC_BAR_ANIM_MS: '250' }), 250);
  // Non-integers are finite positives too — accepted as-is.
  assert.equal(spinnerFrameMs({ KHY_SPINNER_FRAME_MS: '82.5' }), 82.5);
});

test('garbage values (NaN/0/negative/empty) fall back to defaults', () => {
  for (const v of ['abc', 'NaN', '0', '-50', '', '  ', 'Infinity ms']) {
    assert.equal(spinnerFrameMs({ KHY_SPINNER_FRAME_MS: v }), 160, `spinner garbage ${JSON.stringify(v)}`);
    assert.equal(heartbeatMs({ KHY_HEARTBEAT_MS: v }), 1000, `heartbeat garbage ${JSON.stringify(v)}`);
    assert.equal(topicBarAnimMs({ KHY_TOPIC_BAR_ANIM_MS: v }), 320, `topicBar garbage ${JSON.stringify(v)}`);
  }
  // Infinity is positive but NOT finite — rejected too.
  assert.equal(spinnerFrameMs({ KHY_SPINNER_FRAME_MS: 'Infinity' }), 160);
});

test('KHY_TUI_LOW_POWER=1 umbrella relaxes the cadence defaults to 320 / 2000 / 640', () => {
  const env = { KHY_TUI_LOW_POWER: '1' };
  assert.equal(spinnerFrameMs(env), 320);
  assert.equal(heartbeatMs(env), 2000);
  assert.equal(topicBarAnimMs(env), 640);
});

test('umbrella is strict "1": other writings do not activate it', () => {
  for (const v of ['true', 'on', 'yes', '0', '']) {
    const env = { KHY_TUI_LOW_POWER: v };
    assert.equal(spinnerFrameMs(env), 160, `umbrella writing ${JSON.stringify(v)}`);
    assert.equal(heartbeatMs(env), 1000);
    assert.equal(topicBarAnimMs(env), 320);
  }
});

test('explicit per-knob env wins over the LOW_POWER umbrella', () => {
  const env = {
    KHY_TUI_LOW_POWER: '1',
    KHY_SPINNER_FRAME_MS: '90',
    KHY_HEARTBEAT_MS: '1200',
    KHY_TOPIC_BAR_ANIM_MS: '200',
  };
  assert.equal(spinnerFrameMs(env), 90);
  assert.equal(heartbeatMs(env), 1200);
  assert.equal(topicBarAnimMs(env), 200);
});

test('garbage per-knob env under the umbrella falls back to the RELAXED default', () => {
  const env = { KHY_TUI_LOW_POWER: '1', KHY_SPINNER_FRAME_MS: 'garbage', KHY_HEARTBEAT_MS: '-1', KHY_TOPIC_BAR_ANIM_MS: '' };
  assert.equal(spinnerFrameMs(env), 320);
  assert.equal(heartbeatMs(env), 2000);
  assert.equal(topicBarAnimMs(env), 640);
});

test('default env argument (process.env) does not throw', () => {
  assert.ok(Number.isFinite(spinnerFrameMs()));
  assert.ok(Number.isFinite(heartbeatMs()));
  assert.ok(Number.isFinite(topicBarAnimMs()));
});

// ── heartbeatAlignDelayMs:整秒对齐(「时间 1s、1s 的跳」的可验证判据)─────────
// 用户原话:「时间应该 1s、1s 的跳,而不是一下跳几秒,保证计时的准确」。
// 心跳仅按固定相位跑时,回合起点 3.4s 会让读数在 4.0s 才进位 —— 本组断言把
// 「tick 恰好落在 started + N 整秒」这条不变量锁住。

test('heartbeatAlignDelayMs:下一次 tick 对齐到回合的下一整秒', () => {
  const started = 1_000_000;
  const cad = 1000;
  // 起跑后 0ms → 等满一个整秒
  assert.equal(heartbeatAlignDelayMs(started, started, cad), 1000);
  // 0.4s → 等 600ms 落整秒
  assert.equal(heartbeatAlignDelayMs(started + 400, started, cad), 600);
  // 0.999s → 等 1ms
  assert.equal(heartbeatAlignDelayMs(started + 999, started, cad), 1);
  // 恰好整秒(刚才已经 tick 过)→ 等下一个整秒,不是 0(否则会空转)
  assert.equal(heartbeatAlignDelayMs(started + 1000, started, cad), 1000);
  assert.equal(heartbeatAlignDelayMs(started + 3000, started, cad), 1000);
});

test('heartbeatAlignDelayMs:恒 ≤ cadence(绝不比原节奏更慢)', () => {
  const started = 500_000;
  for (const cad of [1000, 2000]) {
    for (let off = 0; off <= cad * 3; off += 37) {
      const d = heartbeatAlignDelayMs(started + off, started, cad);
      assert.ok(d > 0 && d <= cad, `off=${off} cad=${cad} → ${d}`);
    }
  }
});

test('heartbeatAlignDelayMs:回合未起跑 / 垃圾输入 → 回落 cadence', () => {
  assert.equal(heartbeatAlignDelayMs(Date.now(), 0, 1000), 1000);
  assert.equal(heartbeatAlignDelayMs(Date.now(), undefined, 1000), 1000);
  assert.equal(heartbeatAlignDelayMs(Date.now(), NaN, 1000), 1000);
  assert.equal(heartbeatAlignDelayMs(NaN, 12345, 1000), 1000);
  // 故障时钟:now 落后于 started → 回落 cadence,不产出负延迟
  assert.equal(heartbeatAlignDelayMs(1000, 99_000, 1000), 1000);
  // cadence 垃圾 → 回落 1000
  assert.equal(heartbeatAlignDelayMs(Date.now(), Date.now(), 0), 1000);
  assert.equal(heartbeatAlignDelayMs(Date.now(), Date.now(), 'x'), 1000);
});

test('heartbeatAlignDelayMs:整秒对齐的**累积**效果 —— tick 时刻=started+k*cad', () => {
  // 模拟:tick 完即用 leaf 重算下一次 delay ⇒ 每次落地都应恰好是整秒边界。
  const started = 1_726_000_000_000;
  const cad = 1000;
  let now = started + 340; // 回合起点与相位错开 340ms(真实情形)
  const landings = [];
  for (let i = 0; i < 5; i += 1) {
    now += heartbeatAlignDelayMs(now, started, cad);
    landings.push(now - started);
  }
  assert.deepEqual(landings, [1000, 2000, 3000, 4000, 5000]);
});

// ── suspendSettleMs:「挂起 live UI → app.clear()」的沉降屏障 ────────────────
// 这不是节奏参数而是**正确性屏障**:短于 ink 的节流窗口就会与迟到的 trailing 渲染
// 竞态,把刚擦掉的输入框 chrome 画回来(= 用户报的「/命令后输入框残影」)。

test('suspendSettleMs 默认 50ms,且严格大于 ink 的节流窗口', () => {
  assert.equal(INK_THROTTLE_MS, 34); // ink render 默认 maxFps 30 → ceil(1000/30)
  assert.equal(suspendSettleMs({}), 50);
  // 核心不变量:必须 > 34,否则 clear() 竞态复现。
  assert.ok(suspendSettleMs({}) > INK_THROTTLE_MS);
});

test('suspendSettleMs 回归护栏:历史 16ms 正是短于节流窗口的错值', () => {
  assert.ok(16 < INK_THROTTLE_MS, '16ms 小于 34ms 窗口 —— 这正是被修掉的 bug');
});

test('suspendSettleMs 接受任意有限正数覆盖', () => {
  assert.equal(suspendSettleMs({ KHY_TUI_SUSPEND_SETTLE_MS: '80' }), 80);
  assert.equal(suspendSettleMs({ KHY_TUI_SUSPEND_SETTLE_MS: '40.5' }), 40.5);
});

test('suspendSettleMs 垃圾值回落默认 50', () => {
  for (const v of ['abc', 'NaN', '0', '-10', '', '  ', 'Infinity']) {
    assert.equal(suspendSettleMs({ KHY_TUI_SUSPEND_SETTLE_MS: v }), 50, `garbage ${JSON.stringify(v)}`);
  }
});

test('suspendSettleMs 不受 LOW_POWER umbrella 放宽(它是屏障不是节奏)', () => {
  assert.equal(suspendSettleMs({ KHY_TUI_LOW_POWER: '1' }), 50);
});
