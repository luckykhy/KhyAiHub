'use strict';

/**
 * Colocated contract tests for proxyAccess.js (ccSwitch 代理接入凭据解析层).
 * Batch 38 (C-4 test-colocated). Source file untouched.
 *
 * Isolation: the module resolves every file it reads through
 * utils/dataHome.getDataHome()/getLegacyDataHome(). Both are stubbed in
 * require.cache under the FULL resolved path for the whole file and restored
 * in `after`, so every read lands in a directory created by fs.mkdtempSync —
 * never in ~/.khy, ~/.khyquant or the repo tree. The module itself is
 * documented read-only and this suite never calls a write-capable seam.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('node:path');

const SRC = path.resolve(__dirname, '../../../..');
const DATAHOME_ID = require.resolve(path.join(SRC, 'utils/dataHome.js'));

// Mutable homes: one stub serves every case because the module re-resolves the
// data home on each call (no module-level path capture).
let HOME_DIR = null;
let LEGACY_DIR = null;

const savedDataHome = require.cache[DATAHOME_ID];
const savedEndpointEnv = process.env.KHY_PROXY_ENDPOINT;

require.cache[DATAHOME_ID] = {
  id: DATAHOME_ID,
  filename: DATAHOME_ID,
  loaded: true,
  exports: {
    getDataHome: () => HOME_DIR,
    getLegacyDataHome: () => LEGACY_DIR,
    getAppHome: () => HOME_DIR,
  },
};

const pa = require('./proxyAccess');

const tmpRoots = [];

/** Creates a fresh (home, legacy) pair under os.tmpdir() and returns the root. */
function useHomes({ withLegacy = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ccswitch-proxy-'));
  tmpRoots.push(root);
  HOME_DIR = path.join(root, 'home');
  LEGACY_DIR = path.join(root, 'legacy');
  fs.mkdirSync(HOME_DIR, { recursive: true });
  if (withLegacy) {
    fs.mkdirSync(LEGACY_DIR, { recursive: true });
  }
  // Belt and braces: prove the resolved home is inside the temp root.
  assert.ok(HOME_DIR.startsWith(root), 'stubbed home must be inside the temp root');
  return root;
}

function writeJson(dir, name, value) {
  fs.writeFileSync(
    path.join(dir, name),
    typeof value === 'string' ? value : JSON.stringify(value),
    'utf-8'
  );
}

function setEndpoint(value) {
  if (value === undefined) {
    delete process.env.KHY_PROXY_ENDPOINT;
  } else {
    process.env.KHY_PROXY_ENDPOINT = value;
  }
}

test.after(() => {
  setEndpoint(savedEndpointEnv);
  if (savedDataHome) {
    require.cache[DATAHOME_ID] = savedDataHome;
  } else {
    delete require.cache[DATAHOME_ID];
  }
  for (const root of tmpRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* scratch cleanup is best effort */
    }
  }
});

test('文件名为固定常量（runtime / auth / api_keys）', () => {
  assert.equal(pa.PROXY_RUNTIME_FILE, 'proxy_server_runtime.json');
  assert.equal(pa.PROXY_AUTH_FILE, 'proxy_server_auth.json');
  assert.equal(pa.API_KEYS_FILE, 'api_keys.json');
});

test('端点与令牌都缺失时返回可修复的具体原因，而不是空成功', () => {
  useHomes({ withLegacy: true });
  setEndpoint(undefined);
  const r = pa.resolveProxyAccess();
  assert.equal(r.ok, false);
  assert.equal(r.proxyEndpoint, '');
  assert.equal(r.proxyToken, '');
  assert.deepEqual(r.source, { endpoint: 'absent', token: 'absent' });
  // 状态透明（规则 2.2）：原因里必须带修复动作。
  assert.match(r.error, /khy gateway manage/);
  assert.match(r.error, /直连模式/);
});

test('env 端点优先于 runtime 文件，并且会剥掉尾斜杠', () => {
  useHomes();
  setEndpoint('http://env.host:1234/');
  writeJson(HOME_DIR, 'proxy_server_runtime.json', { endpoint: 'http://127.0.0.1:9100' });
  writeJson(HOME_DIR, 'proxy_server_auth.json', { authToken: 'khy-tok' });
  const r = pa.resolveProxyAccess();
  assert.equal(r.ok, true);
  assert.equal(r.proxyEndpoint, 'http://env.host:1234');
  assert.deepEqual(r.source, { endpoint: 'env', token: 'runtime-file' });
});

test('env 为纯空白视为未设置，回落到 runtime 文件', () => {
  useHomes();
  setEndpoint('   ');
  writeJson(HOME_DIR, 'proxy_server_runtime.json', { endpoint: 'http://127.0.0.1:9000' });
  writeJson(HOME_DIR, 'proxy_server_auth.json', { authToken: 'tkn' });
  const r = pa.resolveProxyAccess();
  assert.equal(r.source.endpoint, 'runtime-file');
  assert.equal(r.proxyEndpoint, 'http://127.0.0.1:9000');
});

