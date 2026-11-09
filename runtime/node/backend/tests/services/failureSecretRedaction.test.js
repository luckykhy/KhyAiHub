'use strict';

/**
 * failureSecretRedaction.test.js — 失败展示路径的**密钥不外泄**不变式（[DESIGN-ARCH-198] §7.9）。
 *
 * 背景（**本轮引入的越界** + **既有漏洞**）：
 *   W1 把 CLI 失败信封首屏接到 TUI 失败路径时，实测发现：
 *   `cliFailureEnvelope` **此前完全没有脱敏** → 上游 401 体里的明文 `sk-proj-…`
 *   被原样透给用户（REPL 路径早已如此，W1 又把它**扩到了 TUI 路径**）。
 *   旧 TUI 路径之所以安全，是因为失败墙**恰好**会流经
 *   `resolveFriendlyFailureMessage → sanitizeCause`（脱敏单一真源）——
 *   **是巧合兜住，不是设计兜住**。W1 绕过那道兜底，漏洞就显形了。
 *
 * 本文件钉死：**任何用户可见的失败文案都不得含明文密钥**。
 *   ① 信封首屏（`cliFailureEnvelope` 的 cause.detail 源头脱敏）
 *   ② 失败墙条目（CLI 侧 `_formatGatewayFailureDetails` 源头脱敏）
 *   ③ 两条路径**同款**口径（都走 honestFailureReason.sanitizeCause）
 *
 * ⚠ [DESIGN-ARCH-198] W8（2026-11-01）**契约变更**（安全性收紧，不是退化）：
 *   人话化把 `shown` 与信封首屏第 3 行换成固定中文模板后，「脱敏≠抹掉」这条不变式的
 *   **载体**从「脱敏后的上游文本」换成「固定中文模板」⇒ 人读面从此**不再出现密钥的
 *   掩码形态 `***`**（`cause.detail` / `attempts[].error` 仍是掩码形态，
 *   `_redactDetail` / `_redactWallEntry` 一字未动）。这是更严，不是更松——
 *   后来者不得把「人读面不含 `***`」当回归去「修」。
 *
 * 反向对抗：
 *   - 用**真实**的产品构造器（不是桩字面量）产出墙与信封；
 *   - 断言「脱敏后的墙仍保留结构与真因信息」（不是把内容全抹掉来蒙混过关）。
 */

const path = require('path');

// ⑤ 端到端驱动真实 runToolUseLoop（加载工具注册表 + 14~22 个 hook），冷启即 ~10s；
// 不设超时会在 5s 默认档上误红（同 toolUseLoop.searchDedupRetry.test.js 的做法）。
jest.setTimeout(60000);

const BE = path.resolve(__dirname, '../..');
const helpers = require(path.join(BE, 'src/cli/aiGatewayGenerateHelpers.js'));
const envelopeMod = require(path.join(BE, 'src/services/gateway/cliFailureEnvelope.js'));
const core = require(path.join(BE, 'src/services/tool/toolUseLoop.js'));

const SECRET = 'sk-proj-abcdefghijklmnopqrstuvwx';
const BEARER = 'Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnop';

// [DESIGN-ARCH-198] W8：人话化后的固定中文模板（与 cliErrorDescriptor.HUMAN_SENTENCES 对齐）。
const HUMAN_AUTH = '认证失败 (401)：上游以认证错误拒绝了本次请求，请运行 ai config 更新该通道的 API Key';
const HUMAN_UNAVAILABLE =
  '通道不可用：该通道未注册、未启用或未安装，请运行 khy gateway status 查看各通道实测状态；或运行 /model 换用其它通道';

function makeAttempts() {
  return [
    { success: false, adapterKey: 'OpenCode Zen', errorType: 'auth', error: `auth failed with ${SECRET}`, statusCode: 401 },
    { success: false, adapterKey: 'kiro', errorType: 'unavailable', error: 'Kiro IDE unavailable', statusCode: 0 },
  ];
}

