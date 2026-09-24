'use strict';

// Regression: `khy prompt` used to die with
// "Cannot read properties of undefined (reading 'localeCompare')" on every install
// where promptReuseStore had captured a recipe, because the prompts root is shared
// (promptReuseStore writes prompts/recipes/*.json) and listPrompts() ingested every
// .json it found and then sorted on a field only its own records carry.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');

const SERVICE = require.resolve('../../src/services/promptLibraryService');

function freshService(appHome) {
  delete require.cache[SERVICE];
  const prev = process.env.KHY_APP_HOME;
  process.env.KHY_APP_HOME = appHome;
  try {
    return require(SERVICE);
  } finally {
    if (prev === undefined) delete process.env.KHY_APP_HOME;
    else process.env.KHY_APP_HOME = prev;
  }
}

test('listPrompts ignores another feature\'s json and tolerates a missing createdAt', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-promptlib-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const prompts = path.join(root, 'prompts');
  fs.mkdirSync(path.join(prompts, 'recipes'), { recursive: true });

  // 1) A promptReuseStore capture: shares the root, has no `content`, no `createdAt`.
  fs.writeFileSync(
    path.join(prompts, 'recipes', '2494ddb6.json'),
    JSON.stringify({ id: '2494ddb6', signature: 'sig', category: 'fix', tokens: 12, taskSamples: ['x'] })
  );
  // 2) A well-formed user prompt.
  fs.writeFileSync(
    path.join(prompts, 'good.json'),
    JSON.stringify({ id: 'good', title: '好', content: 'body', createdAt: '2026-01-02T00:00:00.000Z', usedCount: 0 })
  );
  // 3) A user prompt with no createdAt — the shape that used to throw in the sort.
  fs.writeFileSync(
    path.join(prompts, 'legacy.json'),
    JSON.stringify({ id: 'legacy', title: '旧', content: 'older body', usedCount: 0 })
  );
  assert.strictEqual(
    fs.readdirSync(prompts, { recursive: true }).filter((f) => String(f).endsWith('.json')).length,
    3,
    'fixture did not materialise; the assertions below would be vacuous');

  const svc = freshService(root);
  let rows;
  assert.doesNotThrow(() => { rows = svc.listPrompts(); }, 'listPrompts still throws');

  assert.deepStrictEqual(rows.map((r) => r.id).sort(), ['good', 'legacy'],
    'prompt listing must contain exactly the user prompts, newest first');
  assert.ok(rows.every((r) => typeof r.content === 'string'),
    'a non-prompt record leaked into the listing');
  assert.strictEqual(rows[0].id, 'good', 'sort must not be wrecked by a record without createdAt');
});
