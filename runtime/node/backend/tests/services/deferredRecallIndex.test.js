'use strict';

/**
 * deferredRecallIndex — 延迟工具召回词表单测(node:test)。
 *
 * 回归目标(khyos 自审 #4「工具发现成本高」的残余面:召回不到):
 *   ① **召回词不变量(核心)**:索引里每个词都必须能被**真实打分器** scoreTool 命中(>0)——
 *      词表与召回通道同源,否则「列了却搜不中」= 机制骗人。
 *   ② **覆盖**:未揭示的延迟工具一个都不能被压缩规则吞掉(名字必须全在)。
 *   ③ **派生**:词表从工具元数据(aliases/searchHint)现场派生,不是第二份手搓表——
 *      换一份元数据,输出随之变。
 *   ④ **门控字节回退**:关 → 与历史裸名清单逐字节相同;空清单 → ''。
 *   ⑤ 确定性 / 有界(条数+每词上限) / fail-soft(绝不抛)。
 *
 * node:test(jest 经 rtk 代理报 Exec format error 不可用;同仓 toolClusterActivation.test.js)。
 */
const test = require('node:test');
const assert = require('node:assert');

const mod = require('../../src/services/tool/deferredRecallIndex');
const { scoreTool } = require('../../src/tools/toolRecommend');

const OFF_WORDS = ['0', 'false', 'off', 'no'];

/** 真实 registry 的未揭示延迟工具(本仓实测 36 个,此处不锁数量,只锁关系)。 */
function liveUnrevealed() {
  const reg = require('../../src/tools');
  if (reg.loadTools) reg.loadTools();
  const deferred = reg.getDeferredTools();
  const revealed = reg.getRevealedDeferred();
  const unrevealed = [];
  for (const [name] of deferred) {
    if (!revealed.has(name)) unrevealed.push(name);
  }
  return { deferred, unrevealed };
}

/** 历史格式(2026-10-13 前接缝里的拼接原文)——字节回退的对照物。 */
function legacyLiteral(names) {
  return (
    `# Additional Tools\n` +
    `The following tools are available but not currently loaded to save context space. ` +
    `Use the toolSearch tool to discover and activate them when needed:\n` +
    names.join(', ')
  );
}

// ── ① 召回词不变量:每个词都真的能被 scoreTool 命中 ──────────────────────────
test('真实 registry:索引里每个召回词都能被真实 scoreTool 命中(>0)', () => {
  const { deferred, unrevealed } = liveUnrevealed();
  assert.ok(unrevealed.length > 0, '本仓应有未揭示的延迟工具');
  let checked = 0;
  for (const name of unrevealed) {
    const tool = deferred.get(name);
    for (const tok of mod.vocabularyForTool(tool)) {
      const score = scoreTool(tool, [tok]);
      assert.ok(score > 0, `${name} 的召回词 '${tok}' 在真实打分器下得 0 分 —— 索引列了搜不中的词`);
      checked++;
    }
  }
  assert.ok(checked >= unrevealed.length, `词数应不少于工具数(实测 ${checked})`);
});

// ── ② 覆盖:名字一个都不能少 ────────────────────────────────────────────────
test('真实 registry:未揭示延迟工具的名字全部出现在索引里(压缩不吞条目)', () => {
  const { deferred, unrevealed } = liveUnrevealed();
  const block = mod.buildDeferredToolsHint(unrevealed, deferred, { env: {} });
  const missing = unrevealed.filter(
    (n) => !block.includes(`\n- ${n}:`) && !block.includes(`\n- ${n}\n`)
  );
  assert.deepStrictEqual(missing, [], `索引漏了这些工具:${missing.join(', ')}`);
});

// ── ③ 派生:词表来自元数据,不是手搓表 ──────────────────────────────────────
test('派生:元数据变则词表变(合成工具,不依赖仓内具体工具名)', () => {
  const tool = {
    name: 'WidgetForge',
    aliases: ['widget_forge'],
    searchHint: 'frobnicate widgets 部件',
  };
  const vocab = mod.vocabularyForTool(tool);
  assert.ok(vocab.includes('widget_forge'), `应含别名,实得 ${JSON.stringify(vocab)}`);
  assert.ok(vocab.includes('frobnicate'), `应含 hint 词,实得 ${JSON.stringify(vocab)}`);
  assert.ok(vocab.includes('部件'), '中文词应保留(中文召回面)');
  // 同形词剔除:名字词块 'widget' 不应作为召回词出现(hint 里没有,这里顺带锁去重方向)
  const block = mod.buildDeferredToolsHint(['WidgetForge'], [tool], { env: {} });
  assert.ok(block.includes('- WidgetForge: widget_forge frobnicate widgets 部件'), block);
});

