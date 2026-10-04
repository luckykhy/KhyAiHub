'use strict';

/**
 * timeFormat.test.js — 锁时长格式化的「进位」口径。
 *
 * 回归护栏:sub-second 分支曾用 `ms < 1000` + `Math.round(ms)`,导致
 * 999.5–999.9ms 渲染成 "1000ms"(诊断面板「平均工具耗时」即此路径),
 * 而家族其余分支都会向上一单位进位。现改为 `Math.round(ms) < 1000`。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  formatDurationPrecise,
  formatDurationCompact,
  formatDurationHuman,
} = require('../src/services/timeFormat');

test('进位:999.5–999.9ms 显示为 1s 而非 1000ms', () => {
  for (const ms of [999.5, 999.7, 999.9]) {
    assert.strictEqual(formatDurationPrecise(ms), '1s', `precise ${ms}`);
    assert.strictEqual(formatDurationCompact(ms), '1s', `compact ${ms}`);
    assert.strictEqual(formatDurationHuman(ms), '1s', `human ${ms}`);
  }
});

test('边界下方仍显示 ms', () => {
  assert.strictEqual(formatDurationPrecise(999.4), '999ms');
  assert.strictEqual(formatDurationCompact(500), '500ms');
  assert.strictEqual(formatDurationHuman(500), '500ms');
  assert.strictEqual(formatDurationHuman(0), '0ms');
});

test('常规单位不受影响', () => {
  assert.strictEqual(formatDurationPrecise(1234), '1.23s');
  assert.strictEqual(formatDurationCompact(125000), '2m5s');
  assert.strictEqual(formatDurationCompact(5400000), '1h30m');
  assert.strictEqual(formatDurationCompact(90000000), '1d1h');
  assert.strictEqual(formatDurationHuman(45000), '45s');
  assert.strictEqual(formatDurationHuman(180000), '3m');
});

test('非法/边界输入保持原契约', () => {
  assert.strictEqual(formatDurationPrecise(NaN), 'unknown');
  assert.strictEqual(formatDurationPrecise(Infinity), 'unknown');
  assert.strictEqual(formatDurationCompact(null), undefined);
  assert.strictEqual(formatDurationCompact(0), undefined);
  assert.strictEqual(formatDurationCompact(-5), undefined);
  assert.strictEqual(formatDurationHuman(-5), 'n/a');
  assert.strictEqual(formatDurationHuman(null, '无'), '无');
});
