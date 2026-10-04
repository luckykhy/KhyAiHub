'use strict';

// goal handler子处理器 return 1（或 {code}）作为意图退出码，但 router 不读取子命令
// handler 的返回值 → `khy goal set`（缺目标文本）打印 ✗ 却以 rc=0 退出，脚本无法据
// 退出码判失败。handleGoal 现在唯一出口经 _rc() 落 process.exitCode。真实 CLI 已复现
// （失败 rc 从 0 翻成 1，list/help 仍 0），下面直接驱动导出的 handleGoal 固化。

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

const { handleGoal } = require('../../src/cli/handlers/goal.js');

function runWith(subCommand, args, options) {
  const prev = process.exitCode;
  process.exitCode = undefined;
  const w = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { w.push(String(c)); return true; };
  try {
    const ret = handleGoal(subCommand, args || [], options || {});
    const code = process.exitCode;
    return { code, ret, out: w.join('') };
  } finally {
    process.stdout.write = orig;
    process.exitCode = prev;
  }
}

_describe('goal exit-code propagation', () => {
  _test('goal set <空> sets exitCode 1 (was 0)', () => {
    const { code, out } = runWith('set', [], {});
    _expect(out).toContain('用法');
    _expect(code).toBe(1);
  });

  _test('goal <近似拼错的单个词> sets exitCode 1', () => {
    const { code, out } = runWith(null, ['lst'], {});
    _expect(out).toContain('未识别的 goal 参数');
    _expect(code).toBe(1);
  });

  _test('goal help succeeds WITHOUT setting a failure exitCode', () => {
    const { code, ret } = runWith('help', [], {});
    _expect(ret).toBe(0);
    _expect(code || 0).toBe(0);
  });
});
