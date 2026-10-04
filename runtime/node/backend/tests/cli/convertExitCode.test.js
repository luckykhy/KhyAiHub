'use strict';

// handleConvert 在「缺 input 的用法分支」和「runConvert 返回 success:false 的错误分支」
// 都用 printError 打印 ✗，却 `return true`。router 不读子命令返回值 → 真实 CLI 里
// `khy convert` / `khy convert <不存在文件>` 明明 ✗ 却 rc=0，脚本无法据退出码判定失败。
// 现经 utils/markProcessFailure 在两处 ✗ 分支落 process.exitCode；needsDep(printWarn)
// 分支刻意保持 rc=0（警告非错误）。真实 CLI 已复现（失败 0→1）。

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

const { handleConvert } = require('../../src/cli/handlers/convert.js');

async function runWith(parsed) {
  const prev = process.exitCode;
  process.exitCode = undefined;
  const w = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { w.push(String(c)); return true; };
  try {
    await handleConvert(parsed);
    return { code: process.exitCode, out: w.join('') };
  } finally {
    process.stdout.write = orig;
    process.exitCode = prev;
  }
}

_describe('convert exit-code propagation', () => {
  _test('convert <无 input> 用法错误 sets exitCode 1 (was 0)', async () => {
    const { code, out } = await runWith({ args: [], options: {} });
    _expect(out).toContain('用法');
    _expect(code).toBe(1);
  });

  _test('convert <不存在文件> 错误 sets exitCode 1 (was 0)', async () => {
    const { code } = await runWith({ args: ['/nonexistent_zz_file.png'], options: { to: 'pdf' } });
    _expect(code).toBe(1);
  });
});
