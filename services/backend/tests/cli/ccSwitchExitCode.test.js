'use strict';

// cc-switch 各子处理器在「缺卡片 / 卡片不存在 / 缺参」等分支 printError(✗) 却裸 return，
// router 不读返回值 → rc=0。现经 markProcessFailure() 在每个 ✗ 分支落 process.exitCode；
// printWarn（如未提供密钥、无可更新字段）刻意保持 rc=0。
// 真实 CLI 已复现（add / get / update / remove 缺参 0→1；list / help 仍 0）。

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

const h = require('../../src/cli/handlers/ccSwitch.js');

async function runWith(fn, args, options) {
  const prev = process.exitCode;
  process.exitCode = undefined;
  const w = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => {
    w.push(String(c));
    return true;
  };
  try {
    await fn(args || [], options || {});
    return { code: process.exitCode, out: w.join('') };
  } finally {
    process.stdout.write = orig;
    process.exitCode = prev;
  }
}

_describe('cc-switch exit-code propagation', () => {
  _test('`add` without a name sets exitCode 1 (was 0)', async () => {
    const { code, out } = await runWith(h.handleCcSwitchAdd, [], {});
    _expect(out).toContain('缺少卡片名称');
    _expect(code).toBe(1);
  });

  _test('`get` a nonexistent card sets exitCode 1', async () => {
    const { code, out } = await runWith(h.handleCcSwitchGet, ['zz-no-such-card-xyz'], {});
    _expect(out).toContain('卡片');
    _expect(code).toBe(1);
  });

  _test('`remove` without a card sets exitCode 1', async () => {
    const { code, out } = await runWith(h.handleCcSwitchRemove, [], {});
    _expect(out).toContain('缺少卡片');
    _expect(code).toBe(1);
  });

  _test('`list` succeeds WITHOUT a failure exitCode', async () => {
    const { code } = await runWith(h.handleCcSwitchList, [], {});
    _expect(code || 0).toBe(0);
  });
});
