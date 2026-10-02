'use strict';

/**
 * appModelImporter.test.js — 钉死外部 app 模型「消费侧」薄壳：门控方向、poolKey 规整、
 * 从 adapter.usable 抽 provider → registrar 的字段映射、跳过规则、dryRun 与 unimport 撤销。
 *
 * 为什么这支套件必须存在：本模块是把 externalApps/*Adapter 逆向读到的真 key+endpoint 一次性
 * 灌进 customProviderRegistrar 的入口——它决定「哪些外部软件的模型可以被 khy 用」以及
 * 「注册失败时到底拒不拒」。它同时是**安全边界**：门控 env 缺信息 fail-open（授予），
 * registrar 不可用 fail-closed（拒绝）；两种 fail 方向都在 header 里明写，但代码只测 env 侧、
 * 未测 registrar 侧，且 flagRegistry 与 CANON 双路径的**实际生效路径**在本机构建里只有前者。
 * 加上 registerCustomProvider 的入参形状（displayName/poolKey/keyInput/tier/ensureInit）
 * 是对下游全局池 + .env 的一次性写入合同，任何字段漂都会污染 khy 池而不报错——所以逐条钉。
 *
 * 实测更正（与源码注释/直觉不同处，按真实语义钉死）：
 *   · `isEnabled` 在本机构建走 flagRegistry.isFlagEnabled（require 成功），CANON 本地兜底
 *     `_FALSY.has(v)` 分支**从未执行**（是 dead code path）；两者对 {off,0,false,no} 判定相同，
 *     对未设/空串/garbage 都 fail-open。header 声称的「flagRegistry 优先 + CANON 兜底」在
 *     本机构建里等价于「只走 flagRegistry」。
 *   · `discover`/`importApp` 的 error message 里 `${app || '(空)'}` 用的是**原始大小写**参数
 *     （如 'NoSuchApp'），而对象的 `app` 字段用 `_normApp(app)`（小写）——两处**不同源**，
 *     容易在 UI 上出现「同一次调用两个大小写」。
 *   · 缺 registrar（未注入）时 `deps.registrar || _defaultRegistrar()` 会加载真实
 *     customProviderRegistrar 并**真的写全局池**——测试绝不能走这条路径；因此对 registrar
 *     缺失的 fail-closed 只测「注入 `{}`（对象但无函数）」这条支，观测 `{error:'...不可用'}`。
 *   · `unimport` gated-off 与 `importApp` gated-off 返回体形状**不同**：unimport 无
 *     imported/skipped 字段；importApp 附 imported:[] skipped:[]。
 *   · _poolKey 里点号会被替换成 `-`（如 `x.y` → `x-y`），且首尾 `-` 会被 strip；
 *     非 [a-z0-9] 的连续段被压成一个 `-`。
 */

// 关键安全前置：必须在 require 任何会读写数据主目录的模块之前把两把数据家钉到本次 mkdtemp
// 分配的独立目录，绝不污染用户真实 .khy/。
const fs = require('fs');
const os = require('os');
const path = require('path');
const DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-xa-importer-data-'));
process.env.KHY_DATA_HOME = DATA_HOME;
process.env.KHY_PROJECT_DATA_HOME = DATA_HOME;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const IMP = require('./appModelImporter');

