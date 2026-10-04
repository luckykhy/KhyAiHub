'use strict';

/**
 * traeAppAdapter.test.js — 钉死 Trae 桥接适配器，重点记录其 env 隔离缝「形同虚设」的缺陷。
 *
 * 为什么这支套件必须存在：本 adapter 不自己写 live 配置，而是桥接 switch-center 的 profile 存储
 * （trae_switch_profiles.json）。它对外承诺与别的 adapter 一样的 `env` 注入语义，但实测发现
 * list/get/add/remove 传给内部的 `_readStore(env)`，而 `_readStore` 的签名**不收参数**、内部调用
 * `configPath()`（默认 process.env）——于是这四个方法的 env 形参被完全忽略，只有 configPath/usable
 * 真正尊重 env。这是「安全/隔离缝看起来在、其实没接上」的典型，必须钉，否则测试与调用方都会被
 * 「传了 env 就以为隔离了」误导。本套件因此改走 process.env.TRAE_SWITCH_STORE_PATH 做隔离。
 *
 * 实测更正（已注册缺陷，按真实语义钉死）：
 *   · traeAppAdapter.js:47 `_readStore()` 无参、:99/:117/:161/:240 却以 `_readStore(env)` 调用
 *     —— env 被丢弃；四个方法**只认 process.env**。
 *   · 但 configPath(env) / usable(env) 尊重 env（读 env.TRAE_SWITCH_STORE_PATH）。同文件里 env
 *     语义前后不一致，正是缺陷本体。
 *   · remove 方向与其它 adapter 相反：未 confirmed → **硬失败** {success:false, 'remove requires
 *     {confirmed:true}'}（fail-closed），而非别家的 preview success。这与本文件头「必须显式
 *     confirmed:true」一致——是它独有的更严的删除闸门，钉住以防被「统一成 preview」误改。
 *   · usable(env) 返回 **布尔**（非 {success,providers} 对象）——契约与其它 adapter 不一致。
 *   · endpoint 末尾斜杠被剥（`https://t/v1/` → `https://t/v1`）。
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const A = require('./traeAppAdapter');

let BASE;
let STORE;
const PREV_STORE_PATH = process.env.TRAE_SWITCH_STORE_PATH;
before(() => {
  BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-xa-trae-'));
  STORE = path.join(BASE, 'trae', 'trae_switch_profiles.json');
});
beforeEach(() => {
  // _readStore 只认 process.env，故隔离必须落在这里，而不是靠给方法传 env。
  process.env.TRAE_SWITCH_STORE_PATH = STORE;
  try {
    fs.rmSync(STORE, { force: true });
  } catch {
    /* noop */
  }
});
after(() => {
  if (PREV_STORE_PATH === undefined) delete process.env.TRAE_SWITCH_STORE_PATH;
  else process.env.TRAE_SWITCH_STORE_PATH = PREV_STORE_PATH;
  try {
    fs.rmSync(BASE, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function readStore() {
  return JSON.parse(fs.readFileSync(STORE, 'utf8'));
}

test('导出面恰为 7 个（含 APP 常量）', () => {
  assert.deepStrictEqual(Object.keys(A).sort(), ['APP', 'add', 'configPath', 'get', 'list', 'remove', 'usable'].sort());
});

test('configPath(env) 尊重 env.TRAE_SWITCH_STORE_PATH 覆盖', () => {
  assert.strictEqual(A.configPath({ TRAE_SWITCH_STORE_PATH: '/z/s.json' }), '/z/s.json');
});

test('已注册缺陷：list/get/add 的 env 形参被忽略 —— 传任意 env 仍读 process.env 指向的存储', () => {
  // 故意传一个「看起来在隔离」的 env（指向不存在路径），实测它被丢弃、仍命中 process.env 的 STORE。
  process.env.TRAE_SWITCH_STORE_PATH = STORE;
  A.add({ provider: 'Marker', model: 'm', apiKey: 'sk-t-1234567890', endpoint: 'https://t/v1' }, { TRAE_SWITCH_STORE_PATH: '/ignored/nope.json' });
  assert.ok(fs.existsSync(STORE), 'add 写的是 process.env 的 STORE，而非 env 里给的 ignored 路径');
  assert.ok(!fs.existsSync('/ignored/nope.json'), 'env 里给的 ignored 路径根本没被使用');
  const l = A.list({ TRAE_SWITCH_STORE_PATH: '/ignored/nope.json' });
  assert.strictEqual(l.providers.length, 1, 'list 的 env 同样被忽略，仍见 process.env 存储');
});

test('add：落 profile（id 规整、endpoint 去尾斜杠、默认激活），detail 回脱敏', () => {
  const r = A.add({ provider: 'My Trae', model: 'm1', apiKey: 'sk-trae-1234567890', endpoint: 'https://t/v1/' });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.detail.id, 'my-trae');
  assert.strictEqual(r.detail.endpoint, 'https://t/v1', '末尾斜杠被剥');
  assert.strictEqual(r.detail.keyMasked, 'sk-tra…7890');
  assert.strictEqual(r.detail.active, true);
  const s = readStore();
  assert.strictEqual(s.activeId, 'my-trae');
  assert.strictEqual(s.profiles[0].key, 'sk-trae-1234567890');
});

test('add 缺 name/id → 校验失败；缺 endpoint → endpoint is required（fail-closed）', () => {
  assert.match(A.add({ endpoint: 'https://e' }).error, /provider \(或 id\) is required/);
  assert.match(A.add({ provider: 'p' }).error, /endpoint is required/);
});

test('add activate=false：不激活（activeId 保持原值）', () => {
  A.add({ id: 'first', endpoint: 'https://a' });
  A.add({ id: 'second', endpoint: 'https://b', activate: false });
  assert.strictEqual(readStore().activeId, 'first');
});

test('add 同名（name 匹配）视为更新，保留 createdAt、追加去重 models', () => {
  A.add({ provider: 'Same', model: 'a', endpoint: 'https://s' });
  const r = A.add({ provider: 'Same', model: 'b', endpoint: 'https://s2' });
  assert.strictEqual(r.detail.updated, true);
  assert.strictEqual(readStore().profiles.length, 1);
  assert.deepStrictEqual(readStore().profiles[0].models, ['a', 'b']);
});

test('get 命中（id 或 name，大小写不敏感）/未命中', () => {
  A.add({ provider: 'FindMe', model: 'x', endpoint: 'https://f' });
  assert.strictEqual(A.get('findme').success, true);
  assert.strictEqual(A.get('FINDME').provider.id, 'findme');
  assert.strictEqual(A.get('ghost').success, false);
});

test('实测钉住：remove 未 confirmed → 硬失败（fail-closed，区别于其它 adapter 的 preview 成功）', () => {
  A.add({ id: 'gone', endpoint: 'https://g' });
  const r = A.remove('gone', {});
  assert.strictEqual(r.success, false);
  assert.match(r.error, /remove requires \{confirmed:true\}/);
  assert.ok(readStore().profiles.some((p) => p.id === 'gone'), '未确认绝不删');
});

test('remove confirmed 删 profile；若删的是 activeId 则清空 activeId', () => {
  A.add({ id: 'active-one', endpoint: 'https://a' });
  const r = A.remove('active-one', { confirmed: true });
  assert.strictEqual(r.detail.removed, 'active-one');
  assert.strictEqual(readStore().activeId, '');
});

test('实测钉住：usable 返回布尔（非 {success,providers} 对象），与其它 adapter 契约不一致', () => {
  assert.strictEqual(typeof A.usable({ TRAE_SWITCH_STORE_PATH: '/x/y.json' }), 'boolean');
  assert.strictEqual(A.usable({ TRAE_SWITCH_STORE_PATH: '/x/y.json' }), true);
});

test('坏 JSON：list 收敛为 {success:false,...error}（fail-soft）', () => {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, '{ broken');
  const r = A.list();
  assert.strictEqual(r.success, false);
  assert.ok(typeof r.error === 'string' && r.error.length > 0);
});
