'use strict';

/**
 * check-agent-feedback-ambiguity.test.js — 「零信号不得判歧义」的回归锁。
 *
 * ⚠ 本文件与同目录的 `check-agent-feedback.test.js`（**他人未跟踪的在途件**，
 * mtime 2026-09-23）是**互补**关系，刻意不合并：那份锁的是 `ENTRY_HINTS` 的
 * 状态绑定与场景矩阵；本份锁的是 `ambiguous` 的**信号前提**。合并会动到别人的在途文件。
 *
 * ## 要防的头号问题：「无信号」被当成「信号冲突」
 *
 * 2026-09-26 实测：一次**纯文档改动**（单文件 `M`、纯增 62 行、0 删除）被报 5 条 WARN，
 * 其中 `mode-undeclared` 的理由是「同时命中 FIX 与 BUILD（差 0.00 < 0.15）」——
 * 而**同一次运行的 `reasons` 是空数组**，一条规则都没命中。
 *
 * 根因：`detectMode` 初值把 FIX 与 BUILD **各播种 0.05**，零命中时两值相等、分差恒 0.00
 * ⇒ 恒落在 `AMBIGUITY_BAND(0.15)` 内。**歧义的前提是「有信号且互相冲突」，不是「没信号」。**
 *
 * ## 断言不空转
 *
 * 只断言「零信号不判歧义」会被「把 `ambiguous` 直接写死 false」蒙混过关。
 * 故第 2 组是**反向验证**（真冲突必须仍判歧义），第 3 组验证单侧信号不构成歧义 ——
 * 三组合起来才真的把判据锚在「两侧都有信号」上。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const CHECKER = path.resolve(__dirname, '..', 'ci', 'check-agent-feedback.js');
const { detectMode } = require(CHECKER);

const DOC = 'docs/04_IMPL_实现/其它实现/[IMPL-DOC-001] 任务完成判断地图.md';

// ── 第 1 组：零信号不得判歧义 ─────────────────────────────────────────────
test('零规则命中 → 不判歧义（基值播种不得冒充信号）', () => {
  const det = detectMode([{ status: 'M', path: DOC }], '');
  assert.equal(det.reasons.length, 0, '本用例前提：一条规则都不命中');
  assert.deepEqual(
    det.signals,
    { FIX: 0, BUILD: 0, DELETE: 0 },
    'signals 必须全 0，否则前提不成立、本用例变空转'
  );
  assert.equal(det.ambiguous, false, '零信号不得判歧义');
});

// ── 第 2 组：反向验证 —— 真冲突必须仍判歧义（防把 ambiguous 写死 false）──
test('两侧都有真实信号且分差在带内 → 仍判歧义', () => {
  const det = detectMode(
    [
      { status: 'A', path: 'services/backend/src/services/foo.js' },
      { status: 'D', path: 'services/backend/src/services/bar.js' },
    ],
    ''
  );
  assert.ok(det.signals.BUILD > 0 && det.signals.DELETE > 0, `两侧都必须真有信号：${det.reasons}`);
  const gap = Math.abs(det.ranked[0].score - det.ranked[1].score);
  assert.ok(gap < 0.15, `分差须落在歧义带内，实测 ${gap}`);
  assert.equal(det.ambiguous, true, '真冲突必须仍判歧义');
});

// ── 第 3 组：单侧信号不构成歧义（另一侧的 0.05 只是基值）────────────────
test('仅单侧有信号 → 不判歧义', () => {
  const det = detectMode([{ status: 'A', path: 'services/backend/src/services/foo.js' }], '');
  assert.ok(det.signals.BUILD > 0, 'BUILD 必须真有信号');
  assert.equal(det.signals.FIX, 0, 'FIX 必须无信号');
  assert.equal(det.ambiguous, false, '单侧信号不构成歧义');
});

// ── 第 4 组：**已知的另一处失真**，锁行为以便将来修改必须是有意的 ─────────
test('characterization：任务语句含「修复」会把纯文档改动判成 FIX（本轮不改）', () => {
  // 用户原话「…避免一次很大的改变改坏无法修复」里的「修复」是**描述风险**，
  // 不是**本批做过的事**；但 STATEMENT_FEATURES 的 FIX 正则含 `修复` ⇒ +0.40。
  // 本用例不主张这是正确行为，只把当前读数钉住：谁要改这条正则，必须是有意的。
  const det = detectMode(
    [{ status: 'M', path: DOC }],
    '这样即使中间出错也可以回到上一步完成时的状态，避免一次很大的改变改坏无法修复'
  );
  assert.equal(det.mode, 'FIX', '当前行为：被判成 FIX');
  assert.equal(det.ambiguous, false, '分差 0.40 远超带宽 ⇒ 不判歧义（这一半是对的）');
  assert.match(det.reasons.join('\n'), /任务语句命中/, '分数须来自任务语句，而非文件状态');
});

// ── 端到端：纯文档改动不得再被索要 FIX 四件套 ────────────────────────────
test('端到端：单文件 M 的纯文档改动 → 无 mode-undeclared、无 fix-without-repro', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-feedback-e2e-'));
  const evidence = path.join(dir, 'evidence');
  fs.mkdirSync(evidence, { recursive: true });

  const res = cp.spawnSync(
    process.execPath,
    [CHECKER, `--files=M:${DOC}`, `--evidence=${evidence}`],
    { encoding: 'utf8' }
  );
  const out = `${res.stdout || ''}${res.stderr || ''}`;

  // 修复前这两条必现；修复后必须消失
  assert.doesNotMatch(out, /mode-undeclared/, '零信号不得再要求显式声明主模态');
  assert.doesNotMatch(out, /fix-without-repro/, '纯文档改动不得被索要复现存证');

  // 非空转：BUILD 主模态的存证校验必须**仍在跑** —— 缺 requirement-5q.md 要报出来。
  // 若某天有人把证据校验整段短路，这一条会红。
  assert.match(out, /build-without-questions/, 'BUILD 主模态的存证校验必须仍然生效');

  fs.rmSync(dir, { recursive: true, force: true });
});
