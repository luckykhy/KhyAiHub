'use strict';

/**
 * failureWall.formatting.test.js — W3/W4/W6 的**证伪-修复**对（自我对抗式）。
 *
 * 三个根因（[DESIGN-ARCH-198] §2.2/§2.3/§2.6，2026-11-01 用户实测截图）：
 *   W3 失败墙被**压扁 + 截断 + 叠双标签** → 「具体原因：真实失败原因: - kiro … - cursor …」
 *      （实测 31/31 失败墙**全部**命中，100% 必现）
 *   W4 上游真因**认不出** → FreeUsageLimitError 只剩标签、advice 空 → 只给通用「输入「继续」」；
 *      AuthError/Missing API key **完全认不出**（返 null）
 *   W6 失败尝试**平级罗列** → 「本机没装 IDE」被选成主因，真因被埋到末位
 *
 * 反向对抗：
 *   - 用**真实**的上游错误体（JSON 信封）当夹具；
 *   - 断言「混装/未剥形态**确实**坏」——否则本组是假绿；
 *   - 断言「门关 → 与今日**逐字节**一致」，而不是「差不多」。
 */

const path = require('path');

const BE = path.resolve(__dirname, '../..');
const honest = require(path.join(BE, 'src/services/honestFailureReason.js'));
const truth = require(path.join(BE, 'src/services/gateway/upstreamTruthLabel.js'));
const envelope = require(path.join(BE, 'src/services/gateway/cliFailureEnvelope.js'));
const helpers = require(path.join(BE, 'src/cli/aiGatewayGenerateHelpers.js'));
const descriptor = require(path.join(BE, 'src/services/cliErrorDescriptor.js'));

const ZEN_ERR = JSON.stringify({
  type: 'error',
  error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached. Free tier resets hourly.' },
});
const AUTH_ERR = JSON.stringify({
  type: 'error',
  error: { type: 'AuthError', message: 'Missing API key.' },
});

const WALL = [
  '真实失败原因:',
  '- kiro [unavailable]: Kiro IDE unavailable',
  '- cursor [unavailable]: Cursor IDE unavailable',
  '- trae [unavailable]: Trae IDE unavailable',
  '- OpenCode Zen +1 个适配器 [上游 FreeUsageLimitError]: Free usage limit reached. Free…',
].join('\n');

