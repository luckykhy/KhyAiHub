'use strict';

// Regression for BUG-010: App.js's mount-time `bridge.setAppRefs({...})` payload
// referenced `setPermissionRequest`, an identifier that exists nowhere in the
// file. The ReferenceError was swallowed by the surrounding try/catch, so
// setAppRefs never ran, `_appRefs` stayed null, and every confirm/list/form in
// TUI mode silently degraded to the stdin fallbacks — the native overlay layer
// was dead while looking intact. Two guards here:
//   1. uiBridge actually wires with the payload App.js now passes, and
//      showConfirmNative still falls back explicitly (confirm behavior unchanged);
//   2. an anti-phantom scan: every key in App.js's setAppRefs payload must be
//      declared in that file, so the next phantom key cannot land silently.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = path.join(__dirname, '../../../src/cli/tui/ink-components/App.js');
const bridge = require('../../../src/cli/tui/uiBridge.js');

test('App.js mount payload contains no undeclared identifiers (BUG-010 anti-phantom guard)', () => {
  const src = fs.readFileSync(APP_JS, 'utf8');
  const m = src.match(/bridge\.setAppRefs\(\{([\s\S]*?)\}\);/);
  assert.ok(m, 'App.js no longer calls bridge.setAppRefs — update this guard with the new wiring');
  const keys = m[1].split(',').map((s) => s.trim()).filter(Boolean);
  assert.ok(keys.length > 0, 'setAppRefs payload must not be empty');
  const undeclared = keys.filter((k) => {
    const decl = new RegExp(
      `(const\\s*\\[[^\\]]*\\b${k}\\b|function\\s+${k}\\b|const\\s+${k}\\b|let\\s+${k}\\b|var\\s+${k}\\b)`
    );
    return !decl.test(src);
  });
  assert.deepStrictEqual(
    undeclared,
    [],
    `setAppRefs payload references undeclared identifiers: ${undeclared.join(', ')} — ` +
      'the mount effect would throw a swallowed ReferenceError and kill the native overlay layer again'
  );
});

test('uiBridge wires with the fixed payload; confirm falls back explicitly', async () => {
  // Wire exactly what App.js now passes.
  bridge.setAppRefs({ setModelPicker() {}, setFormFlow() {} });
  assert.strictEqual(bridge.hasAppRefs(), true, 'setAppRefs must stick with the real payload');

  // showConfirmNative must detect the absent setPermissionRequest and route to
  // the stdin fallback (which resolves via its own reader), never hang.
  const fallbacks = require('../../../src/cli/tui/uiStdinFallbacks.js');
  const origShowConfirm = fallbacks.showConfirm;
  let fallbackUsed = false;
  fallbacks.showConfirm = async () => {
    fallbackUsed = true;
    return true;
  };
  try {
    const result = await bridge.showConfirmNative({ title: 'Confirm', message: 'probe', danger: false });
    assert.strictEqual(result, true, 'confirm fallback did not resolve');
    assert.strictEqual(fallbackUsed, true, 'confirm did not fall back when setPermissionRequest is absent');
  } finally {
    fallbacks.showConfirm = origShowConfirm;
    bridge.setAppRefs(null);
  }
  assert.strictEqual(bridge.hasAppRefs(), false, 'teardown: refs must reset');
});
