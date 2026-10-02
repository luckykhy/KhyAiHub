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

test('导出面恰好是文档声明的 7 个符号，不多不少', () => {
  assert.deepEqual(
    Object.keys(c).sort(),
    ['AGENT_MODES', 'APPS', 'APP_LABELS', 'DATA_FILE', 'PROTOCOLS', 'PROTOCOL_DEFAULT_MODELS', 'SCHEMA_VERSION'].sort()
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
  // Measured: the module ships the number but no guard — it exports only data.
  assert.ok(
    Object.values(c).every((v) => typeof v !== 'function'),
    'constants exports only data, so every consumer invents its own version compare'
  );
  const src = require('fs').readFileSync(require.resolve('./store.js'), 'utf-8');
  // The only consumer keeps whatever version the file claims (|| only fires on
  // 0/NaN), i.e. a future schemaVersion: 2 store loads unchanged with no gate.
  assert.match(src, /schemaVersion:\s*Number\(doc\.schemaVersion\)\s*\|\|\s*SCHEMA_VERSION/);
  assert.doesNotMatch(src, /schemaVersion\s*[<>]=?\s*\d|schemaVersion !== SCHEMA_VERSION/);
});
