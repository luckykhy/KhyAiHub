'use strict';

/**
 * fallbackEligibilityPolicy.test.js — [DESIGN-ARCH-181] 一期 D1/D2 叶子的验收用例。
 *
 * 覆盖四块:
 *   A. classifyFailureOwnership —— D1 归属矩阵(channel/environment/request/unknown)
 *      与判据优先级(HTTP 码 > 类型名 > 5xx > 环境特征码 > channel 类/消息)。
 *   B. probeEnvironmentOutage —— D2 证据聚合:network 权重 2、timeout 权重 1、按不同
 *      远端 key 去重、≥3 阈值、环境特征码单条成立、远端成功证伪、本地成功不证伪、
 *      virtualSkip 不计、本地失败不计权。
 *   C. decideFallback / classifyDestination —— 三态决策、用户钉选矩阵、目的地资格。
 *   D. strictRelaxQualifies —— 对 aiGatewayGenerateMethod.js:2497-2549 的逐条等价
 *      复现:参考实现内联转写(参考源原文行号见 refShouldRelax 注释),全格驱动比对。
 *
 * 本文件必须用 `require('node:test')` 写:
 *   - `runtime/node/backend/jest.config.js` 按该标记自动把它加入 testPathIgnorePatterns
 *     ⇒ jest 套件不会重复跑它(也不会因两套 runner 冲突而红);
 *   - 而 `test:node`(`node --test tests/**\/*.test.js`,CI 全量 glob)会跑它 ⇒ 落地即须绿。
 *   - 既有的 `tests/gateway/routeFact.test.js` 与 `tests/gateway/cliFailureEnvelope.test.js`
 *     是 jest 风格(裸 describe),在 `node --test` 下本就是红的;因此不往那两个文件追加。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  classifyFailureOwnership,
  probeEnvironmentOutage,
  decideFallback,
  classifyDestination,
  strictRelaxQualifies,
  DEFAULT_LOCAL_ADAPTER_KEYS,
  ENV_SIGNATURE_RE,
} = require('../../src/services/gateway/fallbackEligibilityPolicy');
const {
  isDeadEndpointErrorType,
  isReconnectOrChannelClosedMessage,
} = require('../../src/services/gateway/gatewayErrorClassifier');

// ══════════════════════════════════════════════════════════════════════
// A. 归属矩阵(D1 第一段)
// ══════════════════════════════════════════════════════════════════════

test('A-01 HTTP 码 401/403/429/400/404 → request(硬信号优先于类型名)', () => {
  for (const sc of [401, 403, 429, 400, 404]) {
    assert.strictEqual(
      classifyFailureOwnership({ statusCode: sc, errorType: 'network' }),
      'request',
      `sc=${sc}`,
    );
  }
  assert.strictEqual(
    classifyFailureOwnership({ statusCode: 401, error: 'getaddrinfo EAI_AGAIN x' }),
    'request',
    'HTTP 码先于特征码',
  );
});

test('A-02 request 侧类型名 → request', () => {
  for (const t of ['auth', 'permission', 'rate_limit', 'bad_request', 'model_not_found']) {
    assert.strictEqual(classifyFailureOwnership({ errorType: t }), 'request', t);
  }
});

test('A-03 5xx 与 channel 侧类型名 → channel', () => {
  for (const sc of [500, 502, 503, 599]) {
    assert.strictEqual(classifyFailureOwnership({ statusCode: sc }), 'channel', `sc=${sc}`);
  }
  for (const t of ['server_error', 'process', 'timeout', 'network', 'unavailable']) {
    assert.strictEqual(classifyFailureOwnership({ errorType: t }), 'channel', t);
  }
});

test('A-04 环境特征码 → environment(D2 证据 B;error 与 errorMessage 两字段都认)', () => {
  const sigs = [
    'getaddrinfo EAI_AGAIN api.anthropic.com',
    'getaddrinfo ENOTFOUND api.openai.com',
    'proxy tunnel connection failed',
    'tunneling socket could not be established',
  ];
  for (const s of sigs) {
    assert.strictEqual(classifyFailureOwnership({ error: s }), 'environment', s);
    assert.strictEqual(classifyFailureOwnership({ errorMessage: s }), 'environment', s);
  }
});

test('A-05 ECONNREFUSED 单独不构成环境证据(反模式:更像目标端点死)', () => {
  assert.notStrictEqual(
    classifyFailureOwnership({ error: 'connect ECONNREFUSED 127.0.0.1:11434' }),
    'environment',
  );
  assert.strictEqual(
    classifyFailureOwnership({ error: 'connect ECONNREFUSED 1.2.3.4:443', errorType: 'network' }),
    'channel',
    '带 network 类型时归 channel(该端点死,甩下一通道是对的)',
  );
});

test('A-06 channel 消息族:队列超时 / 瞬态传输 → channel', () => {
  const msgs = [
    'adapter cli queue timeout',
    'queue task timeout',
    'reconnecting to server',
    'channel closed by peer',
    'stream idle timeout',
    'socket hang up',
    'failed to record rollout items',
    'transport issue during rollout recording',
  ];
  for (const m of msgs) {
    assert.strictEqual(classifyFailureOwnership({ error: m }), 'channel', m);
  }
});

test('A-07 未知形态 → unknown(保守)', () => {
  assert.strictEqual(classifyFailureOwnership({ errorType: 'weird_thing' }), 'unknown');
  assert.strictEqual(classifyFailureOwnership({}), 'unknown');
});

test('A-08 特征码先于 channel 类型名(同条 timeout 消息含解析失败 → environment)', () => {
  assert.strictEqual(
    classifyFailureOwnership({ errorType: 'timeout', error: 'getaddrinfo EAI_AGAIN api.x' }),
    'environment',
  );
  assert.strictEqual(
    classifyFailureOwnership({ statusCode: 503, error: 'getaddrinfo ENOTFOUND api.x' }),
    'channel',
    '5xx 说明服务端答过话,连通性存在 → 非环境级',
  );
});

test('A-09 绝不抛:坏输入一律安全缺省', () => {
  const hostile = [
    undefined,
    null,
    0,
    '',
    'str',
    [],
    { toString() { throw new Error('boom'); } },
    Object.create(null),
    { error: { toString() { throw new Error('boom'); } } },
  ];
  for (const h of hostile) {
    assert.doesNotThrow(() => classifyFailureOwnership(h));
  }
  assert.strictEqual(classifyFailureOwnership(), 'unknown');
  assert.strictEqual(classifyFailureOwnership(null), 'unknown');
});

// ══════════════════════════════════════════════════════════════════════
// B. 环境级证据聚合(D2)
// ══════════════════════════════════════════════════════════════════════

/** 远端失败记录构造器(attempts 结构:adapterKey/success/errorType/error)。 */
const remoteFail = (adapterKey, errorType, error = '') => ({ adapterKey, success: false, errorType, error });

