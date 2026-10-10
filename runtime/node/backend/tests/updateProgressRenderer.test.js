'use strict';

/**
 * updateProgressRenderer —— 进度**行**的形状与收尾。
 *
 * 车道语义（一帧最多 +1%、真实值是权威、迟到只走一步）在
 * `tests/services/updateProgressRenderer.test.js` 里逐条锁死；本文件锁的是**行的形状**：
 * 账本片段（`50/100`，它是事实、不是进度条）、速率、TTY 覆写与 `finish()` 的终态文案、
 * 门关回退，以及**分母未知车道过 96 之后仍继续爬**（尾巴档）与**真实值到 100 不跳满**。
 *
 * 历史：本文件的数值断言原按「节拍器落地前」的契约写 —— 确定进度一帧就报真实值、不确定进度
 * 按数学曲线一次算到位。显示值改成「每次采样最多 +1%、攒下的时间丢弃」之后，那四处断言
 * 全部过期（`50%` 其实是首帧 0%、`10` 其实是 1、`30` 其实是 0、满格条其实是一格未填），
 * 于是按现在的契约重写，而不是把过期数字留着当绿。
 */

const { createProgressRenderer } = require('../src/services/updateProgressRenderer');

const TAIL_CAP = 99; // progressiveProgress.TAIL_CAP —— 未完成时能爬到的最高显示值
const STEP = 160; // RENDER_MS / STEP_MS（快速档每 1% 的耗时）
const SLOW = 1400; // 慢速档每 1%（过七成后）
const TAIL = 4000; // 尾巴档每 1%（过天花板后，一样在动）

function capture() {
  let value = '';
  return {
    output: {
      write(chunk) {
        value += String(chunk);
      },
    },
    read: () => value,
    /** 取走并清空 —— 逐次 render 的输出要分开断言，累积串里 slice(-N) 会读到上一行。 */
    take: () => {
      const v = value;
      value = '';
      return v;
    },
  };
}

/** 可推进的注入时钟 + 百分比读数（每次都从输出里现取，而不是猜）。 */
function harness(startMs, options) {
  const sink = capture();
  const state = { now: startMs };
  const renderer = createProgressRenderer(
    Object.assign({ isTTY: false, streamWidth: 80, output: sink.output, clock: () => state.now }, options || {}),
  );
  return {
    sink,
    renderer,
    tick(ms = STEP) {
      state.now += ms;
    },
    /** 取走并读**最后一行**的百分比（累积串里第一行是上一帧的数）。 */
    readPct: () => {
      const lines = sink.take().split('\n').filter(Boolean);
      const m = /(\d+)%/.exec(lines[lines.length - 1] || '');
      return m ? Number(m[1]) : NaN;
    },
  };
}

