'use strict';

// Wiring test: claude/codex adopt credential hints must teach the CURRENT
// shell's env-set syntax, not POSIX `export` on every platform. Non-vacuity:
// each case asserts the branch header was reached. Leaf-level platform
// branching is already covered in tests/constants/shellChainStyle.test.js.

process.env.FORCE_COLOR = '0'; // keep chalk output free of ANSI escapes

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const CLAUDE_ADOPT = path.join(__dirname, '../../src/cli/handlers/claudeAdopt.js');
const CODEX_ADOPT = path.join(__dirname, '../../src/cli/handlers/codexAdopt.js');

const CRED = [
  'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
  'CODEX_API_KEY', 'OPENAI_API_KEY', 'CODEX_DIRECT_BASE_URL',
];

// Capture console output while forcing a platform. The no-cred / empty-preset
// branches return before any file write, so this is side-effect free; only
// process.platform is patched, then restored.
async function runOn(platform, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { lines.push(String(chunk)); return true; };
  for (const k of CRED) delete process.env[k];
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
    if (desc) Object.defineProperty(process, 'platform', { ...desc, configurable: true });
  }
  return lines.join('');
}

const ca = require(CLAUDE_ADOPT);
const co = require(CODEX_ADOPT);

test('claude adopt-env win32: verb-less lines + per-shell note, no bare export command', async () => {
  const out = await runOn('win32', () => ca.handleClaudeAdoptEnv({}));
  assert.match(out, /请先在当前 shell 设置/, 'non-vacuity: reached no-cred branch');
  assert.match(out, /各 shell 的写法/
  );
  assert.doesNotMatch(out, /^\s+export [A-Z_]+=/m, 'win32 must not print a bare `export NAME=` command line');
  assert.match(out, /^\s+ANTHROPIC_BASE_URL="/m, 'win32 lines are verb-less, ready for any shell');
});

test('claude adopt-env linux: POSIX export command retained', async () => {
  const out = await runOn('linux', () => ca.handleClaudeAdoptEnv({}));
  assert.match(out, /请先在当前 shell 设置/);
  assert.match(out, /^\s+export ANTHROPIC_BASE_URL="/m);
  assert.doesNotMatch(out, /各 shell 的写法/, 'posix gets no extra note line');
});

test('codex use-relay (no preset) win32: verb-less lines + note', async () => {
  const out = await runOn('win32', () => co.handleCodexUseRelay(undefined, {}));
  assert.match(out, /你可以直接用你自己的端点/, 'non-vacuity: reached empty-preset branch');
  assert.match(out, /各 shell 的写法/);
  assert.doesNotMatch(out, /^\s+export [A-Z_]+=/m);
});

test('codex use-relay (no preset) linux: export retained, no note', async () => {
  const out = await runOn('linux', () => co.handleCodexUseRelay(undefined, {}));
  assert.match(out, /^\s+export CODEX_DIRECT_BASE_URL="/m);
  assert.doesNotMatch(out, /各 shell 的写法/);
});
