'use strict';

/**
 * reasonixAdapter.test.js — 钉死 DeepSeek-Reasonix `config.toml`（`[[providers]]` 表数组）+ 旁路 .env。
 *
 * 为什么这支套件必须存在：Reasonix 的密钥**不进 toml**，只进 `api_key_env`（引用 env 变量名），
 * 真 secret 写同目录 `.env`；config.toml 里每个 provider 是表数组 `[[providers]]` 的一个元素。
 * 这套「引用名 + 旁路 .env」的双写、以及 remove 时按 api_key_env 清 .env 键（带 tombstone），
 * 与 deepseekTui 的内联策略正好相反——把两种相反的安全方向分别钉死，才不会把其中一个的修复
 * 误套到另一个上。全程 REASONIX_HOME 指向临时目录。
 *
 * 实测更正（与源码注释/直觉不同处，按真实语义钉死）：
 *   · config.toml 里只出现 `api_key_env = "DEEPSEEK_API_KEY"`（键名），真 key 只在 .env。
 *   · hasKey/usable.apiKey 都从 **.env** 解析（parseDotenv），不在 toml 里；故 .env 缺该键 → hasKey=false。
 *   · remove confirmed 删表数组元素 + default_model（若指向它）；带 removeKeys 才动 .env 并写
 *     tombstone `# reasonix-cleared <KEY>`；不 removeKeys 时 .env 原样保留。
 *   · _providerView 的 id 取 `p.name`（表里的 name 字段），不是数组下标；list 的 model 取 doc.default_model。
 *   · toml.stringify 对表数组写出 `[[providers]]` 段；round-trip 能被 tomlLite.parse 读回。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const A = require('./reasonixAdapter');

let BASE;
let env;
before(() => {
  BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-xa-reasonix-'));
  env = { REASONIX_HOME: path.join(BASE, 'rx'), HOME: BASE };
});
after(() => {
  try {
    fs.rmSync(BASE, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function readToml() {
  return fs.readFileSync(A.configPath(env), 'utf8');
}
function readEnv() {
  const p = path.join(env.REASONIX_HOME, '.env');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

test('导出面恰为 configPath/list/get/add/remove/usable', () => {
  assert.deepStrictEqual(Object.keys(A).sort(), ['add', 'configPath', 'get', 'list', 'remove', 'usable'].sort());
});

test('configPath = <home>/config.toml（REASONIX_HOME 覆盖目录）', () => {
  assert.strictEqual(A.configPath({ REASONIX_HOME: '/r' }), path.join('/r', 'config.toml'));
});

test('list 空配置：providers 空、model 空', () => {
  assert.deepStrictEqual(A.list(env), { success: true, app: 'reasonix', providers: [], model: '' });
});

test('add 双写：config.toml 只存 api_key_env 引用，真 key 落旁路 .env', () => {
  const r = A.add({ provider: 'deepseek', model: 'r1', apiKey: 'sk-r-123456789', endpoint: 'https://rx' }, env);
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.keyWritten, true);
  const toml = readToml();
  assert.match(toml, /\[\[providers\]\]/);
  assert.match(toml, /api_key_env = "DEEPSEEK_API_KEY"/);
  assert.ok(!toml.includes('sk-r-123456789'), '真 key 绝不进 config.toml');
  assert.strictEqual(readEnv(), 'DEEPSEEK_API_KEY=sk-r-123456789\n');
  assert.strictEqual(r.keyMasked, 'sk-r…6789');
});

test('add 缺 provider → provider is required', () => {
  assert.match(A.add({}, env).error, /provider is required/);
});

test('add 无 key：写引用名 api_key_env 但不碰 .env（keyWritten=false）', () => {
  A.add({ provider: 'nokey', model: 'nk', endpoint: 'https://nk' }, env);
  const u = A.usable(env).providers.find((p) => p.id === 'nokey');
  assert.strictEqual(u.apiKey, '', '无 .env 键 → usable.apiKey 空');
  assert.strictEqual(A.list(env).providers.find((p) => p.id === 'nokey').hasKey, false);
});

test('list/get 用 p.name 作 id，model 取 default_model', () => {
  const l = A.list(env);
  assert.ok(l.providers.some((p) => p.id === 'deepseek'));
  const g = A.get('DeepSeek', env);
  assert.strictEqual(g.success, true);
  assert.strictEqual(g.provider.endpoint, 'https://rx');
  assert.strictEqual(A.get('ghost', env).success, false);
});

test('usable.apiKey 从 .env 反解（hasKey 同源）', () => {
  A.add({ provider: 'deepseek', model: 'r1', apiKey: 'sk-r-123456789', endpoint: 'https://rx' }, env);
  const u = A.usable(env).providers.find((p) => p.id === 'deepseek');
  assert.strictEqual(u.apiKey, 'sk-r-123456789');
  assert.strictEqual(u.defaultModel, 'r1');
});

test('remove 未 confirmed → preview；不 removeKeys 时 .env 保留', () => {
  A.add({ provider: 'deepseek', model: 'r1', apiKey: 'sk-r-123456789', endpoint: 'https://rx' }, env);
  assert.strictEqual(A.remove({ target: 'deepseek' }, env).preview, true);
  const r = A.remove({ target: 'deepseek', confirmed: true }, env);
  assert.strictEqual(r.keyRemoved, false, '无 removeKeys → keyRemoved=false（实测：字段恒存在，不是 undefined）');
  assert.ok(readEnv().includes('DEEPSEEK_API_KEY'), '未 removeKeys → .env 键保留');
});

test('remove confirmed + removeKeys：删表元素 + .env 写 tombstone `# reasonix-cleared`', () => {
  fs.writeFileSync(A.configPath(env), '');
  fs.writeFileSync(path.join(env.REASONIX_HOME, '.env'), '');
  A.add({ provider: 'deepseek', model: 'r1', apiKey: 'sk-r-123456789', endpoint: 'https://rx' }, env);
  const r = A.remove({ target: 'deepseek', confirmed: true, removeKeys: true }, env);
  assert.strictEqual(r.keyRemoved, true);
  assert.match(readEnv(), /# reasonix-cleared DEEPSEEK_API_KEY/);
  assert.ok(!readEnv().includes('sk-r-123456789'), '真 key 从 .env 移除');
});

test('remove 不存在 → provider not found；坏 TOML fail-soft', () => {
  assert.match(A.remove({ target: 'ghost', confirmed: true }, env).error, /provider not found/);
  fs.writeFileSync(A.configPath(env), 'k = @@@');
  assert.strictEqual(A.list(env).success, false);
});
