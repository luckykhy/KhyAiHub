'use strict';

/**
 * amooToolContract.test.js — 工具名 / 风险契约与五份清单的比对测试。
 *
 * WHY 这个测试存在：五份工具清单互不相通（PC 执行闸 22、目录 32、协作桥 12、
 * 手机端 48、手机循环 48——P0-2 起后者是前者的集合镜像），谁改一边另一边都不知道，
 * 漂移就这么攒出来的。
 * 契约 `amooToolContract.json` 是它们的**坐标**，本测试把坐标和五份清单逐条
 * 对上，并报出计数与差集。
 *
 * 它不新增能力：契约不进任何白名单（不进 BRIDGE_TOOLS、不进 Tools.NAMES、
 * 不进桥的 12 项 wire 面），也不建 CI 红门（PROCESS-008 S1）。
 *
 * 口径 D1-1 部分：D1-2（三端从契约读、删各自 local 常量）尚未做。
 *
 * 跨树读取说明：协作桥的 contracts.js 与手机端的两个 .java 不在 backend 的
 * 依赖方向内（LAYOUT 跨层 require 红线），所以这里**读文本**而不是 require：
 * 只取工具名清单，不取任何实现。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const policy = require('./amooBridgePolicy');
const catalog = require('../phone/phoneBridgeCatalog');

const RISKS = new Set(['low', 'medium', 'high']);
const SCOPES = new Set(['operator', 'phone', 'file']);
const PHASES = new Set([1, 2]);

function findRepoRoot() {
  let dir = __dirname;
  for (let i = 0; i < 12; i += 1) {
    if (fs.existsSync(path.join(dir, 'runtime')) && fs.existsSync(path.join(dir, 'delivery'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error('找不到仓库根目录（无法定位 runtime/ 与 delivery/）');
}

const REPO_ROOT = findRepoRoot();

function readRepoFile(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

/** Java 数组字面量里的字符串：`{ "a", "b" }` → ['a','b']。 */
function parseJavaStringList(text, anchor) {
  const start = text.indexOf(anchor);
  assert.ok(start >= 0, `源文件里找不到声明：${anchor}`);
  const open = text.indexOf('{', start);
  const close = text.indexOf('}', open);
  assert.ok(open > start && close > open, `声明 ${anchor} 的字面量边界解析失败`);
  return [...text.slice(open + 1, close).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** Java `Arrays.asList(...)` 里的字符串。 */
function parseJavaAsList(text, anchor) {
  const start = text.indexOf(anchor);
  assert.ok(start >= 0, `源文件里找不到声明：${anchor}`);
  const open = text.indexOf('(', start);
  const close = text.indexOf(')', open);
  assert.ok(open > start && close > open, `声明 ${anchor} 的字面量边界解析失败`);
  return [...text.slice(open + 1, close).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** 协作桥 contracts.js 的 TOOL_SPECS 里的工具名（只取名字，不取实现）。 */
function parseBridgeToolSpecNames(text) {
  const start = text.indexOf('const TOOL_SPECS = [');
  assert.ok(start >= 0, 'contracts.js 里找不到 TOOL_SPECS');
  const end = text.indexOf('\n];', start);
  assert.ok(end > start, 'contracts.js 的 TOOL_SPECS 边界解析失败');
  return [...text.slice(start, end).matchAll(/\bname:\s*'([^']+)'/g)].map((m) => m[1]);
}

const PHONE_DIR = 'delivery/mobile/khy-os-client-app/android/app/src/main/java/com/khyos/khy_os_client/bridge';
const BRIDGE_CONTRACTS = 'delivery/extension/bridges/khy-amoon-bridge/lib/contracts.js';

const phoneNames = parseJavaStringList(
  readRepoFile(`${PHONE_DIR}/Tools.java`),
  'public static final String[] NAMES =',
);
const loopKnownTools = parseJavaAsList(
  readRepoFile(`${PHONE_DIR}/LoopModes.java`),
  'private static final List<String> KNOWN_TOOLS = Arrays.asList(',
);
const bridgeToolNames = parseBridgeToolSpecNames(readRepoFile(BRIDGE_CONTRACTS));

const policyTools = Object.keys(policy.BRIDGE_TOOLS);
const catalogTools = catalog.getPhoneBridgeTools();
const catalogWireNames = new Set();
const catalogKhyNames = new Set();
const catalogNames = new Set();
for (const tool of catalogTools) {
  catalogWireNames.add(tool.bridgeName);
  catalogKhyNames.add(tool.khyName);
  catalogNames.add(tool.bridgeName);
  catalogNames.add(tool.khyName);
  for (const alias of tool.aliases || []) {
    catalogKhyNames.add(alias);
    catalogNames.add(alias);
  }
}
for (const alias of Object.keys(catalog.ALIAS_TARGETS)) {
  catalogKhyNames.add(alias);
  catalogNames.add(alias);
}

function loadContract() {
  return require('./index').getAmooToolContract();
}

/** 名字 → 契约条目（wireName 与 aliases 都算）。 */
function buildNameIndex(contract) {
  const index = new Map();
  for (const tool of contract.tools) {
    index.set(tool.wireName, tool);
    for (const alias of tool.aliases) {
      assert.ok(!index.has(alias), `契约里名字重复：${alias}`);
      index.set(alias, tool);
    }
  }
  return index;
}

test('契约结构完整：版本、字段、词表、名字全局唯一', () => {
  const contract = loadContract();
  assert.equal(typeof contract.tools_contract_version, 'string');
  assert.ok(contract.tools_contract_version.length > 0, '契约版本号不得为空');
  assert.ok(Array.isArray(contract.tools) && contract.tools.length > 0);

  const seen = new Set();
  for (const tool of contract.tools) {
    for (const field of ['wireName', 'displayName', 'risk', 'requiresConfirm', 'scopes', 'phase', 'aliases']) {
      assert.ok(Object.prototype.hasOwnProperty.call(tool, field), `条目缺字段 ${field}：${tool.wireName}`);
    }
    assert.equal(typeof tool.wireName, 'string');
    assert.ok(tool.wireName.length > 0);
    assert.equal(typeof tool.displayName, 'string');
    assert.ok(tool.displayName.length > 0);
    assert.ok(RISKS.has(tool.risk), `风险档非法：${tool.wireName} = ${tool.risk}`);
    assert.equal(typeof tool.requiresConfirm, 'boolean');
    assert.ok(Array.isArray(tool.scopes) && tool.scopes.length > 0, `scopes 不得为空：${tool.wireName}`);
    for (const scope of tool.scopes) {
      assert.ok(SCOPES.has(scope), `scope 非法：${tool.wireName} = ${scope}`);
    }
    assert.ok(PHASES.has(tool.phase), `phase 非法：${tool.wireName} = ${tool.phase}`);
    assert.ok(Array.isArray(tool.aliases));
    for (const name of [tool.wireName, ...tool.aliases]) {
      assert.ok(!seen.has(name), `契约里名字出现两次：${name}`);
      seen.add(name);
    }
  }
});

test('facade 只读出口：导出 14 个键，契约冻结且可取', () => {
  const facade = require('./index');
  assert.equal(Object.keys(facade).length, 14, 'facade 导出键数与 khy.module.json 的声明不符');
  const contract = facade.getAmooToolContract();
  assert.equal(contract, facade.getAmooToolContract(), '契约应缓存，不该每次重读');
  assert.ok(Object.isFrozen(contract));
  assert.ok(Object.isFrozen(contract.tools));
  assert.ok(Object.isFrozen(contract.tools[0]));
});

test('PC 执行闸的 22 项：契约全覆盖且风险档 / 确认门一致', () => {
  const contract = loadContract();
  const index = buildNameIndex(contract);
  assert.equal(policyTools.length, 22, '执行闸白名单被改动，需人工确认');
  for (const name of policyTools) {
    const entry = index.get(name);
    assert.ok(entry, `执行闸工具不在契约里：${name}`);
    assert.equal(entry.wireName, name, `执行闸工具的规范名应取自身：${name}`);
    assert.equal(entry.risk, policy.BRIDGE_TOOLS[name].risk, `风险档与执行闸不一致：${name}`);
    assert.equal(
      entry.requiresConfirm,
      policy.BRIDGE_TOOLS[name].requiresConfirm,
      `确认门与执行闸不一致：${name}`,
    );
  }
});

test('目录的 32 项（含 phone_* 名与历史别名）全部映射到契约条目', () => {
  const contract = loadContract();
  const index = buildNameIndex(contract);
  assert.equal(catalogTools.length, 32, '目录工具数被改动，需人工确认');
  for (const name of catalogNames) {
    assert.ok(index.has(name), `目录里的名字不在契约里：${name}`);
  }
  for (const tool of catalogTools) {
    const entry = index.get(tool.bridgeName);
    if (tool.dangerous) {
      assert.equal(entry.requiresConfirm, true, `危险工具应要求确认：${tool.bridgeName}`);
    }
  }
  for (const uiTool of catalog.getPhoneBridgeUiTools()) {
    assert.ok(index.has(uiTool), `目录 UI 工具不在契约里：${uiTool}`);
  }
});

test('协作桥的 12 项 wire 工具全部映射到契约条目', () => {
  const contract = loadContract();
  const index = buildNameIndex(contract);
  assert.equal(bridgeToolNames.length, 12, '协作桥 wire 工具数被改动，需人工确认');
  for (const name of bridgeToolNames) {
    assert.ok(index.has(name), `协作桥的 wire 工具不在契约里：${name}`);
  }
});

test('手机端 48 项与手机循环 48 项全部映射到契约条目，且两份清单集合相等', () => {
  const contract = loadContract();
  const index = buildNameIndex(contract);
  assert.equal(phoneNames.length, 48, '手机端 Tools.NAMES 数量被改动，需人工确认');
  assert.equal(
    loopKnownTools.length,
    48,
    '手机端 KNOWN_TOOLS 数量被改动，需人工确认（P0-2 起它与 Tools.NAMES 集合相等）',
  );
  for (const name of phoneNames) {
    assert.ok(index.has(name), `手机端工具不在契约里：${name}`);
  }
  for (const name of loopKnownTools) {
    assert.ok(index.has(name), `手机循环已知工具不在契约里：${name}`);
    assert.ok(phoneNames.includes(name), `手机循环知道一个 Tools.NAMES 里没有的工具：${name}`);
  }
  // 集合相等（按集合比，不看行序）。差集不为空意味着手机端循环会在解析期把那条
  // 命令**静默丢掉**——用户看到的是「什么都没发生」，不是报错。P0-2 之前差集是
  // 12 项（adou_signin / amoo_* / zip / unzip / secret_* / tools）。
  const onlyInNames = phoneNames.filter((name) => !loopKnownTools.includes(name));
  const onlyInKnown = loopKnownTools.filter((name) => !phoneNames.includes(name));
  assert.deepEqual(onlyInNames, [], 'Tools.NAMES 与 KNOWN_TOOLS 的差集必须为空');
  assert.deepEqual(onlyInKnown, [], 'KNOWN_TOOLS 与 Tools.NAMES 的差集必须为空');
});

test('差集与交集：裸名交集只有 ping，桥侧 phone_* 归并后不再误报', (t) => {
  const contract = loadContract();
  const index = buildNameIndex(contract);

  // 目录的「32 项」指手机桥自己应答的那套 wire 名（bridgeName）；
  // phone_* 是目录给 khy-os 侧看的 khy 名与别名，不算桥的 wire 面。
  const rawPolicyBridge = policyTools.filter((name) => bridgeToolNames.includes(name));
  const rawCatalogBridge = [...catalogWireNames].filter((name) => bridgeToolNames.includes(name));
  assert.deepEqual(rawPolicyBridge, ['ping'], '执行闸与协作桥的裸名交集应只有 ping');
  assert.deepEqual(rawCatalogBridge, ['ping'], '目录与协作桥的裸名交集应只有 ping');

  // 归并后：协作桥的每个名字都落到契约条目上（phone_* 通过 alias 归并）。
  const merged = bridgeToolNames.map((name) => ({ name, entry: index.get(name).wireName }));
  const unresolved = merged.filter((row) => !row.entry);
  assert.deepEqual(unresolved, [], '协作桥的名字没能归并到契约条目');

  // 未被任何清单提到的契约条目 = 契约写多的（应当为空）。
  const allListed = new Set([...policyTools, ...catalogNames, ...phoneNames, ...bridgeToolNames]);
  const orphans = contract.tools
    .filter((tool) => !allListed.has(tool.wireName))
    .map((tool) => tool.wireName);
  assert.deepEqual(orphans, [], '契约里有任何清单都没提到的条目');

  // 目录的 khy 名面与协作桥的 wire 名有三处字面重名（phone_info / phone_exec /
  // phone_ls）——同一能力两个名字，正是 alias 归并要消掉的那类误报。
  const colliding = [...catalogKhyNames].filter((name) => bridgeToolNames.includes(name));

  t.diagnostic([
    `清单计数：policy ${policyTools.length} / catalog ${catalogTools.length} / bridge ${bridgeToolNames.length} / names ${phoneNames.length} / known ${loopKnownTools.length}`,
    `裸名交集：policy∩bridge=${rawPolicyBridge.join(',')} catalog∩bridge=${rawCatalogBridge.join(',')}`,
    `目录 khy 名面与桥 wire 面的字面重名（靠 alias 归并）：${colliding.join(',')}`,
    `归并后 bridge→契约：${merged.map((row) => `${row.name}→${row.entry}`).join(' ')}`,
    `契约条目 ${contract.tools.length} 条；清单未覆盖 ${orphans.length} 条`,
  ].join('\n'));
});
