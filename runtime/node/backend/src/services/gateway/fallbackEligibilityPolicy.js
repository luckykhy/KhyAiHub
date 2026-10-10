'use strict';

/**
 * fallbackEligibilityPolicy — 纯叶子:把「什么时候允许甩出(跨通道兜底)」显式化为
 * **归属(ownership) → 三态决策(F 甩 / E 环境级不甩 / B 停下报错)** 两段式, 并聚合
 * 「环境级不通」的跨通道证据。真源设计: docs/03_DESIGN_设计/DESIGN-ARCH/
 * [DESIGN-ARCH-181] 通道兜底(甩出)资格与披露统一策略.md 的 D1/D2 表。
 *
 * 排障背景:用户体感「不通时不会清楚报错,反而总是发去桥接或 claude 渠道」。实测
 * 病灶是 6 处甩出决策点(isReference: aiGatewayGenerateMethod.js:2497-2549、
 * aiGatewayRoutingMethods.js:512-549/854-990、:2585-2631、:2214-2228)各带一套
 * 判据且互不一致 —— 同一种「不通」,HTTP relay 通道要命中死端点类才放宽,桥接类
 * (PROCESS_SENSITIVE)见 process/timeout/network 就放宽;而「环境级(网络/代理全断)」
 * 这个归属**根本不存在**,断网时会把所有远端通道轮流甩一遍。
 *
 * 本叶子是 [181] 一期「只读判定」落地物, 二期起被接线消费(级联环境级跳过 / jitter
 * 前置判定 / 失败报告注记三处; 回滚面 options.fallbackOwnership=false 逐字节回退)。
 * 它回答四个纯问题:
 *   ① 一条失败属于谁(channel / environment / request);
 *   ② 证据是否已构成「环境级不通」(≥2 个不同远端 network/timeout 复现, 或本机
 *      解析/代理特征码);
 *   ③ 据此决策该不该甩(F/E/B), 以及既有 S2/S3 的 strict 放宽判据的等价复现(二期
 *      已收拢: aiGatewayGenerateMethod.js 的 S2/S3 决策点直接消费 strictRelaxQualifies);
 *   ④ 环境级成立后的接线规划: 跳过哪些目的地、如何留痕、证据窗口如何随整轮重跑重置
 *      (planEnvOutageSkipStep / isEnvOutageActive / resetEnvOutagePass, 二期新增)。
 *
 * 判据表(D1, 与 [181] §3 一致):
 *   channel-scoped: server_error(5xx)/process/unavailable/瞬态传输/单通道
 *     network、timeout → F(甩)。
 *   environment-scoped: 跨通道复现证据或 EAI_AGAIN/getaddrinfo/ENOTFOUND/proxy
 *     tunnel/tunneling socket 特征码 → E(不甩远端, 交给「等待网络恢复」; 本地通道
 *     ollama/localLLM 仍可尝试)。注: ECONNREFUSED 单独**不构成**环境证据(更像
 *     目标端点死)。
 *   request-scoped: auth(401/403)/rate_limit(429)/bad_request(400)/
 *     model_not_found(404) → B(停下报错; 换通道会掩盖「该修 key/该等窗口」)。
 *   钉选矩阵: 用户显式钉选(userPinnedAdapter)恒为 B —— 「要么成功、要么明确报错」
 *   ([DESIGN-ARCH-139] 语义,本叶子不回退它);env 钉选与 auto 受归属判据约束。
 *
 * 证据权重(D2):network=2、timeout=1(降权: 慢端点也可能超时), 按**不同远端适配器**
 * 去重后求和, ≥3 即成立(即 2×network, 或 1×network+1×timeout, 或 3×timeout);
 * 另有「全轮无远端成功」闸门(任一端点成功即证伪环境级)。本地通道(默认
 * ollama/localLLM, 真源 aiGateway.js:2295-2297 的 _localAdapters + KHY_LOCAL_ADAPTERS)
 * 不计入远端失败, 也不证伪(local 成功恰是环境级的典型表现)。
 *
 * SSOT 引用(不复制、只 require):
 *   - isDeadEndpointErrorType / isReconnectOrChannelClosedMessage: ./gatewayErrorClassifier;
 *   - DEFAULT_ROUTE_MANUAL_FALLBACK_KEYS: ./gatewayConstants。
 * 桥接类集合 PROCESS_SENSITIVE_ADAPTER_KEYS(aiGateway.js:1214-1224)未导出, 故由调用方
 * 传入(不复制该集合, 防漂移); 同上, KHY_LOCAL_ADAPTERS 扩展后的本地集合如与默认不同,
 * 调用方一并传入。
 *
 * 契约:纯叶子——零 IO、确定性、绝不抛(任何异常 → 安全缺省)、可单测; 不读 env、
 * 不写日志。判据只吃已读入的数据。
 */

