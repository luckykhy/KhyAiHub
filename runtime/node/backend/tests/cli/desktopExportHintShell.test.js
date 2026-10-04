'use strict';

// Wiring test: `khy desktop on|ask` must teach the CURRENT shell's env-set
// syntax for persisting KHY_DESKTOP_CONTROL, not POSIX `export` on win32.
// handleDesktop only sets process.env in-process and prints (no real control),
// so this drives the true branch offline. Non-vacuity: asserts the on-branch
// success line was reached. Leaf platform logic lives in shellChainStyle.

process.env.FORCE_COLOR = '0';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const DESKTOP = path.join(__dirname, '../../src/cli/handlers/desktop.js');

async function runOn(platform, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  const prev = process.env.KHY_DESKTOP_CONTROL;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { lines.push(String(c)); return true; };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
    if (desc) Object.defineProperty(process, 'platform', { ...desc, configurable: true });
    if (prev === undefined) delete process.env.KHY_DESKTOP_CONTROL;
    else process.env.KHY_DESKTOP_CONTROL = prev;
  }
  return lines.join('');
}

for (const mode of ['on', 'ask']) {
  test(`desktop ${mode} win32: no bare export instruction, per-shell note present`, async () => {
    const { handleDesktop } = require(DESKTOP);
    const out = await runOn('win32', () => handleDesktop(mode, []));
    assert.match(out, /桌面操控已开启/, 'non-vacuity: reached the on-branch');
    assert.doesNotMatch(out, /export KHY_DESKTOP_CONTROL/, 'win32 must not say `export NAME`');
    assert.match(out, /在 shell 中设置 KHY_DESKTOP_CONTROL/);
    assert.match(out, /各 shell 的写法/);
  });

  test(`desktop ${mode} linux: POSIX export byte-identical, no note`, async () => {
    const { handleDesktop } = require(DESKTOP);
    const out = await runOn('linux', () => handleDesktop(mode, []));
    assert.match(out, /在 shell 中 export KHY_DESKTOP_CONTROL/, 'posix keeps the original instruction');
    assert.doesNotMatch(out, /各 shell 的写法/, 'posix gets no extra note line');
  });
}
