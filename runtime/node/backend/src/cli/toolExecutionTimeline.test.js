'use strict';

/**
 * Colocated contract test for toolExecutionTimeline.js (producer S5).
 *
 * Pinned here:
 *   ① the gate literal + predicate (KHY_TUI_TOOL_GROUPS, only '1' opens it) — a gate that drifts
 *      to "any truthy string" silently turns the producer on for installs that never asked.
 *   ② all three on-disk timeline shapes decode: live `{type:'tool', tool}` (with input/result),
 *      persisted `{type:'tools', tools:[light]}` (`{name, paramsSummary, status}`), and
 *      narration segments (`text` / `thinking`) as first-class narration rows.
 *   ③ id collisions do not collapse rows: without a toolId useQueryBridge falls back to
 *      `loop-<name>`, so two Reads in one turn share an id — D2 dedups by id and would silently
 *      render one row. The suffix is applied only when a collision is actually detected.
 *   ④ the notice severity has no member in the six-state vocabulary; it is counted as success and
 *      its explanatory text still rides in the summary (nothing is lost, only the state is coarse).
 *   ⑤ read-only: no input segment is mutated, garbage never throws, and the projection carries no
 *      ANSI bytes (the producer is a data producer, not a renderer).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TOOL_GROUPS_ENV,
  isToolGroupsEnabled,
  timelineToSteps,
  timelineToRows,
  timelineToGroups,
  projectTurnTimeline,
  projectToolList,
} = require('./toolExecutionTimeline');

// ── ① gate ──────────────────────────────────────────────────────────────────

test('the gate is a named env var that only "1" opens', () => {
  assert.equal(TOOL_GROUPS_ENV, 'KHY_TUI_TOOL_GROUPS');
  assert.equal(isToolGroupsEnabled('1'), true);
  assert.equal(isToolGroupsEnabled(' 1 '), true);
  for (const off of ['0', 'true', 'yes', 'on', '', undefined, null, 1, {}, '2']) {
    assert.equal(isToolGroupsEnabled(off), false, `${JSON.stringify(off)} must not open the gate`);
  }
});

// ── ② three timeline shapes ─────────────────────────────────────────────────

test('live timeline: text + running tool + resolved tool, in order', () => {
  const timeline = [
    { type: 'text', text: '先看一下配置' },
    { type: 'tool', tool: { name: 'Read', input: { path: 'a.js' }, id: 'tu_1', progress: '正在读取 a.js' } },
    { type: 'tool', tool: { name: 'Read', input: { path: 'b.js' }, id: 'tu_2', result: { text: '...', isError: false, summary: '已读取 42 行' } } },
    { type: 'text', text: '读完了' },
  ];
  const steps = timelineToSteps(timeline);
  assert.deepEqual(steps.map((s) => s.id), ['tu_1', 'tu_2']);
  assert.deepEqual(steps.map((s) => s.status), ['running', 'success']);
  assert.equal(steps[0].summary, '正在读取 a.js', 'a running row shows its live narration');
  assert.equal(steps[1].summary, '已读取 42 行');

  const rows = timelineToRows(timeline);
  assert.deepEqual(rows.map((r) => r.kind), ['narration', 'step', 'step', 'narration']);
  assert.deepEqual(rows.map((r) => r.order), [0, 1, 2, 3]);
  assert.equal(rows[0].phase, 'commentary');
  assert.equal(rows[0].text, '先看一下配置');

  const proj = projectTurnTimeline(timeline);
  assert.equal(proj.rows.length, 4, 'one row per segment: narration is never swallowed');
  assert.equal(proj.totals.succeeded, 1);
  assert.equal(proj.totals.unfinished, 1);
});

test('persisted light shape ({type:"tools"}) decodes without a result object', () => {
  const timeline = [
    { type: 'text', text: '批量改文件' },
    { type: 'tools', tools: [
      { name: 'Edit', paramsSummary: 'a.js', status: 'done' },
      { name: 'Edit', paramsSummary: 'b.js', status: 'error' },
    ] },
  ];
  const steps = timelineToSteps(timeline);
  assert.deepEqual(steps.map((s) => s.name), ['Edit', 'Edit']);
  assert.deepEqual(steps.map((s) => s.status), ['success', 'error']);
  assert.deepEqual(steps.map((s) => s.summary), ['a.js', 'b.js']);
  assert.deepEqual(steps.map((s) => s.id), ['tool-0', 'tool-1'], 'light rows carry no id');
  const proj = projectTurnTimeline(timeline);
  assert.equal(proj.totals.succeeded, 1);
  assert.equal(proj.totals.failed, 1);
});

test('thinking segments are narration rows, and their duration rides on the group thoughtMs', () => {
  const proj = projectTurnTimeline([
    { type: 'thinking', text: '先想清楚', durationMs: 11000 },
    { type: 'tool', tool: { name: 'Bash', id: 'b1', result: { text: 'ok', isError: false } } },
  ]);
  assert.deepEqual(proj.rows.map((r) => r.kind), ['narration', 'step']);
  assert.equal(proj.rows[0].text, '先想清楚');
  // The duration lives where D2 keeps it (buildToolGroup's thoughtMs → counts.thoughtMs),
  // not on the row — `_decodeRow` has a closed row shape and would drop it there.
  assert.equal(proj.groups[0].counts.thoughtMs, 11000);
});

test('no thinking segment means no thoughtMs field at all (absent is not zero)', () => {
  const proj = projectTurnTimeline([
    { type: 'text', text: '直接说' },
    { type: 'tool', tool: { name: 'Bash', id: 'b1', result: { text: 'ok', isError: false } } },
  ]);
  assert.equal(proj.groups[0].counts.thoughtMs, undefined);
});

// ── ③ id collisions ─────────────────────────────────────────────────────────

test('two same-name tools without ids keep two rows (no id collapse)', () => {
  const timeline = [
    { type: 'tool', tool: { name: 'Read', id: 'loop-Read' } },
    { type: 'tool', tool: { name: 'Read', id: 'loop-Read' } },
    { type: 'tool', tool: { name: 'Read', id: 'loop-Read' } },
  ];
  assert.deepEqual(timelineToSteps(timeline).map((s) => s.id), ['loop-Read', 'loop-Read#2', 'loop-Read#3']);
  const proj = projectTurnTimeline(timeline);
  assert.equal(proj.groups[0].count, 3);
  assert.equal(proj.rows.length, 3);
});

// ── ④ error / notice ────────────────────────────────────────────────────────

test('a failed tool carries its reason into the step error', () => {
  const proj = projectTurnTimeline([
    { type: 'tool', tool: { name: 'Bash', id: 'b1', result: { text: '', isError: true, error: 'command not found', exitCode: 127 } } },
  ]);
  assert.equal(proj.totals.failed, 1);
  const g = proj.groups[0];
  assert.equal(g.status, 'error');
});

test('notice severity counts as success and keeps its text (no notice state exists)', () => {
  const proj = projectTurnTimeline([
    { type: 'tool', tool: { name: 'Bash', id: 'b1', result: { text: 'ls: a.js', isError: false, severity: 'notice', notice: '目标是单个文件' } } },
  ]);
  assert.equal(proj.totals.succeeded, 1);
  assert.equal(proj.totals.failed, 0);
});

// ── grouping + titles ───────────────────────────────────────────────────────

test('adjacent tools group together; a narration segment splits the run', () => {
  const timeline = [
    { type: 'tool', tool: { name: 'Read', id: '1' } },
    { type: 'tool', tool: { name: 'Edit', id: '2' } },
    { type: 'text', text: '中间说句话' },
    { type: 'tool', tool: { name: 'Bash', id: '3' } },
  ];
  const groups = timelineToGroups(timeline, (tools) => `${tools.length} tools`);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.kind), ['process', 'process']);
  assert.deepEqual(groups.map((g) => g.title), ['2 tools', '1 tools']);
  const proj = projectTurnTimeline(timeline, { describeGroup: (tools) => `${tools.length} tools` });
  // the narration between two runs hangs off the group BEFORE it (D2's rule), never lost.
  assert.equal(proj.rows.length, 4);
  const narration = proj.rows.find((r) => r.kind === 'narration');
  assert.ok(narration && narration.text === '中间说句话');
  for (const r of proj.rows) {
    if (r.kind === 'step') assert.ok(proj.groups.some((g) => g.stepIds.includes(r.stepId)));
  }
});

test('a throwing title producer degrades to an empty title, never a throw', () => {
  const proj = projectTurnTimeline([{ type: 'tool', tool: { name: 'Read', id: '1' } }], {
    describeGroup: () => { throw new Error('voice module exploded'); },
  });
  assert.equal(proj.groups[0].title, '');
  assert.equal(proj.groups.length, 1);
});

test('projectToolList projects the flat tools[] mirror (restored messages)', () => {
  const proj = projectToolList([
    { name: 'Read', id: '1', input: { path: 'a' } },
    { name: 'Grep', id: '2', result: { text: '3 matches', isError: false, summary: '找到 3 个匹配' } },
  ]);
  assert.equal(proj.groups[0].count, 2);
  assert.equal(proj.totals.succeeded, 1);
  assert.equal(proj.totals.unfinished, 1);
});

// ── ⑤ read-only / garbage / no ANSI ─────────────────────────────────────────

test('the projection never mutates the timeline it was handed', () => {
  const timeline = [
    { type: 'text', text: 'hi' },
    { type: 'tool', tool: { name: 'Read', id: '1', input: { path: 'a' }, result: { text: 'x', isError: false } } },
    { type: 'tools', tools: [{ name: 'Edit', status: 'done' }] },
  ];
  const before = JSON.stringify(timeline);
  projectTurnTimeline(timeline, { describeGroup: () => 't' });
  projectToolList(timeline);
  assert.equal(JSON.stringify(timeline), before);
});

test('garbage timelines degrade to a legal projection instead of throwing', () => {
  for (const bad of [null, undefined, 7, 'x', {}, [null, 5, 'y', []], [{ type: 'tool' }], [{ type: 'tools' }], [{ type: 'tools', tools: [null] }]]) {
    const proj = projectTurnTimeline(bad);
    assert.ok(Array.isArray(proj.groups) && Array.isArray(proj.rows) && proj.totals);
  }
  assert.deepEqual(projectToolList(null).rows, []);
});

test('the projection carries no ANSI bytes and no display strings of its own', () => {
  const proj = projectTurnTimeline([
    { type: 'text', text: 'plain' },
    { type: 'tool', tool: { name: 'Read', id: '1', result: { text: 'out', isError: false } } },
  ]);
  const json = JSON.stringify(proj);
  assert.ok(!/\u001b[[0-9;]*[A-Za-z]/.test(json), 'no CSI escape sequences');
  assert.ok(!/\u001b]/.test(json), 'no OSC escape sequences');
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'toolExecutionTimeline.js'), 'utf8');
  assert.ok(!/\bconsole\./.test(src), 'a data producer writes nothing to stdout');
});

// ── ⑥ real reducer shapes: what the hook actually builds ────────────────────

test('projects a timeline built by the hook\'s own reducers (reduceToolPush/Result)', () => {
  const {
    reduceToolPush,
    reduceToolResult,
    projectToolResultForView,
    tlAppendText,
    tlAppendThinking,
  } = require('./tui/hooks/queryBridgeTimeline');

  // Streaming state exactly as useQueryBridge seeds it (line ~1626).
  let s = { text: '', tools: [], thinking: '', timeline: [] };
  s = { ...s, timeline: tlAppendThinking(s.timeline, '先想清楚') };
  s = { ...s, timeline: tlAppendText(s.timeline, '我来改两个文件') };
  s = reduceToolPush(s, { name: 'Edit', params: { path: 'a.js' }, id: 'tu_1' });
  s = reduceToolResult(s, {
    name: 'Edit',
    toolId: 'tu_1',
    result: projectToolResultForView({ success: true, text: 'wrote a.js' }, 'Edit', { path: 'a.js' }),
  });
  s = reduceToolPush(s, { name: 'Bash', params: { command: 'ls' }, id: 'tu_2' });
  s = reduceToolResult(s, {
    name: 'Bash',
    toolId: 'tu_2',
    result: projectToolResultForView({ success: false, text: '', error: 'command not found', exitCode: 127 }, 'Bash', { command: 'ls' }),
  });

  const proj = projectTurnTimeline(s.timeline);
  assert.equal(proj.rows.length, 4, 'thinking + text + 2 tools, in order');
  assert.deepEqual(proj.rows.map((r) => r.kind), ['narration', 'narration', 'step', 'step']);
  assert.equal(proj.groups.length, 1, 'the two tools are one contiguous run');
  assert.equal(proj.groups[0].kind, 'process');
  assert.equal(proj.totals.succeeded, 1);
  assert.equal(proj.totals.failed, 1);
  assert.equal(proj.groups[0].status, 'error');
  // The narration rows survive: the group summary reads counts, never the prose.
  assert.ok(proj.rows.some((r) => r.kind === 'narration' && r.text === '我来改两个文件'));
  // The flat tools[] mirror projects to the same facts.
  const flat = projectToolList(s.tools);
  assert.equal(flat.groups[0].count, 2);
  assert.equal(flat.totals.failed, 1);
});

// ── ⑦ the hook wiring is gated and fail-soft (source contract) ──────────────

test('useQueryBridge emits the projection only behind the gate, and never throws into a turn', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, 'tui', 'hooks', 'useQueryBridge.js'),
    'utf8'
  );
  // gate read at the top of the emitter.
  // 不断言具体字面量，断言**两端同源**：生产者必须 require 生产模块自己的
  // isToolGroupsEnabled / TOOL_GROUPS_ENV，并拿它判 process.env。
  // （曾经这里是 `src.includes("... !== '1' ...")`，于是生产者与 sink 各写一套判定：
  //   env 为 '1 ' 时桥不发射、sink 却认 —— 静默分叉。同源才是这条断言该守的东西。）
  assert.ok(
    /const \{ isToolGroupsEnabled, TOOL_GROUPS_ENV \} = require\('\.\.\/\.\.\/toolExecutionTimeline'\);/.test(src),
    'the producer must import the gate predicate + name from the S5 module'
  );
  assert.ok(
    /if \(!isToolGroupsEnabled\(process\.env\[TOOL_GROUPS_ENV\]\)\) return;/.test(src),
    'the producer must gate through isToolGroupsEnabled(process.env[TOOL_GROUPS_ENV])'
  );
  // host-registered sink, same pattern as onExitPlanMode
  assert.ok(src.includes('hostOnToolGroupsRef'), 'the sink arrives via hostHandlers');
  assert.ok(
    src.includes('hostHandlers && hostHandlers.onToolGroups'),
    'the sink is host-registered (absent host ⇒ no-op)'
  );
  // exactly one emitter, and it is called from the tool-event choke point
  const calls = src.match(/emitToolGroups\(\);/g) || [];
  assert.equal(calls.length, 1, 'one call site, inside flushCompletedStages');
  assert.ok(
    /emitToolGroups\(\);\s*\n\s*if \(!tl \|\| tl\.length === 0\)/.test(src),
    'the emit runs before the drain so no segment is double-counted'
  );
  // fail-soft: the whole emit body is wrapped (useCallback form, same as bcast)
  assert.ok(
    /const emitToolGroups = useCallback\(\(\) => \{[\s\S]*?try \{[\s\S]*?\} catch \{/.test(src),
    'the emitter body must be fail-soft'
  );
});
