'use strict';

// lang 的不支持语言分支 printError(✗) 却 return false，router 不读返回值 → rc=0。
// 现经 markProcessFailure() 落 process.exitCode。
// 真实 CLI 已复现（khy lang fr 0→1；khy lang status 仍 0；禁用分支 printInfo 仍 0）。

process.env.NO_COLOR = '1';
process.env.FORCE_COLOR = '0';
process.env.KHY_LANG_COMMAND = 'true';

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

const { handleLang } = require('../../src/cli/handlers/lang.js');

async function runWith(sub, envOverride) {
  const prev = process.exitCode;
  const prevEnv = process.env.KHY_LANG_COMMAND;
  if (envOverride !== undefined) process.env.KHY_LANG_COMMAND = envOverride;
  process.exitCode = undefined;
  const w = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => {
    w.push(String(c));
    return true;
  };
  try {
    await handleLang(sub, [], {});
    return { code: process.exitCode, out: w.join('') };
  } finally {
    process.stdout.write = orig;
    process.exitCode = prev;
    if (envOverride !== undefined) process.env.KHY_LANG_COMMAND = prevEnv;
  }
}

_describe('lang exit-code propagation', () => {
  _test('unsupported language sets exitCode 1 (was 0)', async () => {
    const { code, out } = await runWith('fr');
    _expect(out).toContain('不支持的语言');
    _expect(code).toBe(1);
  });

  _test('`status`/read-only succeeds WITHOUT a failure exitCode', async () => {
    const { code } = await runWith('status');
    _expect(code || 0).toBe(0);
  });

  _test('disabled gate branch (printInfo) stays exitCode 0 even on bad arg', async () => {
    const { code, out } = await runWith('fr', 'off');
    _expect(out).toContain('config set language.preference');
    _expect(code || 0).toBe(0);
  });
});
