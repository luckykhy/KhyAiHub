'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildPlan, _humanBytes } = require('./planner.js');

// Shared fixture: one candidate per branch of buildPlan's bucketing logic.
// safety values pinned from junkCatalog.REVIEW === 'review' (measured).
function makeScan() {
  return {
    platform: 'win32',
    driveRoots: ['C:'],
    candidates: [
      { id: 'a', category: 'temp', drive: 'C:', safety: 'review', eligible: true, sizeBytes: 100 },
      { id: 'b', category: 'temp', drive: 'C:', safety: 'safe', eligible: true, sizeBytes: 200 },
      { id: 'c', category: 'cache', drive: 'D:', safety: 'safe', eligible: false, skipReason: '不存在', sizeBytes: 0 },
      { id: 'd', category: 'cache', drive: 'D:', safety: 'safe', eligible: false, skipReason: '受保护', sizeBytes: 0 },
      { id: 'e', category: 'logs', drive: 'C:', safety: 'safe', eligible: true },
      { id: 'f', category: 'trash', drive: 'C:', safety: 'review', eligible: true, sizeBytes: 999 },
    ],
  };
}

const ids = (arr) => arr.map((c) => c.id);

test('默认计划：safe 入 selected，review 入 review，受保护入 skipped，不存在被隐藏', () => {
  const plan = buildPlan(makeScan());
  assert.deepEqual(ids(plan.selected), ['b', 'e']);
  assert.deepEqual(ids(plan.review), ['a', 'f']);
  assert.deepEqual(ids(plan.skipped), ['d']);
  assert.equal(plan.platform, 'win32');
  assert.deepEqual(plan.driveRoots, ['C:']);
  assert.equal(plan.includeReview, false);
});

test('totals 汇总数字与人类可读串逐字节一致', () => {
  const plan = buildPlan(makeScan());
  assert.deepEqual(plan.totals, {
    selectedCount: 2,
    selectedBytes: 200,
    selectedHuman: '200 B',
    reviewCount: 2,
    reviewBytes: 1099,
    reviewHuman: '1.1 KB',
    skippedCount: 1,
  });
});

test('byCategory/byDrive 按 selected 聚合，sizeBytes 缺失记 0', () => {
  const plan = buildPlan(makeScan());
  // candidate 'e' has no sizeBytes → counted as bytes 0 but still counted
  assert.deepEqual(plan.byCategory, {
    temp: { count: 1, bytes: 200 },
    logs: { count: 1, bytes: 0 },
  });
  assert.deepEqual(plan.byDrive, { 'C:': { count: 2, bytes: 200 } });
});

test('includeReview=true 放行全部 review 条目进入 selected', () => {
  const plan = buildPlan(makeScan(), { includeReview: true });
  assert.deepEqual(ids(plan.selected), ['a', 'b', 'e', 'f']);
  assert.deepEqual(ids(plan.review), []);
  assert.equal(plan.includeReview, true);
});

test('includeIds 只点名指定 review 条目，其余留在 review 列', () => {
  const plan = buildPlan(makeScan(), { includeIds: ['a'] });
  assert.deepEqual(ids(plan.selected), ['a', 'b', 'e']);
  assert.deepEqual(ids(plan.review), ['f']);
});

test('includeIds 白名单外的 id 无效，不改变分档', () => {
  const plan = buildPlan(makeScan(), { includeIds: ['nope'] });
  assert.deepEqual(ids(plan.selected), ['b', 'e']);
  assert.deepEqual(ids(plan.review), ['a', 'f']);
});

test('categories 过滤命中类目；空数组等同于不过滤', () => {
  const filtered = buildPlan(makeScan(), { categories: ['temp'] });
  assert.deepEqual(ids(filtered.selected), ['b']);
  assert.deepEqual(ids(filtered.review), ['a']);
  assert.deepEqual(ids(filtered.skipped), []);
  // Empty array falls through the `length ? ... : null` guard → no filter.
  const noFilter = buildPlan(makeScan(), { categories: [] });
  assert.deepEqual(ids(noFilter.selected), ['b', 'e']);
});

test('categories 过滤在分档之前执行：skipped 里被滤掉的类目不出现', () => {
  const plan = buildPlan(makeScan(), { categories: ['temp'] });
  // 'd' (cache, skipped) and 'f' (trash, review) are dropped entirely,
  // not even surfaced as skipped noise.
  assert.equal(plan.totals.skippedCount, 0);
  assert.equal(plan.totals.reviewCount, 1);
});

test('空候选集返回完整计划骨架，human 串为 0 B', () => {
  const plan = buildPlan({ platform: 'linux', driveRoots: [], candidates: [] });
  assert.deepEqual(plan.selected, []);
  assert.deepEqual(plan.review, []);
  assert.deepEqual(plan.skipped, []);
  assert.deepEqual(plan.byCategory, {});
  assert.deepEqual(plan.byDrive, {});
  assert.equal(plan.totals.selectedHuman, '0 B');
  assert.equal(plan.totals.reviewHuman, '0 B');
});

test('缺 candidates 字段的输入直接抛 TypeError（无 fail-soft）', () => {
  assert.throws(() => buildPlan(null), TypeError);
  assert.throws(() => buildPlan(undefined), TypeError);
  assert.throws(() => buildPlan({}), TypeError);
  assert.throws(() => buildPlan('not-an-object'), TypeError);
});

test('_humanBytes 再导出与 byteFormat 口径一致', () => {
  assert.equal(_humanBytes(0), '0 B');
  assert.equal(_humanBytes(1536), '1.5 KB');
  assert.equal(_humanBytes(5 * 1024 * 1024 * 1024), '5.0 GB');
});

test('KNOWN-DEFECT: eligible=false 且无 skipReason 的候选从所有档位静默消失', () => {
  // planner.js:46-52 → input: [{eligible:false}] without skipReason
  // measured: selected/review/skipped all empty, totals count it nowhere.
  const plan = buildPlan({
    candidates: [{ id: 'ghost', category: 'temp', drive: 'C:', safety: 'safe', eligible: false }],
  });
  assert.deepEqual(plan.selected, []);
  assert.deepEqual(plan.review, []);
  assert.deepEqual(plan.skipped, []);
  assert.equal(plan.totals.skippedCount, 0);
});

test('KNOWN-DEFECT: 负 sizeBytes 计入 selectedBytes 为负数，人类可读串却是 0 B', () => {
  // planner.js:74-87 → input: one eligible candidate with sizeBytes: -5.
  // measured: totals.selectedBytes === -5 while selectedHuman === '0 B'
  // (_humanBytes floors negatives), so the two fields contradict each other.
  const plan = buildPlan({
    candidates: [{ id: 'n', category: 'c', drive: 'C:', safety: 'safe', eligible: true, sizeBytes: -5 }],
  });
  assert.equal(plan.totals.selectedBytes, -5);
  assert.equal(plan.totals.selectedHuman, '0 B');
  assert.deepEqual(plan.byCategory, { c: { count: 1, bytes: -5 } });
});