describe('W3 · 失败墙保留换行 + 不叠双标签（[DESIGN-ARCH-198] §2.2）', () => {
  // ⚠ 契约提醒：`resolveFriendlyFailureMessage` 的 env 走 **`options.env`**
  // （且与其它参数**同一个对象**）——传成第二个参数会被静默忽略、env 回落 process.env。
  const OFF = {
    errorType: 'unknown',
    cause: WALL,
    legacyFriendly: 'legacy',
    options: {
      env: {
        KHY_HONEST_FAILURE: '1',
        KHY_FAILURE_WALL_KEEP_LINES: '0',
        KHY_FAILURE_CAUSE_DEDUP: '0',
      },
    },
  };
  const ON = {
    errorType: 'unknown',
    cause: WALL,
    legacyFriendly: 'legacy',
    options: {
      env: {
        KHY_HONEST_FAILURE: '1',
        KHY_FAILURE_WALL_KEEP_LINES: '1',
        KHY_FAILURE_CAUSE_DEDUP: '1',
      },
    },
  };

  test('【对抗前置】今日行为确实压扁成一行且叠双标签（否则本组是假绿）', () => {
    const legacy = honest.resolveFriendlyFailureMessage(OFF);
    expect(legacy).toContain('具体原因：真实失败原因');
    expect(legacy.includes('\n')).toBe(false);
  });

  test('① 保留换行：多行墙不再被压成一行', () => {
    const out = honest.resolveFriendlyFailureMessage(ON);
    expect(out.includes('\n')).toBe(true);
    expect(out).toContain('- kiro [unavailable]: Kiro IDE unavailable');
  });

  test('② 无双标签：不再出现「具体原因：真实失败原因」，且**保留**自带标签', () => {
    const out = honest.resolveFriendlyFailureMessage(ON);
    expect(out).not.toContain('具体原因：真实失败原因');
    // ⚠ 自带标签「真实失败原因:」是**信息**（说明下面这些是各适配器的真因）→ 必须留住。
    expect(out).toContain('真实失败原因');
  });

  test('③ 门关 → 逐字节回退今日行为', () => {
    const legacy = honest.resolveFriendlyFailureMessage(OFF);
    const on = honest.resolveFriendlyFailureMessage(ON);
    expect(on).not.toBe(legacy);
    expect(legacy).toContain('具体原因：真实失败原因');
    expect(legacy.includes('\n')).toBe(false);
    expect(on.includes('\n')).toBe(true);
  });

  test('④ 零回归：无标签的普通真因仍带「具体原因：」前缀', () => {
    const out = honest.resolveFriendlyFailureMessage({
      errorType: 'unknown',
      cause: 'ECONNREFUSED 127.0.0.1:8317',
      legacyFriendly: 'legacy',
      options: ON.options,
    });
    expect(out).toBe('具体原因：ECONNREFUSED 127.0.0.1:8317');
  });

  test('⑤ 零回归：脱敏仍生效（密钥不被带出）', () => {
    const out = honest.resolveFriendlyFailureMessage({
      errorType: 'auth',
      cause: 'auth failed with sk-proj-abcdefghijklmnop',
      legacyFriendly: 'legacy',
      options: ON.options,
    });
    expect(out).not.toContain('sk-proj-abcdefghijklmnop');
    expect(out).toContain('***');
  });

  test('⑥ 末组不被腰斩：长墙的**最后一行**完整保留（不被切成「Fre…」）', () => {
    // 复刻截图那一墙（4 组适配器，总长 > 220 旧上限）
    const longWall = [
      '真实失败原因:',
      '- kiro [unavailable]: Kiro IDE unavailable',
      '- cursor [unavailable]: Cursor IDE unavailable',
      '- trae [unavailable]: Trae IDE unavailable',
      '- OpenCode Zen +1 个适配器 [上游 FreeUsageLimitError]: Free usage limit reached. Free…',
    ].join('\n');
    expect(longWall.length).toBeGreaterThan(220);
    const out = honest.resolveFriendlyFailureMessage({
      errorType: 'unknown',
      cause: longWall,
      legacyFriendly: 'legacy',
      options: ON.options,
    });
    // 末行**完整**（不被腰斩）
    expect(out).toContain('Free usage limit reached. Free…');
    expect(out).not.toContain('Fre…\n');
    // 每一组都在
    for (const frag of ['kiro', 'cursor', 'trae', 'OpenCode Zen']) {
      expect(out).toContain(frag);
    }
  });

  test('⑦ 行数超限时**整行丢弃**并如实标出丢了多少（不腰斩、不静默）', () => {
    const many = ['真实失败原因:'].concat(
      Array.from({ length: 20 }, (_, i) => `- adapter${i} [unavailable]: unavailable message ${i}`)
    ).join('\n');
    const out = honest.resolveFriendlyFailureMessage({
      errorType: 'unknown',
      cause: many,
      legacyFriendly: 'legacy',
      options: ON.options,
    });
    expect(out).toContain('另有');
    expect(out).toMatch(/另有 \d+ 条失败记录未显示/);
    // 被丢的行确实不在里面，且是**整行**丢弃（不出现半截行）
    expect(out).not.toContain('adapter19 [unavailable]: unavailabl');
  });
});

