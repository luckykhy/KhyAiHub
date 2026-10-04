'use strict';

/**
 * entityRegistry.test.js — co-located unit test for entityRegistry.js (D2 unit
 * structuredFurnace). Pure node:test, synchronous, zero I/O.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { EntityRegistry, _normalize } = require('./entityRegistry');

test('module surface is exactly the class plus the private normalizer', () => {
  assert.deepEqual(Object.keys(require('./entityRegistry')), ['EntityRegistry', '_normalize']);
});

test('a fresh registry is empty on every read surface', () => {
  const r = new EntityRegistry();
  assert.deepEqual(r.list(), []);
  assert.deepEqual(r.pointerTable(), {});
  assert.equal(r.deduplicatedCount(), 0);
  assert.equal(r.get('nope'), null);
  assert.equal(r.has('nope'), false);
});

test('mint returns a prefixed, content-addressed uid and stores the node', () => {
  const r = new EntityRegistry();
  const uid = r.mint('file', 'a.js');
  assert.match(uid, /^file_[0-9a-f]{8}$/);
  assert.deepEqual(r.get(uid), {
    uid,
    type: 'file',
    canonical: 'a.js',
    attrs: {},
    mentions: 1,
  });
  assert.equal(r.has(uid), true);
});

test('uid is content-addressed, not time- or random-based (two registries agree)', () => {
  const a = new EntityRegistry();
  const b = new EntityRegistry();
  assert.equal(a.mint('file', 'a.js'), b.mint('file', 'a.js'));
});

test('a repeated description reuses the node and only counts the mention', () => {
  const r = new EntityRegistry();
  const u1 = r.mint('file', 'a.js');
  const u2 = r.mint('file', 'a.js');
  assert.equal(u1, u2);
  assert.equal(r.list().length, 1);
  assert.equal(r.get(u1).mentions, 2);
  assert.equal(r.deduplicatedCount(), 1);
});

test('the dedupe key is normalized, so filler/punctuation do not fork a node', () => {
  const r = new EntityRegistry();
  const a = r.mint('file', '  a.js  ');
  const b = r.mint('file', 'a.js！');
  const c = r.mint('file', '那个 a.js');
  assert.equal(a, b);
  assert.equal(a, c);
  assert.equal(r.get(a).mentions, 3);
});

// B31-F6: FILLER_RE (entityRegistry.js:21) has no word boundary on its
// single-letter English alternatives (`a` above all), so letters are deleted from
// inside ASCII words before the key is built. Two DIFFERENT files then share one
// topology node, and `canonical` stays frozen to whichever was minted first —
// i.e. the second file's identity is silently replaced by the first one's.
// This is a wrong-pointer risk for DELETE/MOVE actions, and deduplicatedCount()
// reports the collision as a dedupe "saving".
test('B31-F6 two distinct filenames collapse into one node (current, wrong)', () => {
  assert.equal(_normalize('app.js'), _normalize('pp.js'));
  const r = new EntityRegistry();
  const app = r.mint('file', 'app.js');
  const pp = r.mint('file', 'pp.js');
  assert.equal(app, pp);
  assert.equal(r.list().length, 1);
  assert.equal(r.get(app).canonical, 'app.js');
  assert.equal(r.get(app).mentions, 2);
  assert.equal(r.deduplicatedCount(), 1);
  // Realistic pair: api.js vs pi.js.
  const r2 = new EntityRegistry();
  assert.equal(r2.mint('file', 'api.js'), r2.mint('file', 'pi.js'));
  // Letters are eaten anywhere, not only at word starts.
  assert.equal(_normalize('cat.js'), 'c t js');
  assert.equal(_normalize('flag.js'), 'fl g js');
});

test('attrs merge keeps existing values (later mentions only fill gaps)', () => {
  const r = new EntityRegistry();
  const uid = r.mint('file', 'a.js', { size: 10, owner: 'me' });
  r.mint('file', 'a.js', { size: 99, extra: true });
  assert.deepEqual(r.get(uid).attrs, { size: 10, owner: 'me', extra: true });
});

test('type is part of the key, so the same text under two types forks', () => {
  const r = new EntityRegistry();
  const asFile = r.mint('file', 'report doc');
  const asTopic = r.mint('topic', 'report doc');
  assert.notEqual(asFile, asTopic);
  assert.equal(r.list().length, 2);
});

test('missing or falsy type degrades to "entity" with the ent_ prefix', () => {
  const r = new EntityRegistry();
  const uid = r.mint(null, 'whatever');
  assert.match(uid, /^ent_[0-9a-f]{8}$/);
  assert.equal(r.get(uid).type, 'entity');
});

test('empty description still mints (canonical "") — see forgeSchema B31-F11', () => {
  const r = new EntityRegistry();
  const uid = r.mint('topic', '');
  assert.equal(r.get(uid).canonical, '');
  assert.equal(r.get(uid).type, 'topic');
});

test('uid prefixes cover every documented category and fall back to ent_', () => {
  const cases = [
    ['file', 'file'],
    ['File', 'file'],
    ['url', 'url'],
    ['link', 'url'],
    ['process', 'proc'],
    ['proc', 'proc'],
    ['variable', 'var'],
    ['topic', 'topic'],
    ['actor', 'actor'],
    ['user', 'actor'],
    ['widget', 'ent'],
    ['', 'ent'],
  ];
  for (const [type, prefix] of cases) {
    const r = new EntityRegistry();
    const uid = r.mint(type, `desc-${prefix}-${type}`);
    assert.ok(uid.startsWith(`${prefix}_`), `type ${JSON.stringify(type)} -> ${uid}`);
  }
});

test('list() and pointerTable() expose insertion order of the uid map', () => {
  const r = new EntityRegistry();
  const u1 = r.mint('file', 'one.js');
  const u2 = r.mint('file', 'two.js');
  assert.deepEqual(Object.keys(r.pointerTable()), [u1, u2]);
  assert.deepEqual(r.pointerTable(), { [u1]: 'one.js', [u2]: 'two.js' });
  assert.deepEqual(r.list().map((e) => e.uid), [u1, u2]);
});

test('deduplicatedCount sums only the extra mentions', () => {
  const r = new EntityRegistry();
  const a = r.mint('file', 'a.js');
  r.mint('file', 'a.js');
  r.mint('file', 'a.js');
  r.mint('file', 'b.js');
  assert.equal(r.deduplicatedCount(), 2);
  assert.equal(r.get(a).mentions, 3);
});

test('the entity objects handed out by list() are the live nodes (no copy)', () => {
  const r = new EntityRegistry();
  const uid = r.mint('file', 'a.js');
  r.list()[0].mentions = 99;
  assert.equal(r.get(uid).mentions, 99);
});

test('_normalize lowercases, strips filler words, punctuation and outer space', () => {
  assert.equal(_normalize('The  Report, v2!'), 'report v2');
  assert.equal(_normalize(undefined), '');
  assert.equal(_normalize(null), '');
  assert.equal(_normalize(0), '');
  assert.equal(_normalize('请帮我看看'), '看看');
});
