'use strict';

/**
 * Colocated contract test for iterationJournal.js (per-round journal recorder).
 * Batch 38 (C-4 test-colocated). Source file untouched.
 *
 * The leaf lazily requires ../services/tool/toolLoopJournal inside recordIteration,
 * so this test installs a recorder stub under that exact resolved path and always
 * restores the cache slot in a finally — nothing here writes to the real journal dir.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const JOURNAL_ID = require.resolve(path.join(__dirname, '../../../tool/toolLoopJournal'));

function withStubJournal(handler, body) {
  const saved = require.cache[JOURNAL_ID];
  const records = [];
  require.cache[JOURNAL_ID] = {
    id: JOURNAL_ID,
    filename: JOURNAL_ID,
    loaded: true,
    exports: {
      appendJournal: (runId, rec) => {
        if (handler) return handler(runId, rec, records);
        records.push({ runId, rec });
        return undefined;
      },
      // Pass the input through under a key so the test can see exactly what
      // the leaf handed the journal module.
      buildIterationRecord: (input) => ({ BUILT: input }),
    },
  };
  try {
    return body(records);
  } finally {
    if (saved) require.cache[JOURNAL_ID] = saved;
    else delete require.cache[JOURNAL_ID];
  }
}

const { createIterationJournal } = require('./iterationJournal');

test('the factory exposes only recordIteration', () => {
  assert.deepEqual(Object.keys(createIterationJournal()), ['recordIteration']);
});

test('round 1 maps a successful call into { name, ok, durationMs, error }', () => {
  withStubJournal(null, (records) => {
    const j = createIterationJournal();
    j.recordIteration('run-A', 1, [{ iteration: 1, tool: 'read', result: { success: true }, elapsed: 12 }]);
    assert.equal(records.length, 1);
    assert.equal(records[0].runId, 'run-A');
    assert.deepEqual(records[0].rec.BUILT, {
      seq: 1,
      iteration: 1,
      tools: [{ name: 'read', ok: true, durationMs: 12, error: null }],
    });
  });
});

test('a failed call carries its error; an absent success is null (unknown), not false', () => {
  withStubJournal(null, (records) => {
    const j = createIterationJournal();
    j.recordIteration('run-A', 2, [
      { tool: 'bash', result: { success: false, error: 'bad' }, elapsed: '30' },
      { tool: 'edit', result: {}, elapsed: null },
      { tool: 'grep', elapsed: 5 },
    ]);
    const tools = records[0].rec.BUILT.tools;
    assert.deepEqual(tools[0], { name: 'bash', ok: false, durationMs: 30, error: 'bad' });
    assert.deepEqual(tools[1], { name: 'edit', ok: null, durationMs: null, error: null });
    assert.deepEqual(tools[2], { name: 'grep', ok: null, durationMs: 5, error: null }, 'no result object at all');
  });
});

test('the cursor advances by ARRAY LENGTH, so the next round sees only new entries', () => {
  withStubJournal(null, (records) => {
    const j = createIterationJournal();
    const log = [{ tool: 'read', result: { success: true } }];
    j.recordIteration('run-A', 1, log);
    log.push({ tool: 'bash', result: { success: true } });
    j.recordIteration('run-A', 2, log);
    assert.deepEqual(records.map((r) => r.rec.BUILT.tools.map((t) => t.name)), [['read'], ['bash']]);
    assert.deepEqual([records[0].rec.BUILT.seq, records[1].rec.BUILT.seq], [1, 2]);
  });
});

test('a round with no new calls still writes an EMPTY record (the journal is per round, not per call)', () => {
  withStubJournal(null, (records) => {
    const j = createIterationJournal();
    const log = [{ tool: 'read', result: { success: true } }];
    j.recordIteration('run-A', 1, log);
    j.recordIteration('run-A', 2, log);
    assert.equal(records.length, 2);
    assert.deepEqual(records[1].rec.BUILT.tools, []);
    assert.equal(records[1].rec.BUILT.seq, 2, 'seq keeps counting even for empty rounds');
    assert.equal(records[1].rec.BUILT.iteration, 2);
  });
});

test('_loopSeq is independent of iteration: repeated iteration numbers still get unique seqs', () => {
  withStubJournal(null, (records) => {
    const j = createIterationJournal();
    for (let i = 0; i < 3; i += 1) j.recordIteration('run-A', 1, []);
    assert.deepEqual(records.map((r) => r.rec.BUILT.seq), [1, 2, 3]);
    assert.deepEqual(records.map((r) => r.rec.BUILT.iteration), [1, 1, 1], 'grace re-numbering preserved');
  });
});

test('FAIL-SOFT: a malformed toolCallLog never escapes to the main loop', () => {
  for (const bad of [undefined, null, 'str', 42, {}]) {
    withStubJournal(null, (records) => {
      const j = createIterationJournal();
      assert.doesNotThrow(() => j.recordIteration('r', 1, bad), `log=${JSON.stringify(bad)}`);
      assert.equal(records.length, 0);
    });
  }
});

test('FAIL-SOFT: the journal module itself throwing is swallowed too', () => {
  withStubJournal(() => {
    throw new Error('disk full');
  }, (records) => {
    const j = createIterationJournal();
    assert.doesNotThrow(() => j.recordIteration('r', 1, [{ tool: 'x', result: { success: true } }]));
    assert.equal(records.length, 0);
  });
});

test('two journal instances never share a cursor or a seq', () => {
  withStubJournal(null, (records) => {
    const a = createIterationJournal();
    const b = createIterationJournal();
    a.recordIteration('run-A', 1, [{ tool: 'read', result: { success: true } }]);
    b.recordIteration('run-B', 1, [{ tool: 'read', result: { success: true } }]);
    assert.deepEqual(records.map((r) => r.rec.BUILT.seq), [1, 1]);
    assert.deepEqual(records.map((r) => r.runId), ['run-A', 'run-B']);
  });
});
