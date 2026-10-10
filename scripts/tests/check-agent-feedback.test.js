'use strict';

/**
 * check-agent-feedback.test.js — 模态判定的反例矩阵（`RUNTIME-007/008/009` 执行器）。
 *
 * 复现的真实缺陷：`ENTRY_HINTS` 那一权重原先只看路径、不看改动状态，
 * 于是**修改**一个 `src/cli/handlers/*.js` 也被记作「新增顶层入口 +0.30」，
 * BUILD 压过 FIX → 守卫改去索要 requirement-5q.md，而矩阵里唯一的 error 级
 * 判据 `fix-without-repro` 在最常见的改代码路径上永远轮不到。
 *
 * 全部离线：只调纯函数 `detectMode()`，不 spawn、不读盘。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectMode, SCENARIOS } = require('../ci/check-agent-feedback.js');

const HANDLER = 'runtime/node/backend/src/cli/handlers/receipts.js';
const ROUTE = 'runtime/node/backend/src/routes/export.js';
const PLAIN = 'runtime/node/backend/src/services/foo.js';

// ── 缺陷本体：入口路径的权重必须绑定「新增」状态 ──────────────────────────────

test('修改 CLI handler + 「修复」语句 → FIX，且不在混合带', () => {
  const det = detectMode([{ status: 'M', path: HANDLER }], '修复 receipts 动词槽 typo 静默渲染列表');
  assert.equal(det.mode, 'FIX');
  assert.equal(det.ambiguous, false, `混合带会逼着写 mode.json 并让 Rule 5 让位：${det.reasons}`);
});

test('修改 routes 入口 → 不再被记作「新增顶层入口」', () => {
  const det = detectMode([{ status: 'M', path: ROUTE }], '修复导出页报错');
  assert.equal(det.mode, 'FIX');
  assert.equal(det.reasons.filter((r) => r.includes('新增顶层入口')).length, 0);
});

test('删除 CLI handler → DELETE 单模态（曾被入口权重拖进混合带）', () => {
  const det = detectMode([{ status: 'D', path: HANDLER }], '随便改点什么');
  assert.equal(det.mode, 'DELETE');
  assert.equal(det.ambiguous, false);
});

test('正向对照：新增 CLI handler 仍是 BUILD（入口权重没有丢失）', () => {
  const det = detectMode([{ status: 'A', path: HANDLER }], '帮我加一个批量导出功能');
  assert.equal(det.mode, 'BUILD');
  assert.ok(
    det.reasons.some((r) => r.includes('新增顶层入口')),
    `入口权重应当只对 A 生效：${det.reasons}`
  );
});

test('非入口路径的修改行为不变（未被本次修复波及）', () => {
  const det = detectMode([{ status: 'M', path: PLAIN }], '这个命令没有反应');
  assert.equal(det.reasons.filter((r) => r.includes('新增顶层入口')).length, 0);
});

// ── 词表：Rule 5 的正文用词必须能命中 FIX ────────────────────────────────────

test('「修复」计入 FIX（AGENTS.md 规则 5 的原话是「修复 bug」）', () => {
  const bare = detectMode([], '修复一个东西');
  const hit = bare.reasons.find((r) => r.startsWith('FIX +'));
  assert.ok(hit, `修复 未命中 FIX 词表：${bare.reasons}`);
  assert.equal(bare.mode, 'FIX');
});

test('既有 FIX 词表未被改动（报错/失败/异常 仍计 FIX）', () => {
  for (const s of ['登录偶尔报错', '导出失败', '网关异常']) {
    assert.equal(detectMode([], s).mode, 'FIX', `${s} 应判 FIX`);
  }
});

test('BUILD 词表不因新增 FIX 词而漂移', () => {
  for (const s of ['加一个导出功能', '新增命令', '支持批量']) {
    assert.equal(detectMode([], s).mode, 'BUILD', `${s} 应判 BUILD`);
  }
});

// ── 场景矩阵防漂移：每个预置场景的主模态就是它要演示的那个 ────────────────────

const SCENARIO_MODES = {
  'fix-no-repro': 'FIX',
  'fix-with-repro': 'FIX',
  'build-no-questions': 'BUILD',
  'delete-mass': 'DELETE',
  'delete-documented': 'DELETE',
  mixed: 'DELETE',
  ambiguous: 'FIX',
};

test('内置场景的主模态逐个保持（改分类逻辑不许把演示样本改掉）', () => {
  for (const [name, expected] of Object.entries(SCENARIO_MODES)) {
    const preset = SCENARIOS[name];
    assert.ok(preset, `场景 ${name} 不存在`);
    const changes = preset.files.map((s) => ({
      status: s.slice(0, 1).toUpperCase(),
      path: s.slice(2),
    }));
    assert.equal(detectMode(changes, preset.say).mode, expected, `${name} 主模态漂移`);
  }
});

test('ambiguous 场景仍留在混合带（本次修复不许顺手抹掉它要演示的东西）', () => {
  const preset = SCENARIOS.ambiguous;
  const changes = preset.files.map((s) => ({
    status: s.slice(0, 1).toUpperCase(),
    path: s.slice(2),
  }));
  assert.equal(detectMode(changes, preset.say).ambiguous, true);
});
