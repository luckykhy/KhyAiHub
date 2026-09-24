'use strict';

/**
 * plainProcessTable — 无边框过程表格渲染的单测(node:test)。
 *
 * 回归目标(用户报告「输出过程表格线条太多·复制混乱」):markdown 表格应能渲染成无盒线、
 * 按列对齐、每行无尾随空白的纯文本(复制友好);门控关则回退。
 *
 * node:test(jest 经 rtk 代理报 Exec format error 不可用)。
 */
const test = require('node:test');
const assert = require('node:assert');

const mod = require('../../src/cli/plainProcessTable');

const DATA = {
  rows: [
    ['Name', 'Role', 'Notes'],
    ['alice', 'admin', 'primary'],
    ['bob', 'dev', 'backup'],
  ],
  colCount: 3,
};

test('renderPlainTable:无盒线字符', () => {
  const lines = mod.renderPlainTable(DATA);
  assert.ok(Array.isArray(lines));
  const joined = lines.join('\n');
  for (const glyph of ['│', '─', '╭', '╮', '╰', '╯', '├', '┤', '┬', '┴', '┼', '|']) {
    assert.ok(!joined.includes(glyph), `不应含盒线/竖线字符:${glyph}`);
  }
});

test('renderPlainTable:表头下有 --- 分隔行', () => {
  const lines = mod.renderPlainTable(DATA);
  assert.ok(/^\s*-{3,}/.test(lines[1]), `第二行应是 dash 分隔:${JSON.stringify(lines[1])}`);
});

test('renderPlainTable:列左对齐(内容按最宽列对齐)', () => {
  const lines = mod.renderPlainTable(DATA);
  // Name 列宽 = max(len(Name,alice,bob)) = 5;alice 后应紧跟两空格再 admin。
  assert.ok(lines[0].includes('Name '), '表头列应右填充到列宽');
  assert.ok(lines.some((l) => l.includes('bob  ')), 'bob 应填充到 Name 列宽');
});

test('renderPlainTable:每行无尾随空白(复制友好)', () => {
  const lines = mod.renderPlainTable(DATA);
  for (const l of lines) {
    assert.strictEqual(l, l.replace(/\s+$/, ''), `行不应有尾随空白:${JSON.stringify(l)}`);
  }
});

test('renderPlainTable:注入 measure/format/header/dim 被调用', () => {
  let headerCalls = 0; let dimCalls = 0;
  const lines = mod.renderPlainTable(DATA, {
    measure: (s) => String(s).length,
    stripMd: (s) => s,
    format: (s) => s,
    header: (s) => { headerCalls++; return `[H]${s}`; },
    dim: (s) => { dimCalls++; return `[D]${s}`; },
  });
  assert.ok(headerCalls >= 3, '表头每列应经 header()');
  assert.strictEqual(dimCalls, 1, '分隔行应经 dim() 一次');
  assert.ok(lines[0].includes('[H]Name'));
});

test('renderPlainTable:单行(无表头)不加分隔行', () => {
  const lines = mod.renderPlainTable({ rows: [['only', 'row']], colCount: 2 });
  assert.strictEqual(lines.length, 1, '单行表格只渲染一行,无 dash 分隔');
});

test('renderPlainTable:异常数据 → null(调用方回退)', () => {
  assert.strictEqual(mod.renderPlainTable(null), null);
  assert.strictEqual(mod.renderPlainTable({ rows: [] }), null);
  assert.strictEqual(mod.renderPlainTable({ rows: null }), null);
  assert.strictEqual(mod.renderPlainTable(undefined), null);
});

test('renderPlainTable:绝不抛', () => {
  assert.doesNotThrow(() => mod.renderPlainTable({ rows: [['a']], colCount: 1 }, null));
  assert.doesNotThrow(() => mod.renderPlainTable({ rows: [[null, undefined]], colCount: 2 }));
});

test('plainProcessTableEnabled:默认开 + 关闭词表', () => {
  assert.strictEqual(mod.plainProcessTableEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(mod.plainProcessTableEnabled({ KHY_PLAIN_PROCESS_TABLE: off }), false, off);
  }
});

// ── 宽度感知折行（2026-09-26「表格很乱」）──────────────────────────────
// 旧行为：列宽 = 内容最大宽度 ⇒ 一个长单元格把整行撑过终端宽度，交给 ink 硬折，
// 折出的续行从第 0 列开始、列结构全丢。修复后由本叶子自己折行并让续行回到列位置。

const { wrapCellLines } = require('../../src/cli/markdownTableWrap');

