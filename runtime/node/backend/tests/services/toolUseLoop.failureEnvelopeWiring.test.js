'use strict';

/**
 * toolUseLoop.failureEnvelopeWiring.test.js — W1 的**证伪-修复**对（自我对抗式）。
 *
 * 背景（[DESIGN-ARCH-198] §2.5）：RUNTIME-005 已要求「CLI/TUI 失败展示必须由结构化失败
 * 信封渲染」，`cliFailureEnvelope.js` 也已实现且门默认开。**实测 khyos 的 TUI 失败路径把
 * 已经渲染好的信封丢掉了** —— 信封在 `aiChatCore.chat()` 里渲染好、随 `reply` + `failureCode`
 * 返回，却被 `toolUseLoopCore` 的错误收口**弃之不用**，改从 `failureDetails` 重新拼散文墙：
 *
 *   aiChatCore  →  reply = 「⚠ …—— 网络不可达 / [NETWORK_ERROR] / 通道: … / → …」  ✅ 已渲染
 *   toolUseLoop →  friendlyMsg = resolveFriendlyFailureMessage(failureDetails)
 *                 = 「具体原因：真实失败原因: - kiro [unavailable]: … 」          ❌ 信封被丢弃
 *
 * 本文件钉死这条不变式，断言的是 **loop 的真实 finalResponse**（不是叶子返回值）。
 *
 * 判据（红→绿）：
 *   ① 上游已渲染信封时，loop 的 finalResponse **必须保留**信封首屏（机器码 + 通道 + 可执行 hint）；
 *   ② 失败文案**不得**出现「具体原因：真实失败原因:」双标签；
 *   ③ 失败文案**不得**只剩通用「输入「继续」」而无任何可执行建议；
 *   ④ 门关 → **逐字节**回退今日行为。
 *
 * 反向对抗（防「测试自己骗自己」）：
 *   - chat() 桩**忠实复刻** aiChatCore 失败返回的真实形状（reply 带信封 + failureCode 带机器码）；
 *   - 断言「上游确实渲染出了信封」——若信封不可渲染，本组断言必须**显式失败**，
 *     否则会退化成「没信封也绿」的假绿。
 */

const path = require('path');

// 每个用例都驱动真实 runToolUseLoop（工具注册表 + hook 加载），单轮冷启即数秒；
// 不设超时会在 5s 默认档上误红（同 toolUseLoop.searchDedupRetry.test.js 的做法）。
jest.setTimeout(60000);

const BE = path.resolve(__dirname, '../..');
const core = require(path.join(BE, 'src/services/tool/toolUseLoop.js'));
const envelopeMod = require(path.join(BE, 'src/services/gateway/cliFailureEnvelope.js'));

const ZEN_ERR = JSON.stringify({
  type: 'error',
  error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached. Free tier resets hourly.' },
});
const AUTH_ERR = JSON.stringify({
  type: 'error',
  error: { type: 'AuthError', message: 'Missing API key.' },
});

/** 复刻截图那轮 attempts：3 个 IDE 适配器不可用 + 1 个真因（上游额度用尽）。 */
function makeAttempts() {
  return [
    { success: false, adapterKey: 'kiro', errorType: 'unavailable', error: 'Kiro IDE unavailable', statusCode: 0 },
    { success: false, adapterKey: 'cursor', errorType: 'unavailable', error: 'Cursor IDE unavailable', statusCode: 0 },
    { success: false, adapterKey: 'trae', errorType: 'unavailable', error: 'Trae IDE unavailable', statusCode: 0 },
    { success: false, adapterKey: 'OpenCode Zen', errorType: 'network', error: ZEN_ERR, statusCode: 429 },
  ];
}

/**
 * 忠实复刻 aiChatCore.chat() 的失败返回形状：
 *   reply        = 信封首屏 + 旧诊断墙（多行，**未被**折叠）
 *   failureCode  = 信封机器码（**仅**信封分支才有 → 可作为「上游已渲染信封」的判别信号）
 *   failureDetails = 多行失败墙
 * 门关时（KHY_CLI_FAILURE_ENVELOPE=0）→ 退化为老散文返回，**不带** failureCode。
 */
function makeFailingChat(attempts, errorType, opts = {}) {
  const env = opts.env || process.env;
  const failureDetails = [
    '真实失败原因:',
    '- kiro [unavailable]: Kiro IDE unavailable',
    '- OpenCode Zen [network]: Free usage limit reached.',
  ].join('\n');

  return async () => {
    const env0 = envelopeMod.buildCliFailureEnvelope({
      result: { success: false, errorType, attempts, preferredAdapter: 'auto' },
      env,
    });
    if (env0 && env0.enabled && env0.ok === false) {
      const head = envelopeMod.renderCliFailureEnvelope(env0);
      if (head) {
        // aiChatCore 的真实形状：reply = 首屏 + '\n\n' + 旧诊断墙
        return {
          reply: `${head}\n\n${failureDetails}`,
          commands: [],
          errorType,
          failureCode: env0.code,
          failureDetails,
          resumable: true,
          continueHint: '输入「继续」即可从断点续写未完成的内容。',
        };
      }
    }
    // 老路径（信封门关 / 不可用）：**无** failureCode
    return {
      reply: `⚠ 本次请求未能完成，AI 服务没有返回回答。\n\n失败信息: 所有 AI 通道均不可用。\n\n${failureDetails}`,
      commands: [],
      errorType,
      failureDetails,
      resumable: true,
      continueHint: '输入「继续」即可从断点续写未完成的内容。',
    };
  };
}

