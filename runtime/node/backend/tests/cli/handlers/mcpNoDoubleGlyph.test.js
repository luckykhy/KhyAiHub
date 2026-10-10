'use strict';

// Regression guard for the double-glyph noise defect: formatters.printSuccess/
// Error/Warn already prepend a colored "  ✓ "/"  ✗ "/"  ⚠ " (formatters.js), so a
// call site that ALSO begins its message with a status emoji renders "✓ ✅ …".
// This scans the real source and asserts the redundant-immediate-emoji pattern
// never reappears in mcp.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '../../../src/cli/handlers/mcp.js');
// Files kept clean of the double-glyph defect — extend this list as sites are fixed.
const CLEANED = [
  '../../../src/cli/handlers/mcp.js',
  '../../../src/cli/handlers/insights.js',
  '../../../src/cli/routerDispatchOps.js',
];

test('cleaned files have no print* message that begins immediately with a status emoji', () => {
  // ✅ U+2705, ❌ U+274C, ⚠ U+26A0, ✔ U+2714, ✓ U+2713 — a status glyph after the
  // opening quote/backtick (allowing leading spaces, since printSuccess already
  // indents "  ✓ " so any extra glyph/indent at the call site doubles it). The
  // `\s*` before the quote also spans multi-line calls (printSuccess(\n  `✅ …).
  const re = /print(?:Success|Error|Warn)\(\s*[`'"][ \t]*[✅❌⚠✔✓]/g;
  for (const rel of CLEANED) {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    const hits = src.match(re);
    assert.strictEqual(hits, null, `${rel} has double-glyph call sites: ${hits && hits.join(', ')}`);
  }

  // Non-vacuity: mcp.js must actually contain print* status calls to guard.
  const src = fs.readFileSync(SRC, 'utf8');
  const total = src.match(/print(?:Success|Error|Warn)\(/g);
  assert.ok(total && total.length > 10, `expected >10 print* calls, saw ${total && total.length}`);
});

test('formatters.printSuccess emits exactly one leading status glyph for plain text', () => {
  const fmt = require('../../../src/cli/formatters');
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  try {
    fmt.printSuccess('已删除 server demo');
  } finally {
    process.stdout.write = orig;
  }
  const line = chunks.join('').replace(/\r?\n$/, '');
  const glyphs = (line.match(/[✓✔✅❌✗⚠]/g) || []).length;
  assert.strictEqual(glyphs, 1, `expected exactly 1 status glyph, got ${glyphs}: ${JSON.stringify(line)}`);
});
