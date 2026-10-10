'use strict';

/**
 * P3 隔离注入调用测试（DESIGN-ARCH-047 PHASE 3，安全核心）。
 *
 * 覆盖：
 *   - quarantinePolicy.decide 决策矩阵（本地放行 / 逃生口 / 预批准 / 交互交闸 / 非交互隔离）
 *   - isGateEnabled env 解析（缺省 ON；仅 0/false/off/no 关闭）
 *   - assertNoAutoDangerous 不变式（中转 + 闸开 + 自动开 dangerous → 抛）
 *   - codexAdapter 结构守卫：不再无条件 enableDangerousMode；改经隔离策略裁决
 */

const fs = require('fs');
const path = require('path');

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const quarantine = require('../../../src/services/domain/trajectory/trajectoryProvenance/quarantinePolicy.js');
const { ACTION } = quarantine;

describe('isGateEnabled env 解析', () => {
  test('缺省 ON', () => {
    assert.equal(quarantine.isGateEnabled({}), true);
    assert.equal(quarantine.isGateEnabled({ KHY_TRAJECTORY_QUARANTINE: '' }), true);
    assert.equal(quarantine.isGateEnabled({ KHY_TRAJECTORY_QUARANTINE: '1' }), true);
    assert.equal(quarantine.isGateEnabled({ KHY_TRAJECTORY_QUARANTINE: 'on' }), true);
  });
  test('仅 0/false/off/no 关闭', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF', 'False']) {
      assert.equal(quarantine.isGateEnabled({ KHY_TRAJECTORY_QUARANTINE: v }), false, `${v} 应关闭`);
    }
  });
});

describe('quarantinePolicy.decide 决策矩阵', () => {
  test('本地 origin → 永远放行 + VERIFIED（零回归）', () => {
    const v = quarantine.decide({ producer: 'khy-local', interactive: false, gateEnabled: true });
    assert.equal(v.action, ACTION.ALLOW);
    assert.equal(v.trust, 'verified');
  });

  test('中转 + 闸关闭（逃生口）→ 放行但标 CLAIMED（保留溯源真相）', () => {
    const v = quarantine.decide({ producer: 'codex', interactive: false, gateEnabled: false });
    assert.equal(v.action, ACTION.ALLOW);
    assert.equal(v.trust, 'claimed');
  });

  test('中转 + 闸开 + 已预批准 → 放行 + VERIFIED', () => {
    const v = quarantine.decide({ producer: 'codex', preApproved: true, gateEnabled: true });
    assert.equal(v.action, ACTION.ALLOW);
    assert.equal(v.trust, 'verified');
  });

  test('中转 + 闸开 + 交互式 + 无批准 → 交审批闸', () => {
    const v = quarantine.decide({ producer: 'codex', interactive: true, gateEnabled: true });
    assert.equal(v.action, ACTION.GATE);
    assert.equal(v.trust, 'claimed');
  });

  test('中转 + 闸开 + 非交互 + 无批准 → 隔离不执行（fail-CLOSED）+ QUARANTINED', () => {
    const v = quarantine.decide({ producer: 'codex', interactive: false, gateEnabled: true });
    assert.equal(v.action, ACTION.QUARANTINE);
    assert.equal(v.trust, 'quarantined');
    assert.match(v.reason, /requires approval/);
    assert.match(v.reason, /KHY_TRAJECTORY_QUARANTINE=0/);
  });

  test('未知 producer 视为中转（坍缩 relay）→ 非交互隔离', () => {
    const v = quarantine.decide({ producer: 'weird-agent', interactive: false, gateEnabled: true });
    assert.equal(v.action, ACTION.QUARANTINE);
  });

  test('riskLevel 随判决透传（透明展示）', () => {
    const v = quarantine.decide({ producer: 'codex', interactive: false, gateEnabled: true, riskLevel: 'high' });
    assert.equal(v.riskLevel, 'high');
  });
});

describe('assertNoAutoDangerous 不变式（防呆④）', () => {
  test('未尝试开 dangerous → 不抛', () => {
    assert.doesNotThrow(() => quarantine.assertNoAutoDangerous({ producer: 'codex', enablingDangerous: false, gateEnabled: true }));
  });
  test('本地 origin 即便开 dangerous → 不抛（本地 loop 合法）', () => {
    assert.doesNotThrow(() => quarantine.assertNoAutoDangerous({ producer: 'khy-local', enablingDangerous: true, gateEnabled: true }));
  });
  test('中转 + 闸关闭 + 开 dangerous → 不抛（逃生口）', () => {
    assert.doesNotThrow(() => quarantine.assertNoAutoDangerous({ producer: 'codex', enablingDangerous: true, gateEnabled: false }));
  });
  test('中转 + 闸开 + 自动开 dangerous → 抛（锁死回归）', () => {
    assert.throws(() => quarantine.assertNoAutoDangerous({ producer: 'codex', enablingDangerous: true, gateEnabled: true }), /不变式违背/);
  });
});

describe('codexAdapter 结构守卫', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../../src/services/gateway/adapters/codexAdapter.js'), 'utf-8');

  test('不再无条件 enableDangerousMode（旧漏洞模式已移除）', () => {
    // 形态无关：单行 `if (x) call();` 与花括号块 `if (x) { call(); }` 都要查得动。
    // 只匹单行字面量的守卫会因排版变化而静默失效——2026-09-29 实测 codexAdapter.js:2245-2247
    // 正是花括号形态，于是「旧模式不存在」这条恒真（因为新版也匹不上），安全守卫形同虚设。
    const unguarded = /if \(!wasDangerous\)\s*\{?\s*toolCalling\.enableDangerousMode\(\)/;
    assert.equal(unguarded.test(src), false, '旧的无条件自动批准模式不应再出现');
    // 唯一性比"匹某个反面字面量"更强：整份 adapter 只允许存在一个调用点。
    const calls = src.match(/toolCalling\.enableDangerousMode\(\)/g) || [];
    assert.equal(calls.length, 1, `enableDangerousMode 调用点必须唯一，实测 ${calls.length} 处`);
  });

  test('引入隔离策略并按裁决隔离', () => {
    assert.match(src, /quarantinePolicy/);
    assert.match(src, /ACTION\.QUARANTINE/);
    assert.match(src, /assertNoAutoDangerous/);
  });

  test('开启 dangerous 受 willEnableDangerous 守卫（仅逃生口）', () => {
    assert.match(
      src,
      /if \(willEnableDangerous\)\s*\{?\s*toolCalling\.enableDangerousMode\(\);/,
      '唯一的 enableDangerousMode 调用点必须受 willEnableDangerous 守卫'
    );
  });
});
