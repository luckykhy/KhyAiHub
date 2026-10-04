'use strict';

/**
 * serviceRegistryDescriptionsChinese.test.js — 服务注册表 description 中文化契约。
 *
 * 复现的真实缺陷: `khy services` 表头/分组标签是中文,但 30 条服务 description 原样是
 * 英文("Trading strategy execution engine" 等),违反 AGENTS.md「面向用户的字符串:中文」。
 * description 是纯展示字段(见 serviceRegistry.js 的 list() 契约 + register meta 注释
 * "Human-readable description"),无逻辑按它匹配,category(分组枚举键)刻意保持英文不动。
 *
 * 这里做的是**语义回归**而非逐字快照:断言每条非空 description 至少含一个汉字,
 * 这样将来新增服务忘中文化会被这条挡住,又不会因措辞微调而脆断。
 */

const assert = require('assert');
const nt = require('node:test');

const registry = require('../../src/services/serviceRegistry');

const CJK = /[一-鿿]/;

nt.test('list() 返回非空(防空转假绿)', () => {
  const items = registry.list();
  assert.ok(Array.isArray(items) && items.length >= 20, `期望 ≥20 条,实得 ${items && items.length}`);
  assert.ok(
    items.every((i) => typeof i.description === 'string'),
    '每条都应带 description 字段'
  );
});

nt.test('每条服务 description 至少含一个汉字(面向用户字符串应中文)', () => {
  const offenders = registry
    .list()
    .filter((i) => i.description && i.description.trim() !== '' && !CJK.test(i.description))
    .map((i) => `${i.name}: ${i.description}`);
  assert.deepStrictEqual(offenders, [], '以下 description 为纯英文,须中文化:\n' + offenders.join('\n'));
});

nt.test('抽查若干已知条目确为中文', () => {
  const byName = new Map(registry.list().map((i) => [i.name, i.description]));
  assert.equal(byName.get('strategyEngine'), '交易策略执行引擎');
  assert.equal(byName.get('backtestEngine'), '策略回测引擎');
  assert.equal(byName.get('tokenUsageService'), 'Token 用量统计');
});