test('B-01 两个不同远端 network 失败 → environmental(2+2≥3)', () => {
  const r = probeEnvironmentOutage({
    attempts: [remoteFail('api', 'network', 'ECONNRESET'), remoteFail('relay_api', 'network', 'reset')],
  });
  assert.strictEqual(r.environmental, true);
  assert.strictEqual(r.remoteAdaptersFailed, 2);
  assert.ok(
    r.evidence.some((s) => s.includes('api') && s.includes('relay_api')),
    r.evidence.join(' | '),
  );
});

test('B-02 network(2) + timeout(1) 不同远端 → environmental(恰达阈值 3)', () => {
  const r = probeEnvironmentOutage({
    attempts: [remoteFail('api', 'network'), remoteFail('relay_api', 'timeout')],
  });
  assert.strictEqual(r.environmental, true);
});

test('B-03 三个不同远端 timeout → environmental(1×3=3)', () => {
  const r = probeEnvironmentOutage({
    attempts: [
      remoteFail('api', 'timeout'),
      remoteFail('relay_api', 'timeout'),
      remoteFail('codex', 'timeout'),
    ],
  });
  assert.strictEqual(r.environmental, true);
});

test('B-04 同一远端多次 network → 去重不叠加(2<3) → 非环境级', () => {
  const r = probeEnvironmentOutage({
    attempts: [remoteFail('api', 'network'), remoteFail('api', 'network'), remoteFail('api', 'network')],
  });
  assert.strictEqual(r.environmental, false);
  assert.strictEqual(r.remoteAdaptersFailed, 1);
});

