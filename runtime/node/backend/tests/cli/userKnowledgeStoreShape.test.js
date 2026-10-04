'use strict';

// Regression: `khy knowledge` died with "userKB is not iterable" on any install
// whose growth/user_knowledge_base.json predates the current bare-array schema —
// the loader returned JSON.parse() verbatim and every consumer iterated it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');

const SERVICE = require.resolve('../../src/services/knowledgeTeachingService');
const DATA_HOME = require.resolve('../../src/utils/dataHome');

function statsFor(fileContents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-userkb-'));
  const dir = path.join(root, 'growth');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'user_knowledge_base.json');
  fs.writeFileSync(target, fileContents);
  // Precondition: the fixture is really on the path the service will read.
  assert.strictEqual(fs.readFileSync(target, 'utf-8'), fileContents);

  const prev = process.env.KHY_APP_HOME;
  process.env.KHY_APP_HOME = root;
  // dataHome memoises the app home in a module local, so both it and the service
  // must be re-required for the redirect to take effect.
  delete require.cache[SERVICE];
  delete require.cache[DATA_HOME];
  try {
    const { getAppHome } = require(DATA_HOME);
    assert.strictEqual(path.resolve(getAppHome()), path.resolve(root),
      'KHY_APP_HOME did not redirect the app home; the test would read the real store');
    return require(SERVICE).getKnowledgeStats();
  } finally {
    if (prev === undefined) delete process.env.KHY_APP_HOME;
    else process.env.KHY_APP_HOME = prev;
    delete require.cache[SERVICE];
    delete require.cache[DATA_HOME];
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('legacy {items, updated} envelope is adopted instead of crashing the iterator', () => {
  const stats = statsFor(JSON.stringify({
    items: [{ title: 't', content: 'c', category: 'risk', learnedAt: '2026-01-01T00:00:00.000Z' }],
    updated: null,
  }));
  assert.strictEqual(stats.learnedCount, 1, 'a learned entry inside the legacy envelope was dropped');
  assert.deepStrictEqual(stats.learnedCategories, { risk: 1 });
});

test('a bare array store still reads normally', () => {
  const stats = statsFor(JSON.stringify([
    { title: 'a', content: 'aa', category: 'exec', learnedAt: '2026-01-02T00:00:00.000Z' },
    { title: 'b', content: 'bb', category: 'exec', learnedAt: '2026-01-03T00:00:00.000Z' },
  ]));
  assert.strictEqual(stats.learnedCount, 2);
});

test('unrecognised shapes degrade to empty rather than taking the command down', () => {
  for (const junk of ['{}', '"garbage-string"', '123', 'null']) {
    let stats;
    assert.doesNotThrow(() => { stats = statsFor(junk); },
      `getKnowledgeStats threw on store content: ${junk}`);
    assert.strictEqual(stats.learnedCount, 0, `non-list store ${junk} was not treated as empty`);
  }
});
