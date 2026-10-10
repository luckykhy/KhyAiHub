'use strict';

/**
 * Colocated contract tests for store.js (ccSwitch 卡片登记册 / 持久层).
 * Batch 38 (C-4 test-colocated). Source file untouched.
 *
 * Isolation: store.js captures DATA_DIR = getDataHome() AT REQUIRE TIME and
 * writes <dataHome>/cc_switch.json through the real utils/atomicWriteJson leaf,
 * plus it reads through the real configGuard (which may create the default doc
 * and append heal audits). Every one of those seams is redirected into a
 * fs.mkdtempSync(os.tmpdir()) tree:
 *   - src/utils/dataHome.js is stubbed in require.cache (full resolved path,
 *     extension included) BEFORE the module is ever required; each case drops
 *     the store.js cache entry and re-requires so the load-time DATA_DIR
 *     rebinds to the temp dir.
 *   - src/services/apiKeyPool.js is stubbed by resolved path — no real
 *     api_keys.json is created or mutated.
 *   - src/services/healEscalationService.js is stubbed by resolved path (the
 *     double-corrupt branch fire-and-forgets into it); its calls are counted.
 *   - src/utils/healAudit resolves its log file via dataHome.getAppHome(), also
 *     stubbed to the temp tree.
 * Restored in `after`; ~/.khyquant, ~/.khy and the repo tree are never touched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('node:path');

const SRC = path.resolve(__dirname, '../../../..');
const STORE_ID = require.resolve(path.join(__dirname, 'store.js'));
const DATAHOME_ID = require.resolve(path.join(SRC, 'utils/dataHome.js'));
const POOL_ID = require.resolve(path.join(SRC, 'services/apiKeyPool.js'));
const ESCALATION_ID = require.resolve(path.join(SRC, 'services/healEscalationService.js'));

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ccswitch-store-'));
const HOME = path.join(ROOT, 'home');
const LEGACY = path.join(ROOT, 'legacy');
const APP_HOME = path.join(ROOT, 'app');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(LEGACY, { recursive: true });
fs.mkdirSync(APP_HOME, { recursive: true });
const STORE_FILE = path.join(HOME, 'cc_switch.json');

let dataHomeOverride = null;
const pool = { added: [], removed: [], picked: {} };
const escalations = [];

const savedCache = new Map();
function cacheStub(id, exports) {
  if (!savedCache.has(id)) savedCache.set(id, require.cache[id]);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

cacheStub(DATAHOME_ID, {
  getDataHome: () => dataHomeOverride || HOME,
  getLegacyDataHome: () => LEGACY,
  getAppHome: () => APP_HOME,
});
cacheStub(POOL_ID, {
  addKey: (provider, meta) => {
    pool.added.push([provider, meta]);
    return `k_${pool.added.length}`;
  },
  removeKey: (provider, keyId) => {
    pool.removed.push([provider, keyId]);
    return true;
  },
  pickById: (provider, keyId) => {
    if (pool.picked.__throw) throw new Error('pool down');
    return pool.picked[`${provider}|${keyId}`] || null;
  },
});
cacheStub(ESCALATION_ID, {
  escalate: (payload) => {
    escalations.push(payload);
    return Promise.resolve();
  },
});

const tmpRoots = [ROOT];

test.after(() => {
  for (const [id, entry] of savedCache) {
    if (entry) require.cache[id] = entry;
    else delete require.cache[id];
  }
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
});

/** Fresh store instance bound to the current data home; also clears the pool spy. */
function freshStore() {
  delete require.cache[STORE_ID];
  const store = require('./store.js');
  store._reset();
  pool.added.length = 0;
  pool.removed.length = 0;
  escalations.length = 0;
  assert.ok(STORE_FILE.startsWith(ROOT), 'store 必须写在临时根内');
  return store;
}

function wipe() {
  for (const f of [STORE_FILE, `${STORE_FILE}.bak`, path.join(LEGACY, 'cc_switch.json'), path.join(APP_HOME, 'heal-audit.jsonl')]) {
    fs.rmSync(f, { force: true });
  }
  fs.rmSync(STORE_FILE, { recursive: true, force: true });
}

function readStoreFile() {
  return JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
}

function writeStoreFile(doc) {
  fs.writeFileSync(STORE_FILE, typeof doc === 'string' ? doc : JSON.stringify(doc));
}

