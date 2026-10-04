'use strict';

// Unit-level contract tests for lenientResponseParser.js (co-located, per [RESEARCH-018] §2.3).
// The parser implements 红线1/2/3 as a total function over ANY model-response input: never
// throws, captures unknown fields instead of dropping them, and returns a well-formed
// degraded structure for bad JSON / non-object roots. Every expected value below was read
// off the source (KNOWN_TOP_LEVEL / KNOWN_ACTION_KEYS sets, the field-fallback ladders, the
// text priority chain). logger is injected so no test touches the real console.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseModelResponse, normalizeAction, KNOWN_TOP_LEVEL } = require('./lenientResponseParser');

const base = (r) => ({
  ok: r.ok,
  degraded: r.degraded,
  actions: r.actions,
  text: r.text,
  unknownFields: r.unknownFields,
});

test('KNOWN_TOP_LEVEL is the documented loose superset (a Set, read-only here)', () => {
  assert.ok(KNOWN_TOP_LEVEL instanceof Set);
  for (const k of ['actions', 'action', 'text', 'content', 'message', 'reasoning', 'usage', 'model', 'role']) {
    assert.equal(KNOWN_TOP_LEVEL.has(k), true, `${k} should be a known top-level field`);
  }
  assert.equal(KNOWN_TOP_LEVEL.has('totally_unknown'), false);
});

// ── 红线3: total input coverage, never throws ────────────────────────────────
test('empty string short-circuits to a clean degraded result with no warnings', () => {
  const r = parseModelResponse('');
  assert.deepEqual(r, { ok: false, degraded: true, actions: [], text: '', unknownFields: {}, warnings: [] });
  const ws = parseModelResponse('   ');
  assert.equal(ws.text, '', 'whitespace-only is not trimmed into JSON, falls to the empty-text path');
  assert.equal(ws.degraded, true);
});

test('malformed JSON is salvaged as text, never fatal (红线1)', () => {
  const r = parseModelResponse('this is not json {');
  assert.equal(r.ok, false);
  assert.equal(r.degraded, true);
  assert.equal(r.text, 'this is not json {', 'the ORIGINAL raw string (untrimmed) is the fallback');
  assert.deepEqual(r.actions, []);
  assert.equal(r.warnings.some((w) => w.includes('JSON.parse 失败')), true);
});

test('non-object roots (null / number / boolean) degrade with a String() text fallback', () => {
  assert.deepEqual(base(parseModelResponse(null)), {
    ok: false, degraded: true, actions: [], text: '', unknownFields: {},
  });
  assert.equal(parseModelResponse(undefined).text, '');
  assert.equal(parseModelResponse(42).text, '42');
  assert.equal(parseModelResponse(true).text, 'true');
  assert.equal(parseModelResponse(0).text, '0', 'falsy-but-not-null number still stringifies');
});

test('valid JSON object string is parsed then treated as an object response', () => {
  const r = parseModelResponse('{"actions":[{"type":"say","params":{"text":"hi"}}]}');
  assert.equal(r.ok, true);
  assert.equal(r.degraded, false);
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].type, 'say');
  assert.deepEqual(r.actions[0].params, { text: 'hi' });
});

// ── action extraction + field fallback ladders ───────────────────────────────
test('array-root response is treated as "all actions" and stays ok', () => {
  const r = parseModelResponse([{ type: 'a' }, { type: 'b' }]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.actions.map((a) => a.type), ['a', 'b']);
  assert.deepEqual(r.unknownFields, {}, 'the wrapper obj is {actions:[...]} which is known');
});

test('singular `action` field is wrapped to a one-element list', () => {
  const r = parseModelResponse({ action: { type: 'x' } });
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].type, 'x');
});

test('a non-array `actions` value is loosely wrapped, not dropped', () => {
  const r = parseModelResponse({ actions: { type: 'x' } });
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].type, 'x');
  assert.equal(r.warnings.some((w) => w.includes('actions 字段非数组')), true);
});

test('actions:0 (falsy but not null) still counts as a present, single non-object action', () => {
  const r = parseModelResponse({ actions: 0 });
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].type, '__nonobject_action__');
  assert.equal(r.actions[0]._raw, 0);
});

