'use strict';

/**
 * fallbackDisclosureWiring.test.js — [DESIGN-ARCH-181] 一期 D3-2 的**接线锁**用例。
 *
 * 为什么是「静态接线锁」而非端到端:披露链要穿过三个巨型文件
 * （aiChatCore 5135 行 / toolUseLoopCore 10555 行 / useQueryBridge 4469 行），
 * TUI 钩子需 React/Ink 运行时,在 node:test 里没有可用的挂载点。而本期的**唯一**
 * 风险恰是「有人顺手删掉/拆散转发行」——转发一旦断,披露就静默消失,且不会有
 * 任何现成测试变红。故用源文本断言把三处透传 + 一处 notice 接线钉死:
 *
 *   ① toolUseLoopCore:  success 返回透传 aiResult.routeFact
 *   ② aiChatCore:       chat 成功返回透传 result.routeFact
 *   ③ useQueryBridge:   工具路径 result 映射透传 loopResult.routeFact
 *   ④ useQueryBridge:   回合末 notice 助手存在且被调用(独立行,不注正文)
 *
 * 同时钉住「零行增长」约定:三处透传必须与既有字段**同行**(L1 文件棘轮的 HARD
 * 指标 maxFuncLines 按最长块计,在这些文件的大块内新增一行即 CI 变红)。若未来
 * 有人把合并行拆成两行,本测试立即报出「拆行会撞棘轮」而不是等他去撞 CI。
 *
 * 本文件用 `require('node:test')`(jest.config.js 按标记自动忽略;test:node 会跑它)。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '../../src');

/** 读源文件并返回行数组(1-based 语义由 findLineNo 负责)。 */
function readLines(rel) {
  return fs.readFileSync(path.join(SRC, rel), 'utf8').split('\n');
}

/** 找含 marker 的行,返回 {no, text};找不到抛断言失败。 */
function findLine(lines, marker, rel) {
  const no = lines.findIndex((l) => l.includes(marker));
  assert.ok(no >= 0, `${rel} 缺接线:找不到 "${marker}"`);
  return { no: no + 1, text: lines[no] };
}

const TOOL_LOOP = 'services/tool/toolUseLoopCore.js';
const CHAT_CORE = 'cli/aiChatCore.js';
const QUERY_BRIDGE = 'cli/tui/hooks/useQueryBridge.js';

test('W-01 toolUseLoopCore:success 返回透传 aiResult.routeFact(同行合并)', () => {
  const lines = readLines(TOOL_LOOP);
  const hit = findLine(lines, '...(aiResult.routeFact ? { routeFact: aiResult.routeFact } : {})', TOOL_LOOP);
  assert.ok(
    hit.text.includes('promptRound'),
    'routeFact 透传须与既有 promptRound spread 同行(拆行 → 最长块 +1 → 棘轮红)',
  );
  assert.strictEqual(
    lines.filter((l) => l.includes('routeFact: aiResult.routeFact')).length,
    1,
    '透传只应出现一次(防重复追加)',
  );
});

test('W-02 aiChatCore:chat 成功返回透传 result.routeFact(同行合并)', () => {
  const lines = readLines(CHAT_CORE);
  const hit = findLine(lines, 'routeFact: result.routeFact || null', CHAT_CORE);
  assert.ok(hit.text.trim().startsWith('effort,'), 'routeFact 须与 effort 同行(零行增长纪律)');
  assert.strictEqual(lines.filter((l) => l.includes('routeFact: result.routeFact')).length, 1);
});

test('W-03 useQueryBridge:工具路径 result 映射透传 loopResult.routeFact(同行合并)', () => {
  const lines = readLines(QUERY_BRIDGE);
  const hit = findLine(lines, 'routeFact: loopResult.routeFact || null', QUERY_BRIDGE);
  assert.ok(hit.text.includes('loopElapsedMs'), '须与 loopElapsedMs 同行(零行增长纪律)');
  assert.strictEqual(lines.filter((l) => l.includes('routeFact: loopResult.routeFact')).length, 1);
});

test('W-04 useQueryBridge:回合末 notice 接线存在(助手定义 + 单点调用)', () => {
  const lines = readLines(QUERY_BRIDGE);
  findLine(lines, 'function _withCascadeNotice(messages, result) {', QUERY_BRIDGE);
  findLine(
    lines,
    'setMessages((m) => _withCascadeNotice(dedupAdjacentAssistantBursts(m, process.env), result));',
    QUERY_BRIDGE,
  );
  const calls = lines.filter((l) => l.includes('_withCascadeNotice(')).length;
  assert.strictEqual(calls, 2, '定义 1 处 + 调用 1 处;多余调用会造成重复 notice');
});

test('W-05 notice 助手契约:独立 role:notice 行、不注入回复正文、fail-soft 兜底', () => {
  const src = readLines(QUERY_BRIDGE).join('\n');
  const start = src.indexOf('function _withCascadeNotice(');
  const body = src.slice(start, src.indexOf('\n}', start));
  assert.ok(body.includes("role: 'notice'"), '必须走独立 notice 行');
  assert.ok(body.includes('formatCascadeNotice'), '文案须来自 routeFact 叶子的单一真源');
  assert.ok(
    body.includes("require('../../../services/gateway/routeFact')"),
    'require 路径须指向叶子(相对路径从 tui/hooks 起算三级)',
  );
  assert.ok(!body.includes('result.reply'), '绝不触碰回复正文(设计红线:不污染复制/解析)');
  assert.ok(body.includes('catch'), 'fail-soft:异常必须原样返回消息数组');
});

test('W-06 披露链各段可加载且符号齐备(叶子导出面没被改坏)', () => {
  const routeFact = require('../../src/services/gateway/routeFact');
  for (const name of ['buildRouteFact', 'formatCascadeNotice', 'formatRouteFactLabel', '_assertCoherent']) {
    assert.strictEqual(typeof routeFact[name], 'function', name);
  }
  const policy = require('../../src/services/gateway/fallbackEligibilityPolicy');
  for (const name of ['classifyFailureOwnership', 'probeEnvironmentOutage', 'decideFallback']) {
    assert.strictEqual(typeof policy[name], 'function', name);
  }
  assert.strictEqual(typeof require('../../src/services/gateway/cliFailureEnvelope').buildCliFailureEnvelope, 'function');
});
