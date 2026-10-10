'use strict';

/**
 * windowsClipboardAutoStart.test.js — 图片桥「开机常驻」默认档的契约。
 *
 * 默认档翻过一次：文档 [OPS-MAN-058] 一直写「AUTO_START 默认关（按需开）」，代码却因为
 * 一次「更新后粘贴失效」的反馈漂成了默认开，于是每台 Windows 会话白背约 85 MB 常驻内存。
 * 2026-10-03 由人拍板回正到文档口径（选 B：随用随开）。没有这根表针，下一次「为了让某个
 * 用户能用」再翻一次默认值不会有人发现。
 *
 * 双向都卡：未设 → 关；显式真值 → 开。且必须与功能总闸 isEnabledByEnv() 语义不同——
 * 后者关掉后连手动 start 都不起，本闸只管开机起不起。
 */

const assert = require('node:assert');
const test = require('node:test');

const svc = require('../src/services/windowsClipboardImg2FileService');

test('boot-time residency is off unless explicitly asked for', () => {
  assert.strictEqual(svc.shouldAutoStart({}), false);
  for (const off of ['false', '0', 'no', 'off', '']) {
    assert.strictEqual(svc.shouldAutoStart({ KHY_CLIPBOARD_IMG2FILE_AUTO_START: off }), false, `"${off}" stays off`);
  }
  for (const on of ['true', '1', 'yes', 'on', 'TRUE']) {
    assert.strictEqual(svc.shouldAutoStart({ KHY_CLIPBOARD_IMG2FILE_AUTO_START: on }), true, `"${on}" turns it on`);
  }
});

test('the residency gate is not the feature gate', () => {
  // Enabled (feature) defaults ON while auto-start defaults OFF: a session that
  // never auto-starts must still be able to `clipboard bridge start` successfully.
  assert.strictEqual(svc.isEnabledByEnv(), true);
  assert.strictEqual(svc.shouldAutoStart({}), false);
  // Both read the environment, but each its own key — turning the feature off
  // must not be interpretable as "auto-start off only".
  const prev = process.env.KHY_CLIPBOARD_IMG2FILE_ENABLED;
  process.env.KHY_CLIPBOARD_IMG2FILE_ENABLED = '0';
  try {
    assert.strictEqual(svc.isEnabledByEnv(), false);
    assert.strictEqual(svc.shouldAutoStart({}), false, 'feature gate does not drive residency');
  } finally {
    if (prev === undefined) delete process.env.KHY_CLIPBOARD_IMG2FILE_ENABLED;
    else process.env.KHY_CLIPBOARD_IMG2FILE_ENABLED = prev;
  }
  assert.strictEqual(svc.isEnabledByEnv(), true, 'restored');
});

test('bridge status reads without spawning and reports the default-off state', () => {
  const st = svc.getClipboardImg2FileBridgeStatus();
  // Nothing started this bridge in this process, so it must read as not running —
  // and reading it must not have spawned anything (no child, no pid).
  assert.strictEqual(st.running, false);
  assert.strictEqual(st.pid, null);
  assert.strictEqual(st.scriptPath.endsWith('windows-clipboard-img2file.ps1'), true);
});
