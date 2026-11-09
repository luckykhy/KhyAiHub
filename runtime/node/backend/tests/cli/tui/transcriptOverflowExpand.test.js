'use strict';

// 转录区「带 … 的工具摘要行可点击就地展开」—— 判据在投影叶子上，不渲染 ink。
//
// 三个环节缺一不可，全部钉住：
//   ① 摘要被裁 → folds 里那一行必须有 { kind:'overflow', key, full }；
//   ② 摘要没被裁 → folds 必须是 null（否则每个工具行都变成按钮）；
//   ③ 展开态 → 那一行换成**完整摘要**，且锚点消失（否则下一帧又展开一次）。
//
// 另外钉住「full 必须是未裁剪原文」：若展开态拿到的还是 60 字截断版，
// 用户点了只会看到一模一样的一行，功能等于没做。

const test = require('node:test');
const assert = require('node:assert');

const tl = require('../../../src/cli/tui/transcriptLines');
const ToolLines = require('../../../src/cli/tui/ink-components/ToolLines');

const LONG_CMD = 'git commit -m "' + '很长的提交信息'.repeat(20) + '"';

function msgsWith(command) {
  return [
    {
      uuid: 'm1',
      role: 'assistant',
      timeline: [
        { type: 'tools', tools: [{ name: 'Bash', input: { command }, result: { content: 'ok' } }] },
      ],
    },
  ];
}

function project(opts) {
  return tl.buildTranscriptLineRecords(msgsWith(LONG_CMD), {
    cols: 80,
    summarizeTool: ToolLines.summarizeArgs,
    ...opts,
  });
}

test('摘要被裁 → 首行带 overflow 锚点，其余行不带', () => {
  const rec = project();
  const marks = rec.folds.filter(Boolean);
  assert.equal(marks.length, 1, '只有一条工具，且只该有首行一个锚点');
  assert.equal(marks[0].kind, 'overflow');
  assert.ok(marks[0].key, '锚点必须带 key（展开态靠它定位）');
  assert.equal(rec.folds[0], marks[0], '锚点必须落在首行（摘要行）');
  // 摘要行会被 `_wrap` 折成多行，`…` 落在折行的最后一行 —— 所以按「整条头行」判，
  // 不能只看 lines[0]。
  const headRowCount = rec.folds.filter((f) => f === marks[0]).length;
  assert.equal(headRowCount, 1, '锚点只挂在首行，续行不挂');
  assert.ok(rec.lines[0].includes('Bash('), '首行是工具名 + 摘要开头');
  const headText = rec.lines.slice(0, 2).join('');
  assert.ok(headText.includes('…'), '折叠态摘要必须以省略号收尾');
});

test('full 是未裁剪原文，而不是再截一次的同一份', () => {
  const rec = project();
  const anchor = rec.folds.find(Boolean);
  assert.ok(anchor.full.length > 60, 'full 必须长过 60 字的显示预算，否则展开没有意义');
  assert.ok(anchor.full.includes('很长的提交信息'), 'full 必须含完整命令正文');
});

test('摘要没被裁 → 不挂锚点（不许每行都变成按钮）', () => {
  const short = tl.buildTranscriptLineRecords(msgsWith('ls -la'), {
    cols: 80,
    summarizeTool: ToolLines.summarizeArgs,
  });
  assert.equal(short.folds.filter(Boolean).length, 0);
  assert.ok(short.lines[0].includes('ls -la'));
});

test('展开态：行变长、锚点消失', () => {
  const folded = project();
  const anchor = folded.folds.find(Boolean);
  const open = project({ expandedOverflow: new Set([anchor.key]) });
  assert.ok(
    open.lines.join('').length > folded.lines.join('').length,
    '展开后必须真的多显示内容'
  );
  assert.equal(open.folds.filter(Boolean).length, 0, '展开后锚点必须消失（否则下一帧重复展开）');
  assert.ok(open.lines.join('').includes('很长的提交信息'.repeat(5)), '展开态必须含折叠态没有的那部分');
});

test('showAll（Ctrl+O 全局展开）下摘要本来就不裁 → 不挂锚点', () => {
  const rec = project({ showAll: true });
  assert.equal(rec.folds.filter(Boolean).length, 0);
  assert.ok(rec.lines.join('').includes('很长的提交信息'.repeat(5)));
});
