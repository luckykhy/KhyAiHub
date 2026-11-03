'use strict';

/**
 * Colocated test for toolExecutionRenderDiff.js — the ±row channel.
 *
 * This is the only part of the render layer that talks to another module, so the tests here are
 * mostly about the seam: the injected builder receives exactly (artifact, expanded), a throwing
 * builder yields no rows rather than an exception, and every writeDiffRows row kind maps onto a
 * marker + line number + dim flag.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const diff = require('./toolExecutionRenderDiff');

const ARTIFACT = {
  kind: 'file-diff',
  filePath: 'src/cli/router.js',
  beforeContent: 'a\nb\nc\n',
  afterContent: 'a\nB\nc\n',
};

test('DIFF_MARKER covers every writeDiffRows row kind', () => {
  for (const kind of ['add', 'del', 'ctx', 'gap', 'meta', 'more', 'stat']) {
    assert.equal(typeof diff.DIFF_MARKER[kind], 'string', `${kind} has no marker`);
  }
  assert.equal(diff.DIFF_MARKER.add, '++');
  assert.equal(diff.DIFF_MARKER.del, '--');
});

test('content rows are bright, bookkeeping rows are dim', () => {
  assert.equal(diff.DIFF_DIM_KINDS.has('add'), false);
  assert.equal(diff.DIFF_DIM_KINDS.has('del'), false);
  for (const kind of ['ctx', 'gap', 'meta', 'more', 'stat']) {
    assert.equal(diff.DIFF_DIM_KINDS.has(kind), true, `${kind} should be dim`);
  }
});

test('the injected builder receives (artifact, expanded) and nothing else', () => {
  const seen = [];
  const build = (artifact, expanded) => {
    seen.push([artifact, expanded]);
    return [{ kind: 'add', num: 1, text: 'x' }];
  };
  const lines = diff.renderDiffLines(ARTIFACT, { expanded: true, buildDiffRows: build, groupId: 'g1' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], ARTIFACT);
  assert.equal(seen[0][1], true);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].groupId, 'g1');
  assert.equal(lines[0].marker, '++');
  assert.equal(lines[0].num, 1);
  assert.equal(lines[0].text, '++x');
  assert.equal(lines[0].full, 'x');
  assert.equal(lines[0].renderer, 'StepRow');
  assert.equal(lines[0].rowKind, 'step');
  assert.equal(lines[0].fold.collapsedRows, 1);
});

test('collapsed by default: expanded is false when the caller says nothing', () => {
  let flag = 'unset';
  diff.renderDiffLines(ARTIFACT, {
    buildDiffRows: (_a, expanded) => {
      flag = expanded;
      return [];
    },
  });
  assert.equal(flag, false);
});

test('an unknown row kind falls back to the blank marker and ctx', () => {
  const lines = diff.renderDiffLines(ARTIFACT, {
    buildDiffRows: () => [{ kind: 'wat', num: null, text: '?' }],
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].diffKind, 'wat');
  assert.equal(lines[0].marker, '  ');
  assert.equal(lines[0].dim, false);
  assert.equal(lines[0].num, null);
});

test('rows with no text or no file path still produce stable ids', () => {
  const lines = diff.renderDiffLines({}, {
    buildDiffRows: () => [{ kind: 'add', text: undefined }, { kind: 'del' }],
  });
  assert.deepEqual(lines.map((l) => l.id), ['diff:diff:0', 'diff:diff:1']);
  assert.deepEqual(lines.map((l) => l.text), ['++', '--']);
});

test('the real SSOT path returns numbered ++/-- rows for a file-diff artifact', () => {
  const lines = diff.renderDiffLines(ARTIFACT, {});
  assert.ok(lines.length > 0, 'no diff rows from the real writeDiffRows');
  const markers = new Set(lines.map((l) => l.marker));
  assert.ok(markers.has('--'), 'no del row');
  assert.ok(markers.has('++'), 'no add row');
  for (const line of lines) {
    if (line.diffKind === 'add' || line.diffKind === 'del') {
      assert.equal(typeof line.num, 'number', `${line.diffKind} row lost its line number`);
    }
  }
});

test('nothing renderable yields an empty array, never an exception', () => {
  assert.deepEqual(diff.renderDiffLines(ARTIFACT, { buildDiffRows: () => null }), []);
  assert.deepEqual(diff.renderDiffLines(ARTIFACT, { buildDiffRows: () => 'nope' }), []);
  assert.deepEqual(diff.renderDiffLines(ARTIFACT, { buildDiffRows: () => [] }), []);
  assert.deepEqual(diff.renderDiffLines(ARTIFACT, {
    buildDiffRows: () => {
      throw new Error('engine down');
    },
  }), []);
  assert.deepEqual(diff.renderDiffLines(undefined, {}), []);
  assert.deepEqual(diff.renderDiffLines('string', {}), []);
});