// 一份可控 openclaw 家目录（OPENCLAW_HOME env-only 覆盖，绝不落真实 ~/.openclaw）。
let FAKE_HOME;
let OC_ENV;
before(() => {
  FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-xa-importer-home-'));
  OC_ENV = { ...process.env, OPENCLAW_HOME: FAKE_HOME, KHY_EXTERNAL_APP_IMPORT: '1' };
});
after(() => {
  for (const d of [DATA_HOME, FAKE_HOME]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

/** 写一份 openclaw.json（models.providers）+ 旁路 .env，供 usable 反向读取。 */
function seedOpenclaw(providers, envMap = {}) {
  fs.writeFileSync(
    path.join(FAKE_HOME, 'openclaw.json'),
    JSON.stringify({ models: { providers } }, null, 2) + '\n'
  );
  const lines = Object.entries(envMap).map(([k, v]) => `${k}=${v}`).join('\n');
  fs.writeFileSync(path.join(FAKE_HOME, '.env'), lines ? lines + '\n' : '');
}

/** 一个只记录调用、不写任何东西的假 registrar（对象，两函数齐）。 */
function makeSpy() {
  const calls = [];
  const uncalls = [];
  return {
    calls,
    uncalls,
    registrar: {
      registerCustomProvider: (arg) => {
        calls.push(arg);
        return { poolKey: arg.poolKey, models: [arg.defaultModel, ...(arg.extraModels || [])], endpoint: arg.endpoint };
      },
      unregisterCustomProvider: (pk, opts) => {
        uncalls.push({ pk, opts });
        return { unregistered: pk, removeKeys: opts.removeKeys };
      },
    },
  };
}

// ── 导出面 ─────────────────────────────────────────────────────────────────
test('导出面恰为 isEnabled/discover/discoverAll/importApp/importAll/unimport/APPS/_poolKey', () => {
  assert.deepStrictEqual(
    Object.keys(IMP).sort(),
    ['APPS', '_poolKey', 'discover', 'discoverAll', 'importAll', 'importApp', 'isEnabled', 'unimport'].sort()
  );
});

test('APPS 恰 6 项、固定顺序（与 _ADAPTERS 键序同源）', () => {
  assert.deepStrictEqual(IMP.APPS, ['opencode', 'openclaw', 'claude-code', 'reasonix', 'deepseek-tui', 'coze']);
});

// ── _poolKey 规整 ──────────────────────────────────────────────────────────
test('_poolKey 规整：空格→`-`、点→`-`、大写→小写、首尾 strip', () => {
  assert.strictEqual(IMP._poolKey('OpenCode', 'Deep Seek'), 'opencode-deep-seek');
  assert.strictEqual(IMP._poolKey('claude-code', 'x.y'), 'claude-code-x-y');
  assert.strictEqual(IMP._poolKey('--Foo--', '--Bar--'), 'foo-bar');
  assert.strictEqual(IMP._poolKey('a', ''), 'a');
});

// ── isEnabled: 门控 fail 方向 ──────────────────────────────────────────────
test('门控 fail-open：env 未设/空串/garbage 一律授予（与 header「默认开」一致，实测）', () => {
  assert.strictEqual(IMP.isEnabled({}), true);
  assert.strictEqual(IMP.isEnabled({ KHY_EXTERNAL_APP_IMPORT: '' }), true);
  assert.strictEqual(IMP.isEnabled({ KHY_EXTERNAL_APP_IMPORT: 'xyz' }), true);
  assert.strictEqual(IMP.isEnabled({ KHY_EXTERNAL_APP_IMPORT: 'TRUE' }), true);
  assert.strictEqual(IMP.isEnabled({ KHY_EXTERNAL_APP_IMPORT: '1' }), true);
});

test('门控 off 词表：{0,false,off,no} 全关（大小写无关 + trim）', () => {
  for (const v of ['0', 'false', 'off', 'no', ' OFF ', 'False']) {
    assert.strictEqual(IMP.isEnabled({ KHY_EXTERNAL_APP_IMPORT: v }), false, `off word ${v}`);
  }
});

// ── discover: 门控关 / 未知 app / 空 / 有 provider ────────────────────────
test('discover gated-off：error 用 canonical 中文，providers=[]，app 字段仍规范化', () => {
  const r = IMP.discover('OpenCode', { KHY_EXTERNAL_APP_IMPORT: 'off' });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.app, 'opencode', 'app 字段是 _normApp 后的小写');
  assert.strictEqual(r.error, '外部模型导入已被门控关闭（KHY_EXTERNAL_APP_IMPORT）');
  assert.deepStrictEqual(r.providers, []);
});

test('discover 未知 app：error 里保留原始大小写、app 字段规范化（两处不同源，实测）', () => {
  const r = IMP.discover('NoSuchApp', { KHY_EXTERNAL_APP_IMPORT: '1' });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.app, 'nosuchapp');
  assert.strictEqual(r.error, '不支持的外部软件: NoSuchApp', 'error 用原始 app，与 app 字段不同源');
});

test('discover 空配置：success=true、providers=[]（无 provider 不是错误）', () => {
  // FAKE_HOME 存在但无 openclaw.json 与 .env → _load 返回 {} → providers=[]
  const r = IMP.discover('openclaw', OC_ENV);
  assert.strictEqual(r.success, true);
  assert.deepStrictEqual(r.providers, []);
});

test('discover 有 provider：真 key 只出现于 keyMasked，绝不外漏原文（安全方向）', () => {
  seedOpenclaw(
    { myprov: { baseUrl: 'https://example.test/v1', models: ['m-a', 'm-b'] } },
    { MYPROV_API_KEY: 'sk-secret-1234567890' }
  );
  const r = IMP.discover('openclaw', OC_ENV);
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.providers.length, 1, 'providers 非空——保证本测不是空跑');
  const p = r.providers[0];
  assert.strictEqual(p.id, 'myprov');
  assert.strictEqual(p.endpoint, 'https://example.test/v1');
  assert.strictEqual(p.hasKey, true);
  assert.strictEqual(p.keyMasked, 'sk-s…7890', '_shared.maskKey: 头尾各 4');
  assert.ok(!('apiKey' in p), 'discover 视图绝不回传原文 key（安全）');
  assert.strictEqual(p.defaultModel, 'm-a');
  assert.deepStrictEqual(p.models, ['m-a', 'm-b']);
});

