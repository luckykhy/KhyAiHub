'use strict';

/**
 * Colocated contract test for protocolContext.js (harness/protocol resolution).
 * Batch 38 (C-4 test-colocated). Source file untouched.
 *
 * gateway / capability / adapter modules are injected, so no real service loads.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveProtocolContext } = require('./protocolContext');

function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[name] = prev;
    else delete process.env[name];
  }
}

const PROFILE = { toolCallProtocol: 'native', name: 'default' };

function makeDeps(overrides = {}) {
  const seen = { breadcrumb: [], tiers: [], capCalls: [], adapters: [] };
  const deps = {
    chatOpts: { model: 'claude-x' },
    options: {},
    modelTier: {
      resolveTier: (m) => {
        seen.tiers.push(m);
        return 'T1';
      },
      harnessProfile: (tier) => (tier === 'T0' ? { ...PROFILE, toolCallProtocol: 'native', tier } : PROFILE),
    },
    loopBreadcrumb: (...args) => seen.breadcrumb.push(args),
    toolCap: {
      isEnabled: () => true,
      modelLacksReliableToolCalling: (m, opts) => {
        seen.capCalls.push([m, opts]);
        return false;
      },
    },
    toolCapStore: { getVerdict: () => ({ verdict: 'native-ok' }) },
    toolProtocolAdapter: {
      resolveAdapter: (p) => {
        seen.adapters.push(p);
        return { __adapterFor: p };
      },
    },
    ...overrides,
  };
  return { deps, seen };
}

test('the returned bag carries exactly the five documented resolutions', () => {
  const { deps } = makeDeps();
  assert.deepEqual(Object.keys(resolveProtocolContext(deps)).sort(), [
    'activeAdapter',
    'activeProtocol',
    'harnessProfile',
    'isTextProtocol',
    'modelLacksNativeTools',
  ]);
});

test('model id precedence: chatOpts.model > options.model > env > empty string', () => {
  const a = makeDeps({ chatOpts: { model: 'fromChatOpts' }, options: { model: 'fromOptions' } });
  resolveProtocolContext(a.deps);
  assert.deepEqual(a.seen.tiers, ['fromChatOpts']);

  const b = makeDeps({ chatOpts: {}, options: { model: 'fromOptions' } });
  resolveProtocolContext(b.deps);
  assert.deepEqual(b.seen.tiers, ['fromOptions']);

  const c = makeDeps({ chatOpts: {}, options: {} });
  withEnv('GATEWAY_PREFERRED_MODEL', 'fromEnv', () => resolveProtocolContext(c.deps));
  assert.deepEqual(c.seen.tiers, ['fromEnv']);

  const d = makeDeps({ chatOpts: {}, options: {} });
  withEnv('GATEWAY_PREFERRED_MODEL', undefined, () => resolveProtocolContext(d.deps));
  assert.deepEqual(d.seen.tiers, [''], 'no model anywhere → the empty string, never undefined');
});

test('the harness profile is always announced as a breadcrumb', () => {
  const { deps, seen } = makeDeps();
  const r = resolveProtocolContext(deps);
  assert.deepEqual(seen.breadcrumb[0], ['harness-profile', r.harnessProfile]);
});

test('explicit toolCallProtocol wins over the harness default, and only text/native are honoured', () => {
  for (const p of ['text', 'native']) {
    const { deps, seen } = makeDeps({ options: { toolCallProtocol: p } });
    const r = resolveProtocolContext(deps);
    assert.equal(r.activeProtocol, p);
    assert.equal(r.isTextProtocol, p === 'text');
    assert.deepEqual(seen.adapters, [p], 'the adapter is resolved with the ACTIVE protocol');
  }
  const { deps } = makeDeps({ options: { toolCallProtocol: 'sideways' } });
  assert.equal(resolveProtocolContext(deps).activeProtocol, 'native', 'an unknown value falls back to the harness default');
});

test('with no explicit protocol the harness default is used, and a missing field means native', () => {
  const { deps } = makeDeps();
  assert.equal(resolveProtocolContext(deps).activeProtocol, 'native');

  const bare = makeDeps({
    modelTier: { resolveTier: () => 'T3', harnessProfile: () => ({}) },
  });
  assert.equal(resolveProtocolContext(bare.deps).activeProtocol, 'native');
});

test('the text protocol emits its own breadcrumb; native stays silent', () => {
  const text = makeDeps({ options: { toolCallProtocol: 'text' } });
  resolveProtocolContext(text.deps);
  assert.deepEqual(text.seen.breadcrumb[1], ['tool-protocol', { protocol: 'text' }]);

  const nat = makeDeps({ options: { toolCallProtocol: 'native' } });
  resolveProtocolContext(nat.deps);
  assert.equal(nat.seen.breadcrumb.length, 1, 'only harness-profile');
});

test('the measured verdict is looked up per model id and passed to the capability SSOT', () => {
  const { deps, seen } = makeDeps();
  resolveProtocolContext(deps);
  assert.deepEqual(seen.capCalls, [['claude-x', { measured: { verdict: 'native-ok' } }]]);
});

test('a capability store that throws still asks the SSOT — with measured: null', () => {
  const { deps, seen } = makeDeps({
    toolCapStore: {
      getVerdict: () => {
        throw new Error('store cold');
      },
    },
  });
  const r = resolveProtocolContext(deps);
  assert.deepEqual(seen.capCalls[0][1], { measured: null });
  assert.equal(r.modelLacksNativeTools, false);
});

test('a disabled capability SSOT short-circuits: the verdict is read but never consulted', () => {
  const { deps, seen } = makeDeps({ toolCap: { isEnabled: () => false, modelLacksReliableToolCalling: () => true } });
  assert.equal(resolveProtocolContext(deps).modelLacksNativeTools, false);
  assert.equal(seen.capCalls.length, 0, 'the alarming default stays off, byte-identical to legacy');
});

test('capability resolution throwing → modelLacksNativeTools false (the calm default)', () => {
  const { deps } = makeDeps({
    toolCap: {
      isEnabled: () => true,
      modelLacksReliableToolCalling: () => {
        throw new Error('ssot absent');
      },
    },
  });
  assert.equal(resolveProtocolContext(deps).modelLacksNativeTools, false);
});

test('a true verdict is forwarded verbatim into the result', () => {
  const { deps } = makeDeps({
    toolCap: { isEnabled: () => true, modelLacksReliableToolCalling: () => true },
  });
  assert.equal(resolveProtocolContext(deps).modelLacksNativeTools, true);
});

test('a missing chatOpts/options pair does not break resolution', () => {
  const { deps } = makeDeps({ chatOpts: null, options: null });
  const r = resolveProtocolContext(deps);
  assert.equal(r.activeProtocol, 'native');
  assert.equal(r.modelLacksNativeTools, false);
});

test('ASYMMETRY (registered, not fixed): the adapter is resolved outside any guard — a bare adapter escapes as a throw', () => {
  const { deps } = makeDeps({ toolProtocolAdapter: null });
  assert.throws(() => resolveProtocolContext(deps), TypeError);
  // ...while the capability pair right above it is fully fail-soft:
  const ok = makeDeps({ toolCapStore: null });
  assert.doesNotThrow(() => resolveProtocolContext(ok.deps));
});

// [DESIGN-ARCH-185] §5.2 —— β 的另一半。
// thinkingFloor 的唯一消费者在 tool-use 循环里，而循环用的是**本函数**产出的 profile。
// 只在 prompt 组装侧接 mode 轴是不够的：那条路径改的是提示词，改不到思考预算。
test('mode intent reaches the loop profile (and stays out when the mode axis is absent)', () => {
  const rm = require('../../../gateway/routingMode');

  // 期望值从档位卡现取，不把某个档的 thinkingFloor 字面量写进断言。
  const modesWithFloor = rm
    .listModes()
    .filter((m) => m.key !== 'auto')
    .map((m) => ({
      key: m.key,
      intent: rm.staticIntentForTier('T2', { GATEWAY_ROUTING_MODE: m.key, KHY_ROUTING_MODES: '1' }),
    }))
    .filter((e) => e.intent && e.intent.thinkingFloor);
  assert.ok(
    modesWithFloor.length > 0,
    '档位卡里没有任何固定档声明 thinkingFloor —— 本测试将空跑'
  );

  const runWith = (envPairs) => {
    let received = '__unset__';
    const { deps } = makeDeps({
      modelTier: {
        resolveTier: () => 'T2',
        harnessProfile: (tier, opts) => {
          received = (opts && opts.modeIntent) === undefined ? '__unset__' : (opts && opts.modeIntent);
          return PROFILE;
        },
      },
    });
    const keys = Object.keys(envPairs);
    const apply = (i) => {
      if (i === keys.length) return resolveProtocolContext(deps);
      return withEnv(keys[i], envPairs[keys[i]], () => apply(i + 1));
    };
    apply(0);
    return received;
  };

  // ① 选了一个固定档 → modeIntent 必须真的传进 profile（否则档选了、β 没变）
  const picked = modesWithFloor[0];
  const got = runWith({ GATEWAY_ROUTING_MODE: picked.key, KHY_ROUTING_MODES: '1' });
  assert.notStrictEqual(got, '__unset__', 'harnessProfile 没有收到第二参数');
  assert.notStrictEqual(got, null, `选了「${picked.key}」档却没解析出意图（require 路径断了会被静默吞掉）`);
  assert.strictEqual(got.thinkingFloor, picked.intent.thinkingFloor);

  // ② 对照:auto 档在这一侧拿不到用户原话,必须传 null → 纯 tier 行为逐字节不变
  const autoRow = runWith({ GATEWAY_ROUTING_MODE: 'auto', KHY_ROUTING_MODES: '1' });
  assert.strictEqual(autoRow, null, 'auto 档不该在这一侧拿到静态意图');

  // ③ 对照:总闸关闭 → 整条模式轴缺席
  const offRow = runWith({ GATEWAY_ROUTING_MODE: picked.key, KHY_ROUTING_MODES: '0' });
  assert.strictEqual(offRow, null, 'KHY_ROUTING_MODES=0 时模式轴必须完全缺席');
});

// §15-1 在**这条消费路径**上的落点：β 的唯一消费者就是循环用的这份 profile，
// 所以旁路必须在这里证明，而不是只在 routingMode 的单元测试里证明。
test('pinned channel bypasses the mode axis at the loop profile (§15-1)', () => {
  const rm = require('../../../gateway/routingMode');
  let received = '__unset__';
  const build = () => {
    received = '__unset__';
    const { deps } = makeDeps({
      modelTier: {
        resolveTier: () => 'T2',
        harnessProfile: (tier, opts) => {
          received = opts && opts.modeIntent === undefined ? '__unset__' : opts.modeIntent;
          return PROFILE;
        },
      },
    });
    resolveProtocolContext(deps);
    return received;
  };

  // 前置：钉选关掉、档开着 ⇒ 必须拿到意图（否则后面的 null 是空断言）
  withEnv('GATEWAY_PREFERRED_ADAPTER', undefined, () =>
    withEnv('GATEWAY_PREFERRED_MODEL', undefined, () => {
      withEnv('GATEWAY_ROUTING_MODE', 'extreme', () => withEnv('KHY_ROUTING_MODES', '1', () => {
        const open = build();
        assert.ok(open, '未钉选时循环侧应拿到模式意图 —— 前置不成立');
        assert.strictEqual(rm.pinnedBypass(process.env), false);
      }));
    })
  );

  // 钉渠道 ⇒ 同一份 profile 必须退回纯 tier（β/π 都不写）
  withEnv('GATEWAY_PREFERRED_ADAPTER', 'api', () => {
    withEnv('GATEWAY_ROUTING_MODE', 'extreme', () =>
      withEnv('KHY_ROUTING_MODES', '1', () => {
        assert.strictEqual(build(), null, '钉了渠道，循环侧仍被模式轴改写');
      })
    );
  });

  // 钉模型也算
  withEnv('GATEWAY_PREFERRED_ADAPTER', 'auto', () =>
    withEnv('GATEWAY_PREFERRED_MODEL', 'claude-opus-4-7', () =>
      withEnv('GATEWAY_ROUTING_MODE', 'extreme', () =>
        withEnv('KHY_ROUTING_MODES', '1', () => {
          assert.strictEqual(build(), null, '钉了模型，循环侧仍被模式轴改写');
        })
      )
    )
  );
});
