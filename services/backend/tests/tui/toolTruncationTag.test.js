'use strict';

/**
 * toolTruncationTag — 截断标记「原因 + 退出码」增强的单测（纯函数，无需 ink）。
 *
 * 诉求（用户 2026-09-26）：「tui 输出时经常截断却没有原因和错误码」。
 * 本套锁定两件事：
 *   ① **向后兼容**：`buildResultTruncationTag(full, shown)` 不传 opts 时输出必须与历史
 *      逐字节一致（`[已截断 X/Y 字]`）—— 这是「加法式扩展」的硬契约，防止增强顺手改了老文案。
 *   ② **新能力来自真实结构**：`describeTruncationReason` 的原因必须能从折叠标记 / `result.truncated`
 *      这类确定性信号推出来，判不出来时返回 ''，**绝不臆造原因**。
 *
 * 每个「应输出」断言都配一条「应沉默」对照（见 A3/A4/B5/B6/C6），避免收窄到恒真。
 */

const T = require('../../src/cli/tui/ink-components/ToolLines.js');

const full = 'a'.repeat(100);
const shown = ['a'.repeat(10)]; // 10/100 字 → 必然触发截断标记

describe('buildResultTruncationTag — 向后兼容（不传 opts 时逐字节不变）', () => {
  test('不传 opts → 历史文案', () => {
    expect(T.buildResultTruncationTag(full, shown)).toBe('[已截断 10/100 字]');
  });

  test('传空对象 → 等同不传', () => {
    expect(T.buildResultTruncationTag(full, shown, {})).toBe('[已截断 10/100 字]');
  });

  test('未截断 → 空串（不产生噪声）', () => {
    expect(T.buildResultTruncationTag('abc', ['abc'])).toBe('');
  });

  test('无内容 / 非数组 → 空串，绝不抛', () => {
    expect(T.buildResultTruncationTag('', [])).toBe('');
    expect(T.buildResultTruncationTag('abc', null)).toBe('');
  });

  test('折叠标记不计入 shown 字数（回归：历史行为）', () => {
    expect(
      T.buildResultTruncationTag('a'.repeat(200), ['a'.repeat(5), '… +99 行 (ctrl+o 展开)'])
    ).toBe('[已截断 5/200 字]');
  });
});

describe('buildResultTruncationTag — 原因与退出码', () => {
  test('只给原因', () => {
    expect(T.buildResultTruncationTag(full, shown, { reason: '输出 45 行 > 显示上限 20 行' })).toBe(
      '[已截断 10/100 字 · 原因：输出 45 行 > 显示上限 20 行]'
    );
  });

  test('原因 + 退出码 0（截断时退出码也必须给）', () => {
    expect(T.buildResultTruncationTag(full, shown, { reason: 'R', exitCode: 0 })).toBe(
      '[已截断 10/100 字 · 原因：R · 退出码 0]'
    );
  });

  test('原因 + 退出码 1', () => {
    expect(T.buildResultTruncationTag(full, shown, { reason: 'R', exitCode: 1 })).toBe(
      '[已截断 10/100 字 · 原因：R · 退出码 1]'
    );
  });

  test('只给退出码', () => {
    expect(T.buildResultTruncationTag(full, shown, { exitCode: 2 })).toBe(
      '[已截断 10/100 字 · 退出码 2]'
    );
  });

  test('非整数 exitCode 被拒（不臆造码）', () => {
    expect(T.buildResultTruncationTag(full, shown, { exitCode: 1.5 })).toBe('[已截断 10/100 字]');
  });

  test('空白 reason 被忽略（不产生空壳「原因：」）', () => {
    expect(T.buildResultTruncationTag(full, shown, { reason: '   ' })).toBe('[已截断 10/100 字]');
  });
});

describe('describeTruncationReason — 原因来自真实结构', () => {
  const folded = [
    ...Array.from({ length: 12 }, (_, i) => `row${i}`),
    '… +33 行 (ctrl+o 展开)',
    ...Array.from({ length: 6 }, (_, i) => `tail${i}`),
  ];

  test('行折叠 · 折叠态 → 带显示上限', () => {
    expect(T.describeTruncationReason(folded, {}, false)).toBe('51 行 > 上限 20 行');
  });

  test('行折叠 · 展开态 → 不谎称有显示上限', () => {
    expect(T.describeTruncationReason(folded, {}, true)).toBe('51 行(隐藏 33 行)');
  });

  test('工具自身截断 + 已存盘', () => {
    expect(T.describeTruncationReason(['x'], { truncated: true, diskPath: '/tmp/a.txt' }, false)).toBe(
      '工具输出超上限(完整结果已存盘)'
    );
  });

  test('工具自身截断（无盘路径）', () => {
    expect(T.describeTruncationReason(['x'], { truncated: true }, false)).toBe('工具输出超上限');
  });

  test('无折叠 → 归因行宽裁剪（列宽取真实有效列宽）', () => {
    expect(T.describeTruncationReason(['x'.repeat(50)], {}, false)).toMatch(/^行宽超终端 \d+ 列$/);
  });

  test('坏输入不抛（null / 非数组）', () => {
    expect(() => T.describeTruncationReason(null, null, false)).not.toThrow();
    expect(T.describeTruncationReason(null, null, false)).toMatch(/^行宽超终端 \d+ 列$/);
  });
});

