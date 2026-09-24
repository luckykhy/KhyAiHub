'use strict';

// bootPhaseLine 单测:守的是「引导进度行被别人的输出糊成一条永久半截行」这个回归。
// 实测症状:`  🔄 准备运行环境 ...  ℹ 已登录: mfplg075` —— 进度行用 \r 覆写、行尾不带
// 换行,光标停在行中间,后续 console 输出就从那里续写。所以每条 console 输出落地前,
// 必须先看到一次整行擦除。

const test = require('node:test');
const assert = require('node:assert');

const bootPhaseLine = require('../../src/cli/bootPhaseLine');
const { CLEAR_LINE, METHODS } = bootPhaseLine;

/**
 * 记录写入顺序的假流 + 假 console,完全不碰真实终端。
 * originals 是**接管之前**的那一组方法引用 —— 还原断言必须拿它比,拿接管后的快照比
 * 等于在断言「包装器等于包装器」,永远成立,守不住任何东西。
 */
function harness(env) {
  const writes = [];
  const calls = [];
  const sink = {};
  for (const m of METHODS) {
    sink[m] = (...args) => calls.push([m, args.join(' ')]);
  }
  // 假 stdout:winston 的 Console transport 与 inquirer 都从这里出去,绕开 console.*。
  const stdoutWrites = [];
  const out = {
    write: (s) => {
      stdoutWrites.push(String(s));
      return true;
    },
  };
  const originals = { ...sink, __stdoutWrite: out.write };
  const handle = bootPhaseLine.create({
    env: env || {},
    stream: { write: (s) => writes.push(s) },
    console: sink,
    stdout: out,
  });
  return { handle, writes, calls, sink, originals, out, stdoutWrites };
}

test('write 覆写同一行:回车打头、CSI K 收尾,不留换行', () => {
  const { handle, writes } = harness();
  handle.write('⏳ 加载环境配置');
  assert.deepStrictEqual(writes, ['\r  ⏳ 加载环境配置...\x1b[K']);
  handle.write('✓ 环境就绪');
  assert.strictEqual(writes[1], '\r  ✓ 环境就绪...\x1b[K');
  assert.ok(!writes.join('').includes('\n'), '进度行绝不能自己换行,否则不再是瞬时行');
});

test('进度行亮着时,任何 console 输出前先擦掉整行', () => {
  const { handle, writes, calls, sink } = harness();
  handle.write('🔄 准备运行环境');
  sink.log('  ℹ 已登录: someone');
  assert.deepStrictEqual(writes, ['\r  🔄 准备运行环境...\x1b[K', CLEAR_LINE]);
  // 让位只负责腾地方,输出本身必须原样透传给真 console。
  assert.deepStrictEqual(calls, [['log', '  ℹ 已登录: someone']]);
});

test('绕开 console 的 stdout 直写(winston / inquirer)同样先让位', () => {
  const { handle, writes, out, stdoutWrites } = harness();
  handle.write('⏳ 加载环境配置');
  out.write('2026-08-25 [warn] something happened\n');
  assert.deepStrictEqual(writes, ['\r  ⏳ 加载环境配置...\x1b[K', CLEAR_LINE]);
  assert.deepStrictEqual(stdoutWrites, ['2026-08-25 [warn] something happened\n']);
});

test('让完一次位就把 stdout 还原:最热的写入路径不带着包装层跑', () => {
  const { handle, out, originals } = harness();
  handle.write('⏳ 加载环境配置');
  assert.notStrictEqual(out.write, originals.__stdoutWrite, '亮着时应当挂着让位层');
  out.write('x');
  assert.strictEqual(out.write, originals.__stdoutWrite, '让完位必须立刻还原');
});

test('进度行熄灭期间不碰 stdout:只有亮着才挂让位层', () => {
  const { handle, out, originals } = harness();
  assert.strictEqual(out.write, originals.__stdoutWrite);
  handle.write('A');
  handle.end();
  assert.strictEqual(out.write, originals.__stdoutWrite, 'end() 之后 stdout 必须干净');
});

