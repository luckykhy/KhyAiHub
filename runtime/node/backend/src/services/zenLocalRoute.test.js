'use strict';

/**
 * zenLocalRoute.test.js — 「本机直连 vs 服务端代理」的决策契约。
 *
 * 语义对应用户诉求「在哪台机器上允许就在那台机器上使用它的机器码和ip」：
 *   - 上游免费层配额按出口 IP 计（2026-10-24 实测）→ 服务端代发 = 全员共用一份配额；
 *   - 故本机有 opencode CLI 时请求交回本机发出；没有则回退代理，不让免费渠道整体不可用；
 *   - 「除非用户明确指定修改」→ KHY_ZEN_ROUTE 是显式覆盖入口，优先于自动判定。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const route = require('./zenLocalRoute');

const FREE = 'flint-40b-free';

test('非 zen 池 → 不适用', () => {
  const d = route.decide({ poolKey: 'glm', model: 'glm-4.7-flash', localAvailable: true, env: {} });
  assert.strictEqual(d.mode, route.MODE_NA);
});

test('zen 池但不是免费模型 → 不适用（付费模型走原代理路）', () => {
  const d = route.decide({ poolKey: 'opencode-zen', model: 'claude-opus-4-5', localAvailable: true, env: {} });
  assert.strictEqual(d.mode, route.MODE_NA);
});

test('免费模型 + 本机无 opencode → proxy', () => {
  const d = route.decide({ poolKey: 'opencode-zen', model: FREE, localAvailable: false, env: {} });
  assert.strictEqual(d.mode, route.MODE_PROXY);
  assert.strictEqual(d.reason, 'no-local-opencode');
});

test('免费模型 + 本机有 opencode → local（本机 IP 与机器码）', () => {
  const d = route.decide({ poolKey: 'opencode-zen', model: FREE, localAvailable: true, env: {} });
  assert.strictEqual(d.mode, route.MODE_LOCAL);
  assert.strictEqual(d.reason, 'local-opencode-available');
});

test('显式 KHY_ZEN_ROUTE=proxy 优先于自动判定（用户明确指定修改）', () => {
  const d = route.decide({
    poolKey: 'opencode-zen',
    model: FREE,
    localAvailable: true,
    env: { KHY_ZEN_ROUTE: 'proxy' },
  });
  assert.strictEqual(d.mode, route.MODE_PROXY);
  assert.strictEqual(d.reason, 'explicit-proxy');
});

test('显式 KHY_ZEN_ROUTE=local 即便探测不到本机 opencode 也照走（不静默改回代理）', () => {
  const d = route.decide({
    poolKey: 'opencode-zen',
    model: FREE,
    localAvailable: false,
    env: { KHY_ZEN_ROUTE: 'local' },
  });
  assert.strictEqual(d.mode, route.MODE_LOCAL);
  assert.strictEqual(d.reason, 'explicit-local');
});

test('主门 KHY_ZEN_LOCAL_ROUTE 关 → 一律 proxy（逐字节回退现状）', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    const d = route.decide({
      poolKey: 'opencode-zen',
      model: FREE,
      localAvailable: true,
      env: { KHY_ZEN_LOCAL_ROUTE: v },
    });
    assert.strictEqual(d.mode, route.MODE_PROXY, `KHY_ZEN_LOCAL_ROUTE=${v} 应回退代理`);
    assert.strictEqual(d.reason, 'gate-off');
  }
});

test('主门开启的各种写法都算开', () => {
  for (const v of ['', '1', 'true', 'on', 'yes']) {
    assert.strictEqual(route.localRouteEnabled({ KHY_ZEN_LOCAL_ROUTE: v }), true, v);
  }
  assert.strictEqual(route.localRouteEnabled({}), true);
});

test('isFreeZenModel 只认 -free 后缀', () => {
  assert.strictEqual(route.isFreeZenModel('flint-40b-free'), true);
  assert.strictEqual(route.isFreeZenModel('big-pickle'), false); // big-pickle 无 -free 后缀
  assert.strictEqual(route.isFreeZenModel(''), false);
});

test('localModelArg 产出本机 opencode 认得的 provider/model', () => {
  assert.strictEqual(route.localModelArg('flint-40b-free'), 'opencode/flint-40b-free');
  assert.strictEqual(route.localModelArg('opencode/xxx'), 'opencode/xxx');
  assert.strictEqual(route.localModelArg(''), '');
});

test('坏输入不抛，落到安全回退', () => {
  assert.doesNotThrow(() => route.decide(null));
  assert.doesNotThrow(() => route.decide({ poolKey: 'opencode-zen', model: FREE }));
  const d = route.decide({ poolKey: 'opencode-zen', model: FREE, localAvailable: true, env: null });
  assert.ok([route.MODE_LOCAL, route.MODE_PROXY].includes(d.mode));
});