describe('§7.9 · 失败展示路径不得外泄明文密钥', () => {
  test('① 信封首屏的 cause.detail 已脱敏（源头修）', () => {
    const env0 = envelopeMod.buildCliFailureEnvelope({
      result: { success: false, errorType: 'auth', attempts: makeAttempts(), preferredAdapter: 'auto' },
      env: process.env,
    });
    expect(env0.cause.detail).not.toContain(SECRET);
    expect(env0.cause.detail).toContain('***');
    // 脱敏≠抹掉：通道名/状态码/真因语义仍在
    expect(env0.cause.adapter).toBe('OpenCode Zen');
    expect(env0.cause.statusCode).toBe(401);
    expect(env0.cause.detail).toContain('auth failed');
    // 机器通道仍可取到结构化原文（W8 硬要求 b）：attempts[].error 一字不改
    expect(env0.attempts[0].error).toBe(`auth failed with ${SECRET}`);
  });

  test('② 信封首屏渲染结果不含明文密钥', () => {
    const env0 = envelopeMod.buildCliFailureEnvelope({
      result: { success: false, errorType: 'auth', attempts: makeAttempts(), preferredAdapter: 'auto' },
      env: process.env,
    });
    const head = envelopeMod.renderCliFailureEnvelope(env0);
    expect(head).not.toContain(SECRET);
    expect(head).toContain('[AUTH_FAILED]');
  });

  test('③ 真实失败墙（产品构造器产出）已脱敏，且保留结构与真因', () => {
    const wall = helpers._formatGatewayFailureDetails({
      success: false,
      errorType: 'auth',
      attempts: makeAttempts(),
    });
    expect(wall).not.toContain(SECRET);
    // W8 契约变更：人读面只剩固定中文模板，**连掩码形态都不再出现**。
    expect(wall).not.toContain('***');
    // 人话句必须真的上桌，且不得夹带原始 JSON 结构
    expect(wall).toContain(HUMAN_AUTH);
    expect(wall).not.toContain('{');
    expect(wall).not.toContain('"type"');
    // 结构与真因信息不丢（两行都在、通道名在）
    expect(wall).toContain('- OpenCode Zen (401) [auth]');
    expect(wall).toContain(`- kiro [unavailable]: ${HUMAN_UNAVAILABLE}`);
  });

  test('④ bearer 形态也脱敏', () => {
    const wall = helpers._formatGatewayFailureDetails({
      success: false,
      errorType: 'auth',
      attempts: [
        { success: false, adapterKey: 'X', errorType: 'auth', error: `call failed with ${BEARER}`, statusCode: 401 },
      ],
    });
    expect(wall).not.toContain(BEARER);
    // W8：人读面不含掩码形态，只剩固定中文模板
    expect(wall).not.toContain('***');
    expect(wall).toContain(HUMAN_AUTH);
  });

  test('⑤ 端到端：loop 的 finalResponse 不含明文密钥（信封首屏 + 展开层两处）', async () => {
    const attempts = makeAttempts();
    const gatewayResult = { success: false, errorType: 'auth', content: '所有 AI 通道均不可用。', attempts, preferredAdapter: 'auto' };
    const wall = helpers._formatGatewayFailureDetails(gatewayResult);
    const env0 = envelopeMod.buildCliFailureEnvelope({ result: gatewayResult, env: process.env });
    const head = envelopeMod.renderCliFailureEnvelope(env0);

    const result = await core.runToolUseLoop('今天有些什么新闻？', {
      chat: async () => ({
        reply: `${head}\n\n${wall}`,
        commands: [],
        errorType: 'auth',
        failureCode: env0.code,
        failureDetails: wall,
        attempts,
        preferredAdapter: 'auto',
        resumable: true,
      }),
      chatOpts: { maxIterations: 1 },
      maxIterations: 1,
      maxTransientRecoveries: 0,
      maxEmptyRecoveries: 0,
    });
    const out = String(result.finalResponse || '');
    expect(out).not.toContain(SECRET);
    // W8：人读面不含掩码形态，只剩固定中文模板
    expect(out).not.toContain('***');
    expect(out).toContain(HUMAN_AUTH);
    // 信封首屏与展开层**都在**（信息不丢）
    expect(out).toContain('[AUTH_FAILED]');
    expect(out).toContain('真实失败原因');
  });

  test('⑥ 零回归：不含密钥的正常失败文案逐字节不变', () => {
    const wall = helpers._formatGatewayFailureDetails({
      success: false,
      errorType: 'network',
      attempts: [
        { success: false, adapterKey: 'kiro', errorType: 'unavailable', error: 'Kiro IDE unavailable', statusCode: 0 },
      ],
    });
    // 人话化正是要把这行英文机器串翻掉（与用户截图诉求一致）
    expect(wall).toContain(`- kiro [unavailable]: ${HUMAN_UNAVAILABLE}`);
    expect(wall).not.toContain('***');
  });

  test('⑦ 门关（H=0）→ 人话叶子根本不被调用，墙行逐字节回退今日', () => {
    const prev = process.env.KHY_FAILURE_HUMAN_TEXT;
    process.env.KHY_FAILURE_HUMAN_TEXT = '0';
    try {
      const wall = helpers._formatGatewayFailureDetails({
        success: false,
        errorType: 'auth',
        attempts: makeAttempts(),
      });
      expect(wall).toBe(
        [
          '真实失败原因:',
          '- OpenCode Zen (401) [auth]: auth failed with ***',
          '- kiro [unavailable]: Kiro IDE unavailable',
        ].join('\n')
      );
      const head = envelopeMod.renderCliFailureEnvelope(
        envelopeMod.buildCliFailureEnvelope({
          result: { success: false, errorType: 'auth', attempts: makeAttempts(), preferredAdapter: 'auto' },
          env: process.env,
        })
      );
      expect(head).toContain('通道: OpenCode Zen (401) [auth] — auth failed with ***');
    } finally {
      if (prev === undefined) delete process.env.KHY_FAILURE_HUMAN_TEXT;
      else process.env.KHY_FAILURE_HUMAN_TEXT = prev;
    }
  });
});
