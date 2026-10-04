'use strict';

/**
 * Round-29 contract: quant-app handlers/data.js quiet paths.
 *
 * Pins four user-visible invariants proven by live repro in
 * .khy/feedback/data-fetch-noise-round29/ :
 *  T1 singleton services must never be `new`-ed (crash repro: rc output
 *     "KlineDataService is not a constructor" on every `khy data fetch`);
 *  T2 quote failure under the host's TUI short-circuit branch → handler prints
 *     the fallback error exactly once (spinner renders nothing there);
 *  T3 quote failure outside that branch → handler prints nothing (spinner's
 *     own fail line owns it — three duplicate prints was the bug);
 *  T4 empty kline result → error names symbol + period + a concrete remedy;
 *  T5 data fetch awaits the winston console transport muted and restores it
 *     afterwards (withSpinner's muteOutput does not cover winston).
 *
 * node --test only (uses require.cache seeding; jest has its own registry).
 * Skips cleanly when no quant-app is resolvable on this machine.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const BACKEND = path.resolve(__dirname, '..', '..', '..');
const REPO = path.resolve(BACKEND, '..', '..');
const qa = require(path.join(BACKEND, 'src', 'services', 'extensions', 'quantApp.js'));
const APP = qa.resolveDir();

function seed(absPath, exportsObj) {
  const m = new Module(absPath, null);
  m.filename = absPath;
  m.loaded = true;
  m.exports = exportsObj;
  require.cache[absPath] = m;
  return m;
}
const Module = require('module');

// The handler requires services INSIDE the call bodies, so the seeds must stay
// live across `await run(...)` — seeding only around require time is a no-op.
async function usingHandler(fake, run, extraSeeds = {}) {
  const hb = path.join(APP, 'handlers', 'bootstrap.js');
  const hf = path.join(APP, 'handlers', 'formatters.js');
  const hd = path.join(APP, 'handlers', 'data.js');
  const hm = path.join(APP, 'services', 'marketDataService.js');
  const hk = path.join(APP, 'services', 'klineDataService.js');
  const hu = path.join(REPO, 'services', 'backend', 'src', 'services', 'userProfile.js');
  const extra = Object.keys(extraSeeds).map((k) => path.resolve(k));
  const seeded = [hb, hf, hd, hm, hk, hu, ...extra];
  const prev = seeded.map((p) => require.cache[p]);
  try {
    seed(hb, { bootstrap: async () => {}, muteDbLogs: () => {}, restoreDbLogs: () => {} });
    seed(hf, fake);
    seed(hm, fake.__marketDataService);
    seed(hk, fake.__klineDataService);
    seed(hu, { trackSymbol: () => {} });
    for (const k of Object.keys(extraSeeds)) seed(path.resolve(k), extraSeeds[k]);
    delete require.cache[hd];
    // Must go through qa.loadModule: the handler's ../../../services/backend/...
    // require (legacy layout) needs the host bridge's ancestor-chain remap.
    return await run(qa.loadModule('handlers/data.js'));
  } finally {
    seeded.forEach((p, i) => {
      if (prev[i]) require.cache[p] = prev[i];
      else delete require.cache[p];
    });
  }
}

test('skip notice: quant-app resolvable (all below depend on it)', async (t) => {
  if (!APP || !fs.existsSync(path.join(APP, 'handlers', 'data.js'))) {
    await t.skip('no quant-app on this machine');
    return;
  }
  const src = fs.readFileSync(path.join(APP, 'handlers', 'data.js'), 'utf8');
  const rp = fs.readFileSync(path.join(APP, 'config', 'referencePrices.js'), 'utf8');
  assert.ok(!/new\s+KlineDataService\s*\(/.test(src), 'T1a handlers/data.js must not new the exported singleton');
  assert.ok(!/new\s+(KlineDataService|MarketDataService)\s*\(/.test(rp), 'T1b referencePrices.js must not new exported singletons');
});

function formattersFake({ tuiActive, tuiCli, marketErr }) {
  const calls = { printError: [], quote: [] };
  const f = {
    printQuote: (q) => calls.quote.push(q),
    printTable: () => {},
    printSuccess: () => {},
    printError: (msg) => calls.printError.push(String(msg)),
    withSpinner: async (text, fn, opts) => {
      f.__spinnerText = text;
      const silent = process.env.KHY_INK_TUI_ACTIVE === '1' && !tuiCli;
      try {
        return await fn();
      } catch (e) {
        // host withSpinner prints its fail line only when it actually rendered
        if (!silent) calls.printError.push('SPINNER_FAIL:' + e.message);
        throw e;
      }
    },
    isTuiRunningCliCommand: () => tuiCli,
    __marketDataService: { getRealTimeQuote: async () => { throw marketErr; } },
    __klineDataService: { get: () => ({}) },
    __calls: calls,
  };
  if (tuiActive !== undefined) process.env.KHY_INK_TUI_ACTIVE = tuiActive ? '1' : '';
  return f;
}

test('T2 quote failure, TUI short-circuit branch → handler fallback-prints exactly once', async (t) => {
  if (!APP) return t.skip('no quant-app');
  const saved = process.env.KHY_INK_TUI_ACTIVE;
  delete process.env.KHY_INK_TUI_ACTIVE;
  process.env.KHY_INK_TUI_ACTIVE = '1';
  try {
    const f = formattersFake({ tuiActive: true, tuiCli: false, marketErr: new Error('boom-T2') });
    await usingHandler(f, (h) => h.handleQuote('sh600000'));
    const own = f.__calls.printError.filter((s) => !s.startsWith('SPINNER_FAIL:'));
    assert.equal(own.length, 1, 'exactly one handler-level error print, got: ' + JSON.stringify(own));
    assert.match(own[0], /boom-T2/, 'fallback must carry the cause');
  } finally {
    if (saved === undefined) delete process.env.KHY_INK_TUI_ACTIVE;
    else process.env.KHY_INK_TUI_ACTIVE = saved;
  }
});

test('T3 quote failure, spinner visible → no duplicate handler print', async (t) => {
  if (!APP) return t.skip('no quant-app');
  const saved = process.env.KHY_INK_TUI_ACTIVE;
  delete process.env.KHY_INK_TUI_ACTIVE;
  try {
    const f = formattersFake({ tuiCli: false, marketErr: new Error('boom-T3') });
    await usingHandler(f, (h) => h.handleQuote('sh600000'));
    const own = f.__calls.printError.filter((s) => !s.startsWith('SPINNER_FAIL:'));
    assert.equal(own.length, 0, 'spinner fail line owns the report; handler must stay silent');
    assert.equal(f.__calls.printError.filter((s) => s.startsWith('SPINNER_FAIL:')).length, 1);
  } finally {
    if (saved === undefined) delete process.env.KHY_INK_TUI_ACTIVE;
    else process.env.KHY_INK_TUI_ACTIVE = saved;
  }
});

test('T4 empty kline → message carries symbol, period and a remedy', async (t) => {
  if (!APP) return t.skip('no quant-app');
  const f = formattersFake({ tuiCli: true, marketErr: new Error('unused') });
  f.__klineDataService = { getKlineData: async () => ({ kline: [], data_source: 'enhanced_mock' }) };
  await usingHandler(f, (h) => h.handleDataFetch('QOKEBAD', { period: 'daily' }));
  assert.equal(f.__calls.printError.length, 1, 'exactly one error line, got ' + JSON.stringify(f.__calls.printError));
  const msg = f.__calls.printError[0];
  assert.match(msg, /QOKEBAD/, 'names the symbol');
  assert.match(msg, /daily/, 'names the period');
  assert.match(msg, /khy data list|sh600519/, 'offers a concrete remedy');
  assert.ok(!/K线数据\.{2,}/.test(String(f.__spinnerText || '')), 'spinner text must not pre-append dots (host appends its own)');
});

test('T5 data fetch mutes winston console transport around the download and restores it', async (t) => {
  if (!APP) return t.skip('no quant-app');
  const logger = require(path.join(BACKEND, 'src', 'utils', 'logger.js'));
  const ct = (logger.transports || []).find((x) => x && x.name === 'console');
  if (!ct) return t.skip('no console transport in this environment');
  const before = ct.level;
  let during = '__never-called__';
  const f = formattersFake({ tuiCli: true, marketErr: new Error('unused') });
  f.__klineDataService = {
    getKlineData: async () => {
      during = ct.level;
      return { kline: [{ time: '2026-01-01', close: 1 }], data_source: 'unit' };
    },
  };
  await usingHandler(f, (h) => h.handleDataFetch('sh600000', { period: 'daily' }));
  assert.equal(during, 'silent', 'console transport must be silenced while the download runs (winston ignores withSpinner muteOutput — see repro probe: transport.level=warn beat instance.level=silent)');
  assert.equal(ct.level, before, 'transport level restored');
});

// ── T6/T7 cache-clear honesty (round 33, .khy/feedback/hci-r33-silent-catch/) ──
// Repro: host cacheService exports { get,set,del,clearByPrefix,getStats } — the
// old handler probed flushAll/clear, matched neither, and printed "✓ 缓存已清理"
// while removing zero entries; its catch even printed a success on failure.

function cacheClearFake() {
  const calls = { success: [], errors: [] };
  return {
    calls,
    fake: {
      printQuote: () => {},
      printTable: () => {},
      printSuccess: (m) => calls.success.push(String(m)),
      printError: (m) => calls.errors.push(String(m)),
      withSpinner: async (t, fn) => fn(),
      isTuiRunningCliCommand: () => false,
      __marketDataService: {},
      __klineDataService: {},
    },
  };
}

test('T6 cache clear removes every quant key domain and reports the real count', async (t) => {
  if (!APP) return t.skip('no quant-app');
  const seen = [];
  const counts = { 'kline:': 2, 'news:': 1, 'finlight:': 0, 'ml:': 3, 'stock:': 4 };
  const { fake, calls } = cacheClearFake();
  const cacheSeed = {
    clearByPrefix: async (p) => { seen.push(p); return counts[p] ?? 0; },
  };
  const seeds = {};
  seeds[path.join(APP, 'services', 'cacheService.js')] = cacheSeed;
  await usingHandler(fake, (h) => h.handleCacheClear(), seeds);
  for (const p of Object.keys(counts)) {
    assert.ok(seen.includes(p), 'prefix not cleared: ' + p + ' (cleared: ' + JSON.stringify(seen) + ')');
  }
  assert.equal(calls.success.length, 1, 'expected exactly one success line');
  assert.match(calls.success[0], /10/, 'count must be the real sum 2+1+0+3+4, got: ' + calls.success[0]);
});

test('T7 cache clear failure → error line, never a fake success', async (t) => {
  if (!APP) return t.skip('no quant-app');
  const { fake, calls } = cacheClearFake();
  const seeds = {};
  seeds[path.join(APP, 'services', 'cacheService.js')] = {
    clearByPrefix: async () => { throw new Error('store wedged'); },
  };
  await usingHandler(fake, (h) => h.handleCacheClear(), seeds);
  assert.equal(calls.success.length, 0, 'failure must not printSuccess');
  assert.equal(calls.errors.length, 1);
  assert.match(calls.errors[0], /store wedged/, 'cause must reach the user');
  assert.doesNotMatch(calls.errors.join(''), /内存缓存/, 'the old fake-success wording must be gone');
});