test('行已熄灭就不再重复擦:连续输出只在第一条前让位一次', () => {
  const { handle, writes, sink } = harness();
  handle.write('🔄 准备运行环境');
  sink.log('第一条');
  sink.warn('第二条');
  sink.error('第三条');
  assert.strictEqual(writes.filter((w) => w === CLEAR_LINE).length, 1);
});

test('重新点亮后再次让位:每一轮进度都能被下一条输出擦掉', () => {
  const { handle, writes, sink } = harness();
  handle.write('A');
  sink.log('x');
  handle.write('B');
  sink.info('y');
  assert.deepStrictEqual(writes, ['\r  A...\x1b[K', CLEAR_LINE, '\r  B...\x1b[K', CLEAR_LINE]);
});

test('end() 擦掉残留行并还原 console;之后 write 不再输出', () => {
  const { handle, writes, calls, sink, originals } = harness();
  // 接管确实发生过,否则下面的还原断言是空转。
  assert.notStrictEqual(sink.log, originals.log, 'create() 应当已接管 console.log');
  handle.write('✓ 就绪');
  handle.end();
  assert.strictEqual(writes[writes.length - 1], CLEAR_LINE);
  for (const m of METHODS) {
    assert.strictEqual(sink[m], originals[m], `${m} 必须还原成接管前的那一个`);
  }
  const writeCount = writes.length;
  handle.write('迟到的进度');
  assert.strictEqual(writes.length, writeCount, 'end() 之后不该再动终端');
  sink.log('之后的输出');
  assert.deepStrictEqual(calls, [['log', '之后的输出']]);
});

test('end() 可重复调用:进程 exit 兜底与交棒收尾不会互相踩', () => {
  const { handle, writes } = harness();
  handle.write('✓ 就绪');
  handle.end();
  const after = writes.length;
  handle.end();
  assert.strictEqual(writes.length, after);
});

test('行未点亮时 end() 不写多余的擦除序列', () => {
  const { handle, writes } = harness();
  handle.end();
  assert.deepStrictEqual(writes, []);
});

test('门控 KHY_BOOT_PHASE_LINE=0 → 空实现,既不输出也不接管 console', () => {
  const { handle, writes, calls, sink, originals, out } = harness({ KHY_BOOT_PHASE_LINE: '0' });
  handle.write('⏳ 加载环境配置');
  handle.end();
  assert.deepStrictEqual(writes, []);
  for (const m of METHODS) {
    assert.strictEqual(sink[m], originals[m], '门控关时不该碰 console');
  }
  assert.strictEqual(out.write, originals.__stdoutWrite, '门控关时不该碰 stdout');
  sink.log('直通');
  assert.deepStrictEqual(calls, [['log', '直通']]);
});

test('门控只认 0/false/off/no;其余值(含未设置)一律视为开', () => {
  assert.strictEqual(bootPhaseLine.isEnabled({}), true);
  assert.strictEqual(bootPhaseLine.isEnabled({ KHY_BOOT_PHASE_LINE: '1' }), true);
  assert.strictEqual(bootPhaseLine.isEnabled({ KHY_BOOT_PHASE_LINE: ' OFF ' }), false);
  assert.strictEqual(bootPhaseLine.isEnabled({ KHY_BOOT_PHASE_LINE: 'False' }), false);
  assert.strictEqual(bootPhaseLine.isEnabled({ KHY_BOOT_PHASE_LINE: 'no' }), false);
  assert.strictEqual(bootPhaseLine.isEnabled({ KHY_BOOT_PHASE_LINE: 'quiet' }), true);
});

test('流写入抛异常不外泄:终端关了也不能拖垮引导', () => {
  const out = { write() {} };
  const originalOut = out.write;
  const handle = bootPhaseLine.create({
    env: {},
    stream: {
      write: () => {
        throw new Error('EPIPE');
      },
    },
    console: { log() {}, info() {}, warn() {}, error() {} },
    stdout: out,
  });
  assert.doesNotThrow(() => handle.write('⏳ 加载环境配置'));
  // 进度行根本没写出去,就不该给 stdout 挂让位层(没有行需要让)。
  assert.strictEqual(out.write, originalOut);
  assert.doesNotThrow(() => handle.end());
});

