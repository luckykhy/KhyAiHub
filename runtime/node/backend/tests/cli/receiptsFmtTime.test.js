'use strict';

// #81 Rule 2.2 noise (same family as #80): `khy receipts list` renders each
// record's startedAt via _fmtTime = new Date(iso).toLocaleString('zh-CN'), whose
// try/catch is inert (the call returns the literal "Invalid Date" instead of
// throwing). receiptService.listReceipts copies stored `r.startedAt` RAW, so a
// legacy / half-written record lacking the field renders English "Invalid Date"
// on a Chinese CLI. Reproduced end-to-end by seeding receiptService and driving
// the REAL handleReceipts('list').

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
  });
}

const path = require('path');
const handlerPath = path.join(__dirname, '../../src/cli/handlers/receipts.js');
const { _fmtTime } = require(handlerPath);

_describe('receipts _fmtTime (Rule 2.2 no raw "Invalid Date")', () => {
  _test('missing startedAt → 未知时间', () => {
    for (const v of [undefined, null, '']) _expect(_fmtTime(v)).toBe('未知时间');
  });
  _test('valid ISO string still formats', () => {
    const out = _fmtTime('2023-11-14T22:13:20.000Z');
    _expect(out).notContain('Invalid Date');
    _expect(out).toContain('2023');
  });
  _test('unparseable → echoed raw', () => {
    _expect(_fmtTime('garbage-ts')).toBe('garbage-ts');
  });
});

_describe('receipts list render (real handler path, fault-injected service)', () => {
  _test('record lacking startedAt renders 未知时间, never Invalid Date', async () => {
    const svcPath = require.resolve('../../src/services/receiptService.js');
    const saved = require.cache[svcPath];
    require.cache[svcPath] = {
      id: svcPath, filename: svcPath, loaded: true, children: [], paths: [],
      exports: {
        listReceipts: () => ([{ id: 'RCPT-1', status: 'ok', maxRisk: 'low', tools: 2, goal: 'g' }]),
        listOrchestrationReceipts: () => ([]),
      },
    };
    delete require.cache[handlerPath];
    const { handleReceipts } = require(handlerPath);
    const w = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (c) => { w.push(String(c)); return true; };
    try {
      await handleReceipts('list', [], {});
    } finally {
      process.stdout.write = orig;
      if (saved) require.cache[svcPath] = saved; else delete require.cache[svcPath];
      delete require.cache[handlerPath];
    }
    const out = w.join('');
    _expect(out).toContain('RCPT-1');
    _expect(out).toContain('未知时间');
    _expect(out).notContain('Invalid Date');
  });
});
