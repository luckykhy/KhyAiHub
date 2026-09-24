'use strict';

/**
 * updateProgressRenderer —— 更新流程进度行的两条车道。
 *
 * 历史：本文件原有的用例毁于编码损坏（UTF-8 CJK 乱码让字符串字面量无法解析），
 * 当时没有任何可用的备份源，于是留了一个空壳保住套件可解析。空壳意味着**这个模块
 * 长期零覆盖** —— 本轮改「显示必须逐步渐进、不许一跳几十个百分点」时才暴露出来：
 * 分母已知的那条车道当时根本没被任何用例碰过。
 *
 * 下面是为**两条车道**重写的用例（不是找回原文，是针对现在的契约新写的）：
 *   · 分母未知 → 补一条 1% 1% 走的节拍条，而不是只打一句静态文案；
 *   · 分母已知 → 真实百分比是权威目标，显示值 1% 1% 地追它、永不越过，
 *     且**一帧最多 +1%**（真实 67% 不会在第一帧画出来）；
 *   · 门关 / 减少动效 → 逐字节回退到「只报真实值」的观感。
 *
 * 时钟与输出都可注入，故本套件**不起任何真实定时器**（isTTY:false 时渲染器不挂重绘节拍）。
 */

const { createProgressRenderer } = require('../../src/services/updateProgressRenderer');

const T0 = 1_700_000_000_000;
const STEP = 160; // RENDER_MS / STEP_MS

/** 收集 write() 的假输出。 */
function fakeOutput() {
  const chunks = [];
  return {
    chunks,
    write(s) {
      chunks.push(String(s));
      return true;
    },
    get text() {
      return chunks.join('');
    },
  };
}

/** 造一个时钟可推进的渲染器 + 假输出。 */
function makeRenderer(extra) {
  const output = fakeOutput();
  let now = T0;
  const renderer = createProgressRenderer(
    Object.assign(
      { isTTY: false, output, clock: () => now, streamWidth: 80 },
      extra || {},
    ),
  );
  return {
    output,
    renderer,
    /** 把时钟推 n 个渲染节拍（模拟「这套渲染器自持 RENDER_MS 重绘节拍」）。 */
    tick(n = 1) {
      now += n * STEP;
      return now;
    },
  };
}

const DETERMINATE_EVENT = {
  action: '更新',
  target: 'KhyOS',
  phase: '下载',
  completed: 67,
  total: 100,
};

describe('updateProgressRenderer · 分母未知车道（补一条 1% 1% 走的条）', () => {
  it('静态文案之外给出可数的推进刻度，且按渲染节拍每次 +1%', () => {
    const { renderer, output, tick } = makeRenderer();
    const event = { action: '更新', target: 'KhyOS', phase: '安装', progress: '第 2/3 阶段' };

    renderer.render(event);
    expect(output.chunks[0]).toContain('第 2/3 阶段'); // 描述词还在
    expect(output.chunks[0]).toMatch(/ 0%/); // 首帧 0%，不假装已经推进

    tick();
    renderer.render(event);
    expect(output.chunks[1]).toMatch(/ 1%/);

    tick();
    renderer.render(event);
    expect(output.chunks[2]).toMatch(/ 2%/);
  });

  it('迟到很久也只走一步 —— 不补足成几十个百分点', () => {
    const { renderer, output, tick } = makeRenderer();
    const event = { action: '更新', target: 'KhyOS', phase: '安装' };
    renderer.render(event);
    tick(200); // 推 200 个节拍（32 秒）后只再画一帧
    renderer.render(event);
    expect(output.chunks[1]).toMatch(/ 1%/);
  });
});