// ── 实时百分比行（「进度必须实时显示」的落点）──────────────────────────────
// 为什么由本模块承担:启动最耗时的一段(ink 渲染引擎装载,实测 11.5s)发生在 Ink 挂载
// **之前** —— 启动屏依赖 ink,结构上不可能显示它。用户报的「启动页一开始就卡在 67%」
// 正是这段空白 + 启动屏一出场就 4/6 的组合。所以这段只能由瞬时行显示,且必须是实时百分比。

test('实时百分比行:给了百分比源就渲染条形 + 百分比', () => {
  const { handle, writes } = harness();
  let pct = 0;
  handle.write('⏳ 加载渲染引擎', 0, 0, () => pct);
  assert.strictEqual(writes[0], '\r  ⏳ 加载渲染引擎 ' + '░'.repeat(20) + ' 0%...\x1b[K');
  pct = 42;
  handle.write('⏳ 加载渲染引擎', 0, 0, () => pct);
  assert.ok(
    writes[1].includes('█'.repeat(8) + '░'.repeat(12) + ' 42%'),
    '条形应按 42% 填充，实测: ' + JSON.stringify(writes[1])
  );
});

test('实时百分比行:按 PERCENT_TICK_MS 重画(不是 1s 的 elapsed 时钟)', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { handle, writes } = harness();
  let pct = 10;
  handle.write('⏳ 加载渲染引擎', 0, 0, () => pct);
  pct = 20;
  t.mock.timers.tick(bootPhaseLine.PERCENT_TICK_MS);
  assert.ok(writes.length >= 2, '一个 tick 内必须已经重画过（否则百分比不是实时的）');
  assert.ok(
    writes[writes.length - 1].includes('20%'),
    '重画必须取到最新百分比，实测: ' + JSON.stringify(writes[writes.length - 1])
  );
  handle.end();
});

test('实时百分比行:源抛异常 / 返回非法值 → 回退到「已等待」文案,绝不外泄', () => {
  const { handle, writes } = harness();
  assert.doesNotThrow(() =>
    handle.write('⏳ 加载渲染引擎', 0, 0, () => {
      throw new Error('boom');
    })
  );
  assert.strictEqual(writes[0], '\r  ⏳ 加载渲染引擎...\x1b[K');
  handle.write('⏳ 加载渲染引擎', 0, 0, () => NaN);
  assert.strictEqual(writes[1], '\r  ⏳ 加载渲染引擎...\x1b[K');
  handle.write('⏳ 加载渲染引擎', 0, 0, () => undefined);
  assert.strictEqual(writes[2], '\r  ⏳ 加载渲染引擎...\x1b[K');
});

test('不给百分比源时逐字节回退到历史行为(3 参调用不变)', () => {
  const { handle, writes } = harness();
  handle.write('⏳ 加载环境配置', 1, 5);
  handle.write('✓ 就绪');
  assert.deepStrictEqual(writes, ['\r  ⏳ 加载环境配置 (1/5)...\x1b[K', '\r  ✓ 就绪...\x1b[K']);
});

test('百分比条:边界钳制,不因越界值抛 RangeError', () => {
  const bar = bootPhaseLine._renderPercentBar;
  assert.strictEqual(bar(-10), '░'.repeat(20));
  assert.strictEqual(bar(0), '░'.repeat(20));
  assert.strictEqual(bar(50), '█'.repeat(10) + '░'.repeat(10));
  assert.strictEqual(bar(100), '█'.repeat(20));
  assert.strictEqual(bar(999), '█'.repeat(20));
});