// ── ④ 门控字节回退 ─────────────────────────────────────────────────────────
test('门控关 → 与历史裸名清单逐字节相同', () => {
  const { deferred, unrevealed } = liveUnrevealed();
  for (const off of OFF_WORDS) {
    const out = mod.buildDeferredToolsHint(unrevealed, deferred, {
      env: { KHY_TOOL_RECALL_INDEX: off },
    });
    assert.strictEqual(out, legacyLiteral(unrevealed), `关闭词 ${off} 未逐字节回退`);
    assert.ok(!out.includes('recall keywords'), `关闭词 ${off} 不应含索引使用行`);
  }
});

test("空清单 → ''(无未揭示工具则不注入,与历史一致)", () => {
  assert.strictEqual(mod.buildDeferredToolsHint([], new Map(), { env: {} }), '');
  assert.strictEqual(
    mod.buildDeferredToolsHint([], new Map(), { env: { KHY_TOOL_RECALL_INDEX: '0' } }),
    ''
  );
  assert.strictEqual(mod.legacyHint([]), '');
});

test('isEnabled:默认开 + 关闭词表', () => {
  assert.strictEqual(mod.isEnabled({}), true);
  for (const off of OFF_WORDS) {
    assert.strictEqual(mod.isEnabled({ KHY_TOOL_RECALL_INDEX: off }), false, off);
  }
});

// ── ⑤ 确定性 / 有界 / fail-soft ────────────────────────────────────────────
test('确定性:同输入两次输出相同,且与工具表插入顺序无关', () => {
  const { deferred, unrevealed } = liveUnrevealed();
  const a = mod.buildDeferredToolsHint(unrevealed, deferred, { env: {} });
  const b = mod.buildDeferredToolsHint(unrevealed.slice().reverse(), deferred, { env: {} });
  const c = mod.buildDeferredToolsHint(unrevealed, deferred, { env: {} });
  assert.strictEqual(a, c, '同输入应稳定');
  assert.strictEqual(a, b, '名字顺序不该影响输出(内部排序)');
});

test('有界:maxTools 截断并如实标注剩余量;每工具词数不超过 maxTokens', () => {
  const tools = new Map();
  const names = [];
  for (let i = 0; i < 5; i++) {
    const n = `Tool${i}`;
    names.push(n);
    tools.set(n, { name: n, aliases: [], searchHint: 'alpha beta gamma delta epsilon zeta eta' });
  }
  const block = mod.buildDeferredToolsHint(names, tools, { env: {}, maxTools: 2, maxTokens: 3 });
  assert.ok(block.includes('3 more deferred tool(s) not listed'), block);
  const bodyLines = block.split('\n').filter((l) => l.startsWith('- '));
  assert.strictEqual(bodyLines.length, 2);
  for (const line of bodyLines) {
    const words = line.slice(line.indexOf(': ') + 2).split(' ');
    assert.ok(words.length <= 3, `每工具词数应 ≤3:${line}`);
  }
});

test('fail-soft:异常输入绝不抛;缺元数据 → 只有名字', () => {
  assert.doesNotThrow(() => mod.buildDeferredToolsHint(null, null, null));
  assert.doesNotThrow(() => mod.vocabularyForTool(null));
  assert.doesNotThrow(() => mod.formatRecallIndex(undefined, undefined, undefined));
  assert.strictEqual(mod.buildDeferredToolsHint(null, null, { env: {} }), '');
  assert.deepStrictEqual(mod.vocabularyForTool(undefined), []);
  const block = mod.buildDeferredToolsHint(['GhostTool'], new Map(), { env: {} });
  assert.ok(block.includes('- GhostTool'), block);
});

test('块形态:标记行 + 使用行(点掉手搓退路) + select: 精确取用指引', () => {
  const { deferred, unrevealed } = liveUnrevealed();
  const block = mod.buildDeferredToolsHint(unrevealed, deferred, { env: {} });
  assert.ok(block.startsWith('# Additional Tools\n'), '首行标记与历史一致');
  assert.ok(block.includes('Before hand-rolling a one-off script'), '应点掉手搓退路');
  assert.ok(block.includes('select:<ToolName>'), '应给出 select: 精确取用');
});

// ── 阶段常量(executorStage 权威,check-rollout-stage 读源码比对)────────────
test('落地阶段:S1(只加词、不拦截)', () => {
  assert.strictEqual(mod.KHY_TOOL_RECALL_INDEX_STAGE, 'S1');
});
