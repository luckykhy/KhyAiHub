'use strict';

// #82: entrypoints handler returns a 0/1 exit code from its renderers, but the
// router never reads a sub-command's return value (success even returns falsy
// 0), so `khy entry info <bad-id>` / `khy entry <unknown-verb>` printed a ✗ and
// STILL exited rc=0 — scripts couldn't detect failure. handleEntrypoints now funnels
// the code through _rc() which sets process.exitCode. Reproduced via the real CLI
// (failure rc flipped 0→1) and pinned below by driving handleEntrypoints directly.

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
  });
}

const { handleEntrypoints } = require('../../src/cli/handlers/entrypoints.js');

async function runWith(args) {
  const prev = process.exitCode;
  process.exitCode = undefined;
  const w = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { w.push(String(c)); return true; };
  try {
    await handleEntrypoints({ args });
  } finally {
    process.stdout.write = orig;
    const code = process.exitCode;
    process.exitCode = prev;
    return { code, out: w.join('') };
  }
}

_describe('entry exit-code propagation (#82)', () => {
  _test('entry info <bogus-id> sets exitCode 1 (was 0)', async () => {
    const { code, out } = await runWith(['info', 'no-such-entry-id-xyz']);
    _expect(out).toContain('未知的端');
    _expect(code).toBe(1);
  });

  _test('entry <unknown-verb> sets exitCode 1', async () => {
    const { code, out } = await runWith(['totally-not-a-verb']);
    _expect(out).toContain('未知子命令');
    _expect(code).toBe(1);
  });

  _test('entry list succeeds WITHOUT setting a failure exitCode', async () => {
    const { code } = await runWith(['list']);
    _expect(code || 0).toBe(0); // undefined or 0, never 1
  });
});
