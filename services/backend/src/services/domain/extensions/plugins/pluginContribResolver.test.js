'use strict';

/**
 * pluginContribResolver.test.js — 钉死插件按需惰性激活：双闸门、目录扫描过滤、
 * 冲突 first-wins、manifest/entry 字段优先级、fail-soft 绝不抛。
 *
 * 为什么必须 stub extensionRoots：真 discover() 会扫本仓 extensions/ 等真实根，
 * 结果随仓库内容漂移；惰性激活器的语义（runtime kind 过滤、tools 声明、entry 相对
 * absDir 拼接、state 键是裸目录名 id）只有在受控扩展集下才可钉死。stub 走
 * require.cache，与 sync.test.js 对 registry 的做法一致。
 * _baseTool / src/tools 两个懒 require 出口同样 stub：register 有全局态，测试不许
 * 污染真注册表。flagRegistry 用真的——实测未知 flag 默认开、'off' 词关闭，
 * GATE='KHY_PLUGIN_LAZY_LOAD' 未在登记表注册，正是靠该默认语义。
 *
 * 实测钉死的怪异行为（非理想行为）：
 *   · ownsTool/activate 的闸门读的是 process.env（模块签名不接受 env 注入），
 *     测试只能临时改 process.env.KHY_PLUGIN_LAZY_LOAD。
 *   · listDeclaredTools 的 inputSchema 只回看 manifest（rec.def），entry 里声明的
 *     schema 不会出现在广告面 → manifest 缺省时给固定默认
 *     {type:'object',properties:{}}。
 *   · _rebuild 的中段过滤用 `state[ext.dir]?.enabled === false`（dir 是 id），
 *     而 scan 阶段不过滤 disabled —— enabled 状态的最终裁决在 _rebuild。
 *   · 冲突消解按 discover() 返回序 first-wins，不是按名字大小写；禁用 first 位扩展
 *     不会让名字消失，而是由 discover 序后位的同名扩展接管（遮蔽者上位）。
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── require.cache 桩（必须在 require 被测模块之前装好）──────────────────
const ER_PATH = require.resolve('../extensions/extensionRoots');
const BASETOOL_PATH = require.resolve('../../../../tools/_baseTool');
const TOOLS_PATH = require.resolve('../../../../tools');
const SAVED = [ER_PATH, BASETOOL_PATH, TOOLS_PATH].map((p) => [p, require.cache[p]]);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-pcr-'));

let state = {};
let discovered = [];
const registered = [];
const defineBooms = new Set(); // 这些名字进 defineTool 即抛
const registerBooms = new Set(); // 这些名字进 register 即抛

function putEntry(extDir, file, src) {
  const abs = path.join(TMP, extDir);
  fs.mkdirSync(abs, { recursive: true });
  fs.writeFileSync(path.join(abs, file), src, 'utf8');
  return abs;
}

require.cache[ER_PATH] = {
  id: ER_PATH,
  filename: ER_PATH,
  loaded: true,
  exports: {
    userExtensionsDir: () => path.join(TMP, '_user'),
    MANIFEST_LEGACY_JSON: 'openclaw.plugin.json',
    stateFilePath: () => path.join(TMP, '_state.json'),
    // 每次返回浅拷贝：模拟真 readState 的文件读， staleness 探针靠内容比较
    readState: () => ({ ...state }),
    discover: () => discovered.slice(),
    isEnabled: (dir, st) => !(st[dir] && st[dir].enabled === false),
  },
};
require.cache[BASETOOL_PATH] = {
  id: BASETOOL_PATH,
  filename: BASETOOL_PATH,
  loaded: true,
  exports: {
    defineTool: (spec) => {
      if (defineBooms.has(spec.name)) throw new Error('bad spec');
      return { ...spec, __built: true };
    },
  },
};
require.cache[TOOLS_PATH] = {
  id: TOOLS_PATH,
  filename: TOOLS_PATH,
  loaded: true,
  exports: {
    register: (tool) => {
      if (registerBooms.has(tool.name)) throw new Error('dup');
      registered.push(tool);
    },
  },
};

const M = require('./pluginContribResolver');

// 真实入口文件（activate 会真 require 它们，落在临时目录）
putEntry(
  'extA',
  'entry.js',
  "module.exports = { tools: [{ name: 'alpha_tool', description: 'entry desc'," +
    " isReadOnly: true, maxResultSizeChars: 999, execute: () => 'from-entry' }] };"
);
putEntry('extB', 'entry.js', "module.exports = { tools: [{ name: 'alpha_tool', execute: () => 'B' }] };");
putEntry('extC', 'entry.js', 'module.exports = { tools: [] };');
putEntry('extD', 'entry.js', "module.exports = { tools: [{ name: 'no_exec' }] };");
putEntry('extE', 'entry.js', "module.exports = { tools: [{ name: 'boom', execute: () => 1 }] };");
putEntry('extF', 'entry.js', "module.exports = { tools: [{ name: 'regfail', execute: () => 1 }] };");

function baseDiscovered() {
  discovered = [
    // extA：manifest 声明 + entry 存在 → 应可拥有 alpha_tool
    {
      id: 'extA',
      dir: path.join(TMP, 'extA'),
      kind: 'runtime',
      entry: 'entry.js',
      tools: [{ name: 'alpha_tool', description: 'manifest desc', category: 'ext', inputSchema: { type: 'object' } }],
    },
    // extB：同名冲突候选，discover 序在 extA 之后 → 应被遮蔽
    { id: 'extB', dir: path.join(TMP, 'extB'), kind: 'runtime', entry: 'entry.js', tools: [{ name: 'alpha_tool' }] },
    // ide-bridge kind 永不贡献 runtime 工具
    { id: 'extIde', dir: path.join(TMP, 'extA'), kind: 'ide-bridge', entry: 'entry.js', tools: [{ name: 'ide_tool' }] },
    // 无 tools 声明
    { id: 'extC', dir: path.join(TMP, 'extC'), kind: 'runtime', entry: 'entry.js', tools: [] },
    // manifest 无 execute 来源（entry 里 no_exec 没有 execute/handler）
    { id: 'extD', dir: path.join(TMP, 'extD'), kind: 'runtime', entry: 'entry.js', tools: [{ name: 'no_exec' }] },
    // entry 文件不存在的声明
    { id: 'extGhost', dir: path.join(TMP, 'ghost'), kind: 'runtime', entry: 'entry.js', tools: [{ name: 'ghost_tool' }] },
    // 无 entry 字段
    { id: 'extNoEntry', dir: path.join(TMP, 'extA'), kind: 'runtime', tools: [{ name: 'entryless' }] },
    // defineTool / register 抛异常的兜底候选
    { id: 'extE', dir: path.join(TMP, 'extE'), kind: 'runtime', entry: 'entry.js', tools: [{ name: 'boom' }] },
    { id: 'extF', dir: path.join(TMP, 'extF'), kind: 'runtime', entry: 'entry.js', tools: [{ name: 'regfail' }] },
  ];
}

function fresh() {
  M._reset();
  state = {};
  baseDiscovered();
  registered.length = 0;
  defineBooms.add('boom');
  registerBooms.add('regfail');
}

after(() => {
  for (const [p, v] of SAVED) {
    if (v) require.cache[p] = v;
    else delete require.cache[p];
  }
  delete process.env.KHY_PLUGIN_LAZY_LOAD;
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('导出面是 extensionRoots 的派生转发，不再自声明路径', () => {
  assert.equal(M.MANIFEST_FILE, 'openclaw.plugin.json');
  assert.equal(M.STATE_FILE, path.join(TMP, '_state.json'));
  assert.equal(M.EXTENSIONS_DIR, path.join(TMP, '_user')); // 兼容位报告 user root
});

test('ownsTool 对非法入参一律 false，不触闸门', () => {
  assert.equal(M.ownsTool(''), false);
  assert.equal(M.ownsTool(null), false);
  assert.equal(M.ownsTool(42), false);
});

test('闸门关：ownsTool/listDeclaredTools/activate 全线静默，如同插件未安装', () => {
  fresh();
  assert.equal(M.ownsTool('alpha_tool'), true); // 前提：默认开
  process.env.KHY_PLUGIN_LAZY_LOAD = 'off';
  try {
    assert.equal(M.ownsTool('alpha_tool'), false);
    assert.deepEqual(M.listDeclaredTools(), []);
    assert.equal(M.activateContributedTool('alpha_tool'), null);
  } finally {
    delete process.env.KHY_PLUGIN_LAZY_LOAD;
  }
});

test('ownsTool 可见性过滤：runtime+entry+声明 才可见；冲突/ide/缺件全不可见', () => {
  fresh();
  assert.equal(M.ownsTool('alpha_tool'), true);
  assert.equal(M.ownsTool('ide_tool'), false); // kind!=='runtime' 被 scan 丢弃
  assert.equal(M.ownsTool('ghost_tool'), false); // entry 文件不存在
  assert.equal(M.ownsTool('entryless'), false); // manifest 无 entry 字段
  assert.equal(M.toolIndex.get('alpha_tool').dir, 'extA'); // first-wins 由 discover 序决定
});

test('刚被禁用的扩展 fail-closed 出局：冲突名由后位扩展接管，双禁用才彻底不可见', () => {
  fresh();
  state = { extA: { enabled: false } };
  // 怪异但真实：extA 出局后 discover 序里后位的 extB 顶上来，名字仍被拥有
  assert.equal(M.ownsTool('alpha_tool'), true);
  assert.equal(M.toolIndex.get('alpha_tool').dir, 'extB');
  state = { extA: { enabled: false }, extB: { enabled: false } };
  assert.equal(M.ownsTool('alpha_tool'), false); // 双禁用 → fail-closed 出局
  state = { extA: { enabled: true }, extB: { enabled: false } };
  assert.equal(M.ownsTool('alpha_tool'), true); // 再启用无需 _reset 即恢复（staleness 重建）
  assert.equal(M.toolIndex.get('alpha_tool').dir, 'extA'); // first-wins 复位
});

test('activate 惰性 require entry：JSON-safe 字段 manifest 胜，函数只能来自 entry', () => {
  fresh();
  const tool = M.activateContributedTool('alpha_tool');
  assert.ok(tool && tool.__built, 'defineTool 产物原样回吐');
  assert.equal(tool.name, 'alpha_tool');
  assert.equal(tool.description, 'manifest desc'); // manifest 压过 entry desc
  assert.equal(tool.category, 'ext');
  assert.equal(tool.risk, 'medium'); // 双缺省 → 默认 medium
  assert.equal(tool.maxResultSizeChars, 999); // entry 标量兜底（manifest 未声明）
  assert.equal(tool.execute(), 'from-entry'); // 函数只能来自 entry
  assert.equal(registered.length, 1);
  assert.equal(registered[0], tool); // register 收的就是返回件
});

test('activate 对无 execute 的声明回 null（fail-soft，不注册）', () => {
  fresh();
  assert.equal(M.activateContributedTool('no_exec'), null);
  assert.equal(registered.length, 0);
});

test('defineTool 抛 / register 抛都收敛为 null，绝不冒异常到漏斗', () => {
  fresh();
  assert.equal(M.activateContributedTool('boom'), null);
  assert.equal(M.activateContributedTool('regfail'), null);
  assert.equal(M.activateContributedTool('not_declared'), null);
});

test('listDeclaredTools 纯 manifest 读：永不 require entry，schema 缺省给固定默认', () => {
  fresh();
  const list = M.listDeclaredTools();
  const alpha = list.find((t) => t.name === 'alpha_tool');
  assert.ok(alpha);
  assert.equal(alpha.dir, 'extA');
  assert.deepEqual(alpha.inputSchema, { type: 'object' }); // manifest 面，非 entry
  const noExec = list.find((t) => t.name === 'no_exec');
  assert.deepEqual(noExec.inputSchema, { type: 'object', properties: {} }); // 默认广告形
  assert.equal(noExec.description, '');
});
