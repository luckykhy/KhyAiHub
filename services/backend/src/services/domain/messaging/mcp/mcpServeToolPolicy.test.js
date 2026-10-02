/**
 * mcpServeToolPolicy.test.js — 钉死 `khy mcp serve` 暴露策略的模式解析/过滤/汇总。
 *
 * 为什么这支套件必须存在：这个叶子决定对外 MCP 服务器暴露哪些本地工具（含
 * shell/文件写/破坏性工具的取舍）。契约宣称"绝不抛"，一旦某分支抛穿，serve
 * 启动横幅与工具列表整个塌掉；风险分级（RISK_ORDER）与安全模式的边界算术
 * 也只能靠测钉死。
 *
 * 实测更正（与源码注释/上游直觉不同处，按真实语义钉死）：
 * 1. resolveExposeMode 对未知值（'Safe' trim+lower 后合法；'reads'/'readonly '
 *    等）一律回落 'all' —— 缺省宽松而非严格。
 * 2. safe 模式 = isReadOnly()真 ∪ risk ordinal ≤ 1（safe/low）；risk 缺失的写
 *    工具按 medium(2) 被排除，但 isReadOnly 抛异常的工具也按 false 排除（保守）。
 * 3. summarizeExposure 中未知/非字符串 risk 归入 byRisk.medium —— 不新建桶。
 * 4. isDestructive() 抛 → 被 catch 吞掉且"不升级"hasDestructive —— 与注释里
 *    "保守"方向相反：更安全的做法是抛即视为破坏性，实测钉住该宽松方向。
 * 5. selectExposedTools(null) / (非数组) → []；null 元素被 filter(Boolean) 剔除。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('./mcpServeToolPolicy');
const { RISK_ORDER } = require('../../../../constants/riskOrder');

function tool(name, { risk, readOnly, destructive } = {}) {
  const t = { name };
  if (risk !== undefined) t.risk = risk;
  if (readOnly !== undefined) t.isReadOnly = () => readOnly;
  if (destructive !== undefined) t.isDestructive = () => destructive;
  return t;
}

test('servePolicy: 导出面与模式常量冻结', () => {
  assert.deepStrictEqual(Object.keys(leaf).sort(), ['EXPOSE_MODES', 'resolveExposeMode', 'selectExposedTools', 'summarizeExposure']);
  assert.ok(Object.isFrozen(leaf.EXPOSE_MODES));
  assert.deepStrictEqual({ ...leaf.EXPOSE_MODES }, { ALL: 'all', SAFE: 'safe', READONLY: 'readonly' });
  assert.equal(RISK_ORDER.low, 1);
  assert.equal(RISK_ORDER.high, 3);
});

test('servePolicy: resolveExposeMode —— 空白/大小写宽容，未知一律 all', () => {
  assert.equal(leaf.resolveExposeMode({ KHY_MCP_SERVE_EXPOSE: 'SAFE' }), 'safe');
  assert.equal(leaf.resolveExposeMode({ KHY_MCP_SERVE_EXPOSE: '  ReadOnly  ' }), 'readonly');
  assert.equal(leaf.resolveExposeMode({ KHY_MCP_SERVE_EXPOSE: 'reads' }), 'all');
  assert.equal(leaf.resolveExposeMode({ KHY_MCP_SERVE_EXPOSE: '' }), 'all');
  assert.equal(leaf.resolveExposeMode({ KHY_MCP_SERVE_EXPOSE: null }), 'all');
  assert.equal(leaf.resolveExposeMode({}), 'all');
  assert.equal(leaf.resolveExposeMode(null), 'all'); // null 走 env||{} 兜底
  assert.equal(leaf.resolveExposeMode({ KHY_MCP_SERVE_EXPOSE: 42 }), 'all');
  // 缺省参数：不传 → 读 process.env（本机未设置该键 → all）
  assert.ok(['all', 'safe', 'readonly'].includes(leaf.resolveExposeMode()));
});

test('servePolicy: selectExposedTools —— all 直返，readonly 看行为函数，safe 看并集', () => {
  const ro = tool('ro', { readOnly: true });
  const lowWrite = tool('loww', { risk: 'low' });
  const medWrite = tool('medw', { risk: 'medium' });
  const destructiveHigh = tool('hi', { risk: 'high' });
  const list = [ro, lowWrite, medWrite, destructiveHigh, null];

  assert.equal(leaf.selectExposedTools(list, 'all').length, 4); // null 已剔除
  assert.deepStrictEqual(leaf.selectExposedTools(list, 'readonly').map((t) => t.name), ['ro']);
  assert.deepStrictEqual(leaf.selectExposedTools(list, 'safe').map((t) => t.name), ['ro', 'loww']);
  // 只读且 risk 缺失也进 safe（isReadOnly 优先短路）
  assert.equal(leaf.selectExposedTools([tool('x', { readOnly: true })], 'safe').length, 1);
  // 模式非法（undefined/'bogus'）→ 按 all
  assert.equal(leaf.selectExposedTools(list).length, 4);
  assert.equal(leaf.selectExposedTools(list, 'bogus').length, 4);
  // 脏列表
  assert.deepStrictEqual(leaf.selectExposedTools(null, 'safe'), []);
  assert.deepStrictEqual(leaf.selectExposedTools('str', 'safe'), []);
  assert.deepStrictEqual(leaf.selectExposedTools([], 'safe'), []);
});

test('servePolicy: isReadOnly 缺失或抛 → 一律 false（readonly 模式排除它们）', () => {
  const bare = { name: 'noBehaviorFn' };                 // 没有 isReadOnly 属性
  const boom = { name: 'boom', isReadOnly: () => { throw new Error('x'); } };
  assert.deepStrictEqual(leaf.selectExposedTools([bare, boom], 'readonly'), []);
  assert.deepStrictEqual(leaf.selectExposedTools([bare, boom], 'safe'), []); // risk 也缺 → medium
});

test('servePolicy: summarizeExposure —— byRisk 五桶，未知 risk 归 medium', () => {
  const input = [
    tool('a', { risk: 'safe' }), tool('b', { risk: 'low' }), tool('c', { risk: 'medium' }),
    tool('d', { risk: 'high' }), tool('e', { risk: 'critical' }), tool('f', { risk: 'weird' }),
    tool('g', { risk: 99 }), null,
  ];
  assert.ok(input.length >= 7); // 非空输入防呆
  const s = leaf.summarizeExposure(input);
  assert.equal(s.total, 7);
  assert.deepStrictEqual(s.byRisk, { safe: 1, low: 1, medium: 3, high: 1, critical: 1 }); // weird+99+g? g=99→medium，weird→medium，c→medium
  assert.equal(s.hasDestructive, true);   // high/critical 在场
});

test('servePolicy: hasDestructive 判定 —— ordinal≥3 或自报 true；自报抛不升级（实测钉住宽松方向）', () => {
  assert.equal(leaf.summarizeExposure([tool('m', { risk: 'medium' })]).hasDestructive, false);
  assert.equal(leaf.summarizeExposure([tool('s', { risk: 'safe', destructive: true })]).hasDestructive, true);
  const throwing = { name: 't', risk: 'low', isDestructive: () => { throw new Error('boom'); } };
  assert.equal(leaf.summarizeExposure([throwing]).hasDestructive, false); // 抛 → 不升级 — 偏差注册
  assert.deepStrictEqual(leaf.summarizeExposure(null), { total: 0, byRisk: { safe: 0, low: 0, medium: 0, high: 0, critical: 0 }, hasDestructive: false });
  assert.equal(leaf.summarizeExposure([]).total, 0);
});
