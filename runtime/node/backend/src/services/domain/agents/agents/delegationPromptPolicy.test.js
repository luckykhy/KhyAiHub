'use strict';

// Colocated tests for delegationPromptPolicy.js (pure leaf: zero IO, deterministic).

const test = require('node:test');
const assert = require('node:assert/strict');

const svc = require('./delegationPromptPolicy');

test('门控默认开：未设/空 env/无该键 → 启用', () => {
  assert.equal(svc.isDelegationCoachingEnabled(), true);
  assert.equal(svc.isDelegationCoachingEnabled({}), true);
  assert.equal(svc.isDelegationCoachingEnabled(null), true); // env 缺失按默认开
  assert.equal(svc.isDelegationCoachingEnabled(undefined), true);
  assert.equal(svc.isDelegationCoachingEnabled({ KHY_DELEGATION_PROMPT: undefined }), true);
});

test('门控仅 0/false/off/no（大小写与空白不敏感）关闭', () => {
  for (const v of ['0', 'false', 'off', 'no', 'FALSE', 'Off', ' NO ', 'false ']) {
    assert.equal(svc.isDelegationCoachingEnabled({ KHY_DELEGATION_PROMPT: v }), false, v);
  }
  for (const v of ['1', 'true', 'on', 'yes', 'OFFICIAL', '00', 'falsely']) {
    assert.equal(svc.isDelegationCoachingEnabled({ KHY_DELEGATION_PROMPT: v }), true, v);
  }
});

test('门控垃圾值不抛、按 String() 语义判定', () => {
  assert.equal(svc.isDelegationCoachingEnabled({ KHY_DELEGATION_PROMPT: 0 }), false); // String(0)='0'
  assert.equal(svc.isDelegationCoachingEnabled({ KHY_DELEGATION_PROMPT: NaN }), true); // 'nan' 不在 off 集
  assert.equal(svc.isDelegationCoachingEnabled({ KHY_DELEGATION_PROMPT: {} }), true);
  // 空数组 String() 后为空串，本叶子的 off 集合只有 {0,false,off,no}，空串不算关
  assert.equal(svc.isDelegationCoachingEnabled({ KHY_DELEGATION_PROMPT: [] }), true);
});

test('resolve 开 → 升级教程逐字节等于 buildDelegationPromptGuide()', () => {
  assert.equal(svc.resolveWritingThePromptSection({}), svc.buildDelegationPromptGuide());
});

test('resolve 关 → 逐字节回退既有 LEGACY_WRITING_SECTION 文案', () => {
  const legacy = svc.resolveWritingThePromptSection({ KHY_DELEGATION_PROMPT: '0' });
  assert.equal(legacy, svc.LEGACY_WRITING_SECTION);
  assert.ok(legacy.includes('## Writing the prompt'));
  assert.ok(legacy.includes('Never delegate understanding.'));
  assert.ok(legacy.includes('Never duplicate delegated work.'));
});

test('resolve 垃圾入参不抛：null/数字/字符串 env 视为启用', () => {
  assert.equal(svc.resolveWritingThePromptSection(null), svc.buildDelegationPromptGuide());
  assert.equal(svc.resolveWritingThePromptSection(0), svc.buildDelegationPromptGuide());
  assert.equal(svc.resolveWritingThePromptSection('x'), svc.buildDelegationPromptGuide());
});

test('升级教程覆盖七要素与三条红线（确定性结构）', () => {
  const guide = svc.buildDelegationPromptGuide();
  for (const keyword of [
    '**Objective**',
    '**Context already gathered**',
    '**Exact pointers**',
    '**Owned scope and non-goals**',
    '**Acceptance criteria**',
    '**Output contract**',
    '**Autonomy and escalation**',
    '**Never delegate understanding.**',
    '**Never duplicate delegated work.**',
    '**Match depth to the task.**',
  ]) {
    assert.ok(guide.includes(keyword), keyword);
  }
  // 两次调用逐字节一致（无时钟/随机）
  assert.equal(guide, svc.buildDelegationPromptGuide());
});

test('导出面完整且常量稳定', () => {
  assert.equal(svc.DELEGATION_PROMPT_GATE, 'KHY_DELEGATION_PROMPT');
  assert.equal(typeof svc.LEGACY_WRITING_SECTION, 'string');
  assert.ok(svc.LEGACY_WRITING_SECTION.length > 0);
});
