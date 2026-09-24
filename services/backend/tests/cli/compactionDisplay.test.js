'use strict';

/**
 * compactionDisplay.test.js — 压缩过程显示单一真源的契约测试（node:test，零依赖）。
 *
 * 锁三件事：
 *   1. 阶段 → 标签/百分比地板的映射面（与 TUI CompactionProgress 再导出一致，防漂移）；
 *   2. buildCompactionLine 输出形态（条 + 百分比 + 阶段 + 可选耗时，规则 2.6 进度信号）；
 *   3. compress() 的 onPhase 契约：里程碑事件恰好 pruning(15) → summarizing(45)，
 *      UI 回调抛错绝不打断压缩本身。
 */

const test = require('node:test');
const assert = require('node:assert');

const display = require('../../src/cli/compactionDisplay');

test('STAGE_LABELS 覆盖五阶段且 done=完成', () => {
  assert.deepStrictEqual(display.STAGE_LABELS, {
    starting: '准备中',
    pruning: '清理冗余',
    guarding: '窗口守护',
    summarizing: '生成摘要',
    done: '完成',
  });
});

test('stagePct：地板取值面与 emitPhase 契约一致，未知阶段回退 starting 地板', () => {
  assert.strictEqual(display.stagePct('starting'), 5);
  assert.strictEqual(display.stagePct('pruning'), 15);
  assert.strictEqual(display.stagePct('guarding'), 30);
  assert.strictEqual(display.stagePct('summarizing'), 45);
  assert.strictEqual(display.stagePct('done'), 100);
  assert.strictEqual(display.stagePct('no-such-stage'), 5);
  assert.strictEqual(display.stagePct(undefined), 5);
});

test('stageLabel：未知阶段回退「压缩中」，不返回 undefined', () => {
  assert.strictEqual(display.stageLabel('pruning'), '清理冗余');
  assert.strictEqual(display.stageLabel('no-such'), '压缩中');
  assert.strictEqual(display.stageLabel(undefined), '压缩中');
});

test('buildCompactionLine：含条形、百分比与阶段标签（动作+目标+进度齐备）', () => {
  const line = display.buildCompactionLine({ stage: 'pruning' });
  assert.ok(line.includes('正在压缩对话'), '动作前缀');
  assert.ok(line.includes('15%'), '百分比地板');
  assert.ok(line.includes('清理冗余'), '阶段标签');
  assert.ok(line.includes('█') && line.includes('░'), '条形字符');
});

test('buildCompactionLine：显式 pct 优先于阶段地板；越界钳到 0..100', () => {
  assert.ok(display.buildCompactionLine({ stage: 'pruning', pct: 22 }).includes('22%'));
  assert.ok(display.buildCompactionLine({ stage: 'pruning', pct: 999 }).includes('100%'));
  assert.ok(display.buildCompactionLine({ stage: 'pruning', pct: -3 }).includes('0%'));
});

test('buildCompactionLine：注入 now 且带 startedAt 时附已耗时；NaN 安全', () => {
  const t0 = 1_000_000;
  const line = display.buildCompactionLine(
    { stage: 'summarizing', startedAt: t0 },
    { now: () => t0 + 12_300 }
  );
  assert.ok(/已 12\.3s/.test(line), `耗时出现在行内: ${line}`);
  const noElapsed = display.buildCompactionLine({ stage: 'summarizing' }, { now: () => t0 });
  assert.ok(!noElapsed.includes('已 '), '无 startedAt 不显示耗时');
});

test('TUI CompactionProgress 再导出的 STAGE_LABELS 与单一真源逐字节一致', () => {
  const C = require('../../src/cli/tui/ink-components/CompactionProgress');
  assert.deepStrictEqual(C.STAGE_LABELS, display.STAGE_LABELS);
});

test('compress() onPhase 契约：里程碑 pruning(15) → summarizing(45) 依次发出', async () => {
  const { compress } = require('../../src/services/contextCompressor');
  const events = [];
  // 6 条消息、高占用 → 必过所有门槛，走到 AI 摘要（桩立即返回合格摘要）。
  const messages = Array.from({ length: 6 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `消息 ${i}：${'内容'.repeat(400)}`,
  }));
  const result = await compress(messages, {
    estimateTokensFn: (t) => Math.ceil((t || '').length / 2),
    callModelFn: async () => ({
      reply: '这是摘要：' + '要'.repeat(30),
    }),
    contextWindowTokens: 1000,
    onPhase: (e) => events.push(e),
  });
  assert.strictEqual(result.summaryGenerated, true, '压缩应成功');
  const stages = events.map((e) => e.stage);
  assert.deepStrictEqual(stages, ['pruning', 'summarizing'], `里程碑序列: ${JSON.stringify(events)}`);
  assert.strictEqual(events[0].pct, 15);
  assert.strictEqual(events[1].pct, 45);
});

test('compress() onPhase 契约：UI 回调抛错被吞掉，压缩照常完成', async () => {
  const { compress, resetAntiJitter } = require('../../src/services/contextCompressor');
  resetAntiJitter(); // 与上一条用例共享模块级 30s 冷却 —— 先清，防本例被冷却路径跳过
  const messages = Array.from({ length: 6 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `消息 ${i}：${'内容'.repeat(400)}`,
  }));
  const result = await compress(messages, {
    estimateTokensFn: (t) => Math.ceil((t || '').length / 2),
    callModelFn: async () => ({ reply: '这是摘要：' + '要'.repeat(30) }),
    contextWindowTokens: 1000,
    onPhase: () => {
      throw new Error('UI 崩了也不许连累压缩');
    },
  });
  assert.strictEqual(result.summaryGenerated, true);
});
