'use strict';

/**
 * apiHandlers.js contract tests — the /api/cc-switch HTTP surface: auth gating,
 * request-body coercion into store calls, per-app status projection, the switch
 * flow through appWriters, and the dispatcher's routing/error table.
 *
 * Real user state is never touched: ./store, ./appWriters and ./usageScan are
 * replaced in require.cache (keyed by their fully resolved paths) with thin
 * delegating fakes BEFORE ./apiHandlers is first required, and the entries are
 * restored in an `after` hook.
 */

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');

const PATHS = {
  store: require.resolve('./store'),
  appWriters: require.resolve('./appWriters'),
  usageScan: require.resolve('./usageScan'),
  self: require.resolve('./apiHandlers'),
};
const SAVED = {
  store: require.cache[PATHS.store],
  appWriters: require.cache[PATHS.appWriters],
  usageScan: require.cache[PATHS.usageScan],
  self: require.cache[PATHS.self],
};

// Behaviour for the current case; every test reassigns the buckets it needs.
const state = { store: {}, appWriters: {}, usageScan: {} };

function fakeModule(filename, exports) {
  return { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}

const storeDelegating = {
  listCards: (...a) => state.store.listCards(...a),
  addCard: (...a) => state.store.addCard(...a),
  updateCard: (...a) => state.store.updateCard(...a),
  removeCard: (...a) => state.store.removeCard(...a),
  getCard: (...a) => state.store.getCard(...a),
  getActiveCardId: (...a) => state.store.getActiveCardId(...a),
  setActiveCard: (...a) => state.store.setActiveCard(...a),
  getAppConfig: (...a) => state.store.getAppConfig(...a),
};
const appWritersDelegating = {
  preflightCardForApp: (...a) => state.appWriters.preflightCardForApp(...a),
  applyCardToApp: (...a) => state.appWriters.applyCardToApp(...a),
};
const usageScanDelegating = {
  scanSessions: (...a) => state.usageScan.scanSessions(...a),
};

require.cache[PATHS.store] = fakeModule(PATHS.store, storeDelegating);
require.cache[PATHS.appWriters] = fakeModule(PATHS.appWriters, appWritersDelegating);
require.cache[PATHS.usageScan] = fakeModule(PATHS.usageScan, usageScanDelegating);
delete require.cache[PATHS.self];

const api = require('./apiHandlers');

after(() => {
  delete require.cache[PATHS.self];
  for (const key of ['store', 'appWriters', 'usageScan']) {
    if (SAVED[key]) require.cache[PATHS[key]] = SAVED[key];
    else delete require.cache[PATHS[key]];
  }
});

// ── Injected HTTP deps (recorders) ─────────────────────────────────────────
let out = [];
api.setCcSwitchHttpDeps({
  sendJson: (res, code, payload) => out.push({ kind: 'json', code, payload }),
  sendError: (res, code, message) => out.push({ kind: 'error', code, message }),
  parseBody: async (req) => {
    if (req.__bodyThrows) throw new Error('body exploded');
    return req.__body;
  },
  authenticateRequest: async (req) => (req.__auth === undefined ? null : req.__auth),
});

function reset(storeOverrides = {}, appOverrides = {}, scanOverrides = {}) {
  out = [];
  state.store = {
    listCards: () => [],
    addCard: () => ({ success: true, card: { id: 'c_new', name: 'n' } }),
    updateCard: () => ({ success: true, card: { id: 'c_up' } }),
    removeCard: () => ({ success: true }),
    getCard: () => null,
    getActiveCardId: () => null,
    setActiveCard: () => {},
    getAppConfig: () => ({ scanEnabled: true }),
    ...storeOverrides,
  };
  state.appWriters = {
    preflightCardForApp: () => ({ ok: true }),
    applyCardToApp: async () => ({ success: true }),
    ...appOverrides,
  };
  state.usageScan = {
    scanSessions: async () => ({ scanned: 0 }),
    ...scanOverrides,
  };
}

const req = (extra = {}) => ({ method: 'GET', authContext: { ok: true }, ...extra });
const dispatch = (pathname, extra = {}) => api.handleCcSwitchApi(req(extra), { __res: true }, pathname);
const last = () => out[out.length - 1];
const wire = () => out.map((o) => [o.kind, o.code, o.message === undefined ? o.payload : o.message]);

test('导出面只暴露 setCcSwitchHttpDeps / handleCcSwitchApi / __test__ 三个键', () => {
  assert.deepEqual(Object.keys(api).sort(), ['__test__', 'handleCcSwitchApi', 'setCcSwitchHttpDeps']);
  assert.deepEqual(Object.keys(api.__test__), ['_extractId']);
});

test('_extractId：取前缀后第一段，缺前缀或空段返回 null', () => {
  const { _extractId } = api.__test__;
  assert.equal(_extractId('/api/cc-switch/cards/c_42', '/cards/'), 'c_42');
  assert.equal(_extractId('/api/cc-switch/cards/c_42/extra', '/cards/'), 'c_42');
  assert.equal(_extractId('/api/cc-switch/cards/', '/cards/'), null, 'empty segment → null');
  assert.equal(_extractId('/api/cc-switch/cards', '/cards/'), null, 'prefix missing → null');
  assert.equal(_extractId('', '/cards/'), null);
  // Measured: indexOf (not lastIndexOf) wins, so an earlier segment shadows the id.
  assert.equal(_extractId('/cards/a/cards/b', '/cards/'), 'a');
});

test('KNOWN-DEFECT _extractId 不解码也不截断 query，脏 id 原样进入 store 调用', async () => {
  const { _extractId } = api.__test__;
  assert.equal(_extractId('/api/cc-switch/cards/c%5F1?dry=1', '/cards/'), 'c%5F1?dry=1');
  assert.equal(_extractId('/api/cc-switch/cards/c#frag', '/cards/'), 'c#frag');
  assert.throws(() => _extractId(undefined, '/cards/'), TypeError, 'non-string pathname is not guarded');

  const ids = [];
  reset({ updateCard: (id) => { ids.push(id); return { success: true, card: { id } }; } });
  await dispatch('/api/cc-switch/cards/c%20y?z=1', { method: 'PUT', __body: {} });
  await dispatch('/api/cc-switch/cards/..%2F..%2Fetc', { method: 'DELETE' });
  assert.deepEqual(ids, ['c%20y?z=1']);
  assert.deepEqual(out[0], { kind: 'json', code: 200, payload: { success: true, data: { id: 'c%20y?z=1' } } });
});

test('KNOWN-DEFECT 鉴权闸门：401 走 sendJson 而其余错误走 sendError，两者在 host 侧不同路', async () => {
  reset();
  const paths = [
    ['/api/cc-switch/cards', 'GET'],
    ['/api/cc-switch/cards', 'POST'],
    ['/api/cc-switch/cards/x', 'PUT'],
    ['/api/cc-switch/cards/x', 'DELETE'],
    ['/api/cc-switch/status', 'GET'],
    ['/api/cc-switch/use', 'POST'],
    ['/api/cc-switch/scan', 'POST'],
  ];
  for (const [pathname, method] of paths) {
    await dispatch(pathname, { method, authContext: null, __auth: null });
  }
  assert.deepEqual(
    wire(),
    paths.map(() => ['json', 401, { success: false, message: 'Authentication required' }]),
    'each rejected request answered exactly once, and as a sendJson (not sendError)'
  );
  // Asymmetry: a host that renders failures only through sendError would answer
  // an empty body here, while 400/404/500 all go through sendError. And the
  // dispatcher's own 404 fallback never authenticates at all.
  await dispatch('/api/cc-switch/nope', { method: 'GET', authContext: null, __auth: null });
  assert.deepEqual(last(), { kind: 'error', code: 404, message: '未知的 cc-switch 端点: /api/cc-switch/nope' }, 'unauthenticated callers still get the routing answer');
});

test('authenticateRequest 拒绝时它的 error 成为 401 文案；通过则正常执行 handler', async () => {
  reset({ listCards: () => [{ id: 'a', name: 'A' }] });
  await dispatch('/api/cc-switch/cards', { authContext: null, __auth: { ok: false, error: '令牌已过期' } });
  assert.deepEqual(last(), { kind: 'json', code: 401, payload: { success: false, message: '令牌已过期' } });
  await dispatch('/api/cc-switch/cards', { authContext: null, __auth: { ok: true } });
  assert.equal(last().code, 200);
  assert.equal(out.length, 2, 'no extra response was emitted');
  // authContext wins even when it denies and authenticateRequest would allow.
  await dispatch('/api/cc-switch/cards', { authContext: { ok: false, error: '本地上下文拒绝' }, __auth: { ok: true } });
  assert.deepEqual(last(), { kind: 'json', code: 401, payload: { success: false, message: '本地上下文拒绝' } });
  // Measured: authContext:{ok:false} without an error string falls back to the
  // generic prompt, and a truthy-but-not-ok-shaped object is still a denial.
  await dispatch('/api/cc-switch/cards', { authContext: { ok: 0 } });
  assert.deepEqual(last().payload, { success: false, message: 'Authentication required' });
});

test('GET /cards：投影固定字段，hasKey 由 keyId 真值决定，原始密钥绝不外泄', async () => {
  const cards = [
    { id: 'a', name: 'A', baseUrl: 'https://a', protocol: 'openai', keyId: 'k1', models: ['m'], defaultModel: 'm', apps: ['codex'], enabled: true, requiresOpenaiAuth: false, key: 'SECRET', secretValue: 'NOPE' },
    { id: 'b', name: 'B', keyId: '', enabled: 0 },
  ];
  reset({ listCards: () => cards });
  await dispatch('/api/cc-switch/cards');
  assert.deepEqual(last(), {
    kind: 'json',
    code: 200,
    payload: {
      success: true,
      data: [
        {
          id: 'a', name: 'A', baseUrl: 'https://a', protocol: 'openai', wireApi: undefined,
          models: ['m'], defaultModel: 'm', apps: ['codex'], enabled: true, hasKey: true, requiresOpenaiAuth: false,
        },
        {
          id: 'b', name: 'B', baseUrl: undefined, protocol: undefined, wireApi: undefined,
          models: undefined, defaultModel: undefined, apps: undefined, enabled: 0, hasKey: false, requiresOpenaiAuth: undefined,
        },
      ],
    },
  });
  // Measured asymmetry: hasKey is `!!keyId` but enabled is passed through raw.
  assert.equal(last().payload.data[1].enabled, 0, 'a non-boolean enabled leaks the store value');
  const serialized = JSON.stringify(out);
  assert.equal(serialized.includes('SECRET'), false, 'raw key never serialized');
  assert.equal(serialized.includes('NOPE'), false, 'unknown card fields are not passed through');
  assert.equal(serialized.includes('keyId'), false, 'the keyId itself is not exposed');
});

test('POST /cards：入参 coercion 矩阵——默认协议/非数组模型/非数组应用/布尔位', async () => {
  let captured = null;
  reset({ addCard: (arg) => { captured = arg; return { success: true, card: { id: 'c9', name: 'Deep' } }; } });
  await dispatch('/api/cc-switch/cards', {
    method: 'POST',
    __body: { name: 'Deep', baseUrl: 'https://d', key: 12345, models: 'not-an-array', apps: { codex: true }, requiresOpenaiAuth: 'yes', protocol: 'anthropic', wireApi: 'responses', defaultModel: 'dm', apps2: 1 },
  });
  assert.deepEqual(captured, {
    name: 'Deep',
    baseUrl: 'https://d',
    key: '12345',
    protocol: 'anthropic',
    wireApi: 'responses',
    models: [],
    defaultModel: 'dm',
    apps: undefined,
    requiresOpenaiAuth: true,
  });
  assert.deepEqual(last(), { kind: 'json', code: 200, payload: { success: true, data: { id: 'c9', name: 'Deep' } } });
});

test('POST /cards：body 为 null / 假值时按全默认调用；空 apps 数组原样透传', async () => {
  const calls = [];
  reset({ addCard: (arg) => { calls.push(arg); return { success: true, card: { id: 'x', name: 'n' } }; } });
  await dispatch('/api/cc-switch/cards', { method: 'POST', __body: null });
  await dispatch('/api/cc-switch/cards', { method: 'POST', __body: { apps: [], models: [], protocol: '', key: '', defaultModel: 0 } });
  assert.deepEqual(calls[0], {
    // Measured: `body && body.name` on a null body yields null, not undefined.
    name: null, baseUrl: null, key: undefined, protocol: 'openai', wireApi: null,
    models: [], defaultModel: '', apps: undefined, requiresOpenaiAuth: false,
  });
  // Measured: '' protocol falls back to openai via `||`, and key '' is dropped.
  assert.equal(calls[1].protocol, 'openai');
  assert.equal(calls[1].key, undefined);
  assert.equal(calls[1].defaultModel, '', 'defaultModel 0 → "" through the || fallback');
  assert.deepEqual(calls[1].apps, [], 'an empty apps array is still an array');
});

test('POST /cards：store 拒绝时报 400 + 原样错误文案，且不再发 200', async () => {
  reset({ addCard: () => ({ success: false, error: '名称不能为空' }) });
  await dispatch('/api/cc-switch/cards', { method: 'POST', __body: { name: '' } });
  assert.deepEqual(out, [{ kind: 'error', code: 400, message: '名称不能为空' }]);
});

test('PUT /cards/:id：undefined 之外的字段才进 patch，enabled/requiresOpenaiAuth 走 !! 强转', async () => {
  let captured = null;
  reset({ updateCard: (id, patch) => { captured = { id, patch }; return { success: true, card: { id: 'c_up' } }; } });
  await dispatch('/api/cc-switch/cards/abc', {
    method: 'PUT',
    __body: {
      name: 'N', baseUrl: undefined, protocol: null, models: 'no', apps: ['codex'],
      enabled: 'truthy-string', requiresOpenaiAuth: 0, defaultModel: '', wireApi: false,
    },
  });
  assert.equal(captured.id, 'abc');
  assert.deepEqual(captured.patch, {
    name: 'N',
    protocol: null,
    wireApi: false,
    defaultModel: '',
    apps: ['codex'],
    enabled: true,
    requiresOpenaiAuth: false,
  });
  assert.equal('models' in captured.patch, false, 'non-array models are dropped, not nulled');
  assert.equal('baseUrl' in captured.patch, false, 'undefined is not a patchable value');
  assert.deepEqual(last(), { kind: 'json', code: 200, payload: { success: true, data: { id: 'c_up' } } });
});

test('KNOWN-DEFECT PUT /cards/:id：key 只在真值时进 patch，空串清不掉密钥（与 name 的语义不对称）', async () => {
  const patches = [];
  reset({ updateCard: (id, patch) => { patches.push(patch); return { success: true, card: { id } }; } });
  await dispatch('/api/cc-switch/cards/a', { method: 'PUT', __body: { key: '' } });
  await dispatch('/api/cc-switch/cards/a', { method: 'PUT', __body: { key: 'new' } });
  await dispatch('/api/cc-switch/cards/a', { method: 'PUT', __body: { name: '' } });
  assert.equal('key' in patches[0], false, 'key:"" is silently ignored');
  assert.equal(patches[1].key, 'new');
  assert.equal(patches[2].name, '', 'an empty name IS forwarded for update');
});

test('PUT/DELETE 缺卡片 ID 报 400；store 失败报 400 并带上 store 文案', async () => {
  reset({ updateCard: () => ({ success: false, error: '卡片不存在' }), removeCard: () => ({ success: false, error: '仍被应用引用' }) });
  await dispatch('/api/cc-switch/cards/', { method: 'PUT', __body: {} });
  await dispatch('/api/cc-switch/cards/', { method: 'DELETE' });
  await dispatch('/api/cc-switch/cards/x', { method: 'PUT', __body: {} });
  await dispatch('/api/cc-switch/cards/x', { method: 'DELETE' });
  assert.deepEqual(wire(), [
    ['error', 400, '缺少卡片 ID'],
    ['error', 400, '缺少卡片 ID'],
    ['error', 400, '卡片不存在'],
    ['error', 400, '仍被应用引用'],
  ]);
});

test('DELETE /cards/:id 成功只回 {success:true}，不带 data', async () => {
  let removed = null;
  reset({ removeCard: (id) => { removed = id; return { success: true }; } });
  await dispatch('/api/cc-switch/cards/del1', { method: 'DELETE' });
  assert.equal(removed, 'del1');
  assert.deepEqual(last(), { kind: 'json', code: 200, payload: { success: true } });
});

test('KNOWN-DEFECT 请求体解析失败：POST/PUT 报 400，scan 却把它当可选体继续执行', async () => {
  const scanArgs = [];
  reset(
    { addCard: () => ({ success: true, card: { id: 'x', name: 'n' } }) },
    {},
    { scanSessions: async (arg) => { scanArgs.push(arg); return { scanned: 3 }; } }
  );
  await dispatch('/api/cc-switch/cards', { method: 'POST', __bodyThrows: true });
  await dispatch('/api/cc-switch/cards/x', { method: 'PUT', __bodyThrows: true });
  await dispatch('/api/cc-switch/scan', { method: 'POST', __bodyThrows: true });
  assert.deepEqual(wire(), [
    ['error', 400, '请求体无效'],
    ['error', 400, '请求体无效'],
    ['json', 200, { success: true, data: { scanned: 3 } }],
  ]);
  assert.deepEqual(scanArgs, [{}], 'scan ran with no apps filter instead of failing the request');
});

test('GET /status：逐应用给出 label/activeCardId/activeCardName/scanEnabled 四元组', async () => {
  reset({
    listCards: () => [{ id: 'a1', name: '卡一' }],
    getActiveCardId: (app) => (app === 'codex' ? 'a1' : null),
    getAppConfig: (app) => ({ scanEnabled: app !== 'gemini' }),
  });
  await dispatch('/api/cc-switch/status');
  const rows = last().payload.data;
  assert.equal(rows.length, 12, 'one row per APPS entry');
  assert.deepEqual(rows[0], { app: 'claude-code', label: 'Claude Code', activeCardId: null, activeCardName: null, scanEnabled: true });
  assert.deepEqual(rows[1], { app: 'codex', label: 'Codex CLI', activeCardId: 'a1', activeCardName: '卡一', scanEnabled: true });
  assert.equal(rows.find((r) => r.app === 'gemini').scanEnabled, false);
  assert.deepEqual(new Set(rows.map((r) => r.app)).size, 12);
  assert.deepEqual(new Set(rows.map((r) => r.label)).size, 12, 'every label resolved from APP_LABELS');
});

test('KNOWN-DEFECT GET /status：active id 指向已删除卡片时仍上报 id，只把名字置空', async () => {
  reset({
    listCards: () => [],
    getActiveCardId: () => 'ghost-card',
    getAppConfig: () => ({ scanEnabled: true }),
  });
  await dispatch('/api/cc-switch/status');
  const rows = last().payload.data;
  assert.equal(rows.length, 12);
  assert.equal(rows[0].activeCardId, 'ghost-card', 'a dangling pointer is surfaced as-is');
  assert.equal(rows[0].activeCardName, null);
  // Asymmetry: POST /use answers 404 for the same dangling id (see next case).
});

test('POST /use：cardId/app 必填、卡片不存在 404、预检失败 400 带 reason', async () => {
  reset({ getCard: (id) => (id === 'good' ? { id: 'good', name: 'G' } : null) });
  await dispatch('/api/cc-switch/use', { method: 'POST', __body: { app: 'codex' } });
  await dispatch('/api/cc-switch/use', { method: 'POST', __body: { cardId: 'good' } });
  await dispatch('/api/cc-switch/use', { method: 'POST', __body: {} });
  await dispatch('/api/cc-switch/use', { method: 'POST', __body: null });
  await dispatch('/api/cc-switch/use', { method: 'POST', __body: { cardId: 'ghost', app: 'codex' } });
  assert.deepEqual(wire(), [
    ['error', 400, 'cardId 与 app 均为必填'],
    ['error', 400, 'cardId 与 app 均为必填'],
    ['error', 400, 'cardId 与 app 均为必填'],
    ['error', 400, 'cardId 与 app 均为必填'],
    ['error', 404, '卡片不存在: ghost'],
  ]);
  // body 假值也走必填分支（body && body.cardId）。
});

test('POST /use：预检不过直接 400 且绝不落 active 卡', async () => {
  const setActive = [];
  reset(
    { getCard: () => ({ id: 'good', name: 'G' }), setActiveCard: (app, id) => setActive.push([app, id]) },
    { preflightCardForApp: (card, app, o) => ({ ok: false, reason: `该卡片不支持 ${app}/${o.mode}` }) }
  );
  await dispatch('/api/cc-switch/use', { method: 'POST', __body: { cardId: 'good', app: 'codex' } });
  assert.deepEqual(last(), { kind: 'error', code: 400, message: '该卡片不支持 codex/proxy' });
  assert.equal(setActive.length, 0);
});

test('POST /use：mode 只有字面 "direct" 生效，其余全部默认 proxy', async () => {
  const modes = [];
  const setActive = [];
  reset(
    { getCard: () => ({ id: 'good', name: 'G' }), setActiveCard: (app, id) => setActive.push([app, id]) },
    {
      preflightCardForApp: (card, app, o) => {
        modes.push(o.mode);
        return { ok: true };
      },
      applyCardToApp: async (card, app, o) => {
        assert.equal(typeof o.store.listCards, 'function', 'the store module is handed to the writer');
        return { success: true };
      },
    }
  );
  for (const mode of ['direct', 'proxy', 'DIRECT', undefined, '', 0, 'proxyish']) {
    await dispatch('/api/cc-switch/use', { method: 'POST', __body: { cardId: 'good', app: 'codex', mode } });
  }
  assert.deepEqual(modes, ['direct', 'proxy', 'proxy', 'proxy', 'proxy', 'proxy', 'proxy']);
  assert.deepEqual(out.map((o) => o.payload.data.mode), ['direct', 'proxy', 'proxy', 'proxy', 'proxy', 'proxy', 'proxy']);
  assert.deepEqual(out[0].payload, { success: true, data: { app: 'codex', cardId: 'good', cardName: 'G', mode: 'direct' } });
  assert.deepEqual(setActive, Array(7).fill(['codex', 'good']), 'every accepted switch recorded the active card');
});

test('POST /use：切换失败报 500 且文案带应用标签，不写 active 卡', async () => {
  const setActive = [];
  reset(
    { getCard: () => ({ id: 'good', name: 'G' }), setActiveCard: () => setActive.push(1) },
    { applyCardToApp: async () => ({ success: false, error: '写入 settings.json 失败' }) }
  );
  await dispatch('/api/cc-switch/use', { method: 'POST', __body: { cardId: 'good', app: 'codex' } });
  assert.deepEqual(last(), { kind: 'error', code: 500, message: 'Codex CLI 切换失败: 写入 settings.json 失败' });
  assert.equal(setActive.length, 0, 'a failed switch never records the active card');
  // Unknown app id → label falls back to the raw id.
  await dispatch('/api/cc-switch/use', { method: 'POST', __body: { cardId: 'good', app: 'brand-new-app' } });
  assert.match(last().message, /^brand-new-app 切换失败: /);
});

test('POST /scan：apps 只在非空数组时透传，否则传空对象；scan 抛错降级 500', async () => {
  const args = [];
  reset({}, {}, {
    scanSessions: async (arg) => {
      args.push(arg);
      if (args.length === 3) throw new Error('索引损坏');
      return { scanned: args.length };
    },
  });
  await dispatch('/api/cc-switch/scan', { method: 'POST', __body: { apps: ['codex'] } });
  await dispatch('/api/cc-switch/scan', { method: 'POST', __body: { apps: [] } });
  await dispatch('/api/cc-switch/scan', { method: 'POST', __body: { apps: 'codex' } });
  await dispatch('/api/cc-switch/scan', { method: 'POST', __body: {} });
  assert.deepEqual(args, [{ apps: ['codex'] }, {}, {}, {}]);
  assert.deepEqual(wire(), [
    ['json', 200, { success: true, data: { scanned: 1 } }],
    ['json', 200, { success: true, data: { scanned: 2 } }],
    ['error', 500, '扫描失败: 索引损坏'],
    ['json', 200, { success: true, data: { scanned: 4 } }],
  ]);
});

test('分派表：方法/路径组合决定 handler，未命中一律 404 并回显路径', async () => {
  const calls = [];
  reset(
    {
      listCards: () => { calls.push('list'); return []; },
      addCard: () => { calls.push('create'); return { success: true, card: { id: 'z', name: 'z' } }; },
      updateCard: () => { calls.push('update'); return { success: true, card: { id: 'z' } }; },
      removeCard: () => { calls.push('delete'); return { success: true }; },
      getCard: () => ({ id: 'z', name: 'z' }),
    },
    { preflightCardForApp: () => { calls.push('preflight'); return { ok: true }; }, applyCardToApp: async () => { calls.push('apply'); return { success: true }; } },
    { scanSessions: async () => { calls.push('scan'); return {}; } }
  );
  const seq = [
    ['/api/cc-switch/cards', 'GET'],
    ['/api/cc-switch/cards', 'POST'],
    ['/api/cc-switch/cards/zz', 'PUT'],
    ['/api/cc-switch/cards/zz', 'DELETE'],
    ['/api/cc-switch/status', 'GET'],
    ['/api/cc-switch/use', 'POST'],
    ['/api/cc-switch/scan', 'POST'],
    ['/api/cc-switch/cards', 'PATCH'],
    ['/api/cc-switch/cards/', 'GET'],
    ['/api/cc-switch/nope', 'GET'],
    ['/api/cc-switch/use', 'GET'],
  ];
  for (const [pathname, method] of seq) {
    await dispatch(pathname, { method, __body: { cardId: 'z', app: 'codex' } });
  }
  assert.deepEqual(calls, ['list', 'create', 'update', 'delete', 'list', 'preflight', 'apply', 'scan']);
  assert.deepEqual(wire().slice(-4), [
    ['error', 404, '未知的 cc-switch 端点: /api/cc-switch/cards'],
    ['error', 404, '未知的 cc-switch 端点: /api/cc-switch/cards/'],
    ['error', 404, '未知的 cc-switch 端点: /api/cc-switch/nope'],
    ['error', 404, '未知的 cc-switch 端点: /api/cc-switch/use'],
  ]);
  assert.equal(out.length, seq.length, 'every dispatch answered exactly once');
});

test('KNOWN-DEFECT 分派器把任何异常（含非字符串 pathname）吞成 500 文案，调用方拿不到堆栈', async () => {
  reset();
  await api.handleCcSwitchApi(req({ method: 'GET' }), {}, undefined);
  await api.handleCcSwitchApi(req({ method: 'GET' }), {}, 123);
  await api.handleCcSwitchApi(req({ method: 'GET', authContext: { ok: true } }), {}, '/api/cc-switch/status');
  assert.deepEqual(wire().slice(0, 2), [
    ['error', 500, "cc-switch API 错误: Cannot read properties of undefined (reading 'startsWith')"],
    ['error', 500, 'cc-switch API 错误: pathname.startsWith is not a function'],
  ]);
  // The third one proves the swallow also hides store contract violations:
  assert.equal(last().kind, 'json', 'a well-formed request still answers 200 after the failures');
});

test('KNOWN-DEFECT GET /status 遇到不合规的 getAppConfig 返回会被整批降级成 500', async () => {
  reset({
    listCards: () => [{ id: 'a', name: 'A' }],
    getActiveCardId: () => null,
    getAppConfig: () => null,
  });
  await dispatch('/api/cc-switch/status');
  assert.deepEqual(wire(), [
    ['error', 500, "cc-switch API 错误: Cannot read properties of null (reading 'scanEnabled')"],
  ]);
});

test('KNOWN-DEFECT setCcSwitchHttpDeps 静默忽略非函数依赖，且没有任何重置入口', async () => {
  reset();
  assert.equal(api.setCcSwitchHttpDeps(), undefined, 'no-arg call is accepted and does nothing');
  assert.equal(api.setCcSwitchHttpDeps({ sendJson: 'not-a-function', sendError: 42, parseBody: null }), undefined);
  assert.equal(api.setCcSwitchHttpDeps({ typoDep: () => {} }), undefined, 'a typo dep name is ignored silently');
  // The originally injected recorder is still in force: no slot was nulled, but
  // injection never validated anything either.
  await dispatch('/api/cc-switch/cards');
  assert.deepEqual(wire(), [['json', 200, { success: true, data: [] }]]);
});

test('KNOWN-DEFECT store 报 success:true 却不带 card 时，handler 自己抛 TypeError 被降级成 500', async () => {
  reset({ addCard: () => ({ success: true }) });
  await dispatch('/api/cc-switch/cards', { method: 'POST', __body: { name: 'n' } });
  assert.deepEqual(wire(), [
    ['error', 500, "cc-switch API 错误: Cannot read properties of undefined (reading 'id')"],
  ]);
});
