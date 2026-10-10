'use strict';

/**
 * Regression for the deploy empty-state dead end (Rule 2.2: an error line must
 * carry problem + code + a concrete fix the user can run).
 *
 * The ledger module is stubbed to "no records" so the empty branch is reached
 * deterministically, and every `khy deploy ...` spelling the message advertises
 * is then checked against the handler's OWN accepted verb set — a hint that
 * routes to nothing is worse than no hint.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const BE = path.resolve(__dirname, '../..');
const LEDGER_PATH = require.resolve(
  path.join(BE, 'src/services/domain/deploy/deploy/deployLedger.js')
);

// Install the fake ledger before the handler is loaded: deploy.js require()s it
// lazily, so the cache entry is what it will actually receive.
require.cache[LEDGER_PATH] = {
  id: LEDGER_PATH,
  filename: LEDGER_PATH,
  loaded: true,
  exports: {
    listReconciled: () => [],
    load: () => [],
    upsert: () => {
      throw new Error('empty-state paths must never write the ledger');
    },
    remove: () => false,
    defaultDeps: () => ({ isAlive: () => false }),
  },
};

const handler = require(path.join(BE, 'src/cli/handlers/deploy.js'));
const { handleDeploy, SUB_COMMANDS } = handler;

assert.ok(SUB_COMMANDS && SUB_COMMANDS.size > 0, 'fixture: handler must export its verb set');

function stripAnsi(s) {
  return s.replace(/\u001B\[[0-9;]*m/g, '');
}

async function run(parsed) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => {
    chunks.push(String(c));
    return true;
  };
  try {
    await handleDeploy(parsed);
  } finally {
    process.stdout.write = orig;
  }
  return stripAnsi(chunks.join(''));
}

// Every verb the message tells the user to type, minus the bare deploy
// invocation, whose positional is a path placeholder rather than a verb.
function advertisedVerbs(out) {
  const found = new Set();
  for (const m of out.matchAll(/\bkhy\s+deploy(?:\s+([a-z][a-z-]*))?/g)) {
    found.add(m[1] === undefined ? '' : m[1]);
  }
  return found;
}

const CASES = [
  ['deploy list', { subCommand: 'list', args: [], options: {} }],
  ['deploy status', { subCommand: 'status', args: [], options: {} }],
  ['deploy stop', { subCommand: 'stop', args: [], options: {} }],
  ['deploy logs', { subCommand: 'logs', args: [], options: {} }],
];

for (const [label, parsed] of CASES) {
  test(`${label} with an empty ledger names a runnable remedy`, async () => {
    const out = await run(parsed);

    // The complaint: the line stopped at the diagnosis.
    assert.match(out, /尚无部署记录/, `expected the empty-ledger line, got: ${out}`);
    assert.ok(out.includes('khy deploy'), `${label} gives no command to run: ${out}`);

    // And that command must be one this handler really accepts.
    const verbs = advertisedVerbs(out);
    assert.ok(verbs.size >= 1, `fixture broken — no "khy deploy" token matched in: ${out}`);
    for (const v of verbs) {
      const ok = v === '' || SUB_COMMANDS.has(v);
      assert.ok(ok, `${label} advertises unrouted verb "khy deploy ${v}" (accepted: ${[...SUB_COMMANDS].join(', ')})`);
    }
    // A bare "khy deploy" alone would not help; the placeholder must be there.
    if (verbs.has('')) {
      assert.ok(/khy\s+deploy\s+</.test(out), `bare "khy deploy" without a target placeholder: ${out}`);
    }
  });
}

test('the same verbs still work once a record exists (fix is not a hard-coded string)', async () => {
  // Positive control: prove the branch under test is driven by the ledger
  // contents, not by a message we happen to always print.
  const rec = {
    name: 'demo',
    type: 'node',
    status: 'deployed',
    pid: null,
    port: null,
    source: 'C:\\src',
    target: 'C:\\target',
    startCmd: null,
    logFile: null,
    startedAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
  };
  require.cache[LEDGER_PATH].exports.listReconciled = () => [rec];
  try {
    const list = await run({ subCommand: 'list', args: [], options: {} });
    assert.ok(list.includes('demo'), `table missing the record: ${list}`);
    assert.ok(!list.includes('尚无部署记录'), `non-empty ledger still says empty: ${list}`);
  } finally {
    require.cache[LEDGER_PATH].exports.listReconciled = () => [];
  }
});
