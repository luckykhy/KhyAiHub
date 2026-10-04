'use strict';

/**
 * progressiveProgress —— 「渐进节拍」单一真源的不变式测试。
 *
 * 用户目标：「所有进度条都需要渐进加载，宁愿慢一些，1% 1% 的加载，也不要出现用户
 * 体感长时间等待」+「包括显示必须逐步渐进显示，不要一下就加载百分之几十的进度」。
 * 所以本套件锁死的不只是「算得对」，而是四条**观感契约**：
 *
 *   ① **一帧最多 +1%**：**一次** `percent()` 调用最多 +1%，攒下的时间一律丢弃 ——
 *      迟到 60 秒后的第一次采样也只走一步（绝不补足成一个几十个百分点的跳）；
 *   ② **单调不减**：显示值只增不减，真实值回退也不许缩回去；
 *   ③ **永不虚报完成**：到 100 的唯一入口是 `finish()`（或确定进度下真实值真的到 100）；
 *   ④ **不静止**：不确定进度在 `TAIL_CAP`（99）之前一定在动 —— `cap`（96）只是换档点，
 *      过它转尾巴档继续爬，绝不冻在那里；
 *   ⑤ **收尾也逐步**：`finish()` / 真实值到 100 都只把**目标**设成终态，显示值仍 1%/帧
 *      走过去（96 → 100 四帧）。旧实现直接赋 100 —— 那一跳就是「卡住很久然后突然完成」。
 *
 * ① 的代价是**采样责任**：每个渲染器都必须自持一个 RENDER_MS（= STEP_MS）的渲染节拍，
 * 否则推进频率就跟着事件密度走（慢，但绝不会跳）。
 *
 * 外加：确定进度车道**永不越过真实值**（诚实），以及门控/降级判据的行为
 * （`KHY_PROGRESS_PACED` 默认开、`KHY_REDUCED_MOTION` 真值时只报真实值）。
 */

const pp = require('../src/services/progressiveProgress');

const T0 = 1_700_000_000_000;
const clock = (ms) => T0 + ms;

describe('progressiveProgress · 常量', () => {
  it('节拍常量与前端（@khy/ui-shared）逐值一致，改动必须两边一起改', () => {
    expect(pp.STEP_MS).toBe(160);
    expect(pp.EASE_AFTER).toBe(70);
    expect(pp.SLOW_STEP_MS).toBe(1400);
    expect(pp.CAP).toBe(96);
    expect(pp.TAIL_STEP_MS).toBe(4000);
    expect(pp.TAIL_CAP).toBe(99);
    expect(pp.RENDER_MS).toBe(pp.STEP_MS); // 每帧恰好 +1% 的前提
    expect(pp.DEFAULTS).toEqual({
      stepMs: 160,
      easeAfter: 70,
      slowStepMs: 1400,
      tailStepMs: 4000,
      cap: 96,
    });
  });

  it('MAX_STEPS_PER_CALL 恒为 1 —— 「一帧最多 +1%」是硬不变式，不是防御上界', () => {
    expect(pp.MAX_STEPS_PER_CALL).toBe(1);
  });
});

