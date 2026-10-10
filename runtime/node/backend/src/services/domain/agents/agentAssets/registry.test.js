'use strict';

/**
 * registry.test.js — 钉死外部 agent 资产层的声明式注册表：表本身的不可变性、门控开关下的
 * 查询结果、id 归一查表、适配器惰性解析与缓存，以及「一家探测失败不影响其余家」的聚合。
 *
 * 为什么这支套件必须存在：本表是全流程唯一的「有哪些外部工具」真源，编排层(sync.js)与工具层
 * (tools/AgentAssetsTool)都只认它的返回值。文件头自称「零厂商专属逻辑」——即注册表不得知道
 * 任何一家的资产根、支持哪几类、能不能写；这些必须来自适配器自己的 detect/capabilities。
 * 只要这里漏进一家专属分支，新增第 7 家就不再是「加一个适配器 + 加一行表」。故这两件事
 * （表封闭、能力来自适配器）必须钉死。
 *
 * 实测更正（与注释/直觉不同处，按真实语义钉死）：
 *   · resolveAdapter 的缓存是**模块级** Map：同一 id 二次解析返回同一引用，换 env 不会重解析；
 *     _resetAdapterCache() 只清缓存，不会把 require.cache 里的桩换下来（单测必须两样都管）。
 *   · describeSources 的 detected 用的是 `detection.ok === true`，但同一对象里的 root 用的是
 *     truthy 判定（registry.js:138）——ok 为真值但非 true 时会出现 detected:false / root 有值。
 *   · khy-os 一家的 detect() 恒 ok:true（资产库不存在也算「可写时再创建」），所以 describeSources
 *     里它的 detected 永远为真，与其他五家的「没装就是没装」不同。
 *   · 六个适配器都是**资产**适配器（detect、capabilities、listMemories/listTools/listSkills、
 *     readAsset、writeAsset、removeAsset），没有 generate()；本通道全程只碰 fs/os，
 *     零网络零子进程，故无需桩 fetch/http/child_process。
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REG = require('./registry');
const M = require('./assetModel');

const ADAPTER_MODULES = {
  'khy-os': 'khyOs',
  opencode: 'opencode',
  'claude-code': 'claudeCode',
  harness: 'harness',
  'deepseek-harness': 'deepseekHarness',
  openclaw: 'openclaw',
};

const ADAPTER_PATHS = Object.entries(ADAPTER_MODULES)
  .map(([, mod]) => require.resolve(`./adapters/${mod}`));

// 进入本套件时这些模块还没被 require 过（注册表是惰性解析），快照用于 after() 逐项还原。
const ORIGINAL_CACHE = new Map(ADAPTER_PATHS.map((p) => [p, require.cache[p]]));
const STUBBED = new Set();

function stubAdapter(moduleName, exportsOrEntry) {
  const abs = require.resolve(`./adapters/${moduleName}`);
  STUBBED.add(abs);
  const entry = Object.isFrozen(exportsOrEntry)
    ? exportsOrEntry
    : { id: abs, filename: abs, loaded: true, exports: exportsOrEntry, children: [], paths: [] };
  require.cache[abs] = entry;
  REG._resetAdapterCache();
  return abs;
}

function unstub(moduleName) {
  const abs = require.resolve(`./adapters/${moduleName}`);
  delete require.cache[abs];
  STUBBED.delete(abs);
  REG._resetAdapterCache();
}

const TMP_DIRS = [];

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-b46-reg-'));
  TMP_DIRS.push(dir);
  return dir;
}

function envWithRoots(dir) {
  return {
    KHY_AGENT_ASSETS_LOCAL_ROOT: dir,
    KHY_AGENT_ASSETS_OPENCODE_ROOT: dir,
    KHY_AGENT_ASSETS_CLAUDE_CODE_ROOT: dir,
    KHY_AGENT_ASSETS_HARNESS_ROOT: dir,
    KHY_AGENT_ASSETS_DSH_ROOT: dir,
    KHY_AGENT_ASSETS_OPENCLAW_ROOT: dir,
  };
}

function fakeAdapter(id, overrides) {
  return Object.assign({
    TOOL_ID: id,
    LABEL: id,
    ROOT_ENV_KEYS: Object.freeze([`KHY_AGENT_ASSETS_${id.toUpperCase()}_ROOT`]),
    detect: () => ({ ok: true, root: '/fake/root', via: 'env:test', checked: [], established: true }),
    capabilities: () => ({ id, label: id, detected: true, root: '/fake/root', kinds: {}, rootEnvKeys: [] }),
    listMemories: () => [],
    listTools: () => [],
    listSkills: () => [],
    readAsset: () => null,
    writeAsset: () => ({ ok: false, error: 'fake' }),
    removeAsset: () => ({ ok: false, error: 'fake' }),
  }, overrides || {});
}

after(() => {
  for (const abs of STUBBED) {
    delete require.cache[abs];
  }
  for (const [abs, entry] of ORIGINAL_CACHE) {
    if (entry) {
      require.cache[abs] = entry;
    } else {
      delete require.cache[abs];
    }
  }
  REG._resetAdapterCache();
  for (const dir of TMP_DIRS) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 导出面与表本身 ───────────────────────────────────────────────────────

test('registry 恰导出 6 个符号（表 + 三个查询 + 聚合 + 测试钩子）', () => {
  assert.deepStrictEqual(Object.keys(REG).sort(), [
    'AGENT_ASSET_SOURCES',
    '_resetAdapterCache',
    'describeSources',
    'getSource',
    'listSourceIds',
    'resolveAdapter',
  ]);
});

test('AGENT_ASSET_SOURCES 是 frozen 的六家名单，逐项 frozen 且 module 与磁盘文件一一对应', () => {
  assert.strictEqual(Object.isFrozen(REG.AGENT_ASSET_SOURCES), true);
  assert.deepStrictEqual(REG.AGENT_ASSET_SOURCES.map((s) => s.id), [
    'khy-os', 'opencode', 'claude-code', 'harness', 'deepseek-harness', 'openclaw',
  ]);
  for (const entry of REG.AGENT_ASSET_SOURCES) {
    assert.strictEqual(Object.isFrozen(entry), true, `${entry.id} 的表项必须 frozen`);
    assert.deepStrictEqual(Object.keys(entry).sort(), ['id', 'label', 'module']);
    assert.match(entry.id, /^[a-z][a-z0-9-]*$/, 'id 必须小写 kebab，直接当 CLI 参数用');
    assert.strictEqual(fs.existsSync(path.join(__dirname, 'adapters', `${entry.module}.js`)), true,
      `${entry.id} 指向的适配器模块必须存在，否则 resolveAdapter 永远只能回加载失败`);
  }
  assert.throws(() => REG.AGENT_ASSET_SOURCES.push({ id: 'x', label: 'x', module: 'x' }), TypeError);
  assert.throws(() => REG.AGENT_ASSET_SOURCES[0].id = 'other', TypeError);
  // 表里不许出现厂商专属字段：注册表必须只认 id/label/module，能力一律问适配器。
  for (const key of ['root', 'kinds', 'capabilities', 'detect', 'envKeys']) {
    assert.strictEqual(REG.AGENT_ASSET_SOURCES[0][key], undefined, `注册表不得预知 ${key}`);
  }
});

// ── listSourceIds ────────────────────────────────────────────────────────

test('listSourceIds：门开回六家原序，四个 CANON 关闭词都回空数组（编排层据此明确拒绝）', () => {
  const ids = ['khy-os', 'opencode', 'claude-code', 'harness', 'deepseek-harness', 'openclaw'];
  assert.deepStrictEqual(REG.listSourceIds({}), ids);
  for (const off of ['0', 'false', 'off', 'no', ' OFF ', 'No']) {
    assert.deepStrictEqual(REG.listSourceIds({ KHY_AGENT_ASSETS: off }), [], `${off} 应关门`);
  }
  assert.deepStrictEqual(REG.listSourceIds({ KHY_AGENT_ASSETS: 0 }), [], '数字 0 经 String 后同解');
  assert.deepStrictEqual(REG.listSourceIds({ KHY_AGENT_ASSETS: 'disable' }), ids,
    'disable 不在 CANON 词表里，关门不了');
});

test('listSourceIds 每次回新数组，改动返回值不污染表；非对象 env 也照表回', () => {
  const first = REG.listSourceIds({});
  first.push('boom');
  assert.strictEqual(REG.listSourceIds({}).length, 6, 'map 产出新数组，表不受调用方影响');
  assert.strictEqual(REG.listSourceIds([]).length, 6, '数组 env 上取不到门控变量，等同门开');
});

// ── getSource ────────────────────────────────────────────────────────────

test('getSource 归一大小写与空白并返回表项本体（frozen 引用，非拷贝）', () => {
  for (const key of ['opencode', 'OpenCode', '  OPENCODE  ']) {
    const got = REG.getSource(key);
    assert.strictEqual(got, REG.AGENT_ASSET_SOURCES[1], `${key} 应命中同一表项引用`);
    assert.strictEqual(got.label, 'opencode');
    assert.strictEqual(got.module, 'opencode');
  }
  assert.strictEqual(REG.getSource('claude-code').label, 'Claude Code');
  assert.strictEqual(REG.getSource('deepseek-harness').module, 'deepseekHarness');
});

test('getSource 对空白 / 未注册 / 原型链键都回 null，绝不把 Object.prototype 的东西当工具', () => {
  for (const miss of ['', '   ', null, undefined, 0, -1, NaN, false, true, {}, [], 'khy_os', 'khy-os-x', 'KHYS-OS']) {
    assert.strictEqual(REG.getSource(miss), null, `${String(miss)} 不该命中`);
  }
  assert.strictEqual(REG.getSource('  khy-os \t'), REG.AGENT_ASSET_SOURCES[0], '首尾空白（含制表符）都被 trim');
  for (const protoKey of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
    assert.strictEqual(REG.getSource(protoKey), null, `${protoKey} 不是注册 id`);
  }
  assert.strictEqual(REG.getSource({ toString: () => 'opencode' }), REG.AGENT_ASSET_SOURCES[1],
    '入参只过 String()：可调用 toString 的对象会被当成它拼出来的名字而命中');
  assert.strictEqual(REG.getSource({ valueOf: () => 'opencode' }), null,
    'String() 走 ToString（hint 为 string）：先 toString 后 valueOf，valueOf-only 拼不出名字');
});

// ── resolveAdapter：门控与查表 ───────────────────────────────────────────

test('resolveAdapter 关门时明确拒绝，错误串逐字钉死（工具层直接把它回给用户）', () => {
  for (const off of ['off', '0', 'false', 'no']) {
    const res = REG.resolveAdapter('khy-os', { KHY_AGENT_ASSETS: off });
    assert.deepStrictEqual(res, { ok: false, error: '外部 agent 资产层已被门控关闭(KHY_AGENT_ASSETS=off)' });
  }
  assert.strictEqual(M.isEnabled({ KHY_AGENT_ASSETS: 'off' }), false);
});

test('resolveAdapter 未注册 id 的错误串把已注册六家全列出来，空 id 回显 (空)', () => {
  const all = 'khy-os / opencode / claude-code / harness / deepseek-harness / openclaw';
  assert.deepStrictEqual(REG.resolveAdapter('cursor', {}), {
    ok: false,
    error: `未注册的外部 agent 工具:cursor（已注册:${all}）`,
  });
  for (const empty of [undefined, null, '', 0, NaN, false]) {
    assert.strictEqual(REG.resolveAdapter(empty, {}).error,
      `未注册的外部 agent 工具:(空)（已注册:${all}）`, 'falsy id 一律回显 (空)');
  }
  // 只含空白的 id 是 truthy，被原样拼进用户可见的错误串里（看起来像空）；查表本身仍按 null 处理。
  assert.strictEqual(REG.resolveAdapter('   ', {}).error,
    `未注册的外部 agent 工具:   （已注册:${all}）`);
  assert.strictEqual(REG.resolveAdapter('Cursor', {}).error,
    `未注册的外部 agent 工具:Cursor（已注册:${all}）`, '错误串回显原始大小写，不做归一');
});

test('resolveAdapter 命中的 source 就是表项本体，且六家的实际契约面是资产接口不是 generate', () => {
  const base = ['LABEL', 'ROOT_ENV_KEYS', 'TOOL_ID', 'capabilities', 'detect',
    'listMemories', 'listSkills', 'listTools', 'readAsset', 'removeAsset', 'writeAsset'];
  const expected = {
    'khy-os': base,
    opencode: base,
    'claude-code': base,
    harness: base,
    'deepseek-harness': [...base, 'JS_EXPR_PREFIX', 'NEVER_READ'].sort(),
    openclaw: [...base, 'IMPORTS_DIR', 'RESERVED_SERVER_NAME'].sort(),
  };
  for (const [id, mod] of Object.entries(ADAPTER_MODULES)) {
    const res = REG.resolveAdapter(id, {});
    assert.strictEqual(res.ok, true, `${id} 应解析成功: ${res.error || ''}`);
    assert.strictEqual(res.source, REG.getSource(id), 'source 必须是表项本体，不是拷贝');
    assert.deepStrictEqual(Object.keys(res.adapter).sort(), expected[id],
      `${id} 的导出面就是这张契约表：本通道没有 generate()，也没有网络/子进程出口`);
    for (const fn of ['detect', 'capabilities', 'listMemories', 'listTools', 'listSkills',
      'readAsset', 'writeAsset', 'removeAsset']) {
      assert.strictEqual(typeof res.adapter[fn], 'function', `${id}.${fn} 必须是函数`);
    }
  }
});

test('resolveAdapter 命中缓存：同 id 二次解析回同一引用，_resetAdapterCache 后才重新 require', () => {
  unstub('khyOs');
  const fakeA = fakeAdapter('khy-os');
  const abs = stubAdapter('khyOs', fakeA);
  const one = REG.resolveAdapter('khy-os', {});
  assert.strictEqual(one.ok, true);
  assert.strictEqual(one.adapter, fakeA, '第一次解析取到桩');
  // 换掉 require.cache 里的 exports，缓存未清时第二次解析仍该拿到旧引用。
  require.cache[abs].exports = fakeAdapter('khy-os', { LABEL: 'second' });
  const two = REG.resolveAdapter('khy-os', {});
  assert.strictEqual(two.adapter, fakeA, '_adapterCache 命中时不得重新 require');
  REG._resetAdapterCache();
  const three = REG.resolveAdapter('khy-os', {});
  assert.strictEqual(three.adapter, require.cache[abs].exports, '清缓存后重新解析到当前模块导出');
  assert.strictEqual(three.adapter.LABEL, 'second');
});

test('resolveAdapter 对「模块加载即抛」不抛，回适配器加载失败并带上原始 message', () => {
  const abs = require.resolve('./adapters/khyOs');
  STUBBED.add(abs);
  require.cache[abs] = {
    id: abs,
    filename: abs,
    loaded: true,
    children: [],
    paths: [],
    get exports() { throw new Error('syntax boom'); },
  };
  REG._resetAdapterCache();
  const res = REG.resolveAdapter('khy-os', {});
  assert.deepStrictEqual(res, { ok: false, error: '适配器加载失败(khy-os):syntax boom' });
  delete require.cache[abs];
  REG._resetAdapterCache();
  assert.strictEqual(REG.resolveAdapter('khy-os', {}).ok, true, '还原后必须能重新加载');
});

// ── describeSources：门控 ────────────────────────────────────────────────

test('describeSources 关门时回 ok:false + 空数组 + 逐字错误串', () => {
  assert.deepStrictEqual(REG.describeSources({ KHY_AGENT_ASSETS: 'off' }), {
    ok: false,
    sources: [],
    error: '外部 agent 资产层已被门控关闭(KHY_AGENT_ASSETS=off)',
  });
});

// ── describeSources：聚合分支（全桩，确定性） ────────────────────────────

test('describeSources 把「没实现 detect / detect 抛 / capabilities 抛」如实记进条目', () => {
  stubAdapter('khyOs', fakeAdapter('khy-os', { detect: () => undefined }));
  stubAdapter('opencode', fakeAdapter('opencode', { detect: () => { throw new Error('disk died'); } }));
  stubAdapter('claudeCode', fakeAdapter('claude-code', { capabilities: () => { throw new Error('cap boom'); } }));

  const res = REG.describeSources({});
  assert.strictEqual(res.ok, true);
  const byId = new Map(res.sources.map((s) => [s.id, s]));

  const noDetect = byId.get('khy-os');
  assert.strictEqual(noDetect.detected, false);
  assert.strictEqual(noDetect.root, '');
  assert.deepStrictEqual(noDetect.checked, []);
  assert.strictEqual(noDetect.error, '适配器未实现 detect()');

  const throwing = byId.get('opencode');
  assert.strictEqual(throwing.detected, false);
  assert.strictEqual(throwing.error, 'detect 异常:disk died');

  const capThrowing = byId.get('claude-code');
  assert.strictEqual(capThrowing.detected, true, 'capabilities 抛不影响 detect 结果');
  assert.deepStrictEqual(capThrowing.capabilities, { error: 'capabilities 异常:cap boom' });
  assert.strictEqual(capThrowing.root, '/fake/root');
});

test('describeSources 一条坏 detect 返回不污染其余家：加载失败项 capabilities 归 null，good 项照常', () => {
  const badAbs = require.resolve('./adapters/harness');
  STUBBED.add(badAbs);
  require.cache[badAbs] = {
    id: badAbs, filename: badAbs, loaded: true, children: [], paths: [],
    get exports() { throw new Error('no such file'); },
  };
  stubAdapter('deepseekHarness', fakeAdapter('deepseek-harness', {
    detect: () => ({ ok: 'yes', root: '/truthy/not/true' }),
  }));
  stubAdapter('openclaw', fakeAdapter('openclaw', {
    detect: () => ({ ok: false, error: '本机未安装 openclaw', checked: 'not-an-array' }),
    capabilities: () => undefined,
  }));
  REG._resetAdapterCache();

  const res = REG.describeSources({});
  const byId = new Map(res.sources.map((s) => [s.id, s]));
  assert.strictEqual(res.sources.length, 6);

  const loadFail = byId.get('harness');
  assert.deepStrictEqual(loadFail, {
    id: 'harness',
    label: '通用 agent harness',
    detected: false,
    error: '适配器加载失败(harness):no such file',
    capabilities: null,
  }, '加载失败条目刻意不带 root/checked 字段');

  const truthy = byId.get('deepseek-harness');
  assert.strictEqual(truthy.detected, false, 'detected 用 === true 判定');
  assert.strictEqual(truthy.root, '/truthy/not/true',
    'root 却走 truthy 判定（registry.js:138）：同一对象里两套真假口径，注释未提');
  assert.strictEqual(truthy.error, '');

  const miss = byId.get('openclaw');
  assert.strictEqual(miss.detected, false);
  assert.strictEqual(miss.root, '');
  assert.strictEqual(miss.error, '本机未安装 openclaw');
  assert.deepStrictEqual(miss.checked, [], 'checked 非数组被规整成空数组');
  assert.strictEqual(miss.capabilities, null, 'capabilities() 回 falsy 时条目记 null 而非 {}');
});

test('describeSources 的每条都恰有 7 个字段并带 label，顺序就是表顺序', () => {
  stubAdapter('khyOs', fakeAdapter('khy-os'));
  stubAdapter('opencode', fakeAdapter('opencode'));
  stubAdapter('claudeCode', fakeAdapter('claude-code'));
  stubAdapter('harness', fakeAdapter('harness'));
  stubAdapter('deepseekHarness', fakeAdapter('deepseek-harness'));
  stubAdapter('openclaw', fakeAdapter('openclaw'));
  const res = REG.describeSources({});
  assert.deepStrictEqual(res.sources.map((s) => s.id), REG.listSourceIds({}));
  for (const s of res.sources) {
    assert.deepStrictEqual(Object.keys(s).sort(),
      ['capabilities', 'checked', 'detected', 'error', 'id', 'label', 'root']);
    assert.strictEqual(s.label, REG.getSource(s.id).label, 'label 只能来自表，不许适配器自说');
    assert.strictEqual(s.detected, true);
  }
});

// ── describeSources：真适配器 ────────────────────────────────────────────

test('describeSources 用真适配器跑六家：六个根变量都指同一临时目录时全部 detected', () => {
  unstub('khyOs');
  unstub('opencode');
  unstub('claudeCode');
  unstub('harness');
  unstub('deepseekHarness');
  unstub('openclaw');
  const dir = tmpRoot();
  const res = REG.describeSources(envWithRoots(dir));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.sources.length, 6);
  for (const s of res.sources) {
    assert.strictEqual(s.detected, true, `${s.id} 应以环境变量根命中：${s.error}`);
    assert.strictEqual(s.root, dir);
    assert.strictEqual(s.error, '');
    assert.strictEqual(Array.isArray(s.checked), true);
    assert.strictEqual(s.capabilities.id, s.id, '能力清单必须由适配器自己声明');
    assert.strictEqual(s.capabilities.label, s.label);
    assert.deepStrictEqual(Object.keys(s.capabilities.kinds).sort(), ['memory', 'skill', 'tool']);
    for (const kind of ['memory', 'skill', 'tool']) {
      const k = s.capabilities.kinds[kind];
      assert.strictEqual(typeof k.read, 'boolean', `${s.id}/${kind}.read 必须是布尔`);
      assert.strictEqual(typeof k.write, 'boolean', `${s.id}/${kind}.write 必须是布尔`);
      assert.strictEqual(typeof k.note, 'string');
    }
    assert.strictEqual(Array.isArray(s.capabilities.rootEnvKeys), true);
    assert.strictEqual(s.capabilities.rootEnvKeys.length > 0, true);
    for (const key of s.capabilities.rootEnvKeys) {
      assert.match(key, /^KHY_AGENT_ASSETS_[A-Z_]+_ROOT$|^[A-Z][A-Z0-9_]*$/,
        `${s.id} 的根变量名必须是可文档化的大写 env key`);
    }
    assert.strictEqual(s.checked[0].location, dir,
      '第一个被检查位置就该是环境变量给的根，说明根变量优先级最高');
  }
});

test('describeSources 对垃圾 env 只保证形状：门关词以外的东西不得让聚合崩掉', () => {
  unstub('khyOs');
  unstub('deepseekHarness');
  for (const junk of [undefined, null, {}, [], 0, 'off']) {
    const res = REG.describeSources(junk);
    // 门控只认 env.KHY_AGENT_ASSETS 这一个键；裸字符串 env 上取不到键，关不了门。
    assert.strictEqual(res.ok, true, `${String(junk)} 不该被判成关门`);
    assert.strictEqual(res.sources.length, 6);
    for (const s of res.sources) {
      assert.strictEqual(typeof s.detected, 'boolean');
      assert.strictEqual(typeof s.error, 'string');
      assert.strictEqual(Array.isArray(s.checked), true);
    }
  }
});