// ───────────────────────────── loading ──────────────────────────────────────

test('首次读取在临时 dataHome 落默认文档（schemaVersion 1 + 四个空容器）', () => {
  wipe();
  const store = freshStore();
  assert.equal(fs.existsSync(STORE_FILE), false, 'before load');
  const doc = store.__test__._load();
  assert.deepEqual(doc, { schemaVersion: 1, cards: [], active: {}, apps: {}, agentMode: {} });
  assert.equal(fs.existsSync(STORE_FILE), true, 'configGuard createIfMissing 会写默认文档');
  assert.deepEqual(readStoreFile(), doc);
  // 二次 _load 命中模块级缓存，不再读盘。
  fs.writeFileSync(STORE_FILE, '{"schemaVersion":9,"cards":[]}');
  assert.equal(store.__test__._load().schemaVersion, 1, '缓存优先于磁盘');
  store._reset();
  assert.equal(store.__test__._load().schemaVersion, 9, 'measured: 数字 schemaVersion 原样保留（只有 NaN 才回落 1）');
  store._reset();
  writeStoreFile({ schemaVersion: 'v2' });
  assert.equal(store.__test__._load().schemaVersion, 1, 'Number("v2") → NaN → || SCHEMA_VERSION');
  wipe();
});

test('脏文档容忍：非法 cards / active / apps / agentMode 条目逐个丢弃', () => {
  wipe();
  const store = freshStore();
  writeStoreFile({
    schemaVersion: 'oops',
    cards: [null, 'str', 42, { name: '' }, { name: '  A  ' }, { id: 'c1', name: 'B', baseUrl: 'u' }],
    active: { 'claude-code': 'c1', codex: '', nope: 'c1', gemini: 5 },
    apps: { 'claude-code': { scanEnabled: false, agentMode: 'direct' }, nope: { scanEnabled: true }, codex: null, zcode: 'str' },
    agentMode: {
      opencode: { mode: 'weird', cardId: 'c1' },
      trae: null,
      ycode: 'str',
      deepseek: { mode: 'direct', cardId: 7, ts: 8 },
      nope: { mode: 'direct' },
    },
  });
  store._reset();
  const doc = store.__test__._load();
  assert.equal(doc.schemaVersion, 1, 'Number("oops") → NaN → || SCHEMA_VERSION');
  assert.deepEqual(doc.cards.map((c) => c.name), ['A', 'B'], 'null/字符串/数字/空名卡片被丢');
  assert.equal(doc.cards[0].id.length, 18, '缺 id 时生成 c_<16hex>');
  assert.deepEqual(doc.active, { 'claude-code': 'c1' }, '只留合法应用 + 非空字符串 cardId');
  assert.deepEqual(Object.keys(doc.apps), ['claude-code'], 'measured: 仅合法应用名 + 对象 cfg 被留（null/字符串/未知应用都丢）');
  assert.deepEqual(doc.apps['claude-code'], { scanEnabled: false }, 'scanEnabled 之外的键不透传');
  assert.deepEqual(Object.keys(doc.agentMode).sort(), ['deepseek', 'opencode'], '非法 agentMode 条目被丢');
  assert.equal(doc.agentMode.opencode.mode, 'proxy', '未知 mode 回落 proxy，但 cardId 保留');
  assert.equal(doc.agentMode.opencode.cardId, 'c1');
  assert.equal(doc.agentMode.deepseek.cardId, '', '非字符串 cardId 归零');
  assert.equal(typeof doc.agentMode.deepseek.ts, 'string');
});

