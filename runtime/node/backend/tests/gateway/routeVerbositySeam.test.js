'use strict';

/**
 * routeVerbositySeam.test.js — §5.2 的 π 到底有没有把提示词变薄。
 *
 * 病形与本方案反复打的那一类相同：叶子（`derivePromptPolicy`）有测试，调用方
 * （`khyUpgradeRuntime` 那个 `_lean` 变量）也接了模式轴，而**真正按 verbosity 决定注入
 * 多少脚手架的地方**（`dynamicPromptAssembler` 的 `calibrateScaffolding`：
 * `promptVerbosity:lean ⇒ −3`）用的是它自己那份 `harnessProfile`，那份**不带 modeIntent**。
 * 于是选了「经济」档：档解出 P0、调用方知道 lean、装配侧仍按 tier 算 full ⇒ 提示词一个字没变。
 *
 * 四行按因果排：先证明这个 bump 只可能来自模式轴（第 1 行把轴整个关掉），
 * 再证明 auto 不带它（第 2 行），再证明 economy 带它（第 3 行），
 * 最后证明中文档名在同一条接缝上同样生效（第 4 行，§16.4k 的别名不是只在叶子里成立）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const BE = path.resolve(__dirname, '..', '..');
const assembler = require(BE + '/src/services/dynamicPromptAssembler');
const { makeModelFeatureRegistry } = require(BE + '/src/services/modelFeatureRegistry');

const FEATURES = path.resolve(BE, 'config', 'models', 'features.json');
// T1：tier 默认 verbosity 是 full，所以 −3 只可能来自模式轴（T0 的 lean 会把这条测试变成废话）。
const MODEL = 'gpt-4o';

function levelOf(r) {
  const step = r.meta && Array.isArray(r.meta.steps)
    ? r.meta.steps.find((s) => s && s.step === 'calibrateScaffolding')
    : null;
  assert.ok(step, `结果里没有 calibrateScaffolding 这一步：${JSON.stringify(r.meta && r.meta.degraded)}`);
  return step;
}

function assemble(modeName, modesFlag) {
  const env = {
    KHY_MODEL_ADAPT: '1',
    KHY_ROUTING_MODES: modesFlag,
    GATEWAY_ROUTING_MODE: modeName,
  };
  return assembler.assemblePromptForModel({
    env,
    modelId: MODEL,
    userText: '帮我把这段代码跑一遍',
    contextWindow: 128000,
    registry: makeModelFeatureRegistry({ env: {}, filePath: FEATURES, homeFilePath: path.resolve(BE, 'config', 'models', 'no-such-home.json') }),
  });
}

function hasLeanBump(step) {
  return (step.adjustments || []).filter((a) => a && a.by === 'promptVerbosity:lean');
}

test('前置条件：模式轴关掉时不得出现 promptVerbosity:lean，且等级不是地板（否则 −3 无法观测）', () => {
  const off = levelOf(assemble('economy', '0'));
  assert.equal(hasLeanBump(off).length, 0, `轴关着却有 lean bump：${JSON.stringify(off.adjustments)}`);
  assert.ok(off.level >= 4, `基线等级 ${off.level} 太低，−3 会被 clamp 吃掉，这条测试将恒真`);
});

test('auto 档不带 lean（π 的 auto 分支需要 margin，缺它只会不弃权，不会变薄）', () => {
  const auto = levelOf(assemble('auto', '1'));
  assert.equal(hasLeanBump(auto).length, 0, JSON.stringify(auto.adjustments));
});

test('经济档必须真的把脚手架等级打下来 —— 这是 π 唯一的可观测后果', () => {
  const auto = levelOf(assemble('auto', '1'));
  const eco = levelOf(assemble('economy', '1'));
  const bumps = hasLeanBump(eco);
  assert.equal(bumps.length, 1, `经济档应有且仅有一个 lean bump：${JSON.stringify(eco.adjustments)}`);
  assert.equal(bumps[0].delta, -3, `lean 的加减项应为 −3，实际 ${JSON.stringify(bumps[0])}`);
  assert.ok(
    eco.level < auto.level,
    `档选了、提示词没变薄（等级 auto=${auto.level} eco=${eco.level}）⇒ 接缝又断了`
  );
});

test('中文档名「经济」走同一条接缝（别名不是只在叶子里成立）', () => {
  const ecoEn = levelOf(assemble('economy', '1'));
  const ecoZh = levelOf(assemble('经济', '1'));
  // 只比「两次相等」是不够的：接缝断掉时两次都拿不到 lean，相等照样成立（M23 就是这样漏的）。
  // 所以先各自要求 bump 存在，再要求两者读数相同。
  assert.equal(hasLeanBump(ecoZh).length, 1, `中文档名没走到装配侧：${JSON.stringify(ecoZh.adjustments)}`);
  assert.equal(hasLeanBump(ecoEn).length, 1, `英文档名没走到装配侧：${JSON.stringify(ecoEn.adjustments)}`);
  assert.deepEqual(
    { level: ecoZh.level, lean: hasLeanBump(ecoZh).length },
    { level: ecoEn.level, lean: hasLeanBump(ecoEn).length },
    `中英档名在装配侧结果不同：zh=${JSON.stringify(ecoZh.adjustments)} en=${JSON.stringify(ecoEn.adjustments)}`
  );
});
