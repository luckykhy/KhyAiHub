'use strict';

// advisor 的未知子命令分支 printError(✗) 却 return true，router 不读返回值 → rc=0。
// 现经 markProcessFailure() 落 process.exitCode。
// 真实 CLI 已复现（khy advisor zznotasub 0→1；khy advisor help 仍 0）。

process.env.NO_COLOR = '1';
process.env.FORCE_COLOR = '0';
process.env.KHY_ADVISOR_COMMAND = 'true';

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

const { handleAdvisor } = require('../../src/cli/handlers/advisor.js');

async function runWith(args) {
  const prev = process.exitCode;
  process.exitCode = undefined;
  const w = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => {
    w.push(String(c));
    return true;
  };
  try {
    await handleAdvisor(undefined, args, {});
    return { code: process.exitCode, out: w.join('') };
  } finally {
    process.stdout.write = orig;
    process.exitCode = prev;
  }
}

_describe('advisor exit-code propagation', () => {
  _test('unknown subcommand sets exitCode 1 (was 0)', async () => {
    const { code, out } = await runWith(['zznotasub']);
    _expect(out).toContain('未知子命令');
    _expect(code).toBe(1);
  });

  _test('`help` succeeds WITHOUT a failure exitCode', async () => {
    const { code } = await runWith(['help']);
    _expect(code || 0).toBe(0);
  });
});