test('KNOWN-DEFECT 遗留 agentMode 抬升是死代码：_normalizeAgentMode 读的是已被 _normalizeApps 剥掉的字段', () => {
  wipe();
  const store = freshStore();
  writeStoreFile({ cards: [], active: {}, apps: { 'claude-code': { scanEnabled: true, agentMode: 'direct', cardId: 'c9' } } });
  store._reset();
  const doc = store.__test__._load();
  // 注释宣称「legacy agentMode 会被抬升」，但 _normalizeApps 先把它剥掉了。
  assert.deepEqual(doc.apps['claude-code'], { scanEnabled: true }, 'apps 条目只剩 scanEnabled');
  assert.deepEqual(doc.agentMode, {}, 'measured: 顶层 agentMode 仍是空 → direct/c9 彻底蒸发');
  assert.deepEqual(store.getAgentMode('claude-code'), { mode: 'proxy', cardId: '', ts: '' }, '回显静默变回 proxy');
  // 只有写在顶层 agentMode 的才会被认。
  writeStoreFile({ agentMode: { codex: { mode: 'direct', cardId: 'c9' } } });
  store._reset();
  assert.equal(store.getAgentMode('codex').mode, 'direct');
  // 公共 setter 也只会丢：setAppConfig 传 agentMode 返回 success:true 却不落地。
  assert.deepEqual(store.setAppConfig('claude-code', { scanEnabled: true, agentMode: 'direct', cardId: 'c9' }), { success: true });
  store._reset();
  assert.deepEqual(store.__test__._load().agentMode, { codex: store.__test__._load().agentMode.codex });
  assert.equal(Object.keys(store.__test__._load().agentMode).length, 1, '写入的 claude-code direct 记录没有出现在结果里');
});

test('遗留迁移：legacy 文件按原字节搬运，主文件存在时不动', () => {
  wipe();
  const raw = '{ "schemaVersion": 1, "cards": [ { "name": "  Legacy  " } ] , "zzz": true }';
  fs.writeFileSync(path.join(LEGACY, 'cc_switch.json'), raw);
  const store = freshStore();
  store.__test__._load();
  assert.equal(fs.existsSync(STORE_FILE), true);
  assert.equal(fs.readFileSync(STORE_FILE, 'utf-8'), raw, '迁移是字节级拷贝（不 normalize）');
  // 主文件一旦存在，legacy 不再覆盖。
  fs.writeFileSync(path.join(LEGACY, 'cc_switch.json'), '{"schemaVersion":7}');
  store._reset();
  const doc = store.__test__._load();
  assert.equal(doc.schemaVersion, 1, '主文件优先（仍是上一步的 raw，被归一为 1）');
  assert.equal(readStoreFile().cards.length, 1);
  // 脏 legacy 也照搬：normalize 只发生在内存里。
  assert.deepEqual(doc.cards[0].name, 'Legacy');
});

// ───────────────────────────── card CRUD ────────────────────────────────────

test('addCard：归一化补齐（trim 名 / 非法协议回落 openai / models 过滤 / apps 默认全 12 / wireApi 依协议）', () => {
  wipe();
  const store = freshStore();
  const res = store.addCard({
    name: '  DeepSeek  ',
    baseUrl: 'https://api.deepseek.com/v1',
    protocol: 'bogus',
    models: ['deepseek-chat', '', null, 5, 'reasoner'],
    apps: ['claude-code', 'nope'],
    key: ' sk-real ',
  });
  assert.equal(res.success, true);
  const card = res.card;
  assert.equal(card.name, 'DeepSeek');
  assert.equal(card.protocol, 'openai');
  assert.equal(card.wireApi, 'chat', '非 responses 协议一律 chat');
  assert.deepEqual(card.models, ['deepseek-chat', 'reasoner']);
  assert.equal(card.defaultModel, 'deepseek-chat', '缺 defaultModel 兜 models[0]');
  assert.deepEqual(card.apps, ['claude-code'], '非法应用名被丢（此时不回落全集）');
  assert.equal(card.enabled, true);
  assert.equal(card.requiresOpenaiAuth, false);
  assert.equal(card.keyId, 'k_1');
  assert.deepEqual(pool.added, [
    // measured: 名称/端点都 trim 了，交给池的原始 key 却原样透传（含首尾空格）。
    ['cc-switch:' + card.id, { key: ' sk-real ', label: 'cc-switch:DeepSeek', endpoint: 'https://api.deepseek.com/v1' }],
  ]);
  assert.equal(card.baseUrl, 'https://api.deepseek.com/v1', 'baseUrl 不 trim（只在存在性门里判真假）');
  // apps 缺省才是全 12 应用。
  const bare = store.addCard({ name: 'B', baseUrl: 'u' });
  assert.deepEqual(bare.card.apps, Object.values(require('./constants').APPS));
  assert.equal(bare.card.keyId, '', '不带 key → 不碰池');
  assert.equal(pool.added.length, 1);
  // responses 协议下 wireApi 只有 'chat' 能翻盘。
  const resp = store.addCard({ name: 'R', baseUrl: 'u', protocol: 'openai_responses' });
  assert.equal(resp.card.wireApi, 'responses');
  const respChat = store.addCard({ name: 'RC', baseUrl: 'u', protocol: 'openai_responses', wireApi: 'chat' });
  assert.equal(respChat.card.wireApi, 'chat');
  const respJunk = store.addCard({ name: 'RJ', baseUrl: 'u', protocol: 'openai_responses', wireApi: 'responses' });
  assert.equal(respJunk.card.wireApi, 'responses');
  // 落盘与内存一致。
  assert.deepEqual(readStoreFile().cards.map((c) => c.name), ['DeepSeek', 'B', 'R', 'RC', 'RJ']);
});

