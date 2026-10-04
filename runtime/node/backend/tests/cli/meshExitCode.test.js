'use strict';

// mesh 子处理器 return 1（如 `khy mesh send` 缺对端/消息），但 router 不读子命令返回值 →
// 打印 ✗ 却 rc=0。handleMesh 现经 _rc() 在唯一出口落 process.exitCode。真实 CLI 已复现
// （send 0→1，peers 仍 0）。

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

const { handleMesh } = require('../../src/cli/handlers/mesh.js');

function runWith(subCommand, args, options) {
  const prev = process.exitCode;
  process.exitCode = undefined;
  const w = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { w.push(String(c)); return true; };
  try {
    const ret = handleMesh(subCommand, args || [], options || {});
    return { code: process.exitCode, ret, out: w.join('') };
  } finally {
    process.stdout.write = orig;
    process.exitCode = prev;
  }
}

_describe('mesh exit-code propagation', () => {
  _test('mesh send <缺参> sets exitCode 1 (was 0)', () => {
    const { code, out } = runWith('send', [], {});
    _expect(out).toContain('用法');
    _expect(code).toBe(1);
  });

  _test('mesh <未知子命令> sets exitCode 1', () => {
    const { code, out } = runWith('not-a-mesh-sub', [], {});
    _expect(out).toContain('未知子命令');
    _expect(code).toBe(1);
  });

  _test('mesh peers succeeds WITHOUT a failure exitCode', () => {
    const { code, ret } = runWith('peers', [], {});
    _expect(ret).toBe(0);
    _expect(code || 0).toBe(0);
  });
});
