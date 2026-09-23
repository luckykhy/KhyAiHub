'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  discoverAdapters,
  validateFixtureCoverage,
  validateResult,
  validateSourceContract,
} = require('../quality-gate/provider-contract');

describe('provider contract gate', () => {
  test('discovers every generate exporter and has an exact fixture set', () => {
    const files = discoverAdapters();
    const names = files.map((file) => path.basename(file));

    // ⚠ 这里**不要**写死一个适配器编号（2026-09-24 修，同一形态第三次复发）。
    // 写死编号必然腐烂：适配器一增一减数值就漂，整条 `test:scripts` 变红，
    // 而这个数字对真正的契约没有任何信息量 —— 前两轮（09-19 / 09-23）都在「调数字」，
    // 调完不久又漂。真正的契约由 validateFixtureCoverage 双向断言：
    //   missing = 发现了 generate 却没有 fixture 配方 → 报出具体文件名
    //   stale   = 有 fixture 配方但适配器已不存在   → 报出具体文件名
    // 新增适配器只要没补配方，就会带名字失败，比「18 !== 19」可诊断得多。
    //
    // 本测试只补两件 validateFixtureCoverage 管不到的事：
    //   ① 发现面不能「塌」——整体塌陷（ADAPTER_DIR 变更、子进程探针全挂）会让
    //      discovered 与 FIXTURES 同时为空，双向一致于是「静默全绿」；
    //   ② 薄壳适配器不能被漏掉（它们最容易被误判成「不是适配器」）。
    assert.ok(
      names.length >= 15,
      `discoverAdapters 只发现 ${names.length} 个 generate 导出，远低于预期 —— ` +
        '通常是发现逻辑坏了（ADAPTER_DIR 变更 / 子进程探针失败），而不是适配器真被删光了'
    );
    assert.ok(
      names.includes('commandCodeAdapter.js'),
      'commandCodeAdapter.js 是 cliToolAdapter 的薄壳但仍导出 generate（KHY_COMMANDCODE，opt-in），必须被覆盖'
    );

    assert.doesNotThrow(() => validateFixtureCoverage(files));
    for (const file of files) assert.doesNotThrow(() => validateSourceContract(file));
  });

  test('projects canonical content to requested text shape', () => {
    const projected = validateResult('fixtureAdapter.js', {
      success: true,
      content: 'fixture text',
      tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      model: 'fixture-model',
    });
    assert.deepEqual(projected, {
      text: 'fixture text',
      tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      model: 'fixture-model',
    });
  });

  test('catches deliberately broken adapter return fields', () => {
    const file = path.join('tmp', 'brokenAdapter.js');
    const base = {
      success: true,
      content: 'ok',
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 1 },
      model: 'fixture-model',
    };
    assert.throws(() => validateResult(file, { ...base, content: '' }), /text\/content/);
    assert.throws(() => validateResult(file, { ...base, tokenUsage: null }), /tokenUsage/);
    assert.throws(() => validateResult(file, { ...base, tokenUsage: { totalTokens: 1 } }), /inputTokens/);
    assert.throws(() => validateResult(file, { ...base, model: null }), /model/);
    assert.throws(() => validateResult(file, { ...base, success: false }), /failure/);
  });
});
