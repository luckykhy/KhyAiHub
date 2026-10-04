'use strict';

/**
 * Co-located tests for commandCatalog.js — the /features + GET /api/commands directory leaf.
 * Zero IO: everything runs through the documented deps/env injection seams.
 */

const test = require('node:test');
const assert = require('node:assert');

const leaf = require('./commandCatalog');
const { commandCatalogEnabled, buildCommandCatalog, CATEGORY_META } = leaf;

const LIST = [
  { cmd: '/cron', label: 'Cron', desc: 'schedule things', route: 'cron', category: 'workflow' },
  { cmd: '/schedule', label: 'Sched', desc: 'alias entry', route: 'cron', category: 'workflow' },
  { cmd: '/apikeyx', desc: 'key admin', route: 'gateway config', category: 'security' },
  { cmd: '/status', description: 'fallback desc field', route: 'status', category: 'nonexistent-cat' },
];

const NOFOLD = { KHY_COMMAND_PRIMARY_PANEL: 'off' };

function deps(list = LIST) {
  return { getBuiltinSlashCommands: () => list };
}

// ── gate ───────────────────────────────────────────────────────────────

test('gate is default-on and only the documented off-words disable it', () => {
  assert.strictEqual(commandCatalogEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no', 'disable', 'disabled']) {
    assert.strictEqual(commandCatalogEnabled({ KHY_COMMAND_CATALOG: off }), false, off);
    assert.strictEqual(commandCatalogEnabled({ KHY_COMMAND_CATALOG: `  ${off.toUpperCase()}  ` }), false, off);
  }
  assert.strictEqual(commandCatalogEnabled({ KHY_COMMAND_CATALOG: 'anything-else' }), true);
});

test('gate treats absent/blank/whitespace as on and never throws on a bad env', () => {
  for (const v of [undefined, '', '   ', null]) {
    assert.strictEqual(commandCatalogEnabled({ KHY_COMMAND_CATALOG: v }), true, String(v));
  }
  assert.strictEqual(commandCatalogEnabled(null), true);
  assert.strictEqual(commandCatalogEnabled(undefined), true);
  // non-string primitives go through `|| ''`, so they read as "unset" → on
  assert.strictEqual(commandCatalogEnabled({ KHY_COMMAND_CATALOG: false }), true);
  assert.strictEqual(commandCatalogEnabled({ KHY_COMMAND_CATALOG: 0 }), true);
});

// ── buildCommandCatalog: shape and grouping ────────────────────────────

test('a disabled gate returns the empty directory, byte-for-byte the documented shape', () => {
  assert.deepStrictEqual(buildCommandCatalog(deps(), { KHY_COMMAND_CATALOG: 'off' }), {
    categories: [],
    total: 0,
    generatedBy: 'commandSchema',
  });
});

test('categories sort by CATEGORY_META.order then key, commands sort by cmd', () => {
  const out = buildCommandCatalog(deps(), NOFOLD);
  assert.deepStrictEqual(out.categories.map((c) => c.key), ['workflow', 'security', 'nonexistent-cat']);
  assert.deepStrictEqual(out.categories[0].commands.map((c) => c.cmd), ['/cron', '/schedule']);
  assert.strictEqual(out.total, 4);
  assert.strictEqual(out.categories.reduce((n, c) => n + c.commands.length, 0), out.total);
});

test('each entry is normalized to the discovery minimum', () => {
  const out = buildCommandCatalog(deps(), NOFOLD);
  const cron = out.categories[0].commands[0];
  assert.deepStrictEqual(Object.keys(cron).sort(), ['cmd', 'desc', 'label', 'name', 'route']);
  assert.strictEqual(cron.name, 'cron');
  assert.strictEqual(cron.label, 'Cron');
  assert.strictEqual(cron.desc, 'schedule things');
});

test('label falls back to the slash-stripped name and desc falls back to description', () => {
  const out = buildCommandCatalog(deps(), NOFOLD);
  const status = out.categories[2].commands[0];
  assert.strictEqual(status.label, 'status');
  assert.strictEqual(status.desc, 'fallback desc field');
  const noDesc = buildCommandCatalog(deps([{ cmd: '/bare', route: 'bare', category: 'system' }]), NOFOLD);
  assert.strictEqual(noDesc.categories[0].commands[0].desc, '');
});