test('discover key 长度 ≤8 走 maskKey 的 **** 分支（短 key 半脱敏）', () => {
  seedOpenclaw({ short: { baseUrl: 'https://s.test/v1', models: ['s-1'] } }, { SHORT_API_KEY: 'abc' });
  const p = IMP.discover('openclaw', OC_ENV).providers[0];
  assert.strictEqual(p.keyMasked, '****');
  assert.strictEqual(p.hasKey, true);
});

// ── importApp: 门控关 / 未知 app / registrar 不可用 ───────────────────────
test('importApp gated-off：附 imported:[] skipped:[] 的空返回', () => {
  const r = IMP.importApp({ app: 'openclaw' }, { KHY_EXTERNAL_APP_IMPORT: 'off' }, { registrar: makeSpy().registrar });
  assert.deepStrictEqual(r, {
    success: false,
    app: 'openclaw',
    error: '外部模型导入已被门控关闭（KHY_EXTERNAL_APP_IMPORT）',
    imported: [],
    skipped: [],
  });
});

test('importApp 未知 app：不支持的外部软件（error 保留原始大小写）', () => {
  const r = IMP.importApp({ app: 'NopeApp' }, { KHY_EXTERNAL_APP_IMPORT: '1' }, { registrar: makeSpy().registrar });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.app, 'nopeapp');
  assert.strictEqual(r.error, '不支持的外部软件: NopeApp');
});

test('importApp registrar 注入 `{}` → fail-closed（customProviderRegistrar 不可用）', () => {
  // 关键安全方向：注入的对象存在但没函数——绝不真调 registrar，也不回落到 _defaultRegistrar。
  const r = IMP.importApp({ app: 'openclaw' }, OC_ENV, { registrar: {} });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error, 'customProviderRegistrar 不可用');
  assert.deepStrictEqual(r.imported, []);
  assert.deepStrictEqual(r.skipped, []);
});

