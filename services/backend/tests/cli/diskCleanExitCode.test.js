'use strict';

// handleDiskClean 三条「用法错误」分支（--min-mb 非法 / --group 非法 / 无法识别的盘符或路径）
// 都 printError ✗ 后裸 `return`；router 不读返回值 → rc=0，脚本据退出码判失败被欺骗。
// 三处均在任何扫描/删除动作之前 return，置码副作用为零。现补 _markFailure()。
// 非空断言：help 子命令必须保持 rc=0。真实 CLI 已复现（0→1）。

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

const { handleDiskClean } = require('../../src/cli/handlers/diskClean.js');

async function runWith(subCommand, args, options) {
  const prev = process.exitCode;
  process.exitCode = undefined;
  const w = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { w.push(String(c)); return true; };
  try {
    await handleDiskClean(subCommand, args || [], options || {});
    return { code: process.exitCode, out: w.join('') };
  } finally {
    process.stdout.write = orig;
    process.exitCode = prev;
  }
}

_describe('diskClean exit-code propagation', () => {
  _test('cleandisk <无法识别路径> sets exitCode 1 (was 0)', async () => {
    const { code, out } = await runWith('bogusverb', ['bogusverb'], {});
    _expect(out).toContain('无法识别的盘符或路径');
    _expect(code).toBe(1);
  });

  _test('cleandisk --min-mb 非法 sets exitCode 1 (was 0)', async () => {
    const { code } = await runWith(null, [], { 'min-mb': 'abc' });
    _expect(code).toBe(1);
  });

  _test('cleandisk --group 越界 sets exitCode 1 (was 0)', async () => {
    const { code } = await runWith(null, [], { group: 99999 });
    _expect(code).toBe(1);
  });

  _test('cleandisk help keeps exitCode 0 (非空: 未过度触发)', async () => {
    const { code } = await runWith('help', [], {});
    _expect(code || 0).toBe(0);
  });
});
