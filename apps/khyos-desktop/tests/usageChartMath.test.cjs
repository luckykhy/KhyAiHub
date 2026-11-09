'use strict';

// usageChartMath.test.cjs — 使用统计页图表数学的钉住用例。
//
// runner 纪律（照 sidebarProjectClassify.test.cjs:11-31 的成例）：本文件用
// node:test 写、放在 tests/ 下安全。模块是零 import 的纯 TS 叶子，用仓里现成的
// typescript 做正规转译求值——不要用正则剥类型，那是猜。

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const modPath = join(__dirname, '..', 'src', 'renderer', 'shared', 'usageChartMath.ts');
const src = readFileSync(modPath, 'utf-8');

const ts = require('typescript');
function loadModule() {
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('exports', 'module', 'require', js)(module.exports, module, require);
  return module.exports;
}

const M = loadModule();

function day(over) {
  return Object.assign(
    { date: '2026-10-11', inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0, costUSD: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    over,
  );
}

// ── stackSegments：两段，段高和 == input + output == 日桶 totalTokens ──

test('stackSegments: 满数据日返回两段，段高和恒等于 (input+output) 按轴上限缩放', () => {
  const d = day({ inputTokens: 1_964_263, outputTokens: 16_463, totalTokens: 1_980_726, requests: 54 });
  const maxTotal = 2_000_000;
  const H = 100;
  const segs = M.stackSegments(d, maxTotal, H);
  assert.strictEqual(segs.length, 2);
  assert.deepStrictEqual(segs.map((s) => s.key), ['input', 'output']);
  const sum = segs.reduce((a, s) => a + s.height, 0);
  const expected = ((d.inputTokens + d.outputTokens) / maxTotal) * H;
  assert.ok(Math.abs(sum - expected) < 1e-6, `段高和应等于 (input+output)/maxTotal×H=${expected}，实得 ${sum}`);
  // 轴上限取整后铺满时，段高和恰为整高
  const full = M.stackSegments(day({ inputTokens: 100, outputTokens: 20, requests: 1 }), 120, 100);
  const fullSum = full.reduce((a, s) => a + s.height, 0);
  assert.ok(Math.abs(fullSum - 100) < 1e-9, `轴上限=当日合计时段高和应为整高 100，实得 ${fullSum}`);
  // 输出段贴底，输入段在其上方
  assert.ok(Math.abs(segs[1].y + segs[1].height - H) < 1e-6, '输出段底边应贴基线');
  assert.ok(Math.abs(segs[0].y + segs[0].height - segs[1].y) < 1e-6, '输入段顶边应贴输出段底边');
});

test('stackSegments: 段高和等于日桶 totalTokens，不被重算成四桶和', () => {
  // 四桶和 2,933,046 ≠ 桶 totalTokens 1,980,726。缓存两列是独立累加器，
  // 叠进「总量」就是凭空造出第三个口径——这条把它钉死。
  const d = day({
    inputTokens: 1_964_263,
    outputTokens: 16_463,
    totalTokens: 1_980_726,
    requests: 54,
    cacheReadTokens: 952_320,
    cacheWriteTokens: 0,
  });
  const fourBucketSum = d.inputTokens + d.outputTokens + d.cacheReadTokens + d.cacheWriteTokens;
  const segs = M.stackSegments(d, fourBucketSum, 100);
  const sum = segs.reduce((a, s) => a + s.height, 0);
  const expected = (d.totalTokens / fourBucketSum) * 100;
  assert.ok(
    Math.abs(sum - expected) < 1e-6,
    `段高和应按 totalTokens/dailyMax 缩放（${expected}），不得按四桶和（100）`,
  );
});

test('stackSegments: 空桶返回 0 段，并由 isEmptyDay 判真（替代 sqrt 的正解）', () => {
  const empty = day({});
  assert.strictEqual(M.isEmptyDay(empty), true);
  assert.deepStrictEqual(M.stackSegments(empty, 1000, 100), []);
  // 有请求但 token 为 0 也算「有记录」——不参与柱高是因为没有量，不是没记
  assert.strictEqual(M.isEmptyDay(day({ requests: 0, inputTokens: 5 })), false);
  assert.strictEqual(M.isEmptyDay(null), true);
});

test('stackSegments: maxTotal 非正 / height 非正时不炸', () => {
  const d = day({ inputTokens: 10, outputTokens: 5, requests: 1 });
  assert.deepStrictEqual(M.stackSegments(d, 0, 100), []);
  assert.deepStrictEqual(M.stackSegments(d, 100, 0), []);
});

// ── niceCeilLinear：线性轴上限 ──

test('niceCeilLinear: 取整到 nice 数且不小于输入', () => {
  assert.strictEqual(M.niceCeilLinear(1), 1);
  assert.strictEqual(M.niceCeilLinear(3), 3);
  assert.strictEqual(M.niceCeilLinear(7.5), 7.5);
  assert.strictEqual(M.niceCeilLinear(1000), 1000);
  // 2_933_046 → 3 × 10⁶
  assert.strictEqual(M.niceCeilLinear(2933046), 3000000);
});

test('niceCeilLinear: 单调不减（更大的 max 不得到更小的轴上限）', () => {
  const xs = [1, 3, 7.5, 1000, 1964263, 2933046, 98765432];
  for (let i = 1; i < xs.length; i++) {
    assert.ok(
      M.niceCeilLinear(xs[i]) >= M.niceCeilLinear(xs[i - 1]),
      `单调性破坏于 ${xs[i - 1]} → ${xs[i]}`,
    );
  }
});

test('niceCeilLinear: 非有限/非正输入回 1，不给假轴', () => {
  assert.strictEqual(M.niceCeilLinear(0), 1);
  assert.strictEqual(M.niceCeilLinear(-5), 1);
  assert.strictEqual(M.niceCeilLinear(NaN), 1);
  assert.strictEqual(M.niceCeilLinear(Infinity), 1);
});

// ── csvFromDays：表头恰 9 列 ──

test('csvFromDays: 表头恰 9 列且第 9 列是 sources 口径列', () => {
  const csv = M.csvFromDays([]);
  const headerLine = csv.split('\n').find((l) => l.startsWith('date,'));
  assert.ok(headerLine, '应能找到表头行');
  const cols = headerLine.split(',');
  assert.strictEqual(cols.length, 9, `表头必须恰 9 列，实得 ${cols.length}: ${headerLine}`);
  assert.strictEqual(cols[8], 'sources');
  assert.strictEqual(M.CSV_HEADERS.length, 9);
});

test('csvFromDays: 每行也是 9 列，sources 列恒为口径注记', () => {
  const csv = M.csvFromDays([
    day({ inputTokens: 1_964_263, outputTokens: 16_463, totalTokens: 1_980_726, requests: 54, cacheReadTokens: 952_320 }),
  ]);
  const dataLines = csv.split('\n').filter((l) => l && !l.startsWith('#'));
  assert.strictEqual(dataLines.length, 2, '表头 + 1 行数据');
  const row = dataLines[1].split(',');
  assert.strictEqual(row.length, 9);
  assert.strictEqual(row[0], '2026-10-11');
  assert.strictEqual(row[1], '1964263');
  assert.strictEqual(row[3], '1980726', 'totalTokens 列写日桶原值，不写四桶和');
  assert.strictEqual(row[8], M.CSV_SOURCES_NOTE);
});

test('csvFromDays: 含「非全量历史」抬头与「合计 = 输入 + 输出，不含缓存」注记', () => {
  const csv = M.csvFromDays([], { stamp: '2026-10-11T10:00:16.839Z', rangeDays: 30 });
  assert.match(csv, /非全量历史/);
  assert.match(csv, /合计 = 输入 \+ 输出，不含缓存/);
  assert.match(csv, /数据截至: 2026-10-11T10:00:16\.839Z/);
  assert.match(csv, /统计窗口: 近 30 日/);
});

test('csvFromDays: stamp 为 null 时不写「数据截至」行（不产出 undefined）', () => {
  const csv = M.csvFromDays([], { stamp: null, rangeDays: 7 });
  assert.doesNotMatch(csv, /数据截至/);
  assert.doesNotMatch(csv, /undefined/);
});

test('csvFromDays: 空数组不炸', () => {
  const csv = M.csvFromDays([]);
  assert.ok(csv.length > 0);
  assert.strictEqual(csv.split('\n').filter((l) => l && !l.startsWith('#')).length, 1);
});

// ── 落地后自检：渲染层不得画缓存段 / 不得用 brand 色 ──────────────

test('usageCharts.tsx 用 trajectory/diff 语义色，不用 --color-brand', () => {
  const charts = readFileSync(
    join(__dirname, '..', 'src', 'renderer', 'components', 'settings', 'usageCharts.tsx'),
    'utf-8',
  );
  // --color-brand 深浅主题分别是 #ffffff / #000000，浅色主题白底上不可见
  assert.doesNotMatch(charts, /var\(--color-brand\)/, '图表不得使用 --color-brand');
  assert.match(charts, /var\(--color-trajectory-user\)/);
  assert.match(charts, /var\(--color-trajectory-assistant\)/);
  assert.match(charts, /var\(--color-diff-removed\)/, 'Missing 态须与真实数据异色');
});

test('UsageSettings.tsx 不出缓存命中率百分比，也不画缓存堆叠段', () => {
  const page = readFileSync(
    join(__dirname, '..', 'src', 'renderer', 'components', 'settings', 'UsageSettings.tsx'),
    'utf-8',
  );
  assert.doesNotMatch(page, /命中率\s*[:：]?\s*\{/, '不得输出命中率百分比（口径未定）');
  assert.doesNotMatch(page, /hitRate|cacheHitPct/, '不得引入命中率计算');
  assert.match(page, /口径未审计/, '缓存两数须带「口径未审计」标注');
});

test('UsageSettings.tsx 页脚：stamp 为 null 时整行不渲染', () => {
  const page = readFileSync(
    join(__dirname, '..', 'src', 'renderer', 'components', 'settings', 'UsageSettings.tsx'),
    'utf-8',
  );
  assert.match(page, /\{stamp && <div>数据截至/, '「数据截至」须由 stamp 真值守卫');
});