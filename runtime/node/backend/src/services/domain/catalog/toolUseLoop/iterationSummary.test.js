'use strict';

/**
 * Colocated contract test for iterationSummary.js (pure builder).
 * Batch 38 (C-4 test-colocated). Source file untouched.
 */

const test = require('node:test');
const assert = require('node:test').strict || require('node:assert/strict');

const { buildIterationSummary } = require('./iterationSummary');

const BASE = {
  iteration: 3,
  succeeded: 2,
  failed: 1,
  denied: 0,
  deduped: 4,
  allReadOnly: true,
};

test('exports exactly one name', () => {
  assert.deepEqual(Object.keys(require('./iterationSummary')), ['buildIterationSummary']);
});

test('passes the flat counters straight through and reports total from toolResults', () => {
  const out = buildIterationSummary({
    ...BASE,
    toolResults: [{ tool: 'read' }, { tool: 'bash' }, { tool: 'write' }],
  });
  assert.equal(out.iteration, 3);
  assert.equal(out.total, 3);
  assert.equal(out.succeeded, 2);
  assert.equal(out.failed, 1);
  assert.equal(out.denied, 0);
  assert.equal(out.deduped, 4);
  assert.equal(out.readOnlyOnly, true, 'allReadOnly is renamed readOnlyOnly');
});

test('name matching is normalized: case, spaces, underscores and dashes all fold', () => {
  const out = buildIterationSummary({
    ...BASE,
    toolResults: [
      { tool: 'Read_File' },
      { tool: 'read file' },
      { tool: 'FILE-READ' },
      { tool: '  WebSearch  ' },
    ],
  });
  assert.equal(out.breakdown.reads, 3, 'read | readfile | fileread all count as reads');
  assert.equal(out.breakdown.searches, 1);
});

test('the five buckets are anchored regexes, so a lookalike name lands in no bucket', () => {
  const out = buildIterationSummary({
    ...BASE,
    toolResults: [
      { tool: 'readme' }, // starts with "read" but is not a read
      { tool: 'broadcast' }, // contains "cast", matches nothing
      { tool: 'overwrite' }, // ends with "write" but is not anchored at the start
      { tool: 'subagent_x' }, // anchored agent|subagent only exactly
    ],
  });
  const b = out.breakdown;
  assert.equal(b.reads + b.searches + b.writes + b.commands + b.agents, 0);
  assert.equal(out.total, 4, 'uncategorized calls still count in total');
});

test('every documented alias is claimed by exactly one bucket', () => {
  const names = [
    'read', 'readfile', 'fileread',
    'grep', 'glob', 'search', 'find', 'websearch', 'webfetch', 'web_search', 'explore',
    'write', 'writefile', 'edit', 'editfile', 'createfile',
    'bash', 'shell', 'shellcommand',
    'agent', 'spawnworker', 'subagent',
  ];
  const out = buildIterationSummary({ ...BASE, toolResults: names.map((tool) => ({ tool })) });
  const b = out.breakdown;
  assert.equal(b.reads, 3);
  // KNOWN-DEFECT-shaped observation (registered, not fixed): the `web_search`
  // alternative in the source regex can NEVER match, because `_norm` strips
  // underscores before the test runs — 'web_search' folds to 'websearch' and is
  // claimed by that branch instead. Harmless today, but the alternation is dead.
  assert.equal(b.searches, 8, 'web_search folds to websearch; the literal alternative is dead code');
  assert.equal(b.writes, 5);
  assert.equal(b.commands, 3);
  assert.equal(b.agents, 3);
  assert.equal(b.reads + b.searches + b.writes + b.commands + b.agents, names.length);
});

test('elapsedMs sums numbers and treats missing/garbage elapsed as 0', () => {
  const out = buildIterationSummary({
    ...BASE,
    toolResults: [{ tool: 'read', elapsed: 10 }, { tool: 'read', elapsed: '5' }, { tool: 'read' }, { tool: 'read', elapsed: 'abc' }],
  });
  assert.equal(out.elapsedMs, 15, 'numeric strings coerce, garbage contributes 0');
});

test('modifiedFiles keeps only write-ish tools, dedupes, and preserves first-seen order', () => {
  const out = buildIterationSummary({
    ...BASE,
    toolResults: [
      { tool: 'edit', params: { file_path: '/a/x.js' } },
      { tool: 'write', params: { file_path: '/a/x.js' } },
      { tool: 'createfile', params: { path: '/b/y.js' } },
      { tool: 'read', params: { file_path: '/c/z.js' } },
    ],
  });
  assert.deepEqual(out.modifiedFiles, ['/a/x.js', '/b/y.js']);
});

test('modifiedFiles accepts all three param spellings and drops blank paths', () => {
  const out = buildIterationSummary({
    ...BASE,
    toolResults: [
      { tool: 'write', params: { filePath: '/camel' } },
      { tool: 'edit', params: { path: '/snake' } },
      { tool: 'write', params: {} },
      { tool: 'write', params: { file_path: '' } },
    ],
  });
  assert.deepEqual(out.modifiedFiles, ['/camel', '/snake'], 'no empty-string placeholder leaks in');
});

test('file_path wins over filePath wins over path within one entry', () => {
  const out = buildIterationSummary({
    ...BASE,
    toolResults: [{ tool: 'write', params: { file_path: '/first', filePath: '/second', path: '/third' } }],
  });
  assert.deepEqual(out.modifiedFiles, ['/first']);
});

test('an entry with no params at all does not throw', () => {
  const out = buildIterationSummary({ ...BASE, toolResults: [{ tool: 'write' }, { tool: 'edit' }] });
  assert.deepEqual(out.modifiedFiles, []);
});

test('empty round yields the whole zero-shaped report, not an exception', () => {
  const out = buildIterationSummary({ ...BASE, toolResults: [] });
  assert.equal(out.total, 0);
  assert.equal(out.elapsedMs, 0);
  assert.deepEqual(out.modifiedFiles, []);
  assert.deepEqual(out.breakdown, { reads: 0, searches: 0, writes: 0, commands: 0, agents: 0 });
});

test('toolResults is the ONE mandatory dep: absent it throws rather than reporting zero', () => {
  // B38-S1 (registered, not fixed — no caller in this repo passes an absent
  // toolResults, so today it is unreachable; pinned so a future caller cannot
  // silently turn a crash into an empty summary).
  assert.throws(() => buildIterationSummary({ iteration: 1 }), TypeError);
  assert.throws(() => buildIterationSummary(), TypeError);
  assert.throws(() => buildIterationSummary({ toolResults: null }), TypeError);
  // An explicitly empty array IS the zero shape:
  const zero = buildIterationSummary({ ...BASE, toolResults: [] });
  assert.equal(zero.total, 0);
});

test('the caller may still attach .advance downstream — the result is a fresh mutable object', () => {
  const out = buildIterationSummary({ ...BASE, toolResults: [{ tool: 'read' }] });
  out.advance = 'continue';
  const again = buildIterationSummary({ ...BASE, toolResults: [{ tool: 'read' }] });
  assert.equal(again.advance, undefined, 'no state shared between calls');
});
