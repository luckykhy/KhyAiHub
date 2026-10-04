'use strict';

// handleRtk 的 default 分支（未知子命令）printError ✗ 却 `return true`；router 不读返回值
// → `khy rtk bogusverb` 明明 ✗ 却 rc=0。现补 _markFailure()，与 notify.js default 分支的
// 既有约定一致。非空断言：status 子命令（成功）必须保持 rc=0。真实 CLI 已复现（0→1）。

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

const { handleRtk } = require('../../src/cli/handlers/rtk.js');

async function runWith(parsed) {
  const prev = process.exitCode;
  process.exitCode = undefined;
  const w = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { w.push(String(c)); return true; };
  try {
    await handleRtk(parsed);
    return { code: process.exitCode, out: w.join('') };
  } finally {
    process.stdout.write = orig;
    process.exitCode = prev;
  }
}

_describe('rtk exit-code propagation', () => {
  _test('rtk <未知子命令> sets exitCode 1 (was 0)', async () => {
    const { code, out } = await runWith({ args: ['not-a-real-rtk-sub'], options: {} });
    _expect(out).toContain('未知子命令');
    _expect(code).toBe(1);
  });

  _test('rtk status keeps exitCode 0 (非空: 未过度触发)', async () => {
    const { code } = await runWith({ subCommand: 'status', args: [], options: {} });
    _expect(code || 0).toBe(0);
  });
});
