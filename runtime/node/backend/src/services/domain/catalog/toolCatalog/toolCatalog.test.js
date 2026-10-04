'use strict';

/**
 * Co-located tests for toolCatalog.js — the grouped /toollist directory leaf.
 * Zero IO: everything runs through deps.getAll + env injection; no tool registry loaded.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const tc = require('./toolCatalog');
const { toolCatalogEnabled, buildToolCatalog, CATEGORY_META, _summarize, _normalizeTool } = tc;

const ENV_ON = {};
const ENV_OFF = { KHY_TOOL_CATALOG: 'off' };

function mapOf(tools) {
  const m = new Map();
  for (const t of tools) m.set(t.name, t);
  return m;
}

describe('toolCatalogEnabled', () => {
  test('默认开，仅关闭词命中才关', () => {
    assert.strictEqual(toolCatalogEnabled({}), true);
    for (const off of ['0', 'false', 'off', 'no', 'disable', 'disabled']) {
      assert.strictEqual(toolCatalogEnabled({ KHY_TOOL_CATALOG: off }), false, off);
      assert.strictEqual(toolCatalogEnabled({ KHY_TOOL_CATALOG: `  ${off.toUpperCase()}  ` }), false, off);
    }
    assert.strictEqual(toolCatalogEnabled({ KHY_TOOL_CATALOG: 'anything' }), true);
  });

  test('缺失/空/非字符串读作未设置 → 开，且坏 env 不抛', () => {
    for (const v of [undefined, '', '   ', null, false, 0]) {
      assert.strictEqual(toolCatalogEnabled({ KHY_TOOL_CATALOG: v }), true, String(v));
    }
    assert.strictEqual(toolCatalogEnabled(null), true);
    assert.strictEqual(toolCatalogEnabled(undefined), true);
  });
});

describe('_summarize', () => {
  test('取首个非空行', () => {
    assert.strictEqual(_summarize('\n  \n第二行内容\n第四行'), '第二行内容');
  });

  test('非串一律空串', () => {
    for (const v of [null, undefined, 0, {}, []]) {
      assert.strictEqual(_summarize(v), '', String(v));
    }
  });

  test('超 120 字截断到 117 + 省略号', () => {
    const long = 'x'.repeat(200);
    const out = _summarize(long);
    assert.strictEqual(out.length, 118); // 117 + '…'
    assert.strictEqual(out.endsWith('…'), true);
    assert.strictEqual(_summarize('x'.repeat(120)).length, 120); // 边界：120 不截
  });
});

describe('_normalizeTool', () => {
  test('合规工具规整到最小确定性字段', () => {
    const t = _normalizeTool({ name: 'Read', category: 'filesystem', description: '  read it  ', risk: 'low', aliases: ['view', '', 5] });
    assert.strictEqual(t.name, 'Read');
    assert.strictEqual(t.category, 'filesystem');
    assert.strictEqual(t.desc, 'read it');
    assert.strictEqual(t.risk, 'low');
    assert.deepStrictEqual(t.aliases, ['view']); // 非字符串/空被过滤
    assert.strictEqual(t.readOnly, false);
  });

  test('category/risk 缺省回落 custom/medium', () => {
    const t = _normalizeTool({ name: 'x' });
    assert.strictEqual(t.category, 'custom');
    assert.strictEqual(t.risk, 'medium');
  });

  test('非对象 / 无 name → null（跳过）', () => {
    for (const bad of [null, undefined, 'str', 42, {}, { name: '   ' }]) {
      assert.strictEqual(_normalizeTool(bad), null, JSON.stringify(bad));
    }
  });

  test('readOnly 判定：isReadOnly 是函数才调用，缺失或抛错 → false', () => {
    assert.strictEqual(_normalizeTool({ name: 'r', isReadOnly: () => true }).readOnly, true);
    assert.strictEqual(_normalizeTool({ name: 'r', isReadOnly: 'not-fn' }).readOnly, false);
    assert.strictEqual(_normalizeTool({ name: 'r', isReadOnly: () => { throw new Error('x'); } }).readOnly, false);
  });
});

describe('buildToolCatalog', () => {
  test('门控关 → 空目录，逐字节契约形状', () => {
    assert.deepStrictEqual(buildToolCatalog({ getAll: () => [] }, ENV_OFF), {
      categories: [], total: 0, generatedBy: 'toolRegistry',
    });
  });

  test('getAll 返 Map / 数组都能消费', () => {
    const tools = [{ name: 'a', category: 'filesystem' }];
    assert.strictEqual(buildToolCatalog({ getAll: () => mapOf(tools) }, ENV_ON).total, 1);
    assert.strictEqual(buildToolCatalog({ getAll: () => tools }, ENV_ON).total, 1);
  });

  test('getAll 返非可迭代/抛异常 → 空目录，不抛', () => {
    assert.strictEqual(buildToolCatalog({ getAll: () => 42 }, ENV_ON).total, 0);
    assert.strictEqual(buildToolCatalog({ getAll: () => { throw new Error('boom'); } }, ENV_ON).total, 0);
  });

  test('类别按 CATEGORY_META.order 再按 key 排序，组内按 name 字母序', () => {
    const out = buildToolCatalog({
      getAll: () => [
        { name: 'zeta', category: 'execution' },
        { name: 'alpha', category: 'filesystem' },
        { name: 'beta', category: 'filesystem' },
      ],
    }, ENV_ON);
    assert.deepStrictEqual(out.categories.map((c) => c.key), ['filesystem', 'execution']);
    assert.deepStrictEqual(out.categories[0].tools.map((t) => t.name), ['alpha', 'beta']);
    assert.strictEqual(out.total, 3);
    assert.strictEqual(out.generatedBy, 'toolRegistry');
  });

  test('未知类别归 other（order 99），排在末', () => {
    const out = buildToolCatalog({
      getAll: () => [{ name: 'a', category: 'zzz-unknown' }, { name: 'b', category: 'filesystem' }],
    }, ENV_ON);
    assert.strictEqual(out.categories[out.categories.length - 1].key, 'zzz-unknown');
    assert.strictEqual(out.categories[out.categories.length - 1].label, CATEGORY_META.other.label);
  });

  test('同 category 内同名去重，保留首个', () => {
    const out = buildToolCatalog({
      getAll: () => [
        { name: 'dup', category: 'git', desc: '', description: 'first' },
        { name: 'dup', category: 'git', description: 'second' },
      ],
    }, ENV_ON);
    assert.strictEqual(out.total, 1);
    assert.strictEqual(out.categories[0].tools[0].desc, 'first');
  });

  test('垃圾条目（无 name / 非对象）被跳过而非崩', () => {
    const out = buildToolCatalog({
      getAll: () => [null, 'x', 42, {}, { name: '' }, { name: 'ok', category: 'system' }],
    }, ENV_ON);
    assert.strictEqual(out.total, 1);
    assert.strictEqual(out.categories[0].tools[0].name, 'ok');
  });

  test('KNOWN-DEFECT: category="constructor" 命中原型链，label/order 变 undefined（/toollist 显示崩坏）', () => {
    // toolCatalog.js:63 `_categoryMeta = CATEGORY_META[cat] || CATEGORY_META.other` 未防原型键。
    // cat='constructor' → CATEGORY_META['constructor'] 取到 Object.prototype.constructor（truthy），
    // 于是 meta.label/meta.order 均为 undefined，既破坏展示也污染 order 排序。
    // （姊妹文件 commandCatalog 已修此问题 B26-F1，本叶子未修。）
    const out = buildToolCatalog({ getAll: () => [{ name: 'x', category: 'constructor' }] }, ENV_ON);
    assert.strictEqual(out.categories.length, 1);
    assert.strictEqual(out.categories[0].key, 'constructor');
    assert.strictEqual(out.categories[0].label, undefined);
    assert.strictEqual(out.categories[0].order, undefined);
  });
});
