'use strict';

// linux 的输入校验分支（未知子命令 / run 缺参 / 命令不在白名单 / 参数过多 / 参数超长）
// 都 printError(✗) 却 return（裸返回），router 不读返回值 → rc=0，与「未知顶层命令 rc=1」矛盾。
// handleLinuxCommand 现经 markProcessFailure() 在每个 ✗ 分支落 process.exitCode。
// 真实 CLI 已复现（失败 0→1；run pwd / help / status 仍 0）。

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

const { handleLinuxCommand } = require('../../src/cli/handlers/linux.js');

async function runWith(subCommand, args, options) {
  const prev = process.exitCode;
  process.exitCode = undefined;
  const w = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => {
    w.push(String(c));
    return true;
  };
  try {
    await handleLinuxCommand(subCommand, args || [], options || {});
    return { code: process.exitCode, out: w.join('') };
  } finally {
    process.stdout.write = orig;
    process.exitCode = prev;
  }
}

_describe('linux exit-code propagation', () => {
  _test('unknown subcommand sets exitCode 1 (was 0)', async () => {
    const { code, out } = await runWith('not-a-sub', [], {});
    _expect(out).toContain('未知子命令');
    _expect(code).toBe(1);
  });

  _test('`run` without a command sets exitCode 1', async () => {
    const { code, out } = await runWith('run', [], {});
    _expect(out).toContain('用法');
    _expect(code).toBe(1);
  });

  _test('disallowed command sets exitCode 1', async () => {
    const { code, out } = await runWith('run', ['rmrf-no-such-cmd'], {});
    _expect(out).toContain('不允许的命令');
    _expect(code).toBe(1);
  });

  _test('`run pwd` succeeds WITHOUT a failure exitCode', async () => {
    const { code } = await runWith('run', ['pwd'], {});
    _expect(code || 0).toBe(0);
  });
});