describe('progressiveProgress · pacedPercent 曲线（纯函数）', () => {
  it('t ≤ 0 / 非有限 → 0', () => {
    expect(pp.pacedPercent(0)).toBe(0);
    expect(pp.pacedPercent(-1000)).toBe(0);
    expect(pp.pacedPercent(NaN)).toBe(0);
    expect(pp.pacedPercent(undefined)).toBe(0);
  });

  it('快速档每 160ms 恰好 +1', () => {
    expect(pp.pacedPercent(160)).toBe(1);
    expect(pp.pacedPercent(1600)).toBe(10);
    expect(pp.pacedPercent(11_200)).toBe(70); // 70 × 160ms
  });

  it('过七成后换慢速档：每 1400ms 才 +1', () => {
    expect(pp.pacedPercent(11_200 + 1399)).toBe(70);
    expect(pp.pacedPercent(11_200 + 1400)).toBe(71);
    expect(pp.pacedPercent(16_000)).toBe(73); // 70 + floor(4800/1400)
  });

  it('cap 是**换档点**不是终点：过 cap 后转尾巴档每 4000ms +1，到 99 才停', () => {
    const reachCapAt = 70 * 160 + 26 * 1400; // 47600ms
    expect(pp.pacedPercent(reachCapAt)).toBe(96);
    // 尾巴档：96 → 97 → 98 → 99，仍是一步 1%，只是更慢（不静止 = 用户知道它还在干）。
    expect(pp.pacedPercent(reachCapAt + 3999)).toBe(96);
    expect(pp.pacedPercent(reachCapAt + 4000)).toBe(97);
    expect(pp.pacedPercent(reachCapAt + 8000)).toBe(98);
    expect(pp.pacedPercent(reachCapAt + 12_000)).toBe(99);
    // 99 是整数百分比的物理上限：再久也只有一个数（要更久就得报小数或报已等待时长）。
    expect(pp.pacedPercent(reachCapAt + 600_000)).toBe(99);
  });

  it('单调不减：任意时刻序列永不回退，且永不超过 TAIL_CAP', () => {
    let prev = -1;
    for (let t = 0; t <= 600_000; t += 137) {
      const v = pp.pacedPercent(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(99);
      prev = v;
    }
  });

  it('可逐项覆盖节拍参数；cap 的写错与越界都被钉住', () => {
    expect(pp.pacedPercent(1600, { stepMs: 100 })).toBe(16);
    expect(pp.pacedPercent(1600, { cap: 5 })).toBe(5);
    expect(pp.pacedPercent(1600, { stepMs: 0 })).toBe(10); // 非法 → 回退默认
    // cap 非正数 → 回退默认（若照收就是「条永远不动」，正是要消灭的观感）。
    expect(pp.normalizeOptions({ cap: 0 }).cap).toBe(96);
    expect(pp.normalizeOptions({ cap: -3 }).cap).toBe(96);
    expect(pp.pacedPercent(600_000, { cap: 0 })).toBe(99); // 兜底成 96 → 尾巴档爬到 99
    // cap 上限钉在 99：未完成时绝不出 100（cap:100 会让条爬到 100% 停住 = 虚报完成）。
    expect(pp.normalizeOptions({ cap: 100 }).cap).toBe(99);
    expect(pp.pacedPercent(600_000, { cap: 100 })).toBe(99);
    // 尾巴档可覆盖（低功耗 / 测试用）。
    expect(pp.pacedPercent(47_600 + 10_000, { tailStepMs: 1000 })).toBe(99);
  });
});

describe('progressiveProgress · filledCells / renderBar（画条的单一真源）', () => {
  it('格数按比例取整并夹在 [0, width]', () => {
    expect(pp.filledCells(0, 20)).toBe(0);
    expect(pp.filledCells(50, 20)).toBe(10);
    expect(pp.filledCells(42, 20)).toBe(8);
    expect(pp.filledCells(100, 20)).toBe(20);
    expect(pp.filledCells(180, 20)).toBe(20);
    expect(pp.filledCells(-5, 20)).toBe(0);
  });

  it('非法宽度收敛到安全值，不抛异常', () => {
    expect(pp.filledCells(50, 0)).toBe(10); // width=0 非法 → 回退默认 20
    expect(pp.filledCells(50, NaN)).toBe(10); // → 默认 20
    expect(pp.filledCells(50, undefined)).toBe(10);
    expect(pp.filledCells(50, 1)).toBe(1);
  });

  it('renderBar 恒为 width 个字符，字形可换', () => {
    const bar = pp.renderBar(42, 20);
    expect([...bar]).toHaveLength(20);
    expect([...bar].filter((c) => c === '█')).toHaveLength(8);
    const custom = pp.renderBar(50, 4, { filled: '#', empty: '-' });
    expect(custom).toBe('##--');
  });
});

describe('progressiveProgress · createPacer 不确定进度车道', () => {
  const makePacer = (extra) =>
    pp.createPacer(Object.assign({ now: () => clock(0) }, extra || {}));

  it('① 一帧最多 +1%：按渲染节拍（160ms）取样时，每次恰好 +1%', () => {
    // 这就是「1% 1% 地加载」的运行时含义 —— 每个渲染帧只推进 1%。
    const p = makePacer();
    const seq = [];
    for (let i = 0; i <= 30; i += 1) {
      seq.push(p.percent(clock(i * pp.RENDER_MS)));
    }
    expect(seq).toEqual(Array.from({ length: 31 }, (_, i) => i));
  });

  it('① 迟到 60 秒后的第一次采样也只走一步（不补足、不跳）', () => {
    // 「不要一下就加载百分之几十的进度」——攒下的时间一律丢弃，而不是一次性兑换。
    // 代价：采样频率低于 stepMs 时推进更慢（宁可慢，不要跳）。
    const p = makePacer();
    expect(p.percent(clock(0))).toBe(0);
    expect(p.percent(clock(60_000))).toBe(1); // 60 秒的债 → 只兑一步
    expect(p.percent(clock(60_000) + pp.STEP_MS)).toBe(2);
    expect(p.percent(clock(600_000))).toBe(3); // 又一次长间隔 → 仍然只有一步
  });

  it('② 单调不减 + ④ 未完成前不静止在 cap 之前：连续重绘一直在推进', () => {
    const p = makePacer();
    const seen = [];
    for (let i = 0; i <= 200; i += 1) {
      seen.push(p.percent(clock(i * 160)));
    }
    // 前 70 步每帧恰好 +1。
    expect(seen.slice(0, 71)).toEqual(Array.from({ length: 71 }, (_, i) => i));
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    }
  });

  it('④ 不静止：到 cap(96) 后转尾巴档继续爬，长任务也不会冻在一个数上', () => {
    // 这一条要用**会走的时钟**：finish() 没有 at 参数，它读注入时钟。
    let nowMs = 0;
    const p = pp.createPacer({ now: () => clock(nowMs) });
    // 按渲染节拍走满前两档：快档 70 步 + 慢档 26 步 → 96
    for (let i = 0; i < 70; i += 1) {
      nowMs += pp.STEP_MS;
      p.percent(clock(nowMs));
    }
    for (let i = 0; i < 26; i += 1) {
      nowMs += pp.SLOW_STEP_MS;
      p.percent(clock(nowMs));
    }
    expect(p.percent(clock(nowMs))).toBe(96);
    expect(p.settled()).toBe(false); // 还没静止 —— 旧的 cap 语义在这里就停了
    // 尾巴档：4 秒一格，仍在动（不是「卡在一个地方很久」）。
    nowMs += pp.TAIL_STEP_MS;
    expect(p.percent(clock(nowMs))).toBe(97);
    nowMs += pp.TAIL_STEP_MS;
    expect(p.percent(clock(nowMs))).toBe(98);
    nowMs += pp.TAIL_STEP_MS;
    expect(p.percent(clock(nowMs))).toBe(99);
    expect(p.settled()).toBe(true); // 99 是整数百分比的物理上限
    // ③ 永不虚报完成：再等 100 分钟也还是 99。
    expect(p.percent(clock(6_000_000))).toBe(99);
    expect(p.isDone()).toBe(false);
    expect(p.isFinished()).toBe(false);
  });

  it('⑤ 收尾逐步：finish() 不从 96 直跳 100，而是四帧走完（收尾也 1% 1%）', () => {
    let nowMs = 0;
    const p = pp.createPacer({ now: () => clock(nowMs) });
    for (let i = 0; i < 70; i += 1) {
      nowMs += pp.STEP_MS;
      p.percent(clock(nowMs));
    }
    for (let i = 0; i < 26; i += 1) {
      nowMs += pp.SLOW_STEP_MS;
      p.percent(clock(nowMs));
    }
    expect(p.percent(clock(nowMs))).toBe(96);
    // finish() 只把**目标**设成终态（工作确实结束了），显示值不许一次性赋成 100。
    expect(p.finish()).toBe(96); // 同一刻不多走一步 —— 收尾的每一步都得等满一个 STEP_MS
    expect(p.isDone()).toBe(true); // 「工作结束」立刻为真
    expect(p.isFinished()).toBe(false); // 「条真的到了 100」还得走四帧
    nowMs += pp.STEP_MS;
    expect(p.percent(clock(nowMs))).toBe(97);
    nowMs += pp.STEP_MS;
    expect(p.percent(clock(nowMs))).toBe(98);
    nowMs += pp.STEP_MS;
    expect(p.percent(clock(nowMs))).toBe(99);
    nowMs += pp.STEP_MS;
    expect(p.percent(clock(nowMs))).toBe(100);
    expect(p.isFinished()).toBe(true);
    expect(p.settled()).toBe(true);
    expect(p.percent(clock(nowMs + 600_000))).toBe(100); // 到顶后稳定在 100
  });

  it('⑤ 收尾不用慢档拖：收尾期一帧一格（迟到 60 秒仍只走一步）', () => {
    // 从 0 起 finish()：收尾每一步都是 STEP_MS（不是 1400ms 的慢档），
    // 且迟到多久都只走一步 —— 收尾既不跳，也不磨。
    let nowMs = 0;
    const p = pp.createPacer({ now: () => clock(nowMs) });
    expect(p.finish()).toBe(0);
    nowMs = 60_000;
    expect(p.percent(clock(nowMs))).toBe(1);
    nowMs += pp.STEP_MS;
    expect(p.percent(clock(nowMs))).toBe(2);
  });

  it('startPercent 让中途挂载的条不从 0 重来', () => {
    const p = makePacer({ startPercent: 42 });
    expect(p.percent(clock(0))).toBe(42);
    expect(p.percent(clock(0) + pp.STEP_MS)).toBe(43);
  });

  it('startedAt 只用于**起点播种**：中途挂载的条从曲线位置起步，之后照旧 1% 1%', () => {
    // 播种不是跳：起点是「这一段已经跑了 3.2 秒」这个既成事实（与 startPercent、额度表同类）。
    // 它**不是**计时基准 —— 迟到的时间不会在第一次采样里补足。
    const p = pp.createPacer({ now: () => clock(0), startedAt: clock(-3200) });
    expect(p.percent(clock(0))).toBe(20); // 3200 / 160
    expect(p.elapsed()).toBe(3200);
    expect(p.percent(clock(pp.STEP_MS))).toBe(21);
    expect(p.percent(clock(2 * pp.STEP_MS))).toBe(22);
  });

  it('observe() 只为「真实值到 100」服务，且真实值不回退', () => {
    let nowMs = 0;
    const p = pp.createPacer({ now: () => clock(nowMs) });
    p.observe(30);
    expect(p.real()).toBe(30);
    p.observe(12); // 回退被忽略
    expect(p.real()).toBe(30);
    // 不确定进度车道：真实值到 100 = 工作结束（转终态），但显示值仍 1% 1% 走过去。
    p.observe(100);
    expect(p.isDone()).toBe(true);
    expect(p.isFinished()).toBe(false);
    nowMs = 60_000;
    expect(p.percent(clock(nowMs))).toBe(1); // 迟到 60 秒也只走一步
    let shown = 1;
    for (let i = 1; i < 100; i += 1) {
      nowMs += pp.STEP_MS;
      shown = p.percent(clock(nowMs));
    }
    expect(shown).toBe(100);
    expect(p.isFinished()).toBe(true);
  });

  it('bar(width) 与 percent 同源', () => {
    const p = makePacer({ startPercent: 50 });
    expect(p.bar(10)).toBe(pp.renderBar(50, 10));
  });

  it('reset() 回到新建态（同一段加载重新开始时用）', () => {
    const p = makePacer({ startPercent: 30 });
    for (let i = 1; i <= 10; i += 1) {
      p.percent(clock(i * pp.STEP_MS));
    }
    expect(p.percent(clock(10 * pp.STEP_MS))).toBe(40);
    p.reset();
    // reset() 把节拍基准收到当下 —— 紧接着取样仍是 startPercent，不会带着上一段的 40% 继续。
    expect(p.percent(clock(0))).toBe(30);
    expect(p.percent(clock(pp.STEP_MS))).toBe(31);
  });

  it('输入非法一律收敛，绝不抛异常', () => {
    const p = pp.createPacer({ startedAt: NaN, startPercent: NaN, pace: null });
    expect(() => p.percent(NaN)).not.toThrow();
    expect(Number.isFinite(p.percent(NaN))).toBe(true);
    expect(() => p.observe('abc')).not.toThrow();
    expect(p.real()).toBe(0);
    expect(typeof p.bar(NaN, null)).toBe('string');
  });
});