// ── openBootWindow：ink 装载窗口的一站式句柄（「一开始就卡在 67%」的接线点）────────
// 它的契约有两条是**硬**的，删掉任何一条就会退回「0.4s 后全黑 25s」的观感：
//   1. 首帧必须带实时百分比（不是光秃秃一行文案）；
//   2. phase()/close() 永不抛，且句柄恒非 null —— 一行显示绝不能拖垮启动。

/** 记录写入的假流，供 openBootWindow 的 options 注入。 */
function bootWindowHarness(env) {
  const writes = [];
  const sink = {};
  for (const m of METHODS) {
    sink[m] = () => {};
  }
  const handle = bootPhaseLine.openBootWindow('⏳ 加载渲染引擎', env || {}, {
    stream: { write: (s) => writes.push(s) },
    console: sink,
    stdout: { write: () => true },
  });
  return { handle, writes };
}

test('openBootWindow:首帧就带实时百分比条,并消费节拍真源', () => {
  const { handle, writes } = bootWindowHarness();
  assert.ok(writes.length >= 1, '开窗必须立刻落地一帧（否则装载窗口仍是黑的）');
  const first = writes[0];
  assert.ok(
    /\d+%/.test(first),
    '首帧必须带实时百分比（这是「进度必须实时显示」的落点），实测: ' + JSON.stringify(first)
  );
  assert.ok(/[█░]{20}/.test(first), '首帧必须带 20 格条形，实测: ' + JSON.stringify(first));
  handle.close();
});

test('openBootWindow:phase() 换文案后仍在同一行、仍带百分比', () => {
  const { handle, writes } = bootWindowHarness();
  handle.phase('⏳ 初始化界面');
  const last = writes[writes.length - 1];
  assert.ok(last.includes('初始化界面'), 'phase() 必须换掉阶段文案，实测: ' + JSON.stringify(last));
  assert.ok(/[█░]{20}/.test(last), '换文案后条形必须还在（否则进度视觉断了）');
  // 这条守的是真实踩过的坑：phase() 少带一次 percentSource，行就会退回「已等待 Xs」
  // 的 elapsed 时钟 —— 条形消失、秒表从头开始，用户看到的是「进度断了一下」。
  assert.ok(
    !/已等待/.test(last),
    'phase() 必须继续带百分比源，不得退回 elapsed 时钟，实测: ' + JSON.stringify(last)
  );
  assert.ok(last.startsWith('\r'), '必须仍是同一行的 \\r 覆写，不得换行');
  handle.close();
});

test('openBootWindow:门关时返回可用空操作句柄,两个方法都不抛', () => {
  const { handle, writes } = bootWindowHarness({ KHY_BOOT_PHASE_LINE: '0' });
  assert.strictEqual(typeof handle.phase, 'function');
  assert.strictEqual(typeof handle.close, 'function');
  assert.doesNotThrow(() => {
    handle.phase('⏳ 初始化界面');
    handle.close();
    handle.close(); // 幂等
  });
  assert.strictEqual(writes.length, 0, '门关时一行都不该写');
});

test('openBootWindow:close() 幂等、phase() 在 close 之后也不抛', () => {
  const { handle } = bootWindowHarness();
  handle.phase('⏳ 初始化界面');
  handle.close();
  assert.doesNotThrow(() => {
    handle.close();
    handle.phase('⏳ 再换一次');
  });
});

test('openBootWindow:close() 擦掉瞬时行并还原 console（Ink 接管的硬前提）', () => {
  const writes = [];
  const sink = { log: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const before = { ...sink };
  const handle = bootPhaseLine.openBootWindow('⏳ 加载渲染引擎', {}, {
    stream: { write: (s) => writes.push(s) },
    console: sink,
    stdout: { write: () => true },
  });
  assert.notStrictEqual(sink.log, before.log, '开窗期间必须接管 console.*');
  handle.close();
  assert.strictEqual(sink.log, before.log, 'close() 必须逐字节还原 console.*');
  assert.ok(
    writes[writes.length - 1] === CLEAR_LINE,
    'close() 最后一笔必须是整行擦除，实测: ' + JSON.stringify(writes[writes.length - 1])
  );
});