test('action type falls back through type → name → tool → action, else __missing_type__', () => {
  assert.equal(parseModelResponse({ actions: [{ name: 'speak' }] }).actions[0].type, 'speak');
  assert.equal(parseModelResponse({ actions: [{ tool: 'grab' }] }).actions[0].type, 'grab');
  assert.equal(parseModelResponse({ actions: [{ action: 'go' }] }).actions[0].type, 'go');
  const miss = parseModelResponse({ actions: [{ params: {} }] });
  assert.equal(miss.actions[0].type, '__missing_type__');
  assert.equal(miss.warnings.some((w) => w.includes('缺少类型字段')), true);
});

test('action params falls back through params → input → arguments → args, else {}', () => {
  assert.deepEqual(parseModelResponse({ actions: [{ type: 't', input: { a: 1 } }] }).actions[0].params, { a: 1 });
  assert.deepEqual(parseModelResponse({ actions: [{ type: 't', arguments: { b: 2 } }] }).actions[0].params, { b: 2 });
  assert.deepEqual(parseModelResponse({ actions: [{ type: 't', args: { c: 3 } }] }).actions[0].params, { c: 3 });
  assert.deepEqual(parseModelResponse({ actions: [{ type: 't' }] }).actions[0].params, {});
});

test('a non-object action is wrapped as a placeholder instead of being dropped (红线2)', () => {
  const r = parseModelResponse({ actions: ['just a string', 5] });
  assert.equal(r.actions[0].type, '__nonobject_action__');
  assert.equal(r.actions[0]._raw, 'just a string');
  assert.equal(r.actions[1]._raw, 5);
  assert.deepEqual(r.actions[0]._unknownKeys, [], 'placeholder carries an empty _unknownKeys array');
  assert.equal(r.warnings.filter((w) => w.includes('非对象')).length, 2);
});

test('unknown action keys are captured into _unknownKeys, never silently dropped (红线2)', () => {
  const a = normalizeAction({ type: 'say', custom_field: 1, another: 2 }, 0, []);
  assert.deepEqual(a._unknownKeys.slice().sort(), ['another', 'custom_field']);
  assert.deepEqual(a.params, {});
  assert.equal(a.type, 'say');
});

test('normalizeAction reports a warning for both unknown keys and a missing type', () => {
  const w = [];
  normalizeAction({ params: { x: 1 }, odd: 9 }, 3, w);
  assert.equal(w.length, 2);
  assert.ok(w.some((line) => line.includes('含未知键') && line.includes('action[3]')));
  assert.ok(w.some((line) => line.includes('缺少类型字段')));
});

// ── top-level unknown-field capture (红线1) ──────────────────────────────────
test('unknown top-level fields are captured and reported, not fatal', () => {
  const r = parseModelResponse({ text: 'hi', future_field: { a: 1 }, another: 2 });
  assert.deepEqual(r.unknownFields, { future_field: { a: 1 }, another: 2 });
  assert.equal(r.warnings.some((w) => w.includes('未知顶层字段')), true);
});

test('known top-level fields are NOT copied into unknownFields', () => {
  const r = parseModelResponse({ model: 'm', usage: { t: 1 }, reasoning: 'r' });
  assert.deepEqual(r.unknownFields, {});
});

// ── text extraction priority chain ───────────────────────────────────────────
test('text prefers text > content > message, and only accepts strings', () => {
  assert.equal(parseModelResponse({ text: 'A', content: 'B', message: 'C' }).text, 'A');
  assert.equal(parseModelResponse({ content: 'B', message: 'C' }).text, 'B');
  assert.equal(parseModelResponse({ message: 'C' }).text, 'C');
  assert.equal(parseModelResponse({ text: 5, content: 'B' }).text, 'B', 'non-string text is skipped');
  assert.equal(parseModelResponse({}).text, '');
});

// ── logger injection contract ────────────────────────────────────────────────
test('warnings are pushed AND mirrored to logger.warn with the module prefix', () => {
  const lines = [];
  const logger = { warn: (m) => lines.push(m) };
  const r = parseModelResponse('bad json', { logger });
  assert.equal(lines.length, r.warnings.length);
  assert.ok(lines.every((l) => l.startsWith('[dualTrack:lenientParser] ')));
});

test('a logger.warn that throws must not break parsing', () => {
  const logger = { warn: () => { throw new Error('log sink down'); } };
  const r = parseModelResponse('still bad json', { logger });
  assert.equal(r.degraded, true);
  assert.equal(r.text, 'still bad json');
});

test('a logger without a warn function is tolerated', () => {
  const r = parseModelResponse({ actions: [{}] }, { logger: {} });
  assert.equal(r.ok, true);
});
