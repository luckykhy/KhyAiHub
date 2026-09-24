'use strict';

/**
 * Round-34 contract: handlers/service.js handleDbStatus honest counts.
 *
 * Repro (.khy/feedback/hci-r34-dbstatus-zero/): every `Model.count()` was
 * wrapped in `.catch(() => 0)`, so a broken query (e.g. tables not yet
 * created) rendered as a genuine `0` under `✓ 数据库连接正常` — the user
 * could not tell "empty table" from "query failed", and the error message
 * was discarded entirely.
 *
 * Pins:
 *  T1 failed counts render 「查询失败」 in-cell, exactly one error line
 *     carries fraction + first raw cause + `khy db init` remedy;
 *  T2 healthy counts keep plain numbers and print zero error lines;
 *  T3 a genuine empty table still shows `0` (fix must not erase truth);
 *  T4 non-vacuity — all five models were actually queried through the stub.
 *
 * node --test only (require.cache seeding).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const SRC = path.resolve(__dirname, '..', '..', '..', 'src');
const P = {
  bootstrap: path.join(SRC, 'cli', 'bootstrap.js'),
  // require.resolve (no execution) — the handler's `require('../../models')`
  // lands on index.js, so the cache key must be the resolved filename.
  models: require.resolve(path.join(SRC, 'models')),
  formatters: path.join(SRC, 'cli', 'formatters.js'),
  handler: path.join(SRC, 'cli', 'handlers', 'service.js'),
};

function seed(absPath, exportsObj) {
  const m = new Module(absPath, null);
  m.filename = absPath;
  m.loaded = true;
  m.exports = exportsObj;
  require.cache[absPath] = m;
}

async function usingHandler(modelsExports, run) {
  const keys = [P.bootstrap, P.models, P.formatters, P.handler];
  const prev = keys.map((p) => require.cache[p]);
  try {
    seed(P.bootstrap, { bootstrap: async () => ({}) });
    seed(P.models, modelsExports);
    const calls = { success: [], errors: [], info: [], tables: [] };
    seed(P.formatters, {
      printSuccess: (m) => calls.success.push(String(m)),
      printError: (m) => calls.errors.push(String(m)),
      printInfo: (m) => calls.info.push(String(m)),
      printTable: (head, rows) => calls.tables.push({ head, rows }),
      withSpinner: async (t, fn) => fn(),
    });
    calls.__calls = calls;
    delete require.cache[P.handler];
    const h = require(P.handler);
    return await run(h, calls);
  } finally {
    keys.forEach((p, i) => {
      if (prev[i]) require.cache[p] = prev[i];
      else delete require.cache[p];
    });
  }
}

const mkModel = (name, spec) => ({
  count: async () => {
    mkModel.__queried.push(name);
    if (spec === true) throw new Error(`SQLITE_ERROR: no such table: ${name}`);
    return typeof spec === 'number' ? spec : 42;
  },
});
mkModel.__queried = [];

function modelsSet(spec) {
  return {
    sequelize: {},
    User: mkModel('User', spec.User),
    Strategy: mkModel('Strategy', spec.Strategy),
    Instrument: mkModel('Instrument', spec.Instrument),
    Backtest: mkModel('Backtest', spec.Backtest),
    Trade: mkModel('Trade', spec.Trade),
  };
}

test('T1 failed counts → 「查询失败」 cells + one honest error line with cause and remedy', async () => {
  await usingHandler(
    modelsSet({ User: true, Strategy: true, Instrument: false, Backtest: false, Trade: true }),
    async (h, calls) => {
      await h.handleDbStatus();
      const rows = calls.tables[0].rows;
      const cell = (label) => rows.find((r) => r[0].includes(label))[1];
      assert.equal(cell('User'), '查询失败', 'failed query must not render as 0');
      assert.equal(cell('Strategy'), '查询失败');
      assert.equal(cell('Trade'), '查询失败');
      assert.equal(cell('Instrument'), '42', 'healthy rows must still print numbers');
      assert.equal(calls.errors.length, 1, 'exactly one error line, got: ' + JSON.stringify(calls.errors));
      assert.match(calls.errors[0], /3\/5/, 'must state how many of five failed');
      assert.match(calls.errors[0], /no such table: User/, 'first raw cause must reach the user');
      assert.match(calls.errors[0], /khy db init/, 'must offer the concrete remedy');
    }
  );
});

test('T2 healthy counts → plain numbers, zero error lines', async () => {
  await usingHandler(
    modelsSet({ User: 7, Strategy: 7, Instrument: 7, Backtest: 7, Trade: 7 }),
    async (h, calls) => {
      await h.handleDbStatus();
      const rows = calls.tables[0].rows;
      assert.ok(rows.every((r) => r[1] === '7'), 'all cells numeric, got: ' + JSON.stringify(rows));
      assert.equal(calls.errors.length, 0);
      assert.equal(calls.success.length, 1, 'connection success line kept');
    }
  );
});

test('T3 genuine empty table still shows 0 (truth not erased by the honesty fix)', async () => {
  await usingHandler(
    modelsSet({ User: 0, Strategy: 0, Instrument: 0, Backtest: 0, Trade: 0 }),
    async (h, calls) => {
      await h.handleDbStatus();
      const rows = calls.tables[0].rows;
      assert.ok(rows.every((r) => r[1] === '0'), 'empty tables must render 0, got: ' + JSON.stringify(rows));
      assert.equal(calls.errors.length, 0, 'all-success zeros must not trigger the failure line');
    }
  );
});

test('T4 non-vacuity: the stub was actually reached for all five models', async () => {
  mkModel.__queried.length = 0;
  await usingHandler(
    modelsSet({ User: false, Strategy: true, Instrument: false, Backtest: false, Trade: false }),
    async (h) => { await h.handleDbStatus(); }
  );
  assert.deepEqual(
    [...mkModel.__queried].sort(),
    ['Backtest', 'Instrument', 'Strategy', 'Trade', 'User'],
    'handleDbStatus must query exactly the five tables'
  );
});