// ── importApp: 完整路径 / dryRun / provider filter / 三条跳过规则 ─────────
test('importApp 完整：字段映射 + 三种 skip 原因；spy 收到真 key 与规整 poolKey', () => {
  seedOpenclaw(
    {
      myprov: { baseUrl: 'https://example.test/v1', models: ['m-a', 'm-b'] },
      nodefault: { baseUrl: 'https://nd.test/v1' },
      noendpoint: { models: ['x'] },
      nokeyprov: { baseUrl: 'https://nk.test/v1', models: ['nk-1'] },
    },
    { MYPROV_API_KEY: 'sk-secret-1234567890' }
  );
  const spy = makeSpy();
  const r = IMP.importApp({ app: 'openclaw' }, OC_ENV, { registrar: spy.registrar });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.imported.length, 1, '非空——确保真跑了一次');
  const im = r.imported[0];
  assert.strictEqual(im.provider, 'myprov');
  assert.strictEqual(im.poolKey, 'openclaw-myprov');
  assert.strictEqual(im.keySource, 'app', 'app 自带 key → keySource=app');
  assert.strictEqual(im.keyMasked, 'sk-s…7890');
  assert.deepStrictEqual(im.models, ['m-a', 'm-b']);
  assert.strictEqual(im.defaultModel, 'm-a');
  assert.ok(!('dryRun' in im), '非 dryRun 时 imported 不带 dryRun 字段');

  // 三条 skip 规则：no model / no endpoint / no key（顺序固定）
  assert.strictEqual(r.skipped.length, 3);
  const reasons = r.skipped.map((s) => s.reason).sort();
  assert.match(reasons[0], /no api key/);
  assert.match(reasons[1], /no endpoint/);
  assert.match(reasons[2], /no model configured/);

  // 只有一次 registrar 调用；字段合同钉死
  assert.strictEqual(spy.calls.length, 1);
  assert.deepStrictEqual(spy.calls[0], {
    displayName: 'openclaw:myprov',
    poolKey: 'openclaw-myprov',
    endpoint: 'https://example.test/v1',
    keyInput: 'sk-secret-1234567890',
    defaultModel: 'm-a',
    extraModels: ['m-b'],
    tier: '',
    ensureInit: true,
  });
});

test('importApp dryRun：imported[].dryRun=true 且 registrar 零调用（预览不污染池）', () => {
  seedOpenclaw({ p: { baseUrl: 'https://d.test/v1', models: ['m'] } }, { P_API_KEY: 'sk-dryrun-key-1' });
  const spy = makeSpy();
  const r = IMP.importApp({ app: 'openclaw', dryRun: true }, OC_ENV, { registrar: spy.registrar });
  assert.strictEqual(r.imported.length, 1);
  assert.strictEqual(r.imported[0].dryRun, true);
  assert.strictEqual(spy.calls.length, 0, 'dryRun 绝不真调 registrar');
});

test('importApp provider filter miss：imported/skipped 都为空（跳过 ≠ 不匹配）', () => {
  seedOpenclaw({ a: { baseUrl: 'https://a.test/v1', models: ['m'] } }, { A_API_KEY: 'sk-a-12345678' });
  const spy = makeSpy();
  const r = IMP.importApp({ app: 'openclaw', provider: 'ghost' }, OC_ENV, { registrar: spy.registrar });
  assert.deepStrictEqual(r.imported, []);
  assert.deepStrictEqual(r.skipped, []);
  assert.strictEqual(spy.calls.length, 0);
});

test('importApp key 借用：app 无 key + preset 有 endpoint → 借 preset 但无 key 仍 skip', () => {
  // provider id 用 'deepseek'（preset.baseUrl 存在），但没配 .env → 池空 → key='' → skip no api key。
  seedOpenclaw({ deepseek: { models: ['deepseek-chat'] } }, {});
  const spy = makeSpy();
  const r = IMP.importApp({ app: 'openclaw' }, OC_ENV, { registrar: spy.registrar });
  assert.strictEqual(r.imported.length, 0);
  assert.strictEqual(spy.calls.length, 0);
  assert.strictEqual(r.skipped.length, 1);
  assert.strictEqual(r.skipped[0].provider, 'deepseek');
  assert.match(r.skipped[0].reason, /no api key/);
});

