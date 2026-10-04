'use strict';

/**
 * keybindingCatalog.js contract tests — the SSOT behind `/keybindings` and the `?`
 * overlay: data-model shape, the honest terminal-boundary wording, selection
 * filters and the deterministic text renderer.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  KEYBINDING_CATALOG,
  ESSENTIAL_SHORTCUTS,
  getEssentialShortcuts,
  selectCatalog,
  formatCatalog,
  isEnabled,
} = require('./keybindingCatalog');

test('catalog shape: frozen groups, unique contexts, every binding has keys + non-empty desc', () => {
  assert.ok(Object.isFrozen(KEYBINDING_CATALOG), 'the SSOT table must not be writable');
  assert.ok(KEYBINDING_CATALOG.length >= 7, `groups: ${KEYBINDING_CATALOG.length}`);
  const contexts = KEYBINDING_CATALOG.map((g) => g.context);
  assert.equal(new Set(contexts).size, contexts.length, 'context names are unique');
  for (const g of KEYBINDING_CATALOG) {
    assert.equal(typeof g.context, 'string');
    assert.equal(typeof g.label, 'string');
    assert.ok(Object.isFrozen(g.bindings), `${g.context}: bindings frozen`);
    assert.ok(g.bindings.length > 0, `${g.context}: has entries`);
    for (const b of g.bindings) {
      assert.equal(typeof b.keys, 'string');
      assert.ok(typeof b.desc === 'string' && b.desc.length > 0, `${g.context}/${b.keys}: desc`);
    }
  }
});

test('the honest boundary is encoded in the data, not promised away', () => {
  const editing = KEYBINDING_CATALOG.find((g) => g.context === 'editing');
  const byKey = new Map(editing.bindings.map((b) => [b.keys, b.desc]));
  assert.match(byKey.get('Ctrl + J'), /实测可用/, 'Ctrl+J is the proven LF path');
  assert.match(byKey.get('Shift + Enter'), /实测|同一字节/);
  assert.match(byKey.get('Ctrl + Enter'), /零字节/);
  assert.match(byKey.get('Alt + Enter'), /本机不可用/);
  assert.equal(byKey.get('Enter'), '发送消息', 'plain Enter is unambiguous and needs no caveat');
});

test('essential view is frozen tuples and comes from the same module', () => {
  assert.ok(Object.isFrozen(ESSENTIAL_SHORTCUTS));
  assert.equal(getEssentialShortcuts(), ESSENTIAL_SHORTCUTS, 'the getter hands out the SSOT, not a copy');
  ESSENTIAL_SHORTCUTS.forEach((t, i) => {
    assert.ok(Object.isFrozen(t), `tuple ${i} frozen`);
    assert.equal(t.length, 2, `tuple ${i} is [keys, desc]`);
    assert.equal(typeof t[0], 'string');
    assert.equal(typeof t[1], 'string');
  });
  // Measured count is 18 while the file comment says "只列最常用的 15 条" — registered as doc drift.
  assert.equal(ESSENTIAL_SHORTCUTS.length, 18, 'pinned so a future edit changes the comment too');
});

test('selectCatalog: no options is a structural copy of every group', () => {
  const all = selectCatalog();
  assert.deepEqual(all.map((g) => g.context), KEYBINDING_CATALOG.map((g) => g.context));
  assert.notEqual(all[0].bindings, KEYBINDING_CATALOG[0].bindings, 'inner arrays are copies');
  all[0].bindings.push({ keys: 'X', desc: 'mutated' });
  assert.equal(selectCatalog()[0].bindings.some((b) => b.keys === 'X'), false, 'mutation stayed local');
});

test('selectCatalog: context matches name or label, case and padding tolerant', () => {
  assert.deepEqual(selectCatalog({ context: 'vim' }).map((g) => g.context), ['vim']);
  assert.deepEqual(selectCatalog({ context: '  CHAT ' }).map((g) => g.context), ['chat']);
  assert.deepEqual(selectCatalog({ context: '补全菜单' }).map((g) => g.context), ['completion'],
    'labels are addressable too');
  assert.deepEqual(selectCatalog({ context: 'nope' }), []);
  assert.equal(selectCatalog({ context: null }).length, KEYBINDING_CATALOG.length);
});

test('selectCatalog: query filters within keys/desc/label and drops emptied groups', () => {
  const hit = selectCatalog({ query: '模型选择器' });
  assert.deepEqual(hit.map((g) => g.context), ['chat']);
  assert.equal(hit[0].bindings.length, 1);
  const multi = selectCatalog({ query: 'ctrl + ' });
  assert.ok(multi.length >= 3, `Ctrl+ appears in several groups (${multi.length})`);
  multi.forEach((g) => assert.ok(g.bindings.length > 0, 'no empty group survives'));
  assert.deepEqual(selectCatalog({ query: '不存在的东西' }), []);
});

test('selectCatalog: filters compose, and hostile options degrade to the full catalog', () => {
  assert.deepEqual(selectCatalog({ context: 'editing', query: '换行' }).map((g) => g.context), ['editing']);
  assert.deepEqual(selectCatalog({ context: 'global', query: '换行' }), [], 'intersection can be empty');
  for (const bad of [null, undefined, 'string', 42, []]) {
    assert.equal(selectCatalog(bad).length, KEYBINDING_CATALOG.length, String(bad));
  }
});

test('formatCatalog: group header, two-space indent, key column padded to the widest key', () => {
  const groups = [{
    context: 'x',
    label: '测试组',
    bindings: [{ keys: 'A', desc: 'one' }, { keys: 'LONGKEY', desc: 'two' }],
  }];
  const out = formatCatalog(groups);
  assert.equal(out, '【测试组】\n  A        one\n  LONGKEY  two', 'padEnd(max+2) alignment');
  assert.equal(formatCatalog([]), '', 'no groups → empty string');
  assert.equal(formatCatalog(null), '', 'null is not an error');
  assert.equal(formatCatalog([{ context: 'e', label: '空组', bindings: [] }]), '', 'empty groups are skipped');
});

test('formatCatalog: two groups are separated by exactly one blank line', () => {
  const out = formatCatalog([
    { context: 'a', label: '甲', bindings: [{ keys: 'K1', desc: 'd1' }] },
    { context: 'b', label: '乙', bindings: [{ keys: 'K2', desc: 'd2' }] },
  ]);
  assert.equal(out, '【甲】\n  K1  d1\n\n【乙】\n  K2  d2');
  assert.equal(out.includes('\x1B['), false, 'no ANSI colour in the pure renderer');
});

test('isEnabled: KHY_KEYBINDINGS default-on, off values close it', () => {
  assert.equal(isEnabled(), true, 'unset → on');
  assert.equal(isEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no', '', ' OFF ']) {
    assert.equal(isEnabled({ KHY_KEYBINDINGS: off }), false, `${String(off)} closes it`);
  }
  for (const on of ['1', 'true', 'on', 'anything']) {
    assert.equal(isEnabled({ KHY_KEYBINDINGS: on }), true, `${on} keeps it on`);
  }
  assert.equal(isEnabled({ KHY_KEYBINDINGS: 'yes' }), true);
  // Measured behaviour (pinned, not blessed): `isEnabled(undefined)` hits the
  // `env = {}` default parameter and reads ON, while `isEnabled(null)` is a real value
  // that short-circuits the `env &&` guard before the default-on string is reached —
  // so null degrades to OFF. Asymmetric, and callers must pass an object to be safe.
  assert.equal(isEnabled(null), false, 'null env degrades to off (no default parameter applied)');
  assert.equal(isEnabled(undefined), true, 'undefined triggers the env={} default → on');
});

test('the leaf reads neither fs nor env directly (purity lock on the source text)', () => {
  const src = require('node:fs').readFileSync(require.resolve('./keybindingCatalog'), 'utf8');
  // Strip block comments (including single-line `/** … */`) and line comments first —
  // the header prose deliberately talks about process.env.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\*.*$/gm, '');
  assert.ok(!code.includes('process.env'), 'env arrives only through isEnabled(env)');
  assert.ok(!/writeFileSync|openSync|spawn|execFile/.test(code), 'zero IO in the catalog leaf');
  assert.match(code, /require\('\.\.\/\.\.\/\.\.\/\.\.\/utils\/isOffValue'\)/,
    'the off-value judgement is delegated to the D3 single source');
});
