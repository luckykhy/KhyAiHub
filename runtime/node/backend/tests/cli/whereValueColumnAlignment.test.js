'use strict';

// #117 — `khy where` diagnostic rows must align their values at the same
// display column. The CJK label 「项目根目录」 is 5 double-width chars (10
// display cols) but was hand-counted as 5, so its value landed one column
// right of every other row.

const assert = require('assert');
const nt = require('node:test');

process.env.NO_COLOR = '1';
process.env.FORCE_COLOR = '0';

// CJK / fullwidth = 2 display columns.
const dlw = (s) => [...String(s)].reduce(
  (w, ch) => w + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1), 0);

function captureRows() {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  try {
    // Fresh require each call; handleWhere is deterministic for the labels.
    delete require.cache[require.resolve('../../src/cli/handlers/where.js')];
    const { handleWhere } = require('../../src/cli/handlers/where.js');
    handleWhere();
  } finally {
    console.log = orig;
  }
  const rows = [];
  for (const line of logs) {
    const m = line.match(/^ {2}(\S+)( +)(\S.*)$/);
    if (!m) continue;
    rows.push({ label: m[1], valueCol: dlw(m[1] + m[2]) });
  }
  return rows;
}

nt('#117 all five rows report a value (non-vacuity)', () => {
  const rows = captureRows();
  const labels = rows.map((r) => r.label);
  for (const need of ['入口文件', '项目根目录', '版本', '安装类型', 'Node.js']) {
    assert.ok(labels.includes(need), `missing row: ${need}`);
  }
  assert.strictEqual(rows.length, 5, `expected 5 rows, got ${rows.length}`);
});

nt('#117 value columns share one display offset', () => {
  const rows = captureRows();
  const cols = new Set(rows.map((r) => r.valueCol));
  assert.strictEqual(cols.size, 1,
    `value columns diverged: ${rows.map((r) => `${r.label}@${r.valueCol}`).join(', ')}`);
});
