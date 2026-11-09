'use strict';

/**
 * upstreamFailureHumanize.test.js — 失败人话化纯叶子契约（[DESIGN-ARCH-198] W8）。
 *
 * 用户实测复现（2026-11-01，会话截图「今日新闻查询」）：上游 401 的 JSON 报文被**原样**
 * 贴到用户可见面 —— 信封首屏 `通道: OpenCode Zen (401) [auth] — {"type":"error",…}`，
 * 失败墙同样只剩英文机器串（`Missing API key.` / `Kiro IDE unavailable`）。
 *
 * 本套件锁死：
 *   - 21 族映射逐行断言 human/fix（措辞照 AGENTS.md 规则 2.2 的「问题 + 原因 + 修复建议」）；
 *   - 识别码取用顺序（HTTP > 上游 code > errno > 我方 errorType > 无）；
 *   - 上游私有 type 不进识别码槽、不进人话句；
 *   - 认不出时人话句不含 `{` 与 `"type"`（JSON 不得上用户桌面）；
 *   - composeHuman 的去重规则（bracket 中文标签 → 省 label 段；识别码与 bracket 相同 → 省括号）；
 *   - 门关 → null 且绝不抛；判码侧（errorType）一个字节都不动。
 *
 * 与 upstreamTruthLabel.test.js 的分界：那个叶子只产**标签**且喂判码侧；本叶子只被
 * **渲染层**调用，产一整句。两套 body 解析器刻意不共享（共享会让两侧规则互相耦合）。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
  HUMAN_SENTENCES,
  humanizeFailure,
  composeHuman,
  humanTextEnabled,
} = require('../../../src/services/cliErrorDescriptor');

const ON = {}; // 门默认开

// ── 21 族映射表（raw → human / fix 逐行断言）────────────────────────────────
const MAPPING = [
  {
    name: 'AuthError + Missing API key + 401 → 缺少 API Key',
    raw: '{"type":"error","error":{"type":"AuthError","message":"Missing API key."}}',
    errorType: 'auth',
    statusCode: 401,
    human: '缺少 API Key (401)：该通道尚未配置 API Key，请运行 ai config 配置该通道的 API Key，配好即可继续',
    fix: '请运行 ai config 配置该通道的 API Key，配好即可继续',
  },
  {
    name: 'Incorrect API key + 401 → API Key 无效或已过期',
    raw: '{"error":{"message":"Incorrect API key provided: sk-xxx.","type":"invalid_request_error"}}',
    errorType: 'auth',
    statusCode: 401,
    human:
      'API Key 无效或已过期 (401)：上游拒绝了本次请求携带的密钥，请运行 ai config 更新该通道的 API Key，并确认账号余额与权限',
    fix: '请运行 ai config 更新该通道的 API Key，并确认账号余额与权限',
  },
  {
    name: 'FreeTierError + 403 → 免费层客户端校验未通过',
    raw: '{"type":"error","error":{"type":"FreeTierError","message":"OpenCode free tier can only be used from within OpenCode"}}',
    errorType: 'auth',
    statusCode: 403,
    human:
      '免费层客户端校验未通过 (403)：该免费通道只接受 OpenCode 客户端指纹，请运行 /model 改用其它通道，或为付费通道配置 API Key',
    fix: '请运行 /model 改用其它通道，或为付费通道配置 API Key',
  },
  {
    name: 'ModelError not supported + 401 → 该模型不被上游支持',
    raw: '{"type":"error","error":{"type":"ModelError","message":"Model deepseek-v4-flash-free is not supported"}}',
    errorType: 'auth',
    statusCode: 401,
    human: '该模型不被上游支持 (401)：该模型已在上游下线，请运行 /model 换一个上游仍支持的模型',
    fix: '请运行 /model 换一个上游仍支持的模型',
  },
  {
    name: 'server_error Endpoint unavailable + 429 → 上游端点不可用',
    raw: '{"error":{"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}}',
    errorType: 'network',
    statusCode: 429,
    human:
      '上游端点不可用 (429)：该通道的端点当前不可用，属瞬态故障，稍后重试即可自愈；仍失败请运行 /model 换一个更稳的通道',
    fix: '稍后重试即可自愈；仍失败请运行 /model 换一个更稳的通道',
  },
  {
    name: 'FreeUsageLimitError + 429 → 上游免费额度用尽',
    raw: '{"type":"error","error":{"type":"FreeUsageLimitError","message":"Free usage limit reached. Free tier resets hourly."}}',
    errorType: 'network',
    statusCode: 429,
    human:
      '上游免费额度用尽 (429)：额度按出口 IP 计算，重试无用，请等配额恢复后重试，或运行 /model 换用付费/其它通道',
    fix: '请等配额恢复后重试，或运行 /model 换用付费/其它通道',
  },
  {
    name: 'RegionError + 403 → 该模型在当前地区不可用',
    raw: '{"error":{"type":"RegionError","message":"This model is not available in your country"}}',
    errorType: 'auth',
    statusCode: 403,
    human: '该模型在当前地区不可用 (403)：上游按出口地区拒绝了该模型，请运行 /model 换用其它地区可用的模型',
    fix: '请运行 /model 换用其它地区可用的模型',
  },
  {
    name: 'body code invalid_api_key + 400 → API Key 无效或已过期',
    raw: '{"error":{"type":"invalid_request_error","message":"…","code":"invalid_api_key","param":"model"}}',
    errorType: 'bad_request',
    statusCode: 400,
    human: 'API Key 无效或已过期 (invalid_api_key)：上游按密钥无效拒绝了本次请求，请运行 ai config 更新该通道的 API Key',
    fix: '请运行 ai config 更新该通道的 API Key',
  },
  {
    name: 'invalid_request_error + param + 400 → 请求参数不被上游接受',
    raw: '{"error":{"type":"invalid_request_error","message":"…","param":"model","code":null}}',
    errorType: 'bad_request',
    statusCode: 400,
    human:
      '请求参数不被上游接受 (400)：上游点名了本次请求里不被接受的参数，请按上游原文调整该参数后重试；本仓已内置自适应剥离机制，会自动重试一次',
    fix: '请按上游原文调整该参数后重试；本仓已内置自适应剥离机制，会自动重试一次',
  },
  {
    name: 'previous_response_not_found + 400 → 会话续接标识已失效',
    raw: '{"error":{"type":"server_error","message":"Previous response \'…\' not found or expired.","code":"previous_response_not_found"}}',
    errorType: 'bad_request',
    statusCode: 400,
    human:
      '会话续接标识已失效 (previous_response_not_found)：上游找不到上一次响应的标识，请去掉 previous_response_id 重新发起请求，或新建会话',
    fix: '请去掉 previous_response_id 重新发起请求，或新建会话',
  },
  {
    name: 'auth_error + 401 → 认证失败',
    raw: '{"error":{"type":"auth_error","message":"…","param":null,"code":null}}',
    errorType: 'auth',
    statusCode: 401,
    human: '认证失败 (401)：上游以认证错误拒绝了本次请求，请运行 ai config 更新该通道的 API Key',
    fix: '请运行 ai config 更新该通道的 API Key',
  },
  {
    name: 'Claude Code CLI 流 api_error（无 HTTP 码 → 省略括号）',
    raw: '{"type":"system","subtype":"error","error":{"type":"api_error","message":"…"}}',
    errorType: 'unknown',
    statusCode: 0,
    human:
      'Claude 通道返回错误：该次调用被上游拒绝，请运行 khy gateway status 看该通道实测状态；凭据问题请运行 khy login 重新认证，否则换通道重试',
    fix: '请运行 khy gateway status 看该通道实测状态；凭据问题请运行 khy login 重新认证，否则换通道重试',
  },
  {
    name: 'Empty response（HTTP 200 是成功码 → 识别码用 errorType empty）',
    raw: 'Empty response (HTTP 200, body: )',
    errorType: 'empty',
    statusCode: 200,
    human:
      '上游返回空内容 (empty)：模型服务连上了但没有产出任何文字或工具调用，请直接重试；若反复空回，请运行 /model 换用更稳的模型',
    // kind 槽已显 `[empty]` → composeHuman 省掉重复的括号段
    composed:
      '上游返回空内容：模型服务连上了但没有产出任何文字或工具调用，请直接重试；若反复空回，请运行 /model 换用更稳的模型',
    fix: '请直接重试；若反复空回，请运行 /model 换用更稳的模型',
  },
  {
    name: 'Request failed with status code 404 → 模型不存在',
    raw: 'Request failed with status code 404',
    errorType: 'model_not_found',
    statusCode: 0,
    human: '模型不存在 (404)：上游只回了状态码、没有说明原因，请运行 /model 查看可用模型并改选',
    fix: '请运行 /model 查看可用模型并改选',
  },
  {
    name: '智谱 HTTP 400 · code 1211 → 模型不存在（复合识别码）',
    raw: '智谱AI: HTTP 400 · code 1211 · 模型不存在 (model glm-4.7-flash)',
    errorType: 'model_not_found',
    statusCode: 400,
    human:
      '模型不存在 (400 / code 1211)：该账号尚未领取或开通这个模型，请运行 /model 换用已开通的模型，或到厂商控制台领取该免费模型后重试',
    fix: '请运行 /model 换用已开通的模型，或到厂商控制台领取该免费模型后重试',
  },
  {
    name: '智谱 HTTP 401 · code 1002 → 认证失败（复合识别码）',
    raw: '智谱AI: HTTP 401 · code 1002 · 鉴权失败',
    errorType: 'auth',
    statusCode: 401,
    human:
      '认证失败 (401 / code 1002)：智谱拒绝了该密钥（token 无效或鉴权校验未通过），请运行 ai config 重新配置该通道的智谱 API Key 后重试',
    fix: '请运行 ai config 重新配置该通道的智谱 API Key 后重试',
  },
  {
    name: 'connect ECONNREFUSED → 网络连接失败（识别码走 errno）',
    raw: 'connect ECONNREFUSED 127.0.0.1:11434',
    errorType: 'network',
    statusCode: 0,
    errno: 'ECONNREFUSED',
    human: '网络连接失败 (ECONNREFUSED)：目标服务没有在监听，请运行 khy server start 启动服务，或改用其它模型通道',
    fix: '请运行 khy server start 启动服务，或改用其它模型通道',
  },
  {
    name: 'getaddrinfo ENOTFOUND → 域名解析失败',
    raw: 'getaddrinfo ENOTFOUND api.example.com',
    errorType: 'network',
    statusCode: 0,
    errno: 'ENOTFOUND',
    human:
      '域名解析失败 (ENOTFOUND)：主机名无法解析成地址，请核对目标地址拼写与 DNS 连通性；受限网络下先运行 /proxy 配置代理',
    fix: '请核对目标地址拼写与 DNS 连通性；受限网络下先运行 /proxy 配置代理',
  },
  {
    name: 'timeout of …ms exceeded → 请求超时（无 HTTP 码 → 语义等价 504）',
    raw: 'timeout of 30000ms exceeded',
    errorType: 'timeout',
    statusCode: 0,
    human:
      '请求超时 (504)：上游在时限内没有返回结果，请稍后重试；若持续超时请检查 /proxy 代理配置并运行 khy gateway status 检查通道',
    fix: '请稍后重试；若持续超时请检查 /proxy 代理配置并运行 khy gateway status 检查通道',
  },
  {
    name: '认不出的结构化 type（WeirdError）→ 固定中文兜底，JSON 不上桌面',
    raw: '{"error":{"type":"WeirdError","message":"boom"}}',
    errorType: 'network',
    statusCode: 400,
    human:
      '上游返回了无法识别的错误 (400)：本机无法判断该错误的真实含义，请运行 khy gateway status 查看各通道实测状态，并换一条通道重试；需要定位时输入 /err 查看原始报文',
    fix: '请运行 khy gateway status 查看各通道实测状态，并换一条通道重试；需要定位时输入 /err 查看原始报文',
    matched: false,
  },
  {
    name: 'errorType=unavailable（环境事实族）→ 通道不可用',
    raw: 'Kiro IDE unavailable',
    errorType: 'unavailable',
    statusCode: 0,
    human:
      '通道不可用 (unavailable)：该通道未注册、未启用或未安装，请运行 khy gateway status 查看各通道实测状态；或运行 /model 换用其它通道',
    // kind 槽已显 `[unavailable]` → composeHuman 省掉重复的括号段（用户截图那行）
    composed:
      '通道不可用：该通道未注册、未启用或未安装，请运行 khy gateway status 查看各通道实测状态；或运行 /model 换用其它通道',
    fix: '请运行 khy gateway status 查看各通道实测状态；或运行 /model 换用其它通道',
  },
];

test('HUMAN_SENTENCES 覆盖 21 族且每条都有 label/reason/fix', () => {
  const kinds = new Set(MAPPING.map((m) => m.name));
  assert.strictEqual(kinds.size, 21, '映射表应为 21 条互异用例');
  for (const [kind, entry] of Object.entries(HUMAN_SENTENCES)) {
    assert.ok(entry.label && entry.reason && entry.fix, `${kind} 缺字段`);
  }
});

for (const m of MAPPING) {
  test(`映射：${m.name}`, () => {
    const n = humanizeFailure({
      raw: m.raw,
      errorType: m.errorType,
      statusCode: m.statusCode,
      errno: m.errno,
      env: ON,
    });
    assert.ok(n, '应产出人话叙事');
    assert.strictEqual(n.sentence, m.human);
    assert.strictEqual(n.fix, m.fix);
    assert.strictEqual(n.matched, m.matched !== false);
    // 墙/信封行的最终形态：bracketToken = kind 槽当前显示的 token（这些 raw 都认不出
    // truth.label ⇒ kind 槽回落裸 errorType）。
    const composed = composeHuman(n, { bracketToken: m.errorType, bracketIsTruthLabel: false });
    assert.strictEqual(composed, m.composed || m.human);
    // 人话句只由固定中文模板拼装，绝不夹带原始 JSON / 上游私有 type
    assert.ok(!composed.includes('{'), `句子不得含 '{'：${composed}`);
    assert.ok(!composed.includes('"type"'), `句子不得含 '"type"'：${composed}`);
  });
}

// ── 识别码取用顺序（硬规则） ────────────────────────────────────────────────

test('识别码顺序①：上游 body 的 code 字段优先于 HTTP 状态码', () => {
  // 上游自己写的机器码比通用 HTTP 桶更可执行：400 有十几种成因，invalid_api_key 只有一种。
  const n = humanizeFailure({
    raw: '{"error":{"type":"invalid_request_error","message":"…","code":"invalid_api_key","param":"model"}}',
    errorType: 'bad_request',
    statusCode: 400,
    env: ON,
  });
  assert.strictEqual(n.code, 'invalid_api_key');
});

test('识别码顺序②：无上游 code 时取 HTTP 状态码（200 不算失败码）', () => {
  assert.strictEqual(
    humanizeFailure({
      raw: '{"error":{"type":"invalid_request_error","message":"…","param":"model","code":null}}',
      errorType: 'bad_request',
      statusCode: 400,
      env: ON,
    }).code,
    '400'
  );
  assert.strictEqual(
    humanizeFailure({ raw: 'Empty response (HTTP 200)', errorType: 'empty', statusCode: 200, env: ON }).code,
    'empty'
  );
});

test('识别码顺序③：无上游 code、无 HTTP 码时取 errno', () => {
  const n = humanizeFailure({
    raw: 'connect ECONNREFUSED 127.0.0.1:11434',
    errorType: 'network',
    errno: 'ECONNREFUSED',
    env: ON,
  });
  assert.strictEqual(n.code, 'ECONNREFUSED');
});

test('识别码顺序④：只剩我方 errorType 时，仅 empty / unavailable 两族进槽', () => {
  assert.strictEqual(humanizeFailure({ raw: 'Kiro IDE unavailable', errorType: 'unavailable', env: ON }).code, 'unavailable');
  assert.strictEqual(humanizeFailure({ raw: 'Empty response (HTTP 200)', errorType: 'empty', env: ON }).code, 'empty');
  // 其它 errorType（auth/network/…）不得把内部类别词塞进识别码槽
  assert.strictEqual(humanizeFailure({ raw: 'auth failed with ***', errorType: 'auth', statusCode: 401, env: ON }).code, '401');
});

test('识别码顺序⑤：什么都取不到 → 省略括号', () => {
  const n = humanizeFailure({ raw: 'something odd happened', errorType: 'unknown', env: ON });
  // 非 JSON、无 errorType 家族 → 本机不转述（调用方逐字节保留今日文案）
  assert.strictEqual(n, null);
  const c = humanizeFailure({
    raw: '{"type":"system","subtype":"error","error":{"type":"api_error","message":"…"}}',
    errorType: 'unknown',
    env: ON,
  });
  assert.strictEqual(c.code, '');
  assert.ok(!c.sentence.includes('('), `无识别码时不得出现括号：${c.sentence}`);
});

test('上游私有 type 一律不进识别码槽（AuthError / WeirdError / api_error…）', () => {
  for (const t of ['AuthError', 'WeirdError', 'api_error', 'FreeTierError', 'RegionError']) {
    const n = humanizeFailure({
      raw: `{"error":{"type":"${t}","message":"boom"}}`,
      errorType: 'network',
      statusCode: 0,
      env: ON,
    });
    assert.ok(n, t);
    assert.notStrictEqual(n.code, t, `${t} 不得进识别码槽`);
    assert.ok(!n.sentence.includes(t), `${t} 不得出现在人话句里`);
  }
});

// ── composeHuman 去重合成 ──────────────────────────────────────────────────

test('composeHuman：bracketIsTruthLabel → 省 label 段（只留 reason，fix）', () => {
  const n = humanizeFailure({
    raw: '{"type":"error","error":{"type":"AuthError","message":"Missing API key."}}',
    errorType: 'auth',
    statusCode: 401,
    env: ON,
  });
  const out = composeHuman(n, { bracketToken: '缺少 API Key', bracketIsTruthLabel: true });
  assert.strictEqual(out, '该通道尚未配置 API Key，请运行 ai config 配置该通道的 API Key，配好即可继续');
});

test('composeHuman：句子识别码与 bracketToken 相同 → 省括号段', () => {
  const n = humanizeFailure({ raw: 'Kiro IDE unavailable', errorType: 'unavailable', env: ON });
  const out = composeHuman(n, { bracketToken: 'unavailable', bracketIsTruthLabel: false });
  assert.strictEqual(
    out,
    '通道不可用：该通道未注册、未启用或未安装，请运行 khy gateway status 查看各通道实测状态；或运行 /model 换用其它通道'
  );
  assert.ok(!out.includes('(unavailable)'), '括号段应被省掉');
});

test('composeHuman：识别码与 bracketToken 不同 → 保留括号段', () => {
  const n = humanizeFailure({ raw: 'auth failed with ***', errorType: 'auth', statusCode: 401, env: ON });
  const out = composeHuman(n, { bracketToken: 'auth', bracketIsTruthLabel: false });
  assert.ok(out.startsWith('认证失败 (401)：'), out);
});

test('composeHuman：空叙事 / 坏输入 → 空串，绝不抛', () => {
  assert.strictEqual(composeHuman(null), '');
  assert.strictEqual(composeHuman({}, {}), '');
  for (const bad of [null, undefined, 42, 'x', { label: 'x' }]) {
    assert.doesNotThrow(() => composeHuman(bad, { bracketToken: 'auth' }));
  }
});

// ── 门控 / 健壮性 ──────────────────────────────────────────────────────────

test('门关（KHY_FAILURE_HUMAN_TEXT=0/false/off/no）→ 一律 null', () => {
  for (const v of ['0', 'false', 'OFF', 'no', ' No ']) {
    assert.strictEqual(
      humanizeFailure({
        raw: '{"type":"error","error":{"type":"AuthError","message":"Missing API key."}}',
        errorType: 'auth',
        statusCode: 401,
        env: { KHY_FAILURE_HUMAN_TEXT: v },
      }),
      null,
      v
    );
  }
});

test('humanTextEnabled：默认开；0/false/off/no 关；注册表关时回本地 CANON', () => {
  assert.strictEqual(humanTextEnabled({}), true);
  assert.strictEqual(humanTextEnabled({ KHY_FAILURE_HUMAN_TEXT: '0' }), false);
  assert.strictEqual(humanTextEnabled({ KHY_FLAG_REGISTRY: '0', KHY_FAILURE_HUMAN_TEXT: '0' }), false);
  assert.strictEqual(humanTextEnabled({ KHY_FLAG_REGISTRY: '0' }), true);
});

test('坏输入绝不抛：null / undefined / 数字 / 半截 JSON / 空体', () => {
  for (const bad of [null, undefined, 42, '', '   ', '{not json', '{"error":null}', '{"error":"str"}', '[]']) {
    assert.doesNotThrow(() => humanizeFailure({ raw: bad, errorType: 'auth', env: ON }));
  }
  // 空体 → 固定中文兜底（不得把空体原样透给用户）
  const empty = humanizeFailure({ raw: '', errorType: 'unknown', env: ON });
  assert.ok(empty);
  assert.strictEqual(empty.matched, false);
  assert.ok(!empty.sentence.includes('{'));
});

test('判码侧零扰动：同一份 attempts 下 errorType 原样返回，人话化不改分类', () => {
  const attempt = {
    success: false,
    adapterKey: 'OpenCode Zen',
    errorType: 'auth',
    error: '{"type":"error","error":{"type":"AuthError","message":"Missing API key."}}',
    statusCode: 401,
  };
  const before = attempt.errorType;
  humanizeFailure({ raw: attempt.error, errorType: attempt.errorType, statusCode: attempt.statusCode, env: ON });
  assert.strictEqual(attempt.errorType, before);
  assert.strictEqual(attempt.error, '{"type":"error","error":{"type":"AuthError","message":"Missing API key."}}');
});

// ── 挂点四：网关 content 墙（_buildFailureReasonSection） ────────────────────
// 该墙进 result.content → aiChatCore 状态行 → failureDetails → 散文层，属二次消费，
// 与信封/CLI 墙同一门同一合成器。
const {
  _buildFailureReasonSection,
} = require('../../../src/services/gateway/aiGateway').__test__;

const WALL_ATTEMPTS = [
  {
    success: false,
    adapterKey: 'OpenCode Zen',
    errorType: 'auth',
    error: '{"type":"error","error":{"type":"AuthError","message":"Missing API key."}}',
    statusCode: 401,
  },
  { success: false, adapterKey: 'kiro', errorType: 'unavailable', error: 'Kiro IDE unavailable', statusCode: 0 },
];

test('网关 content 墙：H=1 时 shown 为人话，原始 JSON 不上桌面', () => {
  const wall = _buildFailureReasonSection(WALL_ATTEMPTS);
  assert.ok(wall.startsWith('真实失败原因:'), wall);
  assert.ok(!wall.includes('{'), wall);
  assert.ok(!wall.includes('"type"'), wall);
  assert.ok(!wall.includes('AuthError'), wall);
  assert.ok(wall.includes('该通道尚未配置 API Key，请运行 ai config 配置该通道的 API Key'), wall);
  assert.ok(wall.includes('通道不可用：该通道未注册、未启用或未安装'), wall);
  // kind 槽规则未改：truth.label 命中仍显中文标签
  assert.ok(wall.includes('- OpenCode Zen (401) [缺少 API Key]:'), wall);
  assert.ok(wall.includes('- kiro [unavailable]:'), wall);
});

test('网关 content 墙：H=0 时逐字节回退今日（truth.message / 原文）', () => {
  const prev = process.env.KHY_FAILURE_HUMAN_TEXT;
  process.env.KHY_FAILURE_HUMAN_TEXT = '0';
  try {
    const wall = _buildFailureReasonSection(WALL_ATTEMPTS);
    assert.ok(
      wall.includes('- OpenCode Zen (401) [缺少 API Key]: Missing API key.'),
      wall
    );
    assert.ok(wall.includes('- kiro [unavailable]: Kiro IDE unavailable'), wall);
  } finally {
    if (prev === undefined) delete process.env.KHY_FAILURE_HUMAN_TEXT;
    else process.env.KHY_FAILURE_HUMAN_TEXT = prev;
  }
});