test('B-05 单个远端 network(2) 不足 → 非环境级(反模式:一次失败≠断网)', () => {
  const r = probeEnvironmentOutage({ attempts: [remoteFail('api', 'network')] });
  assert.strictEqual(r.environmental, false);
  assert.deepStrictEqual(r.evidence, []);
});

test('B-06 环境特征码单条成立(证据 B),即使 errorType 未知', () => {
  const r = probeEnvironmentOutage({
    attempts: [remoteFail('api', 'unknown', 'getaddrinfo EAI_AGAIN api.anthropic.com')],
  });
  assert.strictEqual(r.environmental, true);
  assert.ok(r.evidence.some((s) => s.includes('EAI_AGAIN')), r.evidence.join(' | '));
});

test('B-07 远端成功证伪环境级(闸门:任一远端可通即非环境级)', () => {
  const r = probeEnvironmentOutage({
    attempts: [
      remoteFail('api', 'network'),
      remoteFail('relay_api', 'network'),
      { adapterKey: 'codex', success: true },
    ],
  });
  assert.strictEqual(r.environmental, false);
});

test('B-08 特征码也被远端成功证伪(单条 DNS 抖动 + 他端可用 ≠ 环境级)', () => {
  const r = probeEnvironmentOutage({
    attempts: [
      remoteFail('api', 'unknown', 'getaddrinfo ENOTFOUND api.anthropic.com'),
      { adapterKey: 'relay_api', success: true },
    ],
  });
  assert.strictEqual(r.environmental, false);
});

test('B-09 本地成功不证伪(local 成功恰是环境级的典型表现)', () => {
  const r = probeEnvironmentOutage({
    attempts: [
      { adapterKey: 'ollama', success: true },
      remoteFail('api', 'network'),
      remoteFail('relay_api', 'network'),
    ],
  });
  assert.strictEqual(r.environmental, true);
});

test('B-10 本地失败不计权(仅本地全败不成环境级)', () => {
  const r = probeEnvironmentOutage({
    attempts: [remoteFail('ollama', 'network'), remoteFail('localLLM', 'network')],
  });
  assert.strictEqual(r.environmental, false);
  assert.strictEqual(r.remoteAdaptersFailed, 0);
});

test('B-11 localAdapterKeys 可扩展(调用方传 KHY_LOCAL_ADAPTERS 扩展集)', () => {
  const attempts = [remoteFail('mylocal', 'network'), remoteFail('api', 'network')];
  assert.strictEqual(probeEnvironmentOutage({ attempts }).environmental, true, '默认含 mylocal 为远端 → 2+2');
  assert.strictEqual(
    probeEnvironmentOutage({ attempts, localAdapterKeys: ['mylocal'] }).environmental,
    false,
    '声明 mylocal 为本地后仅剩 api=2 → 不足',
  );
});

test('B-12 virtualSkip 是留痕不是证据(不计权、不收特征码)', () => {
  const r1 = probeEnvironmentOutage({
    attempts: [
      remoteFail('api', 'network'),
      remoteFail('relay_api', 'network'),
      { adapterKey: 'codex', virtualSkip: true, errorType: 'network', error: 'skipped' },
    ],
  });
  assert.strictEqual(r1.environmental, true);
  assert.strictEqual(r1.remoteAdaptersFailed, 2, 'skip 记录不得计入失败远端数');

  const r2 = probeEnvironmentOutage({
    attempts: [remoteFail('api', 'network'), { adapterKey: 'codex', virtualSkip: true, errorType: 'network' }],
  });
  assert.strictEqual(r2.environmental, false, '若 skip 计权会达 2+2=4 → 必须是 2');

  const r3 = probeEnvironmentOutage({
    attempts: [{ adapterKey: 'codex', virtualSkip: true, error: 'getaddrinfo ENOTFOUND x' }],
  });
  assert.strictEqual(r3.environmental, false, 'skip 记录不携带特征码证据');
});

test('B-13 适配器 key 兼容 adapterKey/provider/adapter 三种字段名', () => {
  const r = probeEnvironmentOutage({
    attempts: [
      { provider: 'api', success: false, errorType: 'network' },
      { adapter: 'relay_api', success: false, errorType: 'network' },
    ],
  });
  assert.strictEqual(r.environmental, true);
  assert.strictEqual(r.remoteAdaptersFailed, 2);
});

