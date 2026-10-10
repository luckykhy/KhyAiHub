'use strict';
/**
 * promptStructurer 方法论扩展的静态契约（[DESIGN-PROMPT-003] §4 / §10 落地映射）：
 * METHOD_RULES 注入条件、愿望词黑名单单一真源、inspectPrompt 体检内核。纯叶子，零 IO。
 */
const assert = require('node:assert');

const COMPLEX =
  '帮我重构支付模块，必须保证向后兼容、不能破坏现有接口、注意不要引入循环依赖；先梳理依赖，然后分批迁移，最后跑一遍回归测试。输出迁移清单。';

describe('promptStructurer methodology ([DESIGN-PROMPT-003])', () => {
  const S = require('../src/services/promptStructurer');

  test('复杂任务产 ```spec + 方法论规则，原文逐字保留', () => {
    const out = S.buildStructuredPrompt(COMPLEX, {});
    assert.ok(out, '复杂任务应产出结构化结果');
    assert.ok(out.includes('```spec'), '复杂任务应含 ```spec');
    assert.ok(out.includes('## 方法论规则 / Method Rules'), '复杂任务应含方法论规则块');
    assert.ok(out.includes('标「待确认」并提问'), '应含反幻觉规则行');
    assert.ok(out.includes(COMPLEX), '原文必须逐字保留');
  });

  test('确定性：同一输入两次调用逐字节一致', () => {
    const a = S.buildStructuredPrompt(COMPLEX, {});
    const b = S.buildStructuredPrompt(COMPLEX, {});
    assert.strictEqual(a, b);
  });

  test('简单请求逐字节回退（返 null，不改写）', () => {
    assert.strictEqual(S.buildStructuredPrompt('你好', {}), null);
    assert.strictEqual(S.buildStructuredPrompt('帮我看看这个函数', {}), null);
  });

  test('幂等：已结构化的文本不再包裹', () => {
    const out = S.buildStructuredPrompt(COMPLEX, {});
    assert.strictEqual(S.buildStructuredPrompt(out, {}), null);
  });

  test('主门关 → 全程回退', () => {
    assert.strictEqual(S.buildStructuredPrompt(COMPLEX, { KHY_PROMPT_STRUCTURING: '0' }), null);
  });

  test('方法论子门控关 → spec 仍在、规则块不追加', () => {
    const out = S.buildStructuredPrompt(COMPLEX, {
      KHY_PROMPT_STRUCTURING: '1',
      KHY_PROMPT_STRUCTURING_METHOD_RULES: '0',
    });
    assert.ok(out.includes('```spec'), '父门开时 spec 不受影响');
    assert.ok(!out.includes('## 方法论规则 / Method Rules'), '子门控关时不追加规则块');
    assert.ok(out.includes(COMPLEX), '原文仍逐字保留');
  });

  test('findWishwords：中英文愿望词命中且去重', () => {
    assert.deepStrictEqual(S.findWishwords('帮我写个更专业的报告'), ['更专业']);
    assert.deepStrictEqual(S.findWishwords('要幽默点、接地气'), ['幽默点', '接地气']);
    assert.deepStrictEqual(S.findWishwords('keep it short and concise'), ['short and concise']);
    assert.deepStrictEqual(S.findWishwords('把函数改成 snake_case 并补测试'), []);
  });

  test('inspectPrompt：愿望词扣分 + 收口识别 + 复杂任务两查', () => {
    const bad = S.inspectPrompt('帮我写个更专业的周报');
    const ids = bad.findings.map((f) => f.id);
    assert.ok(ids.includes('wishword'), '命中愿望词');
    assert.ok(ids.includes('no-closing'), '未声明收口');
    assert.ok(bad.score < 100 && bad.grade !== '良好');

    const good = S.inspectPrompt(COMPLEX);
    assert.ok(!good.findings.some((f) => f.id === 'wishword'), '无愿望词');
    assert.ok(!good.findings.some((f) => f.id === 'no-closing'), '「输出迁移清单」应被收口规则识别');
    assert.ok(good.complex, '应判为复杂任务');
  });

  test('inspectPrompt：简单请求不触发复杂任务两查', () => {
    const r = S.inspectPrompt('输出格式：markdown 表格');
    assert.strictEqual(r.complex, false);
    assert.ok(!r.findings.some((f) => f.id === 'no-branch'), '简单请求不查条件分支');
    assert.ok(!r.findings.some((f) => f.id === 'no-antihallucination'), '简单请求不查反幻觉');
  });

  test('METHOD_RULES 常量含三条硬规则', () => {
    assert.ok(S.METHOD_RULES.includes('不编造事实'));
    assert.ok(S.METHOD_RULES.includes('显式说明取舍'));
    assert.ok(S.METHOD_RULES.includes('可执行的下一步'));
  });
});