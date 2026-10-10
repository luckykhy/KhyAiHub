#!/usr/bin/env node
'use strict';

// Real-product startup A/B — the decisive Windows-vs-Linux measurement.
//
// The other bench scripts time isolated probe processes or count spawns. This
// one launches the ACTUAL `khy` startup process (services/backend/bin/khy.js ai)
// end-to-end, twice:
//   • BEFORE — the startup-spawn caches OFF (KHY_GIT_SHELL_FREE=0,
//              KHY_HW_PROBE_CACHE=0, hw-probe cache wiped each run) → every
//              launch re-spawns git via a shell intermediary (cmd.exe on
//              Windows) and re-runs the 3 hardware probes.
//   • AFTER  — the caches ON and warm → git spawned directly (no cmd.exe),
//              0 hardware-probe spawns.
//
// On Linux the delta is tiny (fork is cheap). On Windows each eliminated spawn
// is a CreateProcess + Defender scan (and cmd.exe cold-start), so the BEFORE→
// AFTER delta here IS the Windows startup gap these caches close. Run it on the
// Windows machine that feels slow and compare `savedMs` to a Linux run.
//
// Self-contained: only Node core + a working `khy` checkout. No npm install and
// no network. The child reads EOF immediately (no stdin) and exits cleanly; a
// hard timeout guards against a hang.
//
// Usage:  node extensions/scripts/khy-diagnostics/bench/startup_ab_bench.js [--runs N] [--timeout-ms M]

const os = require('os');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '../..', '..');
// Prefer the in-repo source entry; fall back to a bundled copy if that is what
// the installed product uses (pip/npm layouts ship bundled/services/backend).
// runtime/node/backend is the R2-R4 migrated home of the backend.
const ENTRY_CANDIDATES = [
  path.join(REPO, 'runtime/node/backend/bin/khy.js'),
  path.join(REPO, 'services/backend/bin/khy.js'),
  path.join(REPO, 'platform/khy_os/bundled/services/backend/bin/khy.js'),
];
const ENTRY = ENTRY_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });

function argInt(flag, dflt) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return dflt;
  const v = parseInt(process.argv[i + 1], 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}
const RUNS = argInt('--runs', 9);
const TIMEOUT_MS = argInt('--timeout-ms', 30000);

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

