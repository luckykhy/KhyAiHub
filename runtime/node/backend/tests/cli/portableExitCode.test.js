'use strict';

// my-r84: `khy portable` 的 ✗ 分支全部 printError 后 return true，router 不读
// 返回值 → rc=0；且 manifest wrapper 把未知子命令丢进 args，handler 根本收不到
// (未知形态连 ✗ 都不打)。现经 markProcessFailure() 落 process.exitCode，wrapper
// 恢复未匹配 token。真实 CLI 已复现:status 0→1、zzbogus 0→1;help/bare 仍 0。

const { MANIFEST_EXPORT_KEY } = require('../../src/cli/commandManifest');

// PORTABLE_ROOT_DEFAULT 在 require 期从 env 解析——先清掉才能测「未指定目标」分支。
delete process.env.KHY_PORTABLE_ROOT;
delete process.env.KHYQUANT_PORTABLE_ROOT;
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

const mod = require('../../src/cli/handlers/portable.js');
const manifestHandler = mod[MANIFEST_EXPORT_KEY].handler;

async function runWith(parsed) {
  const prev = process.exitCode;
  process.exitCode = undefined;
  const w = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => {
    w.push(String(c));
    return true;
  };
  try {
    await manifestHandler(parsed);
    return { code: process.exitCode, out: w.join('') };
  } finally {
    process.stdout.write = orig;
    process.exitCode = prev;
  }
}

_describe('portable exit-code propagation (my-r84)', () => {
  _test('status without target: ✗ 且 exitCode 1 (was 0)', async () => {
    const { code, out } = await runWith({ subCommand: 'status', args: [], options: {} });
    _expect(out).toContain('未指定目标目录');
    _expect(code).toBe(1);
  });

  _test('unknown sub recovered from args: ✗ 且 exitCode 1 (was silent 0)', async () => {
    const { code, out } = await runWith({ subCommand: undefined, args: ['zzbogus'], options: {} });
    _expect(out).toContain('未知子命令: zzbogus');
    _expect(code).toBe(1);
  });

  _test('help succeeds WITHOUT a failure exitCode', async () => {
    const { code } = await runWith({ subCommand: 'help', args: [], options: {} });
    _expect(code || 0).toBe(0);
  });

  _test('bare (no sub, only options) → usage wall, rc 0', async () => {
    const { code, out } = await runWith({ subCommand: undefined, args: [], options: {} });
    _expect(out).toContain('用法');
    _expect(code || 0).toBe(0);
  });
});
