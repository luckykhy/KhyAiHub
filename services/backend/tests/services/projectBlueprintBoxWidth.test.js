'use strict';

const test = require('node:test');
const assert = require('node:assert');
const stringWidth = require('string-width');
const blueprint = require('../../src/services/domain/project/projectBlueprint');

// Box-drawing rows are every line that carries a border glyph.
function boxRows(out) {
  return out.split('\n').filter((l) => l.includes('│') || l.includes('─'));
}

test('renderPlanReport: CJK 里程碑框右边界按显示宽度对齐', () => {
  const p = {
    ok: true,
    id: 'demo',
    label: '示例项目蓝图',
    milestones: [
      { index: 0, title: '搭建数据库与鉴权', fileCount: 5 },
      { index: 1, title: 'REST 接口层', fileCount: 8 },
    ],
  };
  const rows = boxRows(blueprint.renderPlanReport(p));
  assert.ok(rows.length >= 5, 'expected a bordered box with content rows');
  const widths = rows.map((l) => stringWidth(l));
  assert.strictEqual(
    new Set(widths).size,
    1,
    `right border must be a single column, got widths: ${widths.join(',')}`
  );
});

test('renderPlanReport: 纯 ASCII 内容与旧 padEnd 行为一致(每行字符数==显示宽度)', () => {
  const p = {
    ok: true,
    id: 'a',
    label: 'Alpha',
    milestones: [{ index: 0, title: 'step', fileCount: 3 }],
  };
  const rows = boxRows(blueprint.renderPlanReport(p));
  // Every box row must close at the same display column, and that column is
  // constant regardless of how many code units the leading CJK title costs.
  const widths = rows.map((l) => stringWidth(l));
  assert.strictEqual(new Set(widths).size, 1, `ascii box must align: ${widths.join(',')}`);
});