test('B-14 无 key 的失败不参与权重(无法归属到任何远端)', () => {
  const r = probeEnvironmentOutage({
    attempts: [
      { success: false, errorType: 'network' },
      { success: false, errorType: 'network' },
      { success: false, errorType: 'network' },
    ],
  });
  assert.strictEqual(r.environmental, false);
});

test('B-15 ENV_SIGNATURE_RE 覆盖 D1 表 5 个特征码,且不含 econnrefused', () => {
  for (const s of ['EAI_AGAIN', 'getaddrinfo', 'ENOTFOUND', 'proxy tunnel', 'tunneling socket']) {
    assert.ok(ENV_SIGNATURE_RE.test(s.toLowerCase()), s);
  }
  assert.ok(!ENV_SIGNATURE_RE.test('econnrefused'), 'ECONNREFUSED 必须不在集合内');
});

test('B-16 绝不抛:坏输入安全缺省', () => {
  const hostile = [undefined, null, 0, 'str', [], { attempts: 'nope' }, { attempts: [null, 1, 'x', {}, []] }];
  for (const h of hostile) {
    assert.doesNotThrow(() => probeEnvironmentOutage(h));
  }
  assert.deepStrictEqual(probeEnvironmentOutage(), {
    environmental: false,
    evidence: [],
    remoteAdaptersFailed: 0,
  });
});

// ══════════════════════════════════════════════════════════════════════
// C. 三态决策与目的地资格
// ══════════════════════════════════════════════════════════════════════

test('C-01 三态基本映射:channel→F / 环境级→E / request→B / unknown→B', () => {
  assert.strictEqual(decideFallback({ ownership: 'channel' }).decision, 'F');
  assert.strictEqual(decideFallback({ ownership: 'unknown', environmental: true }).decision, 'E');
  assert.strictEqual(decideFallback({ ownership: 'unknown', environmental: true }).reason, 'environment-scoped');
  assert.strictEqual(decideFallback({ ownership: 'request' }).decision, 'B');
  assert.strictEqual(decideFallback({ ownership: 'unknown' }).decision, 'B');
});

test('C-02 E 的第二入口:单条特征码归属(environment)不依赖聚合标志', () => {
  const r = decideFallback({ ownership: 'environment' });
  assert.strictEqual(r.decision, 'E');
  assert.strictEqual(r.reason, 'environment-signature');
});

test('C-03 用户钉选恒为 B(钉子户语义不回退,含环境级)', () => {
  for (const ownership of ['channel', 'request', 'environment', 'unknown']) {
    const r = decideFallback({
      pinKind: 'user',
      ownership,
      environmental: ownership === 'environment',
    });
    assert.strictEqual(r.decision, 'B', ownership);
    assert.strictEqual(r.reason, 'user-pinned');
  }
});

test('C-04 env 钉选受归属判据约束(channel→F;这不是用户意志)', () => {
  assert.strictEqual(decideFallback({ pinKind: 'env', ownership: 'channel' }).decision, 'F');
  assert.strictEqual(decideFallback({ pinKind: 'env', ownership: 'request' }).decision, 'B');
});

test('C-05 判据优先级:request 硬信号 > 环境级 > channel', () => {
  assert.strictEqual(
    decideFallback({ ownership: 'request', environmental: true }).decision,
    'B',
    '401/429 有确定修复动作,不该被"网络级"掩盖',
  );
  assert.strictEqual(
    decideFallback({ ownership: 'channel', environmental: true }).decision,
    'E',
    '聚合判定成立时环境级压过单通道归属',
  );
});

test('C-06 绝不抛:decideFallback 坏输入 → B', () => {
  for (const h of [undefined, null, 0, 'str', []]) {
    assert.doesNotThrow(() => decideFallback(h));
  }
  assert.strictEqual(decideFallback().decision, 'B');
  assert.strictEqual(decideFallback().reason, 'unknown-ownership');
});

test('C-07 目的地资格:manual > bridge > local > remote', () => {
  const pid = ['cli', 'codex', 'claude', 'kiro', 'cursor', 'trae', 'vscode', 'warp', 'cursor2api'];
  assert.strictEqual(classifyDestination('relay'), 'manual', 'SSOT DEFAULT_ROUTE_MANUAL_FALLBACK_KEYS');
  assert.strictEqual(classifyDestination('clipboard'), 'manual');
  assert.strictEqual(classifyDestination('cli', { processSensitiveKeys: pid }), 'bridge');
  assert.strictEqual(classifyDestination('ollama'), 'local');
  assert.strictEqual(classifyDestination('localLLM'), 'local');
  assert.strictEqual(classifyDestination('api'), 'remote');
  assert.strictEqual(classifyDestination('relay_api'), 'remote');
});

