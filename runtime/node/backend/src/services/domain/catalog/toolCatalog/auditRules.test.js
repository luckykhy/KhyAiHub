'use strict';

/**
 * Co-located tests for auditRules.js — the per-tool contract audit rule family.
 * Pure/deterministic: fed hand-built tool fixtures + an explicit ctx, no registry load.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { _auditShape, _auditCollisions, _auditParams } = require('./auditRules');

const CTX = { categories: { filesystem: {}, execution: {} }, risks: ['low', 'medium', 'high'] };

function validDef() {
  return {
    name: 'read',
    description: 'Read a file',
    parameters: { type: 'object', properties: { p: { type: 'string', description: 'path' } }, required: ['p'] },
  };
}

function goodTool(over = {}) {
  return {
    name: 'read',
    description: 'Read a file',
    category: 'filesystem',
    risk: 'low',
    toFunctionDef: () => validDef(),
    validate: () => true,
    execute: async () => 'ok',
    isReadOnly: () => true,
    isDestructive: () => false,
    isEnabled: () => true,
    ...over,
  };
}

describe('_auditShape', () => {
  test('合规工具 → 零 finding', () => {
    const out = [];
    _auditShape(goodTool(), CTX, out);
    assert.deepStrictEqual(out, []);
  });

  test('非对象条目记一条 (non-object) error', () => {
    // 注意：[] 的 typeof === 'object'，会走正常形状校验而非 (non-object) 分支，故不列入。
    for (const bad of [null, undefined, 'str', 42]) {
      const out = [];
      _auditShape(bad, CTX, out);
      assert.strictEqual(out.length, 1);
      assert.strictEqual(out[0].rule, 'shape');
      assert.strictEqual(out[0].tool, '(non-object)');
    }
  });

  test('缺失 name / description 各记 error，标签回落 (unnamed)', () => {
    const out = [];
    _auditShape(goodTool({ name: '', description: '' }), CTX, out);
    const msgs = out.filter((f) => f.rule === 'shape').map((f) => f.message);
    assert.ok(msgs.some((m) => m.includes('name')));
    assert.ok(msgs.some((m) => m.includes('description')));
    assert.strictEqual(out[0].tool, '(unnamed)');
  });

  test('category 不在 CATEGORIES 内记 error', () => {
    const out = [];
    _auditShape(goodTool({ category: 'nope' }), CTX, out);
    assert.ok(out.some((f) => f.message.includes("category 'nope'")));
  });

  test('risk 不在 RISK_LEVELS 内记 error', () => {
    const out = [];
    _auditShape(goodTool({ risk: 'critical' }), CTX, out);
    assert.ok(out.some((f) => f.message.includes("risk 'critical'")));
  });

  test('fail-soft：ctx.categories 为空对象时跳过 category 校验（不误报）', () => {
    const out = [];
    _auditShape(goodTool({ category: 'anything' }), { categories: {}, risks: ['low'] }, out);
    assert.strictEqual(out.some((f) => f.message.includes('category')), false);
  });

  test('fail-soft：ctx.risks 为空数组时跳过 risk 校验', () => {
    const out = [];
    _auditShape(goodTool({ risk: 'zzz' }), { categories: { filesystem: {} }, risks: [] }, out);
    assert.strictEqual(out.some((f) => f.message.includes('risk')), false);
  });

  test('七个行为字段缺一即记对应 error', () => {
    const out = [];
    _auditShape(goodTool({ execute: 'not-fn' }), CTX, out);
    assert.ok(out.some((f) => f.message === 'execute 应为函数'));
  });

  test('toFunctionDef 抛异常 → 记 schema error 并提前返回', () => {
    const out = [];
    _auditShape(goodTool({ toFunctionDef: () => { throw new Error('boom'); } }), CTX, out);
    const schema = out.filter((f) => f.rule === 'schema');
    assert.strictEqual(schema.length, 1);
    assert.ok(schema[0].message.includes('抛异常'));
  });

  test('toFunctionDef 返回非对象 / 缺 name / description 非串 → schema error', () => {
    const cases = [
      () => null,
      () => 'string',
      () => ({ description: 'd', parameters: validDef().parameters }),
      () => ({ name: 'read', description: 42, parameters: validDef().parameters }),
    ];
    for (const fn of cases) {
      const out = [];
      _auditShape(goodTool({ toFunctionDef: fn }), CTX, out);
      assert.ok(out.some((f) => f.rule === 'schema'), JSON.stringify(fn()));
    }
  });

  test('parameters 结构非法 → schema error', () => {
    const out = [];
    _auditShape(goodTool({ toFunctionDef: () => ({ name: 'r', description: 'd', parameters: { type: 'array' } }) }), CTX, out);
    assert.ok(out.some((f) => f.rule === 'schema' && f.message.includes('parameters')));
  });

  test('required 存在但非数组 → schema error；required 缺省（undefined）合法', () => {
    const bad = [];
    _auditShape(goodTool({ toFunctionDef: () => ({ name: 'r', description: 'd', parameters: { type: 'object', properties: {}, required: 'p' } }) }), CTX, bad);
    assert.ok(bad.some((f) => f.message.includes('required 存在但非数组')));
    const good = [];
    _auditShape(goodTool({ toFunctionDef: () => ({ name: 'r', description: 'd', parameters: { type: 'object', properties: {} } }) }), CTX, good);
    assert.strictEqual(good.length, 0);
  });
});

describe('_auditParams', () => {
  const defOf = (parameters) => goodTool({ toFunctionDef: () => ({ name: 'r', description: 'd', parameters }) });

  test('合规参数 → 零 param finding', () => {
    const out = [];
    _auditParams(defOf({ type: 'object', properties: { p: { type: 'string', description: 'x' } }, required: ['p'] }), out);
    assert.strictEqual(out.filter((f) => f.rule === 'param').length, 0);
  });

  test('悬垂 required（名不在 properties）→ error', () => {
    const out = [];
    _auditParams(defOf({ type: 'object', properties: { p: { type: 'string', description: 'x' } }, required: ['ghost'] }), out);
    assert.ok(out.some((f) => f.severity === 'error' && f.message.includes('ghost')));
  });

  test('参数缺 description / 缺 type → warning', () => {
    const out = [];
    _auditParams(defOf({ type: 'object', properties: { p: {} } }), out);
    assert.ok(out.some((f) => f.severity === 'warning' && f.message.includes('缺 description')));
    assert.ok(out.some((f) => f.severity === 'warning' && f.message.includes('缺 type')));
  });

  test('$ref / enum / oneOf 任一即算有类型，不误报缺 type', () => {
    const out = [];
    _auditParams(defOf({ type: 'object', properties: { p: { enum: ['a'], description: 'x' }, q: { $ref: '#/x', description: 'y' } } }), out);
    assert.strictEqual(out.filter((f) => f.message.includes('缺 type')).length, 0);
  });

  test('required 却带 default → 死默认值 warning', () => {
    const out = [];
    _auditParams(defOf({ type: 'object', properties: { p: { type: 'string', description: 'x', default: 'z' } }, required: ['p'] }), out);
    assert.ok(out.some((f) => f.message.includes('default 永不生效')));
  });

  test('array 却无 items → 元素类型不明 warning', () => {
    const out = [];
    _auditParams(defOf({ type: 'object', properties: { p: { type: 'array', description: 'x' } } }), out);
    assert.ok(out.some((f) => f.message.includes('array 却无 items')));
  });

  test('无 toFunctionDef / 抛异常 / parameters 非法 → 静默返回（不误报）', () => {
    for (const tool of [null, {}, goodTool({ toFunctionDef: undefined }), goodTool({ toFunctionDef: () => { throw new Error('x'); } }), goodTool({ toFunctionDef: () => ({}) })]) {
      const out = [];
      _auditParams(tool, out);
      assert.deepStrictEqual(out, []);
    }
  });
});

describe('_auditCollisions', () => {
  test('唯一属主 → 无冲突', () => {
    const out = [];
    _auditCollisions([goodTool({ name: 'alpha' }), goodTool({ name: 'beta' })], out);
    assert.strictEqual(out.filter((f) => f.rule === 'collision').length, 0);
  });

  test('归一键相同（大小写/标点无关）同 category 同 risk → warning（同类孪生）', () => {
    const out = [];
    _auditCollisions([
      goodTool({ name: 'my tool', category: 'filesystem', risk: 'low' }),
      goodTool({ name: 'my-tool', category: 'filesystem', risk: 'low' }),
    ], out);
    const c = out.filter((f) => f.rule === 'collision');
    assert.strictEqual(c.length, 1);
    assert.strictEqual(c[0].severity, 'warning');
    assert.ok(c[0].message.includes('同类孪生'));
  });

  test('跨 risk 或跨 category → error', () => {
    const out = [];
    _auditCollisions([
      goodTool({ name: 'dup', category: 'filesystem', risk: 'low' }),
      goodTool({ name: 'Dup', category: 'execution', risk: 'high' }),
    ], out);
    const c = out.filter((f) => f.rule === 'collision');
    assert.strictEqual(c.length, 1);
    assert.strictEqual(c[0].severity, 'error');
    // 两个属主名 'dup' 与 'Dup' 归一到同键 'dup'，且跨 risk + 跨 category。
    assert.ok(c[0].message.includes('跨 risk'));
    assert.ok(c[0].message.includes('跨 category'));
  });

  test('别名参与归一键占用检测', () => {
    const out = [];
    _auditCollisions([
      goodTool({ name: 'read', aliases: [] }),
      goodTool({ name: 'viewer', aliases: ['Read'] }), // 别名 'Read' 归一为 read → 与 name read 撞
    ], out);
    assert.ok(out.some((f) => f.rule === 'collision' && f.tool.includes('read') && f.tool.includes('viewer')));
  });

  test('同一工具 name 与其别名归一相同 → 只记一个属主，不算冲突', () => {
    const out = [];
    _auditCollisions([goodTool({ name: 'read', aliases: ['read'] })], out);
    assert.strictEqual(out.filter((f) => f.rule === 'collision').length, 0);
  });

  test('垃圾条目（非对象 / 无 name）被跳过', () => {
    const out = [];
    _auditCollisions([null, 'str', { description: 'no name' }, 42], out);
    assert.strictEqual(out.length, 0);
  });

  test('KNOWN-DEFECT: _auditCollisions 对非可迭代 tools 抛 TypeError，违背模块头「never-throws」契约', () => {
    // auditRules.js:2「pure, deterministic, never-throws」，但 146-148 `for (const tool of tools)`
    // 未做可迭代性防护。toolContract.auditTools 里用 try/catch 兜住，host 若直接复用本导出则会崩。
    assert.throws(() => _auditCollisions(null, []), TypeError);
    assert.throws(() => _auditCollisions(undefined, []), TypeError);
    assert.throws(() => _auditCollisions(42, []), TypeError);
  });
});
