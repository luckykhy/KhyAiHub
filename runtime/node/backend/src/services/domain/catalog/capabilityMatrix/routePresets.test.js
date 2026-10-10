'use strict';

// Unit-level contract tests for routePresets.js (co-located, per [RESEARCH-018] §2.3).
// Complementary to tests/services/capabilityMatrix/predicates|composer.test.js: the
// focus here is the preset *catalog* as a declarative overlay — its frozen shape, the
// auto-selection precedence rules, and the cross-file invariant that a preset can only
// ever name capabilities that actually exist in ./descriptors.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PRESETS, selectPreset, getPreset } = require('./routePresets');
const { DESCRIPTORS } = require('./descriptors');

const idsOf = (arr) => arr.map((x) => x.id);

test('PRESETS is a frozen, ordered catalog of exactly the three declared routes', () => {
  assert.equal(Object.isFrozen(PRESETS), true);
  assert.deepEqual(idsOf(PRESETS), ['research', 'delivery', 'audit']);
  for (const p of PRESETS) {
    assert.equal(Object.isFrozen(p), true);
    assert.equal(typeof p.label, 'string');
    assert.ok(p.label.length > 0);
    assert.equal(Array.isArray(p.capabilities), true);
    assert.equal(Array.isArray(p.whenModes), true);
  }
});

test('a preset never invents a capability: every id resolves in descriptors.js', () => {
  const known = new Set(idsOf(DESCRIPTORS));
  assert.ok(known.size > 0, 'descriptor catalog must be non-empty or this assert is vacuous');
  for (const p of PRESETS) {
    assert.ok(p.capabilities.length > 0, `preset ${p.id} has an empty capability list`);
    assert.equal(new Set(p.capabilities).size, p.capabilities.length, `duplicate id in ${p.id}`);
    for (const cap of p.capabilities) {
      assert.equal(known.has(cap), true, `preset ${p.id} names unknown capability ${cap}`);
    }
  }
});

test('selectPreset: no modes / non-array modes fall back to null (full catalog, no overlay)', () => {
  assert.equal(selectPreset([]), null);
  for (const junk of [undefined, null, 'analyze', 42, {}]) {
    assert.equal(selectPreset(junk), null);
  }
});

test('selectPreset: the first listed preset wins, so mode overlap is deterministic', () => {
  // 'analyze' belongs to research, 'coding' to delivery; research is listed first.
  assert.equal(selectPreset(['analyze'])?.id, 'research');
  assert.equal(selectPreset(['learn'])?.id, 'research');
  assert.equal(selectPreset(['coding'])?.id, 'delivery');
  assert.equal(selectPreset(['ultrawork'])?.id, 'delivery');
  assert.equal(selectPreset(['goal'])?.id, 'delivery');
  assert.equal(selectPreset(['coding', 'analyze'])?.id, 'research');
  assert.equal(selectPreset(['analyze', 'coding'])?.id, 'research');
});

test('selectPreset: an unlisted mode selects nothing instead of guessing a route', () => {
  assert.equal(selectPreset(['chat', 'translate', '']), null);
});

test('the audit route is unreachable by auto-selection and must be picked by id', () => {
  assert.deepEqual(PRESETS.find((p) => p.id === 'audit').whenModes, []);
  // Every mode in the catalog at once still never lands on audit.
  const allModes = PRESETS.flatMap((p) => p.whenModes);
  assert.ok(allModes.length > 0);
  assert.notEqual(selectPreset(allModes)?.id, 'audit');
  assert.equal(getPreset('audit').id, 'audit');
});

test('getPreset returns the frozen catalog entry itself, or null', () => {
  assert.equal(getPreset('research'), PRESETS[0]);
  assert.equal(getPreset('nope'), null);
  for (const junk of [undefined, null, 42, '']) {
    assert.equal(getPreset(junk), null);
  }
});

test('selectPreset does not mutate or capture the caller mode array', () => {
  const modes = ['coding', 'analyze'];
  const picked = selectPreset(modes);
  modes.push('goal');
  modes[0] = 'nothing';
  assert.equal(picked, PRESETS[0], 'selection must be resolved eagerly from the original input');
});

test('delivery is the only preset that requires tool-use capability', () => {
  const requires = PRESETS.map((p) => [p.id, Object.entries(p.requires || {}).length]);
  assert.deepEqual(requires, [['research', 0], ['delivery', 1], ['audit', 0]]);
  assert.equal(PRESETS.find((p) => p.id === 'delivery').requires.tool_use, 3);
});

test('routePresets stays a pure leaf: no require(), no env read, no fs', () => {
  const src = fs.readFileSync(path.join(__dirname, 'routePresets.js'), 'utf8');
  const code = src
    .split(/\r?\n/)
    .filter((l) => !/^\s*\*/.test(l) && !/^\s*\/\//.test(l) && !/^\s*\/\*/.test(l))
    .join('\n');
  assert.equal(code.includes('require('), false);
  assert.equal(code.includes('process.env'), false);
});
