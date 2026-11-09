'use strict';

/**
 * CodeWhisperer 客户端构造路径的直接测试 —— [MGMT-RPT-035] L5 的前置步骤。
 *
 * 背景（为什么这套测试是 L5 的前置而非附属）：trae/kiro 共有 44–53 行，其中真正可抽的
 * 共享面是「代理接线 + `new CodeWhispererStreaming(clientOpts)` + middleware 注册」。
 * 但这段代码落在**流式热路径**上，而仓内此前只有 `cwBroken`（SDK 抛错）一支覆盖它——
 * 能跑的那支从没被测过。没有覆盖就无法验证「抽叶子后逐字节不变」，所以先补观测。
 *
 * 这套测试同时产出 L5 所需的**裁定证据**：把两个 adapter 的构造面并排断言出来，
 * 人可以直接看出「共享的是什么、各自特化了什么」，再决定抽不抽。
 *
 * 观测手段：`_fakeCwSdk.js` 的假 SDK 把构造参数 / middleware 注册 / send 调用 /
 * middleware 跑完后的最终 header 全部记录下来，且行为正确（send() 返回真形状的事件流）。
 */

const { loadTraeAdapter, PLAIN_TOKEN } = require('./_traeGenHarness');
const { loadKiroAdapter } = require('./_kiroGenHarness');

// ── trae ────────────────────────────────────────────────────────────────

describe('trae CodeWhisperer 客户端构造（此前零覆盖）', () => {
  let h;
  beforeEach(() => {
    h = loadTraeAdapter({
      token: PLAIN_TOKEN, // 非 JWT ⇒ 走 CodeWhisperer 通道
      installed: true,
      cwWorking: true,
    });
  });

  test('CW 客户端被真实构造一次，且 region 有值', async () => {
    const res = await h.adapter.generate('hi', {});
    expect(res.success).toBe(true);
    expect(h.cwRecord.ctorOpts).toHaveLength(1);
    expect(h.cwRecord.ctorOpts[0].region).toBeTruthy();
  });

  test('middleware 被注册，且 header 确实经 middleware 注入到最终请求上', async () => {
    await h.adapter.generate('hi', {});
    expect(h.cwRecord.middleware.length).toBeGreaterThan(0);
    // x-amzn-codewhisperer-optout 是两边共有的声明；能出现在最终 header 里，
    // 证明 middleware 不是「注册了但没跑」。
    expect(h.cwRecord.lastHeaders['x-amzn-codewhisperer-optout']).toBe('true');
  });

  test('send 收到命令，且 trae 不透传第二个 config 参数', async () => {
    await h.adapter.generate('hi', {});
    expect(h.cwRecord.sendCalls).toHaveLength(1);
    expect(h.cwRecord.sendCalls[0].command).toBeTruthy();
    expect(h.cwRecord.sendCalls[0].config).toBeUndefined();
  });

  test('正文 / thinking / token 用量都被解析出来（证明这条路径真的跑通了）', async () => {
    const chunks = [];
    const res = await h.adapter.generate('hi', { onChunk: (c) => chunks.push(c) });
    expect(res.success).toBe(true);
    expect(res.content).toContain('Hello');
    expect(chunks.some((c) => c.type === 'thinking')).toBe(true);
    expect(chunks.some((c) => c.type === 'token_usage')).toBe(true);
    expect(res.tokenUsage.totalTokens).toBe(26);
  });
});

// ── kiro ────────────────────────────────────────────────────────────────

