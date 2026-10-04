'use strict';

/**
 * resourceContract.js contract tests — the single shape gate every manage
 * resource must pass before managementRegistry will hold it.
 *
 * Pure module: no IO, no env, nothing to stub. validateContract never throws,
 * so every case below asserts the exact { ok, errors } verdict, including the
 * error strings (managementRegistry joins them verbatim into the thrown
 * INVALID_CONTRACT message, so they are part of the contract).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { SOURCE_KINDS, validateContract } = require('./resourceContract');

const VALID_ID_ERR = 'id 必须是非空小写 kebab-case 字符串(CLI 子命令 + Web 路由段共用)';
const LABEL_ERR = 'label 必须是非空字符串';
const SOURCE_ERR = `source 必须是 ${SOURCE_KINDS.join('|')} 之一`;
const DETAIL_ERR = 'sourceDetail 必须是非空字符串(真源唯一定位,杜绝双根)';
const CAPS_ERR = 'capabilities 必须是非空数组';
const OPS_ERR = 'ops 必须是对象(操作实现,唯一漏斗)';
const SCHEMA_ERR = 'schema 若提供必须是对象(资源项结构,供 CLI/Web 共用渲染契约)';

const fn = () => {};

// A shipped-shaped contract; callers override only the field under test.
const base = (over = {}) => ({
  id: 'api-keys',
  label: 'API 密钥池',
  source: 'file',
  sourceDetail: 'dataHome/api_keys.json',
  capabilities: ['list', 'add'],
  ops: { list: fn, add: fn },
  ...over,
});

describe('resourceContract.validateContract', () => {
  it('SOURCE_KINDS 固定为 db/file/env/process 四种真源类型', () => {
    assert.deepEqual(SOURCE_KINDS, ['db', 'file', 'env', 'process']);
  });

  it('合法契约返回 ok:true 且 errors 为空数组', () => {
    const r = validateContract(base());
    assert.deepEqual(r, { ok: true, errors: [] });
    assert.deepEqual(Object.keys(r), ['ok', 'errors'], 'verdict shape is exactly {ok,errors}');
  });

  it('四种 source 全部接受，第五种拒绝', () => {
    for (const source of ['db', 'file', 'env', 'process']) {
      assert.equal(validateContract(base({ source })).ok, true, `source=${source}`);
    }
    const r = validateContract(base({ source: 'memory' }));
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors, [SOURCE_ERR]);
  });

  it('空契约与垃圾入参：null/undefined/字符串/数字/数组都收敛为同一组必填错误', () => {
    const expected = [VALID_ID_ERR, LABEL_ERR, SOURCE_ERR, DETAIL_ERR, CAPS_ERR, OPS_ERR];
    for (const junk of [null, undefined, 0, '', false, [], 'nope', 42]) {
      const r = validateContract(junk);
      assert.equal(r.ok, false, `junk=${JSON.stringify(junk)}`);
      assert.deepEqual(r.errors, expected, `junk=${JSON.stringify(junk)}`);
    }
  });

  it('id 只放行首字符为小写字母/数字、其后为 kebab 的 ASCII 形态', () => {
    for (const good of ['a', '1', 'cron', 'api-keys', 'model-config', 'a1-b2', '123', 'a-', 'a--']) {
      assert.equal(validateContract(base({ id: good })).ok, true, `id=${good} must pass`);
    }
    for (const bad of ['', '-a', 'A', 'Api-Keys', 'a_b', 'a-_b', ' a', 'a ', '编号', 'a.b', 'a/b']) {
      assert.equal(validateContract(base({ id: bad })).ok, false, `id=${JSON.stringify(bad)} must fail`);
    }
  });

  it('id 非字符串的真值（数字/数组/对象）与假值一样被拒绝', () => {
    for (const bad of [123, ['api-keys'], { id: 'api-keys' }, true, 0, null, undefined, false]) {
      const r = validateContract(base({ id: bad }));
      assert.equal(r.ok, false, `id=${JSON.stringify(bad)}`);
      assert.deepEqual(r.errors, [VALID_ID_ERR], 'only the id line is reported');
    }
  });

  it('label 接受任意非空字符串（含空白），sourceDetail 同规则', () => {
    assert.equal(validateContract(base({ label: ' ' })).ok, true);
    assert.equal(validateContract(base({ label: 'x' })).ok, true);
    for (const bad of ['', 0, false, null, undefined, {}, 7]) {
      assert.deepEqual(validateContract(base({ label: bad })).errors, [LABEL_ERR]);
    }
    for (const bad of ['', '   ', {}, 7]) {
      // Note: sourceDetail only checks truthiness + typeof, so whitespace passes.
      assert.equal(validateContract(base({ sourceDetail: bad })).ok, bad === '   ');
    }
  });

  it('capabilities 必须是非空数组，字符串/对象形态被拒', () => {
    for (const bad of ['list', {}, 0, null, undefined, true, new Set(['list'])]) {
      const r = validateContract(base({ capabilities: bad }));
      assert.equal(r.ok, false, `capabilities=${String(bad)}`);
      assert.deepEqual(r.errors, [CAPS_ERR]);
    }
    // An empty array still fails `length === 0`, but it IS an array, so the
    // cross-check runs against the untouched ops map and reports every op as
    // undeclared on top of the capability error.
    assert.deepEqual(validateContract(base({ capabilities: [] })).errors, [
      CAPS_ERR,
      'ops.list 未在 capabilities 中声明(能力与实现必须对齐)',
      'ops.add 未在 capabilities 中声明(能力与实现必须对齐)',
    ]);
    // Same field emptied on both sides collapses back to the single line.
    assert.deepEqual(validateContract(base({ capabilities: [], ops: {} })).errors, [CAPS_ERR]);
  });

  it('能力与实现双向对齐：缺实现与未声明都逐条报出', () => {
    const r = validateContract(base({ capabilities: ['list', 'add', 'remove'], ops: { list: fn, drop: fn } }));
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors, [
      'capability "add" 缺少对应的 ops.add 实现',
      'capability "remove" 缺少对应的 ops.remove 实现',
      'ops.drop 未在 capabilities 中声明(能力与实现必须对齐)',
    ], 'missing impls are listed in capability order, then undeclared ops');
  });

  it('ops 里非函数的同名实现按缺实现处理', () => {
    for (const bad of [undefined, null, 'fn', 0, {}, []]) {
      const r = validateContract(base({ capabilities: ['list'], ops: { list: bad } }));
      assert.equal(r.ok, false, `ops.list=${String(bad)}`);
      assert.deepEqual(r.errors, ['capability "list" 缺少对应的 ops.list 实现']);
    }
  });

  it('schema 可选；提供时必须是对象', () => {
    assert.equal(validateContract(base({ schema: undefined })).ok, true);
    assert.equal(validateContract(base({ schema: null })).ok, true, 'null is treated as absent');
    assert.equal(validateContract(base({ schema: {} })).ok, true);
    for (const bad of ['x', 1, true, fn]) {
      const r = validateContract(base({ schema: bad }));
      assert.equal(r.ok, false, `schema=${String(bad)}`);
      assert.deepEqual(r.errors, [SCHEMA_ERR]);
    }
  });

  it('KNOWN-DEFECT: ops 传数组躲过「必须是对象」这一行，只留下逐能力缺实现的报错', () => {
    // Measured: validateContract({...capabilities:['list'], ops: []}) →
    // errors = ['capability "list" 缺少对应的 ops.list 实现'] and NOT OPS_ERR,
    // because the gate is `typeof c.ops !== 'object'` and typeof [] === 'object'.
    const r = validateContract(base({ capabilities: ['list'], ops: [] }));
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors, ['capability "list" 缺少对应的 ops.list 实现']);
    assert.equal(r.errors.includes(OPS_ERR), false, 'the "ops 必须是对象" line never fires for arrays');
    // An array ops with an empty capability list reports only the capability line.
    assert.deepEqual(validateContract(base({ capabilities: [], ops: [] })).errors, [CAPS_ERR]);
  });

  it('KNOWN-DEFECT: schema 传数组同样被当成合法对象（与 ops 数组同源）', () => {
    // Measured: validateContract(base({ schema: ['a'] })) → { ok: true, errors: [] }.
    assert.deepEqual(validateContract(base({ schema: [] })), { ok: true, errors: [] });
    assert.deepEqual(validateContract(base({ schema: [{ list: 1 }] })), { ok: true, errors: [] });
  });

  it('KNOWN-DEFECT: capabilities 非数组时整段能力/实现对齐校验被静默跳过', () => {
    // Measured: capabilities:'list' (string) + ops:{} → only [CAPS_ERR]; the
    // `else if (Array.isArray(c.capabilities))` branch never runs, so a typo'd
    // capabilities field reports nothing about the missing ops implementations.
    const r = validateContract(base({ capabilities: 'list', ops: {} }));
    assert.deepEqual(r.errors, [CAPS_ERR]);
    assert.equal(r.errors.some((e) => /ops\./.test(e)), false);
    // Same hole with a set-like object: undeclared ops go unreported too.
    const r2 = validateContract(base({ capabilities: { 0: 'list' }, ops: { drop: fn } }));
    assert.deepEqual(r2.errors, [CAPS_ERR]);
  });

  it('KNOWN-DEFECT: capabilities 重复项不判非法，空白/数字型能力名直接映射成缺实现报错', () => {
    // Measured: duplicated capability passes (each entry has an impl).
    assert.deepEqual(validateContract(base({ capabilities: ['list', 'list'], ops: { list: fn } })), {
      ok: true,
      errors: [],
    });
    // Measured: an undeclared op key is reported by name, including odd keys.
    const r = validateContract(base({ capabilities: ['list'], ops: { list: fn, extra: fn } }));
    assert.deepEqual(r.errors, ['ops.extra 未在 capabilities 中声明(能力与实现必须对齐)']);
    // Measured: capability names are not validated at all — a whitespace
    // capability with a matching whitespace op key is a fully legal contract.
    assert.deepEqual(validateContract(base({ capabilities: [' '], ops: { ' ': fn } })), {
      ok: true,
      errors: [],
    });
    assert.deepEqual(validateContract(base({ capabilities: ['1', '0'], ops: { 1: fn, 0: fn } })), {
      ok: true,
      errors: [],
    });
    // Measured: a numeric entry in capabilities passes the impl lookup (JS key
    // coercion) but then fails the reverse `includes` check — same pair reported
    // as undeclared.
    assert.deepEqual(validateContract(base({ capabilities: [1], ops: { 1: fn } })).errors, [
      'ops.1 未在 capabilities 中声明(能力与实现必须对齐)',
    ]);
  });
});
