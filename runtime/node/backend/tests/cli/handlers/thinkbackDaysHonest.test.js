'use strict';

/**
 * thinkbackDaysHonest.test.js — `/thinkback --days` 选项诚实契约(hci-r42)。
 *
 * 复现源自 .khy/feedback/hci-r42-thinkback-days/ :parseInput 把 `--days N` 捕获进
 * options(不在 args),而旧 handler 只 raw-scan [subCommand,...args] 且收下 _options
 * 即弃 → CLI `khy thinkback --days 7` 永远显示「近 30 天」(幻影选项),非法值
 * (abc/0)与超上限(5000)静默按 30,连 schema 声称的 clamp 365 都没兑现。
 *
 * 断言面:options.days 生效(标题 + 真正传给 tokenUsageService 的天数)、
 * 无效/缺值/超上限各自提示且行为如实、args 历史形态(--days/-d)保留、
 * 裸调用零提示(happy path 不新增噪音)。node --test only.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const BACKEND = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(BACKEND, 'src');

function seed(absPath, exportsObj) {
  const m = new Module(absPath, null);
  m.filename = absPath;
  m.loaded = true;
  m.exports = exportsObj;
  require.cache[absPath] = m;
}

const rec = { info: [], error: [] };
seed(path.join(SRC, 'cli', 'formatters.js'), {
  printSuccess: () => {},
  printError: (m) => rec.error.push(String(m)),
  printInfo: (m) => rec.info.push(String(m)),
  printWarn: () => {},
  printTable: () => {},
});

const HIST = [
  { date: '2026-09-20', totalTokens: 1200, requests: 3, costUSD: 0.02 },
  { date: '2026-09-21', totalTokens: 3400, requests: 7, costUSD: 0.05 },
];
const seen = { daysArgs: [] };
seed(path.join(SRC, 'services', 'tokenUsageService.js'), {
  getUsageHistory: (days) => {
    seen.daysArgs.push(days);
    return HIST.slice();
  },
});
seed(path.join(SRC, 'services', 'usageHabitService.js'), {
  getHabitSummary: () => ({}),
});

const { handleThinkback, _parseDays } = require(path.join(SRC, 'cli', 'handlers', 'thinkback.js'));

function reset() {
  rec.info.length = 0;
  rec.error.length = 0;
  seen.daysArgs.length = 0;
}

async function run(subCommand, args, options) {
  reset();
  const ok = await handleThinkback(subCommand, args, options);
  assert.equal(ok, true);
  return rec.info.join('\n');
}

test('T1 CLI 通道:options.days=7 生效——标题近 7 天且真传给数据层,零提示噪音', async () => {
  const out = await run(null, [], { days: '7' });
  assert.match(out, /使用回顾（近 7 天）/);
  assert.deepEqual(seen.daysArgs, [7]);
  assert.doesNotMatch(out, /无效|超出上限|缺少值/);
  // 非空断言:数据确实聚合出来了,不是空转
  assert.match(out, /请求合计: 10/);
});

test('T2 超上限:5000 → 如实钳到 365 并提示,不再静默按 30', async () => {
  const out = await run(null, [], { days: '5000' });
  assert.match(out, /--days 5000 超出上限,按 365 天展示/);
  assert.match(out, /使用回顾（近 365 天）/);
  assert.deepEqual(seen.daysArgs, [365]);
});

test('T3 非法值:abc → 明示无效 + 有效范围,按默认 30 展示', async () => {
  const out = await run(null, [], { days: 'abc' });
  assert.match(out, /--days 值「abc」无效\(有效范围 1\.\.365\),按默认 30 天展示/);
  assert.match(out, /使用回顾（近 30 天）/);
});

test('T4 缺值:`--days` 悬空(options=true) → 提示缺少值而非静默', async () => {
  const out = await run(null, [], { days: true });
  assert.match(out, /--days 缺少值\(有效范围 1\.\.365\),按默认 30 天展示/);
  assert.match(out, /使用回顾（近 30 天）/);
});

test('T5 args 历史形态兜底:--days 3 / -d 7 仍然生效', async () => {
  let out = await run(null, ['--days', '3'], {});
  assert.match(out, /使用回顾（近 3 天）/);
  out = await run(null, ['-d', '7'], {});
  assert.match(out, /使用回顾（近 7 天）/);
  out = await run(null, ['--days=5'], {});
  assert.match(out, /使用回顾（近 5 天）/);
});

test('T6 优先级:options.days 覆盖 args 里的杂散 token', async () => {
  const out = await run(null, ['--days', '9'], { days: '14' });
  assert.match(out, /使用回顾（近 14 天）/);
});

test('T7 裸调用零提示:默认 30 天路径不新增噪音', async () => {
  const out = await run(null, [], {});
  assert.match(out, /使用回顾（近 30 天）/);
  assert.doesNotMatch(out, /无效|超出上限|缺少值/);
});

test('T8 _parseDays 向后兼容:仅返数值,合法/钳制/非法语义不变', () => {
  assert.equal(_parseDays(null, ['--days', '7']), 7);
  assert.equal(_parseDays(null, ['--days', '5000']), 365);
  assert.equal(_parseDays(null, ['--days', 'abc']), 30);
  assert.equal(_parseDays(null, []), 30);
});
