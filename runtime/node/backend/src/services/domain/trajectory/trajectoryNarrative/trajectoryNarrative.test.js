'use strict';

/**
 * trajectoryNarrative.test.js — 故事层/话语层/成稿/润色契约的单测。
 * 全程内存 fixture，不碰磁盘与模型。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { collectStory, KIND } = require('./storyCollect');
const { buildNarrative, _verb } = require('./discourse');
const { renderNarrative } = require('./render');
const { maybePolish, _validatePolish } = require('./polish');

let _id = 0;
const BASE_TS = 1760000000000;

function _msg(over) {
  _id += 1;
  return {
    uuid: 'u' + _id,
    parentUuid: _id > 1 ? 'u' + (_id - 1) : null,
    role: 'user',
    content: '',
    timestamp: BASE_TS + _id * 1000,
    isMeta: false,
    isCompactSummary: false,
    ...over,
  };
}

function _call(seq, name, paramsSummary, status, extra = {}) {
  return { seq, name, paramsSummary, status, ...extra };
}

function fixture() {
  _id = 0;
  return [
    _msg({ role: 'user', content: '修复登录页的崩溃问题' }),
    _msg({
      role: 'assistant',
      content: '',
      _timeline: [{ type: 'thinking', text: '先定位崩溃的调用栈，再决定改哪里。' }],
      _toolCalls: [
        _call(1, 'read', 'src/login.js', 'done', { durationMs: 200 }),
        _call(2, 'read', 'src/auth.js', 'done', { durationMs: 150 }),
        _call(3, 'edit', 'src/login.js', 'done', { durationMs: 300 }),
      ],
      _turnStats: { elapsedMs: 5000, toolCount: 3 },
    }),
    _msg({
      role: 'assistant',
      content: '',
      _toolCalls: [
        _call(1, 'bash', 'npm test', 'error', {
          durationMs: 8000,
          error: 'TypeError: x is not a function',
        }),
        _call(2, 'bash', 'npm test', 'done', { durationMs: 7000 }),
      ],
      _turnStats: { elapsedMs: 16000, toolCount: 2 },
    }),
    _msg({
      role: 'assistant',
      content: '测试已通过，顺手复核一遍登录页的边界条件。',
      _toolCalls: [
        _call(1, 'grep', 'validateInput', 'done', { durationMs: 100 }),
        _call(2, 'edit', 'src/login.js', 'done', { durationMs: 250 }),
      ],
      _turnStats: { elapsedMs: 3000, toolCount: 2 },
    }),
  ];
}

test('storyCollect: 严格时序 + 事件种类 + seq 连续', () => {
  const { events, stats } = collectStory(fixture());
  assert.equal(stats.userRequests, 1);
  assert.equal(stats.toolCalls, 7);
  assert.equal(stats.toolErrors, 1);
  assert.equal(stats.thinkings, 1);
  events.forEach((e, i) => assert.equal(e.seq, i + 1));

  assert.equal(events[0].kind, KIND.USER_REQUEST);
  assert.equal(events[0].text, '修复登录页的崩溃问题');
  const err = events.find((e) => e.outcome === 'error');
  assert.equal(err.name, 'bash');
  assert.equal(err.text, 'TypeError: x is not a function');
  assert.ok(events.some((e) => e.kind === KIND.TURN_END));
  assert.equal(events[1].kind, KIND.ASSISTANT_THINKING);
});

test('storyCollect: 空输入与无 timeline 回退', () => {
  assert.deepEqual(collectStory(null).events, []);
  const { events } = collectStory([_msg({ role: 'assistant', content: '纯文本回复，没有工具。' })]);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, KIND.ASSISTANT_TEXT);
  assert.equal(events[0].text, '纯文本回复，没有工具。');
});

test('storyCollect: 旧 transcript 的 tool_use 块回退（outcome 留空，绝不虚构成功）', () => {
  const { events } = collectStory([
    _msg({ role: 'user', content: '查一下登录页代码' }),
    _msg({
      role: 'assistant',
      content: [
        { type: 'text', text: '先读文件。' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/login.js' } },
        { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'src/login.js' } },
      ],
    }),
  ]);
  const tools = events.filter((e) => e.kind === KIND.TOOL_CALL);
  assert.equal(tools.length, 2);
  assert.equal(tools[0].name, 'Read');
  assert.equal(tools[0].target, 'src/login.js');
  assert.equal(tools[0].outcome, undefined);

  // 两次连续同目标读取合并，但无结果记录时不许讲成「第 k 次成功」
  //（无失败无耗时的只读组走概要档，合并标记为 ×2）
  const plan = buildNarrative(events);
  const merged = plan.paragraphs.find((p) => p.text.includes('×2'));
  assert.ok(merged);
  assert.match(merged.text, /读取 src\/login\.js ×2/);
  assert.ok(!merged.text.includes('成功'));
  // 概要段是批量压缩：assistant 文本句与两个工具事件共段，两个工具 seq 都须在锚点里
  assert.ok(merged.anchors.includes(tools[0].seq));
  assert.ok(merged.anchors.includes(tools[1].seq));
});

test('discourse: 频率算子把连续重试合并为「2 次…第 2 次成功」', () => {
  const { events } = collectStory(fixture());
  const plan = buildNarrative(events);
  const merged = plan.paragraphs.find((p) => p.text.includes('2 次'));
  assert.ok(merged, '应存在复数叙述段');
  assert.equal(merged.mode, 'scene'); // 组内有失败 → 场景
  assert.match(merged.text, /先后 2 次执行 npm test（第 2 次成功）/);
  assert.equal(merged.anchors.length, 2); // 两个 bash 事件的 seq 都在
  assert.ok(plan.stats.iterativeMerged >= 1);
});

test('discourse: 时距四档分类正确', () => {
  const { events } = collectStory(fixture());
  const plan = buildNarrative(events);

  // 场景：用户请求 + 写入 edit + 含失败的 bash 组 + 第二次 edit
  const scenes = plan.paragraphs.filter((p) => p.mode === 'scene');
  assert.equal(scenes.length, 4);
  assert.match(scenes[0].text, /^用户提出：修复登录页的崩溃问题/);

  // 概要：两个 read 压进一段，以句号收尾
  const summaries = plan.paragraphs.filter((p) => p.mode === 'summary');
  const readSummary = summaries.find((p) => p.text.includes('读取 src/login.js'));
  assert.ok(readSummary);
  assert.ok(readSummary.text.endsWith('。'));
  assert.ok(readSummary.text.includes('读取 src/auth.js'));

  // 省略（外聚焦）：thinking + 3 个 turn.end
  assert.equal(plan.stats.ellipsis, 4);
});

test('discourse: 折返修改标倒叙「回到第 k 步」', () => {
  const { events } = collectStory(fixture());
  const plan = buildNarrative(events);
  const back = plan.paragraphs.find((p) => p.analepsis);
  assert.ok(back, '第二次 edit src/login.js 应标倒叙');
  assert.match(back.text, /^回到第 \d+ 步：KHY 编辑 src\/login\.js/);
  const first = plan.paragraphs.find(
    (p) => p.mode === 'scene' && p.text === 'KHY 编辑 src/login.js'
  );
  assert.ok(first);
  assert.equal(back.analepsis.backTo, first.anchors[0]);
});

test('discourse: 聚焦控制 thinking 是否入叙事（语式）', () => {
  const { events } = collectStory(fixture());
  const task = buildNarrative(events, { focus: 'task' });
  assert.ok(!task.paragraphs.some((p) => p.mode === 'pause'));

  const reasoning = buildNarrative(events, { focus: 'reasoning' });
  const pause = reasoning.paragraphs.find((p) => p.mode === 'pause');
  assert.ok(pause);
  assert.match(pause.text, /^KHY 分析：先定位崩溃的调用栈/);
});

test('discourse: 动词映射', () => {
  assert.equal(_verb('read'), '读取');
  assert.equal(_verb('multiEdit'), '编辑');
  assert.equal(_verb('bash'), '执行');
  assert.equal(_verb('someCustomTool'), '调用 someCustomTool');
});

test('render: 预叙在前 + 过程叙事带锚点 + 锚点表完备', () => {
  const messages = fixture();
  const { events } = collectStory(messages);
  const plan = buildNarrative(events);
  const recap = require('../../../sessionRecapService').generateRecap(messages);

  const { markdown, anchorCount } = renderNarrative({
    plan,
    events,
    recap,
    sessionId: 'sess-test-1234',
    mode: 'both',
  });

  assert.match(markdown, /# 任务叙事 — sess-tes/);
  const idxResult = markdown.indexOf('## 结果叙事（预叙）');
  const idxProcess = markdown.indexOf('## 过程叙事');
  assert.ok(idxResult >= 0 && idxProcess > idxResult, '结果叙事必须置于过程叙事之前（预叙）');
  assert.match(markdown, /## 证据锚点/);

  // 过程段出现的每个 [#n] 都要在锚点表里查得到
  const processPart = markdown.slice(idxProcess, markdown.indexOf('## 证据锚点'));
  const cited = new Set([...processPart.matchAll(/\[#(\d+)\]/g)].map((m) => Number(m[1])));
  assert.ok(cited.size > 0);
  assert.equal(cited.size, anchorCount);
  const tablePart = markdown.slice(markdown.indexOf('## 证据锚点'));
  for (const n of cited) {
    assert.ok(tablePart.includes(`[#${n}]`), `锚点表缺 [#${n}]`);
  }
});

test('render: mode=result 只出结果叙事', () => {
  const messages = fixture();
  const { events } = collectStory(messages);
  const plan = buildNarrative(events);
  const recap = require('../../../sessionRecapService').generateRecap(messages);
  const { markdown } = renderNarrative({ plan, events, recap, sessionId: 's', mode: 'result' });
  assert.match(markdown, /## 结果叙事（预叙）/);
  assert.ok(!markdown.includes('## 过程叙事'));
});

test('polish: 锚点契约三违规 + 通过', () => {
  const skeleton = '# 任务叙事\n- KHY 读取 a [#1]\n- KHY 编辑 b [#2]\n';
  assert.equal(_validatePolish(skeleton, '# 任务叙事\n- KHY 读取 a [#1]\n- KHY 编辑 b [#2]\n'), null);
  assert.equal(_validatePolish(skeleton, '- KHY 读取 a [#1]\n'), 'anchor-dropped');
  assert.equal(_validatePolish(skeleton, '- a [#1]\n- b [#2]\n- c [#3]\n'), 'anchor-injected');
  assert.equal(_validatePolish(skeleton, '[#1][#2]' + '水'.repeat(skeleton.length * 4)), 'too-long');
});

test('polish: 门关时原样返回骨架', async () => {
  const r = await maybePolish('骨架 [#1]', { env: {} });
  assert.deepEqual(r, { text: '骨架 [#1]', polished: false, reason: 'gate-off' });
});