test('KNOWN-DEFECT addCard：null 入参抛出 V8 内部文案，而其它垃圾入参走中文门（fail-soft 不对称）', () => {
  wipe();
  const store = freshStore();
  assert.deepEqual(store.addCard(null), {
    success: false,
    error: "Cannot destructure property 'key' of 'input' as it is null.",
  }, '文档承诺返回 {success:false,error:中文}，实测漏出引擎内部串');
  assert.deepEqual(store.addCard(), { success: false, error: '卡片名称是必填项' });
  assert.deepEqual(store.addCard(0), { success: false, error: '卡片名称是必填项' });
  assert.deepEqual(store.addCard([]), { success: false, error: '卡片名称是必填项' });
  assert.deepEqual(store.addCard({ name: '   ' }), { success: false, error: '卡片名称是必填项' });
  assert.deepEqual(store.addCard({ name: 'A' }), { success: false, error: '卡片 baseUrl 是必填项' });
  assert.deepEqual(store.addCard({ name: 'A', baseUrl: 5 }), { success: false, error: '卡片 baseUrl 是必填项' });
  assert.equal(store.listCards().length, 0, '失败路径不追加卡片');
  assert.deepEqual(readStoreFile().cards, [], 'measured: 文件由读取路径的 createIfMissing 生成，内容仍是空文档');
  wipe();
});

test('listCards / getCard 返回内部引用：调用方改字段会污染缓存（并可被 _save 固化）', () => {
  wipe();
  const store = freshStore();
  const { card } = store.addCard({ name: 'A', baseUrl: 'u' });
  const listed = store.listCards();
  assert.equal(listed.length, 1);
  assert.equal(listed[0], store.getCard(card.id), '数组是新数组，元素仍是同一对象');
  listed[0].name = 'MUTATED';
  listed[0].models = ['injected'];
  assert.equal(store.getCard(card.id).name, 'MUTATED', '没有深拷贝，缓存被外部改写');
  store.addCard({ name: 'B', baseUrl: 'v' });
  assert.equal(readStoreFile().cards[0].name, 'MUTATED', '下一次 _save 把污染固化到磁盘');
  assert.equal(store.getCard('c_missing'), null);
  assert.equal(store.getCard(undefined), null);
});

test('updateCard：合并 / 换发密钥 / createdAt 保留 / 空 name 回落旧名', () => {
  wipe();
  const store = freshStore();
  const { card } = store.addCard({ name: 'A', baseUrl: 'u', key: 'sk-1', createdAt: 'fixed-time' });
  const created = card.createdAt;
  assert.deepEqual(store.updateCard('c_missing', { name: 'X' }), { success: false, error: '卡片不存在: c_missing' });
  const res = store.updateCard(card.id, { name: 'B', protocol: 'openai_responses', key: 'sk-2' });
  assert.equal(res.success, true);
  assert.equal(res.card.name, 'B');
  assert.equal(res.card.protocol, 'openai_responses');
  // measured: 协议改成 openai_responses 但 wireApi 沿用 prev 的 'chat'——
  // addCard 对同一协议给的是 'responses'，两条路径口径不一致。
  assert.equal(res.card.wireApi, 'chat');
  assert.equal(store.updateCard(card.id, { wireApi: 'responses' }).card.wireApi, 'responses');
  assert.equal(res.card.createdAt, created, 'createdAt 由 prev 继承');
  assert.ok(res.card.updatedAt !== created);
  assert.deepEqual(pool.removed, [['cc-switch:' + card.id, 'k_1']], '旧池条目被摘掉');
  assert.equal(pool.added[1][1].key, 'sk-2');
  assert.equal(res.card.keyId, 'k_2');
  // patch 是垃圾时的容忍：`patch = {}` 默认值只挡 undefined，null 会进解构抛错。
  const nullPatch = store.updateCard(card.id, null);
  assert.equal(nullPatch.success, false, 'null patch 不等价空 patch：解构 null 抛错被 catch 降级');
  assert.match(nullPatch.error, /destructure|null/i, 'measured: 文案是 V8 内部串，不是中文门');
  assert.equal(store.updateCard(card.id, {}).card.name, 'B');
  assert.equal(store.updateCard(card.id, { name: '' }).card.name, 'B', '空串 name 被 `|| prev.name` 吃掉，无法清空');
  assert.equal(store.updateCard(card.id, { enabled: false }).card.enabled, false);
  assert.equal(store.updateCard(card.id, { enabled: 'false' }).card.enabled, true, '只有字面 false 才算禁用');
  assert.equal(store.updateCard(card.id, { models: 'str' }).card.models.length, 0);
  // patch 里带 id 也没用：id 强制为入参 cardId。
  assert.equal(store.updateCard(card.id, { id: 'hijack' }).card.id, card.id);
});

