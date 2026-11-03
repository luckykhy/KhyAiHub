'use strict';

/**
 * Colocated test for toolExecutionRenderRows.js — the four row renderers.
 *
 * The facade test (toolExecutionRender.test.js) pins the display contract end to end; this one
 * pins the row-level units that are awkward to reach through the facade: the closed vocabularies,
 * the injected formatters, and the "degrade instead of throw" fallbacks for every field.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const foundation = require('../services/domain/catalog/toolUseLoop/toolExecutionGroups');
const rows = require('./toolExecutionRenderRows');

// ── 封闭表 ───────────────────────────────────────────────────────────────

test('family vocabulary covers exactly the closed ToolFamily set', () => {
  assert.deepEqual(Object.keys(rows.FAMILY_LABEL).sort(), [...foundation.TOOL_FAMILY].sort());
  assert.deepEqual(Object.keys(rows.FAMILY_UNIT).sort(), [...foundation.TOOL_FAMILY].sort());
  for (const family of foundation.TOOL_FAMILY) {
    assert.ok(rows.FAMILY_LABEL[family], `${family} has no label`);
    assert.ok(rows.FAMILY_UNIT[family], `${family} has no unit`);
  }
});

test('family unit carries a quantifier only (the noun is already in the label)', () => {
  // 「检索 1 次」, not 「检索 1 次检索」.
  assert.equal(rows.FAMILY_UNIT.search, '次');
  assert.equal(rows.FAMILY_UNIT.web, '次');
  assert.equal(rows.FAMILY_UNIT.agent, '个');
  assert.equal(rows.FAMILY_UNIT.shell, '条命令');
});

// ── 时间戳 ───────────────────────────────────────────────────────────────

test('formatClock is UTC and total (same input → same string on any machine)', () => {
  const at = Date.UTC(2026, 10, 2, 3, 4, 5);
  assert.equal(rows.formatClock(at), '03:04:05');
  assert.equal(rows.formatClock(at), rows.formatClock(at));
  assert.equal(rows.formatClock(Date.UTC(2026, 0, 1, 23, 59, 59)), '23:59:59');
});

test('formatClock degrades on junk instead of throwing', () => {
  assert.equal(rows.formatClock(null), '');
  assert.equal(rows.formatClock('nope'), '');
  assert.equal(rows.formatClock(NaN), '');
  assert.equal(rows.formatClock(new Date('bogus')), '');
});

test('formatStamp handles both ends, one end, and neither', () => {
  const a = Date.UTC(2026, 10, 2, 3, 4, 5);
  const b = Date.UTC(2026, 10, 2, 3, 4, 9);
  assert.equal(rows.formatStamp(a, b).text, '03:04:05 → 03:04:09');
  assert.equal(rows.formatStamp(a, null).text, '03:04:05');
  assert.equal(rows.formatStamp(null, b).text, '03:04:09');
  assert.equal(rows.formatStamp(null, null).text, '');
  const local = rows.formatStamp(a, b, (ms) => `T${ms}`);
  assert.equal(local.text, `T${a} → T${b}`);
});

// ── GroupHeader ──────────────────────────────────────────────────────────

test('group header falls back to the count sentence when no title was supplied', () => {
  const line = rows.renderGroupHeader({ id: 'g', count: 3 }, {});
  assert.equal(line.text, '◆ 执行工具 3 次');
  assert.equal(line.countText, '执行工具 3 次');
  assert.equal(line.count, 3);
  const titled = rows.renderGroupHeader({ id: 'g', title: '读取 + 编辑 a.js', count: 2 }, {});
  assert.equal(titled.text, '◆ 读取 + 编辑 a.js');
  assert.equal(titled.countText, '执行工具 2 次');
});

test('groupCountText is plural-free (Chinese has no inflection)', () => {
  assert.equal(rows.groupCountText(0), '执行工具 0 次');
  assert.equal(rows.groupCountText(1), '执行工具 1 次');
  assert.equal(rows.groupCountText(12), '执行工具 12 次');
  assert.equal(rows.groupCountText(-3), '执行工具 0 次');
});

test('group header degrades unknown status/family values to the closed sets', () => {
  const line = rows.renderGroupHeader({ id: 'g', status: 'teleported', count: 1 }, {});
  assert.equal(line.status, 'running');
  assert.equal(line.glyph, rows.STATUS_GLYPH.running);
  const step = rows.renderStepRow({ id: 's', name: 'X', status: 'weird', family: 'weird' }, {});
  assert.equal(step.status, 'running');
  assert.equal(step.family, 'other');
  assert.equal(step.label, '其它');
});

test('group header copy payload is data, not a clipboard call', () => {
  const line = rows.renderGroupHeader({ id: 'g', count: 1 }, {});
  assert.equal(line.copy.action, 'copy');
  assert.equal(line.copy.text, '');
  const withText = rows.renderGroupHeader({ id: 'g', copyText: 'payload' }, {});
  assert.equal(withText.copy.text, 'payload');
});

// ── StepRow ──────────────────────────────────────────────────────────────

test('step row references the data model instead of copying it', () => {
  const step = foundation.decodeToolStep({
    id: 's', name: 'Edit', status: 'success', summary: 'x',
    artifact: { kind: 'file-diff', filePath: 'a.js', beforeContent: 'a\n', afterContent: 'b\n' },
    error: { code: 'E', message: 'm' },
    progress: { bytes: 1, total: 2 },
    childStepIds: ['c1', 'c2'],
  });
  const line = rows.renderStepRow(step, {});
  assert.equal(line.artifact, step.artifact, 'artifact must be the same reference');
  assert.equal(line.error, step.error);
  assert.equal(line.progress, step.progress);
  assert.deepEqual(line.childStepIds, ['c1', 'c2']);
  assert.notEqual(line.childStepIds, step.childStepIds, 'ids array is copied so callers cannot corrupt the step');
});

test('step row omits optional channels entirely when the step has none', () => {
  const line = rows.renderStepRow({ id: 's', name: 'Read', status: 'success', summary: 'x' }, {});
  assert.equal('artifact' in line, false);
  assert.equal('error' in line, false);
  assert.equal('progress' in line, false);
  assert.equal('childStepIds' in line, false);
});

test('step row uses the injected family label when one is supplied', () => {
  const line = rows.renderStepRow({ id: 's', name: 'Bash', status: 'running', summary: 'ls' },
    { familyLabel: (f) => `[${f}]` });
  assert.equal(line.label, '[shell]');
  assert.equal(line.text, '◆ [shell] · ls');
});

test('step row text is empty-summary tolerant (a running step may have no summary yet)', () => {
  const line = rows.renderStepRow({ id: 's', name: 'Bash', status: 'inputStreaming', summary: '' }, {});
  assert.equal(line.text, '… 执行');
  assert.equal(line.summary, '');
  assert.equal(line.full, '');
});

// ── 子步骤聚合 ───────────────────────────────────────────────────────────

test('substep summary spells out the unfinished bucket too', () => {
  const line = rows.renderSubstepSummary({ id: 'p' }, [
    { id: 'c1', name: 'Bash', status: 'success' },
    { id: 'c2', name: 'Bash', status: 'running' },
    { id: 'c3', name: 'Bash', status: 'error' },
  ]);
  assert.equal(line.text, '└ 3 个子步骤 · 1 完成 · 1 失败 · 1 未完成');
  assert.equal(line.id, 'substeps:p');
});

test('substep summary of nothing is still a line saying zero', () => {
  const line = rows.renderSubstepSummary({ id: 'p' }, []);
  assert.equal(line.text, '└ 0 个子步骤');
  assert.equal(line.aggregate.count, 0);
});

// ── NarrationRow ─────────────────────────────────────────────────────────

test('narration row defaults an unknown phase to commentary', () => {
  const line = rows.renderNarrationRow({ id: 'n', text: 'hi', phase: 'aside' });
  assert.equal(line.phase, 'commentary');
  const kept = rows.renderNarrationRow({ id: 'n', text: 'hi', phase: 'final_answer' });
  assert.equal(kept.phase, 'final_answer');
});

test('narration row is not truncated unless a cap is given', () => {
  const long = 'z'.repeat(400);
  const uncapped = rows.renderNarrationRow({ id: 'n', text: long });
  assert.equal(uncapped.text, `● ${long}`);
  assert.equal(uncapped.truncated, false);
  assert.equal(uncapped.full, long);
});

// ── DividerRow ───────────────────────────────────────────────────────────

test('divider row falls back to summary, then to the empty string', () => {
  assert.equal(rows.renderDividerRow({ id: 'd', text: '── 回合 2 ──' }).text, '── 回合 2 ──');
  assert.equal(rows.renderDividerRow({ id: 'd', summary: 'sep' }).text, 'sep');
  assert.equal(rows.renderDividerRow({ id: 'd' }).text, '');
  assert.equal(rows.renderDividerRow({ id: 'd' }).renderer, 'DividerRow');
});

// ── nextAction ───────────────────────────────────────────────────────────

test('nextAction composes label, target and body, and carries the payload through', () => {
  const line = rows.renderNextAction(
    { kind: 'heal', target: 'build.gradle', text: '重跑同步', payload: { attempts: 2 } },
    { id: 'g1' }
  );
  assert.equal(line.text, '修复 build.gradle：重跑同步');
  assert.equal(line.actionKind, 'heal');
  assert.deepEqual(line.payload, { attempts: 2 });
  assert.equal(line.id, 'next-action:g1');
});

test('nextAction without target or body is still a line', () => {
  const bare = rows.renderNextAction({ kind: 'ask', text: '' }, { id: 'g' });
  assert.equal(bare.text, '需要确认');
  assert.equal(bare.body, '');
  const noText = rows.renderNextAction({ kind: 'continue' }, { id: 'g' });
  assert.equal(noText.text, '继续');
});

// ── 折叠元数据回填 ───────────────────────────────────────────────────────

test('withExpandedRows backfills the row count and recomputes the signature', () => {
  const line = rows.renderGroupHeader({ id: 'g', count: 4 }, { childCount: 4 });
  const before = line.fold.signature;
  assert.equal(line.fold.expandedRows, 4);
  rows.withExpandedRows(line, 9);
  assert.equal(line.fold.expandedRows, 9);
  assert.notEqual(line.fold.signature, before);
  assert.equal(line.fold.signature, 'group:9:0');
  rows.withExpandedRows(line, 9);
  assert.equal(line.fold.signature, 'group:9:0');
  assert.equal(rows.withExpandedRows(null, 3), null);
  assert.equal(rows.withExpandedRows({ fold: null }, 3).fold, null);
});

test('fold signature flips on expanded for every row kind', () => {
  const collapsed = rows.renderStepRow({ id: 's', name: 'Read', status: 'success' }, {});
  const expanded = rows.renderStepRow({ id: 's', name: 'Read', status: 'success' }, { expanded: true });
  assert.notEqual(collapsed.fold.signature, expanded.fold.signature);
  assert.equal(collapsed.fold.kind, 'step');
  assert.equal(collapsed.fold.collapsedRows, 1);
});