describe('Update Progress Renderer', () => {
  test('non-TTY 行含动作/目标/阶段与真实账本，百分比按渲染节拍 1% 1% 出', () => {
    const { sink, renderer, tick } = harness(1_000_000);
    const ev = { action: '更新', target: 'KhyOS', phase: '下载', completed: 50, total: 100, rate: 2048 };

    renderer.render(ev);
    // 账本（`50/100`）是事实，照实播报；条与百分比从 0 起 —— 一帧不画到 50%。
    expect(sink.take()).toBe('更新 · KhyOS · 下载 · 50/100 0% 2KiB/s\n');

    tick();
    renderer.render(ev);
    expect(sink.take()).toBe('更新 · KhyOS · 下载 · 50/100 1% 2KiB/s\n');
  });

  test('TTY 逐帧覆写同一行；finish() 以终态文案收尾（不补画 100% 的条）', () => {
    const sink = capture();
    const state = { now: 2_000_000 };
    const renderer = createProgressRenderer({
      isTTY: true,
      streamWidth: 80,
      output: sink.output,
      clock: () => state.now,
    });
    const ev = { action: '更新', target: 'KhyOS', phase: '下载', completed: 50, total: 100 };

    renderer.render(ev);
    state.now += STEP;
    renderer.render(ev);
    const lines = sink.read().split('\r');
    expect(lines[1]).toMatch(/^更新 · KhyOS · 下载 · \[-{16}\] 50\/100 0% /);
    expect(lines[2]).toMatch(/^更新 · KhyOS · 下载 · \[-{16}\] 50\/100 1% /);

    // 4 帧后条才开始出现实心格 —— 条宽 16、每格 6.25%，是「格」的粒度而非跳。
    for (let i = 0; i < 3; i += 1) {
      state.now += STEP;
      renderer.render(ev);
    }
    expect(sink.read().split('\r').pop()).toMatch(/\[#{1}-{15}\] 50\/100 4% /);

    renderer.finish({ status: '完成', message: '更新已安装 3/3' });
    expect(sink.read()).toMatch(/\r完成 · 更新已安装 3\/3.*\n$/);
    // 收尾是**一句终态文案**，不是一条 100% 的条 —— 条没了，也就没有那一跳。
    expect(sink.read()).not.toContain('100%');
  });

  test('unknown totals remain visibly in progress, with a paced percentage', () => {
    const sink = capture();
    const renderer = createProgressRenderer({ isTTY: false, output: sink.output });
    renderer.render({ action: '更新', target: 'GitHub Releases', phase: '连接' });
    // 分母未知时不再只吐一句静态的「进行中」——那句说不了还剩多远。渐进节拍补一个
    // 可数的推进刻度（整数百分比，按 1% 步长单调上涨），描述词仍然保留。
    expect(sink.read()).toMatch(/^更新 · GitHub Releases · 连接 · \d+% · 进行中\n$/);
  });

  test('分母未知：迟到多久也只走一步，绝不补足成几十个百分点', () => {
    const { renderer, tick, readPct } = harness(3_000_000);
    const ev = { action: '更新', target: 'KhyOS', phase: '校验' };

    renderer.render(ev);
    expect(readPct()).toBe(0);

    // 160ms → 恰好一步。
    tick(STEP);
    renderer.render(ev);
    expect(readPct()).toBe(1);

    // 迟到 1.6 秒 / 10 分钟 → **仍然只走一步**（攒下的时间一律丢弃）。这是
    // 「不要一下就加载百分之几十」的拦口：缓过来的第一帧不会把窟窿一次性画出来。
    tick(1_600);
    renderer.render(ev);
    expect(readPct()).toBe(2);
    tick(600_000);
    renderer.render(ev);
    expect(readPct()).toBe(3);
  });

  test('分母未知：过 96 换尾巴档继续爬（不静止），且恒不出 100', () => {
    const { renderer, tick, readPct } = harness(4_000_000);
    const ev = { action: '更新', target: 'KhyOS', phase: '校验' };

    renderer.render(ev);
    readPct();
    // 快速档：70 帧 → 70%（每帧恰好 +1）。
    for (let i = 0; i < 70; i += 1) {
      tick(STEP);
      renderer.render(ev);
    }
    expect(readPct()).toBe(70);

    // 慢速档 26 步（1400ms/步）→ 96：`cap` 只是**换档点**，不是终点。
    for (let i = 0; i < 26; i += 1) {
      tick(SLOW);
      renderer.render(ev);
    }
    expect(readPct()).toBe(96);

    // 尾巴档 4000ms/1%：96 → 97 → 98 → 99 —— 长任务下它**还在动**，不会冻在一个数上
    // 等调用方一句「完成」再跳满。
    tick(TAIL);
    renderer.render(ev);
    expect(readPct()).toBe(97);
    tick(TAIL);
    renderer.render(ev);
    expect(readPct()).toBe(98);
    tick(TAIL);
    renderer.render(ev);
    expect(readPct()).toBe(99);
    tick(600_000);
    renderer.render(ev);
    expect(readPct()).toBe(TAIL_CAP); // 没有真实完成就绝不显示 100%
  });

  test('门关(KHY_PROGRESS_PACED=0)逐字节回退到静态描述词', () => {
    const sink = capture();
    const renderer = createProgressRenderer({
      isTTY: false,
      output: sink.output,
      env: { KHY_PROGRESS_PACED: '0' },
    });
    renderer.render({ action: '更新', target: 'GitHub Releases', phase: '连接' });
    expect(sink.read()).toBe('更新 · GitHub Releases · 连接 · 进行中\n');
  });

  test('分母已知：1% 1% 追真实值，追平即停，永不越过', () => {
    const { sink, renderer, tick, readPct } = harness(5_000_000);
    const ev = { action: '更新', target: 'KhyOS', phase: '下载', completed: 30, total: 100 };

    renderer.render(ev);
    expect(readPct()).toBe(0); // 账本 30/100 照实播报，条从 0 起（一帧不到 30）
    for (let i = 0; i < 30; i += 1) {
      tick();
      renderer.render(ev);
    }
    expect(readPct()).toBe(30);

    // 真值没动 → 显示值也不动（确定进度车道不靠节拍虚增；真实值才是权威）。
    tick(100_000);
    renderer.render(ev);
    expect(readPct()).toBe(30);

    renderer.finish({ status: '完成', message: '更新已安装 3/3' });
    expect(sink.read()).toMatch(/完成 · 更新已安装 3\/3\n$/);
  });

  test('分母已知：真实值到 100 也不跳 —— 仍 1% 1% 走完（收尾走快速档）', () => {
    const { renderer, tick, readPct } = harness(7_000_000);
    const at = (completed) => ({ action: '更新', target: 'KhyOS', phase: '下载', completed, total: 100 });

    renderer.render(at(90));
    readPct(); // 首帧 0
    // 快速档 70 帧（160ms/1%）→ 70%。
    for (let i = 0; i < 70; i += 1) {
      tick(STEP);
      renderer.render(at(90));
    }
    expect(readPct()).toBe(70);
    // 过七成换慢速档 1400ms/1% —— 真实值 90 还要 20 步。
    for (let i = 0; i < 20; i += 1) {
      tick(SLOW);
      renderer.render(at(90));
    }
    expect(readPct()).toBe(90);

    // 真实值一跃到 100：同一瞬间显示值**不动**（旧的「一帧满格」正是在这里发生的）。
    renderer.render(at(100));
    expect(readPct()).toBe(90);

    // 收尾改走快速档：90 → 100 十步，每步 160ms —— 一帧一格，不跳。
    for (let i = 0; i < 9; i += 1) {
      tick();
      renderer.render(at(100));
    }
    expect(readPct()).toBe(99);
    tick();
    renderer.render(at(100));
    expect(readPct()).toBe(100);
  });
});