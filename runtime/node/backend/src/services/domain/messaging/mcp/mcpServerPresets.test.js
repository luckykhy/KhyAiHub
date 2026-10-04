/**
 * mcpServerPresets.test.js — 钉死预设注册表的表规模、别名解析与门控关的三态回退。
 *
 * 为什么这支套件必须存在：这张表决定 `khy mcp add <短名>` 展开成什么命令，
 * `khy mcp presets` 展示什么清单。它宣称原型污染安全（hasOwnProperty）与
 * "requiresEnv 缺失不阻断"两条方向，都必须测钉；表规模（19 预设 + 10 别名）
 * 是发现入口的内容合同。
 *
 * 实测更正（与源码注释/上游直觉不同处，按真实语义钉死）：
 * 1. canonicalPresetName 对 'constructor'/'toString' 等原型键返回 ''（hasOwnProperty 守卫）
 *    —— 污染方向安全，实测钉住。
 * 2. resolvePreset(name, null) 抛 TypeError：`opts.gateEnv` 在默认参数之后仍炸 null。
 * 3. extraArgs 经 String 化并滤除空串：数字 5 进 args 成 '5'，'' 被丢。
 * 4. 门控关三态一致：hasPreset false / resolvePreset {ok:false,error:'MCP 预设未启用…'} /
 *    listPresets []。
 * 5. requiresEnv 缺项只登记 meta.missingEnv，不阻断 ok。
 * 6. config.env 是 {...env} 拷贝；meta.requiresEnv 也是 slice 拷贝——改调用方数组不回写。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('./mcpServerPresets');

test('presets: 导出面与表规模（19 预设 + 10 别名合同）', () => {
  assert.deepStrictEqual(Object.keys(leaf).sort(), ['_ALIASES', '_PRESETS', 'canonicalPresetName', 'hasPreset', 'isPresetsEnabled', 'listPresets', 'resolvePreset']);
  assert.equal(Object.keys(leaf._PRESETS).length, 19);
  assert.equal(Object.keys(leaf._ALIASES).length, 10);
  assert.ok(Object.isFrozen(leaf._PRESETS));
  assert.ok(Object.isFrozen(leaf._ALIASES));
  for (const p of Object.values(leaf._PRESETS)) {
    assert.equal(p.transport, 'stdio');
    assert.ok(Array.isArray(p.args) && p.args.length > 0);
    assert.ok(Array.isArray(p.requiresEnv));
  }
});

test('presets: 门控 —— flagRegistry CANON 四词 + 本地回退同四词，默认开', () => {
  for (const off of ['0', 'false', 'off', 'no', ' OFF']) {
    assert.equal(leaf.isPresetsEnabled({ KHY_MCP_PRESETS: off }), false, off);
  }
  for (const on of [undefined, null, '', '1', 'true']) {
    assert.equal(leaf.isPresetsEnabled({ KHY_MCP_PRESETS: on }), true, JSON.stringify(on));
  }
  assert.equal(leaf.isPresetsEnabled(null), true);
});

test('presets: canonicalPresetName —— 小写/trim/别名 + 原型键守卫（污染安全实测钉住）', () => {
  assert.equal(leaf.canonicalPresetName('GITHUB'), 'github');
  assert.equal(leaf.canonicalPresetName(' gh '), 'github');
  assert.equal(leaf.canonicalPresetName('fs'), 'filesystem');
  assert.equal(leaf.canonicalPresetName('seq-thinking'), 'sequential-thinking');
  assert.equal(leaf.canonicalPresetName('postgresql'), 'postgres');
  assert.equal(leaf.canonicalPresetName('constructor'), '');  // hasOwnProperty 守卫
  assert.equal(leaf.canonicalPresetName('toString'), '');
  assert.equal(leaf.canonicalPresetName('__proto__'), '');
  assert.equal(leaf.canonicalPresetName('nope'), '');
  assert.equal(leaf.canonicalPresetName(null), '');
  assert.equal(leaf.canonicalPresetName(42), '');
});

test('presets: hasPreset —— 门控三态一致', () => {
  assert.equal(leaf.hasPreset('github', {}), true);
  assert.equal(leaf.hasPreset('gh', {}), true);
  assert.equal(leaf.hasPreset('nope', {}), false);
  assert.equal(leaf.hasPreset('github', { KHY_MCP_PRESETS: 'off' }), false);
});

test('presets: resolvePreset —— 构形/extraArgs 化串/env 拷贝/missingEnv 不阻断', () => {
  const r = leaf.resolvePreset('fs', { extraArgs: ['~/D', '', 5], env: { A: '1' }, gateEnv: {} });
  assert.equal(r.ok, true);
  assert.equal(r.name, 'filesystem');
  assert.deepEqual(r.config, { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '~/D', '5'], env: { A: '1' } });
  assert.equal(r.meta.argHint.includes('目录'), true);
  // env 是拷贝
  const envSrc = { A: '1' };
  const r2 = leaf.resolvePreset('memory', { env: envSrc, gateEnv: {} });
  envSrc.A = 'MUT';
  assert.equal(r2.config.env.A, '1'); // {...env} 快照 — 实测钉住
  // requiresEnv 缺项不阻断，missingEnv 登记；给齐则空
  const gh = leaf.resolvePreset('github', { gateEnv: {} });
  assert.equal(gh.ok, true);
  assert.deepEqual(gh.meta.missingEnv, ['GITHUB_PERSONAL_ACCESS_TOKEN']);
  assert.equal('env' in gh.config, false); // 无 env 不出 env 键
  const gh2 = leaf.resolvePreset('github', { env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'x' }, gateEnv: {} });
  assert.deepEqual(gh2.meta.missingEnv, []);
  const req = gh2.meta.requiresEnv;
  req.push('X');
  assert.equal(leaf._PRESETS.github.requiresEnv.length, 1); // meta 是 slice 拷贝，表不回写
  // 未知名 / 门控关 / null opts
  assert.deepEqual(leaf.resolvePreset('nope', { gateEnv: {} }), { ok: false, error: '未知 MCP 预设「nope」。用 `khy mcp presets` 查看全部可用预设。' });
  assert.deepEqual(leaf.resolvePreset('github', { gateEnv: { KHY_MCP_PRESETS: '0' } }), { ok: false, error: 'MCP 预设未启用(KHY_MCP_PRESETS 已关闭)。' });
  assert.throws(() => leaf.resolvePreset('github', null), TypeError);
  // extraArgs 非数组 → 忽略
  assert.deepEqual(leaf.resolvePreset('time', { extraArgs: 'x', gateEnv: {} }).config.args, ['mcp-server-time']);
});

test('presets: listPresets —— 排序全表 / 门控关空数组', () => {
  const list = leaf.listPresets({});
  assert.equal(list.length, 19);
  assert.deepEqual(list.map((x) => x.name), [...list.map((x) => x.name)].sort());
  const fsRow = list.find((x) => x.name === 'filesystem');
  assert.equal(fsRow.command, 'npx -y @modelcontextprotocol/server-filesystem');
  assert.ok(fsRow.homepage.startsWith('https://'));
  assert.deepEqual(leaf.listPresets({ KHY_MCP_PRESETS: 'no' }), []);
});
