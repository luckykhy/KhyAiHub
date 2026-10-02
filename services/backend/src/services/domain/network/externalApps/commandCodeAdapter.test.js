'use strict';

/**
 * commandCodeAdapter.test.js — 钉死 Command Code BYOK 适配器（providers.json + config.json 双文件）。
 *
 * 为什么这支套件必须存在：本 adapter 的密钥策略是「只写 env 引用 `$KHY_CC_SWITCH_<ID>_KEY`，
 * 绝不内联明文」——官方会拒绝裸密钥。这条安全方向（配置里到底落的是引用串还是真 key）必须钉，
 * 一旦有人误把真 key 内联进去，测试得先红。它还同时维护两张文件（providers.json 表 + config.json
 * 默认模型），remove 需跨两文件清理，是最容易「删一半」的形状。
 *
 * 实测更正（与源码注释/直觉不同处，按真实语义钉死）：
 *   · hasKey 判的是「apiKey 字段是否存在」，而该字段被写成引用串 `$KHY_CC_SWITCH_.._KEY`——
 *     所以 hasKey=true **不代表**盘上有真密钥，只代表有 env 引用（安全语义，别读反）。
 *   · list 给**每个** provider 的 defaultModel 都填全局 cfg.model 串（如 'deepseek/dc'），
 *     而不是该 provider 自己的模型——多 provider 时这是会误导的展示面（实测钉住）。
 *   · usable 的 defaultModel 则取 models[0]（与 list 口径不同源），是另一处不一致。
 *   · add 无 protocol 时 api 兜底 'openai-completions'；protocol='anthropic' → 'anthropic-messages'。
 *   · add 缺端点且 preset 无命中 → 明确失败（endpoint is required），绝不写半截 provider。
 *   · config.json 的默认 model 写作 `<id>/<model>`（BYOK 前缀路由规则）。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const A = require('./commandCodeAdapter');

let BASE;
let env;
before(() => {
  BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-xa-cmdcode-'));
  env = { COMMAND_CODE_HOME: path.join(BASE, 'cc'), HOME: BASE };
});
after(() => {
  try {
    fs.rmSync(BASE, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function readProv() {
  return JSON.parse(fs.readFileSync(A.configPath(env), 'utf8'));
}
function readCfg() {
  return JSON.parse(fs.readFileSync(A.configFilePath(env), 'utf8'));
}

test('导出面恰为 8 个（含 configFilePath / API_WIRE）', () => {
  assert.deepStrictEqual(Object.keys(A).sort(), [
    'API_WIRE', 'add', 'configFilePath', 'configPath', 'get', 'list', 'remove', 'usable',
  ]);
});

test('API_WIRE 冻结映射：openai/gemini→openai-completions，anthropic→anthropic-messages', () => {
  assert.deepStrictEqual({ ...A.API_WIRE }, {
    openai: 'openai-completions',
    openai_responses: 'openai-completions',
    anthropic: 'anthropic-messages',
    gemini: 'openai-completions',
  });
});

test('configPath/configFilePath 双文件同目录（COMMAND_CODE_HOME 覆盖）', () => {
  assert.strictEqual(A.configPath({ COMMAND_CODE_HOME: '/c' }), path.join('/c', 'providers.json'));
  assert.strictEqual(A.configFilePath({ COMMAND_CODE_HOME: '/c' }), path.join('/c', 'config.json'));
});

test('add：密钥落 env 引用串而非明文；config.json 写 <id>/<model>', () => {
  const r = A.add({ provider: 'DeepSeek', model: 'dc', apiKey: 'sk-real-secret', endpoint: 'https://api.deepseek.com', protocol: 'anthropic' }, env);
  assert.strictEqual(r.keyRef, '$KHY_CC_SWITCH_DEEPSEEK_KEY');
  const prov = readProv().provider.deepseek;
  assert.strictEqual(prov.apiKey, '$KHY_CC_SWITCH_DEEPSEEK_KEY');
  assert.ok(!JSON.stringify(readProv()).includes('sk-real-secret'), '真 key 绝不进 providers.json');
  assert.strictEqual(prov.api, 'anthropic-messages');
  assert.strictEqual(readCfg().model, 'deepseek/dc');
  assert.strictEqual(readCfg().provider, 'command-code');
});

test('add 缺 provider → provider is required', () => {
  assert.match(A.add({}, env).error, /provider is required/);
});

test('add 无 protocol 兜底 openai-completions；无 key 时不写 apiKey 字段', () => {
  A.add({ provider: 'plain', endpoint: 'https://p', model: 'x' }, env);
  const p = readProv().provider.plain;
  assert.strictEqual(p.api, 'openai-completions');
  assert.ok(!('apiKey' in p), '无 key 且原无引用 → apiKey 字段留空（不写 undefined 键）');
});

test('add 无端点且无 preset → endpoint is required（不写半截 provider）', () => {
  const r = A.add({ provider: 'zzzbrand-no-preset' }, env);
  assert.strictEqual(r.success, false);
  assert.match(r.error, /endpoint is required/);
});

test('实测钉住：list 给每个 provider 的 defaultModel 都填全局 cfg.model（多 provider 误导面）', () => {
  fs.writeFileSync(A.configFilePath(env), JSON.stringify({ model: 'deepseek/dc' }));
  fs.writeFileSync(A.configPath(env), JSON.stringify({ provider: { deepseek: { baseURL: 'u', apiKey: 'r', models: { dc: {} } }, other: { baseURL: 'u2' } } }));
  const l = A.list(env);
  const byId = Object.fromEntries(l.providers.map((p) => [p.id, p]));
  assert.strictEqual(byId.deepseek.defaultModel, 'deepseek/dc');
  assert.strictEqual(byId.other.defaultModel, 'deepseek/dc', 'other 自己没有 defaultModel，却继承了全局 cfg.model');
});

test('get 命中返回视图；未知 → provider not found', () => {
  A.add({ provider: 'deepseek', model: 'dc', apiKey: 'sk-x', endpoint: 'https://api.deepseek.com' }, env);
  assert.strictEqual(A.get('deepseek', env).success, true);
  assert.strictEqual(A.get('ghost', env).success, false);
});

test('usable 的 defaultModel 取 models[0]（与 list 的全局 cfg.model 口径不同源）', () => {
  fs.writeFileSync(A.configFilePath(env), JSON.stringify({ model: 'zzz/other' }));
  fs.writeFileSync(A.configPath(env), JSON.stringify({ provider: { ds: { baseURL: 'u', apiKey: 'k', models: { m1: {}, m2: {} } } } }));
  const u = A.usable(env);
  assert.strictEqual(u.providers[0].defaultModel, 'm1');
  assert.strictEqual(u.providers[0].apiKey, 'k', 'usable 回的是引用串（含 hasKey 语义），非真 key');
});

test('remove 未 confirmed → preview success；确认后跨两文件删 provider + 指向它的 cfg.model', () => {
  fs.writeFileSync(A.configPath(env), JSON.stringify({ provider: { deepseek: { baseURL: 'u' }, keep: { baseURL: 'k' } } }));
  fs.writeFileSync(A.configFilePath(env), JSON.stringify({ model: 'deepseek/dc' }));
  const pv = A.remove({ target: 'deepseek' }, env);
  assert.strictEqual(pv.preview, true);
  assert.ok(readProv().provider.deepseek, '预览不得删 provider');
  const r = A.remove({ target: 'deepseek', confirmed: true }, env);
  assert.strictEqual(r.confirmed, true);
  assert.ok(!readProv().provider.deepseek);
  assert.ok(readProv().provider.keep, '其它 provider 保留（merge 语义）');
  assert.ok(!('model' in readCfg()), '指向被删 id 的默认模型被清');
});

test('remove 不存在 provider → provider not found', () => {
  fs.writeFileSync(A.configPath(env), JSON.stringify({ provider: {} }));
  assert.match(A.remove({ target: 'ghost', confirmed: true }, env).error, /provider not found/);
});

test('坏 providers.json fail-soft：list → {success:false,error}', () => {
  fs.writeFileSync(A.configPath(env), 'not-json{');
  assert.strictEqual(A.list(env).success, false);
});