describe('updateProgressRenderer · 分母已知车道（真实值是权威目标，显示逐步追）', () => {
  it('一帧最多 +1%：真实 67% 不会在第一帧就被画出来', () => {
    const { renderer, output, tick } = makeRenderer();
    renderer.render(DETERMINATE_EVENT);
    // 真实账本（67/100）照实播报，但百分比与条宽由节拍器出。
    expect(output.chunks[0]).toContain('67/100');
    expect(output.chunks[0]).toMatch(/ 0%/);

    tick();
    renderer.render(DETERMINATE_EVENT);
    expect(output.chunks[1]).toMatch(/ 1%/);

    tick();
    renderer.render(DETERMINATE_EVENT);
    expect(output.chunks[2]).toMatch(/ 2%/);
  });

  it('逐帧逼近真实值，追平即停；未完成时绝不出 100', () => {
    const { renderer, output, tick } = makeRenderer();
    for (let i = 0; i < 80; i += 1) {
      renderer.render(DETERMINATE_EVENT);
      tick();
    }
    // 每帧 +1%：chunk[0] 是 0%，chunk[n] 就是 n%。67 步（≤70，走快速档）后追平真实值，
    // 此后不再增长。
    expect(output.chunks[67]).toMatch(/ 67%/);
    expect(output.chunks[79]).toMatch(/ 67%/);
    expect(output.text).not.toContain(' 100%');
  });

  it('迟到很久也只走一步（真实值 99 也不会一帧到位）', () => {
    const { renderer, output, tick } = makeRenderer();
    renderer.render({ action: '更新', target: 'KhyOS', phase: '校验', completed: 99, total: 100 });
    tick(500);
    renderer.render({ action: '更新', target: 'KhyOS', phase: '校验', completed: 99, total: 100 });
    expect(output.chunks[1]).toMatch(/ 1%/);
  });

  it('真实值回退不让显示值缩回去（单调）', () => {
    const { renderer, output, tick } = makeRenderer();
    for (let i = 0; i < 10; i += 1) {
      renderer.render(DETERMINATE_EVENT);
      tick();
    }
    expect(output.chunks[9]).toMatch(/ 9%/);
    // 上游把 completed 报小了 —— 条不许往回缩。
    renderer.render({ action: '更新', target: 'KhyOS', phase: '下载', completed: 5, total: 100 });
    expect(output.chunks[10]).toMatch(/ 10%/);
  });
});

describe('updateProgressRenderer · 降级路径（逐字节回退到今日观感）', () => {
  it('门关（options.pacer=false）→ 直接报真实百分比，不逐步爬', () => {
    const { renderer, output } = makeRenderer({ pacer: false });
    renderer.render(DETERMINATE_EVENT);
    expect(output.chunks[0]).toContain('67/100 67%');
  });

  it('KHY_REDUCED_MOTION 真值 → 只报真实值（假动效也是一种欺骗）', () => {
    const { renderer, output } = makeRenderer({ env: { KHY_REDUCED_MOTION: '1' } });
    renderer.render(DETERMINATE_EVENT);
    expect(output.chunks[0]).toContain('67/100 67%');
  });

  it('KHY_PROGRESS_PACED=0 → 分母未知时退回今日的静态文案', () => {
    const { renderer, output } = makeRenderer({ env: { KHY_PROGRESS_PACED: '0' } });
    renderer.render({ action: '更新', target: 'KhyOS', phase: '安装', progress: '第 1/3 阶段' });
    expect(output.chunks[0]).toContain('第 1/3 阶段');
    expect(output.chunks[0]).not.toMatch(/\d+%/); // 没有节拍条，也就没有百分比
  });

  it('finish() 收尾：行是终态文案，且停掉重画节拍', () => {
    const { renderer, output } = makeRenderer({ isTTY: true });
    renderer.render({ action: '更新', target: 'KhyOS', phase: '安装' });
    const line = renderer.finish({ status: '完成', message: '更新流程结束' });
    expect(line).toBe('完成 · 更新流程结束');
    expect(output.text).toContain('完成 · 更新流程结束');
    expect(() => renderer.dispose()).not.toThrow();
  });
});