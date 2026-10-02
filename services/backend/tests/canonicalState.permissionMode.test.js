'use strict';
/**
 * canonicalState.permissionMode.test.js — the session permission mode carried
 * in the canonical snapshot (constraints dimension).
 *
 * Locks: (1) explicit ctx.permissionMode wins; (2) without ctx, the snapshot
 * records the ACTUAL current mode via the toolCallingPermissions singleton
 * getter (never a guessed default); (3) formatAsPrompt renders the mode line
 * only when present — old snapshots without the field must render BYTE-identical
 * to the legacy output (regression lock); (4) an old-shape state survives the
 * JSON round-trip and renders fine (undefined tolerance).
 *
 * Who breaks it red: removing the field from buildSnapshot, guessing a default
 * when the getter is unavailable, or rendering the line for legacy snapshots.
 */
const test = require('node:test');
const assert = require('node:assert');
const { buildSnapshot, formatAsPrompt } = require('../src/services/canonicalState');
const { getPermissionMode } = require('../src/services/tool/toolCallingPermissions');

const MIN_CTX = {
  messages: [{ role: 'user', content: 'fix the failing test' }],
  toolCallLog: [],
};

// Old-shape constraints: exactly the pre-permissionMode fields.
const LEGACY_STATE = {
  goal: 'fix the failing test',
  constraints: { model: 'test-model', workspace: '/tmp/ws', notes: '' },
  facts: [],
  openLoops: [],
  pending: [],
  criticalRefs: { filePaths: [] },
};

test('ctx 显式 permissionMode 优先写入 constraints 维', () => {
  const snap = buildSnapshot({ ...MIN_CTX, permissionMode: 'bypass' });
  assert.strictEqual(snap.constraints.permissionMode, 'bypass');
});

test('未传 ctx 时 fail-soft 解析实际当前档位（getter 单例真源，非猜 default）', () => {
  const snap = buildSnapshot(MIN_CTX);
  assert.strictEqual(typeof snap.constraints.permissionMode, 'string');
  assert.ok(snap.constraints.permissionMode.length > 0);
  assert.strictEqual(snap.constraints.permissionMode, getPermissionMode());
});

test('旧形态快照（无该字段）不设键且渲染逐字节等于既有输出（回归锁）', () => {
  const snap = buildSnapshot(MIN_CTX);
  delete snap.constraints.permissionMode;
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(snap.constraints, 'permissionMode'),
    false
  );
  const prompt = formatAsPrompt(snap);
  // Byte-identical to the legacy composition for this shape.
  assert.strictEqual(
    prompt,
    '## Goal\nfix the failing test\n\n## Constraints\nModel: unknown\nWorkspace: ' +
      snap.constraints.workspace
  );
});

test('含字段时 formatAsPrompt 渲染 Permission mode 行', () => {
  const snap = buildSnapshot({ ...MIN_CTX, permissionMode: 'bypass' });
  const prompt = formatAsPrompt(snap);
  assert.ok(prompt.includes('Permission mode: bypass'), prompt);
});

test('旧形态状态经 JSON round-trip 后仍可渲染（undefined 容忍）', () => {
  const revived = JSON.parse(JSON.stringify(LEGACY_STATE));
  const prompt = formatAsPrompt(revived);
  assert.ok(prompt.startsWith('## Goal\nfix the failing test'));
  assert.ok(!prompt.includes('Permission mode'));
});
