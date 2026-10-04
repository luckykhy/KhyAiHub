'use strict';

const assert = require('assert');
const nt = require('node:test');

// handleHealth renders the 状态 column via printTable. Before the fix it emitted
// the raw ANSI color name (`✓ green` / `i cyan`); now it must emit a Chinese
// status word. Under node --test stdout is non-TTY → printTable takes its plain,
// ANSI-stripped branch, so the rendered text is deterministic.

function captureHealth() {
  const { handleHealth } = require('../../src/cli/handlers/health.js');
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  return Promise.resolve()
    .then(() => handleHealth({}))
    .then(() => lines.join('\n'))
    .finally(() => {
      console.log = orig;
    });
}

nt('status column renders Chinese words (non-vacuity: 信息 always present for the info-only 安装位置 row)', async () => {
  const out = await captureHealth();
  assert.ok(out.includes('信息'), 'expected a 信息 status word in the rendered table');
});

nt('status column no longer leaks raw ANSI color names', async () => {
  const out = await captureHealth();
  assert.ok(!/✓\s*green/.test(out), 'regression: "✓ green" color token leaked to user');
  assert.ok(!/⚠\s*yellow/.test(out), 'regression: "⚠ yellow" color token leaked to user');
  assert.ok(!/✗\s*red/.test(out), 'regression: "✗ red" color token leaked to user');
  assert.ok(!/\bi\s+/.test(out) || !/\bi\s+cyan/.test(out), 'regression: "i cyan" color token leaked to user');
});

nt('no status glyph is ever followed by a latin color/token anywhere', async () => {
  const out = await captureHealth();
  const bad = out.match(/(?:✓|⚠|✗|i)\s+(?:green|yellow|red|cyan|white|ok|warning|error|info)\b/);
  assert.ok(!bad, `regression: latin token after status glyph: ${bad && bad[0]}`);
});
