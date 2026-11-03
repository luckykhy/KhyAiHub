'use strict';

/**
 * Colocated contract test for toolExecutionReport.js (three-zone structured output).
 *
 * The gates that live here:
 *   ① REPORT_ZONES ↔ emitted zones, both directions — the layout contract of the whole
 *      output (instruction on top, process in the middle, summary at the bottom).
 *   ② the order is *machine-checked*, not remembered: a permuted zones array must be
 *      caught by zoneOrderViolations, and renderReportText must put the instruction first
 *      and the summary last. Silent reordering is the failure mode this file exists for.
 *   ③ zone 1 is verbatim: no rewrite, no summary, no truncation — display caps do not apply.
 *   ④ zone 3 is stats, not prose: the opencode session-stats shape per mode, with
 *      `unfinished` as a first-class count (a tool that never finished must be visible).
 *
 * Verified by hand that gates ① and ② are real, not vacuous — see the negative-test note at
 * the bottom of this file.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const foundation = require('../services/domain/catalog/toolUseLoop/toolExecutionGroups');
const render = require('./toolExecutionRender');
const statsModule = require('./toolExecutionStats');
const report = require('./toolExecutionReport');

const { REPORT_ZONES } = report;
const { USAGE_FIELDS } = statsModule;

// ── fixture：一次真实的「先说话 → 读 → 改 → 再说 → 还在跑」 ─────────────────

const INSTRUCTION = '把 router.js 的头部注释改掉，\n然后跑一遍测试。  （尾部空格保留）';

function fixture() {
  return {
    instruction: INSTRUCTION,
    steps: [
      { id: 's1', name: 'Read', status: 'success', summary: 'src/cli/router.js · 340 lines', durationMs: 200 },
      { id: 's2', name: 'Edit', status: 'success', summary: '改写头部注释', durationMs: 300 },
      { id: 's3', name: 'Bash', status: 'success', summary: 'node --test', durationMs: 900 },
      { id: 's4', name: 'Bash', status: 'success', summary: 'node --test again', durationMs: 100 },
      { id: 's5', name: 'Grep', status: 'error', summary: 'no match', error: { code: 'E1', message: 'boom' } },
      { id: 's6', name: 'Bash', status: 'paused', summary: 'npm run build' },
    ],
    rows: [
      { kind: 'narration', phase: 'commentary', text: '先读一遍路由再改。' },
      { kind: 'step', stepId: 's1' },
      { kind: 'divider' },
      { kind: 'step', stepId: 's2' },
      { kind: 'narration', phase: 'final_answer', text: '改完了，构建还没跑完。' },
      { kind: 'step', stepId: 's5' },
      { kind: 'step', stepId: 's6' },
    ],
    groups: [{
      id: 'g1',
      kind: 'turn',
      title: '读取 + 编辑 src/cli/router.js',
      startedAt: Date.UTC(2026, 10, 2, 3, 4, 5),
      endedAt: Date.UTC(2026, 10, 2, 3, 4, 9),
      thoughtMs: 11000,
      copyText: 'g1 的复制载荷',
      nextAction: { kind: 'retry', text: '重跑构建', target: 'npm run build' },
      steps: [
        { id: 's1', name: 'Read', status: 'success', summary: 'src/cli/router.js · 340 lines', durationMs: 200 },
        { id: 's2', name: 'Edit', status: 'success', summary: '改写头部注释', durationMs: 300 },
        { id: 's3', name: 'Bash', status: 'success', summary: 'node --test', durationMs: 900 },
        { id: 's4', name: 'Bash', status: 'success', summary: 'node --test again', durationMs: 100 },
        { id: 's5', name: 'Grep', status: 'error', summary: 'no match', error: { code: 'E1', message: 'boom' } },
        { id: 's6', name: 'Bash', status: 'paused', summary: 'npm run build' },
      ],
    }],
  };
}

function buildReport(opts) {
  return report.buildToolExecutionReport(fixture(), opts);
}

// ── ① REPORT_ZONES ↔ 实际输出的区域（双向） ───────────────────────────────

test('report zones are exactly REPORT_ZONES, in that order', () => {
  const out = buildReport();
  assert.deepEqual(out.zones.map((z) => z.zone), [...REPORT_ZONES]);
  assert.equal(out.orderViolations.length, 0);
  assert.equal(out.layoutViolations.length, 0);
  assert.equal(report.reportOrderOk(out), true);
  for (let i = 0; i < out.zones.length; i += 1) {
    assert.equal(out.zones[i].position, i, `zone ${out.zones[i].zone} carries the wrong position`);
  }
});

test('REPORT_ZONES is frozen and its order is the documented layout', () => {
  assert.equal(Object.isFrozen(REPORT_ZONES), true);
  // 第一约束的字面断言：用户指令在最上，过程居中，结构化总结在最下。
  assert.deepEqual([...REPORT_ZONES], ['instruction', 'process', 'summary']);
  assert.ok(report.zoneIndex('instruction') < report.zoneIndex('process'));
  assert.ok(report.zoneIndex('process') < report.zoneIndex('summary'));
  assert.equal(report.zoneIndex('nope'), -1);
});

test('reportZone picks a zone by name instead of by index', () => {
  const out = buildReport();
  assert.equal(report.reportZone(out, 'summary').zone, 'summary');
  assert.equal(report.reportZone(out, 'nope'), null);
  assert.equal(report.reportZone(null, 'summary'), null);
});

// ── ② 次序本身有闸（用户明确要求的第一约束） ──────────────────────────────

test('a permuted zones array is caught, not silently accepted', () => {
  const out = buildReport();
  const swapped = [out.zones[2], out.zones[1], out.zones[0]];
  const violations = report.zoneOrderViolations(swapped);
  // 总结跑到最上、指令掉到最底：两处错位，中间那一区恰好还对。
  assert.equal(violations.length, 2, 'summary ahead of process must be reported');
  assert.deepEqual(violations[0], { index: 0, expected: 'instruction', actual: 'summary' });
  assert.deepEqual(violations[1], { index: 2, expected: 'summary', actual: 'instruction' });
  assert.equal(report.zoneSetViolations(swapped).length, 0, 'same members, wrong order');
  assert.equal(report.reportOrderOk({ zones: swapped }), false);
  // 真实产物恒零违规——两个断言合起来才证明闸不是恒绿的。
  assert.deepEqual(report.zoneOrderViolations(out.zones), []);
});

test('a dropped zone is a violation, not a shorter report', () => {
  const out = buildReport();
  // [instruction, process] 逐位都对——只有成员闸能抓到「总结整个不见了」。
  assert.deepEqual(report.zoneOrderViolations(out.zones.slice(0, 2)), []);
  assert.deepEqual(report.zoneSetViolations(out.zones.slice(0, 2)), [
    { kind: 'missing', zone: 'summary' },
  ]);
  assert.equal(report.zoneLayoutViolations(out.zones.slice(0, 2)).length, 1);
  assert.equal(report.reportOrderOk({ zones: out.zones.slice(0, 2) }), false);
  assert.deepEqual(report.zoneSetViolations([{ zone: 'instruction' }, { zone: 'postscript' }]), [
    { kind: 'missing', zone: 'process' },
    { kind: 'missing', zone: 'summary' },
    { kind: 'unknown', zone: 'postscript' },
  ]);
  assert.equal(report.zoneOrderViolations(null).length, 0);
});

test('renderReportText lays the zones out in order: instruction first, summary last', () => {
  const out = buildReport();
  const lines = report.renderReportText(out);
  const firstProcess = lines.findIndex((l) => l.includes('先读一遍路由再改。'));
  const summaryHead = lines.findIndex((l) => l.startsWith('执行工具 '));
  const instructionFirst = lines[0];
  assert.equal(instructionFirst, '把 router.js 的头部注释改掉，');
  assert.ok(firstProcess > 0, 'the process must sit below the instruction');
  assert.ok(summaryHead > firstProcess, 'the summary must sit below the whole process');
  assert.equal(lines[lines.length - 1].startsWith('  '), true, 'summary tool rows are indented');
});

test('renderReportText of a permuted report follows the array it was given', () => {
  // 纯文本面不自己纠序：它照 zones 的次序铺。纠序只发生在组装处（REPORT_ZONES）。
  const out = buildReport();
  const text = report.renderReportText({ zones: [out.zones[2], out.zones[1], out.zones[0]] });
  assert.ok(text[0].startsWith('执行工具 '), 'given a permuted report, the text is permuted too');
});

// ── ③ 第 1 区：用户指令原样呈现 ──────────────────────────────────────────

test('zone 1 is verbatim: no rewrite, no summary, no truncation', () => {
  const out = buildReport({ summaryCap: 8, narrationCap: 8 });
  const zone = report.reportZone(out, 'instruction');
  assert.equal(zone.text, INSTRUCTION);
  assert.equal(zone.full, INSTRUCTION);
  assert.equal(zone.truncated, false);
  assert.equal(zone.truncation, 'never');
  assert.deepEqual(zone.lines, INSTRUCTION.split('\n'));
});

test('zone 1 survives a 5000-character instruction untouched', () => {
  const long = 'x'.repeat(5000);
  const out = report.buildToolExecutionReport({ instruction: long, steps: [], rows: [] });
  const zone = report.reportZone(out, 'instruction');
  assert.equal(zone.text.length, 5000);
  assert.equal(zone.truncated, false);
  assert.equal(report.renderReportText(out).length, 2, 'one instruction line + one summary head');
});

test('an empty instruction yields an empty zone, not a fabricated one', () => {
  const out = report.buildToolExecutionReport({ steps: [], rows: [] });
  const zone = report.reportZone(out, 'instruction');
  assert.equal(zone.text, '');
  assert.deepEqual(zone.lines, []);
  assert.equal(report.renderReportText(out).some((l) => l === ''), false);
});

// ── ④ 第 2 区：七条显示契约都在这一区 ────────────────────────────────────

test('zone 2 carries the row-layer display model and nothing else', () => {
  const zone = report.reportZone(buildReport(), 'process');
  assert.ok(zone.lines.length > 0);
  for (const line of zone.lines) {
    assert.equal(typeof line.text, 'string');
    assert.equal(typeof line.renderer, 'string');
  }
  const anchored = new Set([...Object.values(foundation.RENDERERS), 'FallbackRow']);
  for (const line of zone.lines) {
    assert.ok(anchored.has(line.renderer), `${line.renderer} is not an anchored renderer id`);
  }
});

test('zone 2 keeps narration as first-class rows and nextAction under the header', () => {
  const zone = report.reportZone(buildReport(), 'process');
  const narrations = zone.lines.filter((l) => l.kind === 'narration');
  assert.equal(narrations.length, 2, 'two narration rows survive the assembly');
  assert.equal(narrations[0].bullet, '●');
  const headerAt = zone.lines.findIndex((l) => l.kind === 'group-header');
  assert.ok(headerAt >= 0);
  assert.equal(zone.lines[headerAt + 1].kind, 'next-action');
  assert.equal(zone.nextActions.length, 1);
});

// ── ⑤ 第 3 区：结构化总结（统计，不是散文） ──────────────────────────────

test('zone 3 stats shape matches the opencode session-stats shape per mode', () => {
  const none = statsModule.buildSessionStats(fixture().steps, { mode: 'none' });
  assert.deepEqual(Object.keys(none), ['mode']);
  assert.equal(none.mode, 'none');
  const summary = statsModule.buildSessionStats(fixture().steps, { mode: 'summary' });
  assert.deepEqual(Object.keys(summary), ['mode', 'totals']);
  const detail = statsModule.buildSessionStats(fixture().steps, { mode: 'detail' });
  assert.deepEqual(Object.keys(detail), ['mode', 'totals', 'usage']);
  assert.equal(detail.mode, 'detail');
});

test('every usage row carries the frozen ToolUsage fields, in order', () => {
  const detail = statsModule.buildSessionStats(fixture().steps, { mode: 'detail' });
  assert.equal(detail.usage.length, 4, 'Read / Edit / Bash / Grep');
  for (const row of detail.usage) assert.deepEqual(Object.keys(row), [...USAGE_FIELDS]);
  // 按调用次数降序：Bash 3 次在最上。
  assert.equal(detail.usage[0].name, 'Bash');
  assert.equal(detail.usage[0].calls, 3);
  assert.equal(detail.usage[0].succeeded, 2);
  assert.equal(detail.usage[0].unfinished, 1);
  assert.equal(detail.usage[0].durationP50, 500, 'median of [100, 900]: even count → mean of the two middles');
});

test('unfinished is a first-class count: a paused tool is visible, not frozen', () => {
  const detail = statsModule.buildSessionStats(fixture().steps, { mode: 'detail' });
  assert.equal(detail.totals.unfinished, 1);
  const bash = detail.usage.find((u) => u.name === 'Bash');
  assert.equal(bash.unfinished, 1);
  const text = statsModule.renderStatsText(detail);
  assert.ok(text[0].includes('未完成 1'), `summary head hides the unfinished run: ${text[0]}`);
  assert.equal(foundation.normalizeStatus('paused'), 'running');
});

test('totals come from the D2 leaf, not from a second counter here', () => {
  const input = fixture();
  const expected = foundation.projectToolExecution(input).totals;
  const detail = statsModule.buildSessionStats(input.steps, { mode: 'detail', totals: expected });
  assert.deepEqual(detail.totals, expected);
  // 不传 totals 时也经同一个函数现取，于是两条路给出同一个读数。
  const derived = statsModule.buildSessionStats(input.steps, { mode: 'summary' });
  assert.deepEqual(derived.totals, expected);
});

test('durationP50 is the median of the samples (odd and even counts)', () => {
  const odd = statsModule.buildToolUsage([{ id: 'a', name: 'Bash', status: 'success', durationMs: 100 }]);
  assert.equal(odd[0].durationP50, 100);
  const four = statsModule.buildToolUsage([
    { id: 'a', name: 'Bash', status: 'success', durationMs: 100 },
    { id: 'b', name: 'Bash', status: 'success', durationMs: 200 },
    { id: 'c', name: 'Bash', status: 'success', durationMs: 300 },
    { id: 'd', name: 'Bash', status: 'success', durationMs: 400 },
  ]);
  assert.equal(four[0].durationP50, 250);
});

test('renderStatsText emits count lines, not prose', () => {
  const text = statsModule.renderStatsText(buildReport().stats);
  assert.ok(/^执行工具 \d+ 次 · 完成 \d+ · 失败 \d+ · 未完成 \d+$/.test(text[0]), text[0]);
  assert.ok(text.some((l) => l.startsWith('按族：')));
  assert.ok(text.includes('按工具：'));
  assert.ok(text.every((l) => !l.includes('\n')));
});

test('a tool with no duration sample shows no duration cell', () => {
  const detail = statsModule.buildSessionStats(
    [{ id: 'a', name: 'Read', status: 'running' }],
    { mode: 'detail' }
  );
  assert.equal(detail.usage[0].durationP50, 0);
  const line = statsModule.renderStatsText(detail).find((l) => l.includes('Read'));
  assert.ok(line.includes('未完成 1'));
  assert.equal(line.includes('中位耗时'), false, '"no sample" must not read as "0 seconds"');
});

// ── ⑥ 层自身的不变量 ────────────────────────────────────────────────────

test('the report never throws on garbage input', () => {
  assert.doesNotThrow(() => report.buildToolExecutionReport(null));
  assert.doesNotThrow(() => report.buildToolExecutionReport({}));
  assert.doesNotThrow(() => report.buildToolExecutionReport({ steps: 'nope', rows: 7, instruction: 42 }));
  assert.doesNotThrow(() => report.buildToolExecutionReport({ steps: [null, 3, ''] , rows: [] }));
  const out = report.buildToolExecutionReport({ steps: 'nope', instruction: 42 });
  assert.equal(out.instruction, '42');
  assert.deepEqual(out.orderViolations, []);
  assert.deepEqual(out.layoutViolations, []);
  assert.deepEqual(report.renderReportText(null), []);
});

test('the same input renders the same report (determinism, no clock, no randomness)', () => {
  assert.deepEqual(buildReport(), buildReport());
  assert.deepEqual(report.renderReportText(buildReport()), report.renderReportText(buildReport()));
});

test('building a report never mutates the input projection or steps', () => {
  const input = fixture();
  const before = JSON.stringify(input);
  report.buildToolExecutionReport(input);
  report.renderReportText(report.buildToolExecutionReport(input));
  assert.equal(JSON.stringify(input), before);
});

test('the report emits zero ANSI bytes (no DECSTBM, no ED2, no colour)', () => {
  const text = report.renderReportText(buildReport());
  assert.ok(text.length > 0);
  assert.equal(text.join('\n').includes('\x1B'), false);
  const json = JSON.stringify(buildReport());
  assert.equal(json.includes('\\u001b'), false);
});

test('renderReportText covers every zone it was given', () => {
  const out = buildReport();
  const text = report.renderReportText(out);
  const zone2Texts = out.zones[1].lines.map((l) => l.text);
  for (const t of zone2Texts) assert.ok(text.includes(t), `missing a process line: ${t}`);
  for (const t of out.zones[2].text) assert.ok(text.includes(t), `missing a summary line: ${t}`);
});

// ── negative test note ──────────────────────────────────────────────────
//
// Verified by hand (2026-11-02) that the gates above are real, not vacuous. Every mutation was
// made on a cp backup and reverted from that backup — never `git checkout`.
//
//   1. Appended `'postscript'` to REPORT_ZONES → 5 red: "report zones are exactly REPORT_ZONES",
//      "REPORT_ZONES is frozen and its order is the documented layout", "a permuted zones array
//      is caught", "a dropped zone is a violation", "the report never throws on garbage input"
//      (the last one asserts layoutViolations is empty on a garbage-built report).
//   2. Made `_instructionZone` clip its text to 12 chars → 3 red: the two zone-1 tests plus
//      "renderReportText lays the zones out in order" (which pins the first on-screen line).
//      Every zone-2 / zone-3 test stayed green, so the gate is specific to zone 1.
//   3. Added `usage` to the `summary` branch of buildSessionStats → 2 red: the per-mode key-set
//      assertions here and in toolExecutionStats.test.js.
//   4. Assembled `zones` in reverse (summary on top, instruction at the bottom) → 8 red, including
//      both order gates. This is the "silently reorderable" failure mode the user called out as
//      the first constraint; it cannot happen quietly.
