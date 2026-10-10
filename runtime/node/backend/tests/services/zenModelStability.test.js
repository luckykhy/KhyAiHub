'use strict';

/**
 * zenModelStability.test.js — Zen 免费模型「抖动评分」账本契约。
 *
 * 背景（用户实测 2026-10-09，存证 works/data/khy/feedback/upstream-truth-label-20261009/）：
 * step-5-preview-free 同日 429/200 交替，mimo-v2.6-flash-free 稳定，但用户选中前零知情。
 * 本套件锁死：冷启动无样本不打标（绝不误报）、样本足时按失败率判 stable/flappy、
 * 24h 窗口外的样本不参与、门控关读写全停、垃圾输入绝不抛。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MIN_SAMPLES,
  isEnabled,
  recordOutcome,
  classify,
  suggestStableAlternative,
  _reset,
} = require('../../src/services/zenModelStability');

function _tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `khy-stab-${t.name.replace(/\W/g, '')}-`));
  return path.join(dir, 'stability.json');
}

function _fresh(t) {
  _reset();
  const file = _tmpFile(t);
  process.env.KHY_ZEN_STABILITY_FILE = file;
  return file;
}

// ── 门控 ────────────────────────────────────────────────────────────────────

test('isEnabled: 默认开；0/false/off/no 关', () => {
  assert.strictEqual(isEnabled({}), true);
  for (const v of ['0', 'false', 'OFF', 'no']) {
    assert.strictEqual(isEnabled({ KHY_ZEN_MODEL_STABILITY: v }), false, v);
  }
});

test('门关：record 不落盘、classify 恒 null', () => {
  const file = _fresh({ name: 'gateoff' });
  delete process.env.KHY_ZEN_STABILITY_FILE;
  process.env.KHY_ZEN_STABILITY_FILE = file;
  process.env.KHY_ZEN_MODEL_STABILITY = '0';
  try {
    recordOutcome('m-free', false, { env: process.env });
    assert.strictEqual(fs.existsSync(file), false, '门关不应写盘');
    assert.strictEqual(classify('m-free', { env: process.env }), null);
  } finally {
    delete process.env.KHY_ZEN_MODEL_STABILITY;
  }
});

// ── 冷启动 / 判级 ───────────────────────────────────────────────────────────

test('冷启动无样本 → classify null（列表不打标，不误报）', () => {
  _fresh({ name: 'cold' });
  assert.strictEqual(classify('never-seen-free', { env: process.env }), null);
});

test(`样本 < ${MIN_SAMPLES} → null（宁可无标记不误报）`, () => {
  _fresh({ name: 'few' });
  for (let i = 0; i < MIN_SAMPLES - 1; i++) {
    recordOutcome('m-free', false, { env: process.env });
  }
  assert.strictEqual(classify('m-free', { env: process.env }), null);
});

test('连续 5 次失败 → flappy，失败率 1.0', () => {
  _fresh({ name: 'flappy' });
  for (let i = 0; i < 5; i++) {
    recordOutcome('step-5-preview-free', false, { env: process.env, statusCode: 429 });
  }
  const d = classify('step-5-preview-free', { env: process.env });
  assert.ok(d);
  assert.strictEqual(d.tier, 'flappy');
  assert.strictEqual(d.failRate, 1);
  assert.strictEqual(d.samples, 5);
  assert.ok(/抖动/.test(d.label), 'flappy 标签应含「抖动」');
});

test('4 成功 + 1 失败（率 0.2）→ stable', () => {
  _fresh({ name: 'stable' });
  for (let i = 0; i < 4; i++) {
    recordOutcome('mimo-v2.6-flash-free', true, { env: process.env });
  }
  recordOutcome('mimo-v2.6-flash-free', false, { env: process.env, statusCode: 429 });
  const d = classify('mimo-v2.6-flash-free', { env: process.env });
  assert.ok(d);
  assert.strictEqual(d.tier, 'stable');
  assert.ok(Math.abs(d.failRate - 0.2) < 1e-9);
});

test('24h 窗口外的旧样本不参与判级', () => {
  const file = _fresh({ name: 'window' });
  const stale = { 'old-free': { outcomes: [{ ok: false, at: Date.now() - 25 * 60 * 60 * 1000 }] } };
  fs.writeFileSync(file, JSON.stringify(stale), 'utf-8');
  _reset();
  recordOutcome('old-free', true, { env: process.env });
  assert.strictEqual(classify('old-free', { env: process.env }), null, '旧样本应被剪掉');
});

// ── suggestStableAlternative ────────────────────────────────────────────────

test('suggestStableAlternative: 排除自身，挑样本最多且失败的 stable 项', () => {
  _fresh({ name: 'alt1' });
  for (let i = 0; i < 6; i++) {
    recordOutcome('mimo-v2.6-flash-free', true, { env: process.env });
  }
  for (let i = 0; i < 5; i++) {
    recordOutcome('qwen-something-free', true, { env: process.env });
  }
  for (let i = 0; i < 5; i++) {
    recordOutcome('step-5-preview-free', false, { env: process.env, statusCode: 429 });
  }
  assert.strictEqual(
    suggestStableAlternative('step-5-preview-free', { env: process.env }),
    'mimo-v2.6-flash-free',
    '样本最多的 stable 项胜出'
  );
});

test('suggestStableAlternative: 只剩自己一个 stable 项时 → null（不推荐自己）', () => {
  _fresh({ name: 'alt2' });
  for (let i = 0; i < 5; i++) {
    recordOutcome('mimo-v2.6-flash-free', true, { env: process.env });
  }
  assert.strictEqual(suggestStableAlternative('mimo-v2.6-flash-free', { env: process.env }), null);
  assert.strictEqual(
    suggestStableAlternative('mimo-v2.6-flash-free', { env: process.env }),
    null
  );
});

test('suggestStableAlternative: 无 stable 候选 / 门关 / 垃圾输入 → null，绝不抛', () => {
  _fresh({ name: 'alt3' });
  for (let i = 0; i < 5; i++) {
    recordOutcome('a-free', false, { env: process.env });
  }
  assert.strictEqual(suggestStableAlternative('a-free', { env: process.env }), null);
  assert.strictEqual(
    suggestStableAlternative('a-free', { env: { KHY_ZEN_MODEL_STABILITY: '0' } }),
    null
  );
  assert.doesNotThrow(() => suggestStableAlternative('', { env: process.env }));
  assert.doesNotThrow(() => suggestStableAlternative(null, { env: process.env }));
});

// ── 健壮性 ──────────────────────────────────────────────────────────────────

test('垃圾输入绝不抛：空 id / 非布尔 ok / 重复记录去重到窗口上限', () => {
  _fresh({ name: 'robust' });
  assert.doesNotThrow(() => recordOutcome('', false, { env: process.env }));
  assert.doesNotThrow(() => recordOutcome(null, true, { env: process.env }));
  assert.doesNotThrow(() => classify('', { env: process.env }));
  assert.doesNotThrow(() => recordOutcome('m-free', 'not-a-bool', { env: process.env }));
  assert.strictEqual(classify('m-free', { env: process.env }), null);
});

test('滚动窗口：只留最近 MAX_OUTCOMES 条，账本不无限增长', () => {
  _fresh({ name: 'roll' });
  for (let i = 0; i < 50; i++) {
    recordOutcome('m-free', i % 2 === 0, { env: process.env });
  }
  const state = JSON.parse(fs.readFileSync(process.env.KHY_ZEN_STABILITY_FILE, 'utf-8'));
  assert.ok(state['m-free'].outcomes.length <= 30, '窗口应封顶');
});
