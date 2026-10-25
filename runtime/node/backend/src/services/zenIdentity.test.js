'use strict';

/**
 * zenIdentity.test.js — 每机持久身份的确定性单测。
 *
 * 覆盖的语义（对应用户诉求「在哪台机器上允许就在那台机器上用它的机器码和ip」）：
 *   1. 主门关 → 不落盘、不派生，回退到 zenGatekeeper 的进程级随机（历史行为）；
 *   2. 默认开 → 同一台机器（同一机器码）恒得同一身份；
 *   3. 跨「重启」（清内存态后重读）身份不变 —— 这是本次修正的核心；
 *   4. 不同机器码 → 不同身份（多机不撞号）；
 *   5. env 显式覆盖优先（用户明确指定修改的唯一入口）；
 *   6. 形态合法：session id = ses_ + 12 位 hex + 14 位 base62（上游门控拒收非 12 hex 开头）；
 *      project uuid = v4 形态；
 *   7. 集成：zenGatekeeper.buildZenHeaders 用的是这个持久身份，而不是进程级随机。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const zenIdentity = require('./zenIdentity');
const zenGatekeeper = require('./zenGatekeeper');

function _tmpFile(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `khy-zen-id-${tag}-`));
  return path.join(dir, 'zen_identity.json');
}

function _env(overrides = {}) {
  return {
    KHY_ZEN_IDENTITY_FILE: _tmpFile('x'),
    KHY_MACHINE_ID: 'MACHINE-A',
    ...overrides,
  };
}

test('主门关：不派生身份（回退由 zenGatekeeper 承担）', () => {
  const env = _env({ KHY_ZEN_IDENTITY: '0' });
  zenIdentity._reset(true);
  assert.strictEqual(zenIdentity.getIdentity(env), null);
  assert.strictEqual(zenIdentity.enabled(env), false);
});

test('默认开：同一台机器恒得同一身份', () => {
  const env = _env();
  zenIdentity._reset(true);
  const a = zenIdentity.getIdentity(env);
  const b = zenIdentity.getIdentity(env);
  assert.ok(a && a.sessionId && a.projectUuid);
  assert.strictEqual(a.sessionId, b.sessionId);
  assert.strictEqual(a.projectUuid, b.projectUuid);
});

test('跨「重启」稳定：清内存态后重读同一文件，身份不变', () => {
  const env = _env();
  zenIdentity._reset(true);
  const first = zenIdentity.getIdentity(env);
  // 模拟进程重启：内存态清空（落盘文件保留）
  zenIdentity._reset(false);
  const second = zenIdentity.getIdentity(env);
  assert.strictEqual(first.sessionId, second.sessionId);
  assert.strictEqual(first.projectUuid, second.projectUuid);
  assert.strictEqual(second.source, 'file');
});

test('不同机器码 → 不同身份（多机不撞号）', () => {
  const envA = _env({ KHY_MACHINE_ID: 'MACHINE-A' });
  const envB = _env({ KHY_MACHINE_ID: 'MACHINE-B' });
  zenIdentity._reset(true);
  const a = zenIdentity.getIdentity(envA);
  const b = zenIdentity.getIdentity(envB);
  assert.notStrictEqual(a.sessionId, b.sessionId);
  assert.notStrictEqual(a.projectUuid, b.projectUuid);
});

test('env 显式覆盖优先于落盘与派生', () => {
  const env = _env({
    KHY_ZEN_SESSION_ID: 'ses_0123456789abcustom',
    KHY_ZEN_PROJECT_ID: '11111111-2222-4333-8444-555555555555',
  });
  zenIdentity._reset(true);
  const id = zenIdentity.getIdentity(env);
  assert.strictEqual(id.sessionId, 'ses_0123456789abcustom');
  assert.strictEqual(id.projectUuid, '11111111-2222-4333-8444-555555555555');
  assert.strictEqual(id.source, 'env');
});

test('形态合法：session id 前缀与 12 位 hex 时间段', () => {
  const env = _env();
  zenIdentity._reset(true);
  const id = zenIdentity.getIdentity(env);
  assert.match(id.sessionId, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.match(
    id.projectUuid,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
});

test('集成：zenGatekeeper 的指纹头用的是持久身份', () => {
  // zenGatekeeper 读的是真实 process.env（生产路径），故此处临时改真实 env。
  const env = _env();
  const prev = {
    file: process.env.KHY_ZEN_IDENTITY_FILE,
    machine: process.env.KHY_MACHINE_ID,
  };
  process.env.KHY_ZEN_IDENTITY_FILE = env.KHY_ZEN_IDENTITY_FILE;
  process.env.KHY_MACHINE_ID = env.KHY_MACHINE_ID;
  try {
    zenIdentity._reset(true);
    zenGatekeeper._reset();
    const id = zenIdentity.getIdentity(process.env);
    const headers = zenGatekeeper.buildZenHeaders({});
    assert.strictEqual(headers['x-opencode-session'], id.sessionId);
    assert.strictEqual(headers['x-opencode-project'], id.projectUuid);
    assert.strictEqual(headers['x-session-id'], id.sessionId);
  } finally {
    if (prev.file === undefined) {
      delete process.env.KHY_ZEN_IDENTITY_FILE;
    } else {
      process.env.KHY_ZEN_IDENTITY_FILE = prev.file;
    }
    if (prev.machine === undefined) {
      delete process.env.KHY_MACHINE_ID;
    } else {
      process.env.KHY_MACHINE_ID = prev.machine;
    }
    zenIdentity._reset(false);
    zenGatekeeper._reset();
  }
});

test('门关时 zenGatekeeper 回退到进程级随机（历史行为不回退）', () => {
  const env = _env({ KHY_ZEN_IDENTITY: 'off' });
  zenIdentity._reset(true);
  zenGatekeeper._reset();
  const before = process.env.KHY_ZEN_IDENTITY;
  process.env.KHY_ZEN_IDENTITY = 'off';
  try {
    const headers = zenGatekeeper.buildZenHeaders({});
    assert.match(headers['x-opencode-session'], /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    // 进程级随机：同一进程内两次调用仍是同一 id（历史语义）
    assert.strictEqual(zenGatekeeper.getSessionId(), headers['x-opencode-session']);
  } finally {
    if (before === undefined) {
      delete process.env.KHY_ZEN_IDENTITY;
    } else {
      process.env.KHY_ZEN_IDENTITY = before;
    }
    zenGatekeeper._reset();
  }
});