const {
  isDeadEndpointErrorType,
  isReconnectOrChannelClosedMessage,
} = require('./gatewayErrorClassifier');
const { DEFAULT_ROUTE_MANUAL_FALLBACK_KEYS } = require('./gatewayConstants');

/** 默认本地通道集合(真源: aiGateway.js:2295-2297;扩展走 KHY_LOCAL_ADAPTERS,由调用方传入覆盖)。 */
const DEFAULT_LOCAL_ADAPTER_KEYS = Object.freeze(['ollama', 'localLLM']);

/** request 侧(不该甩)错误类型。与 :2515-2519 注释哲学及 D1 表对齐。 */
const REQUEST_SIDE_ERROR_TYPES = new Set([
  'auth',
  'permission',
  'rate_limit',
  'bad_request',
  'model_not_found',
]);

/** channel 侧(该甩)错误类型。 */
const CHANNEL_SIDE_ERROR_TYPES = new Set([
  'server_error',
  'process',
  'timeout',
  'network',
  'unavailable',
]);

/** 本机解析/代理特征码(证据 B)。刻意不含 ECONNREFUSED(视为目标端点死, 非环境级)。 */
const ENV_SIGNATURE_RE = /\beai_again\b|getaddrinfo|\benotfound\b|proxy tunnel|tunneling socket/i;

/** 同源正则的全局扫描副本:仅用于收集一条消息里的**全部**命中特征码(source 共享, 防漂移)。 */
const ENV_SIGNATURE_ALL_RE = new RegExp(ENV_SIGNATURE_RE.source, 'gi');

/** 队列超时消息(:2542 同款)。 */
const QUEUE_TIMEOUT_RE = /adapter\s+\S+\s+queue timeout|queue task timeout/;

/** 归一化错误类型:小写去空白。绝不抛。 */
function _type(v) {
  try {
    return String(v == null ? '' : v)
      .trim()
      .toLowerCase();
  } catch {
    return '';
  }
}

/** 归一化适配器 key:小写去空白。绝不抛。 */
function _key(v) {
  return _type(v);
}

/** 归一化消息:小写。绝不抛。 */
function _lower(v) {
  try {
    return String(v == null ? '' : v).toLowerCase();
  } catch {
    return '';
  }
}

/** 瞬态传输消息(_isTransientGatewayTransportMessage 同款, 真源 aiGateway.js:146-152)。 */
function _isTransient(msgLower) {
  return isReconnectOrChannelClosedMessage(msgLower) || /stream idle timeout|socket hang up/.test(msgLower);
}

/**
 * 单条失败的归属分类(D1 第一段)。纯函数、绝不抛。
 *
 * 顺序:HTTP 码(最硬) → 类型名 → 5xx → 环境特征码 → channel 类型/消息 → unknown。
 * 注意:单条失败的 'environment' 只来自特征码(证据 B); 证据 A(跨通道复现)由
 * probeEnvironmentOutage 聚合, 不在本函数内。
 *
 * @param {object} args { errorType, statusCode, error|errorMessage }
 * @returns {'channel'|'environment'|'request'|'unknown'}
 */
