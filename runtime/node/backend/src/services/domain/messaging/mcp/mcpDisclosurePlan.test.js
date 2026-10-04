/**
 * mcpDisclosurePlan.test.js — 钉死渐进披露计划器的阈值算术与开关词汇。
 *
 * 为什么这支套件必须存在：planMcpDisclosure 决定所有 MCP 工具目录是内联进系统
 * 提示还是整体降为 shouldDefer 延迟披露——这是对 token 预算有直接影响的纯函数，
 * 但它的 off 词汇与全仓 flagRegistry CANON 四词族（0/false/off/no）不一致：
 * 只有字面 '0' 能关闭，'false'/'off'/'no' 都会保持开启。无测试则无人能察觉。
 *
 * 实测更正（与源码注释/上游直觉不同处，按真实语义钉死）：
 * 1. isDisclosureEnabled 只认 exact '0'（源码注释写 env-overridable，但关闭词表
 *    是单位集合 {'0'}）— 'false'/'off'/'no'/'1'/'True' 全部返回 true — 实测钉住。
 * 2. planMcpDisclosure(null) 抛 TypeError：默认参数 `= {}` 只兜 undefined，
 *    对 null 的解构直接崩 — 实测钉住。
 * 3. overBudget 用严格大于：estTokens 恰等于 budgetTokens 时仍是 'inline'。
 * 4. estimateToolTokens(null) 抛（默认参数同上）；数组中的 null 元素被 continue 跳过。
 * 5. 循环引用 schema 计 +256 字符再除 4 → 64 token（catch 分支补偿值，不是 256 token）。
 * 6. KHY_MCP_DISCLOSURE_THRESHOLD_PCT 必须有限且 >0，'0'/'-1'/'abc'/'' 全回退默认 0.15。
 * 7. contextWindowTokens 以 `||` 优先于 env — 传 0 会被 env 或默认值接管，无法显式置 0。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('./mcpDisclosurePlan');

function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try { return fn(); } finally {
    if (had) process.env[name] = prev;
    else delete process.env[name];
  }
}

test('disclosure: 导出面钉死 + 默认常量', () => {
  assert.deepStrictEqual(Object.keys(leaf).sort(), [
    'DEFAULT_CONTEXT_WINDOW_TOKENS', 'DEFAULT_THRESHOLD_PCT',
    'estimateToolTokens', 'isDisclosureEnabled', 'planMcpDisclosure',
  ]);
  assert.equal(leaf.DEFAULT_THRESHOLD_PCT, 0.15);
  assert.equal(leaf.DEFAULT_CONTEXT_WINDOW_TOKENS, 32000);
});

test('disclosure: 关闭词汇只有字面 0 —— false/off/no 均保持开启（实测钉住偏差）', () => {
  for (const off of ['false', 'off', 'no', '1', 'TRUE', ' ']) {
    withEnv('KHY_MCP_DISCLOSURE', off, () => {
      assert.equal(leaf.isDisclosureEnabled(), true, `KHY_MCP_DISCLOSURE=${off} 竟然关闭了`);
    });
  }
  withEnv('KHY_MCP_DISCLOSURE', '0', () => {
    assert.equal(leaf.isDisclosureEnabled(), false);
  });
  withEnv('KHY_MCP_DISCLOSURE', undefined, () => {
    assert.equal(leaf.isDisclosureEnabled(), true); // 默认 ON
  });
});

test('disclosure: estimateToolTokens 字符→token 向上取整，4 字符/token', () => {
  // 名字 8 + 描述 8 = 16 chars → 4 tokens（非空输入断言）
  assert.equal(leaf.estimateToolTokens([{ name: 'abcdefgh', description: 'abcdefgh' }]), 4);
  assert.equal(leaf.estimateToolTokens([]), 0);
  assert.equal(leaf.estimateToolTokens(), 0); // undefined 走默认参数
  assert.equal(leaf.estimateToolTokens([null, undefined]), 0); // 空元素被跳过
  assert.equal(leaf.estimateToolTokens([{ name: null, description: undefined }]), 0);
  // schema 参与字符计数
  const withSchema = leaf.estimateToolTokens([{ name: 'a', inputJSONSchema: { type: 'object' } }]);
  assert.ok(withSchema > 0);
  assert.throws(() => leaf.estimateToolTokens(null), TypeError); // null 不走默认参数
});

test('disclosure: 循环 schema 补偿 256 字符（=64 token），不是 256 token', () => {
  const circ = {};
  circ.self = circ;
  assert.equal(leaf.estimateToolTokens([{ name: '', inputJSONSchema: circ }]), 64);
});

test('disclosure: plan 算术 —— 预算=floor(window×pct)，严格大于才 deferred', () => {
  const envClean = () => {
    const saved = {
      t: process.env.KHY_MCP_DISCLOSURE_THRESHOLD_PCT,
      w: process.env.KHY_MCP_DISCLOSURE_WINDOW,
    };
    delete process.env.KHY_MCP_DISCLOSURE_THRESHOLD_PCT;
    delete process.env.KHY_MCP_DISCLOSURE_WINDOW;
    return () => {
      if (saved.t !== undefined) process.env.KHY_MCP_DISCLOSURE_THRESHOLD_PCT = saved.t;
      if (saved.w !== undefined) process.env.KHY_MCP_DISCLOSURE_WINDOW = saved.w;
    };
  };
  const restore = envClean();
  try {
    const p = leaf.planMcpDisclosure({ toolCount: 3, estTokens: 150, contextWindowTokens: 1000 });
    assert.equal(p.budgetTokens, 150);
    assert.equal(p.mode, 'inline'); // 150 == 150 不越界
    const p2 = leaf.planMcpDisclosure({ toolCount: 3, estTokens: 151, contextWindowTokens: 1000 });
    assert.equal(p2.mode, 'deferred');
    assert.deepStrictEqual(Object.keys(p2).sort(), ['budgetTokens', 'contextWindowTokens', 'estTokens', 'mode', 'thresholdPct', 'toolCount'].sort());
    // toolCount 为 0 时即使巨量 token 也不 defer（&& 短路）
    assert.equal(leaf.planMcpDisclosure({ toolCount: 0, estTokens: 10 ** 9, contextWindowTokens: 100 }).mode, 'inline');
    // enabled:false 一票否决
    assert.equal(leaf.planMcpDisclosure({ toolCount: 5, estTokens: 10 ** 9, contextWindowTokens: 100 }, { enabled: false }).mode, 'inline');
    // 默认 window = 32000 → 预算 4800
    const d = leaf.planMcpDisclosure({ toolCount: 1, estTokens: 4801 });
    assert.equal(d.budgetTokens, 4800);
    assert.equal(d.contextWindowTokens, 32000);
    assert.equal(d.mode, 'deferred');
    assert.throws(() => leaf.planMcpDisclosure(null), TypeError);
  } finally { restore(); }
});

test('disclosure: env 阈值/窗口必须有限且 >0，否则回退默认', () => {
  for (const bad of ['0', '-1', 'abc', '', 'Infinity', 'NaN']) {
    withEnv('KHY_MCP_DISCLOSURE_THRESHOLD_PCT', bad, () => {
      withEnv('KHY_MCP_DISCLOSURE_WINDOW', bad, () => {
        const p = leaf.planMcpDisclosure({});
        assert.equal(p.thresholdPct, 0.15, `pct='${bad}' 未回退`);
        assert.equal(p.contextWindowTokens, 32000, `window='${bad}' 未回退`);
      });
    });
  }
  withEnv('KHY_MCP_DISCLOSURE_THRESHOLD_PCT', '0.5', () => {
    withEnv('KHY_MCP_DISCLOSURE_WINDOW', '2000', () => {
      const p = leaf.planMcpDisclosure({});
      assert.equal(p.thresholdPct, 0.5);
      assert.equal(p.budgetTokens, 1000);
      // 显式 contextWindowTokens 以 || 优先于 env
      const p2 = leaf.planMcpDisclosure({ contextWindowTokens: 4000 });
      assert.equal(p2.contextWindowTokens, 4000);
      // 显式 0 被 || 吞掉 → 回落到 env 2000（无法显式置 0，实测钉住）
      const p3 = leaf.planMcpDisclosure({ contextWindowTokens: 0 });
      assert.equal(p3.contextWindowTokens, 2000);
    });
  });
});
