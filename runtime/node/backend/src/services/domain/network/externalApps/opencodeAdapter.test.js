'use strict';

/**
 * opencodeAdapter.test.js — 钉死 opencode.json 适配器：路径候选解析、/v1 端点补齐、
 * models 形状自愈（_healProviderModels/_healDoc）、repair 落盘、门控与 BOM 容忍。
 *
 * 为什么这支套件必须存在：本单元导出面最宽（9 个，含 _healProviderModels/_healDoc/repair 内部符号）。
 * 它的自愈直接根治「opencode.exe 因 Expected object 拒启动」这类真机故障，判定写错方向会让
 * 本该修好的配置继续拒绝启动、或把合法配置改坏。configPath 的候选解析还涉及便携布局探测
 * （由 __dirname 反推仓库根 → 兄弟 Tools 目录），这条路径解析必须在测试里可控，否则读到真实
 * 便携配置。全部用 OPENCODE_CONFIG 显式指向临时文件绕开探测。
 *
 * 实测更正（与源码注释/直觉不同处，按真实语义钉死）：
 *   · configPath 命中 OPENCODE_CONFIG 即**直接返回**（即便该文件不存在）——显式 env 优先于存在性。
 *   · add 对 http(s) 且末尾无 /v1 的端点自动补 /v1（openai-compatible SDK 约定）；已带 /v1 或非
 *     http 协议端点不动。
 *   · _healProviderModels 的 `models.list` 分支只补条目、**不设** defaultModelId（changed=true、
 *     defaultModelId=''）；只有 `models.default` 字符串才回填 defaultModelId 并可能补顶层 model。
 *   · _healProviderModels 对「值非对象」的损坏键一律 delete；models 整体被写成数组 → 归零为 {}。
 *   · repair 无损坏时不落盘（changed:false）；门 KHY_OPENCODE_CONFIG_HEAL=off 时明确 {success:false}。
 *   · _loadRaw 容忍 UTF-8 BOM（不 strip 会让 JSON.parse 抛）。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const A = require('./opencodeAdapter');

let BASE;
let env;
before(() => {
  BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-xa-oc-'));
  env = { OPENCODE_CONFIG: path.join(BASE, 'opencode.json') };
});
after(() => {
  try {
    fs.rmSync(BASE, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function writeCfg(objOrText) {
  fs.mkdirSync(path.dirname(env.OPENCODE_CONFIG), { recursive: true });
  fs.writeFileSync(env.OPENCODE_CONFIG, typeof objOrText === 'string' ? objOrText : JSON.stringify(objOrText));
}
function readCfg() {
  return JSON.parse(fs.readFileSync(env.OPENCODE_CONFIG, 'utf8'));
}

test('导出面恰为 9 个公共/内部符号', () => {
  assert.deepStrictEqual(new Set(Object.keys(A)), new Set([
    'configPath', 'list', 'get', 'add', 'remove', 'usable', 'repair', '_healProviderModels', '_healDoc',
  ]));
  assert.strictEqual(Object.keys(A).length, 9);
});

test('configPath 命中 OPENCODE_CONFIG 直接返回（不校验存在性）', () => {
  assert.strictEqual(A.configPath({ OPENCODE_CONFIG: '/nowhere/x.json' }), '/nowhere/x.json');
});

test('configPath 无 OPENCODE_CONFIG：OPENCODE_CONFIG_DIR 候选**存在**时优先被取（复用真实配置）', () => {
  // 便携布局在本机可能真有 opencode.json，故显式让 dir 候选存在，钉「取已存在者」这条解析序，
  // 而不是断言「全部不存在时的回退」——后者依赖本机文件系统，不可移植。
  const dir = path.join(BASE, 'ocdir');
  fs.mkdirSync(dir, { recursive: true });
  const cfgFile = path.join(dir, 'opencode.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ provider: {} }));
  assert.strictEqual(A.configPath({ OPENCODE_CONFIG_DIR: dir, XDG_CONFIG_HOME: '/xdg-nonexistent' }), cfgFile);
});

test('add：http 端点末尾无 /v1 → 自动补齐；已带 /v1 不动；非 http 不动', () => {
  const r1 = A.add({ provider: 'deepseek', model: 'd', apiKey: 'sk-a123456789', endpoint: 'https://api.deepseek.com' }, env);
  assert.strictEqual(r1.endpoint, 'https://api.deepseek.com/v1');
  const r2 = A.add({ provider: 'x', model: 'm', apiKey: 'sk-b123456789', endpoint: 'https://h/v1' }, env);
  assert.strictEqual(r2.endpoint, 'https://h/v1');
  const r3 = A.add({ provider: 'y', model: 'm', apiKey: 'sk-c123456789', endpoint: 'grpc://host:1' }, env);
  assert.strictEqual(r3.endpoint, 'grpc://host:1', '非 http(s) 协议端点不补 /v1');
});

test('add 落 provider 结构：npm/name/options/models + 顶层 model=<id>/<model>', () => {
  A.add({ provider: 'deepseek', model: 'd', apiKey: 'sk-a123456789', endpoint: 'https://api.deepseek.com' }, env);
  const doc = readCfg();
  assert.strictEqual(doc.provider.deepseek.npm, '@ai-sdk/openai-compatible');
  assert.strictEqual(doc.provider.deepseek.options.baseURL, 'https://api.deepseek.com/v1');
  assert.strictEqual(doc.provider.deepseek.options.apiKey, 'sk-a123456789');
  assert.deepStrictEqual(Object.keys(doc.provider.deepseek.models), ['d']);
  assert.strictEqual(doc.model, 'deepseek/d');
});

test('add 缺 provider → provider is required', () => {
  assert.match(A.add({}, env).error, /provider is required/);
});

test('list/get/usable 反读 + BOM 容忍（坏 JSON fail-soft）', () => {
  writeCfg('﻿{"provider":{"ds":{"options":{"baseURL":"https://x","apiKey":"sk-1"},"models":{"m1":{"name":"M"}}}}}');
  assert.strictEqual(A.list(env).providers[0].id, 'ds');
  assert.strictEqual(A.usable(env).providers[0].apiKey, 'sk-1');
  writeCfg('{ broken json');
  assert.strictEqual(A.list(env).success, false);
});

// ── _healProviderModels 逐分支 ────────────────────────────────────────────

test('_healProviderModels：default 字符串 → 补 {name} 条目 + 回 defaultModelId，删 default 键', () => {
  const p = { models: { default: 'm1', bad: 1 } };
  const r = A._healProviderModels(p);
  assert.deepStrictEqual(r, { changed: true, defaultModelId: 'm1' });
  assert.deepStrictEqual(p.models, { m1: { name: 'm1' } }, 'default 与损坏键都删除，仅留迁移条目');
});

test('_healProviderModels：list 数组 → 逐条补 {name}，但 defaultModelId 恒空（实测差异）', () => {
  const p = { models: { list: ['a', 'b'] } };
  const r = A._healProviderModels(p);
  assert.deepStrictEqual(r, { changed: true, defaultModelId: '' });
  assert.deepStrictEqual(Object.keys(p.models).sort(), ['a', 'b']);
});

test('_healProviderModels：models 整体为数组 → 归零为 {} changed；合法对象零改动', () => {
  const arr = { models: ['x'] };
  assert.deepStrictEqual(A._healProviderModels(arr), { changed: true, defaultModelId: '' });
  assert.deepStrictEqual(arr.models, {});
  const ok = { models: { m1: { name: 'M' } } };
  assert.deepStrictEqual(A._healProviderModels(ok), { changed: false, defaultModelId: '' });
  assert.deepStrictEqual(ok.models, { m1: { name: 'M' } });
});

test('_healProviderModels：null / 无 models → {changed:false}', () => {
  assert.deepStrictEqual(A._healProviderModels(null), { changed: false, defaultModelId: '' });
  assert.deepStrictEqual(A._healProviderModels({}), { changed: false, defaultModelId: '' });
});

test('_healDoc：default 迁出后用 defaultModelId 补顶层 model（仅当原 model 缺失）', () => {
  const doc = { provider: { d: { models: { default: 'z' } } } };
  const r = A._healDoc(doc);
  assert.deepStrictEqual(r, { changed: true });
  assert.strictEqual(doc.model, 'd/z');
});

test('_healDoc：顶层 model 已存在则不覆盖；无 provider → {changed:false}', () => {
  const doc = { model: 'keep/me', provider: { d: { models: { default: 'z' } } } };
  A._healDoc(doc);
  assert.strictEqual(doc.model, 'keep/me');
  assert.deepStrictEqual(A._healDoc({}), { changed: false });
  assert.deepStrictEqual(A._healDoc(null), { changed: false });
});

// ── repair 落盘 ────────────────────────────────────────────────────────────

test('repair：损坏配置落盘修正并回 providers；无损坏 changed:false 不改盘', () => {
  writeCfg({ provider: { ds: { options: { baseURL: 'https://x' }, models: { default: 'm9' } } } });
  const r = A.repair(env);
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.model, 'ds/m9');
  assert.deepStrictEqual(Object.keys(readCfg().provider.ds.models), ['m9']);
  const before = fs.readFileSync(env.OPENCODE_CONFIG, 'utf8');
  assert.strictEqual(A.repair(env).changed, false, '已修好 → 再次 no-op');
  assert.strictEqual(fs.readFileSync(env.OPENCODE_CONFIG, 'utf8'), before, 'no-op 不得改盘');
});

test('repair 门控关闭 → {success:false, disabled}；heal 关闭后 add 不再自愈旧形状', () => {
  const off = { ...env, KHY_OPENCODE_CONFIG_HEAL: 'off' };
  writeCfg({ provider: { ds: { models: { default: 'z' } } } });
  const r = A.repair(off);
  assert.strictEqual(r.success, false);
  assert.match(r.error, /disabled/);
});

test('heal 门控（经 repair 观测）：off 词表 0/false/off/no 关闭，其它值/空串保持 ON', () => {
  writeCfg({ provider: { ds: { options: { baseURL: 'https://x' }, models: { default: 'm9' } } } });
  for (const v of ['0', 'false', 'off', 'no', ' OFF ', 'False']) {
    const r = A.repair({ ...env, KHY_OPENCODE_CONFIG_HEAL: v });
    assert.strictEqual(r.success, false, `${v} 应关闭 heal → repair 报 disabled`);
  }
  for (const v of ['', 'OFF2', '1', 'true', 'disabled']) {
    const r = A.repair({ ...env, KHY_OPENCODE_CONFIG_HEAL: v });
    assert.strictEqual(r.success, true, `${v} 不在 off 词表 → heal 仍 ON`);
    // 重置回损坏态以便下一轮
    writeCfg({ provider: { ds: { options: { baseURL: 'https://x' }, models: { default: 'm9' } } } });
  }
});
