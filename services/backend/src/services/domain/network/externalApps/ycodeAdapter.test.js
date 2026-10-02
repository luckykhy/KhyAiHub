'use strict';

/**
 * ycodeAdapter.test.js — 钉死 YCode `.ycode/config.json` 单一 provider 块适配器（env 引用密钥）。
 *
 * 为什么这支套件必须存在：YCode 的形态与其它都不同——它只有**一个** provider 块（不是按 id 分表），
 * 密钥只写 `api_key_env`（env 变量名引用，官方「never writes the key to its config」）。因此
 * 「add 是覆盖整个 provider 块」而非「增删列表项」，remove 是「清空 provider 块」。这个语义与其它
 * adapter 的 upsert-by-id 差别很大，若不钉住，调用方容易按「多 provider」心智误用。默认目录是
 * `<cwd>/.ycode`，测试用 YCODE_CONFIG_DIR 指到临时目录，绝不写真实项目目录。
 *
 * 实测更正（与源码注释/直觉不同处，按真实语义钉死）：
 *   · _providerView.id 恒为 'api'（只要 base_url 存在），并非传入的 provider 名——单块语义。
 *   · add 会补 timeout_seconds:180 与 stream:true（若原无）；保留既有其它 provider 字段（merge 到块内）。
 *   · apiKey 存在 → 只写 api_key_env=envKeyNameForId(provider||'api')；真 key 绝不落盘。
 *   · remove 清空整个 provider 块；块不存在 → provider not found（而非幂等成功）。
 *   · configDir：YCODE_CONFIG_DIR 优先，否则 path.join(process.cwd(), '.ycode')。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const A = require('./ycodeAdapter');

let BASE;
let env;
before(() => {
  BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-xa-ycode-'));
  env = { YCODE_CONFIG_DIR: path.join(BASE, '.ycode'), HOME: BASE };
});
after(() => {
  try {
    fs.rmSync(BASE, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function readCfg() {
  return JSON.parse(fs.readFileSync(A.configPath(env), 'utf8'));
}

test('导出面恰为 8 个（含 configDir / envKeyNameForId）', () => {
  assert.deepStrictEqual(Object.keys(A).sort(), [
    'add', 'configDir', 'configPath', 'envKeyNameForId', 'get', 'list', 'remove', 'usable',
  ]);
});

test('configDir/configPath：YCODE_CONFIG_DIR 覆盖，否则 <cwd>/.ycode', () => {
  assert.strictEqual(A.configDir(env), env.YCODE_CONFIG_DIR);
  assert.strictEqual(A.configPath(env), path.join(env.YCODE_CONFIG_DIR, 'config.json'));
  assert.strictEqual(A.configDir({ HOME: '/h' }), path.join(process.cwd(), '.ycode'));
});

test('envKeyNameForId：大写折叠 + 空回退 CUSTOM', () => {
  assert.strictEqual(A.envKeyNameForId('Deep Seek'), 'KHY_CC_SWITCH_DEEP_SEEK_KEY');
  assert.strictEqual(A.envKeyNameForId(''), 'KHY_CC_SWITCH_CUSTOM_KEY');
});

test('add：单 provider 块落 api_key_env 引用 + timeout/stream 兜底；真 key 不落盘', () => {
  const r = A.add({ provider: 'DeepSeek', model: 'yc1', apiKey: 'sk-real-secret', endpoint: 'https://y/v1' }, env);
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.keyEnvRef, 'KHY_CC_SWITCH_DEEPSEEK_KEY');
  const p = readCfg().provider;
  assert.strictEqual(p.api_key_env, 'KHY_CC_SWITCH_DEEPSEEK_KEY');
  assert.ok(!JSON.stringify(readCfg()).includes('sk-real-secret'), '真 key 绝不进 config.json');
  assert.strictEqual(p.timeout_seconds, 180);
  assert.strictEqual(p.stream, true);
  assert.strictEqual(p.connection, 'api');
});

test('add 缺端点且无 preset → endpoint is required', () => {
  assert.match(A.add({ provider: 'zzzbrand-no-preset' }, env).error, /endpoint is required/);
});

test('实测钉住：_providerView.id 恒为 api（单块语义），list/get/usable 皆反映该点', () => {
  A.add({ provider: 'Whatever', model: 'w', endpoint: 'https://w', apiKey: 'sk-w-12345678' }, env);
  assert.strictEqual(A.list(env).providers[0].id, 'api');
  assert.strictEqual(A.list(env).providers[0].defaultModel, 'w');
  assert.strictEqual(A.get('anything', env).provider.id, 'api');
  assert.strictEqual(A.usable(env).providers[0].id, 'api');
  assert.strictEqual(A.usable(env).providers[0].apiKey, 'KHY_CC_SWITCH_WHATEVER_KEY', 'usable 回的是 env 引用名');
});

test('add merge 保留块内既有无关字段', () => {
  fs.writeFileSync(A.configPath(env), JSON.stringify({ provider: { custom_keep: 'yes', base_url: 'https://old' }, agent: { x: 1 } }));
  A.add({ provider: 'p', model: 'm', endpoint: 'https://n' }, env);
  const doc = readCfg();
  assert.strictEqual(doc.provider.custom_keep, 'yes');
  assert.strictEqual(doc.agent.x, 1);
});

test('remove 未 confirmed → preview；确认后清空 provider 块', () => {
  A.add({ provider: 'p', model: 'm', endpoint: 'https://n' }, env);
  assert.strictEqual(A.remove({}, env).preview, true);
  assert.ok(readCfg().provider, '预览不清块');
  const r = A.remove({ confirmed: true }, env);
  assert.strictEqual(r.confirmed, true);
  assert.ok(!('provider' in readCfg()), 'provider 块被整体删除');
});

test('实测钉住：空配置里 _load 把 provider 兜成 {}，remove 的 "provider not found" 分支永不触发', () => {
  // 这是 ycode 特有的可达性面：_load 强制 doc.provider = {}（若非对象），
  // 于是 remove 的 `!doc.provider || typeof!=='object'` 守卫恒不成立 —— 该 not-found 分支是死代码。
  fs.writeFileSync(A.configPath(env), JSON.stringify({}));
  const r = A.remove({ confirmed: true }, env);
  assert.strictEqual(r.success, true, '空配置 remove 反而成功（删了兜底的 {} provider 键）');
  assert.ok(!('provider' in readCfg()));
});

test('实测钉住：空 provider（被 _load 兜成 {}）仍产出一条 id="" 的视图，而非空列表', () => {
  fs.writeFileSync(A.configPath(env), JSON.stringify({}));
  const l = A.list(env);
  assert.strictEqual(l.success, true);
  assert.strictEqual(l.providers.length, 1, '_load 兜底 {} → list 恒有一条视图');
  assert.strictEqual(l.providers[0].id, '', 'base_url 缺失 → id 为 ""');
  assert.strictEqual(A.get('anything', env).success, true, 'get 对兜底 {} 也回 success（非 not-found）');
});

test('坏 JSON fail-soft：list → {success:false,error}', () => {
  fs.writeFileSync(A.configPath(env), '{bad');
  assert.strictEqual(A.list(env).success, false);
});