test('runtime 新鲜度：超过 24h 的残留端点被判为 absent', () => {
  useHomes();
  setEndpoint(undefined);
  writeJson(HOME_DIR, 'proxy_server_auth.json', { authToken: 'tkn' });
  writeJson(HOME_DIR, 'proxy_server_runtime.json', {
    endpoint: 'http://127.0.0.1:9100',
    startedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
  });
  const r = pa.resolveProxyAccess();
  assert.equal(r.source.endpoint, 'absent');
  assert.equal(r.proxyEndpoint, '');
  assert.match(r.error, /proxy_server_runtime\.json/);
});

test('KNOWN-DEFECT resolveProxyAccess.startedAt：缺省/无法解析/未来的时间戳一律当新鲜（新鲜度门 fail-open）', () => {
  useHomes();
  setEndpoint(undefined);
  writeJson(HOME_DIR, 'proxy_server_auth.json', { authToken: 'tkn' });
  // Measured: all three stamps behave identically to a fresh one → ok:true.
  const cases = [
    ['缺省 startedAt', { endpoint: 'http://127.0.0.1:9100' }],
    ['不可解析 startedAt', { endpoint: 'http://127.0.0.1:9100', startedAt: 'not-a-date' }],
    ['未来 startedAt', {
      endpoint: 'http://127.0.0.1:9100',
      startedAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    }],
  ];
  for (const [label, doc] of cases) {
    writeJson(HOME_DIR, 'proxy_server_runtime.json', doc);
    const r = pa.resolveProxyAccess();
    assert.equal(r.source.endpoint, 'runtime-file', label);
    assert.equal(r.ok, true, label);
  }
  // Asymmetry: a 25h-old stamp is rejected while a MISSING stamp is honored,
  // so the leftover file of a dead gateway wins over the documented staleness.
});