test('C-08 人肉红线:manual 优先于 bridge/local(同时命中也不放行自动级联)', () => {
  assert.strictEqual(classifyDestination('relay', { processSensitiveKeys: ['relay'] }), 'manual');
  assert.strictEqual(classifyDestination('relay', { localKeys: ['relay'] }), 'manual');
});

test('C-09 bridge 集合无缺省(未传时桥接类落 remote —— 防集合副本漂移)', () => {
  assert.strictEqual(classifyDestination('claude'), 'remote');
  assert.strictEqual(classifyDestination('claude', { processSensitiveKeys: new Set(['claude']) }), 'bridge');
});

test('C-10 空/坏 key → unknown;集合三种形态(Set/数组/逗号串)均可', () => {
  assert.strictEqual(classifyDestination(''), 'unknown');
  assert.strictEqual(classifyDestination(undefined), 'unknown');
  assert.strictEqual(classifyDestination('mylocal', { localKeys: 'a, MyLocal ,b' }), 'local');
  assert.strictEqual(classifyDestination('x', { manualKeys: [] }), 'remote');
});

test('C-11 绝不抛:classifyDestination 坏 opts;DEFAULT_LOCAL_ADAPTER_KEYS 冻结且与真源同值', () => {
  for (const h of [null, 0, 'x', { localKeys: 42 }]) {
    assert.doesNotThrow(() => classifyDestination('api', h));
  }
  assert.strictEqual(classifyDestination(), 'unknown');
  assert.deepStrictEqual([...DEFAULT_LOCAL_ADAPTER_KEYS], ['ollama', 'localLLM']);
  assert.ok(Object.isFrozen(DEFAULT_LOCAL_ADAPTER_KEYS));
});

// ══════════════════════════════════════════════════════════════════════
// D. strictRelaxQualifies —— 对既有 S2/S3 分支的逐条等价复现
// ══════════════════════════════════════════════════════════════════════

/**
 * 参考实现:`aiGatewayGenerateMethod.js:2497-2549`(`_shouldRelaxStrictPreferredOnFailure`)
 * 的逐行转写,含其两个注入依赖:
 *   - `_isDeadEndpointErrorType`    = gatewayErrorClassifier.isDeadEndpointErrorType
 *   - `_isTransientGatewayTransportMessage` = aiGateway.js:146-152 的逐行转写
 * 以及三个已解析门 / 计数(relayDeadEndpointRelax、allowStrictAutoRelaxOnProcess、
 * strictAutoRelaxMinFailures、_adapterFailures[preferred])按入参等价传入。
 * 若既有分支本体改动,这里必须同步改 —— 等价性测试的意义即在此。
 */
function refShouldRelax(inp) {
  if (!inp.strictPreferredOnly) return false;
  if (inp.userPinnedAdapter) return false;
  if (!inp.preferredAdapter || inp.preferredAdapter === 'auto') return false;
  if (inp.entryKey !== inp.preferredAdapter) return false;
  const normalizedType = String(inp.errorType || '').trim().toLowerCase();
  const msg = String(inp.errorMessage || '').toLowerCase();
  if (
    inp.relayDeadEndpointRelax &&
    inp.isHttpRelay &&
    isDeadEndpointErrorType(normalizedType) &&
    Number(inp.failuresOnPreferred || 0) >= inp.minFailures
  ) {
    return true;
  }
  if (!inp.allowStrictAutoRelaxOnProcess) return false;
  if (!inp.isProcessSensitive) return false;
  if (normalizedType === 'process' || normalizedType === 'timeout' || normalizedType === 'network') return true;
  if (/adapter\s+\S+\s+queue timeout|queue task timeout/.test(msg)) return true;
  const transient = isReconnectOrChannelClosedMessage(msg) || /stream idle timeout|socket hang up/.test(msg);
  return transient;
}

