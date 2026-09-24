'use strict';

// proactive 的未知子命令分支 printError(✗) 却 return true，router 不读返回值 → rc=0。
// 现经 markProcessFailure() 落 process.exitCode。
// 真实 CLI 已复现（khy proactive bogusverb 0→1；khy proactive status 仍 0）。

process.env.NO_COLOR = '1';
process.env.FORCE_COLOR = '0';
process.env.KHY_PROACTIVE_COMMAND = 'true';

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

const { handleProactive } = require('../../src/cli/handlers/proactive.js');

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
    await handleProactive(undefined, args, {});
    return { code: process.exitCode, out: w.join('') };
  } finally {
    process.stdout.write = orig;
    process.exitCode = prev;
  }
}

_describe('proactive exit-code propagation', () => {
  _test('unknown subcommand sets exitCode 1 (was 0)', async () => {
    const { code, out } = await runWith(['not-a-proactive-sub']);
    _expect(out).toContain('未知子命令');
    _expect(code).toBe(1);
  });

  _test('`status` succeeds WITHOUT a failure exitCode', async () => {
    const { code } = await runWith(['status']);
    _expect(code || 0).toBe(0);
  });
});
