'use strict';

/**
 * forgeSchema.test.js — co-located unit test for forgeSchema.js (D2 unit
 * structuredFurnace). Pure node:test, synchronous, zero I/O.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ACTION_PRIMITIVES,
  VAGUE_RE,
  coerceVagueness,
  isAtomic,
  hasRelativeClause,
  validate,
  validateActionIntent,
  validateTaskGraph,
  validateStateMachine,
} = require('./forgeSchema');
const S = require('../../project/metaplan/constraintStrategy');

const intent = (over = {}) => ({
  kind: 'ActionIntent',
  uid: 'ai_1',
  action: 'READ',
  target: { uid: 'file_1' },
  params: {},
  confidence: 1,
  strategy: S.STRATEGIES.PROMPT_SOFT,
  entities: { file_1: { uid: 'file_1', type: 'file', canonical: 'a.js', attrs: {}, mentions: 1 } },
  ...over,
});

const graph = (over = {}) => ({
  kind: 'TaskGraph',
  uid: 'tg_1',
  graph: {
    nodes: [
      { uid: 'n1', action: 'READ', target: { uid: 'file_1' } },
      { uid: 'n2', action: 'DELETE', target: { uid: 'file_1' } },
    ],
    edges: [{ from: 'n1', to: 'n2', type: 'seq' }],
  },
  entities: { file_1: { uid: 'file_1', type: 'file', canonical: 'a.js', attrs: {}, mentions: 1 } },
  strategy: S.STRATEGIES.CODE_HARD,
  ...over,
});

const machine = (over = {}) => ({
  kind: 'StateMachine',
  uid: 'sm_1',
  machine: {
    initial: 's1',
    states: [{ uid: 's1', name: 'READ:file_1' }, { uid: 's2', name: 'DELETE:file_1' }],
    transitions: [{ from: 's1', to: 's2', on: 'next', confidence: 1 }],
  },
  entities: { file_1: { uid: 'file_1', type: 'file', canonical: 'a.js', attrs: {}, mentions: 1 } },
  strategy: S.STRATEGIES.PROMPT_SOFT,
  ...over,
});

test('module surface is the nine documented entries', () => {
  assert.deepEqual(Object.keys(require('./forgeSchema')), [
    'ACTION_PRIMITIVES',
    'VAGUE_RE',
    'coerceVagueness',
    'isAtomic',
    'hasRelativeClause',
    'validate',
    'validateActionIntent',
    'validateTaskGraph',
    'validateStateMachine',
  ]);
});

test('ACTION_PRIMITIVES is frozen and closes with UNKNOWN', () => {
  assert.ok(Object.isFrozen(ACTION_PRIMITIVES));
  assert.equal(ACTION_PRIMITIVES.length, 17);
  assert.equal(ACTION_PRIMITIVES[16], 'UNKNOWN');
  assert.ok(ACTION_PRIMITIVES.includes('CREATE'));
  assert.ok(!ACTION_PRIMITIVES.includes('WRITE'));
});

test('a happy-path payload passes and comes back as `normalized` (identity, not copy)', () => {
  const p = intent();
  const r = validateActionIntent(p);
  assert.deepEqual(r, { valid: true, normalized: p });
  assert.equal(r.normalized, p);
});

test('ActionIntent: kind gate comes first and carries no missing list', () => {
  assert.deepEqual(validateActionIntent(null), { valid: false, error: 'kind 必须为 ActionIntent' });
  assert.deepEqual(validateActionIntent({ kind: 'TaskGraph' }), { valid: false, error: 'kind 必须为 ActionIntent' });
  assert.equal('missing' in validateActionIntent({}), false);
});

test('ActionIntent: every required element is named in `missing`', () => {
  const r = validateActionIntent(
    intent({ uid: '', action: 'FLY', target: {}, confidence: 'high' }),
  );
  assert.equal(r.valid, false);
  assert.equal(r.error, 'ActionIntent 要素缺失');
  assert.deepEqual(r.missing, ['uid', 'action(必须是标准动作原语)', 'target.uid(目标实体指针)', 'confidence']);
});

test('ActionIntent: UNKNOWN is a legal action, so an unmapped verb passes the schema', () => {
  // See B31-F1 — the schema gate deliberately accepts the sentinel; the degrade the
  // collapse layer promises for it is never applied by anomalyHandler.
  assert.equal(validateActionIntent(intent({ action: 'UNKNOWN' })).valid, true);
});

test('ActionIntent: strategy must be a constraintStrategy enum member', () => {
  assert.equal(validateActionIntent(intent({ strategy: 'soft' })).valid, false);
  assert.match(validateActionIntent(intent({ strategy: 'soft' })).error, /strategy 非法/);
  assert.equal(validateActionIntent(intent({ strategy: undefined })).valid, false);
  assert.equal(validateActionIntent(intent({ strategy: S.STRATEGIES.SYSTEM_BLOCK })).valid, true);
});

test('ActionIntent: params values are checked for vagueness, clauses and atomicity', () => {
  assert.match(validateActionIntent(intent({ params: { note: '可能会失败' } })).error, /含模糊词/);
  assert.match(validateActionIntent(intent({ params: { note: 'the report that shipped' } })).error, /定语从句/);
  assert.match(validateActionIntent(intent({ params: { note: '备份，然后清理' } })).error, /非原子/);
  assert.equal(validateActionIntent(intent({ params: { note: '备份' } })).valid, true);
  // Non-string values are atomic by definition (forgeSchema.js:76-78).
  assert.equal(validateActionIntent(intent({ params: { n: 3, o: { a: 1 }, arr: ['x，y'] } })).valid, true);
});

test('ActionIntent: the target pointer must resolve inside the entity table', () => {
  const r = validateActionIntent(intent({ target: { uid: 'ghost' } }));
  assert.equal(r.valid, false);
  assert.match(r.error, /悬空指针/);
});

test('entities: uid and type are mandatory on every node', () => {
  assert.match(validateActionIntent(intent({ entities: { file_1: { type: 'file', canonical: 'a.js' } } })).error, /实体缺少 UID/);
  assert.match(validateActionIntent(intent({ entities: { file_1: { uid: 'file_1', canonical: 'a.js' } } })).error, /缺少 type/);
});

// B31-F11: `_validateEntity` runs the description through `_checkStringField`, but
// an EMPTY canonical matches nothing, so an entity that carries no description at all
// is legal. Combined with dimensionReducer's '<unspecified>' placeholder the lattice
// can be sealed with pointers that resolve to nothing a human could read.
test('B31-F11 an entity with an empty canonical passes the ambiguity gate', () => {
  const r = validateActionIntent(intent({ entities: { file_1: { uid: 'file_1', type: 'file', canonical: '' } } }));
  assert.deepEqual(r, { valid: true, normalized: r.normalized });
  const missing = validateActionIntent(intent({ entities: { file_1: { uid: 'file_1', type: 'file' } } }));
  assert.equal(missing.valid, true, 'and a wholly absent canonical passes too (e.canonical || "")');
});

test('TaskGraph: kind, uid and the nodes/edges containers', () => {
  assert.deepEqual(validateTaskGraph({ kind: 'ActionIntent' }), { valid: false, error: 'kind 必须为 TaskGraph' });
  assert.deepEqual(validateTaskGraph(graph({ uid: '' })), { valid: false, error: 'TaskGraph 缺少 uid', missing: ['uid'] });
  assert.match(validateTaskGraph(graph({ graph: {} })).error, /须含 nodes\[\] 与 edges\[\]/);
  assert.deepEqual(validateTaskGraph(graph({ graph: { nodes: [], edges: [] } })), {
    valid: false,
    error: 'TaskGraph 至少一个节点',
    missing: ['nodes'],
  });
});

test('TaskGraph: an empty edge set is fine unless the caller asserts a dependency', () => {
  const flat = graph({ graph: { nodes: [{ uid: 'n1', action: 'READ' }], edges: [] } });
  assert.equal(validateTaskGraph(flat).valid, true);
  const r = validateTaskGraph(flat, { hadDependency: true });
  assert.equal(r.valid, false);
  assert.deepEqual(r.missing, ['edges']);
  assert.match(r.error, /防呆②/);
});

test('TaskGraph: duplicate uids are one rule, a uid-less node is another', () => {
  assert.match(validateTaskGraph(graph({ graph: { nodes: [{ uid: 'n1', action: 'READ' }, { uid: 'n1', action: 'READ' }], edges: [] } })).error, /重复\/缺失的节点 uid/);
  // forgeSchema.js:184 counts `undefined` as a distinct Set member, so the "缺失"
  // half of that message is unreachable; the uid-less node is caught later by the
  // per-node loop with its own wording.
  const uidless = validateTaskGraph(graph({ graph: { nodes: [{ uid: 'n1', action: 'READ' }, { action: 'READ' }], edges: [] } }));
  assert.deepEqual(uidless, { valid: false, error: '节点缺少 uid', missing: ['node.uid'] });
});

test('TaskGraph: node action must be a primitive and endpoints must exist', () => {
  const bad = graph({ graph: { nodes: [{ uid: 'n1', action: 'FLY' }], edges: [] } });
  assert.match(validateTaskGraph(bad).error, /action 非标准原语/);
  const dangling = graph({
    graph: { nodes: [{ uid: 'n1', action: 'READ' }], edges: [{ from: 'n1', to: 'ghost', type: 'seq' }] },
  });
  assert.match(validateTaskGraph(dangling).error, /边端点悬空（n1 -> ghost）/);
});

// B31-F11: pointer integrity is only enforced for L0. validateActionIntent.js:156
// checks that target.uid resolves inside the entity table; validateTaskGraph never
// looks at node.target at all, so a TaskGraph full of dangling node pointers is a
// legal forge product (and it is what intentWeaver.weave() emits whenever the entity
// registry was not carried over).
test('B31-F11 node target pointers are never resolved against the entity table', () => {
  const r = validateTaskGraph({
    kind: 'TaskGraph',
    uid: 'tg_x',
    graph: { nodes: [{ uid: 'n1', action: 'READ', target: { uid: 'ghost' } }], edges: [{ from: 'n1', to: 'n1', type: 'seq' }] },
    entities: {},
    strategy: S.STRATEGIES.PROMPT_SOFT,
  });
  assert.equal(r.valid, true);
});

test('TaskGraph: entities, params and strategy reuse the L0 rules', () => {
  assert.match(validateTaskGraph(graph({ entities: { x: { uid: 'x' } } })).error, /缺少 type/);
  assert.match(
    validateTaskGraph(graph({
      graph: { nodes: [{ uid: 'n1', action: 'READ', params: { p: '如果下雨' } }], edges: [] },
    })).error,
    /含模糊词|非原子/,
  );
  assert.match(validateTaskGraph(graph({ strategy: 'nope' })).error, /strategy 非法/);
});

test('StateMachine: container, initial and emptiness gates', () => {
  assert.deepEqual(validateStateMachine({ kind: 'TaskGraph' }), { valid: false, error: 'kind 必须为 StateMachine' });
  assert.deepEqual(validateStateMachine(machine({ uid: '' })), { valid: false, error: 'StateMachine 缺少 uid', missing: ['uid'] });
  assert.match(validateStateMachine(machine({ machine: {} })).error, /须含 states\[\] 与 transitions\[\]/);
  assert.deepEqual(validateStateMachine(machine({ machine: { initial: 's1', states: [], transitions: [] } })), {
    valid: false,
    error: 'StateMachine 至少一个状态',
    missing: ['states'],
  });
  assert.deepEqual(validateStateMachine(machine({ machine: { initial: '', states: [{ uid: 's1' }], transitions: [] } })), {
    valid: false,
    error: 'StateMachine 缺少 initial 状态',
    missing: ['initial'],
  });
  assert.match(validateStateMachine(machine({ machine: { initial: 'ghost', states: [{ uid: 's1' }], transitions: [] } })).error, /initial 不在状态集内/);
});

test('StateMachine: transition endpoints must exist', () => {
  const r = validateStateMachine(machine({
    machine: { initial: 's1', states: [{ uid: 's1' }], transitions: [{ from: 's1', to: 'ghost', on: 'next' }] },
  }));
  assert.match(r.error, /转移端点悬空（s1 -> ghost）/);
});

// B31-F11: validateTaskGraph compares the deduped uid Set against the node array
// (forgeSchema.js:184-187); validateStateMachine builds the same Set (forgeSchema.js:241)
// but never compares its size, so two states sharing one uid are legal at L2 —
// and `transitions` referencing that uid become ambiguous, which is exactly the
// 可索引性 rule the module header claims to police.
test('B31-F11 duplicate state uids pass the L2 gate (current, wrong)', () => {
  const r = validateStateMachine(machine({
    machine: {
      initial: 's1',
      states: [{ uid: 's1', name: 'first' }, { uid: 's1', name: 'second' }],
      transitions: [{ from: 's1', to: 's1', on: 'next' }],
    },
  }));
  assert.equal(r.valid, true);
  const analogous = validateTaskGraph({
    kind: 'TaskGraph',
    uid: 'tg_y',
    graph: { nodes: [{ uid: 'n1', action: 'READ' }, { uid: 'n1', action: 'READ' }], edges: [] },
    entities: {},
    strategy: S.STRATEGIES.PROMPT_SOFT,
  });
  assert.equal(analogous.valid, false, 'the same shape is refused at L1');
});

test('StateMachine: entities and strategy gates behave as elsewhere', () => {
  assert.match(validateStateMachine(machine({ entities: { x: { uid: 'x', type: 't', canonical: '大概如此' } } })).error, /含模糊词/);
  assert.match(validateStateMachine(machine({ strategy: 'x' })).error, /strategy 非法/);
  assert.equal(validateStateMachine(machine()).valid, true);
});

test('validate() dispatches on kind and names the unknown one', () => {
  assert.equal(validate(intent()).valid, true);
  assert.equal(validate(graph()).valid, true);
  assert.equal(validate(machine()).valid, true);
  assert.deepEqual(validate({ kind: 'Whatever' }), { valid: false, error: '未知坍缩产出 kind: Whatever' });
  assert.match(validate({}).error, /未知坍缩产出 kind: undefined/);
  assert.match(validate(null).error, /未知坍缩产出 kind/);
  assert.equal(validate(graph(), { hadDependency: true }).valid, true);
});

test('coerceVagueness leaves clean text alone at full confidence', () => {
  assert.deepEqual(coerceVagueness('删除 a.js'), { clean: '删除 a.js', confidence: 1, hadVague: false });
  assert.deepEqual(coerceVagueness(undefined), { clean: '', confidence: 1, hadVague: false });
  assert.deepEqual(coerceVagueness('  修剪空白  '), { clean: '修剪空白', confidence: 1, hadVague: false });
});

test('coerceVagueness quantifies the vagueness instead of guessing a value', () => {
  const r = coerceVagueness('可能要删除 a.js');
  assert.deepEqual(r, { clean: '要删除 a.js', confidence: 0.6, hadVague: true });
  assert.equal(coerceVagueness('删除大概三个文件').confidence, 0.6);
  assert.equal(coerceVagueness('maybe delete it').clean, 'delete it');
});

// B31-F10 (schema half): the confidence floor in anomalyHandler is 0.65 and the
// coercion hands out exactly 0.6, so any hit below permanently routes to DEGRADE —
// including the ordinary English prepositions 'about'/'around' that VAGUE_RE lists.
test('B31-F10 an ordinary English preposition is enough to drop below the degrade floor', () => {
  const r = coerceVagueness('delete a.js about 3 files');
  assert.equal(r.hadVague, true);
  assert.equal(r.confidence, 0.6);
  assert.equal(r.clean, 'delete a.js 3 files', 'the word is also deleted from the text');
  assert.ok(r.confidence < require('./anomalyHandler').DEGRADE_CONFIDENCE_FLOOR);
  assert.equal(VAGUE_RE.test('roughly'), true);
});

test('isAtomic / hasRelativeClause implement the two lattice iron rules', () => {
  assert.equal(isAtomic(42), true);
  assert.equal(isAtomic(null), true);
  assert.equal(isAtomic({}), true);
  assert.equal(isAtomic('备份文件'), true);
  assert.equal(isAtomic('备份并且清理'), false);
  assert.equal(isAtomic('备份, 清理'), false);
  assert.equal(isAtomic('do it then stop'), false);
  assert.equal(hasRelativeClause('the file that shipped'), true);
  assert.equal(hasRelativeClause('谁的报告'), false, 'a single 的 is not a nested clause');
  assert.equal(hasRelativeClause('昨天的那个晴朗的下午'), true);
  assert.equal(hasRelativeClause(7), false, 'non-strings never carry a clause');
});

test('_checkStringField reports the first violated rule only (vague > clause > atomic)', () => {
  const both = validateActionIntent(intent({ params: { p: '可能，然后' } }));
  assert.match(both.error, /含模糊词/, 'the atomicity breach is masked behind the vagueness hit');
});
