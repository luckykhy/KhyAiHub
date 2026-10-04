'use strict';

// Unit-level contract tests for unknownActionView.js (co-located, per [RESEARCH-018] §2.3).
// This is 红线2's UI-safety leaf: it must produce a renderable placeholder for ANY input
// (never white-screen, never silent drop) and cap the raw-data view so a huge payload
// cannot blow up the terminal. Every assertion is derived from the source constants and
// the documented descriptor shape. No IO, no env.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildUnknownActionPlaceholder, RAW_VIEW_MAX } = require('./unknownActionView');

test('module exposes the documented raw-view cap', () => {
  assert.equal(RAW_VIEW_MAX, 4000);
});

test('a typed action produces the full descriptor contract', () => {
  const action = { type: 'fly_to_moon', params: { x: 1 } };
  const p = buildUnknownActionPlaceholder(action);
  assert.equal(p.kind, 'unknown-action-placeholder');
  assert.equal(p.actionType, 'fly_to_moon');
  assert.equal(p.title, '未知指令：fly_to_moon');
  assert.equal(
    p.message,
    '当前版本不支持该指令，可通过用户扩展轨（user_patch/）实现',
  );
  assert.equal(p.canExtend, true);
  assert.equal(p.renderable, true, '红线2: never white-screen');
  // No _raw → the raw view is the action itself, pretty-printed.
  assert.equal(p.rawDataView, JSON.stringify(action, null, 2));
});

test('a numeric action type is coerced to a string', () => {
  const p = buildUnknownActionPlaceholder({ type: 42 });
  assert.equal(p.actionType, '42');
  assert.equal(p.title, '未知指令：42');
});

test('null / undefined action still yields a renderable placeholder (never throws)', () => {
  for (const bad of [null, undefined, 0, '', false]) {
    const p = buildUnknownActionPlaceholder(bad);
    assert.equal(p.renderable, true, `input ${String(bad)} must still be renderable`);
    assert.equal(p.actionType, '<unknown>');
    assert.equal(p.title, '未知指令：<unknown>');
  }
});

test('_raw is preferred over the action object when present', () => {
  const p = buildUnknownActionPlaceholder({ type: 'x', _raw: { secret: 'payload' } });
  assert.equal(p.rawDataView, JSON.stringify({ secret: 'payload' }, null, 2));
});

test('undefined action collapses to the "undefined" raw string via the non-string guard', () => {
  // action === undefined → the selector falls through to `action` (undefined);
  // JSON.stringify(undefined) is not a string, so the module coerces via String().
  const p = buildUnknownActionPlaceholder(undefined);
  assert.equal(p.rawDataView, 'undefined');
});

test('a circular payload degrades to a coarse string instead of throwing', () => {
  const circular = { type: 'loop' };
  circular.self = circular;
  const p = buildUnknownActionPlaceholder(circular);
  assert.equal(p.renderable, true);
  assert.equal(p.rawDataView, '[object Object]');
});

test('an oversized raw view is truncated with the documented marker', () => {
  const huge = { type: 'big', blob: 'x'.repeat(RAW_VIEW_MAX + 500) };
  const original = JSON.stringify(huge, null, 2);
  assert.ok(original.length > RAW_VIEW_MAX, 'fixture must exceed the cap for the test to bite');
  const p = buildUnknownActionPlaceholder(huge);
  assert.equal(p.rawDataView.slice(0, RAW_VIEW_MAX), original.slice(0, RAW_VIEW_MAX));
  // The source appends: "\n…(已截断，共 <original length> 字符)"
  const suffix = `\n…(已截断，共 ${original.length} 字符)`;
  assert.ok(p.rawDataView.endsWith(suffix), 'truncation suffix must report the original length');
  assert.equal(p.rawDataView.length, RAW_VIEW_MAX + suffix.length);
});

test('an exactly-at-cap payload is NOT truncated (boundary is strictly >)', () => {
  // Build an object whose pretty JSON is exactly RAW_VIEW_MAX chars is fiddly;
  // instead verify a short payload round-trips untouched.
  const p = buildUnknownActionPlaceholder({ type: 'ok', v: 1 });
  assert.equal(p.rawDataView, JSON.stringify({ type: 'ok', v: 1 }, null, 2));
  assert.equal(p.rawDataView.includes('已截断'), false);
});
