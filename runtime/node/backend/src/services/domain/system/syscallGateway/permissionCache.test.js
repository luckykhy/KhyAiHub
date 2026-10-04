'use strict';

/**
 * permissionCache.test.js — 会话级权限缓存契约（仅内存、绝不落盘、确定性）。
 *
 * fail 方向：**保守优先 / fail-closed**。预审批清单静默拒收 L2（即便调用方伪造 level）；
 * grantSessionExempt 仅 L1 生效、L0/L2 no-op；L2 会话免审通道受 KHY_L2_SESSION_ALLOW 门控，
 * 门控关 → grant no-op + has 恒 false（逐字节恢复「红灯不可会话免审」铁律）。
 * L1 与 L2 两套 grants 物理隔离，互不溢出。涉及门控时保存/恢复 process.env。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { PermissionCache, isL2SessionAllowEnabled } = require('./permissionCache');
const { classify } = require('./resourceClassifier');

const classifier = (probe) => classify(probe);

test('isL2SessionAllowEnabled 默认开，仅 falsy token 关闭', () => {
  assert.strictEqual(isL2SessionAllowEnabled({}), true);
  assert.strictEqual(isL2SessionAllowEnabled({ KHY_L2_SESSION_ALLOW: 'off' }), false);
  assert.strictEqual(isL2SessionAllowEnabled({ KHY_L2_SESSION_ALLOW: '0' }), false);
  assert.strictEqual(isL2SessionAllowEnabled({ KHY_L2_SESSION_ALLOW: 'true' }), true);
});

test('submitManifest 用真实分级器接纳 L1、静默拒收 L2', () => {
  const c = new PermissionCache();
  const n = c.submitManifest(
    [{ action: 'write', scope: 'project' }, { action: 'delete', scope: 'system' }],
    classifier
  );
  assert.strictEqual(n, 1);
  const snap = c.describeManifest();
  assert.strictEqual(snap.length, 1);
  assert.strictEqual(snap[0].level, 'L1');
});

test('submitManifest 无分类器时按 item.level 判定，仍拒收 L2', () => {
  const c = new PermissionCache();
  assert.strictEqual(c.submitManifest([{ action: 'delete', scope: 'p', level: 'L2' }]), 0);
  assert.strictEqual(c.submitManifest([{ action: 'write', scope: 'p', level: 'L1' }]), 1);
});

test('submitManifest null 条目安全（非空表由上条保证）', () => {
  const c = new PermissionCache();
  assert.strictEqual(c.submitManifest(null, classifier), 0);
});

test('inManifest 命中已批同类，跨作用域与 L2 均不命中', () => {
  const c = new PermissionCache();
  c.submitManifest([{ action: 'write', scope: 'project', level: 'L1' }]);
  assert.strictEqual(c.inManifest({ action: 'write', scope: 'project' }, 'L1'), true);
  assert.strictEqual(c.inManifest({ action: 'write', scope: 'home' }, 'L1'), false);
  assert.strictEqual(c.inManifest({ action: 'write', scope: 'project' }, 'L2'), false);
});

test('grantSessionExempt 仅 L1 可免审，L0/L2 no-op', () => {
  const c = new PermissionCache();
  assert.strictEqual(c.grantSessionExempt({ action: 'network', scope: 'network' }, 'L1'), true);
  assert.strictEqual(c.hasSessionExempt({ action: 'network', scope: 'network' }, 'L1'), true);
  assert.strictEqual(c.grantSessionExempt({ action: 'x', scope: 'y' }, 'L2'), false);
  assert.strictEqual(c.grantSessionExempt({ action: 'x', scope: 'y' }, 'L0'), false);
});

test('hasSessionExempt 对非 L1 恒 false', () => {
  const c = new PermissionCache();
  assert.strictEqual(c.hasSessionExempt({ action: 'delete', scope: 'project' }, 'L2'), false);
});

test('L2 会话免审门控开：授予后同类命中、异类不命中', () => {
  const saved = process.env.KHY_L2_SESSION_ALLOW;
  delete process.env.KHY_L2_SESSION_ALLOW;
  try {
    const c = new PermissionCache();
    assert.strictEqual(c.grantL2SessionExempt({ action: 'delete', scope: 'project' }), true);
    assert.strictEqual(c.hasL2SessionExempt({ action: 'delete', scope: 'project' }), true);
    assert.strictEqual(c.hasL2SessionExempt({ action: 'kill', scope: 'project' }), false);
  } finally {
    if (saved === undefined) delete process.env.KHY_L2_SESSION_ALLOW;
    else process.env.KHY_L2_SESSION_ALLOW = saved;
  }
});

test('L2 会话免审门控关：grant no-op + has 恒 false（红线铁律）', () => {
  const saved = process.env.KHY_L2_SESSION_ALLOW;
  process.env.KHY_L2_SESSION_ALLOW = 'off';
  try {
    const c = new PermissionCache();
    assert.strictEqual(c.grantL2SessionExempt({ action: 'delete', scope: 'project' }), false);
    assert.strictEqual(c.hasL2SessionExempt({ action: 'delete', scope: 'project' }), false);
  } finally {
    if (saved === undefined) delete process.env.KHY_L2_SESSION_ALLOW;
    else process.env.KHY_L2_SESSION_ALLOW = saved;
  }
});

test('L1 与 L2 grants 物理隔离，互不溢出', () => {
  const saved = process.env.KHY_L2_SESSION_ALLOW;
  delete process.env.KHY_L2_SESSION_ALLOW;
  try {
    const c = new PermissionCache();
    const intent = { action: 'delete', scope: 'project' };
    c.grantL2SessionExempt(intent);
    assert.strictEqual(c.hasSessionExempt(intent, 'L1'), false, 'L2 授权不得泄漏到 L1');
    c.grantSessionExempt({ action: 'write', scope: 'project' }, 'L1');
    assert.strictEqual(c.hasL2SessionExempt({ action: 'write', scope: 'project' }), false, 'L1 授权不得泄漏到 L2');
  } finally {
    if (saved === undefined) delete process.env.KHY_L2_SESSION_ALLOW;
    else process.env.KHY_L2_SESSION_ALLOW = saved;
  }
});

test('clear 清空清单与全部 grants', () => {
  const c = new PermissionCache();
  c.submitManifest([{ action: 'write', scope: 'project', level: 'L1' }]);
  c.grantSessionExempt({ action: 'network', scope: 'network' }, 'L1');
  c.clear();
  assert.strictEqual(c.inManifest({ action: 'write', scope: 'project' }, 'L1'), false);
  assert.strictEqual(c.hasSessionExempt({ action: 'network', scope: 'network' }, 'L1'), false);
  assert.deepStrictEqual(c.describeManifest(), []);
});
