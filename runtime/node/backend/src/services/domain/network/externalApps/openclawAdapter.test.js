'use strict';

/**
 * openclawAdapter.test.js — 钉死 openclaw `openclaw.json`（models.providers）+ 旁路 .env 适配器。
 *
 * 为什么这支套件必须存在：openclaw 是「json 存结构、密钥旁路 .env」的双文件形态——和 reasonix
 * 一样把真 key 挡在主配置文件外，但主配置是 JSON 而非 TOML，providers 挂在 `models.providers` 下，
 * 默认模型在 `agents.defaults.model.primary`。这些嵌套路径与 remove 时对 primary 的「只删指向它的」
 * 联动，是本 adapter 特有的形状，必须钉，否则容易把 deepseekTui 的顶层标量删法误套过来。
 *
 * 实测更正（与源码注释/直觉不同处，按真实语义钉死）：
 *   · 主配置 JSON 里 provider 只留 baseUrl/models/input，**绝不含 api_key**；真 key 在 `<home>/.env`
 *     的 `<ID>_API_KEY`；hasKey/usable.apiKey 均从 .env 反解。
 *   · add 会补 `input: ['text']`（若非数组）；这是 openclaw schema 要求，非可选。
 *   · default 路径 = `agents.defaults.model.primary`，写作 `<id>/<model>`。
 *   · remove confirmed 删 provider + 若 primary 指向 `<id>/` 则删 primary；.env 键仅在 removeKeys 时
 *     删除并写 tombstone `# openclaw-cleared`。
 *   · p.baseUrl / p.baseURL 两种大小写都认（endpoint getter 取 baseUrl||baseURL）。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const A = require('./openclawAdapter');

let BASE;
let env;
before(() => {
  BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-xa-openclaw-'));
  env = { OPENCLAW_HOME: path.join(BASE, 'ocl'), HOME: BASE };
});
after(() => {
  try {
    fs.rmSync(BASE, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function readJson() {
  return JSON.parse(fs.readFileSync(A.configPath(env), 'utf8'));
}
function readEnv() {
  const p = path.join(env.OPENCLAW_HOME, '.env');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

test('导出面恰为 configPath/list/get/add/remove/usable', () => {
  assert.deepStrictEqual(Object.keys(A).sort(), ['add', 'configPath', 'get', 'list', 'remove', 'usable'].sort());
});

test('configPath = <home>/openclaw.json（OPENCLAW_HOME 覆盖）', () => {
  assert.strictEqual(A.configPath({ OPENCLAW_HOME: '/o' }), path.join('/o', 'openclaw.json'));
});

test('list 空配置：providers 空、model 空', () => {
  assert.deepStrictEqual(A.list(env), { success: true, app: 'openclaw', providers: [], model: '' });
});

test('add：json 存结构（含 input 兜底）+ primary 路径；密钥旁路 .env', () => {
  const r = A.add({ provider: 'deepseek', model: 'o1', apiKey: 'sk-o-123456789', endpoint: 'https://o' }, env);
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.keyWritten, true);
  const doc = readJson();
  assert.strictEqual(doc.models.providers.deepseek.baseUrl, 'https://o');
  assert.deepStrictEqual(doc.models.providers.deepseek.input, ['text']);
  assert.ok(!('api_key' in doc.models.providers.deepseek), '真 key 不进 json');
  assert.strictEqual(doc.agents.defaults.model.primary, 'deepseek/o1');
  assert.strictEqual(readEnv(), 'DEEPSEEK_API_KEY=sk-o-123456789\n');
});

test('add 缺 provider → provider is required', () => {
  assert.match(A.add({}, env).error, /provider is required/);
});

test('list/get 认 baseUrl||baseURL 双大小写', () => {
  fs.writeFileSync(A.configPath(env), JSON.stringify({ models: { providers: { alt: { baseURL: 'https://UPPER', models: ['m'] } } } }));
  assert.strictEqual(A.get('alt', env).provider.endpoint, 'https://UPPER');
});

test('usable.apiKey 从 .env 反解', () => {
  A.add({ provider: 'deepseek', model: 'o1', apiKey: 'sk-o-123456789', endpoint: 'https://o' }, env);
  const u = A.usable(env).providers.find((p) => p.id === 'deepseek');
  assert.strictEqual(u.apiKey, 'sk-o-123456789');
});

test('remove 未 confirmed → preview；确认后删 provider + 指向它的 primary', () => {
  A.add({ provider: 'deepseek', model: 'o1', apiKey: 'sk-o-123456789', endpoint: 'https://o' }, env);
  assert.strictEqual(A.remove({ target: 'deepseek' }, env).preview, true);
  assert.ok(readJson().models.providers.deepseek, '预览不删');
  const r = A.remove({ target: 'deepseek', confirmed: true }, env);
  assert.strictEqual(r.confirmed, true);
  assert.ok(!readJson().models.providers.deepseek);
  assert.ok(!readJson().agents.defaults.model.primary, 'primary 指向被删 id → 清');
});

test('remove + removeKeys：清 .env 键并写 tombstone `# openclaw-cleared`', () => {
  fs.writeFileSync(path.join(env.OPENCLAW_HOME, '.env'), '');
  A.add({ provider: 'deepseek', model: 'o1', apiKey: 'sk-o-123456789', endpoint: 'https://o' }, env);
  const r = A.remove({ target: 'deepseek', confirmed: true, removeKeys: true }, env);
  assert.strictEqual(r.keyRemoved, true);
  assert.match(readEnv(), /# openclaw-cleared DEEPSEEK_API_KEY/);
});

test('remove 不存在 provider → provider not found；坏 JSON fail-soft', () => {
  assert.match(A.remove({ target: 'ghost', confirmed: true }, env).error, /provider not found/);
  fs.writeFileSync(A.configPath(env), '{broken');
  assert.strictEqual(A.list(env).success, false);
});
