'use strict';

// Unit-level contract tests for executorRegistry.js (co-located, per [RESEARCH-018] §2.3).
// This is the 武器库: the closed set of executors a model may pick, each declaring its
// language boundary and whether it ships an AST safety net. The registry holds no
// validation logic — it is data + lookups — so what matters is that the data stays
// well-formed, that lookups cannot invent executors (防呆: 模型不可凭空捏造执行器), and
// that the prompt menu is *generated* from the same table so the model's universe of
// choices can never drift from what the validator accepts.

const test = require('node:test');
const assert = require('node:assert/strict');

const registry = require('./executorRegistry');

const IDS = ['js_babel_writer', 'py_ast_replacer', 'generic_syntax_writer', 'raw_string_injector'];

test('the catalog is the closed four-executor list, in the documented safest-first order', () => {
  assert.equal(Array.isArray(registry.EXECUTORS), true);
  assert.equal(registry.EXECUTORS.length, 4);
  assert.deepEqual(registry.executorIds(), IDS);
  assert.deepEqual(
    registry.listExecutors().map((e) => e.id),
    IDS,
  );
});

test('every executor carries the full declared shape with the right types', () => {
  const fails = [];
  for (const e of registry.listExecutors()) {
    const keys = Object.keys(e).sort();
    if (keys.join(',') !== 'astSafetyNet,destructive,id,label,languages,risk,summary,validator') {
      fails.push(`${e.id}: unexpected key set ${keys.join(',')}`);
    }
    if (typeof e.label !== 'string' || !e.label) fails.push(`${e.id}: label missing`);
    if (!Array.isArray(e.languages) || e.languages.length === 0) fails.push(`${e.id}: languages empty`);
    if (typeof e.astSafetyNet !== 'boolean') fails.push(`${e.id}: astSafetyNet must be boolean`);
    if (typeof e.destructive !== 'boolean') fails.push(`${e.id}: destructive must be boolean`);
    if (!(e.validator === null || typeof e.validator === 'string')) {
      fails.push(`${e.id}: validator must be a key or null, got ${typeof e.validator}`);
    }
    if (typeof e.summary !== 'string' || e.summary.length < 10) fails.push(`${e.id}: summary too thin`);
    if (typeof e.risk !== 'string' || e.risk.length < 2) fails.push(`${e.id}: risk note missing`);
  }
  assert.deepEqual(fails, [], fails.join('\n'));
});

test('the four executors differ in exactly the two axes the strategy ladder keys on', () => {
  const byId = Object.fromEntries(registry.listExecutors().map((e) => [e.id, e]));
  assert.deepEqual(byId.js_babel_writer, {
    id: 'js_babel_writer',
    label: 'JS/TS AST 写手',
    languages: ['javascript', 'typescript', 'jsx', 'tsx'],
    astSafetyNet: true,
    validator: 'babel',
    destructive: false,
    summary: '用 @babel/parser 解析校验后再落盘，自带语法安全网，适合重构核心逻辑。',
    risk: '低：语法错误会被 AST 拦截打回，绝不写入坏代码。',
  });
  assert.deepEqual(byId.py_ast_replacer.languages, ['python']);
  assert.equal(byId.py_ast_replacer.validator, 'python_ast');
  assert.equal(byId.py_ast_replacer.astSafetyNet, true);
  assert.deepEqual(byId.generic_syntax_writer.languages, ['*']);
  assert.equal(byId.generic_syntax_writer.validator, 'vm_or_native');
  assert.equal(byId.generic_syntax_writer.astSafetyNet, true);
  // The only unguarded executor: this is the one a Prompt_Soft dissent must justify.
  assert.equal(byId.raw_string_injector.validator, null);
  assert.equal(byId.raw_string_injector.astSafetyNet, false);
  assert.equal(byId.raw_string_injector.languages.includes('*'), true);
  // Nothing in the catalog is declared destructive — the red-line layer owns that axis.
  for (const e of registry.listExecutors()) assert.equal(e.destructive, false, `${e.id} claims destructive`);
});

