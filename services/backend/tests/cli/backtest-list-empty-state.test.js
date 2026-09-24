'use strict';

/**
 * Regression for `khy backtest list` on an empty history.
 *
 * Two things are pinned here:
 *  1. An empty result must not render as a failure (✗). It read as "the query
 *     broke" while nothing broke.
 *  2. The formatter used by that branch must actually be imported. The fix
 *     nearly shipped a ReferenceError because backtest.js never referenced
 *     printInfo before — a static require check catches that class of slip.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const BE = path.resolve(__dirname, '../..');
const HANDLER = path.join(BE, 'src/cli/handlers/backtest.js');
const BOOTSTRAP = require.resolve(path.join(BE, 'src/cli/bootstrap.js'));
const MODELS = require.resolve(path.join(BE, 'src/models/index.js'));

let rows = [];

function installStubs() {
  require.cache[BOOTSTRAP] = {
    id: BOOTSTRAP,
    filename: BOOTSTRAP,
    loaded: true,
    exports: {
      bootstrap: async () => {},
      muteDbLogs: () => {},
      restoreDbLogs: () => {},
    },
  };
  require.cache[MODELS] = {
    id: MODELS,
    filename: MODELS,
    loaded: true,
    exports: {
      Backtest: {
        findAll: async () => rows,
      },
    },
  };
}

installStubs();
const { handleBacktestList } = require(HANDLER);

async function capture() {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => {
    chunks.push(String(c));
    return true;
  };
  try {
    await handleBacktestList({});
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join('').replace(/\u001B\[[0-9;]*m/g, '');
}

test('empty history renders as info, not as a failure', async () => {
  rows = [];
  const out = await capture();
  assert.ok(out.includes('暂无回测记录'), `empty branch not reached: ${out}`);
  assert.ok(!out.includes('✗'), `empty list still rendered with the error glyph: ${out}`);
});

test('positive control — a non-empty history takes the table path', async () => {
  rows = [
    {
      id: 1,
      name: 'ma_cross demo',
      symbol: '600000',
      status: 'done',
      returnRate: 0.12,
      sharpe: 1.4,
      created_at: '2026-09-23T00:00:00.000Z',
    },
  ];
  try {
    const out = await capture();
    assert.ok(out.includes('共 1 条回测记录'), `table header missing: ${out}`);
    assert.ok(!out.includes('暂无回测记录'), `non-empty history reported empty: ${out}`);
  } finally {
    rows = [];
  }
});

test('every formatter the empty branch calls is imported', () => {
  const src = fs.readFileSync(HANDLER, 'utf8');
  const imported = /const\s*\{([^}]*)\}\s*=\s*require\('\.\.\/formatters'\)/.exec(src);
  assert.ok(imported, 'fixture broken — formatters import block not found');
  const names = imported[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const used = new Set();
  for (const m of src.matchAll(/\b(print(Info|Error|Success|Warn|Table))\s*\(/g)) {
    used.add(m[1]);
  }
  for (const fn of used) {
    assert.ok(names.includes(fn), `${fn}() is called but not imported from ../formatters`);
  }
  assert.ok(used.has('printInfo'), 'fixture guard: expected the empty branch to use printInfo');
});
