'use strict';

/**
 * Co-located tests for toolContract.js — the tool-contract auditor leaf.
 * Registry SSOT + CATEGORIES/RISK_LEVELS are all injected via deps, so the real
 * tool registry is never loaded and nothing executes a tool. Gates delegate flagRegistry.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const tcontract = require('./toolContract');
const { toolContractEnabled, paramAuditEnabled, auditTools, _toolKey, _auditShape, _auditParams, _auditCollisions } = tcontract;

function tool(over = {}) {
  return {
    name: 'read',
    category: 'filesystem',
    risk: 'low',
    description: 'read a file',
    toFunctionDef: () => ({
      name: 'read',
      description: 'read a file',
      parameters: { type: 'object', properties: { p: { type: 'string', description: 'path' } }, required: ['p'] },
    }),
    validate: () => true,
    execute: async () => 'ok',
    isReadOnly: () => true,
    isDestructive: () => false,
    isEnabled: () => true,
    ...over,
  };
}

const DEPS = {
  CATEGORIES: { filesystem: {}, execution: {} },
  RISK_LEVELS: ['low', 'medium', 'high'],
};

describe('门控（委托 flagRegistry）', () => {
  test('默认开，关闭词命中才关', () => {
    assert.strictEqual(toolContractEnabled({}), true);
    assert.strictEqual(paramAuditEnabled({}), true);
    for (const off of ['0', 'false', 'off', 'no', 'disable', 'disabled']) {
      assert.strictEqual(toolContractEnabled({ KHY_TOOL_CONTRACT: off }), false, off);
      assert.strictEqual(paramAuditEnabled({ KHY_TOOL_PARAM_AUDIT: off }), false, off);
    }
  });

  test('非关闭词 / 空 / 坏 env 一律开，且绝不抛', () => {
    assert.strictEqual(toolContractEnabled({ KHY_TOOL_CONTRACT: 'anything' }), true);
    assert.strictEqual(paramAuditEnabled({ KHY_TOOL_PARAM_AUDIT: '' }), true);
    assert.strictEqual(toolContractEnabled(null), true);
    assert.strictEqual(paramAuditEnabled(undefined), true);
  });
});

describe('_toolKey（与 toolCalling 复刻的归一键）', () => {
  test('小写 + 去非字母数字', () => {
    assert.strictEqual(_toolKey('My_Tool!'), 'mytool');
    assert.strictEqual(_toolKey('read file'), 'readfile');
    assert.strictEqual(_toolKey(''), '');
    assert.strictEqual(_toolKey(null), '');
    assert.strictEqual(_toolKey(0), '');
  });
});

describe('re-export 的子例程', () => {
  test('auditRules 三族在此原样透出（host 复用同一实现）', () => {
    const out = [];
    _auditShape('non-object', { categories: {}, risks: [] }, out);
    assert.strictEqual(out[0].tool, '(non-object)');
    assert.strictEqual(typeof _auditParams, 'function');
    assert.strictEqual(typeof _auditCollisions, 'function');
  });
});

describe('auditTools', () => {
  test('门控关 → 空 findings 契约形状', () => {
    assert.deepStrictEqual(
      auditTools({ getAll: () => [tool()], ...DEPS }, { KHY_TOOL_CONTRACT: 'off' }),
      { findings: [], errors: 0, warnings: 0, total: 0 },
    );
  });

  test('合规工具 → 零 finding，total 计数', () => {
    const res = auditTools({ getAll: () => [tool()], ...DEPS }, {});
    assert.deepStrictEqual(res.findings, []);
    assert.strictEqual(res.errors, 0);
    assert.strictEqual(res.total, 1);
  });

  test('形状违规汇聚为 error', () => {
    const res = auditTools({ getAll: () => [tool({ execute: 'not-fn', risk: 'extreme' })], ...DEPS }, {});
    assert.ok(res.errors >= 2);
    assert.ok(res.findings.some((f) => f.message.includes('execute 应为函数')));
    assert.ok(res.findings.some((f) => f.message.includes('risk')));
  });

  test('命名冲突（跨 category）记 error', () => {
    const res = auditTools({
      getAll: () => [
        tool({ name: 'dup', category: 'filesystem', risk: 'low' }),
        tool({ name: 'Dup', category: 'execution', risk: 'low' }),
      ],
      ...DEPS,
    }, {});
    assert.ok(res.findings.some((f) => f.rule === 'collision' && f.severity === 'error'));
  });

  test('Map 输入与数组输入等价消费', () => {
    const m = new Map([['read', tool()]]);
    assert.strictEqual(auditTools({ getAll: () => m, ...DEPS }, {}).total, 1);
  });

  test('getAll 抛异常 / 返非可迭代 → 空目录，不抛', () => {
    assert.deepStrictEqual(auditTools({ getAll: () => { throw new Error('x'); }, ...DEPS }, {}), { findings: [], errors: 0, warnings: 0, total: 0 });
    assert.strictEqual(auditTools({ getAll: () => 7, ...DEPS }, {}).total, 0);
  });

  test('子门控 KHY_TOOL_PARAM_AUDIT 独立于总门控：关时只出形状/冲突，不出参数 finding', () => {
    // 一个形状合规、但 required 悬垂（'ghost' 不在 properties）的工具。
    const dangling = tool({
      toFunctionDef: () => ({
        name: 'read',
        description: 'read a file',
        parameters: { type: 'object', properties: { p: { type: 'string', description: 'x' } }, required: ['ghost'] },
      }),
    });
    const on = auditTools({ getAll: () => [dangling], ...DEPS }, {});
    assert.ok(on.findings.some((f) => f.rule === 'param' && f.message.includes('ghost')));
    const off = auditTools({ getAll: () => [dangling], ...DEPS }, { KHY_TOOL_PARAM_AUDIT: 'off' });
    assert.strictEqual(off.findings.filter((f) => f.rule === 'param').length, 0);
  });

  test('deps 未给 CATEGORIES/RISK_LEVELS 时走 SSOT 回退，仍不抛（fail-soft）', () => {
    // 不提供 CATEGORIES/RISK_LEVELS，本叶子会惰性 require SSOT 常量；getAll 仍注入。
    const res = auditTools({ getAll: () => [tool()] }, {});
    assert.strictEqual(res.total, 1);
    assert.ok(Array.isArray(res.findings));
  });
});