test('removeCard：解除所有 active 引用并摘池；agentMode 里的同卡片引用残留', () => {
  wipe();
  const store = freshStore();
  const a = store.addCard({ name: 'A', baseUrl: 'u', key: 'sk' }).card;
  const b = store.addCard({ name: 'B', baseUrl: 'v' }).card;
  store.setActiveCard('claude-code', a.id);
  store.setActiveCard('codex', a.id);
  store.setAgentMode('opencode', 'proxy', a.id);
  assert.deepEqual(store.removeCard('c_missing'), { success: false, error: '卡片不存在: c_missing' });
  assert.deepEqual(store.removeCard(a.id), { success: true });
  assert.deepEqual(readStoreFile().active, {}, '两个 active 指向都被解除');
  assert.deepEqual(pool.removed, [['cc-switch:' + a.id, 'k_1']]);
  assert.deepEqual(store.listCards().map((c) => c.id), [b.id]);
  assert.deepEqual(Object.keys(store.getAllAgentModes()), ['opencode']);
  assert.equal(store.getAllAgentModes().opencode.cardId, a.id, 'measured: 已删卡片仍被 agentMode 指着');
  // 无 keyId 的卡片不碰池。
  store.removeCard(b.id);
  assert.equal(pool.removed.length, 1);
});

test('getCardCredential：只认 keyId，池缺失/抛错都回 null', () => {
  wipe();
  const store = freshStore();
  assert.equal(store.getCardCredential('nope'), null);
  const noKey = store.addCard({ name: 'A', baseUrl: 'u' }).card;
  assert.equal(store.getCardCredential(noKey.id), null, 'credential-free 卡片返回 null');
  const withKey = store.addCard({ name: 'B', baseUrl: 'v', key: 'sk-real' }).card;
  assert.equal(store.getCardCredential(withKey.id), null, '池里没这条 → pickById 返回 null');
  pool.picked[`cc-switch:${withKey.id}|k_1`] = { key: 'sk-real' };
  assert.equal(store.getCardCredential(withKey.id), 'sk-real');
  pool.picked.__throw = true;
  assert.equal(store.getCardCredential(withKey.id), null, '池抛错被吞 → null');
  delete pool.picked.__throw;
});

// ───────────────────────────── app state ────────────────────────────────────

test('setActiveCard：四类门与 null/undefined 清除（空串不是清除）', () => {
  wipe();
  const store = freshStore();
  const a = store.addCard({ name: 'A', baseUrl: 'u' }).card;
  const disabled = store.addCard({ name: 'D', baseUrl: 'u', enabled: false }).card;
  const narrow = store.addCard({ name: 'N', baseUrl: 'u', apps: ['claude-code'] }).card;
  assert.deepEqual(store.setActiveCard('nope', a.id), { success: false, error: '不支持的应用: nope' });
  assert.deepEqual(store.setActiveCard('codex', 'c_missing'), { success: false, error: '卡片不存在: c_missing' });
  assert.deepEqual(store.setActiveCard('codex', disabled.id), { success: false, error: '卡片「D」已禁用' });
  assert.deepEqual(store.setActiveCard('codex', narrow.id), {
    success: false,
    error: `卡片「N」不支持应用 codex`,
  });
  const ok = store.setActiveCard('codex', a.id);
  assert.equal(ok.success, true);
  assert.equal(ok.card.id, a.id);
  assert.equal(store.getActiveCardId('codex'), a.id);
  assert.deepEqual(store.setActiveCard('codex', null), { success: true });
  assert.equal(store.getActiveCardId('codex'), null);
  store.setActiveCard('codex', a.id);
  assert.deepEqual(store.setActiveCard('codex', undefined), { success: true }, 'cardId == null 宽松相等');
  assert.equal(store.getActiveCardId('codex'), null);
  // 空串走查表分支，报「卡片不存在: 」。
  assert.deepEqual(store.setActiveCard('codex', ''), { success: false, error: '卡片不存在: ' });
  assert.equal(store.getActiveCardId('nope'), null);
});

