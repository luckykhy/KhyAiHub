'use strict';

/**
 * panels.js 执行简报 / 完成面板 框体完整性回归（轮八十一）。
 *
 * 历史缺陷（复现于修复前，行宽集合 {74,75,76} / {70,71,72}）：
 *   1. 顶边框 dashCount 少减 1 → ╭ 行比正文宽 1 列；
 *   2. 底边框 '─'.repeat(maxW) 多 2 列 → ╰ 行比正文宽 2 列；
 *   3. addLine 的 pad 只补不截 → 分析/文件/命令等未预截断的行
 *      超宽时顶穿右边界。
 * 修复后契约：同一面板所有非空行显示宽度必须一致，且首行 ╮ / 末行 ╯。
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const panels = require('../src/cli/panels');
const { displayWidth } = require('../src/cli/formatters');

// printExecutionBrief / printCompletionPanel 仅在非 TTY 渲染；
// node --test 下 stdout 是管道 → 正常出框。
function captureRender(fn, args) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    panels[fn](args);
  } finally {
    console.log = orig;
  }
  return lines
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''))
    .filter((l) => l.trim() !== '');
}

function assertUniformBox(lines, minRows) {
  assert.ok(lines.length >= minRows, `行数 ${lines.length} < ${minRows}（防空渲染假绿）`);
  const widths = new Set(lines.map(displayWidth));
  assert.equal(widths.size, 1, `行宽不齐: ${[...widths].sort((a, b) => a - b).join('/')}`);
  assert.ok(lines[0].includes('╮'), `首行非顶边框: ${JSON.stringify(lines[0].slice(-6))}`);
  assert.ok(lines[lines.length - 1].includes('╯'), `末行非底边框: ${JSON.stringify(lines[lines.length - 1].slice(-6))}`);
}

describe('printExecutionBrief 框体完整性', () => {
  it('最小内容行宽一致', () => {
    assertUniformBox(
      captureRender('printExecutionBrief', { request: 'r', scale: 'large', files: ['a.js'] }),
      6
    );
  });

  it('病态超宽内容（200+ 列需求/分析/步骤/文件）不顶穿边界', () => {
    assertUniformBox(
      captureRender('printExecutionBrief', {
        request: '需'.repeat(200),
        scale: 'large',
        analysis: '分'.repeat(200),
        steps: Array.from({ length: 12 }, () => '步'.repeat(120)),
        files: Array.from({ length: 9 }, () => 'd:/very/long/dir/'.repeat(6) + 'file.js'),
        decomposed: true,
        subtaskCount: 12,
      }),
      10
    );
  });
});

describe('printCompletionPanel 框体完整性', () => {
  const base = {
    success: true,
    iterations: 3,
    totalCalls: 8,
    succeeded: 8,
    elapsed: '8.3s',
    searches: 2,
    reads: 5,
  };

  it('最小内容行宽一致', () => {
    assertUniformBox(
      captureRender('printCompletionPanel', {
        ...base,
        fileChanges: [{ path: 'a/b/panels.js', operation: 'modify', diff: '+4 -2' }],
        commands: [{ cmd: 'node --test tests', success: true }],
      }),
      6
    );
  });

  it('超长命令与 diff 串不顶穿边界', () => {
    assertUniformBox(
      captureRender('printCompletionPanel', {
        ...base,
        fileChanges: Array.from({ length: 8 }, (_, i) => ({
          path: `src/${'深'.repeat(60)}/mod${i}.js`,
          operation: 'modify',
          diff: '+' + '9'.repeat(80),
        })),
        commands: Array.from({ length: 6 }, () => ({ cmd: 'c'.repeat(300), success: true })),
      }),
      10
    );
  });
});