// Launch the real product once, timing spawn→exit wall-clock in ms. Returns
// null if it times out (counted separately so a hang never poisons the median).
// Workload is `status`, not the `ai` REPL: the REPL does not exit on stdin EOF
// on Windows (verified 2026-10-04 — it hangs forever), while `status` walks the
// same startup path (module graph → init → dispatch) and exits cleanly.
function launchOnce(env) {
  const t0 = process.hrtime.bigint();
  const res = cp.spawnSync(process.execPath, [ENTRY, 'status'], {
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: TIMEOUT_MS,
    env,
    windowsHide: true,
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (res.error && res.error.code === 'ETIMEDOUT') return null;
  return ms;
}

function baseEnv(tmpHome, extra) {
  // Start from a copy of the real environment so the launch is representative,
  // then isolate the data home and pin the gate values under test.
  return Object.assign({}, process.env, { KHY_DATA_HOME: tmpHome }, extra);
}

// Sample BEFORE/AFTER alternately, run by run. Grouped sampling (all BEFORE,
// then all AFTER) is the measurement hazard on a noisy Windows box: a Defender
// burst or an FS-cache wave spanning tens of seconds lands entirely on one arm
// and manufactures a fake delta. Each side keeps its own data home so the
// per-side invariants hold (BEFORE wipes the hw-probe cache every run; AFTER
// keeps it warm) while the two arms still interleave in wall-clock time. The
// starting side also alternates per pair so a fixed phase in the noise cannot
// consistently favor one arm.
function benchInterleaved(beforeExtra, afterExtra, { wipeBeforeCacheEachRun }) {
  const mkHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ab-'));
  const homeBefore = mkHome();
  const homeAfter = mkHome();
  const cacheFile = path.join(homeBefore, 'hw_probe_cache.json');
  try {
    // One warm-up launch per side (JIT, FS cache), not measured. For AFTER this
    // also primes its hw-probe cache so its measured runs are warm.
    launchOnce(baseEnv(homeBefore, beforeExtra));
    launchOnce(baseEnv(homeAfter, afterExtra));
    const before = { samples: [], timeouts: 0 };
    const after = { samples: [], timeouts: 0 };
    for (let i = 0; i < RUNS; i++) {
      const order = i % 2 === 0 ? ['before', 'after'] : ['after', 'before'];
      for (const side of order) {
        if (side === 'before' && wipeBeforeCacheEachRun) {
          try { fs.unlinkSync(cacheFile); } catch { /* absent */ }
        }
        const ms = launchOnce(baseEnv(side === 'before' ? homeBefore : homeAfter,
          side === 'before' ? beforeExtra : afterExtra));
        const bucket = side === 'before' ? before : after;
        if (ms === null) { bucket.timeouts += 1; continue; }
        bucket.samples.push(ms);
      }
    }
    return { before, after };
  } finally {
    for (const home of [homeBefore, homeAfter]) {
      try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

function main() {
  if (!ENTRY) {
    console.error('startup_ab_bench: could not find bin/khy.js. Run from a khy checkout.');
    console.error('  looked in:\n    ' + ENTRY_CANDIDATES.join('\n    '));
    process.exit(2);
  }

  console.log(`platform=${os.platform()} arch=${os.arch()} cpus=${os.cpus().length}`);
  console.log(`node=${process.version}  runs=${RUNS}  entry=${path.relative(REPO, ENTRY)}`);
  console.log('Launching the REAL khy startup end-to-end, caches OFF vs ON (interleaved) …');
  console.log('');

  // BEFORE: startup-spawn caches OFF; wipe the hw-probe cache before every
  // launch so each one re-pays all three probe spawns + shell-wrapped git.
  // AFTER: caches ON and warm (its own warm-up primed the hw-probe cache).
  const { before, after } = benchInterleaved({
    KHY_GIT_SHELL_FREE: '0',
    KHY_HW_PROBE_CACHE: '0',
  }, {
    KHY_GIT_SHELL_FREE: '1',
    KHY_HW_PROBE_CACHE: '1',
  }, { wipeBeforeCacheEachRun: true });

  const line = (label, r) => `  ${label.padEnd(28)} : median ${median(r.samples) == null ? 'n/a' : median(r.samples).toFixed(1) + ' ms'}`
    + (r.timeouts ? `  (${r.timeouts} timeout${r.timeouts > 1 ? 's' : ''})` : '');
  console.log(line('BEFORE  (caches OFF, cold)', before));
  console.log(line('AFTER   (caches ON, warm)', after));
  console.log('  ' + '─'.repeat(60));

  const beforeMedian = median(before.samples);
  const afterMedian = median(after.samples);
  let savedMs = null;
  let savedPct = null;
  if (beforeMedian != null && afterMedian != null) {
    savedMs = beforeMedian - afterMedian;
    savedPct = (savedMs / beforeMedian) * 100;
    console.log(`  → the 4 startup-spawn caches remove ~${savedMs.toFixed(1)} ms `
      + `(${savedPct.toFixed(1)}%) from real cold startup on this OS.`);
  }
  console.log('  On Linux this is ~noise (fork is cheap); on Windows each removed');
  console.log('  spawn is a CreateProcess + Defender scan (+cmd.exe), so a large');
  console.log('  savedMs here IS the Windows startup gap these caches close.');

  const json = {
    platform: os.platform(),
    arch: os.arch(),
    node: process.version,
    runs: RUNS,
    sampling: 'interleaved',
    beforeMs: beforeMedian == null ? null : Number(beforeMedian.toFixed(2)),
    afterMs: afterMedian == null ? null : Number(afterMedian.toFixed(2)),
    savedMs: savedMs == null ? null : Number(savedMs.toFixed(2)),
    savedPct: savedPct == null ? null : Number(savedPct.toFixed(2)),
    beforeTimeouts: before.timeouts,
    afterTimeouts: after.timeouts,
  };
  console.log('');
  console.log(`RESULT_JSON ${JSON.stringify(json)}`);
}

main();
