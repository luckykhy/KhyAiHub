'use strict';

/**
 * claudeCodeAdapter.test.js — 钉死 claude-code settings.json `env` 块适配器的六导出契约。
 *
 * 为什么这支套件必须存在：本 adapter 把 provider 落进 `~/.claude/settings.json` 的 env 块，
 * 是 merge-write（只动目标键、保留其余）+ remove 带 confirmed 闸门的典型。它有两条外部面：
 * 正向写入（add/remove）与反向消费（usable，含真 key）。任何一处漂移都会写坏用户真实
 * claude 配置或把密钥错脱敏，故用注入 CLAUDE_CONFIG_DIR 指向临时目录全程隔离，绝不动真实家目录。
 *
 * 实测更正（与源码注释/直觉不同处，按真实语义钉死）：
 *   · list/remove 后 ANTHROPIC_MODEL 不会被清——remove 只删 <P>_BASE_URL 与（可选）<P>_API_KEY，
 *     故删干净后 list().providers 为空但 list().model 仍是旧模型串（实测 providers:[] 且 model 保留）。
 *   · literalAnthropicEnv=true 把端点/密钥写到 ANTHROPIC_BASE_URL/ANTHROPIC_API_KEY 而非
 *     <P>_* 命名空间——这条代理模式分支必须独立钉。
 *   · hasKey 由「有 AUTH_TOKEN 或 API_KEY」决定，AUTH_TOKEN 优先（中继 Bearer）。
 *   · remove 未 confirmed 返回 {success:true, preview:true}（预览即成功，非失败）；
 *     目标不存在才 {success:false, 'provider not found'}。
 *   · 坏 JSON 让 _load 抛，被 list 收敛为 {success:false,error}（fail-soft 契约）。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.KHY_DATA_HOME = process.env.KHY_DATA_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'khy-xa-cc-'));

const A = require('./claudeCodeAdapter');

let BASE;
let env;
before(() => {
  BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-xa-claude-'));
  env = { CLAUDE_CONFIG_DIR: path.join(BASE, 'cfg'), HOME: BASE };
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

test('导出面恰为 configPath/list/get/add/remove/usable', () => {
  assert.deepStrictEqual(Object.keys(A).sort(), ['add', 'configPath', 'get', 'list', 'remove', 'usable'].sort());
});

test('configPath：CLAUDE_CONFIG_DIR 覆盖目录，否则回落 ~/.claude/settings.json', () => {
  assert.strictEqual(A.configPath({ CLAUDE_CONFIG_DIR: '/x/y' }), path.join('/x/y', 'settings.json'));
  assert.strictEqual(A.configPath({ HOME: '/hh' }), path.join(path.join('/hh', '.claude'), 'settings.json'));
});

test('list 空配置：success:true、providers 空、model 空', () => {
  const r = A.list(env);
  assert.deepStrictEqual(r, { success: true, app: 'claude-code', providers: [], model: '' });
});

test('add 缺 provider → {success:false, provider is required}，不落盘', () => {
  const r = A.add({}, env);
  assert.strictEqual(r.success, false);
  assert.match(r.error, /provider is required/);
});

test('add 全链：写 <P>_API_KEY/<P>_BASE_URL/ANTHROPIC_MODEL，密钥脱敏回显', () => {
  const r = A.add({ provider: 'DeepSeek', model: 'ds-chat', apiKey: 'sk-secret123456', endpoint: 'https://x/v1' }, env);
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.keySource, 'nl');
  assert.strictEqual(r.keyMasked, 'sk-s…3456');
  const doc = readCfg();
  assert.strictEqual(doc.env.DEEPSEEK_API_KEY, 'sk-secret123456');
  assert.strictEqual(doc.env.DEEPSEEK_BASE_URL, 'https://x/v1');
  assert.strictEqual(doc.env.ANTHROPIC_MODEL, 'ds-chat');
});

test('list/get/usable 反读同一 provider：hasKey 真、usable 带真 key（不脱敏）', () => {
  A.add({ provider: 'DeepSeek', model: 'ds-chat', apiKey: 'sk-secret123456', endpoint: 'https://x/v1' }, env);
  const l = A.list(env);
  assert.deepStrictEqual(l.providers, [{ id: 'deepseek', models: ['ds-chat'], endpoint: 'https://x/v1', hasKey: true }]);
  const g = A.get('deepseek', env);
  assert.strictEqual(g.success, true);
  assert.strictEqual(g.provider.endpoint, 'https://x/v1');
  const u = A.usable(env);
  assert.strictEqual(u.providers[0].apiKey, 'sk-secret123456');
  assert.strictEqual(u.providers[0].defaultModel, 'ds-chat');
});

test('get 未知 provider → provider not found', () => {
  const g = A.get('nope', env);
  assert.strictEqual(g.success, false);
  assert.match(g.error, /provider not found: nope/);
});

test('AUTH_TOKEN 优先于 API_KEY 计入 hasKey 与 usable.apiKey', () => {
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    A.configPath(env),
    JSON.stringify({ env: { DEEPSEEK_AUTH_TOKEN: 'tok-relay', DEEPSEEK_API_KEY: 'sk-real' } })
  );
  assert.strictEqual(A.get('deepseek', env).provider.hasKey, true);
  assert.strictEqual(A.usable(env).providers.find((p) => p.id === 'deepseek').apiKey, 'tok-relay');
});

test('literalAnthropicEnv=true 落 ANTHROPIC_* 而非 <P>_* 命名空间（代理模式分支）', () => {
  fs.writeFileSync(A.configPath(env), JSON.stringify({ env: {} }));
  A.add({ provider: 'glm', apiKey: 'sk-glm-abcdef123', endpoint: 'https://g', model: 'm1', literalAnthropicEnv: true }, env);
  const doc = readCfg();
  assert.strictEqual(doc.env.ANTHROPIC_API_KEY, 'sk-glm-abcdef123');
  assert.strictEqual(doc.env.ANTHROPIC_BASE_URL, 'https://g');
  assert.strictEqual(doc.env.GLM_API_KEY, undefined);
});

test('add merge-write：保留 env 块内无关键', () => {
  fs.writeFileSync(A.configPath(env), JSON.stringify({ env: { UNRELATED_KEEP: 'yes' }, otherTop: 1 }));
  A.add({ provider: 'p1', apiKey: 'sk-p1-abcdef123', endpoint: 'https://e', model: 'mm' }, env);
  const doc = readCfg();
  assert.strictEqual(doc.env.UNRELATED_KEEP, 'yes');
  assert.strictEqual(doc.otherTop, 1);
});

test('remove 未 confirmed → {success:true, preview:true, confirmed:false}（预览即成功，不落盘改动）', () => {
  fs.writeFileSync(A.configPath(env), JSON.stringify({ env: { P1_API_KEY: 'k', P1_BASE_URL: 'u' } }));
  const before = fs.readFileSync(A.configPath(env), 'utf8');
  const r = A.remove({ target: 'p1' }, env);
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.preview, true);
  assert.strictEqual(fs.readFileSync(A.configPath(env), 'utf8'), before, '预览不得改盘');
});

test('实测钉住：remove confirmed+removeKeys 只删 <P>_BASE_URL/<P>_API_KEY，ANTHROPIC_MODEL 残留', () => {
  fs.writeFileSync(
    A.configPath(env),
    JSON.stringify({ env: { DEEPSEEK_API_KEY: 'sk-d-123456789', DEEPSEEK_BASE_URL: 'https://x', ANTHROPIC_MODEL: 'ds' } })
  );
  const r = A.remove({ target: 'deepseek', confirmed: true, removeKeys: true }, env);
  assert.strictEqual(r.keyRemoved, true);
  const doc = readCfg();
  assert.strictEqual(doc.env.DEEPSEEK_API_KEY, undefined);
  assert.strictEqual(doc.env.DEEPSEEK_BASE_URL, undefined);
  assert.strictEqual(doc.env.ANTHROPIC_MODEL, 'ds', 'remove 不清 ANTHROPIC_MODEL —— 实测行为');
  assert.deepStrictEqual(A.list(env).providers, []);
  assert.strictEqual(A.list(env).model, 'ds', 'providers 空但 model 仍回显旧串 —— 实测');
});

test('remove 不存在的 provider → provider not found', () => {
  fs.writeFileSync(A.configPath(env), JSON.stringify({ env: {} }));
  const r = A.remove({ target: 'ghost', confirmed: true }, env);
  assert.strictEqual(r.success, false);
  assert.match(r.error, /provider not found/);
});

test('坏 JSON 让 list 收敛为 {success:false,error}（fail-soft 契约）', () => {
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(A.configPath(env), '{ not valid json ');
  const r = A.list(env);
  assert.strictEqual(r.success, false);
  assert.ok(typeof r.error === 'string' && r.error.length > 0);
});