test('KNOWN-DEFECT setAppConfig：非法 cfg 返回 success:true 却让键从磁盘上消失', () => {
  wipe();
  const store = freshStore();
  store.setAppConfig('claude-code', { scanEnabled: false });
  assert.deepEqual(readStoreFile().apps, { 'claude-code': { scanEnabled: false } });
  assert.deepEqual(store.setAppConfig('claude-code', null), { success: true });
  assert.deepEqual(readStoreFile().apps, {}, 'measured: 报成功但配置被静默删除');
  store.setAppConfig('codex', { scanEnabled: true });
  assert.deepEqual(store.setAppConfig('nope', { scanEnabled: true }), { success: false, error: '不支持的应用: nope' });
  assert.deepEqual(store.setAppConfig('codex', 'x'), { success: true });
  assert.equal(readStoreFile().apps.codex, undefined);
  assert.deepEqual(store.setAppConfig('codex', { scanEnabled: 'yes', other: 1 }), { success: true });
  assert.deepEqual(store.getAppConfig('codex'), { scanEnabled: true }, '非 false 一律视为启用');
  // getAppConfig 返回内部引用：改它即改缓存。
  const cfg = store.getAppConfig('opencode');
  assert.deepEqual(cfg, { scanEnabled: true }, '未登记的 app 给默认对象');
  cfg.scanEnabled = false;
  store._reset();
  assert.deepEqual(store.getAppConfig('opencode'), { scanEnabled: true }, '未落盘，reset 后蒸发');
  store.setAppConfig('zcode', { scanEnabled: true });
  store.getAppConfig('zcode').scanEnabled = false;
  store.setAppConfig('ycode', { scanEnabled: true });
  assert.deepEqual(readStoreFile().apps.zcode, { scanEnabled: false }, '改内部引用会被下一次 _save 固化');
});

test('setAgentMode / getAgentMode / getAllAgentModes：默认 proxy，null 清除，未知模式中文报错', () => {
  wipe();
  const store = freshStore();
  assert.deepEqual(store.getAgentMode('claude-code'), { mode: 'proxy', cardId: '', ts: '' }, '缺省即 proxy');
  assert.deepEqual(store.getAgentMode('nope'), { mode: 'proxy', cardId: '', ts: '' });
  assert.deepEqual(store.getAllAgentModes(), {});
  assert.deepEqual(store.setAgentMode('nope', 'proxy'), { success: false, error: '不支持的应用: nope' });
  assert.deepEqual(store.setAgentMode('codex', 'weird'), {
    success: false,
    error: '未知模式: weird（应为 proxy 或 direct）',
  });
  assert.equal(store.setAgentMode('codex', 'direct', 'c_x').success, true);
  assert.deepEqual(store.getAgentMode('codex'), {
    mode: 'direct',
    cardId: 'c_x',
    ts: store.getAgentMode('codex').ts,
  });
  assert.equal(store.setAgentMode('codex', 'proxy', 7).success, true);
  assert.equal(store.getAgentMode('codex').cardId, '', '非字符串 cardId 归零');
  assert.equal(store.setAgentMode('codex', 'proxy').success, true);
  assert.deepEqual(store.getAllAgentModes(), { codex: store.getAgentMode('codex') }, '浅拷贝：顶层新对象');
  assert.equal(store.getAllAgentModes().codex, store.getAgentMode('codex'), '但条目对象仍是同一引用');
  store.getAllAgentModes().codex.mode = 'hacked';
  // measured 缺陷：getAgentMode 对非法 mode 静默回落成 proxy 三元组，
  // 而 getAllAgentModes 原样透出脏条目 —— 两个读口径对同一条记录给出不同答案。
  assert.deepEqual(store.getAgentMode('codex'), { mode: 'proxy', cardId: '', ts: '' },
    '非法 mode 被掩盖成默认代理');
  assert.equal(store.getAllAgentModes().codex.mode, 'hacked', '副本条目仍是缓存里那一个，脏值可见');
  store.setAgentMode('codex', 'proxy', 'c1');
  assert.equal(store.setAgentMode('codex', null).success, true);
  assert.deepEqual(store.getAllAgentModes(), {});
  assert.equal(store.getActiveCardId('codex'), null, '清模式不动 active');
});

