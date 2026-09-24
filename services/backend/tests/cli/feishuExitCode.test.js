'use strict';

// feishu async 分发器各失败分支 return 1，但 router 不读子命令返回值 → `khy feishu send`
// （缺参）打印 ✗ 却 rc=0。handleFeishu 现 await 分发结果经 _rc() 落 process.exitCode。
// 真实 CLI 已复现（send/bogus 0→1，help 仍 0）。测试仅走无网络/无 daemon 的早退分支。

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

const { handleFeishu } = require('../../src/cli/handlers/feishu.js');

async function runWith(subCommand, args, options) {
  const prev = process.exitCode;
  process.exitCode = undefined;
  const w = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { w.push(String(c)); return true; };
  try {
    const ret = await handleFeishu(subCommand, args || [], options || {});
    return { code: process.exitCode, ret, out: w.join('') };
  } finally {
    process.stdout.write = orig;
    process.exitCode = prev;
  }
}

_describe('feishu exit-code propagation', () => {
  _test('feishu send <缺参> sets exitCode 1 (was 0)', async () => {
    const { code, out } = await runWith('send', [], {});
    _expect(out).toContain('用法');
    _expect(code).toBe(1);
  });

  _test('feishu <未知子命令> sets exitCode 1', async () => {
    const { code, out } = await runWith('not-a-feishu-sub', [], {});
    _expect(out).toContain('未知子命令');
    _expect(code).toBe(1);
  });

  _test('feishu help succeeds WITHOUT a failure exitCode', async () => {
    const { code, ret } = await runWith('help', [], {});
    _expect(ret).toBe(0);
    _expect(code || 0).toBe(0);
  });
});
