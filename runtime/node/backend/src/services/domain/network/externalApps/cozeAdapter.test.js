'use strict';

/**
 * cozeAdapter.test.js — 钉死 coze-studio 每模型一 YAML 模板的适配器（js-yaml，项目内目录）。
 *
 * 为什么这支套件必须存在：coze 的配置目录是**项目内** backend/conf/model/（非用户 home），
 * 无法定位时降级为「回传可写入 YAML、不落盘」而不是猜路径。这条「降级 vs 落盘」分叉，以及
 * 「模板文件名按 model 命名、get/remove 又按传入 target 命名」的命名不对称，是本单元里最容易
 * 让调用方踩空的地方（用 provider id 去 remove 会找不到文件）。全部用 COZE_MODEL_DIR 指到临时目录。
 *
 * 实测更正（与源码注释/直觉不同处，按真实语义钉死）：
 *   · add 的文件名 = _templateName(resolvedModel || id)，即用**模型名**命名；而 remove 用
 *     _templateName(target)。所以删一个以 provider 'deepseek' 添加、model 'cz' 的模板，
 *     target 必须传 'cz'（不是 'deepseek'）——实测钉住这条命名不对称。
 *   · 无 COZE_HOME/COZE_MODEL_DIR → add 返回 {success:true, degraded:true, yaml, suggestedFile}，
 *     且不写任何文件；list 返回 {success:true, providers:[], note:'...未指明'}（非失败）。
 *   · maskKey 对短 key（≤8）返回 '****'：故 degraded 回显 keyMasked 可能就是 '****'，非泄露。
 *   · list/usable 无目录或目录不存在 → {success:true, providers:[]}（空而非错）。
 *   · add merge：已存模板保留原 id（首次为 100001），只更新 conn_config 目标字段。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const A = require('./cozeAdapter');

let BASE;
let env;
before(() => {
  BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-xa-coze-'));
  env = { COZE_MODEL_DIR: path.join(BASE, 'model'), HOME: BASE };
  fs.mkdirSync(env.COZE_MODEL_DIR, { recursive: true });
});
after(() => {
  try {
    fs.rmSync(BASE, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function files() {
  return fs.readdirSync(env.COZE_MODEL_DIR);
}

test('导出面恰为 configPath/list/get/add/remove/usable', () => {
  assert.deepStrictEqual(Object.keys(A).sort(), ['add', 'configPath', 'get', 'list', 'remove', 'usable'].sort());
});

test('configPath 语义=模板目录；两个 env 皆无时 _modelDir 为 null → configPath 返回空串', () => {
  assert.strictEqual(A.configPath(env), env.COZE_MODEL_DIR);
  assert.strictEqual(A.configPath({ COZE_HOME: '/h' }), path.join(path.join('/h', 'backend'), 'conf', 'model'));
  assert.strictEqual(A.configPath({ HOME: '/h' }), '');
});

test('list：无目录 note 提示；有目录无匹配文件 → providers:[]（皆 success:true）', () => {
  const noDir = A.list({ HOME: '/h' });
  assert.strictEqual(noDir.success, true);
  assert.match(noDir.note, /未指明/);
  assert.deepStrictEqual(A.list(env), { success: true, app: 'coze', providers: [], model: '' });
});

test('add 降级：无项目根 → success:true, degraded, yaml 文本, 不落盘', () => {
  const before = files().length;
  const r = A.add({ provider: 'deepseek', model: 'cz', apiKey: 'sk-c', endpoint: 'https://c' }, { HOME: '/h' });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.degraded, true);
  assert.strictEqual(r.suggestedFile, 'model_template_cz.yaml');
  assert.ok(/conn_config/.test(r.yaml), '降级须回传可写入 YAML 文本');
  assert.strictEqual(r.keyMasked, '****', '短 key 脱敏为 ****（非泄露）');
  assert.strictEqual(files().length, before, '降级绝不写盘');
});

test('add 落盘：写 model_template_<model>.yaml，结构含 meta.conn_config', () => {
  const r = A.add({ provider: 'deepseek', model: 'cz', apiKey: 'sk-c', endpoint: 'https://c' }, env);
  assert.strictEqual(r.success, true);
  assert.ok(!r.degraded);
  assert.deepStrictEqual(files(), ['model_template_cz.yaml']);
  const text = fs.readFileSync(path.join(env.COZE_MODEL_DIR, 'model_template_cz.yaml'), 'utf8');
  assert.match(text, /base_url: 'https:\/\/c'/);
  assert.match(text, /api_key: sk-c/);
});

test('add merge：重复添加保留原 id，只更新 conn_config', () => {
  A.add({ provider: 'deepseek', model: 'cz', apiKey: 'sk-c', endpoint: 'https://c' }, env);
  A.add({ provider: 'deepseek', model: 'cz', apiKey: 'sk-c2', endpoint: 'https://c2' }, env);
  assert.strictEqual(files().length, 1, 'upsert 同名文件，不新增');
  const u = A.usable(env).providers[0];
  assert.strictEqual(u.endpoint, 'https://c2');
  assert.strictEqual(u.apiKey, 'sk-c2');
});

test('get/usable 反读：id 取模板 name，apiKey 取 conn_config.api_key（含真 key 不脱敏）', () => {
  A.add({ provider: 'deepseek', model: 'cz', apiKey: 'sk-real-key', endpoint: 'https://c' }, env);
  const g = A.get('cz', env);
  assert.strictEqual(g.success, true);
  assert.strictEqual(g.provider.endpoint, 'https://c');
  assert.strictEqual(A.usable(env).providers[0].apiKey, 'sk-real-key');
});

test('实测钉住：get/remove 用 target 命名文件；以 provider id 去 get 会 miss（命名不对称）', () => {
  A.add({ provider: 'deepseek', model: 'onlymodel', apiKey: 'sk-k12345678', endpoint: 'https://e' }, env);
  assert.strictEqual(A.get('onlymodel', env).success, true, '按 model 名命中');
  assert.strictEqual(A.get('deepseek', env).success, false, '按 provider id 落空 —— 文件是 model_template_onlymodel.yaml');
  const rm = A.remove({ target: 'deepseek', confirmed: true }, env);
  assert.strictEqual(rm.success, false, 'remove 也按 _templateName(target) 定位，provider id 删不掉');
  assert.ok(files().includes('model_template_onlymodel.yaml'), '文件仍在');
});

test('remove 未 confirmed → preview；确认后 unlinkSync 删文件', () => {
  A.add({ provider: 'deepseek', model: 'todel', apiKey: 'sk-k12345678', endpoint: 'https://e' }, env);
  assert.ok(files().includes('model_template_todel.yaml'));
  const pv = A.remove({ target: 'todel' }, env);
  assert.strictEqual(pv.preview, true);
  assert.ok(files().includes('model_template_todel.yaml'), '预览不得删文件');
  const r = A.remove({ target: 'todel', confirmed: true }, env);
  assert.strictEqual(r.confirmed, true);
  assert.ok(!files().includes('model_template_todel.yaml'));
});

test('get/remove 目标不存在 → template not found；缺 target → target is required', () => {
  assert.match(A.get('ghost', env).error, /template not found/);
  assert.match(A.remove({ target: 'ghost', confirmed: true }, env).error, /template not found/);
  assert.match(A.remove({}, env).error, /target is required/);
});

test('坏 YAML fail-soft：list 对损坏模板收敛为 {success:false,error}', () => {
  fs.writeFileSync(path.join(env.COZE_MODEL_DIR, 'model_template_bad.yaml'), '\t: : : broken: [\n');
  const r = A.list(env);
  assert.strictEqual(r.success, false);
  assert.ok(r.error.length > 0);
  fs.unlinkSync(path.join(env.COZE_MODEL_DIR, 'model_template_bad.yaml'));
});