describe('progressiveProgress · createPacer 确定进度车道（诚实优先）', () => {
  it('显示值永不越过真实值：分母粗（0/33/67）也被摊成 1% 1% 的曲线', () => {
    const p = pp.createPacer({ now: () => clock(0), determinate: true });
    p.observe(33);
    const seq = [];
    for (let i = 0; i <= 40; i += 1) {
      seq.push(p.percent(clock(i * 160)));
    }
    expect(Math.max(...seq)).toBe(33);
    expect(seq.every((v) => v <= 33)).toBe(true);
    expect(seq[0]).toBe(0);
    expect(seq[1]).toBe(1); // 一次只走 1%
  });

  it('① 确定进度同样一帧最多 +1%：真实值 67% 也不会在第一帧画出来', () => {
    const p = pp.createPacer({ now: () => clock(0), determinate: true });
    p.observe(67);
    expect(p.percent(clock(60_000))).toBe(1); // 迟到 60 秒也只走一步
    expect(p.percent(clock(60_000 + pp.STEP_MS))).toBe(2);
  });

  it('真实值到 100 → 允许 100，但同样是 1% 1% 走过去（不突然满格）', () => {
    let nowMs = 0;
    const p = pp.createPacer({ now: () => clock(nowMs), determinate: true });
    p.observe(100);
    expect(p.isDone()).toBe(true);
    expect(p.isFinished()).toBe(false); // 真实值到了 100，显示值还没走到
    nowMs = 60_000;
    expect(p.percent(clock(nowMs))).toBe(1); // 迟到 60 秒也只走一步
    let shown = 1;
    for (let i = 1; i < 100; i += 1) {
      nowMs += pp.STEP_MS;
      shown = p.percent(clock(nowMs));
    }
    expect(shown).toBe(100);
    expect(p.isFinished()).toBe(true);
    expect(p.settled()).toBe(true);
  });

  it('确定进度车道也逐步追平：追平后 settled() 为真（看板卡片据此停表）', () => {
    const p = pp.createPacer({ now: () => clock(0), determinate: true });
    p.observe(3);
    expect(p.settled()).toBe(false);
    expect(p.percent(clock(pp.STEP_MS))).toBe(1);
    expect(p.percent(clock(2 * pp.STEP_MS))).toBe(2);
    expect(p.percent(clock(3 * pp.STEP_MS))).toBe(3);
    expect(p.settled()).toBe(true);
  });

  it('真实值 99.6 不会显示成 100（未完成不许虚报）', () => {
    const p = pp.createPacer({ now: () => clock(0), determinate: true });
    p.observe(99.6);
    // 一路重绘上去：快档 70 步 + 慢档 29 步 = 99（floor(99.6)）
    let t = 0;
    for (let i = 0; i < 70; i += 1) {
      t += pp.STEP_MS;
      p.percent(clock(t));
    }
    for (let i = 0; i < 29; i += 1) {
      t += pp.SLOW_STEP_MS;
      p.percent(clock(t));
    }
    expect(p.percent(clock(t))).toBe(99);
    expect(p.percent(clock(600_000))).toBe(99); // 停在 99，绝不出 100
    expect(p.isDone()).toBe(false);
    expect(p.isFinished()).toBe(false);
    // 确定进度车道的 rate 不含尾巴档：99 处也已静止，不会因为「尾巴档」被拖成 4 秒一格。
    expect(p.settled()).toBe(true);
  });

  it('确定进度车道不被不确定车道的 cap(96) 压住：真实值 98 就画到 98', () => {
    // cap 的 4% 余量是为「不确定进度不触顶即静止」留的；确定进度车道的目标是真实值，
    // 套用 96 就成了凭空少画 2%。爬到 98 需 70×160 + 28×1400 = 50400ms（过七成后降速）。
    const p = pp.createPacer({ now: () => clock(0), determinate: true });
    p.observe(98);
    let t = 0;
    for (let i = 0; i < 70; i += 1) {
      t += pp.STEP_MS;
      p.percent(clock(t));
    }
    for (let i = 0; i < 28; i += 1) {
      t += pp.SLOW_STEP_MS;
      p.percent(clock(t));
    }
    expect(p.percent(clock(t))).toBe(98);
    expect(p.percent(clock(120_000))).toBe(98); // 追平即停，不会溢出到 100
  });

  it('真实值回退时显示值不缩回去（单调）', () => {
    const p = pp.createPacer({ now: () => clock(0), determinate: true });
    p.observe(50);
    for (let i = 1; i <= 50; i += 1) {
      p.percent(clock(i * pp.STEP_MS));
    }
    expect(p.percent(clock(50 * pp.STEP_MS))).toBe(50);
    p.observe(10);
    expect(p.percent(clock(60 * pp.STEP_MS))).toBe(50);
  });
});

