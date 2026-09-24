'use strict';

// #18 (audit round 15b): Tab completion must never hide a verb the dispatcher
// already accepts. The static SUB_COMMANDS snapshot misses (a) manifest verbs of
// commands already keyed in ROUTER_SUB_COMMANDS (merge guard `!out[def.name]`),
// (b) manifest-only commands registered after require time, and (c) camelCase
// alias canonicals (`selfheal` → 'selfHeal' vs lowercase keys) — while
// commandAutoRegistry._alignSubCommand dispatches all of them. Before the fix,
// 6 commands hid 16 verbs from Tab; evidence:
// .khy/feedback/tab-completion-union-round15/repro-before.txt.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const BE = path.join(__dirname, '..', '..');
const router = require(path.join(BE, 'src/cli/router'));
const registry = require(path.join(BE, 'src/cli/commandAutoRegistry'));
const unionLeaf = require(path.join(BE, 'src/cli/completionManifestUnion'));

function verbsFor(typed) {
  return router.getCompletions(`${typed} `).map((s) => s.slice(typed.length + 1));
}

test('floor: registry really declares manifest verbs (probe is not blind)', () => {
  const withVerbs = registry
    .getCompletions()
    .filter((e) => Array.isArray(e.subCommands) && e.subCommands.length > 0);
  assert.ok(withVerbs.length >= 20, `expected 20+ verb-declaring commands, got ${withVerbs.length}`);
});

test('no manifest verb stays hidden from Tab (whole-registry sweep)', () => {
  for (const e of registry.getCompletions()) {
    if (!Array.isArray(e.subCommands) || !e.subCommands.length) continue;
    const got = verbsFor(e.name);
    for (const v of e.subCommands) {
      assert.ok(got.includes(v), `${e.name} hides manifest verb "${v}" from Tab`);
    }
  }
});

test('#18 the six measured commands complete their previously-hidden verbs', () => {
  const expect = {
    backup: ['new', 'ls', 'check', 'clean'],
    project: ['analysis', 'struct', 'mini', 'find', 'search'],
    selfheal: ['status', 'index', 'test'], // camelCase canonical 'selfHeal' path
    metadata: ['help'],
    proxy: ['core'],
    maintain: ['bare'],
  };
  for (const [cmd, verbs] of Object.entries(expect)) {
    const got = verbsFor(cmd);
    for (const v of verbs) {
      assert.ok(got.includes(v), `${cmd} still hides ${v}`);
    }
  }
});

test('gate-off is byte-identical to the legacy static-table behavior', () => {
  const staticTable = require(path.join(BE, 'src/constants/commandSchema')).getRouterSubCommands();
  const aliases = require(path.join(BE, 'src/cli/aliases'));
  const before = process.env.KHY_COMPLETION_MANIFEST_UNION;
  process.env.KHY_COMPLETION_MANIFEST_UNION = 'off';
  try {
    for (const cmd of Object.keys(staticTable)) {
      const al = aliases.resolveAlias(cmd);
      // Keys whose alias canonical differs (selfheal → 'selfHeal') are exactly
      // the legacy-blind case: legacy looked up the camelCase key, missed, and
      // printed []. Asserting identity for them would demand legacy to equal a
      // table it never consulted — checked explicitly after the loop instead.
      if (al && al.command !== cmd) continue;
      assert.deepStrictEqual(
        router.getCompletions(`${cmd} `),
        staticTable[cmd].map((s) => `${cmd} ${s}`),
        `gate-off drifted for ${cmd}`
      );
    }
    assert.deepStrictEqual(router.getCompletions('selfheal '), [], 'legacy kept selfheal empty');
  } finally {
    if (before === undefined) delete process.env.KHY_COMPLETION_MANIFEST_UNION;
    else process.env.KHY_COMPLETION_MANIFEST_UNION = before;
  }
});

test('unknown command still completes to nothing; prefix filter intact', () => {
  assert.deepStrictEqual(router.getCompletions('zzxcmdnotreal '), []);
  assert.ok(router.getCompletions('backup ').includes('backup check'));
  const prefixed = router.getCompletions('backup c');
  assert.ok(prefixed.length > 0, 'prefix query returned nothing (probe blind, not a pass)');
  for (const item of prefixed) {
    assert.ok(item.startsWith('backup c'), `prefix leaked ${item}`);
  }
});

test('union leaf: dedup, static-first, tolerant of missing sides, never throws', () => {
  assert.deepStrictEqual(unionLeaf.union(['a', 'b'], ['b', 'c']), ['a', 'b', 'c']);
  assert.deepStrictEqual(unionLeaf.union(undefined, ['x']), ['x']);
  assert.deepStrictEqual(unionLeaf.union(['x'], undefined), ['x']);
  assert.deepStrictEqual(unionLeaf.union(undefined, undefined), []);
  assert.deepStrictEqual(unionLeaf.union(null, { nope: 1 }), []);
  assert.equal(unionLeaf.isEnabled({}), true);
  assert.equal(unionLeaf.isEnabled({ KHY_COMPLETION_MANIFEST_UNION: 'off' }), false);
  assert.equal(unionLeaf.isEnabled({ KHY_COMPLETION_MANIFEST_UNION: 'ON' }), true);
});
