'use strict';

/**
 * routeResolver.js contract tests — the pure active-card rewriter: which apps a
 * wire protocol may belong to, what always outranks a card, how the candidate
 * scan falls through, and the exact shape of the rewritten route.
 *
 * Zero IO: the store is a hand-rolled fake passed in through ctx.store.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveCardRoute, appForProtocol, appsForProtocol } = require('./routeResolver');
const { APPS, PROTOCOLS } = require('./constants');

// Fake store: activeMap app→cardId, cards by id; `calls` records the scan order.
function fakeStore(activeMap, cards, opts = {}) {
  const calls = [];
  return {
    calls,
    getActiveCardId(app) {
      calls.push(['getActiveCardId', app]);
      if (opts.throwOn && opts.throwOn.includes(app)) throw new Error(`store blew up for ${app}`);
      return activeMap[app] || null;
    },
    getCard(id) {
      calls.push(['getCard', id]);
      return cards[id] || null;
    },
  };
}

const anthropicCard = { id: 'c_claude', name: 'Anthropic 卡', enabled: true, protocol: PROTOCOLS.ANTHROPIC, defaultModel: 'claude-x' };

test('appsForProtocol：四种在册线路各自的应用集', () => {
  assert.deepEqual(appsForProtocol(PROTOCOLS.ANTHROPIC), [APPS.CLAUDE_CODE, APPS.COMMAND_CODE]);
  assert.deepEqual(appsForProtocol(PROTOCOLS.OPENAI), [APPS.OPENCODE, APPS.COMMAND_CODE, APPS.YCODE]);
  assert.deepEqual(appsForProtocol(PROTOCOLS.GEMINI), [APPS.GEMINI]);
  // A free-form source string is not a protocol at all.
  assert.deepEqual(appsForProtocol('anthropic-messages'), []);
  assert.deepEqual(appsForProtocol(''), []);
});

test('appsForProtocol 每次都返回新数组，改写结果不污染后续调用', () => {
  const first = appsForProtocol(PROTOCOLS.ANTHROPIC);
  first.push('injected');
  assert.deepEqual(appsForProtocol(PROTOCOLS.ANTHROPIC), [APPS.CLAUDE_CODE, APPS.COMMAND_CODE]);
  assert.notEqual(appsForProtocol(PROTOCOLS.GEMINI), appsForProtocol(PROTOCOLS.GEMINI), 'fresh array per call');
});

test('appForProtocol 取候选集首个，空集返回 null（垃圾输入不抛错）', () => {
  assert.equal(appForProtocol(PROTOCOLS.ANTHROPIC), APPS.CLAUDE_CODE);
  assert.equal(appForProtocol(PROTOCOLS.OPENAI), APPS.OPENCODE);
  assert.equal(appForProtocol(PROTOCOLS.GEMINI), APPS.GEMINI);
  for (const junk of [null, '', 0, {}, [], 'codex', PROTOCOLS.RESPONSES]) {
    assert.equal(appForProtocol(junk), null, `junk=${String(junk)}`);
  }
  assert.equal(appForProtocol(), APPS.CODEX, 'no argument: the dead `case undefined` wins (see KNOWN-DEFECT)');
});

test('resolveCardRoute 前置门槛：无 store / 无 route / 线路不认识都返回 null', () => {
  const store = fakeStore({ [APPS.CLAUDE_CODE]: 'c_claude' }, { c_claude: anthropicCard });
  assert.notEqual(resolveCardRoute({ modelId: 'm' }, { store, sourceProtocol: PROTOCOLS.ANTHROPIC }), null, 'control: valid input does route');
  assert.equal(resolveCardRoute({ modelId: 'm' }, { sourceProtocol: PROTOCOLS.ANTHROPIC }), null, 'ctx without store');
  assert.equal(resolveCardRoute(null, { store, sourceProtocol: PROTOCOLS.ANTHROPIC }), null, 'no route');
  assert.equal(resolveCardRoute(undefined, { store }), null);
  const quiet = fakeStore({ [APPS.CLAUDE_CODE]: 'c_claude' }, { c_claude: anthropicCard });
  assert.equal(resolveCardRoute({ modelId: 'm' }, { store: quiet, sourceProtocol: 'bogus' }), null);
  assert.equal(quiet.calls.length, 0, 'unknown protocol must not even consult the store');
});

test('resolveCardRoute() 无参 / 只有 route 都安全返回 null，不接受 null ctx（见 KNOWN-DEFECT）', () => {
  assert.equal(resolveCardRoute(), null);
  assert.equal(resolveCardRoute({ modelId: 'm' }), null);
});

test('用户显式钉死通道永远压过卡片：四种钉死形态', () => {
  const store = fakeStore({ [APPS.CLAUDE_CODE]: 'c_claude' }, { c_claude: anthropicCard });
  const ctx = { store, sourceProtocol: PROTOCOLS.ANTHROPIC };
  const pinned = [
    { modelId: 'm', userPinned: true },
    { modelId: 'm', strictPreferred: true },
    { modelId: 'm', metadata: { source: 'explicit' } },
    { modelId: 'm', metadata: { source: 'route-map' } },
  ];
  for (const route of pinned) {
    assert.equal(resolveCardRoute(route, ctx), null, JSON.stringify(route));
  }
  assert.equal(store.calls.length, 0, 'pinned routes never reach the card scan');
});

test('钉死判定是严格形状：userPinned 真值字符串生效，strictPreferred 非 true 不生效', () => {
  const store = fakeStore({ [APPS.CLAUDE_CODE]: 'c_claude' }, { c_claude: anthropicCard });
  const ctx = { store, sourceProtocol: PROTOCOLS.ANTHROPIC };
  // Measured: `route.userPinned ||` is truthy-based, `strictPreferred === true` is strict.
  assert.equal(resolveCardRoute({ userPinned: 'yes' }, ctx), null, 'truthy userPinned pins');
  assert.equal(resolveCardRoute({ userPinned: 0 }, ctx) !== null, true, 'falsy userPinned does not pin');
  assert.equal(resolveCardRoute({ strictPreferred: 'true' }, ctx) !== null, true, 'non-true strictPreferred does NOT pin');
  assert.equal(resolveCardRoute({ metadata: { source: 'EXPLICIT' } }, ctx) !== null, true, 'source compare is case-sensitive');
  assert.equal(resolveCardRoute({ metadata: { source: '  explicit' } }, ctx) !== null, true, 'no trimming');
});

test('候选扫描顺序：首个有启用卡片的应用胜出，并只查到它为止', () => {
  const cards = { c_cc: { ...anthropicCard, id: 'c_cc', name: 'Claude Code 卡' } };
  const store = fakeStore({ [APPS.CLAUDE_CODE]: 'c_cc' }, cards);
  const out = resolveCardRoute({ modelId: 'm' }, { store, sourceProtocol: PROTOCOLS.ANTHROPIC });
  assert.equal(out.ccSwitchCardId, 'c_cc');
  assert.deepEqual(store.calls, [['getActiveCardId', APPS.CLAUDE_CODE], ['getCard', 'c_cc']]);
});

test('启用卡片判定链：禁用卡与取不到实体的 id 都让位给下一个候选应用', () => {
  const disabled = { id: 'a', name: 'A', enabled: false, protocol: PROTOCOLS.ANTHROPIC };
  const store = fakeStore(
    { [APPS.CLAUDE_CODE]: 'a', [APPS.COMMAND_CODE]: 'c' },
    { a: disabled, c: 'not-an-object' }
  );
  const out = resolveCardRoute({ modelId: 'm' }, { store, sourceProtocol: PROTOCOLS.ANTHROPIC });
  // Measured: claude-code card disabled → next candidate command-code → activeId 'c'
  // but getCard('c') returns a truthy string whose .enabled is undefined → falsy.
  assert.equal(out, null);
  assert.deepEqual(store.calls, [
    ['getActiveCardId', APPS.CLAUDE_CODE],
    ['getCard', 'a'],
    ['getActiveCardId', APPS.COMMAND_CODE],
    ['getCard', 'c'],
  ]);
});

test('store 抛错被逐个应用吞掉并继续下一个候选（fail-soft 扫描）', () => {
  const winner = { id: 'c_cmd', name: 'Command 卡', enabled: true, protocol: PROTOCOLS.ANTHROPIC };
  const store = fakeStore({ [APPS.COMMAND_CODE]: 'c_cmd' }, { c_cmd: winner }, { throwOn: [APPS.CLAUDE_CODE] });
  assert.doesNotThrow(() => {
    const out = resolveCardRoute({ modelId: 'm' }, { store, sourceProtocol: PROTOCOLS.ANTHROPIC });
    assert.equal(out.ccSwitchCardId, 'c_cmd');
  });
  assert.ok(store.calls.some((c) => c[1] === APPS.COMMAND_CODE), 'scan continued past the throwing app');
});

test('Codex 只接受 OpenAI 兼容上游：openai / openai_responses 放行，其余拒收', () => {
  const mk = (protocol) => {
    const card = { id: 'cx', name: 'Codex 卡', enabled: true, protocol, defaultModel: 'gpt-x' };
    return fakeStore({ [APPS.CODEX]: 'cx' }, { cx: card });
  };
  // Measured: the Codex candidate is only reachable when sourceProtocol is
  // literally undefined (see the KNOWN-DEFECT case below), so ctx is faked by
  // driving the resolver with undefined and a codex-only store.
  assert.equal(resolveCardRoute({ modelId: 'm' }, { store: mk(PROTOCOLS.OPENAI), sourceProtocol: undefined }).ccSwitchCardId, 'cx');
  assert.equal(resolveCardRoute({ modelId: 'm' }, { store: mk(PROTOCOLS.RESPONSES), sourceProtocol: undefined }).ccSwitchCardId, 'cx');
  for (const bad of [PROTOCOLS.ANTHROPIC, PROTOCOLS.GEMINI, undefined, null, '', 'OpenAI']) {
    assert.equal(resolveCardRoute({ modelId: 'm' }, { store: mk(bad), sourceProtocol: undefined }), null, `protocol=${String(bad)}`);
  }
});

test('重写形状：adapterKey/apiPoolProvider/metadata 全量钉死，未识别字段原样透传', () => {
  const store = fakeStore({ [APPS.GEMINI]: 'g' }, { g: { id: 'g', name: 'G 卡', enabled: true, protocol: PROTOCOLS.GEMINI, defaultModel: 'gemini-y', extraFlag: 7 } });
  const route = { modelId: 'gemini-pro', keepMe: 'x', metadata: { source: 'auto', traceId: 't1' } };
  const out = resolveCardRoute(route, { store, sourceProtocol: PROTOCOLS.GEMINI });
  assert.deepEqual(out, {
    modelId: 'gemini-pro',
    keepMe: 'x',
    metadata: { source: 'cc-switch-card', traceId: 't1', ccSwitchCardId: 'g', ccSwitchCardName: 'G 卡' },
    adapterKey: 'api',
    preferredAdapter: 'api',
    preferredModel: 'gemini-pro',
    strictPreferred: false,
    userPinned: false,
    ccSwitchCardId: 'g',
    ccSwitchCardName: 'G 卡',
    apiPoolProvider: 'cc-switch:g',
  });
  // Measured: only card.id/.name are lifted out of the card; card.extraFlag and
  // card.protocol never reach the rewritten route.
  assert.equal('extraFlag' in out, false);
  assert.equal('protocol' in out, false);
});

test('preferredModel 优先级：route.modelId > card.defaultModel > null', () => {
  const store = fakeStore({ [APPS.GEMINI]: 'g' }, { g: { id: 'g', enabled: true, protocol: PROTOCOLS.GEMINI, defaultModel: 'dm' } });
  const ctx = { store, sourceProtocol: PROTOCOLS.GEMINI };
  assert.equal(resolveCardRoute({ modelId: 'live' }, ctx).preferredModel, 'live');
  assert.equal(resolveCardRoute({}, ctx).preferredModel, 'dm');
  // Measured: '' and 0 are falsy modelIds, so the card default still wins.
  assert.equal(resolveCardRoute({ modelId: '' }, ctx).preferredModel, 'dm');
  assert.equal(resolveCardRoute({ modelId: 0 }, ctx).preferredModel, 'dm');
  const noDefault = fakeStore({ [APPS.GEMINI]: 'g2' }, { g2: { id: 'g2', enabled: true, protocol: PROTOCOLS.GEMINI } });
  assert.equal(resolveCardRoute({}, { store: noDefault, sourceProtocol: PROTOCOLS.GEMINI }).preferredModel, null);
});

test('重写不改写调用方的 route / metadata 对象', () => {
  const store = fakeStore({ [APPS.GEMINI]: 'g' }, { g: { id: 'g', name: 'G', enabled: true, protocol: PROTOCOLS.GEMINI } });
  const route = { modelId: 'm', metadata: { source: 'auto', traceId: 't1' }, userPinned: false };
  const snapshot = JSON.parse(JSON.stringify(route));
  const out = resolveCardRoute(route, { store, sourceProtocol: PROTOCOLS.GEMINI });
  assert.deepEqual(route, snapshot, 'input object untouched');
  out.metadata.traceId = 'mutated';
  assert.equal(route.metadata.traceId, 't1', 'metadata is a copy, not the caller reference');
  assert.notEqual(out.metadata, route.metadata);
});

test('卡片缺 id/name 时不改写只降级：poolProvider 拼出字面 undefined', () => {
  const store = fakeStore({ [APPS.GEMINI]: null }, {});
  assert.equal(resolveCardRoute({ modelId: 'm' }, { store, sourceProtocol: PROTOCOLS.GEMINI }), null, 'no active id → null');
  const anonymous = fakeStore({ [APPS.GEMINI]: 'x' }, { x: { enabled: true, protocol: PROTOCOLS.GEMINI } });
  const out = resolveCardRoute({ modelId: 'm' }, { store: anonymous, sourceProtocol: PROTOCOLS.GEMINI });
  assert.equal(out.apiPoolProvider, 'cc-switch:undefined');
  assert.equal(out.ccSwitchCardId, undefined);
  assert.equal('ccSwitchCardName' in out, true, 'the name key still exists');
  assert.equal(out.metadata.ccSwitchCardName, undefined);
});

test('KNOWN-DEFECT ctx 默认值挡不住 null：唯一会炸的入参形态，且早于 route 判空', () => {
  const route = { modelId: 'm' };
  const store = fakeStore({ [APPS.GEMINI]: 'g' }, { g: { id: 'g', enabled: true, protocol: PROTOCOLS.GEMINI } });
  assert.equal(resolveCardRoute(route, undefined), null, 'undefined ctx falls back to {}');
  assert.equal(resolveCardRoute(route, {}), null, 'an empty ctx is fine (no store)');
  // Measured: every other falsy/non-object ctx survives (property access on a
  // boxed primitive yields undefined) — only null throws.
  for (const junk of [0, '', false, 'x', [], NaN]) {
    assert.equal(resolveCardRoute(route, junk), null, `ctx=${String(junk)} is tolerated`);
  }
  assert.throws(() => resolveCardRoute(route, null), TypeError);
  // Worse: `const store = ctx.store` runs before the `!route` guard, so even a
  // missing route explodes when ctx is null.
  assert.equal(resolveCardRoute(null, undefined), null);
  assert.throws(() => resolveCardRoute(null, null), TypeError);
  assert.equal(store.calls.length, 0);
});

test('KNOWN-DEFECT appsForProtocol 用不存在的 PROTOCOLS.CODEX 做 case：codex 只认 undefined 线路', () => {
  // Measured: PROTOCOLS has no CODEX member, so `case PROTOCOLS.CODEX:` is
  // `case undefined:` — the real Codex wire ('openai_responses') has no branch.
  assert.equal(PROTOCOLS.CODEX, undefined);
  assert.deepEqual(appsForProtocol(undefined), [APPS.CODEX]);
  assert.deepEqual(appsForProtocol(PROTOCOLS.RESPONSES), []);
  const store = fakeStore({ [APPS.CODEX]: 'cx' }, { cx: { id: 'cx', name: 'Codex', enabled: true, protocol: PROTOCOLS.RESPONSES } });
  assert.notEqual(resolveCardRoute({ modelId: 'm' }, { store, sourceProtocol: undefined }), null, 'codex card only applies to a protocol-less caller');
  assert.equal(resolveCardRoute({ modelId: 'm' }, { store, sourceProtocol: PROTOCOLS.RESPONSES }), null, 'the actual Codex wire never sees its own card');
});

test('KNOWN-DEFECT 与 PROTOCOLS.RESPONSES 对称的 openai_responses 线路整体无人认领', () => {
  // Every registered protocol except RESPONSES yields at least one app.
  const covered = Object.values(PROTOCOLS).map((p) => [p, appsForProtocol(p)]);
  const empty = covered.filter(([, apps]) => apps.length === 0);
  assert.deepEqual(empty, [[PROTOCOLS.RESPONSES, []]], 'responses is the only protocol with no app');
  assert.equal(appForProtocol(PROTOCOLS.RESPONSES), null);
});
