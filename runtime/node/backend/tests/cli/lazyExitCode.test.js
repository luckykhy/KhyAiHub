'use strict';

// lazy 子处理器 return 1（如 `khy lazy level` 缺强度），但 router 不读子命令返回值 →
// 打印 ✗ 却 rc=0。handleLazy 现经 _rc() 在唯一出口落 process.exitCode。真实 CLI 已复现
// （level 0→1，ladder 仍 0）。

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

const { handleLazy } = require('../../src/cli/handlers/lazy.js');

function runWith(subCommand, args, options) {
  const prev = process.exitCode;
  process.exitCode = undefined;
  const w = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { w.push(String(c)); return true; };
  try {
    const ret = handleLazy(subCommand, args || [], options || {});
    return { code: process.exitCode, ret, out: w.join('') };
  } finally {
    process.stdout.write = orig;
    process.exitCode = prev;
  }
}

_describe('lazy exit-code propagation', () => {
  _test('lazy level <缺强度> sets exitCode 1 (was 0)', () => {
    const { code, out } = runWith('level', [], {});
    _expect(out).toContain('未知强度');
    _expect(code).toBe(1);
  });

  _test('lazy <未知子命令> sets exitCode 1', () => {
    const { code, out } = runWith('not-a-lazy-sub', [], {});
    _expect(out).toContain('未知子命令');
    _expect(code).toBe(1);
  });

  _test('lazy ladder succeeds WITHOUT a failure exitCode', () => {
    const { code, ret } = runWith('ladder', [], {});
    _expect(ret).toBe(0);
    _expect(code || 0).toBe(0);
  });
});