// ─────────────────────────── snapshots ─────────────────────────────────────

test('exportSnapshot 是深拷贝；importSnapshot 增量按 id 去重、active 只认在册卡片', () => {
  wipe();
  const store = freshStore();
  const a = store.addCard({ name: 'A', baseUrl: 'u', key: 'sk' }).card;
  store.setActiveCard('claude-code', a.id);
  const snap = store.exportSnapshot();
  assert.deepEqual(snap, store.__test__._load());
  assert.notEqual(snap.cards[0], store.getCard(a.id), '深拷贝');
  snap.cards[0].name = 'HACKED';
  snap.active['claude-code'] = 'bogus';
  assert.equal(store.getCard(a.id).name, 'A', '改导出不影响存储');
  // 增量导入：同 id 跳过，active 里指向不存在卡片的项被丢。
  const incoming = {
    schemaVersion: 1,
    cards: [{ id: a.id, name: 'A2', baseUrl: 'u2' }, { id: 'c_new', name: 'N', baseUrl: 'u3' }],
    active: { codex: 'c_new', gemini: 'c_ghost' },
  };
  assert.deepEqual(store.importSnapshot(incoming), { success: true, count: 2 });
  assert.deepEqual(store.listCards().map((c) => c.name), ['A', 'N'], '同 id 不覆盖');
  assert.deepEqual(readStoreFile().active, { 'claude-code': a.id, codex: 'c_new' });
  assert.equal(store.getActiveCardId('gemini'), null);
  // 垃圾快照：全部静默成功、count 0。
  for (const junk of [null, undefined, 0, 'str', '{"cards":[', [], '"json-string"']) {
    assert.deepEqual(store.importSnapshot(junk), { success: true, count: 0 }, JSON.stringify(junk));
  }
  // JSON 字符串不会被解析（与「导入备份文件」的直觉相反）。
  const before = store.listCards().length;
  store.importSnapshot(JSON.stringify({ cards: [{ id: 'c_s', name: 'S', baseUrl: 'u' }] }));
  assert.equal(store.listCards().length, before, '传字符串等于什么都没导');
});

test('KNOWN-DEFECT importSnapshot(replace)：换 cards/active/apps 却不换 agentMode → 陈旧模式指向已不存在的卡片', () => {
  wipe();
  const store = freshStore();
  const old = store.addCard({ name: 'Old', baseUrl: 'u' }).card;
  store.setActiveCard('codex', old.id);
  store.setAgentMode('codex', 'direct', old.id);
  const res = store.importSnapshot(
    { schemaVersion: 1, cards: [{ id: 'c_fresh', name: 'Fresh', baseUrl: 'v' }], active: {}, apps: {} },
    { replace: true }
  );
  assert.deepEqual(res, { success: true, count: 1 });
  const doc = readStoreFile();
  assert.deepEqual(doc.cards.map((c) => c.id), ['c_fresh']);
  assert.deepEqual(doc.active, {});
  assert.deepEqual(doc.apps, {});
  assert.deepEqual(Object.keys(doc.agentMode), ['codex'], 'agentMode 不在 replace 范围内');
  assert.equal(doc.agentMode.codex.cardId, old.id, '留下指向已删除卡片的 direct 记录');
  assert.equal(store.getCard(old.id), null);
  assert.equal(store.getAgentMode('codex').mode, 'direct', '回显仍是旧模式，而卡片已消失');
});

// ─────────────────────── write paths / fail-soft ───────────────────────────