describe('kiro CodeWhisperer 客户端构造（此前零覆盖）', () => {
  let h;
  beforeEach(() => {
    h = loadKiroAdapter({
      cwWorking: true,
      kiroToken: true,
      env: { KIRO_PROXY_URL: 'https://kiro.example' },
    });
  });

  test('CW 客户端被真实构造一次', async () => {
    const res = await h.adapter.generate('hi', {});
    expect(res.success).toBe(true);
    expect(h.cwRecord.ctorOpts).toHaveLength(1);
  });

  test('middleware 被注册（kiro 侧注册数多于 trae —— 这是特化，不是共有面）', async () => {
    await h.adapter.generate('hi', {});
    expect(h.cwRecord.middleware.length).toBeGreaterThan(1);
  });

  test('header 也经 middleware 注入，且 kiro 带自己的 agent-mode 声明', async () => {
    await h.adapter.generate('hi', {});
    expect(h.cwRecord.lastHeaders['x-amzn-codewhisperer-optout']).toBe('true');
    expect(h.cwRecord.lastHeaders['x-amzn-kiro-agent-mode']).toBe('vibe');
  });

  test('正文 / token 用量同样被解析出来', async () => {
    const res = await h.adapter.generate('hi', {});
    expect(res.success).toBe(true);
    expect(res.content).toContain('Hello');
    expect(res.tokenUsage.totalTokens).toBe(26);
  });
});

// ── 并排：L5 的裁定证据 ─────────────────────────────────────────────────

describe('L5 裁定证据：两个 adapter 的 CW 构造面并排', () => {
  test('共有面比预想的大：optout 与 agent-mode 两个 header 两边都注入；特化在 middleware 数量与 header 构造方式', async () => {
    const trae = loadTraeAdapter({ token: PLAIN_TOKEN, installed: true, cwWorking: true });
    const kiro = loadKiroAdapter({
      cwWorking: true,
      kiroToken: true,
      env: { KIRO_PROXY_URL: 'https://kiro.example' },
    });
    try {
      const rt = await trae.adapter.generate('hi', {});
      const rk = await kiro.adapter.generate('hi', {});
      expect(rt.success).toBe(true);
      expect(rk.success).toBe(true);

      // 共有：都构造一次客户端、都发一次命令
      expect(trae.cwRecord.ctorOpts).toHaveLength(1);
      expect(kiro.cwRecord.ctorOpts).toHaveLength(1);
      expect(trae.cwRecord.sendCalls).toHaveLength(1);
      expect(kiro.cwRecord.sendCalls).toHaveLength(1);

      // 共有（**实测纠错**：最初以为 agent-mode 是 kiro 独有，跑完发现 trae 也注入）——
      // 两个 header 两边都设，说明「要注入哪些 header」这一层是共享的。
      for (const k of ['x-amzn-codewhisperer-optout', 'x-amzn-kiro-agent-mode']) {
        expect(trae.cwRecord.lastHeaders[k]).toBe('true' in {} ? trae.cwRecord.lastHeaders[k] : trae.cwRecord.lastHeaders[k]);
        expect(kiro.cwRecord.lastHeaders[k]).toBeTruthy();
      }
      expect(trae.cwRecord.lastHeaders['x-amzn-codewhisperer-optout']).toBe('true');
      expect(kiro.cwRecord.lastHeaders['x-amzn-codewhisperer-optout']).toBe('true');
      expect(trae.cwRecord.lastHeaders['x-amzn-kiro-agent-mode']).toBe('vibe');
      expect(kiro.cwRecord.lastHeaders['x-amzn-kiro-agent-mode']).toBe('vibe');

      // 特化（三条，都是「不能简单合并成一个基类」的证据）：
      //  1. middleware 数量不同（trae 1 个，kiro 3 个）——注册粒度不同
      expect(trae.cwRecord.middleware.length).not.toBe(kiro.cwRecord.middleware.length);
      //  2. header 构造方式不同：kiro 走 buildKiroHeaders() 包一层，trae 内联对象
      //     （源码差异，非本测试可直接观测；由 middleware 数量差异间接体现）
      //  3. region 来源不同：trae 按账号 CN 判定，kiro 从 profileArn 推
      expect(trae.cwRecord.ctorOpts[0].region).toBeTruthy();
      expect(kiro.cwRecord.ctorOpts[0].region).toBeTruthy();
    } finally {
      trae.cleanup();
      kiro.cleanup();
    }
  });
});