describe('progressiveProgress · 减少动效档（static）', () => {
  it('不叠加节拍，只报真实值（假动效也是一种欺骗）', () => {
    const p = pp.createPacer({ now: () => clock(0), static: true });
    expect(p.percent(clock(60_000))).toBe(0); // 真实值仍是 0 → 不假装在推进
    p.observe(40);
    expect(p.percent(clock(60_000))).toBe(40);
    expect(p.settled()).toBe(true); // 这一档本来就不动，不该挂定时器
  });

  it('static 档收尾直接报 100：这一档不许有动效，也就不许有「爬上去」的过程', () => {
    const p = pp.createPacer({ now: () => clock(0), static: true });
    p.observe(40);
    expect(p.percent(clock(60_000))).toBe(40);
    expect(p.finish()).toBe(100);
    expect(p.isFinished()).toBe(true);
  });
});

describe('progressiveProgress · 门控与降级判据', () => {
  it('KHY_PROGRESS_PACED 默认开；显式 0/false/off/no 关', () => {
    expect(pp.isPacedEnabled({})).toBe(true);
    for (const word of ['0', 'false', 'off', 'no', ' OFF ']) {
      expect(pp.isPacedEnabled({ KHY_PROGRESS_PACED: word })).toBe(false);
    }
    expect(pp.isPacedEnabled({ KHY_PROGRESS_PACED: '1' })).toBe(true);
  });

  it('createDisplayPacer：门关 → null（调用方据此逐字节回退今日观感）', () => {
    expect(pp.createDisplayPacer({ KHY_PROGRESS_PACED: '0' })).toBeNull();
    const pacer = pp.createDisplayPacer({}, { now: () => clock(0) });
    expect(pacer).not.toBeNull();
    expect(pacer.percent(clock(0))).toBe(0);
  });

  it('KHY_REDUCED_MOTION 真值 → createDisplayPacer 自动折算为 static', () => {
    for (const word of ['1', 'true', 'on', 'yes', ' YES ']) {
      expect(pp.isReducedMotion({ KHY_REDUCED_MOTION: word })).toBe(true);
    }
    expect(pp.isReducedMotion({})).toBe(false);
    const pacer = pp.createDisplayPacer({ KHY_REDUCED_MOTION: '1' }, { now: () => clock(0) });
    expect(pacer.percent(clock(60_000))).toBe(0);
  });

  it('门控判据 never throws（env 是垃圾也不崩）', () => {
    expect(() => pp.isPacedEnabled(null)).not.toThrow();
    expect(() => pp.isReducedMotion(undefined)).not.toThrow();
    expect(pp.isPacedEnabled(null)).toBe(true); // 不确定 → 按默认（开）
  });
});