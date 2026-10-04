'use strict';

// handleRole 在「无角色描述的用法分支」和「runRole 返回 success:false 的错误分支」都用
// printError 打印 ✗，却 `return true`。router 不读返回值 → `khy role`（无参）明明 ✗ 用法
// 却 rc=0。现经 utils/markProcessFailure 在两处 ✗ 分支落 process.exitCode。
// 非空断言：成功路径（set / show）必须保持 rc=0，以证 _markFailure 未过度触发。
// 真实 CLI 已复现：无参 0→1，--show 仍 0。

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

const { handleRole } = require('../../src/cli/handlers/role.js');

async function runWith(parsed) {
  const prev = process.exitCode;
  process.exitCode = undefined;
  const w = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { w.push(String(c)); return true; };
  try {
    await handleRole(parsed);
    return { code: process.exitCode, out: w.join('') };
  } finally {
    process.stdout.write = orig;
    process.exitCode = prev;
  }
}

_describe('role exit-code propagation', () => {
  _test('role <无描述> 用法错误 sets exitCode 1 (was 0)', async () => {
    const { code, out } = await runWith({ args: [], options: {} });
    _expect(out).toContain('用法');
    _expect(code).toBe(1);
  });

  _test('role set 成功 keeps exitCode 0 (非空: 未过度触发)', async () => {
    const { code } = await runWith({ args: ['资深面试官'], options: {} });
    _expect(code || 0).toBe(0);
  });

  _test('role --show 成功 keeps exitCode 0', async () => {
    const { code } = await runWith({ args: [], options: { show: true } });
    _expect(code || 0).toBe(0);
  });
});
