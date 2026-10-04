'use strict';

// Regression for hci-audit #45: `khy backup prune -n` promised a dry-run but the
// parser only routes `--x` tokens into options (router.js option loop) and
// normalizeArgs only up-cases single-dash tokens LONGER than 2 chars, so `-n`
// landed in args and backup.js's `_bool(options, 'dry-run', 'dryRun', 'n')` read
// nothing — dryRun stayed false and prune walked straight into the real-delete
// branch. backup.js now ORs a short-flag probe over args for the two destructive
// branches (restore/prune). These tests monkey-patch the service layer in-process:
// a regression must never delete anything.

const { test } = require('node:test');
const assert = require('node:assert');

const handler = require('../../src/cli/handlers/backup');
const backupService = require('../../src/services/domain/backup/backup/backupService.js');
const restoreService = require('../../src/services/domain/backup/backup/restoreService.js');

function capture(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  return Promise.resolve(fn())
    .then((result) => {
      console.log = orig;
      return { result, out: lines.join('\n') };
    })
    .catch((error) => {
      console.log = orig;
      return { result: null, out: lines.join('\n'), error };
    });
}

test('prune with bare `-n` in args runs dry, not the real-delete branch', async () => {
  const seen = [];
  const orig = backupService.pruneBackups;
  backupService.pruneBackups = (opts) => {
    seen.push(opts);
    return { root: '<probe>', kept: ['b1'], dropped: [{ id: 'b0', reason: 'probe', removed: false }] };
  };
  try {
    const { out, error } = await capture(() => handler.handleBackupCommand('prune', ['-n'], {}));
    assert.ok(!error, `handler threw: ${error && error.message}`);
    assert.strictEqual(seen.length, 1, 'pruneBackups was not called');
    assert.strictEqual(seen[0].dryRun, true, '-n did not reach the service as dryRun — dry-run is broken again');
    assert.ok(out.includes('将删除') || out.includes('预演'), `output did not promise a dry run:\n${out}`);
    assert.ok(!out.includes('已删除') && !out.includes('清理完成'), `output claimed a real deletion:\n${out}`);
  } finally {
    backupService.pruneBackups = orig;
  }
});

test('prune with no flag still reports the real-run shape (patch keeps both branches distinct)', async () => {
  const seen = [];
  const orig = backupService.pruneBackups;
  backupService.pruneBackups = (opts) => {
    seen.push(opts);
    return { root: '<probe>', kept: ['b1'], dropped: [] };
  };
  try {
    const { out } = await capture(() => handler.handleBackupCommand('prune', [], {}));
    assert.strictEqual(seen[0].dryRun, false, 'bare prune must not be dry');
    assert.ok(out.includes('无需清理'), `unexpected output:\n${out}`);
  } finally {
    backupService.pruneBackups = orig;
  }
});

test('restore with bare `-n` is dry AND -n is not mistaken for the backup id', async () => {
  const seen = [];
  const orig = restoreService.restoreBackup;
  restoreService.restoreBackup = async (id, opts) => {
    seen.push({ id, opts });
    return {
      ok: true,
      dryRun: true,
      id,
      blockers: [],
      warnings: [],
      manualSteps: [],
      failed: [],
      restored: { sqlite: 0, file: 0, cold: 0 },
    };
  };
  try {
    const { out, error } = await capture(() => handler.handleBackupCommand('restore', ['-n'], {}));
    assert.ok(!error, `handler threw: ${error && error.message}`);
    assert.strictEqual(seen[0].id, '--latest', '-n leaked into the backup id position');
    assert.strictEqual(seen[0].opts.dryRun, true, '-n did not reach restore as dryRun');
    assert.ok(out.includes('预演'), `output did not promise a dry run:\n${out}`);

    seen.length = 0;
    await capture(() => handler.handleBackupCommand('restore', ['-n', 'b-20260928'], {}));
    assert.strictEqual(seen[0].id, 'b-20260928', 'real id after -n was lost');
    assert.strictEqual(seen[0].opts.dryRun, true, 'dry-run lost when an id follows -n');
  } finally {
    restoreService.restoreBackup = orig;
  }
});

test('--dry-run long form still works for both branches', async () => {
  const seen = [];
  const origPrune = backupService.pruneBackups;
  backupService.pruneBackups = (opts) => {
    seen.push(opts);
    return { root: '<probe>', kept: ['b1'], dropped: [] };
  };
  try {
    await capture(() => handler.handleBackupCommand('prune', [], { 'dry-run': true }));
    assert.strictEqual(seen[0].dryRun, true, '--dry-run long form regressed');
  } finally {
    backupService.pruneBackups = origPrune;
  }
});
