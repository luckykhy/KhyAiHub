'use strict';

/**
 * spinnerStallLine — 等待行文案的契约（规则 2.5：等待状态必须显示「在等什么 + 已经多久」）。
 *
 * 为什么单独立测：这条文案以前只在 ink 渲染测试里被间接断言，而 ink 渲染环境在部分机器上
 * 缺席（inkRenderSmoke 会整体 skip），于是「等待行是不是带着实际数据」长期没有守卫。现在
 * 组装抽成纯函数（Spinner.buildStallLine），任何环境都能锁住它。
 *
 * 被锁的三件事：
 *   ① 目标来自实际数据（detail 优先 / label 兜底），不是固定短语；
 *   ② 停滞秒数来自 stalledSec（lastActivity→now 的真实间隔），有数就必须出现；
 *   ③ meta 不再重复同一个时长（buildSpinnerMeta 的 skipDuration）—— 一个数出现两遍是缺陷。
 *
 * node:test（与同目录 spinner 系测试一致）。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const Spinner = require(path.join(
  __dirname,
  '..',
  '..',
  'src',
  'cli',
  'tui',
  'ink-components',
  'Spinner'
));

const { buildStallLine, buildSpinnerMeta, statusSegmentOf } = Spinner;

test('buildStallLine:目标 + 实际停滞秒数（规则 2.5 的合规形状）', () => {
  assert.strictEqual(
    buildStallLine('执行 npm run build', 30),
    '⏳ 等待中 · 执行 npm run build（已 30s）'
  );
});

test('buildStallLine:有目标无秒数 → 不加空后缀，也不编一个数', () => {
  assert.strictEqual(buildStallLine('读取 src/index.js', 0), '⏳ 等待中 · 读取 src/index.js');
  assert.strictEqual(buildStallLine('读取 src/index.js', undefined), '⏳ 等待中 · 读取 src/index.js');
  assert.strictEqual(buildStallLine('读取 src/index.js', null), '⏳ 等待中 · 读取 src/index.js');
});

test('buildStallLine:无目标但有秒数 → 必须带数，不得退化成光秃秃一句等待中', () => {
  // 规则 2.5 的 ❌ 反例正是「⏳ 等待中」/「⏳ 请稍候…」这种什么都没说的行。
  assert.strictEqual(buildStallLine('', 12), '⏳ 等待中（已 12s）');
  assert.strictEqual(buildStallLine('   ', 12), '⏳ 等待中（已 12s）');
});

test('buildStallLine:目标里的换行/多空格折成一格（单行渲染，行数预算不能被撑坏）', () => {
  assert.strictEqual(
    buildStallLine('等待模型\n  响应中', 5),
    '⏳ 等待中 · 等待模型 响应中（已 5s）'
  );
});

test('buildStallLine:junk 输入不产出 "undefined"/"NaN"', () => {
  for (const v of [undefined, null, 0, {}, [], () => {}]) {
    const out = buildStallLine(v, 7);
    assert.doesNotMatch(out, /undefined|null|NaN/);
    assert.ok(out.startsWith('⏳ 等待中'));
  }
  // 秒数为垃圾 → 视作未知，不编造
  for (const v of ['abc', {}, [], NaN, -5]) {
    assert.strictEqual(buildStallLine('X', v), '⏳ 等待中 · X');
  }
});

test('buildSpinnerMeta:skipDuration 去掉时长段但保留 tokens（停滞行已表达时长）', () => {
  // >30s 让 meta 的时长段本会出现
  assert.strictEqual(buildSpinnerMeta(31, 340, {}, { skipDuration: true }), ' · ~340 tok');
  // 时长去掉后什么都不剩 → 返回 ''，而不是留一个孤零零的 ' · '
  assert.strictEqual(buildSpinnerMeta(31, 0, {}, { skipDuration: true }), '');
  // 不传 / false → 与既有行为逐字节一致（向后兼容）
  assert.strictEqual(buildSpinnerMeta(31, 340, {}, {}), ' · 31s · ~340 tok');
  assert.strictEqual(buildSpinnerMeta(31, 340, {}, { skipDuration: false }), ' · 31s · ~340 tok');
  assert.strictEqual(buildSpinnerMeta(31, 340, {}), ' · 31s · ~340 tok');
});

// ── statusSegmentOf：状态语义（「spinner 文案的直观」的判据）─────────────────
// 用户原话:「spinner 文案的直观」。
// 病根是 `displayText = detail || label` 恒定走 detail 分支 —— 屏幕只剩「在做什么」,
// 而「是在等模型、还是在跑工具」这两个**语义完全不同**的停顿反而消失了。
// 这里的解法不新增任何文案表:状态段从既有 label 里**按既有分隔符提取**。

test('statusSegmentOf:从 label 的既有形状里取出状态段', () => {
  assert.strictEqual(statusSegmentOf('思考中… · 分析用户意图'), '思考中…');
  assert.strictEqual(statusSegmentOf('执行工具… · 读取 src/index.js'), '执行工具…');
  assert.strictEqual(statusSegmentOf('生成中… · 重试 2 次'), '生成中…');
});

test('statusSegmentOf:没有分隔符 → 整串就是状态词（不臆造）', () => {
  assert.strictEqual(statusSegmentOf('思考中…'), '思考中…');
  assert.strictEqual(statusSegmentOf('本地引擎应答中（不调用模型）…'), '本地引擎应答中（不调用模型）…');
});

test('statusSegmentOf:空 / 垃圾输入 → 空串（渲染层据此不补状态段，绝不产出 "undefined"）', () => {
  for (const v of ['', '   ', null, undefined]) {
    assert.strictEqual(statusSegmentOf(v), '');
  }
  // 分隔符紧贴开头（归一化的 trim 会先吃掉前导空格）→ 退化成「整串即状态词」。
  // 这是**可接受**的保守行为：它不臆造状态段，也不会把目标当成状态词藏起来。
  assert.strictEqual(statusSegmentOf(' · 只有目标'), '· 只有目标');
  assert.strictEqual(statusSegmentOf('· 只有目标'), '· 只有目标');
});

test('statusSegmentOf:换行/多空格折成一格，且不动目标部分', () => {
  assert.strictEqual(statusSegmentOf('思考中…\n  ·  分析用户意图'), '思考中…');
});
