'use strict';

/**
 * externalDelegationCascade.test.js — 普通问题不得被连弹外部智能体委派审批卡
 * （`PROCESS-004`：默认自做，委派是例外）。
 *
 * 实测样本 works/data/khy/ruleguard/delegation-gate.jsonl：同一组四个 key
 * （claude → cli → opencode → acp）每轮按序被试，每个 key 各弹一张卡，全拒后整轮失败。
 * 两个根因在此各钉一组断言：
 *   A 外部委派 key 不得进自动候选池 —— 预检「自动挑通道」把 claude/codex 当普通候选，
 *     胜者直写 GATEWAY_PREFERRED_ADAPTER + STRICT，随后级联逐个询问。
 *   B 一次拒绝 = 本轮其余外部 key 静默跳过 —— 用户的拒绝是对「把活交给外部智能体」
 *     这件事本身的拒绝，不是对某一个 key 的拒绝。
 *
 * 判定逻辑的单一真源在 delegationGate.js：外部 key 集合只有那一份
 * （RUNTIME-010 A2-5 禁止同一概念两份定义），本文件只消费它的导出，不复制任何 key 清单。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  HUMAN_PIN_APPROVED,
  isExternalDelegationAdapter,
  stripUnapprovedExternalAdapters,
  shouldSilenceExternalOnRoundDenial,
} = require('./delegationGate');

const GATE_METHOD_SRC = path.join(__dirname, 'aiGatewayGenerateMethod.js');
const PREFLIGHT_SRC = path.join(__dirname, '..', '..', 'cli', 'aiMessageBuilder.js');

const mb = require('../../cli/aiMessageBuilder');
const chatState = require('../../cli/aiChatState');

function makeFakeGateway(types, probed, pinned) {
  return {
    isInitialized: () => true,
    init: async () => {},
    getStatus: () => types.map((type) => ({ enabled: true, available: true, type })),
    testAdapter: async (key) => {
      probed.push(key);
      return { connectivity: { success: true }, generation: { success: true }, models: { success: true } };
    },
    setActiveChannel: (key) => pinned.push(key),
  };
}

async function runPreflight(types) {
  const probed = [];
  const pinned = [];
  const envBefore = {
    pin: process.env.GATEWAY_PREFERRED_ADAPTER,
    strict: process.env.GATEWAY_PREFERRED_STRICT,
  };
  mb.setAiMessageBuilderDeps({ getGateway: () => makeFakeGateway(types, probed, pinned) });
  chatState.gatewayPreflightDone = false;
  chatState.gatewayPreflightInFlight = null;
  delete process.env.GATEWAY_PREFERRED_ADAPTER;
  delete process.env.GATEWAY_PREFERRED_STRICT;
  try {
    await mb._preflightGatewayAvailability({});
    return { probed, pinned, pin: process.env.GATEWAY_PREFERRED_ADAPTER || '' };
  } finally {
    chatState.gatewayPreflightDone = false;
    chatState.gatewayPreflightInFlight = null;
    for (const [k, v] of [
      ['GATEWAY_PREFERRED_ADAPTER', envBefore.pin],
      ['GATEWAY_PREFERRED_STRICT', envBefore.strict],
    ]) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

test('A/预检：外部委派 key 不探测、不写 env 钉选——否则每轮都拿它当首选候选', async () => {
  const { probed, pinned, pin } = await runPreflight([
    'claude',
    'codex',
    'cli',
    'opencode',
    'acp',
    'api',
    'ollama',
  ]);
  for (const key of probed) {
    assert.strictEqual(isExternalDelegationAdapter(key), false, `不得探测外部委派通道: ${key}`);
  }
  assert.ok(pin, '有原生候选时必须钉选原生通道');
  assert.strictEqual(isExternalDelegationAdapter(pin), false, `env 钉选不得是外部通道: ${pin}`);
  for (const key of pinned) {
    assert.strictEqual(isExternalDelegationAdapter(key), false, `不得 setActiveChannel 到外部通道: ${key}`);
  }
});

test('A/预检：只剩外部委派 key 时一个都不探测，也不改 env 钉选', async () => {
  const { probed, pinned, pin } = await runPreflight(['claude', 'codex', 'opencode', 'acp']);
  assert.deepStrictEqual(probed, [], '外部委派通道不得作为自动候选被探测');
  assert.deepStrictEqual(pinned, []);
  assert.strictEqual(pin, '', '不得把外部通道写进 GATEWAY_PREFERRED_ADAPTER');
});

test('A/级联：未经人类批准时外部 key 从序列剔除，原生顺序不变', () => {
  const cascade = [
    { key: 'claude' },
    { key: 'api' },
    { key: 'codex' },
    { key: 'ollama' },
    { key: 'cli' },
  ];
  const { kept, removedKeys } = stripUnapprovedExternalAdapters(cascade, {});
  assert.deepStrictEqual(
    kept.map((a) => a.key),
    ['api', 'ollama']
  );
  assert.deepStrictEqual(removedKeys.sort(), ['claude', 'cli', 'codex']);
});

test("A/级联：humanPin='user-command'（用户亲手 khy <agent>）原样保留", () => {
  const cascade = [{ key: 'claude' }, { key: 'api' }, { key: 'codex' }];
  const { kept, removedKeys } = stripUnapprovedExternalAdapters(cascade, {
    delegationApprovedByUser: HUMAN_PIN_APPROVED,
  });
  assert.deepStrictEqual(
    kept.map((a) => a.key),
    ['claude', 'api', 'codex']
  );
  assert.deepStrictEqual(removedKeys, []);
});

test('A/级联：用户显式钉选的外部通道原样保留，其余外部 key 仍剔除', () => {
  const cascade = [{ key: 'claude' }, { key: 'api' }, { key: 'codex' }];
  const { kept, removedKeys } = stripUnapprovedExternalAdapters(cascade, {
    userPinnedAdapter: true,
    preferredAdapter: 'claude',
  });
  assert.deepStrictEqual(
    kept.map((a) => a.key),
    ['claude', 'api']
  );
  assert.deepStrictEqual(removedKeys, ['codex']);
});

test('A/级联：env 机器钉选（非 userPinnedAdapter）不构成批准，照样剔除', () => {
  const cascade = [{ key: 'codex' }, { key: 'api' }];
  const { kept, removedKeys } = stripUnapprovedExternalAdapters(cascade, {
    preferredAdapter: 'codex',
  });
  assert.deepStrictEqual(
    kept.map((a) => a.key),
    ['api']
  );
  assert.deepStrictEqual(removedKeys, ['codex']);
});

test('A/级联：用户的显式 opt-out（KHY_DELEGATION_APPROVAL=allow）保留整条序列', () => {
  const cascade = [{ key: 'claude' }, { key: 'api' }];
  const { kept, removedKeys } = stripUnapprovedExternalAdapters(cascade, {
    delegationPolicy: 'allow',
  });
  assert.deepStrictEqual(
    kept.map((a) => a.key),
    ['claude', 'api']
  );
  assert.deepStrictEqual(removedKeys, []);
});

test('C/级联前 strict 成员检查必须放行「钉选通道已被委派剔除」，否则零尝试终局失败', () => {
  // Trigger surface: repl/startup.js:158-160 machine-writes
  // GATEWAY_PREFERRED_ADAPTER=<external key> + GATEWAY_PREFERRED_STRICT=true. Inside
  // generate() that pin is NOT userPinnedAdapter, so the strip removes the pinned
  // key from the cascade; the pre-loop strict member check must then relax exactly
  // like the two in-loop strict branches — otherwise a registered, available channel
  // is reported as "not registered" and the round dies with zero attempts, leaving
  // the native channels never tried.
  const strip = stripUnapprovedExternalAdapters(
    [{ key: 'claude' }, { key: 'api' }, { key: 'kiro' }],
    { delegationPolicy: 'ask', userPinnedAdapter: false, preferredAdapter: 'claude' }
  );
  assert.deepStrictEqual(strip.removedKeys, ['claude']);
  assert.strictEqual(
    strip.kept.find((a) => a.key === 'claude'),
    undefined
  );

  const src = fs.readFileSync(GATE_METHOD_SRC, 'utf8');
  const at = src.indexOf(
    'const preferredEntry = orderedAdapters.find((a) => a.key === preferredAdapter);'
  );
  assert.ok(at > 0, '级联前的 strict 成员检查不存在');
  const guard = src.slice(Math.max(0, at - 700), at);
  assert.ok(guard.includes('strictPreferredOnly'), '定位窗口漂移：未找到 strict 前置条件');
  assert.ok(
    guard.includes('!_delegationDeniedOnPreferred'),
    '级联前的 strict 成员早退必须与两处循环内分支同样用 _delegationDeniedOnPreferred 放行'
  );
});

test('C/mesh 接线：generate() 必须取 services/modelMesh 的 getModelMesh，不是 routes 路由', () => {
  // Same accident shape as the one recorded at aiGatewayGenerateMethod.js:670-674:
  // requiring the routes/ Express router leaves getModelMesh undefined, so EVERY
  // generate() call throws KHY_MESH_WIRING, spams console.error and pushes a
  // 「模型 mesh 接线异常」status at the user, and cross-machine forwarding dies.
  const servicesMesh = require('../../services/modelMesh');
  assert.strictEqual(typeof servicesMesh.getModelMesh, 'function');
  const src = fs.readFileSync(GATE_METHOD_SRC, 'utf8');
  const req = src.match(/require\('(\.\.\/\.\.\/[^']*)'\);\s*\n\s*if \(typeof meshModule\.getModelMesh/g);
  assert.ok(req, 'mesh 接线块不存在（require 后应紧跟 getModelMesh 的 typeof 检查）');
  assert.strictEqual(
    req[0].includes("require('../../services/modelMesh')"),
    true,
    `mesh require 指错了模块: ${req[0].split('\n')[0]}`
  );
});

test('B/静默：本轮已有外部委派被拒后，其余外部 key 直接跳过（不再弹卡）', () => {
  assert.strictEqual(shouldSilenceExternalOnRoundDenial('codex', true), true);
  assert.strictEqual(shouldSilenceExternalOnRoundDenial('CLI', true), true, '大小写不敏感');
  assert.strictEqual(shouldSilenceExternalOnRoundDenial('opencode', true), true);
});

test('B/静默：无拒绝时不跳过；原生通道任何情况下都不跳过', () => {
  assert.strictEqual(shouldSilenceExternalOnRoundDenial('codex', false), false);
  assert.strictEqual(shouldSilenceExternalOnRoundDenial('api', true), false);
  assert.strictEqual(shouldSilenceExternalOnRoundDenial('ollama', true), false);
});

test('接线：级联与预检真的调用了这套判定（防大文件里被改回去）', () => {
  const gate = fs.readFileSync(GATE_METHOD_SRC, 'utf8');
  assert.ok(
    gate.includes('stripUnapprovedExternalAdapters'),
    'generate() 必须在组装完成后剔除未经批准的外部委派 key'
  );
  assert.ok(
    gate.includes('shouldSilenceExternalOnRoundDenial'),
    'generate() 必须在一次拒绝后静默跳过其余外部委派 key'
  );
  const preflight = fs.readFileSync(PREFLIGHT_SRC, 'utf8');
  assert.ok(
    preflight.includes('isExternalDelegationAdapter'),
    '预检的自动候选过滤必须排除外部委派 key（并复用 delegationGate 的单一真源）'
  );
});