describe('W4 · 上游配额/缺 key 真因可认（[DESIGN-ARCH-198] §2.3）', () => {
  test('【对抗前置】今日确实认不出（否则本组是假绿）', () => {
    const legacyEnv = { KHY_UPSTREAM_TRUTH_LABEL: '1', KHY_UPSTREAM_QUOTA_TRUTH: '0' };
    const zen = truth.describeUpstream(ZEN_ERR, { errorType: 'network', env: legacyEnv });
    const auth = truth.describeUpstream(AUTH_ERR, { errorType: 'auth', env: legacyEnv });
    expect(zen.advice).toBe(''); // 拿得到标签、拿不到建议
    expect(auth).toBe(null); // 完全认不出
  });

  test('① FreeUsageLimitError → 有标签 + 有可执行建议 + 非瞬态', () => {
    const r = truth.describeUpstream(ZEN_ERR, { errorType: 'network', env: process.env });
    expect(r).toBeTruthy();
    expect(r.label).toContain('额度');
    expect(r.advice).toBeTruthy();
    expect(r.transient).toBe(false); // 额度用尽重试无用
  });

  test('② AuthError/Missing API key → 可认（不再返 null）', () => {
    const r = truth.describeUpstream(AUTH_ERR, { errorType: 'auth', env: process.env });
    expect(r).toBeTruthy();
    expect(r.label).toContain('Key');
    expect(r.advice).toMatch(/ai config/);
  });

  test('③ 门关 → 逐字节回退今日行为', () => {
    const legacyEnv = { KHY_UPSTREAM_TRUTH_LABEL: '1', KHY_UPSTREAM_QUOTA_TRUTH: '0' };
    const legacy = truth.describeUpstream(ZEN_ERR, { errorType: 'network', env: legacyEnv });
    const on = truth.describeUpstream(ZEN_ERR, { errorType: 'network', env: process.env });
    expect(on).not.toEqual(legacy);
    expect(legacy.advice).toBe('');
    expect(on.advice).toBeTruthy();
  });

  test('④ 零回归：既有规则不被破坏', () => {
    const unsupported = JSON.stringify({
      type: 'error',
      error: { type: 'ModelError', message: 'model xyz is not supported' },
    });
    const r = truth.describeUpstream(unsupported, { errorType: 'auth', env: process.env });
    expect(r.label).toContain('不被上游支持');
  });
});

describe('W6 · 失败尝试分层（[DESIGN-ARCH-198] §2.6）', () => {
  const attempts = [
    { success: false, adapterKey: 'kiro', errorType: 'unavailable', error: 'Kiro IDE unavailable', statusCode: 0 },
    { success: false, adapterKey: 'cursor', errorType: 'unavailable', error: 'Cursor IDE unavailable', statusCode: 0 },
    { success: false, adapterKey: 'trae', errorType: 'unavailable', error: 'Trae IDE unavailable', statusCode: 0 },
    { success: false, adapterKey: 'OpenCode Zen', errorType: 'network', error: ZEN_ERR, statusCode: 429 },
  ];

  test('【对抗前置】今日确实把 IDE 噪音选成主因（否则本组是假绿）', () => {
    const legacy = envelope.buildCliFailureEnvelope({
      result: { success: false, errorType: 'network', attempts, preferredAdapter: 'auto' },
      env: { KHY_CLI_FAILURE_ENVELOPE: '1', KHY_FAILURE_ATTEMPT_TIERS: '0' },
    });
    expect(legacy.cause.adapter).toBe('kiro');
  });

  test('① 主因 = 真实可行动原因（不是 IDE 噪音）', () => {
    const on = envelope.buildCliFailureEnvelope({
      result: { success: false, errorType: 'network', attempts, preferredAdapter: 'auto' },
      env: process.env,
    });
    expect(on.cause.adapter).toBe('OpenCode Zen');
    expect(on.cause.statusCode).toBe(429);
  });

  test('② 门关 → 逐字节回退今日行为（主因 = kiro）', () => {
    const legacy = envelope.buildCliFailureEnvelope({
      result: { success: false, errorType: 'network', attempts, preferredAdapter: 'auto' },
      env: { KHY_CLI_FAILURE_ENVELOPE: '1', KHY_FAILURE_ATTEMPT_TIERS: '0' },
    });
    const on = envelope.buildCliFailureEnvelope({
      result: { success: false, errorType: 'network', attempts, preferredAdapter: 'auto' },
      env: process.env,
    });
    expect(on.cause.adapter).not.toBe(legacy.cause.adapter);
    expect(legacy.cause.adapter).toBe('kiro');
  });

  test('③ 零回归：只有 IDE 噪音时，主因仍是它（不硬造原因）', () => {
    const onlyNoise = attempts.slice(0, 3);
    const on = envelope.buildCliFailureEnvelope({
      result: { success: false, errorType: 'network', attempts: onlyNoise, preferredAdapter: 'auto' },
      env: process.env,
    });
    expect(['kiro', 'cursor', 'trae']).toContain(on.cause.adapter);
  });
});