async function runFailingLoop(attempts, errorType, env) {
  const chat = makeFailingChat(attempts, errorType, { env });
  const result = await core.runToolUseLoop('今天有些什么新闻？', {
    chat,
    chatOpts: { maxIterations: 1 },
    maxIterations: 1,
    // 关掉瞬时重试预算：network/timeout 类默认会退避重试（真实网络下是正确行为，
    // 但本测试要的是**终局**失败文案，且退避会让单测超时）。
    maxTransientRecoveries: 0,
    maxEmptyRecoveries: 0,
  });
  return result;
}

describe('W1 · TUI 失败路径必须消费 CLI 失败信封（[DESIGN-ARCH-198] §2.5）', () => {
  const KEY = 'KHY_TUI_FAILURE_ENVELOPE';
  let prev;
  beforeEach(() => {
    prev = process.env[KEY];
    delete process.env[KEY];
  });
  afterEach(() => {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  });

  test('【对抗前置】上游确实渲染出了信封（否则本组断言会是假绿）', () => {
    const env0 = envelopeMod.buildCliFailureEnvelope({
      result: { success: false, errorType: 'network', attempts: makeAttempts(), preferredAdapter: 'auto' },
      env: process.env,
    });
    expect(env0.enabled).toBe(true);
    expect(env0.ok).toBe(false);
    expect(env0.code).toBeTruthy();
    const head = envelopeMod.renderCliFailureEnvelope(env0);
    expect(head).toContain(`[${env0.code}]`);
  });

  test('① 信封首屏进入 loop 的 finalResponse（机器码 + 通道 + 可执行 hint）', async () => {
    const result = await runFailingLoop(makeAttempts(), 'network');
    const text = String(result.finalResponse || '');
    expect(text).toMatch(/\[[A-Z_]+\]/);
    expect(text).toMatch(/→|khy |\/proxy|ai config|gateway status/);
  });

  test('② 不再出现「具体原因：真实失败原因:」双标签', async () => {
    const result = await runFailingLoop(makeAttempts(), 'network');
    const text = String(result.finalResponse || '');
    expect(text).not.toContain('具体原因：真实失败原因');
  });

  test('③ 失败文案不止一句「输入「继续」」——必带可执行建议', async () => {
    const result = await runFailingLoop(makeAttempts(), 'network');
    const text = String(result.finalResponse || '');
    expect(/→|khy |\/proxy|ai config|gateway status|额度|配额/.test(text)).toBe(true);
  });

  test('④ 门关 → 逐字节回退今日行为（老散文墙照旧，不出现信封机器码）', async () => {
    process.env[KEY] = '0';
    const result = await runFailingLoop(makeAttempts(), 'network');
    const text = String(result.finalResponse || '');
    expect(text).not.toMatch(/\[[A-Z_]+\]/);
    expect(text).toContain('真实失败原因');
  });

  test('⑤ auth 类失败（缺 key）也走信封，给出「配 key」方向', async () => {
    const attempts = [
      { success: false, adapterKey: 'OpenCode Zen', errorType: 'auth', error: AUTH_ERR, statusCode: 401 },
      { success: false, adapterKey: 'relay_api', errorType: 'unavailable', error: 'API 中转 unavailable', statusCode: 0 },
    ];
    const result = await runFailingLoop(attempts, 'auth');
    const text = String(result.finalResponse || '');
    expect(text).toMatch(/\[[A-Z_]+\]/);
    expect(text).toMatch(/key|Key|密钥|ai config/);
  });

  test('【对抗】门关时必须与今日行为**逐字节**一致（不是「差不多」）', async () => {
    process.env[KEY] = '0';
    const off = String((await runFailingLoop(makeAttempts(), 'network')).finalResponse || '');
    delete process.env[KEY];
    const on = String((await runFailingLoop(makeAttempts(), 'network')).finalResponse || '');
    // 门关 = 老散文墙路径（无信封机器码、有「真实失败原因:」墙 + 类别前缀）；
    // 门开 = 信封首屏（有机器码）。两者**必须不同**，否则说明门根本没接线（假绿）。
    expect(off).not.toBe(on);
    expect(off).not.toMatch(/\[[A-Z_]+\]/);
    expect(off).toContain('真实失败原因:');
    expect(off).toContain('网络请求未能完成。');
    // ⚠ [DESIGN-ARCH-198] W8 散文层顺序修复后，「具体原因：真实失败原因:」双标签在
    // **两条路径上**都已消除（去重判定早于类别前缀分支）——故这里对 off/on 一致地
    // 断言「不出现」，而不是把双标签当作「门关」的判别式。
    expect(off).not.toContain('具体原因：真实失败原因');
    expect(on).not.toContain('具体原因：真实失败原因');
  });

  test('⑧ W8：信封首屏被沿用时 finalResponse 含中文人话，attempts 原文未丢', async () => {
    const attempts = makeAttempts();
    const result = await runFailingLoop(attempts, 'network');
    const text = String(result.finalResponse || '');
    // 主因（OpenCode Zen 429 免费额度用尽）被翻成中文人话，且不含原始 JSON 结构
    expect(text).toContain('上游免费额度用尽');
    expect(text).toContain('/model');
    expect(text).not.toContain('FreeUsageLimitError');
    // 机器通道：attempts[].error 仍是结构化原文（W8 硬要求 b）
    expect(attempts[3].error).toBe(ZEN_ERR);
    // 信封的机器视图：cause.vendor 只带 type/code/param，不带 message
    const env0 = envelopeMod.buildCliFailureEnvelope({
      result: { success: false, errorType: 'network', attempts, preferredAdapter: 'auto' },
      env: process.env,
    });
    expect(env0.cause.vendor).toEqual({ type: 'FreeUsageLimitError', code: '', param: '' });
    expect(env0.cause.detail).toContain('FreeUsageLimitError');
    expect(env0.cause.human).toBeTruthy();
  });
});