test('runtime 文件损坏 / 非对象 / 空端点都降级为 absent，令牌仍独立可用', () => {
  useHomes();
  setEndpoint(undefined);
  writeJson(HOME_DIR, 'proxy_server_auth.json', { authToken: 'tkn' });
  for (const bad of ['{not json', [1, 2, 3], { endpoint: '   ' }, '"a string"', null, 42]) {
    writeJson(HOME_DIR, 'proxy_server_runtime.json', bad);
    const r = pa.resolveProxyAccess();
    assert.equal(r.source.endpoint, 'absent', JSON.stringify(bad));
    assert.equal(r.proxyToken, 'tkn', JSON.stringify(bad));
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
});

test('令牌独立解析：authToken 缺失/空/非字符串的三种形态', () => {
  useHomes();
  setEndpoint('http://x:1');
  writeJson(HOME_DIR, 'proxy_server_runtime.json', { endpoint: 'http://y:2' });
  writeJson(HOME_DIR, 'proxy_server_auth.json', {});
  assert.deepEqual(pa.resolveProxyAccess(), {
    ok: false,
    proxyEndpoint: 'http://x:1',
    proxyToken: '',
    source: { endpoint: 'env', token: 'absent' },
    error:
      '网关令牌不可用：proxy_server_auth.json 缺失或无 authToken。' +
      '修复动作: 启动一次 khy 网关以生成令牌（khy gateway manage），或改用直连模式（direct）',
  });
  // Non-string token is String()-coerced rather than rejected.
  writeJson(HOME_DIR, 'proxy_server_auth.json', { authToken: 12345 });
  assert.equal(pa.resolveProxyAccess().proxyToken, '12345');
  // Corrupt auth file is indistinguishable from a missing one.
  writeJson(HOME_DIR, 'proxy_server_auth.json', 'oops[');
  assert.equal(pa.resolveProxyAccess().source.token, 'absent');
});

test('数据家查找顺序：主目录优先，主目录缺件时回落 legacy，两处都缺则 absent', () => {
  setEndpoint(undefined);
  useHomes({ withLegacy: true });
  writeJson(LEGACY_DIR, 'proxy_server_runtime.json', { endpoint: 'http://127.0.0.1:9101' });
  writeJson(LEGACY_DIR, 'proxy_server_auth.json', { authToken: 'legacy-token' });
  let r = pa.resolveProxyAccess();
  assert.equal(r.proxyEndpoint, 'http://127.0.0.1:9101');
  assert.equal(r.proxyToken, 'legacy-token');
  // Primary now has the runtime file only → endpoint from primary, token still
  // from legacy (per-file fallback, not per-home all-or-nothing).
  writeJson(HOME_DIR, 'proxy_server_runtime.json', { endpoint: 'http://127.0.0.1:9000' });
  r = pa.resolveProxyAccess();
  assert.equal(r.proxyEndpoint, 'http://127.0.0.1:9000');
  assert.equal(r.proxyToken, 'legacy-token');
  assert.deepEqual(pa.__test__._findInDataHome('proxy_server_runtime.json'), path.join(HOME_DIR, 'proxy_server_runtime.json'));
  assert.equal(pa.__test__._findInDataHome('no_such_file.json'), null);
});

test('poolKey 解析：池内 keyId 命中优先，未命中回退卡片名 slug', () => {
  useHomes({ withLegacy: true });
  const keyId = pa.__test__._keyIdFor('deepseek', 'sk-real');
  assert.match(keyId, /^[0-9a-f]{12}$/);
  writeJson(HOME_DIR, 'api_keys.json', {
    deepseek: [{ key: 'sk-real', label: 'x' }],
    broken: 'not-an-array',
    anthropic: [{ key: 42 }, null, { key: 'other' }],
  });
  assert.deepEqual(pa.resolvePoolKeyFromCard({ keyId, name: 'Whatever' }, { raw: true }), {
    poolKey: 'deepseek',
    source: 'pool-scan',
  });
  // Unknown keyId → name fallback (slug), audit source flips.
  assert.deepEqual(pa.resolvePoolKeyFromCard({ keyId: 'deadbeefdead', name: 'My Provider!' }, { raw: true }), {
    poolKey: 'my_provider',
    source: 'name-fallback',
  });
  // Non-string keyId is ignored entirely (no pool read).
  assert.deepEqual(pa.resolvePoolKeyFromCard({ keyId: 99, name: 'A B' }, { raw: true }), {
    poolKey: 'a_b',
    source: 'name-fallback',
  });
  assert.equal(pa.resolvePoolKeyFromCard({ keyId }), 'deepseek');
});

test('poolKey 敌意输入：null 卡片 / 无池文件 / 池文件损坏都返回空串而不是抛', () => {
  useHomes();
  assert.equal(pa.resolvePoolKeyFromCard(null), '');
  assert.deepEqual(pa.resolvePoolKeyFromCard(null, { raw: true }), { poolKey: '', source: 'name-fallback' });
  writeJson(HOME_DIR, 'api_keys.json', '{oops');
  assert.equal(pa.resolvePoolKeyFromCard({ keyId: 'aaaaaaaaaaaa', name: null }), '');
  writeJson(HOME_DIR, 'api_keys.json', [1, 2]);
  // Numeric names survive the slug (digits are legal pool-key chars).
  assert.equal(pa.resolvePoolKeyFromCard({ keyId: 'aaaaaaaaaaaa', name: 123 }), '123');
});

test('slug 归一化：大小写、空格、非 ASCII 与首尾分隔符', () => {
  const s = pa.__test__._slug;
  assert.deepEqual(
    ['  DeepSeek API ', '中文名称', '', null, undefined, '___a___b___', 'x1'].map(s),
    ['deepseek_api', '', '', '', '', 'a_b', 'x1']
  );
});

test('buildProxyCard 换端点换模型名且不改入参对象', () => {
  const card = { id: 'c_1', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat', keyId: 'k' };
  const out = pa.buildProxyCard(card, { proxyEndpoint: 'http://127.0.0.1:9100/', poolKey: 'deepseek' });
  assert.deepEqual(out, {
    id: 'c_1',
    name: 'DeepSeek',
    baseUrl: 'http://127.0.0.1:9100',
    defaultModel: 'api:deepseek:deepseek-chat',
    keyId: 'k',
  });
  assert.notEqual(out, card);
  assert.equal(card.baseUrl, 'https://api.deepseek.com/v1', '入参未被改写');
  assert.equal(card.defaultModel, 'deepseek-chat', '入参未被改写');
  // input.model wins over card.defaultModel; empty poolKey leaves model alone.
  assert.equal(pa.buildProxyCard(card, { proxyEndpoint: 'http://p:1', poolKey: '', model: 'm' }).defaultModel, 'm');
  assert.equal(pa.buildProxyCard(card, {}).baseUrl, '');
  assert.equal(pa.buildProxyCard(card, { proxyEndpoint: 'http://p:1' }).defaultModel, 'deepseek-chat', '无 poolKey → 模型名保持原样，不拼三段');
});

test('KNOWN-DEFECT buildProxyCard(card=null)：契约只说「不修改入参」，实测直接抛 TypeError', () => {
  // Measured: String(input.model || card.defaultModel) dereferences null.
  assert.throws(() => pa.buildProxyCard(null), TypeError);
  assert.throws(() => pa.buildProxyCard(undefined), TypeError);
  // A card without defaultModel + no input.model is fine (yields '').
  assert.equal(pa.buildProxyCard({}, { proxyEndpoint: 'http://p:1' }).defaultModel, '');
});

test('可路由模型名 _routableModelName：三段式幂等透传，缺任一段则不拼', () => {
  const f = pa.__test__._routableModelName;
  assert.equal(f('dp', 'api:x:y'), 'api:x:y', '已是三段 → 原样透传，不二次拼接');
  assert.equal(f('dp', 'api:x:y:z'), 'api:x:y:z', '四段也命中透传（正则只要求第三段非空）');
  assert.equal(f('', 'm'), 'm');
  assert.equal(f('p', ''), '');
  assert.equal(f('p', '  '), '');
  assert.equal(f('p', 'a:b'), 'api:p:a:b', '两段模型名会被补成三段');
  assert.equal(f(null, null), '');
});
