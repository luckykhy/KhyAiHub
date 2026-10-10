'use strict';

/**
 * r62 contract: the weak-model coding-profile guidance about version sources
 * must not rot behind the gate it points at. Assertions are DATA-DRIVEN from
 * scripts/ci/check-version-sync.js (the authoritative VERSION_GROUPS spec),
 * so a future fifth G1 source with an un-updated sentence turns T1 red
 * automatically — no human has to remember to amend this test.
 */

const gate = require('../../../../../scripts/ci/check-version-sync.js');
const wmg = require('../../src/services/weakModelGuidance.js');

function renderedWhyLine() {
  const block = wmg.buildIntentionalDesigns({});
  return String(block)
    .split('\n')
    .find((l) => l.includes('no-hardcode rule'));
}

test('T0 non-vacuity: gate really declares a main-khy-os group with sources', () => {
  const group = gate.VERSION_GROUPS.find(
    (g) => g.id === 'main-khy-os' || (g.files || []).includes('pyproject.toml')
  );
  expect(group).toBeTruthy();
  expect(group.files.length).toBeGreaterThanOrEqual(4);
});

test('T1 rendered WHY line names EVERY file of the gate G1 group', () => {
  const group = gate.VERSION_GROUPS.find((g) => g.id === 'main-khy-os');
  const line = renderedWhyLine();
  expect(line).toBeTruthy();
  for (const file of group.files) {
    expect(line).toContain(file);
  }
});

test('T2 line points at the authoritative spec instead of being the truth', () => {
  const line = renderedWhyLine();
  expect(line).toContain('VERSION_GROUPS');
  expect(line).toContain('check-version-sync.js');
});

// Field-free regression guard: green pre- AND post-fix — the knife must not
// have gutted the entry's original meaning (no-hardcode warning stays).
test('T3 no-hardcode teaching survives the rewrite', () => {
  const line = renderedWhyLine();
  expect(line).toContain('ENFORCES the no-hardcode rule');
  expect(line).toContain('fail on purpose');
});
