'use strict';

// khy arena 的 formatArenaResult「for CLI display」经 handlers/arena.js 接线，把结果
// 表格打印到终端。此前四处独立整行散文标签是硬编码英文（Arena Results / Prompt: /
// Total time: / Content Similarity:），违反 AGENTS.md「面向用户的字符串：中文」。
// 修复只动这四行零列宽耦合的整行标签；固定宽度表格头与 yes/no/ok/failed 单元格是
// padEnd 对齐的 ASCII 遥测，双宽 CJK 会打乱 │ 列格 → 刻意保持不变。
// 另：表格头部/分隔行的 Model 列比数据行窄 1 格（原 #111），使所有 │/┼ 左偏 1，
// 现头部 Model 列补 1 空格、分隔行补 1 破折号对齐。本测试锁三面：
//   1) 中文散文标签出现、旧英文消失；2) ASCII 表格单元未被本地化（防回归）；
//   3) 表头/分隔/数据/失败四行的 │/┼ 列位完全一致（对齐不变式）。

process.env.NO_COLOR = '1';
process.env.FORCE_COLOR = '0';

const assert = require('assert');
const nt = require('node:test');

const { formatArenaResult } = require('../../src/services/arenaManager');

const RESULT = {
  arenaId: 'a1b2',
  prompt: 'write a function to sort a list',
  totalMs: 4213,
  summary: {
    metrics: [
      { model: 'claude-sonnet', latencyMs: 1200, totalMs: 1980, wordCount: 240, hasCode: true },
      { model: 'gpt-4o', latencyMs: 900, totalMs: 2233, wordCount: 180, hasCode: false },
    ],
    failedModels: [{ model: 'llama-local', error: 'ECONNREFUSED' }],
    similarities: [{ modelA: 'claude-sonnet', modelB: 'gpt-4o', similarity: 62 }],
    recommendation: 'claude-sonnet produced the most complete answer',
  },
};

const out = formatArenaResult(RESULT);

nt.describe('formatArenaResult prose labels localized (中文)', () => {
  nt.test('the four standalone prose labels render in Chinese', () => {
    for (const h of ['竞技场结果（a1b2）', '提示词：', '总耗时：4213ms', '内容相似度：']) {
      assert.ok(out.includes(h), `expected Chinese label: ${h}`);
    }
  });

  nt.test('the old English prose labels are gone (anti-regression)', () => {
    for (const bad of ['Arena Results', 'Prompt: ', 'Total time: ', 'Content Similarity:']) {
      assert.ok(!out.includes(bad), `expected NOT to contain English label: ${bad}`);
    }
  });
});

nt.describe('formatArenaResult ASCII table stays aligned + non-localized', () => {
  // 取所有含列分隔符的行，比对每行的 │/┼ 列索引集合。
  const sepCols = (line) => [...line.matchAll(/[│┼]/g)].map((x) => x.index);
  const tableRows = out.split('\n').filter((l) => /[│┼]/.test(l));

  nt.test('table cell telemetry is NOT localized (Model/Latency/ok/failed stay ASCII)', () => {
    assert.ok(out.includes('Model'), '表头 Model 列应保留 ASCII');
    assert.ok(out.includes('ok'), '状态单元格 ok 应保留');
    assert.ok(out.includes('failed'), '失败行 failed 应保留');
  });

  nt.test('header / separator / data / failed rows share identical column offsets (#111)', () => {
    assert.ok(tableRows.length >= 4, `expected >=4 table rows, got ${tableRows.length}`);
    const signatures = [...new Set(tableRows.map((l) => sepCols(l).join(',')))];
    assert.strictEqual(
      signatures.length,
      1,
      `column offsets disagree across rows: ${JSON.stringify(signatures)}`
    );
    // 且至少 5 条竖线（6 列），证明确实扫到了完整表格而非空集。
    assert.ok(sepCols(tableRows[0]).length >= 5, 'table should have >=5 separators');
  });
});
