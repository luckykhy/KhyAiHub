'use strict';

/**
 * zcodeAdapter.test.js — 钉死 ZCode `~/.zcode/cli/config.json` 适配器：登录门槽位、内联密钥、
 * wire kind 白名单、双角色 model 引用、usable 的「有 key 才算可用」过滤。
 *
 * 为什么这支套件必须存在：ZCode 的安全方向与其它 adapter 明确相反——它把密钥**内联落盘**
 * （上游登录门要求 options.apiKey 非空），并写后 POSIX chmod 0600。因此本 adapter 有两道
 * 「拒绝写入」的门（槽位 + kind），必须钉它们 **fail-closed**：不合格槽位/不支持 kind 直接
 * {success:false, 拒绝写入}，绝不写半截。文件头称「登录门仅 zai/bigmodel 认可内联 key」——
 * 实测这条拒绝方向与文档一致，是本单元里少见的「文档说的失败方向 = 实测失败方向」的正例，
 * 值得专门钉住（对照 commandCode/ycode 只写 env 引用的相反策略）。
 *
 * 实测更正（与源码注释/直觉不同处，按真实语义钉死）：
 *   · 槽位不在 GATE_SLOTS（zai/bigmodel）→ 拒绝写入；kind 不在 KINDS → 拒绝。两道门均 fail-closed。
 *   · kindForProtocol 兜底 'anthropic'（未知协议如 gemini/'' → anthropic，而非报错）。
 *   · _modelIdOf('khy/glm-4') 取斜杠后段 'glm-4'；main/lite 双角色写成 `<slot>/<modelId>`。
 *   · add 无 key：写端点/模型但带 warning，keyWritten=false，且**保留**既有内联 key（不覆盖）。
 *   · usable 只列 options.apiKey 非空的 provider（无 key 的槽位被过滤掉，与 hasKey 视图口径不同）。
 *   · remove 清槽位并删 model.main/lite 中以 `<slot>/` 开头的角色。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const A = require('./zcodeAdapter');

let BASE;
let env;
before(() => {
  BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-xa-zcode-'));
  env = { ZCODE_CLI_CONFIG_FILE: path.join(BASE, 'z', 'config.json'), HOME: BASE };
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

test('导出面恰为 9 个（含 GATE_SLOTS / KINDS / kindForProtocol）', () => {
  assert.deepStrictEqual(Object.keys(A).sort(), [
    'GATE_SLOTS', 'KINDS', 'add', 'configPath', 'get', 'kindForProtocol', 'list', 'remove', 'usable',
  ].sort());
});

test('configPath：ZCODE_CLI_CONFIG_FILE 覆盖，否则 ~/.zcode/cli/config.json', () => {
  assert.strictEqual(A.configPath({ ZCODE_CLI_CONFIG_FILE: '/z/c.json' }), '/z/c.json');
  assert.strictEqual(A.configPath({ HOME: '/hh' }), path.join(path.join('/hh', '.zcode'), path.join('cli', 'config.json')));
});

test('GATE_SLOTS / KINDS 常量集合', () => {
  assert.deepStrictEqual([...A.GATE_SLOTS], ['zai', 'bigmodel']);
  assert.deepStrictEqual([...A.KINDS], ['anthropic', 'openai-compatible', 'openai']);
});

test('kindForProtocol：anthropic→anthropic，openai/responses→openai-compatible，其余兜底 anthropic', () => {
  assert.strictEqual(A.kindForProtocol('anthropic'), 'anthropic');
  assert.strictEqual(A.kindForProtocol('openai'), 'openai-compatible');
  assert.strictEqual(A.kindForProtocol('openai_responses'), 'openai-compatible');
  assert.strictEqual(A.kindForProtocol('gemini'), 'anthropic');
  assert.strictEqual(A.kindForProtocol(''), 'anthropic');
});

test('fail-closed 门 1：非登录门槽位 → 拒绝写入（不落盘、success:false）', () => {
  const r = A.add({ slot: 'myprovider', apiKey: 'sk-x', endpoint: 'https://x' }, env);
  assert.strictEqual(r.success, false);
  assert.match(r.error, /不满足 zcode 登录门/);
  assert.strictEqual(fs.existsSync(A.configPath(env)), false, '被拒时不得创建配置文件');
});

test('fail-closed 门 2：不支持的 wire kind → 拒绝写入', () => {
  const r = A.add({ kind: 'xml', apiKey: 'sk-x' }, env);
  assert.strictEqual(r.success, false);
  assert.match(r.error, /不支持的 wire kind/);
});

test('add：内联 apiKey 落盘 + apiKeyRequired + main/lite 双角色（_modelIdOf 取斜杠后段）', () => {
  const r = A.add({ provider: '智谱', model: 'khy/glm-4', apiKey: 'sk-z-1234567890', endpoint: 'https://z/v4' }, env);
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.model, 'glm-4');
  assert.strictEqual(r.keyWritten, true);
  const zai = readCfg().provider.zai;
  assert.strictEqual(zai.options.apiKey, 'sk-z-1234567890');
  assert.strictEqual(zai.options.apiKeyRequired, true);
  assert.deepStrictEqual(Object.keys(zai.models), ['glm-4']);
  assert.deepStrictEqual(readCfg().model, { main: 'zai/glm-4', lite: 'zai/glm-4' });
});

test('add 无 key：warning + 保留既有内联 key（不覆盖）', () => {
  A.add({ model: 'm1', apiKey: 'sk-existing-123456', endpoint: 'https://z' }, env);
  const before = readCfg().provider.zai.options.apiKey;
  const r = A.add({ model: 'm2', endpoint: 'https://z' }, env);
  assert.ok(/未提供密钥/.test(r.warning), '无 key 须回 warning');
  assert.strictEqual(r.keyWritten, false);
  assert.strictEqual(readCfg().provider.zai.options.apiKey, before, '既有内联 key 保持不变');
});

test('list/get/usable：usable 仅列有 apiKey 的槽位（bigmodel 无 key 被过滤）', () => {
  A.add({ slot: 'zai', model: 'a', apiKey: 'sk-a-12345678', endpoint: 'https://a' }, env);
  A.add({ slot: 'bigmodel', model: 'b', endpoint: 'https://b' }, env);
  const u = A.usable(env);
  assert.deepStrictEqual(u.providers.map((p) => p.id), ['zai'], 'bigmodel 无内联 key → 被 usable 过滤');
  assert.strictEqual(A.list(env).providers.length, 2);
  assert.strictEqual(A.get('zai', env).provider.isGateSlot, true);
  assert.strictEqual(A.get('ghost', env).success, false);
});

test('remove：默认槽位 zai；未 confirmed → preview；确认后清槽位 + 指向它的 model 角色', () => {
  A.add({ slot: 'zai', model: 'a', apiKey: 'sk-a-12345678', endpoint: 'https://a' }, env);
  assert.ok(readCfg().model.main);
  const pv = A.remove({}, env);
  assert.strictEqual(pv.preview, true);
  assert.ok(readCfg().provider.zai, '预览不删');
  const r = A.remove({ target: 'zai', confirmed: true }, env);
  assert.strictEqual(r.confirmed, true);
  assert.ok(!readCfg().provider.zai);
  assert.deepStrictEqual(readCfg().model, {}, 'main/lite 均指 zai/ → 清空');
});

test('remove 不存在槽位 → provider slot not found；坏 JSON fail-soft', () => {
  assert.match(A.remove({ target: 'nope', confirmed: true }, env).error, /provider slot not found/);
  fs.writeFileSync(A.configPath(env), '{bad');
  assert.strictEqual(A.list(env).success, false);
});