/** 笛卡尔积遍历(通用,供全格比对复用)。 */
function eachCombo(axes, fn) {
  const keys = Object.keys(axes);
  const idx = new Array(keys.length).fill(0);
  let count = 0;
  for (;;) {
    const inp = {};
    for (let k = 0; k < keys.length; k++) inp[keys[k]] = axes[keys[k]][idx[k]];
    fn(inp);
    count++;
    let carry = keys.length - 1;
    for (;;) {
      if (carry < 0) return count;
      idx[carry]++;
      if (idx[carry] < axes[keys[carry]].length) break;
      idx[carry] = 0;
      carry--;
    }
  }
}

/** 全格比对:strictRelaxQualifies 与参考实现逐组合必须同值。 */
function compareGrid(axes, fixed) {
  const mismatches = [];
  let n = 0;
  eachCombo(axes, (inp) => {
    const full = { ...inp, ...fixed };
    n++;
    const mine = strictRelaxQualifies(full);
    const ref = refShouldRelax(full);
    if (mine !== ref && mismatches.length < 5) mismatches.push({ full, mine, ref });
  });
  return { n, mismatches };
}

const ON = { relayDeadEndpointRelax: true, allowStrictAutoRelaxOnProcess: true, minFailures: 1 };

test('D-01 语义锚点(实测场景,两侧同值)', () => {
  const base = {
    strictPreferredOnly: true,
    userPinnedAdapter: false,
    failuresOnPreferred: 1,
    ...ON,
  };
  const anchor = (over, want) => {
    const inp = { ...base, ...over };
    assert.strictEqual(refShouldRelax(inp), want, `参考侧 ${JSON.stringify(over)}`);
    assert.strictEqual(strictRelaxQualifies(inp), want, `叶子侧 ${JSON.stringify(over)}`);
  };
  // 死端点锚点(用户 trae 死端点的真实类型;:2519 注释自证)
  anchor({ preferredAdapter: 'api', entryKey: 'api', errorType: 'model_not_found', isHttpRelay: true }, true);
  // 桥接类不覆盖 model_not_found(HTTP relay 与桥接类路径的分野,doc §1.2)
  anchor({ preferredAdapter: 'trae', entryKey: 'trae', errorType: 'model_not_found', isProcessSensitive: true }, false);
  // 桥接类 process/timeout/network/队列超时/瞬态 → 放宽
  anchor({ preferredAdapter: 'trae', entryKey: 'trae', errorType: 'process', isProcessSensitive: true }, true);
  anchor({ preferredAdapter: 'trae', entryKey: 'trae', errorType: 'timeout', isProcessSensitive: true }, true);
  anchor({ preferredAdapter: 'trae', entryKey: 'trae', errorType: 'network', isProcessSensitive: true }, true);
  anchor({ preferredAdapter: 'trae', entryKey: 'trae', errorType: 'unknown', isProcessSensitive: true, errorMessage: 'adapter trae queue timeout' }, true);
  anchor({ preferredAdapter: 'trae', entryKey: 'trae', errorType: 'unknown', isProcessSensitive: true, errorMessage: 'socket hang up' }, true);
  // HTTP relay 不覆盖 network(同型失败取决于通道类型 —— doc §1.2 记录在案,三期才收紧)
  anchor({ preferredAdapter: 'api', entryKey: 'api', errorType: 'network', isHttpRelay: true }, false);
  // auth/rate_limit 两路都不放宽(注释哲学的叶子化)
  anchor({ preferredAdapter: 'api', entryKey: 'api', errorType: 'auth', isHttpRelay: true }, false);
  anchor({ preferredAdapter: 'trae', entryKey: 'trae', errorType: 'rate_limit', isProcessSensitive: true }, false);
  // 钉选/auto/非首选入口/门关闭
  anchor({ preferredAdapter: 'api', entryKey: 'api', errorType: 'model_not_found', isHttpRelay: true, userPinnedAdapter: true }, false);
  anchor({ preferredAdapter: 'auto', entryKey: 'auto', errorType: 'process', isProcessSensitive: true }, false);
  anchor({ preferredAdapter: 'api', entryKey: 'other', errorType: 'model_not_found', isHttpRelay: true }, false);
  anchor({ preferredAdapter: 'api', entryKey: 'api', errorType: 'model_not_found', isHttpRelay: true, relayDeadEndpointRelax: false }, false);
  anchor({ preferredAdapter: 'trae', entryKey: 'trae', errorType: 'process', isProcessSensitive: true, allowStrictAutoRelaxOnProcess: false }, false);
});