test('listExecutors hands out per-entry copies, so retuning one object does not hit the catalog', () => {
  const first = registry.listExecutors()[0];
  const second = registry.listExecutors()[0];
  assert.notEqual(first, second, 'each call must build fresh entry objects');
  first.label = 'hijacked';
  first.astSafetyNet = false;
  assert.equal(registry.getExecutor('js_babel_writer').label, 'JS/TS AST 写手');
  assert.equal(registry.getExecutor('js_babel_writer').astSafetyNet, true);
  assert.equal(registry.EXECUTORS[0].label, 'JS/TS AST 写手');
});

test('known gaps (see README 已登记的缺口): the array is frozen but entries are not, and languages is shared', () => {
  // Characterization, NOT endorsement. capabilityMatrix/ deep-freezes every catalog
  // entry; this one freezes only the array shell.
  assert.equal(Object.isFrozen(registry.EXECUTORS), true);
  assert.equal(Object.isFrozen(registry.EXECUTORS[0]), false, 'entries stay writable — registered gap');
  // And the "copy" is shallow: the nested `languages` array is handed out by reference,
  // so a consumer can widen an executor's language boundary for the whole process.
  const leaked = registry.listExecutors()[0].languages;
  assert.equal(leaked, registry.EXECUTORS[0].languages, 'same array instance — registered gap');
  // Deliberately NOT exercised: pushing here would poison the registry for every
  // sibling test in this file. The candidate fix is one Object.freeze per entry plus a
  // frozen/copyed languages array, applied centrally.
});

test('getExecutor / isRegistered agree on the registered ids', () => {
  for (const id of IDS) {
    assert.equal(registry.getExecutor(id).id, id);
    assert.equal(registry.isRegistered(id), true);
  }
  assert.equal(registry.getExecutor('no_such_writer'), null);
  assert.equal(registry.isRegistered('no_such_writer'), false);
  // Whitespace and null-ish input are normalized, never looked up raw.
  assert.equal(registry.getExecutor('  js_babel_writer  ').id, 'js_babel_writer');
  assert.equal(registry.getExecutor(null), null);
  assert.equal(registry.getExecutor(undefined), null);
  assert.equal(registry.getExecutor(''), null);
  assert.equal(registry.isRegistered(null), false);
  assert.equal(registry.isRegistered(''), false);
  assert.equal(registry.isRegistered('  py_ast_replacer  '), true);
});

test('getExecutor and isRegistered agree on prototype keys — neither resolves an inherited member', () => {
  // Was a registered DEFECT (repro chain: .khy/feedback/b23-metaplan/repro-before.txt →
  // repro-after.txt): getExecutor did a plain `_BY_ID[key] || null`, so an
  // Object.prototype key returned the inherited member instead of null, contradicting
  // its own JSDoc. Fixed by routing ownership through isRegistered(); this test now pins
  // the agreement instead of the divergence.
  for (const id of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'nope_id']) {
    assert.equal(registry.isRegistered(id), false, `${id}: not registered`);
    assert.equal(registry.getExecutor(id), null, `${id}: must be null, not an inherited member`);
  }
  assert.equal(registry.validateToolchain(['constructor']).valid, false, 'the 防呆 gate does reject it');
});

test('executorsForLanguage matches the boundary plus every generic', () => {
  const js = registry.executorsForLanguage('javascript').map((e) => e.id);
  assert.deepEqual(js, ['js_babel_writer', 'generic_syntax_writer', 'raw_string_injector']);
  assert.deepEqual(registry.executorsForLanguage('PYTHON').map((e) => e.id), [
    'py_ast_replacer',
    'generic_syntax_writer',
    'raw_string_injector',
  ]);
  assert.deepEqual(registry.executorsForLanguage('tsx').map((e) => e.id), [
    'js_babel_writer',
    'generic_syntax_writer',
    'raw_string_injector',
  ]);
  // A language nobody declared still gets the two '*' generics — never an empty menu.
  assert.deepEqual(registry.executorsForLanguage('cobol').map((e) => e.id), [
    'generic_syntax_writer',
    'raw_string_injector',
  ]);
  assert.deepEqual(registry.executorsForLanguage('').map((e) => e.id), [
    'generic_syntax_writer',
    'raw_string_injector',
  ]);
  assert.deepEqual(registry.executorsForLanguage(null).map((e) => e.id), [
    'generic_syntax_writer',
    'raw_string_injector',
  ]);
  // The returned entry objects are fresh copies, so a caller can re-sort or re-label
  // its own menu without touching the catalog. (The nested `languages` array is NOT
  // copied — that is the gap asserted above, so it is deliberately not exercised here.)
  const menu = registry.executorsForLanguage('javascript');
  assert.notEqual(menu[0], registry.EXECUTORS[0]);
  menu[0].label = 'caller-local rename';
  assert.equal(registry.getExecutor('js_babel_writer').label, 'JS/TS AST 写手');
});

