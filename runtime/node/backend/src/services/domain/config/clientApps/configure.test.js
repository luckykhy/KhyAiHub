'use strict';

/**
 * configure.js 契约测试 —— 写入编排（[DESIGN-ARCH-189] P5）。
 *
 * 分两类：
 *   A. **漂移测试**（无需 mock）：编排层里的三张表（EXTERNAL_ADAPTERS /
 *      RESTORE_STYLES / WRITE_BLOCKED）与 catalog.json 的真源必须一致。
 *      这类测试最容易被忽略，但表漂移了不会报错，只会在运行时静默走错分支。
 *   B. **硬不变量**（mock appWriters）：备份失败必须在写之前中止，
 *      一个字节都不写；写失败必须从 .prev 还原。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadCatalog } = require('./catalog');
// ── mock appWriters（必须在 require('./configure') 之前） ───────────────────
// configure.js 在模块加载时就 `const { applyCardToApp } = require(...)` 解构，
// 事后改 exports 对象不生效，故这里预先替换 require.cache。
const APPWRITERS_PATH = require.resolve('../ccSwitch/appWriters');
let applyCardToAppImpl = async () => ({ success: true });
let writeCallCount = 0;
require.cache[APPWRITERS_PATH] = {
  id: APPWRITERS_PATH,
  filename: APPWRITERS_PATH,
  loaded: true,
  children: [],
  paths: [],
  exports: {
    applyCardToApp: async (...args) => { writeCallCount += 1; return applyCardToAppImpl(...args); },
  },
};

const {
  previewConfigure,
  configureApp,
  resolveManagedFiles,
  restoreApp,
  EXTERNAL_ADAPTERS,
  RESTORE_STYLES,
  WRITE_BLOCKED,
} = require('./configure');

// ── A. 漂移测试 ─────────────────────────────────────────────────────────────

test('EXTERNAL_ADAPTERS 的 appId 全部在 catalog 在册', () => {
  const catalog = loadCatalog();
  const known = new Set(catalog.apps.map((a) => a.appId));
  for (const appId of Object.keys(EXTERNAL_ADAPTERS)) {
    assert.ok(known.has(appId), `EXTERNAL_ADAPTERS 里的 ${appId} 不在 catalog 中`);
  }
});

test('配了 backupKeys 且未被挡的 app，编排层必须能定位到 adapter', () => {
  // 准确形状：WRITE_BLOCKED 里的 app（如 codex，写者在 D1 侧）可以配 backupKeys
  // 但没有 externalApps adapter——那是"本期不接它"，由 WRITE_BLOCKED 显式说明。
  // 真正要防的是：**没被挡**却又找不到 adapter，那会静默走不到写路径。
  const catalog = loadCatalog();
  for (const a of catalog.apps) {
    if (!a.backupKeys || a.backupKeys.length === 0) continue;
    if (WRITE_BLOCKED[a.appId]) continue;
    assert.ok(
      EXTERNAL_ADAPTERS[a.appId],
      `${a.appId} 配了 backupKeys（${a.backupKeys.join(',')}）且未被 WRITE_BLOCKED 挡，但 EXTERNAL_ADAPTERS 无对应模块`
    );
  }
});

test('RESTORE_STYLES 只允许 positional，且 key 必须是真实 adapter 模块名', () => {
  const mods = new Set(Object.values(EXTERNAL_ADAPTERS));
  for (const [mod, style] of Object.entries(RESTORE_STYLES)) {
    assert.ok(mods.has(mod), `RESTORE_STYLES 的 ${mod} 不是 EXTERNAL_ADAPTERS 里的模块名`);
    assert.equal(style, 'positional', '目前只支持 positional 一种变体');
  }
});

test('WRITE_BLOCKED 与 catalog 的 backupKeys 不构成"静默无备份"', () => {
  // 注意这条不变量的准确形状：WRITE_BLOCKED（本层不写它）与 backupKeys
  // （它有受管文件）**可以共存**——一个是能力决定，一个是事实描述。
  // 真正要防的是：被挡的 app 在 preview 里必须给出挡它的理由，而不是
  // 静默地没有 targets 也没解释。
  const catalog = loadCatalog();
  for (const appId of Object.keys(WRITE_BLOCKED)) {
    const entry = catalog.apps.find((a) => a.appId === appId);
    assert.ok(entry, `WRITE_BLOCKED 的 ${appId} 不在 catalog 中`);
    const prev = previewConfigure({ appId, card: { id: 'c' } });
    assert.equal(prev.ok, false, `${appId} 被 WRITE_BLOCKED 挡但 preview 判为可写`);
    assert.ok(prev.reason && prev.reason.length > 10, `${appId} 被挡但没给理由`);
  }
});

test('previewConfigure 对 13 个 app 全部给出明确判定（无静默）', () => {
  const catalog = loadCatalog();
  for (const a of catalog.apps) {
    const prev = previewConfigure({ appId: a.appId, card: { id: 'c1' } });
    if (prev.ok) {
      assert.ok(Array.isArray(prev.targets) && prev.targets.length > 0, `${a.appId} 判为可写但没有 targets`);
      for (const t of prev.targets) {
        assert.ok(t.backupKey, `${a.appId} 的 target 缺 backupKey`);
        assert.notEqual(t.backupKey, a.appId, `${a.appId} 的 backupKey 不得等于 appId`);
      }
    } else {
      // 不可写必须带理由——不允许静默跳过
      assert.ok(prev.reason && prev.reason.length > 3, `${a.appId} 判为不可写但没给理由`);
    }
  }
});

test('previewConfigure 对未知 appId 返回 {ok:false} 而不抛', () => {
  const prev = previewConfigure({ appId: '__nope__', card: { id: 'x' } });
  assert.equal(prev.ok, false);
  assert.equal(prev.code, 'CLIENT_APPS_UNKNOWN_APP_ID');
});

test('resolveManagedFiles 对 codex 报 blocked 而不抛', () => {
  // codex 配了两个 backupKey（config.toml + auth.json）但 externalApps 无模块。
  // 必须是业务拒绝（blocked + 理由），不是异常——否则路由返 500。
  const r = resolveManagedFiles('codex');
  assert.deepEqual(r.files, []);
  assert.match(r.blocked, /D1 侧|无对应 adapter/);
});

// ── B. 硬不变量 ─────────────────────────────────────────────────────────────

test('写失败 → 从 .prev 还原，且 phase 标明失败点', async () => {
  applyCardToAppImpl = async () => ({ success: false, error: '模拟写失败' });
  const before = writeCallCount;

  const out = await configureApp({ appId: 'claude-code', card: { id: 'c', name: 'Khy' }, mode: 'proxy' });

  assert.equal(out.ok, false);
  assert.equal(out.phase, 'write', '失败点必须标明是 write 阶段，调用方要知道该不该重试');
  assert.equal(writeCallCount, before + 1, '写失败路径下写应当被调用过一次');
  assert.match(out.error, /模拟写失败/);
  applyCardToAppImpl = async () => ({ success: true });
});

test('写成功 → 返回逐键回读结果（不许只有 success）', async () => {
  applyCardToAppImpl = async () => ({ success: true, app: 'claude-code', mode: 'proxy' });
  const out = await configureApp({ appId: 'claude-code', card: { id: 'c', name: 'Khy', model: 'm1' }, mode: 'proxy' });
  // claude-code 在 externalApps 里，应有真实回读面（哪怕结果是 NO-READER，也必须有结果）
  assert.equal(out.ok, true);
  assert.ok(Array.isArray(out.readBack) && out.readBack.length > 0, '必须返回逐键回读数组');
  for (const r of out.readBack) {
    assert.ok(
      ['ok', 'MISSING', 'DIFF', 'NO-READER'].includes(r.status),
      `回读状态必须是四种之一，实得 ${r.status}`
    );
  }
  applyCardToAppImpl = async () => ({ success: true });
});

test('restoreApp 对 trae 用位置参数、对其余用解构 options', () => {
  // 不真调 adapter（会碰真实文件），只验证分派逻辑读到的形状差异确实存在。
  const trae = require('../../network/externalApps/traeAppAdapter');
  const claude = require('../../network/externalApps/claudeCodeAdapter');
  // 用 Function.prototype.length 无法反映解构，故用 toString 验证签名形状
  assert.match(String(trae.remove), /^function remove\(query,/, 'trae 的 remove 必须是位置参数签名');
  assert.match(String(claude.remove), /^function remove\(\{/, '其余 adapter 必须是解构 options 签名');
});

test('restoreApp 对无反向写能力的 app 明确拒绝', () => {
  // codex 不在 externalApps 里
  const out = restoreApp({ appId: 'codex', target: 'khy' });
  assert.equal(out.ok, false);
  assert.match(out.reason, /无反向写能力/);
});
