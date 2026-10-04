'use strict';

/**
 * onboardingPlan.test.js — 单元**契约**测试（与共置的 README.md / khy.module.json 同层）。
 *
 * 病根：`services/backend/tests/services/onboarding/onboardingPlan.test.js`（160 行）逐条
 * 覆盖解析行为与别名表，但**没有任何测试钉住 onboardingPlan.js 的纯度契约**（必须继续
 * 零依赖、零 IO、绝不抛）。一旦有人往它里面加一个 `require(fs)`，全仓测试照样绿——直到
 * 某个无 TTY 的调用方在导入阶段就炸。本文件补的是那一层：导出面、纯度、绝不抛、确定性、
 * env 只认注入。
 *
 * 注意本文件**自身不是纯叶子**（它读盘、读 env），故头部刻意不把自己写成叶子：这份
 * docstring 只描述被它约束的 onboardingPlan.js。
 *
 * runner：node:test（jest.config.js 按 `require('node:test')` 标记自动忽略本文件）。
 *   node --test src/services/domain/onboarding/onboarding/
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const LEAF_PATH = path.join(__dirname, 'onboardingPlan.js');
const leaf = require('./onboardingPlan.js');
const LEAF_SRC = fs.readFileSync(LEAF_PATH, 'utf8');

const EXPECTED_EXPORTS = [
  'STEP_ORDER',
  'buildHelpText',
  'buildStatusText',
  'buildStepHeader',
  'buildTrustStatusText',
  'buildUnavailableText',
  'buildUnknownStepText',
  'describeStep',
  'isEnabled',
  'isStepAvailable',
  'parseOnboardingArgs',
];

test('契约 1 导出面：不多不少。新增导出要同时改 khy.module.json 的 contract 段', () => {
  assert.deepStrictEqual(Object.keys(leaf).sort(), EXPECTED_EXPORTS);
});

test('契约 2 纯度：叶子自身零依赖（源码里不存在任何模块加载调用）', () => {
  // 连注释里都不写其字面形态是这叶子的刻意约束（躲 ghost-dependency 扫描器），
  // 所以这条正则不需要剥注释——命中即说明真的长了依赖。
  assert.ok(!/\brequire\s*\(/.test(LEAF_SRC), 'onboardingPlan.js 里出现了模块加载调用，纯度契约破了');
  assert.ok(!/\b(process\.env|fs\.readFileSync|child_process)\b/.test(LEAF_SRC), '叶子不得自己读环境或读盘');
});

test('契约 3 绝不抛：垃圾入参全部安全返回', () => {
  const junk = [undefined, null, NaN, 0, '', '   ', [], {}, () => {}, Symbol.iterator, 10n, true];
  for (const v of junk) {
    assert.doesNotThrow(() => leaf.parseOnboardingArgs(v), `parseOnboardingArgs(${String(v)})`);
    assert.doesNotThrow(() => leaf.describeStep(v), `describeStep(${String(v)})`);
    assert.doesNotThrow(() => leaf.isStepAvailable(v), `isStepAvailable(${String(v)})`);
    assert.doesNotThrow(() => leaf.buildUnavailableText(v));
    assert.doesNotThrow(() => leaf.buildUnknownStepText(v));
    assert.doesNotThrow(() => leaf.buildStepHeader(v));
    assert.doesNotThrow(() => leaf.isEnabled(v === true ? {} : v), 'isEnabled 需要一个可索引的 env 形状');
    for (const arg of [v, { cwd: v, trusted: v, persistedCount: v, reason: v }]) {
      assert.doesNotThrow(() => leaf.buildStatusText(arg), `buildStatusText(${String(v)})`);
      assert.doesNotThrow(() => leaf.buildTrustStatusText(arg), `buildTrustStatusText(${String(v)})`);
    }
  }
});

test('契约 4 确定性：同一入参两次调用逐字节相同', () => {
  const snap = { onboardingDone: true, configured: false, activeTheme: 'dark', mcpServerCount: 2 };
  assert.strictEqual(leaf.buildStatusText(snap), leaf.buildStatusText(snap));
  assert.strictEqual(leaf.buildHelpText(), leaf.buildHelpText());
  const trust = { gateEnabled: true, cwd: '/tmp/x', trusted: true, reason: 'persisted', persistedCount: 1 };
  assert.strictEqual(leaf.buildTrustStatusText(trust), leaf.buildTrustStatusText(trust));
});

test('契约 5 env 只认注入：进程环境里的门控值必须被忽略', () => {
  const KEY = 'KHY_ONBOARDING_COMMAND';
  const saved = process.env[KEY];
  process.env[KEY] = '0';
  try {
    // 传一个不含该键的 env 对象 → 叶子必须按「默认开」返回，而不是回头看 process.env。
    assert.strictEqual(leaf.isEnabled({}), true, '叶子偷读了 process.env，注入契约破了');
    // 显式注入关闭值才关得掉。
    assert.strictEqual(leaf.isEnabled({ [KEY]: '0' }), false);
  } finally {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  }
});

test('契约 6 步骤表自洽：STEP_ORDER 与元数据一一对应，且 help 列全', () => {
  const help = leaf.buildHelpText();
  for (const step of leaf.STEP_ORDER) {
    assert.strictEqual(leaf.isStepAvailable(step), true, `${step} 应可委托真实 SSOT`);
    assert.ok(help.includes(`/onboarding ${step}`), `help 文本漏了 ${step}`);
  }
  assert.strictEqual(leaf.STEP_ORDER.length, 6);
});

test('契约 7 诚实留白：缺面不得编造成「是/否」', () => {
  const empty = leaf.buildStatusText({});
  assert.ok(empty.includes('引导完成标记: 未知'), empty);
  assert.ok(empty.includes('当前主题: 未知'), empty);
  const trustEmpty = leaf.buildTrustStatusText({});
  assert.ok(trustEmpty.includes('当前目录: 未知'), trustEmpty);
  assert.ok(trustEmpty.includes('已持久化信任目录: 未知'), trustEmpty);
});