test('validateToolchain accepts registered ids in any order and reports the offenders', () => {
  const ok = registry.validateToolchain(['raw_string_injector', 'js_babel_writer']);
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.toolchain, ['raw_string_injector', 'js_babel_writer'], 'application order is preserved');
  assert.equal(ok.unknown, undefined);

  const bad = registry.validateToolchain(['js_babel_writer', 'ghost_a', 'ghost_b']);
  assert.equal(bad.valid, false);
  assert.deepEqual(bad.unknown, ['ghost_a', 'ghost_b']);
  assert.match(bad.reason, /ghost_a, ghost_b/);
  // The rejection message reprints the whole menu, so a model can self-correct.
  for (const id of IDS) assert.ok(bad.reason.includes(id), `reason must list ${id}`);

  const empty = registry.validateToolchain([]);
  assert.equal(empty.valid, false);
  assert.match(empty.reason, /非空数组/);
  for (const junk of [null, undefined, 'js_babel_writer', 7, {}, { length: 0 }]) {
    assert.equal(registry.validateToolchain(junk).valid, false, `${JSON.stringify(junk)} must be rejected`);
  }
  // Duplicates are tolerated — the catalog says nothing about idempotence.
  assert.deepEqual(
    registry.validateToolchain(['js_babel_writer', 'js_babel_writer']).toolchain,
    ['js_babel_writer', 'js_babel_writer'],
  );
});

test('toolchainHasUnguarded is the Prompt_Soft cross-check, and fails closed', () => {
  assert.equal(registry.toolchainHasUnguarded(['raw_string_injector']), true);
  assert.equal(registry.toolchainHasUnguarded(['js_babel_writer']), false);
  assert.equal(registry.toolchainHasUnguarded(['py_ast_replacer', 'generic_syntax_writer']), false);
  assert.equal(
    registry.toolchainHasUnguarded(['js_babel_writer', 'raw_string_injector']),
    true,
    'one unguarded executor anywhere in the chain counts',
  );
  // An invalid / empty / junk toolchain returns true (assume the worst) rather than throwing.
  assert.equal(registry.toolchainHasUnguarded([]), true);
  assert.equal(registry.toolchainHasUnguarded(null), true);
  assert.equal(registry.toolchainHasUnguarded(['made_up_id']), true);
});

test('describeForModel is generated from the catalog, so the menu and the validator cannot drift', () => {
  const menu = registry.describeForModel();
  const lines = menu.split('\n');
  assert.equal(lines.length, registry.EXECUTORS.length);
  for (const line of lines) assert.match(line, /^  - "[a-z_]+"/);
  for (const id of IDS) assert.ok(menu.includes(`"${id}"`), `menu must offer ${id}`);
  // The two axes the model needs to reason about risk are spelled out per line.
  assert.ok(menu.includes('有 AST 安全网'));
  assert.ok(menu.includes('无 AST 校验'));
  assert.ok(menu.includes('任意语言'), "the '*' boundary is rendered in Chinese");
  assert.ok(menu.includes('javascript/typescript/jsx/tsx'));
  assert.ok(menu.includes('python'));
  // And nothing outside the catalog leaks into the menu.
  assert.equal(menu.includes('made_up'), false);
});