// ── W8 · 失败墙/信封人话化（[DESIGN-ARCH-198] §2.7）────────────────────────
describe('W8 · 用户可见面不得出现原始 JSON，只出现中文人话', () => {
  const W8_ATTEMPTS = [
    { success: false, adapterKey: 'OpenCode Zen', errorType: 'auth', error: AUTH_ERR, statusCode: 401 },
    { success: false, adapterKey: 'kiro', errorType: 'unavailable', error: 'Kiro IDE unavailable', statusCode: 0 },
  ];

  test('① 墙条目不含原始 JSON，含中文原因与可执行命令', () => {
    const wall = helpers._formatGatewayFailureDetails({
      success: false,
      errorType: 'auth',
      attempts: W8_ATTEMPTS,
    });
    expect(wall).not.toContain('{');
    expect(wall).not.toContain('"type"');
    expect(wall).not.toContain('AuthError');
    expect(wall).toContain('缺少 API Key');
    expect(wall).toContain('ai config');
    expect(wall).toContain('通道不可用');
  });

  test('② 信封首屏第 3 行不含原始 JSON，改印中文人话', () => {
    const head = envelope.renderCliFailureEnvelope(
      envelope.buildCliFailureEnvelope({
        result: { success: false, errorType: 'auth', attempts: W8_ATTEMPTS, preferredAdapter: 'auto' },
        env: process.env,
      })
    );
    expect(head).not.toContain('{');
    expect(head).not.toContain('AuthError');
    expect(head).toContain('通道: OpenCode Zen (401) [auth] — 缺少 API Key (401)：');
  });

  test('③ 门关 → 墙与信封逐字节回退今日（原文 / truth.message）', () => {
    const prevH = process.env.KHY_FAILURE_HUMAN_TEXT;
    process.env.KHY_FAILURE_HUMAN_TEXT = '0';
    try {
      const wall = helpers._formatGatewayFailureDetails({
        success: false,
        errorType: 'auth',
        attempts: W8_ATTEMPTS,
      });
      expect(wall).toBe(
        [
          '真实失败原因:',
          `- OpenCode Zen (401) [缺少 API Key]: ${'Missing API key.'}`,
          '- kiro [unavailable]: Kiro IDE unavailable',
        ].join('\n')
      );
      const head = envelope.renderCliFailureEnvelope(
        envelope.buildCliFailureEnvelope({
          result: { success: false, errorType: 'auth', attempts: W8_ATTEMPTS, preferredAdapter: 'auto' },
          env: process.env,
        })
      );
      expect(head).toContain(`通道: OpenCode Zen (401) [auth] — ${AUTH_ERR}`);
    } finally {
      if (prevH === undefined) delete process.env.KHY_FAILURE_HUMAN_TEXT;
      else process.env.KHY_FAILURE_HUMAN_TEXT = prevH;
    }
  });

  test('④ composeHuman 去重后墙行不出现重复 label（truth.label 与句子标签不叠）', () => {
    const n = descriptor.humanizeFailure({
      raw: AUTH_ERR,
      errorType: 'auth',
      statusCode: 401,
      env: process.env,
    });
    expect(n).toBeTruthy();
    const withLabel = descriptor.composeHuman(n, {
      bracketToken: 'auth',
      bracketIsTruthLabel: false,
    });
    const withoutLabel = descriptor.composeHuman(n, {
      bracketToken: '缺少 API Key',
      bracketIsTruthLabel: true,
    });
    // kind 槽已显中文真因标签 → 句子里不再重复一遍「缺少 API Key」
    expect(withLabel.startsWith('缺少 API Key (401)：')).toBe(true);
    expect(withoutLabel.startsWith('该通道尚未配置 API Key，')).toBe(true);
  });

  test('⑤ 厂商点名不退化：raw 里出现厂商显示名时，人话句原样保留该名', () => {
    const n = descriptor.humanizeFailure({
      raw: '智谱AI: HTTP 401 · code 1002 · 鉴权失败',
      errorType: 'auth',
      statusCode: 401,
      env: process.env,
    });
    expect(n).toBeTruthy();
    expect(n.sentence).toContain('智谱');
  });
});
