'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PHYSICAL_CODES,
  ELEVATION_MAP,
  mappingFor,
  isPhysicalCode
} = require('./physicalCodes.js');

test('PHYSICAL_CODES 四码自映射且被冻结', () => {
  assert.deepEqual(PHYSICAL_CODES, {
    ERR_SCHEMA_VIOLATION: 'ERR_SCHEMA_VIOLATION',
    ERR_TOOL_HALLUCINATION: 'ERR_TOOL_HALLUCINATION',
    ERR_BEHAVIOR_FORBIDDEN: 'ERR_BEHAVIOR_FORBIDDEN',
    ERR_RESOURCE_OVERFLOW: 'ERR_RESOURCE_OVERFLOW',
  });
  assert.equal(Object.isFrozen(PHYSICAL_CODES), true);
  assert.throws(() => {
    PHYSICAL_CODES.ERR_NEW = 'ERR_NEW';
  }, TypeError);
});

test('ELEVATION_MAP 恰好覆盖四个物理码，gateOrder 0-3 无重复', () => {
  assert.deepEqual(Object.keys(ELEVATION_MAP).sort(), [
    'ERR_BEHAVIOR_FORBIDDEN',
    'ERR_RESOURCE_OVERFLOW',
    'ERR_SCHEMA_VIOLATION',
    'ERR_TOOL_HALLUCINATION',
  ]);
  assert.deepEqual(
    Object.keys(ELEVATION_MAP).map((c) => ELEVATION_MAP[c].gateOrder).sort(),
    [0, 1, 2, 3]
  );
});

test('ERR_BEHAVIOR_FORBIDDEN 的升维映射（安全/越权先判，gateOrder 0）', () => {
  assert.deepEqual(mappingFor(PHYSICAL_CODES.ERR_BEHAVIOR_FORBIDDEN), {
    signal: 'interceptor-block',
    priority: 'High',
    intendedLevel: 'L1',
    why: '行为越权被守卫阻断——缺细粒度权限沙箱与行为前置审批，能力拓扑空洞。',
    proposedModules: ['细粒度权限沙箱', '行为前置审批网关'],
    action: '增加细粒度权限沙箱与行为前置审批网关',
    gateOrder: 0,
  });
});

test('ERR_TOOL_HALLUCINATION 的升维映射', () => {
  assert.deepEqual(mappingFor('ERR_TOOL_HALLUCINATION'), {
    signal: 'tool-failure',
    priority: 'High',
    intendedLevel: 'L1',
    why: '调用了不存在的工具——能力拓扑空洞，缺工具路由白名单校验与降级兜底工具。',
    proposedModules: ['工具路由白名单校验', '降级兜底工具'],
    action: '增加工具路由白名单校验与降级兜底工具',
    gateOrder: 1,
  });
});

test('ERR_RESOURCE_OVERFLOW 的升维映射', () => {
  assert.deepEqual(mappingFor('ERR_RESOURCE_OVERFLOW'), {
    signal: 'context-meltdown',
    priority: 'Medium',
    intendedLevel: 'L1',
    why: '资源越界/上下文溢出——预算阈值僵化，缺硬限与异步快照执行能力，能力拓扑空洞。',
    proposedModules: ['上下文预算硬限网关', '异步快照执行器'],
    action: '增加上下文预算硬限网关与异步快照执行器',
    gateOrder: 2,
  });
});

test('ERR_SCHEMA_VIOLATION 的升维映射', () => {
  assert.deepEqual(mappingFor('ERR_SCHEMA_VIOLATION'), {
    signal: 'tool-failure',
    priority: 'Medium',
    intendedLevel: 'L1',
    why: '输出违反结构化 Schema——缺格式校验与自动重试解析，能力拓扑空洞。',
    proposedModules: ['输出格式校验拦截器', '自动重试解析器'],
    action: '增加/强化输出格式校验拦截器与自动重试解析器',
    gateOrder: 3,
  });
});

test('why 避开 classify 的 L2 触发词，"网关"只出现在 action/proposedModules', () => {
  for (const code of Object.keys(ELEVATION_MAP)) {
    const m = mappingFor(code);
    assert.equal(m.intendedLevel, 'L1', `${code} 保底必须落 L1`);
    for (const word of ['压缩', '网关', '调度', '核心流转', '元约束']) {
      assert.equal(m.why.includes(word), false, `${code} why 含 L2 触发词 ${word}`);
    }
  }
  // the prescription wording is not lost, it is parked in the non-classified fields
  assert.equal(mappingFor('ERR_RESOURCE_OVERFLOW').proposedModules[0], '上下文预算硬限网关');
  assert.equal(mappingFor('ERR_BEHAVIOR_FORBIDDEN').action.includes('网关'), true);
});

test('mappingFor 返回的正是表内同一引用（identity）', () => {
  assert.equal(mappingFor('ERR_SCHEMA_VIOLATION'), ELEVATION_MAP.ERR_SCHEMA_VIOLATION);
  assert.equal(isPhysicalCode('ERR_SCHEMA_VIOLATION'), true);
});

test('原型键不会被当成物理码（hasOwnProperty 守卫）', () => {
  for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(isPhysicalCode(k), false, `expected ${k} rejected`);
    assert.equal(mappingFor(k), null, `expected ${k} -> null`);
  }
});

test('垃圾输入一律 false / null', () => {
  for (const junk of [null, undefined, '', 123, {}, [], true, 'ERR_UNKNOWN', 'err_schema_violation']) {
    assert.equal(isPhysicalCode(junk), false, `junk ${String(junk)}`);
    assert.equal(mappingFor(junk), null, `junk ${String(junk)}`);
  }
  assert.equal(isPhysicalCode(), false);
  assert.equal(mappingFor(), null);
});

test('KNOWN-DEFECT: ELEVATION_MAP 的 freeze 是浅冻结，mappingFor 交出的内层对象仍可写并污染共享真源', () => {
  assert.equal(Object.isFrozen(ELEVATION_MAP), true);
  const m = mappingFor('ERR_SCHEMA_VIOLATION');
  assert.equal(Object.isFrozen(m), false);
  const original = ELEVATION_MAP.ERR_SCHEMA_VIOLATION.gateOrder;
  try {
    m.gateOrder = 99;
    // the mutation is visible through the frozen table itself
    assert.equal(ELEVATION_MAP.ERR_SCHEMA_VIOLATION.gateOrder, 99);
    assert.equal(mappingFor('ERR_SCHEMA_VIOLATION').gateOrder, 99);
    assert.equal(Object.keys(ELEVATION_MAP).length, 4);
  } finally {
    m.gateOrder = original;
  }
  assert.equal(ELEVATION_MAP.ERR_SCHEMA_VIOLATION.gateOrder, 3);
});
