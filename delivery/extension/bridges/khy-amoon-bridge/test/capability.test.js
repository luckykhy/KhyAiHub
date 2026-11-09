'use strict';

/**
 * capability.test.js — Phase 0 gate writer/instructions (no device, no model).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const C = require('../lib/contracts');
const { loadConfig } = require('../lib/config');
const { buildProbeInstructions, recordCapability, showCapability } = require('../scripts/probe-amoon');

function tempConfig(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amoon-cap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return loadConfig({ stateDir: dir, env: { KHY_AMOON_HOME: dir, KHY_AMOON_PORT: '18888' } });
}

test('probe instructions name the three amoon-side actions', (t) => {
  const config = tempConfig(t);
  const lines = buildProbeInstructions({ config }).join('\n');
  assert.match(lines, /kb health/);
  assert.match(lines, /inbox\//);
  assert.match(lines, /cmd_/);
  assert.match(lines, /127\.0\.0\.1:18888\/health/);
  assert.match(lines, /PC 侧 adb shell 的结果不算/);
});

test('capability writer computes unavailable/partial/verified and persists', (t) => {
  const config = tempConfig(t);

  const none = recordCapability({ config, evidence: {} });
  assert.equal(none.status, C.CAPABILITY_STATUS.UNAVAILABLE);
  assert.equal(none.http, false);

  const partial = recordCapability({ config, evidence: { shell: true, http: false, fileWrite: false } });
  assert.equal(partial.status, C.CAPABILITY_STATUS.PARTIAL);

  // A verified status without the raw http field must not imply HTTP.
  const verifiedNoHttp = recordCapability({
    config,
    evidence: { shell: true, http: false, fileWrite: true },
    by: 'tester',
  });
  assert.equal(verifiedNoHttp.status, C.CAPABILITY_STATUS.PARTIAL);
  assert.equal(verifiedNoHttp.http, false);

  const verified = recordCapability({
    config,
    evidence: { shell: true, http: true, fileWrite: true, fileRead: true, note: 'kb health + inbox + curl' },
    by: 'tester',
  });
  assert.equal(verified.status, C.CAPABILITY_STATUS.VERIFIED);
  assert.equal(verified.by, 'tester');

  const stored = showCapability(config);
  assert.equal(stored.status, C.CAPABILITY_STATUS.VERIFIED);
  assert.equal(stored.http, true);
  assert.equal(JSON.parse(fs.readFileSync(config.paths.capability, 'utf8')).status, 'verified');
});