test('KNOWN-DEFECT 写入失败：addCard 仍返回 success:true，磁盘上一个字节都没有（静默丢数据）', () => {
  wipe();
  const blocked = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ccswitch-blocked-'));
  tmpRoots.push(blocked);
  // 用「目录占了文件名」制造确定性写失败（跨平台一致）。
  fs.mkdirSync(path.join(blocked, 'cc_switch.json'));
  dataHomeOverride = blocked;
  try {
    const store = freshStore();
    const res = store.addCard({ name: 'A', baseUrl: 'u' });
    assert.equal(res.success, true, 'measured: 写盘失败被 _save 的 catch 吞掉');
    assert.equal(res.card.name, 'A');
    assert.equal(fs.readdirSync(path.join(blocked, 'cc_switch.json')).length, 0, '没有临时文件残留');
    store.setAgentMode('codex', 'direct', 'c1');
    store.removeCard(res.card.id);
    assert.equal(fs.readdirSync(blocked).length, 1, '目录里始终只有那个占位文件夹');
  } finally {
    dataHomeOverride = null;
  }
});

test('KNOWN-DEFECT 损坏主文件 + 有效 .bak：自动恢复并写 heal-audit；双损坏则回落默认文档并触发升级链', () => {
  wipe();
  let store = freshStore();
  store.addCard({ name: 'A', baseUrl: 'u' });
  const good = fs.readFileSync(STORE_FILE, 'utf-8');
  fs.writeFileSync(`${STORE_FILE}.bak`, good);
  fs.writeFileSync(STORE_FILE, '{"cards": [ broken');
  store._reset();
  store.__test__._load();
  assert.equal(fs.readFileSync(STORE_FILE, 'utf-8'), good, '主文件被 .bak 覆盖恢复');
  assert.deepEqual(store.listCards().map((c) => c.name), ['A']);
  const auditFile = path.join(APP_HOME, 'heal-audit.jsonl');
  assert.equal(auditFile.startsWith(ROOT), true, '审计只写临时 app home');
  // 双损坏：主 + bak 都是垃圾。
  fs.writeFileSync(STORE_FILE, '{{{');
  fs.writeFileSync(`${STORE_FILE}.bak`, '}}}');
  store._reset();
  const doc = store.__test__._load();
  assert.deepEqual(doc, { schemaVersion: 1, cards: [], active: {}, apps: {}, agentMode: {} });
  assert.equal(escalations.length, 1, 'fire-and-forget 交给升级链');
  assert.equal(escalations[0].trigger, 'config-guard-double-corrupt-sync');
  assert.deepEqual(escalations[0].failedAttempts.map((a) => a.step), ['read_main', 'read_backup']);
  // 升级链自身抛错也不阻断读取。
  fs.writeFileSync(STORE_FILE, '{{{');
  fs.writeFileSync(`${STORE_FILE}.bak`, '}}}');
  const savedEscalate = require.cache[ESCALATION_ID].exports.escalate;
  require.cache[ESCALATION_ID].exports.escalate = () => {
    throw new Error('escalation down');
  };
  try {
    store._reset();
    assert.deepEqual(store.__test__._load().cards, []);
  } finally {
    require.cache[ESCALATION_ID].exports.escalate = savedEscalate;
  }
  wipe();
});

test('导出面与池命名空间：_poolProvider 用 cc-switch: 前缀隔离内置池', () => {
  wipe();
  const store = freshStore();
  assert.equal(store._poolProvider('c1'), 'cc-switch:c1');
  assert.equal(store._poolProvider(''), 'cc-switch:');
  assert.equal(store._poolProvider(undefined), 'cc-switch:undefined');
  assert.deepEqual(Object.keys(store).sort(), [
    '__test__',
    '_poolProvider',
    '_reset',
    'addCard',
    'exportSnapshot',
    'getActiveCardId',
    'getAgentMode',
    'getAllAgentModes',
    'getAppConfig',
    'getCard',
    'getCardCredential',
    'importSnapshot',
    'listCards',
    'removeCard',
    'setActiveCard',
    'setAgentMode',
    'setAppConfig',
    'updateCard',
  ]);
  assert.deepEqual(Object.keys(store.__test__).sort(), ['_load', '_save']);
  // _save 把当前缓存原子落盘（tmp + rename，不留残 file）。
  store.addCard({ name: 'Z', baseUrl: 'u' });
  store.__test__._save();
  assert.deepEqual(readStoreFile().cards.map((c) => c.name), ['Z']);
  assert.deepEqual(fs.readdirSync(HOME).filter((f) => f.includes('.tmp')), []);
  wipe();
});