test('D-02 全格等价(主网格:大小写漂移/空串/undefined 边界全覆盖)', () => {
  const axes = {
    strictPreferredOnly: [true, false],
    userPinnedAdapter: [true, false],
    preferredAdapter: ['cli', 'api', 'auto', 'Auto', 'CLI', '', undefined],
    entryKey: ['cli', 'api', 'CLI', 'other', '', undefined],
    errorType: ['process', 'timeout', 'network', 'model_not_found', 'unavailable', 'bad_request', 'server_error', 'auth', 'rate_limit', 'weird', ''],
    errorMessage: ['', 'adapter cli queue timeout', 'queue task timeout', 'reconnecting', 'channel closed', 'stream idle timeout', 'socket hang up', 'failed to record rollout items', 'getaddrinfo eai_again'],
    isHttpRelay: [true, false],
    isProcessSensitive: [true, false],
    failuresOnPreferred: [0, 1],
  };
  const { n, mismatches } = compareGrid(axes, ON);
  const expected = Object.values(axes).reduce((acc, arr) => acc * arr.length, 1);
  assert.strictEqual(n, expected, `组合数 ${n} 应为 ${expected}`);
  assert.deepStrictEqual(mismatches, [], `等价性偏差 ${mismatches.length} 例(截前 5)`);
});

test('D-03 全格等价(门网格:两门 × failures 边界)', () => {
  const axes = {
    strictPreferredOnly: [true, false],
    userPinnedAdapter: [true, false],
    relayDeadEndpointRelax: [true, false],
    allowStrictAutoRelaxOnProcess: [true, false],
    preferredAdapter: ['cli', 'api'],
    entryKey: ['cli', 'other'],
    errorType: ['process', 'network', 'model_not_found', 'auth'],
    errorMessage: ['', 'queue task timeout'],
    isHttpRelay: [true, false],
    isProcessSensitive: [true, false],
    failuresOnPreferred: [0, 1, 2],
  };
  const { n, mismatches } = compareGrid(axes, { minFailures: 1 });
  const expected = Object.values(axes).reduce((acc, arr) => acc * arr.length, 1);
  assert.strictEqual(n, expected, `组合数 ${n} 应为 ${expected}`);
  assert.deepStrictEqual(mismatches, [], `等价性偏差 ${mismatches.length} 例(截前 5)`);
});

test('D-04 minFailures 边界:连败计数恰达阈值才放宽(1/2 两档)', () => {
  const inp = { strictPreferredOnly: true, userPinnedAdapter: false, preferredAdapter: 'api', entryKey: 'api', errorType: 'server_error', errorMessage: '', isHttpRelay: true, isProcessSensitive: false, relayDeadEndpointRelax: true, allowStrictAutoRelaxOnProcess: true };
  for (const [failures, min, want] of [[0, 1, false], [1, 1, true], [1, 2, false], [2, 2, true], [3, 2, true]]) {
    assert.strictEqual(strictRelaxQualifies({ ...inp, failuresOnPreferred: failures, minFailures: min }), want, `failures=${failures} min=${min}`);
    assert.strictEqual(refShouldRelax({ ...inp, failuresOnPreferred: failures, minFailures: min }), want, `参考侧 failures=${failures} min=${min}`);
  }
});

test('D-05 门缺省视为开(与 gateway 默认 GATEWAY_STRICT_AUTO_RELAX_ON_PROCESS=true / KHY_RELAY_DEADENDPOINT_RELAX=true 对齐)', () => {
  assert.strictEqual(
    strictRelaxQualifies({ strictPreferredOnly: true, preferredAdapter: 'api', entryKey: 'api', errorType: 'model_not_found', isHttpRelay: true, failuresOnPreferred: 1 }),
    true,
  );
  assert.strictEqual(
    strictRelaxQualifies({ strictPreferredOnly: true, preferredAdapter: 'cli', entryKey: 'cli', errorType: 'process', isProcessSensitive: true }),
    true,
  );
});

test('D-06 绝不抛:strictRelaxQualifies 坏输入 → false', () => {
  for (const h of [undefined, null, 0, 'str', [], { preferredAdapter: { toString() { throw new Error('boom'); } } }]) {
    assert.doesNotThrow(() => strictRelaxQualifies(h));
  }
  assert.strictEqual(strictRelaxQualifies(), false);
});
