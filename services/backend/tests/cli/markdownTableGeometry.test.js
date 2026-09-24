'use strict';

/**
 * markdownTableGeometry — 表格「几何完整性」回归(node:test)。
 *
 * 2026-09-26 用户报告「表格很乱不清晰」。三个独立缺陷叠在一起：
 *
 *  ① `_parseTableData` 用 `filter(idx > 0 && idx < arr.length - 1)` 切单元格，
 *     隐含假设每行都以 `|` 结尾。GFM 允许 `| a | b`（无尾竖线），此时**最后一个
 *     单元格被静默丢弃** —— 一列内容整体消失。
 *  ② 单元格里的 `<br>` 被 `_renderInlineHtml` 换成真 `\n`，而这一步跑在
 *     `_renderMarkdownTables` **之前** ⇒ 表格行被劈成两半：前半段不以 `|` 结尾
 *     （撞上 ①），后半段不以 `|` 开头、散落到表格外面当普通文本。
 *  ③ `renderPlainTable` 列宽 = 内容最大宽度，超长单元格撑爆行宽，交给 ink 二次
 *     硬折 ⇒ 续行从第 0 列开始，列结构全丢（「表格很乱」的直接观感）。
 *
 * ①②在本文件，③在 plainProcessTable.test.js。
 */
const test = require('node:test');
const assert = require('node:assert');

const mr = require('../../src/cli/markdownRenderer');

const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s) => String(s).replace(ANSI, '');
function width(s) {
  try {
    const m = require('string-width');
    return (typeof m === 'function' ? m : m.default)(String(s));
  } catch {
    return String(s).length;
  }
}
const render = (md, cols) =>
  strip(mr.renderMarkdownLite(Array.isArray(md) ? md.join('\n') : md, cols)).split('\n');

test('末列不丢:行不以 `|` 结尾时最后一个单元格仍被渲染', () => {
  // `| 设计 | 影子 FSM ...` 是合法 GFM 表格行(尾竖线可省)。
  const lines = render(['| 维度 | KHY OS |', '| --- | --- |', '| 设计 | 影子 FSM 描述'], 100);
  assert.ok(
    lines.some((l) => l.includes('影子 FSM 描述')),
    `末列不应丢失,实际输出:\n${lines.join('\n')}`
  );
});

test('末列不丢:带尾竖线与不带尾竖线渲染一致', () => {
  const withPipe = render(['| a | b |', '| --- | --- |', '| c | d |'], 100);
  const noPipe = render(['| a | b |', '| --- | --- |', '| c | d'], 100);
  assert.deepStrictEqual(noPipe, withPipe, '尾竖线不应影响单元格切分');
});

test('单元格内 <br> 不劈开表格行(内容不散落到表格外)', () => {
  const lines = render(
    ['| 维度 | KHY OS<br>Y-code |', '| --- | --- |', '| 设计 | 甲<br>乙 |'],
    100
  );
  const joined = lines.join('\n');
  assert.ok(!joined.includes('|'), `不应残留裸竖线:\n${joined}`);
  assert.ok(joined.includes('KHY OS'), '表头第二列应完整保留');
  assert.ok(joined.includes('Y-code'), '`<br>` 之后的内容不得落到表格外');
  assert.ok(joined.includes('甲'), '数据行第二列应完整保留');
  assert.ok(joined.includes('乙'), '`<br>` 之后的内容不得落到表格外');
});

test('正文里的 <br> 仍然换行(表格外行为不变)', () => {
  const lines = render('第一行<br>第二行', 100);
  assert.strictEqual(lines[0].trim(), '第一行');
  assert.strictEqual(lines[1].trim(), '第二行');
});

test('几何不变量:表格每一物理行都不超过渲染列宽', () => {
  const cols = 100;
  const md = [
    '| 维度 | KHY OS |',
    '| --- | --- |',
    '| 设计 | 影子 FSM (shadow observation, toolLoopPhases.js) — 主循环按事件 fire()，非法转移不抛错、只记录    严格状态机 — Turn 8 态 + Step 10 态，非法转移显式失败 |',
    '| 阶段 | init → send_to_ai → parse_ai_output → execute_tools → process_results → transient_recovery \\ error_handling \\ interrupted (9 个)    Turn: created>preparing>running>completed\\ failed\\ cancelled\\ interrupted |',
    '| 持久化 | journal (iterationJournal) 每轮记录游标切片，崩溃可定位死在第 N 轮 |',
    '- 取消/中断/恢复',
  ].join('\n');
  const lines = render(md, cols);
  for (const l of lines) {
    assert.ok(width(l) <= cols, `行超出 ${cols} 列(w=${width(l)}),ink 会二次硬折:\n${JSON.stringify(l)}`);
  }
});

test('几何不变量:长单元格折行后,续行落在列位置而不是第 0 列', () => {
  const md = [
    '| 维度 | KHY OS |',
    '| --- | --- |',
    '| 设计 | 影子 FSM (shadow observation, toolLoopPhases.js) — 主循环按事件 fire()，非法转移不抛错、只记录 |',
  ].join('\n');
  const lines = render(md, 60);
  const dataIdx = lines.findIndex((l) => l.includes('影子 FSM'));
  assert.ok(dataIdx >= 0, '数据行应存在');
  // 第二列的起始**列**(显示列,不是字符下标 —— CJK 占两列)。
  const col2CharIdx = lines[0].indexOf('KHY OS');
  assert.ok(col2CharIdx > 0, '表头第二列应存在');
  const col2Start = width(lines[0].slice(0, col2CharIdx));
  assert.ok(col2Start > 2, '第二列应在第一列之后');
  // 续行：位于数据行之后、以空白开头、且有内容
  const cont = lines.slice(dataIdx + 1).filter((l) => /^\s+\S/.test(l));
  assert.ok(cont.length > 0, '长单元格应折出续行');
  for (const c of cont) {
    const lead = width(c.replace(/\S[\s\S]*$/, ''));
    assert.strictEqual(lead, col2Start, `续行缩进应回到第二列起始列:${JSON.stringify(c)}`);
  }
});
