'use strict';

/**
 * constants.js contract tests — the single source of truth for the ccSwitch
 * provider-card subsystem: protocol enum, supported apps, display labels,
 * switch modes, per-protocol default models, and the data-file identity.
 *
 * Pure data module: no IO, no env reads. These tests pin the SSOT shape so any
 * drift (a new app without a label, a renamed protocol) is caught mechanically.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const c = require('./constants');

const {
  PROTOCOLS,
  APPS,
  APP_LABELS,
  AGENT_MODES,
  PROTOCOL_DEFAULT_MODELS,
  DATA_FILE,
  SCHEMA_VERSION,
} = c;

test('导出面恰好是文档声明的 10 个符号，不多不少', () => {
  assert.deepEqual(
    Object.keys(c).sort(),
    [
      'AGENT_MODES',
      'APPS',
      'APP_LABELS',
      'CARD_POOL_NAMESPACE',
      'DATA_FILE',
      'LEGACY_CARD_POOL_NAMESPACE',
      'PROTOCOLS',
      'PROTOCOL_DEFAULT_MODELS',
      'SCHEMA_VERSION',
      'cardPoolProvider',
      'legacyCardPoolProvider',
      'normalizePoolProviderName',
    ].sort()
  );
});

test('PROTOCOLS 钉死四个线上协议字面量（网关转换依赖这些精确串）', () => {
  assert.deepEqual(PROTOCOLS, {
    OPENAI: 'openai',
    ANTHROPIC: 'anthropic',
    RESPONSES: 'openai_responses',
    GEMINI: 'gemini',
  });
  assert.equal(new Set(Object.values(PROTOCOLS)).size, 4, 'no duplicate wire names');
});

test('APPS 是 12 个 kebab-case 应用 id，键名与值遵循同一条命名变换', () => {
  const ids = Object.values(APPS);
  assert.equal(ids.length, 12);
  assert.equal(new Set(ids).size, 12, 'app ids unique');
  for (const [key, value] of Object.entries(APPS)) {
    assert.match(value, /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, `${key} → ${value} kebab-case`);
    assert.equal(key.toLowerCase().replace(/_/g, '-'), value, `${key} ↔ ${value} derive identically`);
  }
  assert.deepEqual(ids, [
    'claude-code', 'codex', 'opencode', 'gemini', 'deepseek', 'reasonix',
    'command-code', 'ycode', 'zcode', 'openclaw', 'coze', 'trae',
  ]);
});

test('APP_LABELS 与 APPS 双向覆盖：每个应用有且仅有一个人类标签', () => {
  const ids = Object.values(APPS);
  for (const id of ids) {
    assert.equal(typeof APP_LABELS[id], 'string', `${id} has a label`);
    assert.ok(APP_LABELS[id].trim().length > 0, `${id} label non-empty`);
  }
  assert.deepEqual(Object.keys(APP_LABELS), ids, 'no label without an app');
  assert.equal(new Set(Object.values(APP_LABELS)).size, ids.length, 'labels unique');
});

test('AGENT_MODES 只有 direct/proxy 两档（DESIGN-ARCH-101 §6）', () => {
  assert.deepEqual(AGENT_MODES, { DIRECT: 'direct', PROXY: 'proxy' });
});

test('PROTOCOL_DEFAULT_MODELS 的键恰为 PROTOCOLS 的全部取值，值非空', () => {
  assert.deepEqual(Object.keys(PROTOCOL_DEFAULT_MODELS).sort(), Object.values(PROTOCOLS).sort());
  assert.deepEqual(PROTOCOL_DEFAULT_MODELS, {
    openai: 'gpt-4o',
    anthropic: 'claude-sonnet-4-5',
    openai_responses: 'gpt-5-codex',
    gemini: 'gemini-2.5-pro',
  });
  for (const [k, v] of Object.entries(PROTOCOL_DEFAULT_MODELS)) {
    assert.equal(typeof v, 'string');
    assert.ok(v.trim().length > 0, `${k} default model non-empty`);
  }
});

test('DATA_FILE 是纯文件名、SCHEMA_VERSION 是正整数（RUNTIME-001：不得含路径/主机）', () => {
  assert.equal(DATA_FILE, 'cc_switch.json');
  assert.doesNotMatch(DATA_FILE, /[\\/]/, 'no path separator → dataHome stays the single root');
  assert.doesNotMatch(DATA_FILE, /(^|\s)(localhost|\d+\.\d+\.\d+\.\d+|\d{1,5}:\d{1,5})/);
  assert.equal(SCHEMA_VERSION, 1);
  assert.ok(Number.isInteger(SCHEMA_VERSION) && SCHEMA_VERSION > 0);
});

test('五个枚举对象被 Object.freeze，写入在严格模式下抛 TypeError', () => {
  for (const [name, obj] of [['PROTOCOLS', PROTOCOLS], ['APPS', APPS], ['APP_LABELS', APP_LABELS], ['AGENT_MODES', AGENT_MODES], ['PROTOCOL_DEFAULT_MODELS', PROTOCOL_DEFAULT_MODELS]]) {
    assert.ok(Object.isFrozen(obj), `${name} frozen`);
    assert.throws(() => { obj.__kprobe__ = 1; }, TypeError, `${name} rejects new keys`);
    assert.equal(obj.__kprobe__, undefined);
  }
  // 冻结是浅层的：值本身是字符串，因此不存在内部可变对象可漏改。
  for (const obj of [PROTOCOLS, APPS, APP_LABELS, AGENT_MODES, PROTOCOL_DEFAULT_MODELS]) {
    assert.ok(Object.values(obj).every((v) => typeof v === 'string'), 'flat string leaves only');
  }
});

test('KNOWN-DEFECT 应用 id 与协议字面量共用命名空间："gemini" 两边同名，跨表查找会静默命中', () => {
  const protocolValues = new Set(Object.values(PROTOCOLS));
  const collided = Object.values(APPS).filter((id) => protocolValues.has(id));
  // Measured: exactly one collision, and it is the Gemini CLI app.
  assert.deepEqual(collided, ['gemini']);
  assert.equal(APPS.GEMINI, PROTOCOLS.GEMINI);
  // Consequence: a caller that indexes a protocol-keyed table with an app id (or
  // the other way round) gets a hit instead of undefined — no failure to notice.
  assert.equal(PROTOCOL_DEFAULT_MODELS[APPS.GEMINI], 'gemini-2.5-pro');
  assert.equal(APP_LABELS[PROTOCOLS.GEMINI], 'Gemini CLI');
  // Every other pair stays disjoint, so the bug only bites on the gemini wire.
  assert.equal(PROTOCOL_DEFAULT_MODELS[APPS.CODEX], undefined);
  assert.equal(APP_LABELS[PROTOCOLS.OPENAI], undefined);
  assert.equal(Object.keys(APP_LABELS).some((k) => protocolValues.has(k)), true, 'the collision is real, not theoretical');
});

test('KNOWN-DEFECT PROTOCOLS 里没有 CODEX 成员，routeResolver 的 case PROTOCOLS.CODEX 是死分支', () => {
  // Measured: the enum only carries RESPONSES ('openai_responses'); CODEX is
  // undefined, so `case PROTOCOLS.CODEX:` compiles to `case undefined:`.
  assert.equal(PROTOCOLS.CODEX, undefined);
  const rr = require('./routeResolver');
  assert.deepEqual(rr.appForProtocol(undefined), APPS.CODEX, 'undefined wire resolves to Codex');
  assert.deepEqual(rr.appForProtocol(PROTOCOLS.RESPONSES), null, 'the real Codex wire resolves to nothing');
});

test('KNOWN-DEFECT SCHEMA_VERSION 只当默认值用：无任何校验器，未知高版本照单全收', () => {
  // Measured: the module ships the number but no guard — 数据符号全是字面量/冻结对象。
  // （2026-11-19 起另有 3 个池名纯函数，见下面「卡片池命名空间」一组；它们不参与版本比较。）
  const DATA_SYMBOLS = [
    'PROTOCOLS', 'APPS', 'APP_LABELS', 'AGENT_MODES', 'PROTOCOL_DEFAULT_MODELS',
    'DATA_FILE', 'SCHEMA_VERSION', 'CARD_POOL_NAMESPACE', 'LEGACY_CARD_POOL_NAMESPACE',
  ];
  for (const name of DATA_SYMBOLS) {
    assert.notEqual(typeof c[name], 'function', `${name} 是数据不是行为`);
  }
  assert.deepEqual(
    Object.keys(c).filter((k) => typeof c[k] === 'function').sort(),
    ['cardPoolProvider', 'legacyCardPoolProvider', 'normalizePoolProviderName'],
    '唯一的函数符号是三个池名纯叶子（零 IO、绝不抛）'
  );
  const src = require('fs').readFileSync(require.resolve('./store.js'), 'utf-8');
  // The only consumer keeps whatever version the file claims (|| only fires on
  // 0/NaN), i.e. a future schemaVersion: 2 store loads unchanged with no gate.
  assert.match(src, /schemaVersion:\s*Number\(doc\.schemaVersion\)\s*\|\|\s*SCHEMA_VERSION/);
  assert.doesNotMatch(src, /schemaVersion\s*[<>]=?\s*\d|schemaVersion !== SCHEMA_VERSION/);
});

// ── 卡片池命名空间（2026-11-19：缺口②「自带 key 的卡生成的模型名网关解不出」）────
// 池名会被网关当成 `api:<pool>:<model>` 的池段用，apiAdapter.parseProviderModel 与
// aiGateway._resolveApiPoolProviderForRequest 的三段式正则池段只认 [a-z0-9_-]。
// 历史命名空间 `cc-switch:<cardId>` 含冒号 → 池段被截成 'cc-switch'、apiKeyPool.pick
// 精确匹配不到 key/endpoint、模型 id 被污染成 '<cardId>:<model>'。
test('卡片池命名空间：现行名合法、旧名含冒号、两侧互转', () => {
  assert.equal(c.CARD_POOL_NAMESPACE, 'cc_switch');
  assert.equal(c.LEGACY_CARD_POOL_NAMESPACE, 'cc-switch');
  assert.equal(c.cardPoolProvider('c_ab12'), 'cc_switch_c_ab12');
  assert.equal(c.legacyCardPoolProvider('c_ab12'), 'cc-switch:c_ab12');
  // 现行名必须过网关池段正则；旧名必须过不了（这就是要换掉它的理由）
  assert.match(c.cardPoolProvider('c_ab12'), /^[a-z0-9_-]+$/);
  assert.doesNotMatch(c.legacyCardPoolProvider('c_ab12'), /^[a-z0-9_-]+$/);
  // 幂等/边界：空 id 仍产出合法形态（store 总是先 _genId()，空 id 只会出现在手搓数据里）
  assert.match(c.cardPoolProvider(''), /^[a-z0-9_-]+$/);
});

test('normalizePoolProviderName：合法名原样透传，非法字符折叠为 _', () => {
  assert.equal(c.normalizePoolProviderName('openai'), 'openai');
  assert.equal(c.normalizePoolProviderName('my-provider'), 'my-provider', '连字符在字符类内，不许被折叠');
  assert.equal(c.normalizePoolProviderName('  DeepSeek  '), 'deepseek');
  assert.equal(c.normalizePoolProviderName('a:b:c'), 'a_b_c');
  assert.equal(c.normalizePoolProviderName('__x__'), 'x', '首尾下划线被修掉');
  assert.equal(c.normalizePoolProviderName(''), '');
  assert.equal(c.normalizePoolProviderName(null), '');
  // 绝不抛
  assert.doesNotThrow(() => c.normalizePoolProviderName({ toString: null }));
});
