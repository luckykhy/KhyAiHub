'use strict';

/**
 * footerModelIntent 纯叶子单测。
 *
 * 契约只有一条：Auto 是用户的**选择**，getActiveAdapter() 返回的具体通道只是
 * 「现在能用的通道」。前者必须压过后者 —— 否则页脚/横幅把 Auto 显示成上一次
 * 成功的模型名，用户会以为偏好被改掉了。
 */
const { resolveFooterModel } = require('../../../src/cli/footerModelIntent');

describe('footerModelIntent', () => {
  test('autoIntent 优先于 getActiveAdapter 解析出的具体模型', () => {
    expect(
      resolveFooterModel({
        activeModel: 'agnes-3.0-flash',
        preferredModel: undefined,
        autoIntent: true,
      })
    ).toBe('auto');
  });

  test('非 Auto：沿用解析出的具体模型', () => {
    expect(
      resolveFooterModel({
        activeModel: 'agnes-3.0-flash',
        preferredModel: 'agnes-2.0-flash',
        autoIntent: false,
      })
    ).toBe('agnes-3.0-flash');
  });

  test('非 Auto 且没有解析结果：退回环境里钉住的模型', () => {
    expect(
      resolveFooterModel({
        activeModel: '',
        preferredModel: 'gpt-5-codex',
        autoIntent: false,
      })
    ).toBe('gpt-5-codex');
  });

  test('全空：历史兜底仍是 auto', () => {
    expect(resolveFooterModel({})).toBe('auto');
  });

  test('只有显式 true 才算 Auto 意图（不接受真值串）', () => {
    expect(
      resolveFooterModel({ activeModel: 'cli', autoIntent: 'true' })
    ).toBe('cli');
  });
});