describe('_annotateTruncation — 回复正文截断必须带码值', () => {
  const H = require('../../src/cli/aiGatewayGenerateHelpers.js');

  test('finish_reason=length → 提示里出现可搜索的码值', () => {
    const out = H._annotateTruncation('半截话', 'length', 0);
    expect(out.truncated).toBe(true);
    expect(out.reply).toContain('finish_reason=length');
    expect(out.reply).toContain('截断');
  });

  test('max_tokens 变体同样带上', () => {
    const out = H._annotateTruncation('半截话', 'MAX_TOKENS', 0);
    expect(out.truncated).toBe(true);
    expect(out.reply).toContain('finish_reason=max_tokens');
  });

  test('对照：正常结束不带码值、不改正文', () => {
    const out = H._annotateTruncation('完整回复', 'stop', 0);
    expect(out.truncated).toBe(false);
    expect(out.reply).toBe('完整回复');
  });

  test('幂等：已含截断提示的正文不重复追加', () => {
    const out = H._annotateTruncation('前面已经说了被截断的事', 'length', 0);
    expect(out.reply).toBe('前面已经说了被截断的事');
    expect(out.reply).not.toContain('finish_reason=');
  });
});

// ── 端到端：真起 ink 渲染一帧，确认「原因 + 退出码」确实出现在屏幕上 ──────────
// 纯函数断言只能证明「算得对」，证明不了「渲染得出来」。与 inkRenderSmoke 同款守卫：
// ink 是 ESM-only，动态 import 只在 --experimental-vm-modules 下可用，故默认跳过、
// 由 `npm run --workspace backend test:tui` 真跑。
process.env.KHY_TUI_PREWARM = '0';
const VM_MODULES = (process.env.NODE_OPTIONS || '').includes('experimental-vm-modules');
const describeRender = VM_MODULES ? describe : describe.skip;

describeRender('ToolLines 端到端渲染 — 截断标记带原因与退出码', () => {
  const { Writable } = require('stream');
  const { EventEmitter } = require('events');
  const React = require('react');
  const rt = require('../../src/cli/tui/inkRuntime');

  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

  let ink;
  beforeAll(async () => {
    rt.registerJsx();
    await rt.loadInk();
    ink = rt.get();
  }, 60000);

  function fakeStdout() {
    let buffer = '';
    const stream = new Writable({
      write(chunk, _enc, cb) {
        buffer += chunk.toString();
        cb();
      },
    });
    stream.columns = 80;
    stream.rows = 24;
    stream.isTTY = false;
    stream.getBuffer = () => buffer;
    return stream;
  }

  function fakeStdin() {
    const stream = new EventEmitter();
    stream.isTTY = true;
    stream.setRawMode = () => stream;
    stream.setEncoding = () => stream;
    stream.resume = () => stream;
    stream.pause = () => stream;
    stream.ref = () => {};
    stream.unref = () => {};
    stream.read = () => null;
    return stream;
  }

  async function toolFrame(tools, expanded) {
    const Comp = require('../../src/cli/tui/ink-components/ToolLines');
    const stdout = fakeStdout();
    const instance = ink.render(React.createElement(Comp, { tools, expanded }), {
      stdout,
      stdin: fakeStdin(),
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const frame = stdout.getBuffer();
    instance.unmount();
    return stripAnsi(frame);
  }

  const longOutput = Array.from({ length: 60 }, (_, i) => `row${i + 1}`).join('\n');

  test('折叠 + 退出码 1 → 标记含原因与退出码，且不再重复输出 ↳ 退出码行', async () => {
    const frame = await toolFrame(
      [{ name: 'bash', result: { success: true, output: longOutput, exitCode: 1 } }],
      false
    );
    expect(frame).toContain('原因：');
    expect(frame).toContain('上限 20 行');
    expect(frame).toContain('退出码 1');
    expect(frame).not.toContain('↳ 退出码 1'); // 同一信息只出现一次
  });

  test('折叠 + 退出码 0 → 截断时退出码也要给（历史只在非 0 时显示）', async () => {
    const frame = await toolFrame(
      [{ name: 'bash', result: { success: true, output: longOutput, exitCode: 0 } }],
      false
    );
    expect(frame).toContain('退出码 0');
  });

  test('未截断 + 退出码 1 → 保留历史的 ↳ 退出码 行（不回归）', async () => {
    const frame = await toolFrame(
      [{ name: 'bash', result: { success: true, output: 'short output', exitCode: 1 } }],
      false
    );
    expect(frame).not.toContain('原因：'); // 没截断就不该有原因
    expect(frame).toContain('↳ 退出码 1');
  });

  test('工具自身声明截断 → 归因「工具输出超上限」而非显示策略', async () => {
    const frame = await toolFrame(
      [{ name: 'bash', result: { success: true, output: longOutput, truncated: true } }],
      false
    );
    expect(frame).toContain('工具输出超上限');
  });
});
