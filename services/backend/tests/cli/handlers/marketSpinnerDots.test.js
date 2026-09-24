'use strict';

// Regression guard for the win32+TTY spinner double-dot defect. The simple
// spinner branch in formatters.withSpinner already appends "..." to the label
// (formatters.js:1174  `  ◌ ${text}...`), so a caller that ALSO ends its
// withSpinner text with "..." renders "......" (six dots). Callers must pass a
// dot-free label. This scans market.js (wired `khy watch`/`rank`) for any
// self-appended trailing dots in a withSpinner first argument.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '../../../src/cli/handlers/market.js');

function firstArgLiterals(src) {
  // Capture the string/template literal that is the first arg of each withSpinner(.
  const out = [];
  const re = /withSpinner\(\s*(`(?:[^`]|\n)*`|'(?:[^']|\n)*'|"(?:[^"]|\n)*")/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

test('market.js passes dot-free labels to withSpinner', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const labels = firstArgLiterals(src);
  // Non-vacuity: market.js really does drive spinners.
  assert.ok(labels.length >= 3, `expected >=3 withSpinner labels, saw ${labels.length}`);
  const bad = labels.filter((l) => /\.\.\.\s*['"`]$/.test(l));
  assert.strictEqual(bad.length, 0, `self-appended trailing dots double up on win32: ${bad.join(' , ')}`);
});

test('formatters simple-spinner appends exactly one "..." to a dot-free label (win32+TTY)', () => {
  // Lock the leaf contract that the caller-side fix relies on: the win32+TTY
  // branch adds "..." itself, so a clean label must not also carry dots.
  const origPlatform = process.platform;
  const origIn = process.stdin.isTTY;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  process.stdin.isTTY = true;
  const NO_COLOR_BEFORE = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  // Re-require so the branch reads the forced platform.
  delete require.cache[require.resolve('../../../src/cli/formatters')];
  const fmt = require('../../../src/cli/formatters');
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  return fmt
    .withSpinner('查询 AAPL 行情', () => Promise.resolve('ok'))
    .then(() => {
      process.stdout.write = orig;
      process.stdin.isTTY = origIn;
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
      if (NO_COLOR_BEFORE === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = NO_COLOR_BEFORE;
      delete require.cache[require.resolve('../../../src/cli/formatters')];
      const first = chunks.join('').split('\r')[0];
      const dots = (first.match(/\.+$/) || [''])[0].length;
      assert.strictEqual(dots, 3, `expected the leaf to add exactly 3 dots, got ${dots}: ${JSON.stringify(first)}`);
    });
});
