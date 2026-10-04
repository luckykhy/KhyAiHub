'use strict';

// #80 Rule 2.2 noise: `khy rollback list` renders stored checkpoint timestamps.
// A legacy / half-written record can lack the `timestamp` field entirely, and
// `new Date(undefined).toLocaleString('zh-CN')` returns the literal English
// "Invalid Date" on a Chinese CLI (its try/catch never fires — the call does
// not throw). _fmtTime now maps missing → 未知时间, echoes unparseable raw
// values, and only then locale-formats. Reproduced end-to-end below by seeding
// rollbackService.list and driving the REAL handleRollback('list') render.

process.env.NO_COLOR = '1';
process.env.FORCE_COLOR = '0';

let _describe = global.describe;
let _test = global.test || global.it;
let _expect = global.expect;
if (typeof _describe !== 'function' || typeof _expect !== 'function') {
  const assert = require('assert');
  const nt = require('node:test');
  _describe = (n, fn) => nt.describe(n, fn);
  _test = (n, fn) => nt.test(n, fn);
  _expect = (actual) => ({
    toBe: (e) => assert.strictEqual(actual, e),
    toContain: (s) => assert.ok(String(actual).includes(s), `expected to contain: ${s}`),
    notContain: (s) => assert.ok(!String(actual).includes(s), `expected NOT to contain: ${s}`),
    toEqual: (e) => assert.deepStrictEqual(actual, e),
  });
}

const path = require('path');
const handlerPath = path.join(__dirname, '../../src/cli/handlers/rollback.js');
const { _fmtTime } = require(handlerPath);

_describe('rollback _fmtTime (Rule 2.2 no raw "Invalid Date")', () => {
  _test('missing timestamp → 未知时间, not English Invalid Date', () => {
    for (const v of [undefined, null, '']) {
      const out = _fmtTime(v);
      _expect(out).toBe('未知时间');
      _expect(out).notContain('Invalid Date');
    }
  });

  _test('unparseable string → echoed raw, not Invalid Date', () => {
    const out = _fmtTime('not-a-date');
    _expect(out).toBe('not-a-date');
    _expect(out).notContain('Invalid Date');
  });

  _test('valid epoch-ms still locale-formats', () => {
    const out = _fmtTime(1700000000000);
    _expect(out).notContain('Invalid Date');
    _expect(out).notContain('未知时间');
    _expect(out).toContain('2023');
  });
});

_describe('rollback list render (real handler path, fault-injected service)', () => {
  _test('a stored checkpoint lacking timestamp renders 未知时间, never Invalid Date', async () => {
    const svcPath = require.resolve('../../src/services/rollbackService.js');
    const saved = require.cache[svcPath];
    require.cache[svcPath] = {
      id: svcPath, filename: svcPath, loaded: true, children: [], paths: [],
      exports: {
        GRANULARITY: { PATCH: 'patch', TURN: 'turn', SESSION: 'session', VERSION: 'version' },
        list: () => ({
          success: true, granularity: 'session',
          items: [{ id: 'ckpt-1', mode: 'auto', message: 'goal' }], // no timestamp
        }),
      },
    };
    delete require.cache[handlerPath];
    const { handleRollback } = require(handlerPath);

    const written = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (c) => { written.push(String(c)); return true; };
    try {
      await handleRollback('rewind', 'list', [], { level: 'session', projectDir: process.cwd() });
    } finally {
      process.stdout.write = orig;
      if (saved) require.cache[svcPath] = saved; else delete require.cache[svcPath];
      delete require.cache[handlerPath];
    }
    const out = written.join('');
    _expect(out).toContain('ckpt-1');
    _expect(out).toContain('未知时间');
    _expect(out).notContain('Invalid Date');
  });
});