function classifyFailureOwnership(args = {}) {
  try {
    const a = args && typeof args === 'object' ? args : {};
    const sc = Number(a.statusCode) || 0;
    if (sc === 401 || sc === 403 || sc === 429 || sc === 400 || sc === 404) {
      return 'request';
    }
    const type = _type(a.errorType);
    if (REQUEST_SIDE_ERROR_TYPES.has(type)) {
      return 'request';
    }
    if (sc >= 500 && sc <= 599) {
      return 'channel';
    }
    const msg = _lower(a.error != null ? a.error : a.errorMessage);
    if (ENV_SIGNATURE_RE.test(msg)) {
      return 'environment';
    }
    if (CHANNEL_SIDE_ERROR_TYPES.has(type)) {
      return 'channel';
    }
    if (QUEUE_TIMEOUT_RE.test(msg) || _isTransient(msg)) {
      return 'channel';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 环境级不通的证据聚合(D2)。纯函数、绝不抛。
 *
 * 证据 A:按**不同远端适配器**去重的 network(权重2)/timeout(权重1)失败, 权重和 ≥3。
 * 证据 B:任一失败消息命中 ENV_SIGNATURE_RE(本机解析/代理特征码, 单条即成立)。
 * 闸门:全轮出现**远端成功**即证伪(环境可通); local 成功不证伪。virtualSkip 不计。
 *
 * @param {object} args { attempts, localAdapterKeys? }
 * @returns {{environmental:boolean, evidence:string[], remoteAdaptersFailed:number}}
 */
function probeEnvironmentOutage(args = {}) {
  try {
    return _aggregateOutage(args && typeof args === 'object' ? args : {});
  } catch {
    return { environmental: false, evidence: [], remoteAdaptersFailed: 0 };
  }
}

/** D2 证据扫描：逐条 attempt 归集出「远端是否成功证伪 / 特征码集合 / 各远端适配器最高权重」。 */
function _collectOutageEvidence(a) {
  const attempts = Array.isArray(a.attempts) ? a.attempts : [];
  const localList = Array.isArray(a.localAdapterKeys) ? a.localAdapterKeys : DEFAULT_LOCAL_ADAPTER_KEYS;
  const local = new Set(localList.map(_key).filter(Boolean));
  const byKey = new Map();
  const signatures = new Set();
  let remoteSuccess = false;
  for (const raw of attempts) {
    if (!raw || typeof raw !== 'object') continue;
    const key = _key(raw.adapterKey != null ? raw.adapterKey : raw.provider != null ? raw.provider : raw.adapter);
    const isLocal = !!key && local.has(key);
    if (raw.success === true) {
      // 远端成功即证伪环境级；local 成功不证伪（local 通恰是环境级的典型表现）。
      remoteSuccess = remoteSuccess || (!!key && !isLocal);
      continue;
    }
    if (raw.virtualSkip === true) continue;
    const msg = _lower(raw.error != null ? raw.error : raw.message != null ? raw.message : raw.rawError);
    const hits = msg.match(ENV_SIGNATURE_ALL_RE);
    if (hits) for (const t of hits) signatures.add(String(t).toUpperCase());
    if (!key || isLocal) continue;
    const type = _type(raw.errorType);
    const w = type === 'network' ? 2 : type === 'timeout' ? 1 : 0;
    const cell = byKey.get(key) || { weight: 0 };
    if (w > cell.weight) cell.weight = w;
    byKey.set(key, cell);
  }
  return { byKey, signatures, remoteSuccess };
}

/** 由扫描结果算结论（权重和 ≥3 或特征码非空，且无远端成功）与可读证据行。 */
function _aggregateOutage(a) {
  const { byKey, signatures, remoteSuccess } = _collectOutageEvidence(a);
  const keys = [];
  let weightSum = 0;
  for (const entry of byKey.entries()) {
    if (entry[1].weight > 0) {
      keys.push(entry[0]);
      weightSum += entry[1].weight;
    }
  }
  const environmental = !remoteSuccess && (weightSum >= 3 || signatures.size > 0);
  const evidence = [];
  if (environmental) {
    if (signatures.size > 0) evidence.push(`环境特征码: ${[...signatures].join(', ')}`);
    if (weightSum >= 3) {
      evidence.push(`跨通道网络失败: ${keys.join(', ')}（权重 ${weightSum} ≥3）`);
    }
  }
  return { environmental, evidence, remoteAdaptersFailed: keys.length };
}

/**
 * 三态决策(D1 第二段 + 钉选矩阵)。纯函数、绝不抛。
 * 顺序(首个命中即停):用户钉选 → request 侧 → 环境级 → channel 侧 → 未知(保守停下)。
 *
 * E 的两个入口(同一结论的两个来源,取或):
 *   ① environmental===true —— D2 聚合判定(推荐入口;已含「远端成功证伪」闸门);
 *   ② ownership==='environment' —— 单条特征码归属(证据 B 按 D1 表单条即成立)。
 * 若调用方已跑聚合且被远端成功证伪(environmental:false),不应同时再传
 * ownership:'environment' —— 该归属仅来自特征码,特征码被证伪时归属应重判(判据 ① 优先)。
 *
 * reason 取值:user-pinned / request-scoped / environment-scoped / environment-signature /
 * channel-scoped / unknown-ownership / exception-fallback。
 *
 * @param {object} args { pinKind?:'user'|'env'|'none', ownership, environmental? }
 * @returns {{decision:'F'|'E'|'B', ownership:string, reason:string}}
 */
function decideFallback(args = {}) {
  try {
    const a = args && typeof args === 'object' ? args : {};
    const pin = _lower(a.pinKind);
    const ownership = _type(a.ownership) || 'unknown';
    if (pin === 'user') {
      return { decision: 'B', ownership, reason: 'user-pinned' };
    }
    if (ownership === 'request') {
      return { decision: 'B', ownership, reason: 'request-scoped' };
    }
    if (a.environmental === true) {
      return { decision: 'E', ownership: 'environment', reason: 'environment-scoped' };
    }
    if (ownership === 'environment') {
      return { decision: 'E', ownership, reason: 'environment-signature' };
    }
    if (ownership === 'channel') {
      return { decision: 'F', ownership, reason: 'channel-scoped' };
    }
    return { decision: 'B', ownership, reason: 'unknown-ownership' };
  } catch {
    return { decision: 'B', ownership: 'unknown', reason: 'exception-fallback' };
  }
}

/**
 * 目的地分类(D1 目的地资格表)。纯函数、绝不抛。
 * 顺序:manual(人肉, 自动级联禁甩) → bridge(桥接类, 有本机进程副作用) →
 * local(本地无网络依赖) → remote。manual 优先于 bridge 与 local(策略性红线)。
 * 集合缺省:local = DEFAULT_LOCAL_ADAPTER_KEYS;manual = gatewayConstants SSOT;
 * bridge 无缺省(调用方传 PROCESS_SENSITIVE_ADAPTER_KEYS, 不复制防漂移)。
 *
 * @param {string} adapterKey
 * @param {object} [opts] { localKeys?, manualKeys?, processSensitiveKeys? }
 * @returns {'local'|'manual'|'bridge'|'remote'|'unknown'}
 */
function classifyDestination(adapterKey, opts = {}) {
  try {
    const key = _key(adapterKey);
    if (!key) return 'unknown';
    const o = opts && typeof opts === 'object' ? opts : {};
    const manualSrc = o.manualKeys !== undefined ? o.manualKeys : DEFAULT_ROUTE_MANUAL_FALLBACK_KEYS;
    const manual = new Set(_iterKeys(manualSrc));
    if (manual.has(key)) return 'manual';
    if (o.processSensitiveKeys !== undefined) {
      const bridge = new Set(_iterKeys(o.processSensitiveKeys));
      if (bridge.has(key)) return 'bridge';
    }
    const localSrc = o.localKeys !== undefined ? o.localKeys : DEFAULT_LOCAL_ADAPTER_KEYS;
    const local = new Set(_iterKeys(localSrc));
    if (local.has(key)) return 'local';
    return 'remote';
  } catch {
    return 'unknown';
  }
}

/** 把 Set/数组/逗号串安全转成 key 数组(绝不抛)。 */
function _iterKeys(src) {
  try {
    if (src instanceof Set) return [...src].map(_key).filter(Boolean);
    if (Array.isArray(src)) return src.map(_key).filter(Boolean);
    if (typeof src === 'string') {
      return src
        .split(',')
        .map((s) => s.trim())
        .map(_key)
        .filter(Boolean);
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * 既有 S2/S3「strict 放宽」判据的等价复现(aiGatewayGenerateMethod.js:2497-2549 的
 * _shouldRelaxStrictPreferredOnFailure 本体)。纯函数、绝不抛。
 *
 * 二期(2026-10-04)已收拢: S2/S3 决策点改为直接消费本函数(该文件原内联实现已删,
 * 全格等价由 fallbackEligibilityPolicy.test.js D 组 ≈13 万组合对拍钉住)。
 * 未收拢: S3 前置块(:2477-2496 recent-process 预放宽)、S4 解钉、S5 提升 —— 判据不含
 * 错误类型面或语义属「进程探测提升」, 无等价映射面; 强行收拢=恒真伪调用或行为漂移,
 * 留待三期随 D1 收紧统一设计(见 [181] §11 偏离-2)。
 *
 * @param {object} args
 * @param {boolean} args.strictPreferredOnly
 * @param {boolean} args.userPinnedAdapter
 * @param {string}  args.preferredAdapter
 * @param {string}  args.entryKey
 * @param {string}  args.errorType
 * @param {string}  [args.errorMessage]
 * @param {boolean} [args.isHttpRelay]           首选是否 HTTP relay/api/relay 类
 * @param {boolean} [args.isProcessSensitive]    首选是否桥接类
 * @param {number}  [args.failuresOnPreferred]   该通道连续失败计数
 * @param {number}  [args.minFailures]           放宽阈值(默认 1)
 * @param {boolean} [args.relayDeadEndpointRelax] 门(缺省视为开)
 * @param {boolean} [args.allowStrictAutoRelaxOnProcess] 门(缺省视为开)
 * @returns {boolean}
 */
function strictRelaxQualifies(args = {}) {
  try {
    const a = args && typeof args === 'object' ? args : {};
    if (!a.strictPreferredOnly) return false;
    if (a.userPinnedAdapter) return false;
    // key 比较刻意用**原始字符串**(与 :2505-2510 逐字符一致)—— 不做小写归一,
    // 否则大小写漂移输入会引入一类等价性偏差点,「全格等价」承诺出现裂缝。
    const preferred = a.preferredAdapter;
    if (!preferred || preferred === 'auto') return false;
    if (a.entryKey !== preferred) return false;
    const type = _type(a.errorType);
    const msg = _lower(a.errorMessage);
    const minFailures = Math.max(1, parseInt(a.minFailures, 10) || 1);
    if (
      a.relayDeadEndpointRelax !== false &&
      a.isHttpRelay === true &&
      isDeadEndpointErrorType(type) &&
      Number(a.failuresOnPreferred || 0) >= minFailures
    ) {
      return true;
    }
    if (a.allowStrictAutoRelaxOnProcess === false) return false;
    if (a.isProcessSensitive !== true) return false;
    if (type === 'process' || type === 'timeout' || type === 'network') return true;
    if (QUEUE_TIMEOUT_RE.test(msg)) return true;
    if (_isTransient(msg)) return true;
    return false;
  } catch {
    return false;
  }
}

/** 环境级证据窗口:只统计 floor 之后的 attempts(整轮重跑前置新,防上轮证据误判本轮)。绝不抛。 */
function _probeWithinWindow(s, attempts) {
  const lk = s.localKeys == null ? undefined : _iterKeys(s.localKeys);
  const floor = Number.isFinite(s.floor) && s.floor > 0 ? Math.floor(s.floor) : 0;
  const list = Array.isArray(attempts) ? attempts : [];
  return probeEnvironmentOutage({
    attempts: floor > 0 ? list.slice(floor) : list,
    localAdapterKeys: lk,
  });
}

/**
 * 「环境级跳过」接线规划(D2 消费点一/二/三共用)。纯函数、绝不抛。
 *
 * state 为调用方持有的状态袋 { policyOn, localKeys?, armed, floor, announced? }:
 *   policyOn —— 回滚面(options.fallbackOwnership !== false);false 时恒空转;
 *   localKeys —— 本地通道集合(缺省用 DEFAULT_LOCAL_ADAPTER_KEYS);
 *   armed/floor/announced —— 证据窗口与单次宣布状态(由调用方依返回值更新)。
 *
 * @param {string} entryKey 当前待判定适配器 key
 * @param {Array} attempts 真源 attempts(函数只读 floor 之后的窗口, 不修改数组)
 * @returns {{arm:boolean, skip:boolean, statusText:string, skipEntry:object|null}}
 */
function planEnvOutageSkipStep(state, entryKey, attempts) {
  try {
    const s = state && typeof state === 'object' ? state : {};
    const none = { arm: false, skip: false, statusText: '', skipEntry: null };
    if (s.policyOn !== true) return none;
    const key = _key(entryKey);
    if (!key) return none;
    const level = _probeWithinWindow(s, attempts);
    if (!level.environmental) return none;
    const dest = classifyDestination(key, { localKeys: s.localKeys, manualKeys: s.manualKeys });
    if (dest !== 'remote') return { arm: true, skip: false, statusText: '', skipEntry: null };
    const logged =
      Array.isArray(attempts) &&
      attempts.some((a) => a && a.adapterKey === key && a.errorType === 'env_outage_skip');
    return {
      arm: true,
      skip: true,
      statusText:
        s.announced === true
          ? ''
          : `检测到跨通道网络不可达，暂停远端尝试，转为等待网络恢复（${level.evidence.join('；')}）`,
      skipEntry: logged
        ? null
        : {
            provider: key,
            adapterKey: key,
            success: false,
            error: `${key} skipped: environment outage — remote attempts paused (cross-channel network unreachable)`,
            statusCode: 0,
            errorType: 'env_outage_skip',
            virtualSkip: true,
          },
    };
  } catch {
    return { arm: false, skip: false, statusText: '', skipEntry: null };
  }
}

/**
 * 环境级是否生效(armed 短路径或当前证据窗口成立)。供 jitter 前置(消费点二)与
 * 失败报告注记(消费点三)判定。纯函数、绝不抛。
 */
function isEnvOutageActive(state, attempts) {
  try {
    const s = state && typeof state === 'object' ? state : {};
    if (s.policyOn !== true) return false;
    return s.armed === true || _probeWithinWindow(s, attempts).environmental;
  } catch {
    return false;
  }
}

/** 整轮重跑(jitter/续传)前置新证据窗口:armed/announced 归零, floor=当前 attempts 长度。绝不抛。 */
function resetEnvOutagePass(state, attempts) {
  try {
    const s = state && typeof state === 'object' ? state : {};
    s.armed = false;
    s.announced = false;
    s.floor = Array.isArray(attempts) ? attempts.length : 0;
  } catch {
    /* 绝不抛:重置失败不影响请求主流程 */
  }
}

/** 失败报告顶部的环境级注记(D2 消费点三;与 D3-3 信封 hint 同源语义)。 */
const ENV_OUTAGE_REPORT_NOTE =
  '⚑ 网络/代理不通（不是通道问题）：跨通道远端均不可达。检查网络与代理（khy doctor）；恢复后说「继续」重试。\n\n';

module.exports = {
  classifyFailureOwnership,
  probeEnvironmentOutage,
  decideFallback,
  classifyDestination,
  strictRelaxQualifies,
  planEnvOutageSkipStep,
  isEnvOutageActive,
  resetEnvOutagePass,
  ENV_OUTAGE_REPORT_NOTE,
  DEFAULT_LOCAL_ADAPTER_KEYS,
  REQUEST_SIDE_ERROR_TYPES,
  CHANNEL_SIDE_ERROR_TYPES,
  ENV_SIGNATURE_RE,
};
