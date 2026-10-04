'use strict';

/**
 * geminiCliAdapter.test.js — 钉死 Gemini CLI settings.json `env` 块适配器，重点记录其 remove
 * 分支里两处「写了但实际不生效」的缺陷（按实测行为钉住，不修正源码）。
 *
 * 为什么这支套件必须存在：gemini 与 claude-code 同构（env 块 merge-write），但它的凭据键是
 * 全局共享的 GEMINI_API_KEY / GOOGLE_GENAI_API_KEY，不像 claude 那样按 provider 分键。于是
 * remove 时「要不要删共享凭据」就成了一个真会误删/漏删的判定点。本套件把两个已实测的缺陷
 * 钉成回归基线：任何人后续真去修这两处，都会先撞红这里的断言，从而被迫重看契约。
 *
 * 实测更正（两处已注册缺陷）：
 *   · geminiCliAdapter.js:180-185 的 `stillUsed` 判据里 `.some()` 回调对每个键都 `return false`
 *     （两个分支都 false），恒得 stillUsed=false —— 注释宣称「仅当没有其它 provider 使用
 *     GEMINI_API_KEY 时才删」，实测**永远**当作没人用、永远删共享凭据。
 *   · geminiCliAdapter.js:173-176 先 `delete doc.env[urlName]`（<P>_BASE_URL），再判
 *     `doc.env[urlName] === doc.env.GOOGLE_GENAI_API_URL` —— 此刻 urlName 已被删成 undefined，
 *     与 GOOGLE_GENAI_API_URL 永不相等，故共享端点键 GOOGLE_GENAI_API_URL **漏删、残留**。
 *   · 上述两条叠加后的净效果（实测）：confirmed remove+removeKeys 删掉 <P>_BASE_URL 与两把
 *     API_KEY，但 GOOGLE_GENAI_API_URL / GOOGLE_GENAI_MODEL 留在盘上。keyRemoved 恒 true。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const A = require('./geminiCliAdapter');

let BASE;
let env;
before(() => {
  BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-xa-gemini-'));
  env = { GEMINI_CONFIG_DIR: path.join(BASE, 'cfg'), HOME: BASE };
});
after(() => {
  try {
    fs.rmSync(BASE, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function seed(obj) {
  fs.mkdirSync(env.GEMINI_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(A.configPath(env), JSON.stringify(obj));
}
function readCfg() {
  return JSON.parse(fs.readFileSync(A.configPath(env), 'utf8'));
}

test('导出面恰为 configPath/list/get/add/remove/usable', () => {
  assert.deepStrictEqual(Object.keys(A).sort(), ['add', 'configPath', 'get', 'list', 'remove', 'usable'].sort());
});

test('configPath：GEMINI_CONFIG_DIR 覆盖，否则 ~/.gemini/settings.json', () => {
  assert.strictEqual(A.configPath({ GEMINI_CONFIG_DIR: '/g' }), path.join('/g', 'settings.json'));
  assert.strictEqual(A.configPath({ HOME: '/hh' }), path.join(path.join('/hh', '.gemini'), 'settings.json'));
});

test('add 写共享凭据键 + provider 端点键 + 全局模型键', () => {
  const r = A.add({ provider: 'gemini', model: 'g1', apiKey: 'sk-gg-1234567890', endpoint: 'https://gem/v1' }, env);
  assert.strictEqual(r.success, true);
  const doc = readCfg();
  assert.strictEqual(doc.env.GEMINI_API_KEY, 'sk-gg-1234567890');
  assert.strictEqual(doc.env.GOOGLE_GENAI_API_KEY, 'sk-gg-1234567890');
  assert.strictEqual(doc.env.GEMINI_BASE_URL, 'https://gem/v1');
  assert.strictEqual(doc.env.GOOGLE_GENAI_API_URL, 'https://gem/v1');
  assert.strictEqual(doc.env.GOOGLE_GENAI_MODEL, 'g1');
});

test('add 缺 provider → provider is required', () => {
  const r = A.add({}, env);
  assert.strictEqual(r.success, false);
  assert.match(r.error, /provider is required/);
});

test('list/get/usable 反读：凭据优先 GEMINI_API_KEY，端点回退 GOOGLE_GENAI_API_URL', () => {
  A.add({ provider: 'gemini', model: 'g1', apiKey: 'sk-gg-1234567890', endpoint: 'https://gem/v1' }, env);
  assert.strictEqual(A.get('gemini', env).provider.hasKey, true);
  assert.strictEqual(A.usable(env).providers[0].apiKey, 'sk-gg-1234567890');
  assert.strictEqual(A.list(env).model, 'g1');
});

test('_providersFromEnv 只认 <UPPER>_API_KEY / _BASE_URL（小写键与非前缀键忽略）', () => {
  seed({ env: { OPENAI_API_KEY: 'k', XAI_BASE_URL: 'u', lowercase_api_key: 'z', GOOGLE_GENAI_MODEL: 'm' } });
  const ids = A.list(env).providers.map((p) => p.id).sort();
  assert.deepStrictEqual(ids, ['openai', 'xai']);
});

test('remove 未 confirmed → success:true preview（不改盘）', () => {
  seed({ env: { GEMINI_API_KEY: 'k', GEMINI_BASE_URL: 'u' } });
  const before = fs.readFileSync(A.configPath(env), 'utf8');
  const r = A.remove({ target: 'gemini' }, env);
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.preview, true);
  assert.strictEqual(fs.readFileSync(A.configPath(env), 'utf8'), before);
});

test('已注册缺陷：confirmed remove 删了 <P>_BASE_URL 后，共享端点键 GOOGLE_GENAI_API_URL 漏删残留', () => {
  seed({
    env: {
      GEMINI_API_KEY: 'sk-gg-1234567890',
      GOOGLE_GENAI_API_KEY: 'sk-gg-1234567890',
      GEMINI_BASE_URL: 'https://gem/v1',
      GOOGLE_GENAI_API_URL: 'https://gem/v1',
      GOOGLE_GENAI_MODEL: 'g1',
    },
  });
  const r = A.remove({ target: 'gemini', confirmed: true, removeKeys: true }, env);
  assert.strictEqual(r.keyRemoved, true, 'stillUsed 恒 false → 总是删共享 key');
  const doc = readCfg();
  assert.strictEqual(doc.env.GEMINI_BASE_URL, undefined);
  assert.strictEqual(doc.env.GEMINI_API_KEY, undefined);
  assert.strictEqual(doc.env.GOOGLE_GENAI_API_KEY, undefined);
  // 漏删：urlName 先被删成 undefined，等值判断永不成立 → 共享端点键留下
  assert.strictEqual(doc.env.GOOGLE_GENAI_API_URL, 'https://gem/v1', '实测漏删：GOOGLE_GENAI_API_URL 残留');
});

test('已注册缺陷：即便存在另一 provider 共用 GEMINI_API_KEY，remove 仍删共享凭据（stillUsed 判据恒 false）', () => {
  seed({
    env: {
      GEMINI_API_KEY: 'shared-secret-key',
      GOOGLE_GENAI_API_KEY: 'shared-secret-key',
      GEMINI_BASE_URL: 'https://a',
      OTHERPROVIDER_BASE_URL: 'https://b',
    },
  });
  A.remove({ target: 'gemini', confirmed: true, removeKeys: true }, env);
  const doc = readCfg();
  // OTHERPROVIDER 仅以 BASE_URL 存在（不以 key 声明），但判据根本不检查任何键 → 共享 key 被删
  assert.strictEqual(doc.env.GEMINI_API_KEY, undefined, '注释声称的「其它 provider 还在用则保留」并未实现');
  assert.ok(doc.env.OTHERPROVIDER_BASE_URL, '无关 provider 端点仍在');
});

test('remove 不存在 provider → provider not found（需既有 <P>_API_KEY 或 <P>_BASE_URL 才算存在）', () => {
  seed({ env: {} });
  const r = A.remove({ target: 'ghost', confirmed: true }, env);
  assert.strictEqual(r.success, false);
  assert.match(r.error, /provider not found/);
});

test('坏 JSON fail-soft：usable 收敛为 {success:false,error}', () => {
  seed('{ broken');
  const r = A.usable(env);
  assert.strictEqual(r.success, false);
  assert.ok(r.error.length > 0);
});
