'use strict';

const test = require('node:test');
const assert = require('node:assert');
const stringWidth = require('string-width');
const dc = require('../../src/services/domain/backup/diskCleanup');

function plan() {
  return {
    platform: 'win32',
    driveRoots: ['C:', 'D:'],
    totals: {
      selectedCount: 12,
      selectedHuman: '3.4 GB',
      reviewCount: 5,
      reviewHuman: '1.1 GB',
      skippedCount: 2,
    },
    byCategory: {
      浏览器缓存: { count: 7, bytes: 123456789 },
      临时文件: { count: 5, bytes: 9876543 },
    },
    skipped: [
      { label: '系统关键目录', skipReason: '受保护' },
      { label: '云端同步盘', skipReason: '含未同步' },
    ],
  };
}

test('diskCleanup renderPlanReport: 全角内容下所有边框行显示宽度恒等于总宽', () => {
  const rows = dc.renderPlanReport(plan()).split('\n');
  assert.ok(rows.length >= 8, 'expected a multi-row box');
  const widths = rows.map((l) => stringWidth(l));
  assert.strictEqual(
    new Set(widths).size,
    1,
    `right border must sit in one column, got: ${widths.join(',')}`
  );
});

test('diskCleanup renderPlanReport: 超长全角分类名被截断但仍不破右边界', () => {
  const p = plan();
  p.byCategory = { 一个非常非常非常长的分类名称占位: { count: 99, bytes: 1e12 } };
  const widths = dc.renderPlanReport(p).split('\n').map((l) => stringWidth(l));
  assert.ok(
    widths.every((w) => w === widths[0]),
    `truncation must not break the border, got: ${widths.join(',')}`
  );
});

test('diskCleanup renderPlanReport: 空态仍成框且各边框对齐', () => {
  const p = plan();
  p.byCategory = {};
  p.totals.reviewCount = 0;
  p.totals.skippedCount = 0;
  p.skipped = [];
  const widths = dc.renderPlanReport(p).split('\n').map((l) => stringWidth(l));
  assert.ok(widths.length >= 5 && widths.every((w) => w === widths[0]), `empty box misaligned: ${widths.join(',')}`);
});