// ── unimport ───────────────────────────────────────────────────────────────
test('unimport：调用 registrar.unregisterCustomProvider(poolKey, {removeKeys:true})', () => {
  const spy = makeSpy();
  const r = IMP.unimport({ app: 'OpenCode', provider: 'MyProv', removeKeys: true }, { KHY_EXTERNAL_APP_IMPORT: '1' }, { registrar: spy.registrar });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.poolKey, 'opencode-myprov');
  assert.strictEqual(r.removeKeys, true);
  assert.deepStrictEqual(spy.uncalls, [{ pk: 'opencode-myprov', opts: { removeKeys: true } }]);
});

test('unimport gated-off：返回体**不含** imported/skipped（与 importApp 形状不同，实测）', () => {
  const r = IMP.unimport({ app: 'openclaw', provider: 'p' }, { KHY_EXTERNAL_APP_IMPORT: 'off' }, { registrar: makeSpy().registrar });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error, '外部模型导入已被门控关闭（KHY_EXTERNAL_APP_IMPORT）');
  assert.ok(!('imported' in r) && !('skipped' in r));
});

test('unimport 无 provider → provider is required（早于 registrar 检查）', () => {
  const spy = makeSpy();
  const r = IMP.unimport({ app: 'openclaw' }, { KHY_EXTERNAL_APP_IMPORT: '1' }, { registrar: spy.registrar });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error, 'provider is required');
  assert.strictEqual(spy.uncalls.length, 0);
});

test('unimport registrar 无 unregisterCustomProvider 函数 → fail-closed', () => {
  const r = IMP.unimport({ app: 'openclaw', provider: 'p' }, { KHY_EXTERNAL_APP_IMPORT: '1' }, { registrar: { registerCustomProvider: () => ({}) } });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error, 'customProviderRegistrar 不可用');
});

test('unimport registrar 抛错 → fail-soft 包成 {success:false,error}', () => {
  const boom = { unregisterCustomProvider: () => { throw new Error('boom'); } };
  const r = IMP.unimport({ app: 'openclaw', provider: 'p' }, { KHY_EXTERNAL_APP_IMPORT: '1' }, { registrar: boom });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error, 'boom');
  assert.strictEqual(r.poolKey, 'openclaw-p');
});

// ── discoverAll / importAll ───────────────────────────────────────────────
test('discoverAll gated-off：apps=[]，success=false（早退，不逐个 discover）', () => {
  const r = IMP.discoverAll({ KHY_EXTERNAL_APP_IMPORT: 'off' });
  assert.strictEqual(r.success, false);
  assert.deepStrictEqual(r.apps, []);
  assert.strictEqual(r.error, '外部模型导入已被门控关闭（KHY_EXTERNAL_APP_IMPORT）');
});

test('discoverAll gated-on：apps 长度恰等于 APPS（6 个逐条 discover）', () => {
  // 强制指向 fake home 让 openclaw 走我们写的 config；其它 5 app 无配置也能返回 success:true 且 providers:[]。
  seedOpenclaw({ onlyone: { baseUrl: 'https://o.test/v1', models: ['m'] } }, { ONLYONE_API_KEY: 'sk-o-1234567890' });
  const r = IMP.discoverAll(OC_ENV);
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.apps.length, IMP.APPS.length);
  assert.strictEqual(r.apps.find((x) => x.app === 'openclaw').providers.length, 1);
});

test('importAll gated-off：附 imported:[] skipped:[] 的空返回', () => {
  const r = IMP.importAll({}, { KHY_EXTERNAL_APP_IMPORT: 'off' }, { registrar: makeSpy().registrar });
  assert.strictEqual(r.success, false);
  assert.deepStrictEqual(r.imported, []);
  assert.deepStrictEqual(r.skipped, []);
});