function width(s) {
  try {
    const m = require('string-width');
    return (typeof m === 'function' ? m : m.default)(String(s));
  } catch {
    return String(s).length;
  }
}

const LONG = '影子 FSM — 主循环按事件 fire()，非法转移不抛错、只记录；严格状态机 — Turn 8 态 + Step 10 态，非法转移显式失败';

test('renderPlainTable:maxWidth 下超宽单元格折行,且每行不超 maxWidth', () => {
  const MAX = 60;
  const lines = mod.renderPlainTable(
    { rows: [['维度', 'KHY OS'], ['设计', LONG]], colCount: 2 },
    { measure: width, maxWidth: MAX, wrapLines: wrapCellLines }
  );
  assert.ok(lines.length > 3, '长单元格应折成多行');
  for (const l of lines) {
    assert.ok(width(l) <= MAX, `行超出 maxWidth(${MAX}):w=${width(l)} ${JSON.stringify(l)}`);
  }
});

test('renderPlainTable:折出的续行回到第二列(不退回第 0 列)', () => {
  const MAX = 60;
  const lines = mod.renderPlainTable(
    { rows: [['维度', 'KHY OS'], ['设计', LONG]], colCount: 2 },
    { measure: width, maxWidth: MAX, wrapLines: wrapCellLines }
  );
  // 表头行的第二列起始列 = 缩进 + 第一列宽 + 2 空格槽
  const header = lines[0];
  const col2Start = header.length - header.replace(/^\s*/, '').length + width('维度') + 2;
  const continuations = lines.filter((l) => /^\s{4,}\S/.test(l));
  assert.ok(continuations.length > 0, '应存在续行');
  for (const c of continuations) {
    const lead = c.length - c.replace(/^\s*/, '').length;
    assert.strictEqual(lead, col2Start, `续行缩进应等于第二列起始列:${JSON.stringify(c)}`);
  }
});

test('renderPlainTable:短标签列在收缩时完整保留(不被折碎)', () => {
  const lines = mod.renderPlainTable(
    { rows: [['错、只记录', 'X'.repeat(300)], ['持久化', 'Y'.repeat(300)]], colCount: 2 },
    { maxWidth: 60, wrapLines: wrapCellLines }
  );
  assert.ok(
    lines.some((l) => l.includes('错、只记录')),
    '标签列必须完整保留,不能被压成 `错、只记` + `录`'
  );
  assert.ok(lines.some((l) => l.includes('持久化')), '标签列必须完整保留');
});

test('renderPlainTable:收缩后分隔线不超 maxWidth', () => {
  const MAX = 60;
  const lines = mod.renderPlainTable(
    { rows: [['name', 'role'], ['alice', 'D'.repeat(300)]], colCount: 2 },
    { measure: width, maxWidth: MAX, wrapLines: wrapCellLines }
  );
  const rule = lines[1];
  assert.ok(/^\s*-{3,}/.test(rule), '第二行应是 dash 分隔');
  assert.ok(width(rule) <= MAX, `分隔线超宽:w=${width(rule)}`);
});

test('renderPlainTable:不传 maxWidth 时不折行(旧行为逐字节保留)', () => {
  const lines = mod.renderPlainTable({ rows: [['a', 'B'.repeat(300)]], colCount: 2 });
  assert.strictEqual(lines.length, 1, '单行表格仍只渲染一行');
  assert.strictEqual(width(lines[0]), 2 + 1 + 2 + 300, '未给预算时保持自然列宽');
});

test('renderPlainTable:给了 maxWidth 但内容不超宽时不折行', () => {
  const lines = mod.renderPlainTable(
    { rows: [['a', 'b'], ['c', 'd']], colCount: 2 },
    { maxWidth: 200, wrapLines: wrapCellLines }
  );
  assert.strictEqual(lines.length, 3, '表头 + 分隔 + 1 数据行');
  assert.strictEqual(lines[2], '  c  d');
});

test('renderPlainTable:下划线与列几何精确镜像（窄列不吞两空格槽位）', () => {
  // 存量缺陷：dash 段用 Math.max(3, w)，宽度<3 的窄列（如 '#'、'ID'）
  // 溢进 2 空格槽位 → 其后所有段整体右移、脱离所在列。
  const lines = mod.renderPlainTable(
    { rows: [['#', 'Name'], ['1', 'bob']], colCount: 2 },
    {}
  );
  // 列宽 = [1, 4]；下划线必须逐字符镜像 buildLine 几何。
  assert.strictEqual(lines[1], '  -  ----');
});
