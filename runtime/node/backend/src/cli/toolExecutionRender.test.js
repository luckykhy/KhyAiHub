'use strict';

/**
 * Colocated contract test for toolExecutionRender.js (S3 render layer facade).
 *
 * What is pinned here, and why each pin exists:
 *   ① RENDERERS anchor ↔ implementation, both directions. D2's own test only proves "every RowKind
 *      has a renderer id"; this one proves "every id has an implementation". Adding a member to
 *      ROW_KIND *and* RENDERERS together leaves D2 green and would silently ship an unimplemented
 *      renderer — verified by hand (see the negative test note at the bottom).
 *   ② the seven display-contract items (group header / step row / diff / substep aggregate /
 *      narration / hoisted nextAction / display-only truncation), one `test()` each.
 *   ③ the layer's own invariants: zero ANSI bytes, never throws, never mutates the projection,
 *      fold signature flips with `expanded`, glyph table matches toolDisplayLine byte for byte.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const foundation = require('../services/domain/catalog/toolUseLoop/toolExecutionGroups');
const {
  ROW_KIND,
  RENDERERS,
  TOOL_FAMILY,
  classifyToolFamily,
} = foundation;

const render = require('./toolExecutionRender');
const rowsModule = require('./toolExecutionRenderRows');
const diffModule = require('./toolExecutionRenderDiff');

// ── fixture：一次真实的「先说话 → 读 → 改（带 diff 与子步骤）→ 再说话 → 还在跑」 ──

function fixture() {
  // steps 提成共享 const：groups[0].steps 与顶层 steps 原本逐字重复两份，
  // 改一处漏一处是本文件最大的维护隐患（也让 fixture 从 54 行降到 40 行以内）。
  const steps = [
    { id: 's1', name: 'Read', status: 'success', summary: 'src/cli/router.js · 340 lines', durationMs: 200 },
    {
      id: 's2', name: 'Edit', status: 'success', summary: '改写头部注释', durationMs: 300,
      artifact: {
        kind: 'file-diff',
        filePath: 'src/cli/router.js',
        beforeContent: 'a\nb\nc\n',
        afterContent: 'a\nB\nc\n',
      },
      childStepIds: ['s3', 's4'],
    },
    { id: 's3', name: 'Bash', status: 'success', summary: 'node --test', durationMs: 500 },
    { id: 's4', name: 'Grep', status: 'error', summary: 'no match', error: { code: 'E1', message: 'boom' } },
    { id: 's5', name: 'Bash', status: 'running', summary: 'npm run build' },
  ];
  return {
    steps,
    rows: [
      { kind: 'narration', phase: 'commentary', text: '先读一遍路由再改。' },
      { kind: 'step', stepId: 's1' },
      { kind: 'divider' },
      { kind: 'step', stepId: 's2' },
      { kind: 'narration', phase: 'final_answer', text: '改完了，构建还在跑。' },
      { kind: 'step', stepId: 's5' },
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
      steps,
    }],
  };
}

function renderFixture(opts) {
  return render.renderToolExecution(fixture(), opts);
}

function findLine(out, predicate) {
  return out.lines.find(predicate) || null;
}

// ── ① RENDERERS 锚点表 ↔ 实现（双向） ─────────────────────────────────────

test('rendererCoverage is empty: every anchored renderer id has an implementation', () => {
  assert.deepEqual(render.rendererCoverage(), []);
});

test('RENDERER_IDS is derived from the D2 anchor table, not copied', () => {
  assert.deepEqual([...render.RENDERER_IDS].sort(), Object.values(RENDERERS).sort());
  assert.equal(render.RENDERER_IDS.length, ROW_KIND.length);
});

test('RENDERER_IMPL keys are exactly RENDERER_IDS (no orphans, no gaps)', () => {
  assert.deepEqual(Object.keys(render.RENDERER_IMPL).sort(), [...render.RENDERER_IDS].sort());
  for (const id of render.RENDERER_IDS) {
    assert.equal(typeof render.RENDERER_IMPL[id], 'function', `${id} is not a function`);
  }
});

test('findUnimplementedRenderers catches an id the anchor table adds but nobody implements', () => {
  // The permanent, self-checking half of the negative test: simulate the anchor table gaining a
  // member (which is exactly what adding a RowKind without a renderer looks like from here) and
  // require the gate to name it. Without this the gate could be vacuously green.
  const extended = { ...RENDERERS, metric: 'MetricRow' };
  assert.deepEqual(render.findUnimplementedRenderers(extended, render.RENDERER_IMPL), ['MetricRow']);
  assert.deepEqual(
    render.findUnimplementedRenderers(RENDERERS, {}).sort(),
    [...render.RENDERER_IDS].sort()
  );
  assert.deepEqual(render.findUnimplementedRenderers({}, {}), []);
});

test('every row kind dispatches to its anchored renderer id', () => {
  const ctx = render.buildRenderContext(fixture());
  const byKind = {
    group: { kind: 'group', id: 'r0', groupId: 'g1' },
    step: { kind: 'step', id: 'r1', stepId: 's1', groupId: 'g1' },
    narration: { kind: 'narration', id: 'r2', text: 'x' },
    divider: { kind: 'divider', id: 'r3' },
  };
  for (const kind of ROW_KIND) {
    const line = render.renderRow(byKind[kind], ctx);
    assert.equal(line.renderer, RENDERERS[kind], `${kind} dispatched to ${line.renderer}`);
    assert.equal(line.rowKind, kind);
  }
});

// ── ② 显示契约 ①：分组头 ─────────────────────────────────────────────────

test('contract 1: group header is collapsible, counted, timestamped and copyable', () => {
  const out = renderFixture();
  const header = findLine(out, (l) => l.kind === 'group-header');
  assert.ok(header, 'no group header rendered');
  assert.equal(header.countText, '执行工具 5 次');
  assert.equal(header.count, 5);
  assert.equal(header.fold.expanded, false, 'group starts collapsed');
  assert.equal(header.fold.collapsedRows, 1);
  assert.equal(header.fold.expandedRows, out.groups[0].lineIds.length);
  assert.equal(header.timestamps.text, '03:04:05 → 03:04:09');
  assert.equal(header.copy.action, 'copy');
  assert.equal(header.copy.text, 'g1 的复制载荷');
  assert.equal(header.status, 'running');
  assert.equal(header.glyph, render.STATUS_GLYPH.running);
});

test('contract 1: fold signature flips with expanded (foldModel H5)', () => {
  const collapsed = rowsModule.renderGroupHeader({ id: 'g', count: 3 }, { childCount: 7 });
  const expanded = rowsModule.renderGroupHeader({ id: 'g', count: 3 }, { childCount: 7, expanded: true });
  assert.notEqual(collapsed.fold.signature, expanded.fold.signature);
  assert.equal(collapsed.fold.expandedRows, 7);
  assert.equal(expanded.fold.expanded, true);
});

test('contract 1: a group with no rows still gets a header (a cancelled group is not invisible)', () => {
  const out = render.renderProjection(
    foundation.projectToolExecution({ steps: [], groups: [{ id: 'gz', kind: 'turn', steps: [] }], rows: [] }),
    []
  );
  assert.equal(out.lines.length, 1);
  assert.equal(out.lines[0].kind, 'group-header');
  assert.equal(out.lines[0].countText, '执行工具 0 次');
});

// ── ③ 显示契约 ②：每条 = 状态图标 + 类型标签 + 截断摘要 ──────────────────

test('contract 2: step row carries glyph + type label + summary', () => {
  const out = renderFixture();
  const step = findLine(out, (l) => l.id === 'step:s1');
  assert.equal(step.glyph, render.STATUS_GLYPH.success);
  assert.equal(step.statusLabel, '完成');
  assert.equal(step.family, 'read');
  assert.equal(step.label, '读取');
  assert.equal(step.summary, 'src/cli/router.js · 340 lines');
  assert.equal(step.text, '✓ 读取 · src/cli/router.js · 340 lines');
  assert.equal(step.truncated, false);
});

test('contract 2: every closed status has a glyph and a label', () => {
  for (const status of foundation.TOOL_RUN_STATUS) {
    assert.ok(render.STATUS_GLYPH[status], `${status} has no glyph`);
    assert.ok(render.STATUS_LABEL[status], `${status} has no label`);
  }
  assert.deepEqual(Object.keys(render.STATUS_GLYPH).sort(), [...foundation.TOOL_RUN_STATUS].sort());
});

test('contract 2: glyphs match toolDisplayLine byte for byte on the three shared states', () => {
  // The duplication is deliberate (static require would pull formatters/string-width into this
  // leaf's start-up chain); this test is what keeps it from drifting into a second source.
  const { GLYPHS } = require('./toolDisplayLine');
  assert.equal(render.STATUS_GLYPH.success, GLYPHS.ok);
  assert.equal(render.STATUS_GLYPH.running, GLYPHS.running);
  assert.equal(render.STATUS_GLYPH.error, GLYPHS.err);
});

test('contract 2: family labels cover exactly the closed ToolFamily set', () => {
  assert.deepEqual(Object.keys(render.FAMILY_LABEL).sort(), [...TOOL_FAMILY].sort());
  assert.deepEqual(Object.keys(render.FAMILY_UNIT).sort(), [...TOOL_FAMILY].sort());
  assert.equal(classifyToolFamily('Notebook_Edit'), 'edit');
  assert.equal(render.FAMILY_LABEL.edit, '编辑');
});

test('contract 2: a raw (undecoded) step still gets its family from the closed table', () => {
  const line = rowsModule.renderStepRow({ id: 's', name: 'Notebook_Edit', status: 'success', summary: 'x' }, {});
  assert.equal(line.family, 'edit');
  assert.equal(line.label, '编辑');
  const unknown = rowsModule.renderStepRow({ id: 's', name: 'mcp__x__y', status: 'success' }, {});
  assert.equal(unknown.family, 'other');
  assert.equal(unknown.label, '其它');
});

// ── ④ 显示契约 ③：展开态 diff ────────────────────────────────────────────

test('contract 3: expanded diff rows carry line numbers and ++/-- markers', () => {
  const out = renderFixture({ expandSubsteps: true });
  const step = findLine(out, (l) => l.id === 'step:s2');
  assert.ok(step.artifact, 'artifact reference is kept on the display line');
  const diffLines = diffModule.renderDiffLines(step.artifact, {
    expanded: false,
    groupId: 'g1',
    buildDiffRows: () => [
      { kind: 'ctx', num: 1, text: 'a' },
      { kind: 'del', num: 2, text: 'b' },
      { kind: 'add', num: 2, text: 'B' },
      { kind: 'ctx', num: 3, text: 'c' },
    ],
  });
  assert.equal(diffLines.length, 4);
  assert.deepEqual(diffLines.map((d) => d.marker), ['  ', '--', '++', '  ']);
  assert.deepEqual(diffLines.map((d) => d.num), [1, 2, 2, 3]);
  assert.deepEqual(diffLines.map((d) => d.text), ['  a', '--b', '++B', '  c']);
  assert.deepEqual(diffLines.map((d) => d.dim), [true, false, false, true]);
  assert.equal(diffLines[1].renderer, 'StepRow');
  assert.equal(diffLines[1].rowKind, 'step');
});

test('contract 3: the real ±row SSOT is reachable through the lazy require', () => {
  const step = foundation.decodeToolStep({
    id: 'x', name: 'Edit', status: 'success',
    artifact: {
      kind: 'file-diff', filePath: 'a.js', beforeContent: 'a\nb\n', afterContent: 'a\nB\n',
    },
  });
  const lines = diffModule.renderDiffLines(step.artifact, {});
  const markers = lines.map((l) => l.marker);
  assert.ok(markers.includes('--'), `no del row from the real SSOT: ${JSON.stringify(lines)}`);
  assert.ok(markers.includes('++'), `no add row from the real SSOT: ${JSON.stringify(lines)}`);
  const numbered = lines.filter((l) => l.num != null);
  assert.ok(numbered.length >= 3, 'the real SSOT numbers every diff row');
});

test('contract 3: a diff that cannot be computed yields no rows, never a throw', () => {
  const throwing = () => {
    throw new Error('diff engine exploded');
  };
  assert.deepEqual(diffModule.renderDiffLines({ filePath: 'a' }, { buildDiffRows: throwing }), []);
  assert.deepEqual(diffModule.renderDiffLines(null, {}), []);
  assert.deepEqual(diffModule.renderDiffLines({}, {}), []);
  assert.deepEqual(diffModule.renderDiffLines({ filePath: 'a' }, { buildDiffRows: () => null }), []);
});

// ── ⑤ 显示契约 ④：子步骤聚合 + 组级叙述 ─────────────────────────────────

test('contract 4: child steps collapse into one aggregate count line', () => {
  const out = renderFixture();
  const agg = findLine(out, (l) => l.kind === 'substep-summary');
  assert.ok(agg, 'no substep aggregate line');
  assert.equal(agg.text, '└ 2 个子步骤 · 1 完成 · 1 失败');
  assert.equal(agg.aggregate.count, 2);
  assert.equal(agg.aggregate.counts.succeeded, 1);
  assert.equal(agg.aggregate.counts.failed, 1);
});

test('contract 4: aggregate semantics come from the D2 leaf, not a second counter', () => {
  const children = [
    { id: 'c1', name: 'Bash', status: 'running' },
    { id: 'c2', name: 'Bash', status: 'paused' },
  ];
  const agg = rowsModule.aggregateChildSteps(children);
  const viaLeaf = foundation.buildToolGroup({ id: 't', steps: children });
  assert.deepEqual(agg.counts, viaLeaf.counts);
  assert.equal(agg.counts.unfinished, 2, 'paused folds into unfinished, exactly as the leaf says');
  assert.equal(agg.status, 'running');
});

test('contract 4: group narrative folds substeps into one sentence (figure 9 shape)', () => {
  const out = renderFixture();
  const header = findLine(out, (l) => l.kind === 'group-header');
  assert.equal(header.narrative, '思考 11 秒，读取 1 个文件，编辑 1 个文件，执行 2 条命令，检索 1 次');
});

test('contract 4: narrative duration wording is injected, not reimplemented', () => {
  const line = rowsModule.renderGroupHeader(
    { id: 'g', counts: { thoughtMs: 11000, byFamily: { shell: 1 } } },
    { formatDuration: (ms) => `${ms}ms` }
  );
  assert.equal(line.narrative, '思考 11000ms，执行 1 条命令');
  const bare = rowsModule.renderGroupHeader({ id: 'g', counts: { thoughtMs: 2000 } }, {});
  assert.equal(bare.narrative, '思考 2 秒');
});

// ── ⑥ 显示契约 ⑤：叙述是一等行 ──────────────────────────────────────────

test('contract 5: narration rows render as ● bullets, one line each, in order', () => {
  const out = renderFixture();
  const narrations = out.lines.filter((l) => l.kind === 'narration');
  assert.equal(narrations.length, 2);
  assert.equal(narrations[0].bullet, render.NARRATION_BULLET);
  assert.equal(narrations[0].text, '● 先读一遍路由再改。');
  assert.equal(narrations[0].phase, 'commentary');
  assert.equal(narrations[1].text, '● 改完了，构建还在跑。');
  assert.equal(narrations[1].phase, 'final_answer');
  const idxFirst = out.lines.findIndex((l) => l.kind === 'narration');
  const idxLast = out.lines.length - 1 - [...out.lines].reverse().findIndex((l) => l.kind === 'narration');
  assert.ok(idxFirst < idxLast, 'narration order is not preserved');
});

test('contract 5: the group summary never swallows narration text', () => {
  const out = renderFixture();
  const header = findLine(out, (l) => l.kind === 'group-header');
  assert.ok(!header.narrative.includes('先读一遍路由再改'), 'narration leaked into the group summary');
  assert.ok(!header.narrative.includes('改完了'), 'narration leaked into the group summary');
});

test('contract 5: an empty narration is still a line (absent vs empty are different facts)', () => {
  const out = render.renderToolExecution({
    steps: [{ id: 's1', name: 'Read', status: 'success' }],
    rows: [{ kind: 'narration', text: '' }, { kind: 'step', stepId: 's1' }],
  });
  const narrations = out.lines.filter((l) => l.kind === 'narration');
  assert.equal(narrations.length, 1);
  assert.equal(narrations[0].text, render.NARRATION_BULLET);
  assert.equal(narrations[0].full, '');
});

test('contract 5: an empty divider is still a line', () => {
  const out = render.renderToolExecution({
    steps: [{ id: 's1', name: 'Read', status: 'success' }],
    rows: [{ kind: 'divider' }, { kind: 'step', stepId: 's1' }],
  });
  const dividers = out.lines.filter((l) => l.kind === 'divider');
  assert.equal(dividers.length, 1);
  assert.equal(dividers[0].text, '');
});

// ── ⑦ 显示契约 ⑥：nextAction 上提 ───────────────────────────────────────

test('contract 6: nextAction sits right under the group header, and at the top level', () => {
  const out = renderFixture();
  const headerIdx = out.lines.findIndex((l) => l.kind === 'group-header');
  const na = out.lines[headerIdx + 1];
  assert.equal(na.kind, 'next-action');
  assert.equal(na.actionKind, 'retry');
  assert.equal(na.label, '重试');
  assert.equal(na.target, 'npm run build');
  assert.equal(na.body, '重跑构建');
  assert.equal(na.text, '重试 npm run build：重跑构建');
  assert.equal(out.nextActions.length, 1);
  assert.equal(out.nextActions[0].id, na.id);
  assert.equal(out.groups[0].nextAction.id, na.id);
  // 不埋在最后一段文字里：最后一行是还在跑的 shell，不是 nextAction。
  assert.notEqual(out.lines[out.lines.length - 1].kind, 'next-action');
});

test('contract 6: every closed nextActionKind has a label', () => {
  for (const kind of foundation.NEXT_ACTION_KIND) {
    assert.ok(render.NEXT_ACTION_LABEL[kind], `${kind} has no label`);
  }
  assert.deepEqual(Object.keys(render.NEXT_ACTION_LABEL).sort(), [...foundation.NEXT_ACTION_KIND].sort());
});

test('contract 6: an unknown nextAction kind degrades instead of disappearing', () => {
  const line = rowsModule.renderNextAction({ kind: 'teleport', text: 'x' }, { id: 'g' });
  assert.equal(line.actionKind, 'continue');
  assert.equal(line.label, '继续');
});

// ── ⑧ 显示契约 ⑦：截断只作用于显示 ──────────────────────────────────────

test('contract 7: display-only truncation keeps the full text available', () => {
  const long = 'x'.repeat(500);
  const step = foundation.decodeToolStep({ id: 's', name: 'Read', status: 'success', summary: long });
  const full = rowsModule.renderStepRow(step, {});
  assert.equal(full.truncated, true, 'the D2 leaf already truncated this summary');
  assert.equal(full.summary.length, foundation.SUMMARY_CAP);
  assert.equal(full.full, long, 'full text survives in the display model');
  const capped = rowsModule.renderStepRow(step, { summaryCap: 10 });
  assert.equal(capped.summary.length, 10);
  assert.equal(capped.truncated, true);
  assert.equal(capped.full, long, 'a second display-side clip still keeps the full text');
});

test('contract 7: narration cap clips the display string only', () => {
  const line = rowsModule.renderNarrationRow({ id: 'n', text: '一二三四五六' }, { narrationCap: 3 });
  assert.equal(line.text, '● 一二三');
  assert.equal(line.truncated, true);
  assert.equal(line.full, '一二三四五六');
});

test('contract 7: rendering never mutates the input projection', () => {
  const input = fixture();
  const before = JSON.stringify(input);
  render.renderToolExecution(input);
  render.renderToolExecution(input, { expandSubsteps: true, summaryCap: 5, narrationCap: 5 });
  assert.equal(JSON.stringify(input), before);
});

// ── ⑨ 层自身的不变量 ────────────────────────────────────────────────────

test('the layer emits zero ANSI bytes (no DECSTBM, no ED2, no colour)', () => {
  const out = renderFixture({ expandSubsteps: true });
  const stack = [out];
  const seen = new Set();
  while (stack.length) {
    const node = stack.pop();
    if (node && typeof node === 'object') {
      if (seen.has(node)) continue;
      seen.add(node);
      for (const v of Object.values(node)) stack.push(v);
    } else if (typeof node === 'string') {
      assert.ok(!node.includes('\x1B'), `ANSI byte leaked: ${JSON.stringify(node)}`);
      assert.ok(!/\x1B\[[0-9;]*[A-Za-z]/.test(node), `escape sequence leaked: ${JSON.stringify(node)}`);
    }
  }
});

test('the layer never throws on garbage input', () => {
  const junk = [null, undefined, 42, 'str', [], {}, { steps: 'nope' }, { rows: [null, 1, {}] },
    { groups: [null, {}, { steps: [null, 7] }] }, { steps: [{}, { id: 'x' }] }];
  for (const j of junk) {
    assert.doesNotThrow(() => render.renderToolExecution(j));
    assert.doesNotThrow(() => render.buildRenderContext(j));
    assert.doesNotThrow(() => render.renderRow(j, {}));
  }
});

test('a step row whose stepId resolves to nothing is a visible bad row, not a silent gap', () => {
  const out = render.renderToolExecution({
    steps: [{ id: 's1', name: 'Read', status: 'success' }],
    rows: [{ kind: 'step', stepId: 'ghost', groupId: 'g' }, { kind: 'step', stepId: 's1' }],
  });
  const bad = out.lines[0];
  assert.equal(bad.stepId, 'ghost');
  assert.equal(bad.missing, true);
  assert.equal(bad.text, '✗ 其它 · 步骤数据缺失');
  assert.equal(bad.fold.kind, 'step');
  // 坏行 + 自动分组的头 + 真步骤：一行都没被优化掉。
  assert.equal(out.lines.length, 3);
  assert.equal(out.lines[1].kind, 'group-header');
  assert.equal(out.lines[2].id, 'step:s1');
});

test('a row kind outside the closed set renders through the fallback, not a crash', () => {
  const line = render.renderRow({ kind: 'metric', id: 'm1', text: 'CPU 12%' }, {});
  assert.equal(line.renderer, 'FallbackRow');
  assert.equal(line.unknownRenderer, true);
  assert.equal(line.text, 'CPU 12%');
  assert.equal(line.fold.kind, 'unknown');
});

test('row order is preserved: the projection is never re-sorted for display', () => {
  const out = renderFixture();
  const kinds = out.lines.map((l) => l.kind);
  assert.deepEqual(kinds, [
    'narration', 'group-header', 'next-action', 'step', 'divider', 'step',
    'substep-summary', 'narration', 'step',
  ]);
});

test('facade re-exports both split halves so callers need one entry point', () => {
  for (const name of Object.keys(rowsModule)) {
    assert.equal(render[name], rowsModule[name], `${name} is not re-exported`);
  }
  for (const name of Object.keys(diffModule)) {
    assert.equal(render[name], diffModule[name], `${name} is not re-exported`);
  }
  assert.equal(typeof render.renderToolExecution, 'function');
  assert.equal(typeof render.renderProjection, 'function');
  assert.equal(typeof render.renderRow, 'function');
});

// ── negative test note ──────────────────────────────────────────────────
//
// Verified by hand (2026-11-02) that gate ① is real, not vacuous:
//   1. cp toolExecutionGroups.js → .bak, then add `metric: 'MetricRow'` to BOTH ROW_KIND and
//      RENDERERS in the D2 leaf. D2's own exhaustiveness test stays green (36/36); this file goes
//      RED on 4 tests (rendererCoverage / RENDERER_IMPL keys / dispatch / fallback).
//   2. Same setup, then drop the `narration` entry from RENDERER_IMPL here → same red.
//   Both edits were reverted from the .bak with cp (never git checkout).
