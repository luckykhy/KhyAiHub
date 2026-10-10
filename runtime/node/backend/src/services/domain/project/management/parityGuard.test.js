'use strict';

/**
 * parityGuard.js contract tests — the three invariants (source uniqueness,
 * CLI sub-command parity, op reachability) as measured through checkParity().
 *
 * checkParity(deps) takes its registry and command schema by injection, so no
 * require.cache surgery is needed here. The default `require('./index')` branch
 * is deliberately never exercised: it drags in the whole backend boot (~18s)
 * and opens the real dataHome, which a unit test must not touch. The default
 * `require('../../../../constants/commandSchema')` branch is cheap and pure, so
 * one case below does use it to pin the shipped `manage` sub-command list.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { checkParity } = require('./parityGuard');

const cmd = (over = {}) => ({
  capabilities: ['list'],
  ops: { list: () => {} },
  ...over,
});

// describe()/get() pair mirroring managementRegistry's read surface.
function registryOf(...contracts) {
  const byId = new Map(contracts.map((c) => [c.id, c]));
  return {
    describe: () =>
      contracts.map((c) => ({
        id: c.id,
        source: c.source,
        sourceDetail: c.sourceDetail,
        capabilities: c.capabilities,
      })),
    get: (id) => byId.get(id) || null,
  };
}

function schemaOf(manage) {
  return { getRouterSubCommands: () => ({ manage }) };
}

describe('parityGuard.checkParity', () => {
  it('全对齐时返回 { ok: true, errors: [] }', () => {
    const r = checkParity({
      registry: registryOf(
        { id: 'cron', source: 'file', sourceDetail: 'dataHome/growth/cron_jobs.json', ...cmd() },
        { id: 'users', source: 'db', sourceDetail: 'db:users', ...cmd({ capabilities: ['list', 'add'], ops: { list: () => {}, add: () => {} } }) }
      ),
      commandSchema: schemaOf(['list', 'cron', 'users']),
    });
    assert.deepEqual(r, { ok: true, errors: [] });
    assert.deepEqual(Object.keys(r), ['ok', 'errors']);
  });

  it('空注册表 + 只有 list 的子命令表是合法状态', () => {
    assert.deepEqual(checkParity({ registry: registryOf(), commandSchema: schemaOf(['list']) }), {
      ok: true,
      errors: [],
    });
  });

  it('两个资源绑同一 source:sourceDetail 时报 SOURCE_CONFLICT，且按「后来者 与 先来者」排序', () => {
    const r = checkParity({
      registry: registryOf(
        { id: 'aaa', source: 'file', sourceDetail: 'x', ...cmd() },
        { id: 'bbb', source: 'file', sourceDetail: 'x', ...cmd() }
      ),
      commandSchema: schemaOf(['list', 'aaa', 'bbb']),
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors, ["SOURCE_CONFLICT: 'bbb' and 'aaa' both bind source file:x"]);
  });

  it('三个资源争同一真源时每个后来者各报一条，都指向首个占坑者', () => {
    const r = checkParity({
      registry: registryOf(
        { id: 'a1', source: 'db', sourceDetail: 'same', ...cmd() },
        { id: 'a2', source: 'db', sourceDetail: 'same', ...cmd() },
        { id: 'a3', source: 'db', sourceDetail: 'same', ...cmd() }
      ),
      commandSchema: schemaOf(['list', 'a1', 'a2', 'a3']),
    });
    assert.deepEqual(r.errors, [
      "SOURCE_CONFLICT: 'a2' and 'a1' both bind source db:same",
      "SOURCE_CONFLICT: 'a3' and 'a1' both bind source db:same",
    ]);
  });

  it('真源 key 由 source 与 sourceDetail 拼成：不同 source 复用同一 detail 不算冲突', () => {
    const r = checkParity({
      registry: registryOf(
        { id: 'a', source: 'db', sourceDetail: 'same', ...cmd() },
        { id: 'b', source: 'file', sourceDetail: 'same', ...cmd() }
      ),
      commandSchema: schemaOf(['list', 'a', 'b']),
    });
    assert.deepEqual(r.errors, []);
  });

  it('manage 子命令与注册表 id 不一致时报 CLI_PARITY，两侧列表按字典序原样印出', () => {
    const r = checkParity({
      registry: registryOf({ id: 'alpha', source: 'db', sourceDetail: 'd', ...cmd() }),
      commandSchema: schemaOf(['list', 'alpha', 'beta']),
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors, ['CLI_PARITY: manage sub-commands [alpha, beta] != registry resources [alpha]']);
  });

  it('子命令比对两侧都排序，顺序差异不算不一致', () => {
    const r = checkParity({
      registry: registryOf(
        { id: 'zzz', source: 'db', sourceDetail: '1', ...cmd() },
        { id: 'aaa', source: 'file', sourceDetail: '2', ...cmd() }
      ),
      commandSchema: schemaOf(['list', 'zzz', 'aaa']),
    });
    assert.deepEqual(r.errors, []);
  });

  it('list 子命令是保留字：它不计入资源比对，缺失时单独报错', () => {
    const r = checkParity({
      registry: registryOf({ id: 'users', source: 'db', sourceDetail: 'u', ...cmd() }),
      commandSchema: schemaOf(['users']),
    });
    assert.deepEqual(r.errors, ["CLI_PARITY: manage sub-commands must include 'list'"]);
  });

  it('KNOWN-DEFECT: manage 缺省被 `|| []` 兜底成空表，但子命令表整体缺失时直接抛 TypeError', () => {
    // Measured: getRouterSubCommands() → {} with an EMPTY registry → [] vs []
    // compare equal, so only the reserved 'list' line is reported: the missing
    // manage array is silently tolerated.
    assert.deepEqual(
      checkParity({ registry: registryOf(), commandSchema: { getRouterSubCommands: () => ({}) } }).errors,
      ["CLI_PARITY: manage sub-commands must include 'list'"]
    );
    // Measured: the same missing array against a non-empty registry now also
    // reports the resource the CLI can no longer reach.
    assert.deepEqual(
      checkParity({
        registry: registryOf({ id: 'u', source: 'db', sourceDetail: 'g', ...cmd() }),
        commandSchema: { getRouterSubCommands: () => ({}) },
      }).errors,
      [
        'CLI_PARITY: manage sub-commands [] != registry resources [u]',
        "CLI_PARITY: manage sub-commands must include 'list'",
      ]
    );
    // Measured: getRouterSubCommands() → undefined → TypeError, not a verdict.
    assert.throws(
      () => checkParity({ registry: registryOf(), commandSchema: { getRouterSubCommands: () => undefined } }),
      TypeError
    );
  });

  it('KNOWN-DEFECT: manage 是字符串时守卫抛 TypeError 而不是产出 { ok:false }，与「返回 {ok,errors}」的注释矛盾', () => {
    // Measured: manage:'users' passes the truthiness gate, then subs.filter is
    // not a function → TypeError escapes checkParity.
    assert.throws(
      () =>
        checkParity({
          registry: registryOf({ id: 'users', source: 'db', sourceDetail: 'u', ...cmd() }),
          commandSchema: schemaOf('users'),
        }),
      (err) => {
        assert.ok(err instanceof TypeError, `expected TypeError, got ${err.name}`);
        assert.match(err.message, /subs\.filter is not a function/);
        return true;
      }
    );
    // Array.isArray would have rejected it; the guard only checks truthiness.
    assert.equal(Array.isArray('users'), false);
  });

  it('describe 列出的 id 在 get 里查不到时报 MISSING_CONTRACT 并跳过后续能力检查', () => {
    const reg = {
      describe: () => [{ id: 'ghost', source: 'db', sourceDetail: 'g', capabilities: ['list'] }],
      get: () => null,
    };
    const r = checkParity({ registry: reg, commandSchema: schemaOf(['list', 'ghost']) });
    assert.deepEqual(r.errors, ["MISSING_CONTRACT: describe() listed 'ghost' but get() returned nothing"]);
  });

  it('能力数组为空或非数组时报 NO_CAPABILITIES', () => {
    for (const capabilities of [[], undefined, null, 'list', {}]) {
      const reg = {
        describe: () => [{ id: 'u', source: 'db', sourceDetail: 'g', capabilities }],
        get: () => ({ id: 'u', capabilities, ops: { list: () => {} } }),
      };
      const r = checkParity({ registry: reg, commandSchema: schemaOf(['list', 'u']) });
      assert.deepEqual(r.errors, ["NO_CAPABILITIES: 'u' declares no capabilities"], `capabilities=${String(capabilities)}`);
    }
  });

  it('声明了能力但 ops 里无对应实现时报 NO_IMPL，逐条列出', () => {
    const contract = {
      id: 'u',
      capabilities: ['list', 'add', 'remove'],
      ops: { list: () => {}, add: 'not-a-function' },
    };
    const reg = {
      describe: () => [{ id: 'u', source: 'db', sourceDetail: 'g', capabilities: contract.capabilities }],
      get: () => contract,
    };
    const r = checkParity({ registry: reg, commandSchema: schemaOf(['list', 'u']) });
    assert.deepEqual(r.errors, [
      "NO_IMPL: 'u.add' has no ops implementation",
      "NO_IMPL: 'u.remove' has no ops implementation",
    ]);
  });

  it('KNOWN-DEFECT: 契约缺 ops 字段时 NO_CAPABILITIES 的 continue 兜不住，检查抛 TypeError', () => {
    // Measured: capabilities non-empty array + `ops` absent → `contract.ops[cap]`
    // → TypeError: Cannot read properties of undefined. The guard documented as
    // "pure, read-only check ... returns { ok, errors}" blows up instead.
    const reg = {
      describe: () => [{ id: 'u', source: 'db', sourceDetail: 'g', capabilities: ['list'] }],
      get: () => ({ id: 'u', capabilities: ['list'] }),
    };
    assert.throws(() => checkParity({ registry: reg, commandSchema: schemaOf(['list', 'u']) }), TypeError);
  });

  it('KNOWN-DEFECT: describe() 重复列出同一 id 时真源冲突只报一条，去重后的 CLI 侧却报成资源表不一致', () => {
    // Measured: two matrix rows with identical id+source+detail produce ONE
    // SOURCE_CONFLICT (both point at 'dup'), while the ids list keeps the
    // duplicate and no longer matches the CLI sub-commands.
    const row = { id: 'dup', source: 'db', sourceDetail: 'same', capabilities: ['list'] };
    const reg = {
      describe: () => [row, { ...row }],
      get: () => ({ id: 'dup', capabilities: ['list'], ops: { list: () => {} } }),
    };
    const r = checkParity({ registry: reg, commandSchema: schemaOf(['list', 'dup']) });
    assert.deepEqual(r.errors, [
      "SOURCE_CONFLICT: 'dup' and 'dup' both bind source db:same",
      'CLI_PARITY: manage sub-commands [dup] != registry resources [dup, dup]',
    ]);
  });

  it('三类错误同时存在时全部收集，不因首个错误短路', () => {
    const r = checkParity({
      registry: registryOf(
        { id: 'a', source: 'db', sourceDetail: 'x', ...cmd() },
        { id: 'b', source: 'db', sourceDetail: 'x', ...cmd({ capabilities: ['list'], ops: {} }) }
      ),
      commandSchema: schemaOf(['a', 'b', 'extra']),
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors, [
      "SOURCE_CONFLICT: 'b' and 'a' both bind source db:x",
      'CLI_PARITY: manage sub-commands [a, b, extra] != registry resources [a, b]',
      "CLI_PARITY: manage sub-commands must include 'list'",
      "NO_IMPL: 'b.list' has no ops implementation",
    ]);
    assert.equal(r.errors.length, 4);
  });

  it('默认 commandSchema 走仓内真源：与出厂 manage 子命令表自洽', () => {
    // Only `registry` is injected, so checkParity falls back to the real
    // constants/commandSchema. The registry is derived from that same shipped
    // list, which pins today's `manage` surface (8 entries incl. 'list').
    const schema = require('../../../../constants/commandSchema');
    const subs = schema.getRouterSubCommands().manage;
    assert.deepEqual(subs, ['list', 'users', 'api-keys', 'dependencies', 'custom-providers', 'model-overrides', 'model-config', 'cron']);
    const contracts = subs
      .filter((s) => s !== 'list')
      .map((id) => ({ id, source: 'env', sourceDetail: `stub:${id}`, ...cmd() }));
    assert.deepEqual(checkParity({ registry: registryOf(...contracts) }), { ok: true, errors: [] });
  });

  it('入参 deps 为 null 时默认值不生效，直接 TypeError', () => {
    // Measured: `deps = {}` only defaults on undefined; null.registry throws.
    assert.throws(() => checkParity(null), TypeError);
  });

  it('KNOWN-DEFECT: 接真·managementRegistry 时 SOURCE_CONFLICT / NO_IMPL 两条不变量根本不可达', () => {
    // Measured: register() runs validateContract + its own source-uniqueness
    // check first, so a registry built through the real funnel can never carry
    // a duplicated source or a capability without an impl. parityGuard re-checks
    // both and can only ever report CLI_PARITY here.
    const registry = require('./managementRegistry');
    registry._reset();
    try {
      registry.register({ id: 'pg-one', label: '一', source: 'env', sourceDetail: 'pg:1', capabilities: ['list'], ops: { list: () => {} } });
      registry.register({
        id: 'pg-two',
        label: '二',
        source: 'env',
        sourceDetail: 'pg:2',
        capabilities: ['list', 'add'],
        ops: { list: () => {}, add: () => {} },
      });
      // Only the registry half is injected; the CLI side falls back to the real
      // shipped `manage` list, so parity must fail for the two fake ids.
      const r = checkParity({ registry });
      assert.equal(r.ok, false);
      assert.deepEqual(r.errors, [
        'CLI_PARITY: manage sub-commands [api-keys, cron, custom-providers, dependencies, model-config, model-overrides, users] != registry resources [pg-one, pg-two]',
      ]);
      assert.throws(
        () => registry.register({ id: 'pg-three', label: '三', source: 'env', sourceDetail: 'pg:1', capabilities: ['list'], ops: { list: () => {} } }),
        /真源冲突/
      );
      assert.throws(
        () => registry.register({ id: 'pg-four', label: '四', source: 'env', sourceDetail: 'pg:4', capabilities: ['list'], ops: {} }),
        /缺少对应的 ops\.list 实现/
      );
      assert.equal(checkParity({ registry }).errors.some((e) => /SOURCE_CONFLICT|NO_IMPL/.test(e)), false);
    } finally {
      registry._reset();
    }
  });
});
