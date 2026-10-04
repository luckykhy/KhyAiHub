'use strict';

/**
 * deepseekTuiAdapter.test.js — 钉死 DeepSeek-TUI `~/.deepseek/config.toml` 适配器（点分子表）。
 *
 * 为什么这支套件必须存在：本 adapter 读写走 tomlLite（零依赖 TOML 子集），密钥**直接内联**在
 * provider 子表的 api_key 字段（非引用、非旁路 .env）。它同时维护顶层 `provider`（当前激活）与
 * `default_text_model`（当前默认模型）两条顶层标量。remove 删子表 + 若当前激活就是它则删顶层 provider。
 * 这些「顶层标量与子表的联动」最容易删错方向，且 toml 序列化后能否被自家 parse 读回是硬契约。
 *
 * 实测更正（与源码注释/直觉不同处，按真实语义钉死）：
 *   · configPath 三态优先级：DEEPSEEK_CONFIG_PATH（直指文件）> DEEPSEEK_HOME（目录）> ~/.deepseek。
 *   · remove confirmed 只删 doc.providers[id] 与（当 doc.provider===id 时）顶层 provider；
 *     `default_text_model` **不清**——删干净后 list().providers 为空但 list().model 仍是旧模型串。
 *   · add 反复调用对同一 provider 幂等：models 去重追加，不会重复堆叠同一 model 名。
 *   · list/get 用 tomlLite.parse 反解；坏 TOML（不可识别构造）由 tomlLite 抛、被本层收敛为 {success:false}。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const A = require('./deepseekTuiAdapter');

let BASE;
let env;
before(() => {
  BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-xa-dstui-'));
  env = { DEEPSEEK_CONFIG_PATH: path.join(BASE, 'ds', 'config.toml'), HOME: BASE };
});
after(() => {
  try {
    fs.rmSync(BASE, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function readToml() {
  return fs.readFileSync(env.DEEPSEEK_CONFIG_PATH, 'utf8');
}

test('导出面恰为 configPath/list/get/add/remove/usable', () => {
  assert.deepStrictEqual(Object.keys(A).sort(), ['add', 'configPath', 'get', 'list', 'remove', 'usable'].sort());
});

test('configPath 三态：CONFIG_PATH 直指 > DEEPSEEK_HOME 目录 > ~/.deepseek', () => {
  assert.strictEqual(A.configPath({ DEEPSEEK_CONFIG_PATH: '/x/c.toml' }), '/x/c.toml');
  assert.strictEqual(A.configPath({ DEEPSEEK_HOME: '/h' }), path.join('/h', 'config.toml'));
  assert.strictEqual(A.configPath({ HOME: '/hh' }), path.join(path.join(path.join('/hh', '.deepseek'), 'config.toml')));
});

test('list 空配置：providers 空、model 空串', () => {
  assert.deepStrictEqual(A.list(env), { success: true, app: 'deepseek-tui', providers: [], model: '' });
});

test('add 内联 api_key 到 [providers.<id>] 子表 + 顶层 provider / default_text_model', () => {
  const r = A.add({ provider: 'deepseek', model: 'd1', apiKey: 'sk-d-123456789', endpoint: 'https://ds/v1' }, env);
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.keySource, 'nl');
  const toml = readToml();
  assert.match(toml, /\[providers\.deepseek\]/);
  assert.match(toml, /api_key = "sk-d-123456789"/);
  assert.match(toml, /provider = "deepseek"/);
  assert.match(toml, /default_text_model = "d1"/);
});

test('add 缺 provider → provider is required', () => {
  assert.match(A.add({}, env).error, /provider is required/);
});

test('add 幂等：同 provider 再加同 model 不重复堆叠 models', () => {
  A.add({ provider: 'deepseek', model: 'd1', apiKey: 'sk-d-123456789', endpoint: 'https://ds/v1' }, env);
  A.add({ provider: 'deepseek', model: 'd1', apiKey: 'sk-d-123456789', endpoint: 'https://ds/v1' }, env);
  const u = A.usable(env).providers.find((p) => p.id === 'deepseek');
  assert.deepStrictEqual(u.models, ['d1']);
});

test('list/get/usable 反读同一 provider（usable 带真 key）', () => {
  A.add({ provider: 'deepseek', model: 'd1', apiKey: 'sk-d-123456789', endpoint: 'https://ds/v1' }, env);
  assert.strictEqual(A.list(env).providers[0].hasKey, true);
  assert.strictEqual(A.get('deepseek', env).provider.endpoint, 'https://ds/v1');
  assert.strictEqual(A.usable(env).providers[0].apiKey, 'sk-d-123456789');
  assert.strictEqual(A.get('ghost', env).success, false);
});

test('实测钉住：remove 清子表与顶层 provider，但 default_text_model 残留（list().model 仍非空）', () => {
  A.add({ provider: 'deepseek', model: 'd1', apiKey: 'sk-d-123456789', endpoint: 'https://ds/v1' }, env);
  const r = A.remove({ target: 'deepseek', confirmed: true }, env);
  assert.strictEqual(r.confirmed, true);
  const toml = readToml();
  assert.doesNotMatch(toml, /api_key = "sk-d/, '子表 api_key 应随 provider 删除');
  assert.doesNotMatch(toml, /provider = "deepseek"/, '顶层 provider 应被清');
  assert.match(toml, /default_text_model = "d1"/, '实测：default_text_model 不被 remove 清理');
  const l = A.list(env);
  assert.deepStrictEqual(l.providers, []);
  assert.strictEqual(l.model, 'd1');
});

test('remove 未 confirmed → preview；不存在 → provider not found', () => {
  A.add({ provider: 'deepseek', model: 'd1', apiKey: 'sk-d-123456789', endpoint: 'https://ds/v1' }, env);
  const pv = A.remove({ target: 'deepseek' }, env);
  assert.strictEqual(pv.success, true);
  assert.strictEqual(pv.preview, true);
  assert.strictEqual(A.remove({ target: 'ghost', confirmed: true }, env).success, false);
});

test('坏 TOML fail-soft：不可识别值让 list 收敛为 {success:false,error}', () => {
  fs.mkdirSync(path.dirname(env.DEEPSEEK_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(env.DEEPSEEK_CONFIG_PATH, 'k = @@@not-a-value');
  const r = A.list(env);
  assert.strictEqual(r.success, false);
  assert.match(r.error, /unrecognized value/);
});