test('unknown categories land in the 其他 bucket with order 99', () => {
  const out = buildCommandCatalog(deps(), NOFOLD);
  const other = out.categories[out.categories.length - 1];
  assert.strictEqual(other.key, 'nonexistent-cat');
  assert.strictEqual(other.label, CATEGORY_META.other.label);
  assert.strictEqual(other.order, CATEGORY_META.other.order);
});

test('a category named after an Object.prototype key still falls back to 其他', () => {
  // B26-F1: `CATEGORY_META[cat] || other` used to return the inherited value for
  // cat = 'constructor'/'valueOf'/'toString', yielding {label: undefined, order: undefined}.
  const out = buildCommandCatalog(deps([{ cmd: '/x', route: 'x', category: 'constructor' }]), NOFOLD);
  assert.strictEqual(out.categories.length, 1);
  assert.strictEqual(out.categories[0].label, CATEGORY_META.other.label);
  assert.strictEqual(out.categories[0].order, CATEGORY_META.other.order);
});

test('junk entries are skipped rather than thrown on', () => {
  const out = buildCommandCatalog(deps([
    null,
    'not-an-object',
    42,
    { cmd: '   ' },
    { cmd: '/' },
    { cmd: '//' },
    { cmd: '/ok', route: 'ok', category: 'dev' },
  ]), NOFOLD);
  assert.strictEqual(out.total, 1);
  assert.strictEqual(out.categories[0].commands[0].cmd, '/ok');
});

test('duplicate cmd within a category is folded to the first occurrence', () => {
  const out = buildCommandCatalog(deps([
    { cmd: '/dup', desc: 'first', route: 'a', category: 'dev' },
    { cmd: '/dup', desc: 'second', route: 'b', category: 'dev' },
  ]), NOFOLD);
  assert.strictEqual(out.total, 1);
  assert.strictEqual(out.categories[0].commands[0].desc, 'first');
});

// ── alias folding (KHY_COMMAND_PRIMARY_PANEL, real alias SSOT) ─────────

test('panel on drops the alias row and hangs it under the canonical command', () => {
  const on = buildCommandCatalog(deps(), { KHY_COMMAND_PRIMARY_PANEL: 'on' });
  // '/schedule' is a real SSOT alias of route 'cron'; '/apikey' is the canonical's own row here.
  assert.strictEqual(on.total, 3);
  assert.strictEqual(on.categories.some((c) => c.commands.some((x) => x.cmd === '/schedule')), false);
  const cron = on.categories[0].commands.find((x) => x.cmd === '/cron');
  assert.deepStrictEqual(cron.aliases, ['/schedule']);
});

test('panel off keeps every row and adds no aliases field (byte-for-byte fallback)', () => {
  const off = buildCommandCatalog(deps(), NOFOLD);
  assert.strictEqual(off.total, 4);
  for (const c of off.categories) {
    for (const cmd of c.commands) {
      assert.strictEqual('aliases' in cmd, false, cmd.cmd);
    }
  }
});

test('folding is route-driven, so an alias joins the canonical row even under another cmd', () => {
  // '/apikey' is a real SSOT alias of route 'gateway config'; the injected row uses that route.
  const out = buildCommandCatalog(deps(), { KHY_COMMAND_PRIMARY_PANEL: 'on' });
  const key = out.categories[1].commands[0];
  assert.strictEqual(key.cmd, '/apikeyx');
  assert.deepStrictEqual(key.aliases, ['/apikey']);
});

test('the real SSOT builds a non-empty directory with every label resolved', () => {
  const real = buildCommandCatalog({}, {});
  assert.ok(real.categories.length > 0);
  assert.ok(real.total > 0);
  for (const c of real.categories) {
    assert.strictEqual(typeof c.label, 'string');
    assert.ok(c.label.length > 0, c.key);
    assert.strictEqual(Number.isInteger(c.order), true, c.key);
    assert.strictEqual(c.commands.length > 0, true, c.key);
  }
  assert.strictEqual(real.categories.reduce((n, c) => n + c.commands.length, 0), real.total);
});

test('an unresolvable command source yields the empty directory, not a throw', () => {
  assert.strictEqual(
    buildCommandCatalog({ getBuiltinSlashCommands: () => null }, NOFOLD).total,
    0,
  );
  assert.strictEqual(
    buildCommandCatalog({ getBuiltinSlashCommands: () => { throw new Error('boom'); } }, NOFOLD).total,
    0,
  );
});
