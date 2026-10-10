'use strict';
/**
 * [DESIGN-ARCH-169] P1a — early readiness signals in ai-manage-daemon.
 *
 * Proves (提案 §7 断言 1-3):
 *  1. The t≈0 entry sequence (control plane bind + runtime write) produces the
 *     runtime file with phase='starting' within 1s — BEFORE the serial startup
 *     chain produces anything, so the CLI can report progress instead of a
 *     silent 180s black box.
 *  2. The watchdog decision core fires 'startup-watchdog' once phase='starting'
 *     has outlived the budget (300s default > the ~206s worst-case chain).
 *  3. The watchdog decision core never fires once phase='ready'.
 *
 * The watchdog is only exercised through its pure decision core on purpose: the
 * timer wrapper terminates the process via shutdown() and must stay out of unit
 * tests.
 *
 * Hermetic: KHY_DATA_HOME is a temp dir; no management stack is started.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-daemon-early-ready-'));
// Must be set before the daemon module (and the data-home module it requires) loads.
process.env.KHY_DATA_HOME = tempHome;

const daemon = require('../scripts/ai-manage-daemon');

const RUNTIME_FILE = path.join(tempHome, 'ai_manage_runtime.json');

test.after(() => {
  daemon._resetForTests();
  fs.rmSync(tempHome, { recursive: true, force: true });
});

test('断言 1: the t≈0 entry sequence publishes the runtime file with phase=starting', async () => {
  fs.rmSync(RUNTIME_FILE, { force: true });
  const began = Date.now();
  await daemon.beginStartupPhase();
  const elapsed = Date.now() - began;

  const runtime = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
  assert.equal(runtime.phase, 'starting');
  assert.equal(runtime.phaseDetail, 'web-backend');
  assert.ok(runtime.controlPort > 0, 'control plane must already be bound');
  assert.ok(runtime.controlToken, 'control token must be published');
  assert.ok(
    elapsed <= 1000,
    `entry sequence took ${elapsed}ms — must be effectively immediate (budget 1000ms)`
  );
  // The in-process state seam agrees with the file (one source, no drift).
  assert.equal(daemon.getStartupPhaseState().phase, 'starting');
});

test('断言 2: watchdog decision fires startup-watchdog past the budget while starting', () => {
  assert.equal(
    daemon._evalStartupWatchdog(Date.now(), 'starting', 300_000, 300_000),
    'startup-watchdog'
  );
  assert.equal(
    daemon._evalStartupWatchdog(Date.now(), 'starting', 301_000, 300_000),
    'startup-watchdog'
  );
  assert.equal(daemon._evalStartupWatchdog(Date.now(), 'starting', 299_999, 300_000), null);
  // Budget sanity: 300s still covers the ~206s worst-case serial chain (§1.3).
  assert.equal(daemon._evalStartupWatchdog(Date.now(), 'starting', 206_000, 300_000), null);
});

test('断言 3: watchdog decision never fires once phase=ready', () => {
  assert.equal(daemon._evalStartupWatchdog(Date.now(), 'ready', 10 * 60_000, 300_000), null);
});

test('phase transitions ride the runtime file; _resetForTests restores defaults', () => {
  daemon._setStartupPhase('ready', 'ready');
  const runtime = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
  assert.equal(runtime.phase, 'ready');
  assert.equal(runtime.phaseDetail, 'ready');

  daemon._resetForTests();
  const state = daemon.getStartupPhaseState();
  assert.equal(state.phase, 'starting');
  assert.equal(state.phaseDetail, '');
});
