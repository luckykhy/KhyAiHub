'use strict';

// test-key 的两个真可达 ✗ 分支（未知厂商 / 不可测厂商）printError 却 rc=0：
// manifest wrapper 恒 `return true`，router 不读 handler 返回值。
// 现经 _markFailure()（markProcessFailure）落 process.exitCode=1。
// 真实 CLI 已复现：`khy test-key zzznotavendor` 与 `khy test-key trae` 0→1；`khy test-key list` 仍 0。

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

const { handleTestKey } = require('../../src/cli/handlers/testKey.js');

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
    await handleTestKey(args, {});
    return { code: process.exitCode, out: w.join('') };
  } finally {
    process.stdout.write = orig;
    process.exitCode = prev;
  }
}

_describe('test-key exit-code propagation', () => {
  _test('unknown vendor sets exitCode 1 (was 0)', async () => {
    const { code, out } = await runWith(['zznotavendor']);
    _expect(out).toContain('未知厂商');
    _expect(code).toBe(1);
  });

  _test('non-testable vendor sets exitCode 1 (was 0)', async () => {
    const { code, out } = await runWith(['trae']);
    _expect(out).toContain('暂不支持自动连通测试');
    _expect(code).toBe(1);
  });

  _test('`list` succeeds WITHOUT a failure exitCode', async () => {
    const { code } = await runWith(['list']);
    _expect(code || 0).toBe(0);
  });
});
