'use strict';

// msg 子处理器 return 1（含 async send/test），但 router 不读子命令返回值 →
// `khy msg send`（缺参）/`khy msg <bogus>` 打印 ✗ 却 rc=0。handleMsg 现经 promise-aware
// _rc() 在唯一出口落 process.exitCode。真实 CLI 已复现（失败 0→1，status/platforms 仍 0）。

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

const { handleMsg } = require('../../src/cli/handlers/msg.js');

async function runWith(subCommand, args, options) {
  const prev = process.exitCode;
  process.exitCode = undefined;
  const w = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { w.push(String(c)); return true; };
  try {
    const ret = await handleMsg(subCommand, args || [], options || {});
    return { code: process.exitCode, ret, out: w.join('') };
  } finally {
    process.stdout.write = orig;
    process.exitCode = prev;
  }
}

_describe('msg exit-code propagation', () => {
  _test('async send <缺参> sets exitCode 1 (was 0)', async () => {
    const { code, out } = await runWith('send', [], {});
    _expect(out).toContain('用法');
    _expect(code).toBe(1);
  });

  _test('sync unknown-sub sets exitCode 1', async () => {
    const { code, out } = await runWith('totally-not-a-sub', [], {});
    _expect(out).toContain('未知子命令');
    _expect(code).toBe(1);
  });

  _test('status succeeds WITHOUT a failure exitCode', async () => {
    const { code, ret } = await runWith('status', [], {});
    _expect(ret).toBe(0);
    _expect(code || 0).toBe(0);
  });
});
