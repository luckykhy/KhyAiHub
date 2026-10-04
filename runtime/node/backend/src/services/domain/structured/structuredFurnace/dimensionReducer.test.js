'use strict';

/**
 * dimensionReducer.test.js — co-located unit test for dimensionReducer.js (D2 unit
 * structuredFurnace). Pure node:test, synchronous, zero I/O: every target is minted
 * into a caller-supplied EntityRegistry, no path is touched.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  reduce,
  reduceClause,
  mapActionVerb,
  extractTarget,
  strategyForActions,
  RISKY_ACTIONS,
  _uid,
} = require('./dimensionReducer');
const { EntityRegistry } = require('./entityRegistry');
const S = require('../../project/metaplan/constraintStrategy');

test('module surface: six documented entries plus the uid helper', () => {
  assert.deepEqual(Object.keys(require('./dimensionReducer')), [
    'reduce',
    'reduceClause',
    'mapActionVerb',
    'extractTarget',
    'strategyForActions',
    'RISKY_ACTIONS',
    '_uid',
  ]);
});

test('mapActionVerb covers one primitive per VERB_MAP row', () => {
  const cases = [
    ['新建一个模块', 'CREATE'],
    ['create a module', 'CREATE'],
    ['删除 a.js', 'DELETE'],
    ['rm a.js', 'DELETE'],
    ['修改配置', 'UPDATE'],
    ['移动文件', 'MOVE'],
    ['mv a b', 'MOVE'],
    ['复制一份', 'COPY'],
    ['cp a b', 'COPY'],
    ['搜索关键字', 'SEARCH'],
    ['grep foo', 'SEARCH'],
    ['分析这段日志', 'ANALYZE'],
    ['review the patch', 'ANALYZE'],
    ['运行一次', 'EXECUTE'],
    ['execute it', 'EXECUTE'],
    ['构建项目', 'BUILD'],
    ['compile now', 'BUILD'],
    ['跑测试', 'TEST'],
    ['部署上线', 'DEPLOY'],
    ['publish it', 'DEPLOY'],
    ['通知我', 'NOTIFY'],
    ['alert me', 'NOTIFY'],
    ['等待结果', 'WAIT'],
    ['hold on', 'WAIT'],
    ['下载数据集', 'FETCH'],
    ['pull the image', 'FETCH'],
    ['总结一下', 'SUMMARIZE'],
    ['summarize this', 'SUMMARIZE'],
    ['读取文件', 'READ'],
    ['cat a.js', 'READ'],
  ];
  for (const [text, action] of cases) {
    assert.equal(mapActionVerb(text), action, text);
  }
});

test('an unmapped verb becomes UNKNOWN instead of an invented action', () => {
  assert.equal(mapActionVerb('把 a.js 熨一下'), 'UNKNOWN');
  assert.equal(mapActionVerb(''), 'UNKNOWN');
});

// B31-F2: dimensionReducer.js:21 claims the table is ordered "靠前的更具体，命中即停",
// but CREATE is row 0 and DELETE row 1, so any clause that mentions both comes back
// as CREATE with the destructive half dropped — and CREATE is NOT in RISKY_ACTIONS,
// so "删除并创建 a.js" is sealed as a Prompt_Soft (lightest lock) intent whose only
// recorded action is the harmless one. A later row can never win.
test('B31-F2 a compound clause keeps CREATE and drops DELETE, with the lightest lock (current, wrong)', () => {
  assert.equal(mapActionVerb('删除并创建 a.js'), 'CREATE');
  assert.equal(mapActionVerb('先删除再创建 a.js'), 'CREATE');
  const p = reduce('删除并创建 a.js');
  assert.equal(p.action, 'CREATE');
  assert.equal(p.strategy, S.STRATEGIES.PROMPT_SOFT);
  assert.equal(p.confidence, 1, 'the lost verb does not even lower confidence');
});

test('RISKY_ACTIONS is the documented six-member set', () => {
  assert.ok(RISKY_ACTIONS instanceof Set);
  assert.deepEqual([...RISKY_ACTIONS].sort(), ['BUILD', 'DELETE', 'DEPLOY', 'EXECUTE', 'MOVE', 'UPDATE']);
});

test('strategyForActions escalates to CODE_HARD for any risky member', () => {
  assert.equal(strategyForActions(['READ', 'DELETE']), S.STRATEGIES.CODE_HARD);
  assert.equal(strategyForActions(['READ']), S.STRATEGIES.PROMPT_SOFT);
  assert.equal(strategyForActions([]), S.STRATEGIES.PROMPT_SOFT);
  assert.equal(strategyForActions(['UNKNOWN']), S.STRATEGIES.PROMPT_SOFT);
});

test('extractTarget prefers a file token over every other shape', () => {
  const r = new EntityRegistry();
  const uid = extractTarget('看看 src/a.spec.js 吧', r);
  assert.match(uid, /^file_/);
  assert.equal(r.get(uid).canonical, 'src/a.spec.js');
});

// B31-F17: the file-token regex (dimensionReducer.js:60) runs BEFORE the URL branch
// (:70), so any URL whose path ends in an extension is registered as type 'file'
// with the scheme cut off, and a bare version number is registered as a file too.
// entityRegistry.js:40 advertises `url` as a first-class type and _uidPrefix maps it
// to `url_`, so the envelope carries a mis-typed pointer whose canonical string is
// not usable as a URL.
test('B31-F17 a URL becomes a "file" entity without its scheme (current, wrong)', () => {
  const r = new EntityRegistry();
  const uid = extractTarget('获取 https://target.invalid/a.js', r);
  assert.equal(r.get(uid).type, 'file');
  assert.equal(r.get(uid).canonical, '//target.invalid/a.js');
  assert.equal(r.list().length, 1, 'the dedicated URL branch never runs');
  const v = new EntityRegistry();
  const vuid = extractTarget('更新版本号 2.10 一下', v);
  assert.equal(v.get(vuid).type, 'file');
  assert.equal(v.get(vuid).canonical, '2.10');
});

test('a scheme-less URL is still mis-typed as a file', () => {
  const r = new EntityRegistry();
  const uid = extractTarget('抓取 target.invalid/feed.atom', r);
  assert.equal(r.get(uid).type, 'file');
});

test('quoted objects become topic entities and keep their inner text verbatim', () => {
  const r = new EntityRegistry();
  const uid = extractTarget('分析 "季度报表" 一下', r);
  assert.equal(r.get(uid).type, 'topic');
  assert.equal(r.get(uid).canonical, '季度报表');
  const cjk = new EntityRegistry();
  assert.equal(cjk.get(extractTarget('分析「季度报表」', cjk)).canonical, '季度报表');
});

test('the url branch survives only for a dot-free host', () => {
  const bare = new EntityRegistry();
  const buid = extractTarget('访问 http://intranet:8080/status', bare);
  assert.equal(bare.get(buid).type, 'url');
  assert.equal(bare.get(buid).canonical, 'http://intranet:8080/status');
  // Any dotted host is grabbed by the file-token branch first (see B31-F17).
  const dotted = new EntityRegistry();
  assert.equal(dotted.get(extractTarget('访问 http://intranet.example:8080/status', dotted)).type, 'file');
});

test('the topic fallback strips one leading politeness prefix and keeps the rest', () => {
  const r = new EntityRegistry();
  const uid = extractTarget('请熨一下这个', r);
  assert.equal(r.get(uid).type, 'topic');
  assert.equal(r.get(uid).canonical, '熨一下这个', 'FILLER_RE is anchored, so only the leading prefix goes');
});

test('the fallback truncates at 40 characters and falls back to the raw text', () => {
  const r = new EntityRegistry();
  const long = '熨 ' + '字'.repeat(60);
  const uid = extractTarget(long, r);
  assert.ok(r.get(uid).canonical.length <= 40, `len=${r.get(uid).canonical.length}`);
});

test('an unextractable clause mints the <unspecified> placeholder topic', () => {
  const r = new EntityRegistry();
  const uid = extractTarget('   ', r);
  assert.equal(r.get(uid).type, 'topic');
  assert.equal(r.get(uid).canonical, '<unspecified>');
});

test('_uid is a deterministic prefix plus 8 hex chars', () => {
  assert.match(_uid('ai', 'x'), /^ai_[0-9a-f]{8}$/);
  assert.equal(_uid('ai', 'same text'), _uid('ai', 'same text'));
  assert.notEqual(_uid('ai', 'a'), _uid('ai', 'b'));
  assert.equal(_uid('ai', null), _uid('ai', 'null'), 'non-strings are stringified first');
  assert.equal(_uid('tg', 12), _uid('tg', '12'));
});

test('reduceClause returns the node skeleton with a uid pointer, not a description', () => {
  const r = new EntityRegistry();
  const c = reduceClause('请删除 a.js', r);
  assert.deepEqual(c, { action: 'DELETE', target: { uid: r.mint('file', 'a.js') }, params: {}, confidence: 1 });
  assert.equal(c.params.constructor, Object, 'params is always the empty object today');
});

test('reduceClause strips politeness prefixes before mapping the verb', () => {
  const r = new EntityRegistry();
  assert.equal(reduceClause('please can you read a.txt', r).action, 'READ');
  assert.equal(reduceClause('i want to build it', r).action, 'BUILD');
});

test('reduce builds a complete ActionIntent with a content-addressed uid', () => {
  const p = reduce('读取 src/a.js');
  assert.deepEqual(Object.keys(p), ['kind', 'uid', 'action', 'target', 'params', 'confidence', 'strategy', 'entities']);
  assert.equal(p.kind, 'ActionIntent');
  assert.match(p.uid, /^ai_[0-9a-f]{8}$/);
  assert.equal(p.action, 'READ');
  assert.equal(p.strategy, S.STRATEGIES.PROMPT_SOFT);
  assert.equal(p.entities[p.target.uid].canonical, 'src/a.js');
  assert.equal(reduce('读取 src/a.js').uid, p.uid, 'same input, same uid');
});

test('reduce passes the target uid through the same registry it was given', () => {
  const r = new EntityRegistry();
  const first = reduce('删除 a.js', r);
  const second = reduce('读取 a.js', r);
  assert.equal(first.target.uid, second.target.uid, 'entity dedupe across calls');
  assert.equal(r.get(first.target.uid).mentions, 2);
});

// B31-F1: a reused registry leaks earlier entities into the next payload — reduce()
// snapshots `registry.list()` (dimensionReducer.js:115-117), so the second
// ActionIntent carries the first one's entity nodes while pointing at only one of
// them. Not a correctness break for the schema (pointer integrity still holds), but
// the envelope's `entities` surface grows with every call that shares a registry.
test('a shared registry accumulates entities into every later payload', () => {
  const r = new EntityRegistry();
  reduce('删除 a.js', r);
  const second = reduce('读取 b.js', r);
  assert.equal(Object.keys(second.entities).length, 2);
  assert.equal(second.target.uid, r.mint('file', 'b.js'));
});

test('reduce normalizes an out-of-table action back to UNKNOWN', () => {
  // reduceClause can only ever emit table members or UNKNOWN, so the guard at
  // dimensionReducer.js:121 is unreachable from inside — pinned here for the record.
  assert.equal(reduce('熨一下 a.js').action, 'UNKNOWN');
});
