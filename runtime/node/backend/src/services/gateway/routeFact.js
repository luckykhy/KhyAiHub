'use strict';

/**
 * routeFact.js — 路由事实快照（单一真源）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么存在（真实事故，2026-09-17）
 * ════════════════════════════════════════════════════════════════════════════
 * 现象：页脚显示 `agnes-3.0-flash`，报错却写 `windsurf [unavailable]`——同一屏上下矛盾。
 *
 * 根因不是「显示错了」，而是**三处显示各自推导、无人负责一致性**：
 *
 *   ① 页脚模型名  ← gateway.getActiveAdapter().activeModel
 *                    （会**聪明地绕开**不可用钉选通道 → Tier2 lastVerified → agnes）
 *   ② 页脚通道名  ← process.env.GATEWAY_PREFERRED_ADAPTER
 *                    （读的是「声明」，不是「实际」）
 *   ③ 报错正文    ← generate() 的 allAttempts
 *                    （会**死板地钉死**在同名通道上 → windsurf unavailable）
 *
 * 同一个 `GATEWAY_PREFERRED_ADAPTER=windsurf`，两个消费点容错策略相反：
 * `getActiveAdapter()` 跳过坏通道、`generate()` 死在坏通道上。于是「意图」被展示成
 * 「事实」，而「事实」只在报错里出现一次。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 修法：不修「显示」，修「口径」
 * ════════════════════════════════════════════════════════════════════════════
 * 把「用户想要什么 / 网关解析成什么 / 实际发了什么 / 谁成功了」固化成**一个对象**，
 * 每次 generate 结束（无论成败）产出一份，所有展示点只读它，禁止自行推导。
 *
 * 字段语义是**唯一的**，任何消费方不得重新解释：
 *
 *   requested  用户/环境声明的意图（GATEWAY_PREFERRED_ADAPTER / _MODEL）
 *   resolved   网关解析后的选路（getActiveAdapter 的结果）
 *   attempted  实际发出的第一个请求（firstTriedAdapter）
 *   served     真正成功的那个（失败时为 null）
 *   outcome    'ok' | 'failed'
 *   strictPinned  是否被 GATEWAY_PREFERRED_STRICT 硬钉（true 时禁止回退）
 *   pinnedUnavailable  pinned 通道是否不可用（strictPinned 下即硬失败原因）
 *   cascade    逐跳链（[DESIGN-ARCH-181] D3-1，由 result.attempts 派生）：
 *              [{ adapter, errorType, cause, decision:'fallback'|'skip'|'failed' }]；
 *              虚拟跳过也计入（cause 标 virtualSkip）；「首跳即成功」无切换 → 空数组
 *   switchedFrom 与 served 不同的首跳来源（无切换或失败时为 ''）
 *   switchReason 首跳失败类别（归一化 errorType，非原始消息；无切换时为 ''）
 *   environmental 环境级不通结论（D2 证据聚合透出；判据见 fallbackEligibilityPolicy）
 *
 * 一致性不变式（可断言，见 _assertCoherent）：
 *   - outcome==='ok'   ⟺ served 非空
 *   - outcome==='failed' → served === null
 *   - strictPinned && pinnedUnavailable → outcome==='failed'
 *   - environmental===true → cascade 中**远端**条目 decision 全为 skip/failed
 *   - outcome==='ok' && cascade.length>0 → switchedFrom 非空
 *
 * 本模块是**纯叶子**：零 IO、不读 env、不写日志、绝不抛。唯一 require 是同级纯叶子
 * fallbackEligibilityPolicy（D2 证据聚合；叶子→叶子，契约守卫放行）。
 * env 快照由调用方传入（`env` 参数），保证同一请求内多次调用口径稳定，
 * 也避免并发请求互相污染 process.env 时读到漂移值。
 */

/** 结果类型白名单——防止把任意字符串当 outcome 透传给 UI。 */
const OUTCOMES = Object.freeze(['ok', 'failed']);

// D2 证据聚合(D3-1 的 environmental 字段来源)。叶子→叶子 require,契约守卫放行。
const { probeEnvironmentOutage, DEFAULT_LOCAL_ADAPTER_KEYS } = require('./fallbackEligibilityPolicy');

/**
 * 从任意值安全取出非空字符串（去空白）。
 * @param {unknown} v
 * @returns {string}
 */
function _str(v) {
  return v == null ? '' : String(v).trim();
}

/**
 * 判断首选通道是否被显式钉选（非空且非 'auto'）。
 *
 * 'auto' 是 khy 的**哨兵值**，语义是「交给网关按健康度级联」，与「未设置」同义；
 * 若把它当成钉选通道名，会去 _adapters 里找一个叫 'auto' 的适配器，必然落空，
 * 进而误判 pinnedUnavailable=true → 页脚恒显告警。故必须在此显式排除。
 *
 * @param {string} adapter
 * @returns {boolean}
 */
function isPinnedAdapter(adapter) {
  const a = _str(adapter).toLowerCase();
  return !!a && a !== 'auto';
}

/**
 * 解析 strict 开关。语义与 aiChatCore.js:734 保持逐字一致：
 * **仅当显式等于 'false' 时**才是非 strict，其余（含未设置、空串）一律 strict。
 *
 * 这个「默认 true」的取向是刻意的——它让「配了钉选通道但忘了配 strict」时
 * 行为可预期（钉死），代价是容易硬失败；因此在 routeFact 里必须如实标注，
 * 让页脚能把这个隐性风险显性化。
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {boolean}
 */
function isStrictPinned(env) {
  const raw = _str((env || {}).GATEWAY_PREFERRED_STRICT).toLowerCase();
  return raw !== 'false';
}

/**
 * 构造空的（尚未发生路由的）事实快照。
 * 供 UI 初始化、以及任何拿不到 result 的降级路径使用——保证消费方**永远有对象可读**，
 * 不必写 `routeFact?.requested?.adapter ?? ...` 这类多级兜底。
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {object}
 */
function createEmptyRouteFact(env) {
  return {
    requested: { adapter: '', model: '' },
    resolved: { adapter: '', model: '' },
    attempted: { adapter: '', model: '' },
    served: null,
    outcome: 'failed',
    strictPinned: false,
    pinnedUnavailable: false,
    cascade: [],
    switchedFrom: '',
    switchReason: '',
    environmental: false,
    reason: '',
    at: 0,
  };
}

/**
 * 从 generate 的 result 构造路由事实快照。
 *
 * **只读** result，绝不修改它（调用方可能在多处复用同一对象）。
 * 任何字段缺失都降级为空串/null，绝不抛——本函数的失败会让整个 generate 出口崩掉，
 * 那是不可接受的（页脚诊断信息永远不该成为请求成败的变量）。
 *
 * @param {object|null|undefined} result  generate 的返回值
 * @param {object} [options]
 * @param {Record<string,string|undefined>} [options.env]  env 快照（缺省读 process.env）
 * @param {number} [options.at]  时间戳（缺省 Date.now()；显式传入以保证确定性测试）
 * @param {boolean} [options.pinnedUnavailable]  钉选通道是否不可用（由调用方判定）
 * @returns {object}
 */
function buildRouteFact(result, options = {}) {
  const env = options.env || {};
  const r = result && typeof result === 'object' ? result : {};

  const requestedAdapter = _str(env.GATEWAY_PREFERRED_ADAPTER);
  const requestedModel = _str(env.GATEWAY_PREFERRED_MODEL);
  const strictPinned = isPinnedAdapter(requestedAdapter) && isStrictPinned(env);

  // resolved：网关解析后的选路。result 上的 preferredAdapter 是「解析期钉选」，
  // actualAdapter 才是「真正选中的」——两者不同正是错位 A 的物质体现，故都保留。
  const resolvedAdapter = _str(r.preferredAdapter) || requestedAdapter;
  const attemptedAdapter = _str(r.actualAdapter) || _str(r.adapter);

  const success = !!r.success;
  const servedAdapter = success ? _str(r.actualAdapter) || _str(r.adapter) : '';

  const pinnedUnavailable = options.pinnedUnavailable === true;

  const fact = {
    requested: { adapter: requestedAdapter, model: requestedModel },
    resolved: { adapter: resolvedAdapter, model: _str(r.model) || requestedModel },
    attempted: { adapter: attemptedAdapter, model: _str(r.model) || requestedModel },
    served: servedAdapter
      ? { adapter: servedAdapter, model: _str(r.model) || requestedModel }
      : null,
    outcome: success ? 'ok' : 'failed',
    strictPinned,
    pinnedUnavailable,
    reason: _str(r.error) || _str(r.fallbackReason) || '',
    at: Number.isFinite(options.at) ? Number(options.at) : Date.now(),
  };
  return _attachCascade(fact, r);
}

/**
 * 一致性断言（返回违规清单，不抛）。
 *
 * 刻意**不抛异常**：这是诊断设施，不是门禁。调用方可选择记日志、或在测试里断言空数组。
 * 在 produce 路径上抛错会让「诊断信息」变成「故障来源」，与设计初衷相反。
 *
 * @param {object} fact
 * @returns {string[]} 违规描述列表（空数组 = 自洽）
 */
function _assertCoherent(fact) {
  const problems = [];
  const f = fact && typeof fact === 'object' ? fact : {};
  const outcome = _str(f.outcome);

  if (!OUTCOMES.includes(outcome)) {
    problems.push(`outcome 非法: ${JSON.stringify(f.outcome)}`);
  }
  const hasServed = !!(f.served && _str(f.served.adapter));
  if (outcome === 'ok' && !hasServed) {
    problems.push('outcome=ok 但 served 为空（成功必有所服务的通道）');
  }
  if (outcome === 'failed' && hasServed) {
    problems.push('outcome=failed 但 served 非空（失败不该有成功通道）');
  }
  if (f.strictPinned === true && f.pinnedUnavailable === true && outcome !== 'failed') {
    problems.push('strictPinned+pinnedUnavailable 必为 failed（strict 抑制回退）');
  }
  problems.push(..._cascadeProblems(f, outcome));
  return problems;
}

/**
 * D3-1 披露字段挂载。`fact` 由 buildRouteFact 现场新建，可安全写入；`result` 只读。
 * 派生逻辑全部留在本处 —— buildRouteFact 内只做单行调用替换，不增长其 brace-span
 * （棘轮 HARD 指标：被改文件的最长块不得比 base 变长）。
 * fail-soft：任何异常降级为「空切换链 + environmental:false」。
 */
function _attachCascade(fact, result) {
  const f = fact && typeof fact === 'object' ? fact : {};
  try {
    const attempts = result && typeof result === 'object' ? result.attempts : null;
    const cascade = _deriveCascade(attempts);
    const sw = _deriveSwitch(cascade, _str(f.served && f.served.adapter));
    f.cascade = cascade;
    f.switchedFrom = sw.switchedFrom;
    f.switchReason = sw.switchReason;
    f.environmental = !!(attempts && probeEnvironmentOutage({ attempts }).environmental);
  } catch {
    f.cascade = [];
    f.switchedFrom = '';
    f.switchReason = '';
    f.environmental = false;
  }
  return f;
}

/**
 * 由 result.attempts 派生逐跳链（D3-1）。只读、绝不改 attempts。
 * 每条记录 → 一跳：virtualSkip → 'skip'；success → 'fallback'；其余 → 'failed'。
 * cause 标 'virtualSkip'（设计要求的留痕标注）；errorType 取归一化原值。
 * 整链只有「首跳即成功」一跳时，本轮无切换 → 空数组（与不变式
 * 「outcome=ok && cascade.length>0 → switchedFrom 非空」互洽）。
 */
function _deriveCascade(attempts) {
  try {
    const list = Array.isArray(attempts) ? attempts : [];
    const hops = [];
    for (const raw of list) {
      const hop = _hopOf(raw);
      if (hop) hops.push(hop);
    }
    if (hops.length === 1 && hops[0].decision === 'fallback') return [];
    return hops;
  } catch {
    return [];
  }
}

/** 单条尝试记录 → 一跳（对象构造独立成函数：把 for 循环内的嵌套压回 ≤3）。 */
function _hopOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const adapter = _str(
    raw.adapterKey != null ? raw.adapterKey : raw.provider != null ? raw.provider : raw.adapter
  );
  if (!adapter) return null;
  const isSkip = raw.virtualSkip === true;
  return {
    adapter,
    errorType: _str(raw.errorType),
    cause: isSkip ? 'virtualSkip' : '',
    decision: isSkip ? 'skip' : raw.success === true ? 'fallback' : 'failed',
  };
}

/** 首跳切换来源：cascade 里第一条与 served 不同的条目（无 served / 无切换 → 空）。 */
function _deriveSwitch(cascade, servedAdapter) {
  const empty = { switchedFrom: '', switchReason: '' };
  try {
    if (!servedAdapter || !Array.isArray(cascade)) return empty;
    const hop = cascade.find(function (h) {
      return !!_str(h && h.adapter) && _str(h && h.adapter) !== servedAdapter;
    });
    if (!hop) return empty;
    return { switchedFrom: _str(hop.adapter), switchReason: _str(hop.errorType) };
  } catch {
    return empty;
  }
}

/** D3-1 新增不变式的违规清单（绝不抛；从 _assertCoherent 单行接入）。 */
function _cascadeProblems(f, outcome) {
  try {
    const problems = [];
    const cascade = Array.isArray(f.cascade) ? f.cascade : [];
    if (f.environmental === true) problems.push(..._remoteFallbackProblems(cascade));
    if (outcome === 'ok' && cascade.length > 0 && !_str(f.switchedFrom)) {
      problems.push('outcome=ok 且 cascade 非空但 switchedFrom 为空（切换链必须可归因）');
    }
    return problems;
  } catch {
    return [];
  }
}

/**
 * 环境级成立时的远端落点检查（nesting 刻意压平：本仓棘轮 HARD 指标看最长块与嵌套，
 * 新增辅助函数不得把文件 maxNesting 抬过 base 的 3）。
 */
function _remoteFallbackProblems(cascade) {
  const local = new Set(DEFAULT_LOCAL_ADAPTER_KEYS.map((k) => _str(k).toLowerCase()));
  return cascade
    .filter((hop) => {
      const adapter = _str(hop && hop.adapter).toLowerCase();
      return !!adapter && !local.has(adapter) && _str(hop && hop.decision) === 'fallback';
    })
    .map(
      (hop) =>
        `environmental=true 但远端 ${_str(hop && hop.adapter)} 仍为 fallback 落点（环境级不得甩远端）`
    );
}

/** 切换原因（归一化 errorType）→ notice 行用中文标签。 */
const SWITCH_REASON_LABELS = Object.freeze({
  network: '网络异常',
  timeout: '超时',
  process: '进程异常',
  server_error: '服务端错误',
  unavailable: '通道不可用',
  model_not_found: '模型不可用',
  bad_request: '请求被拒',
  env_outage_skip: '网络不可达',
});

/**
 * 回合级切换 notice（[DESIGN-ARCH-181] D3-2 的文案单一真源）。
 *
 * 仅当「成功 + 真发生了切换」时返回非空行；其余（失败 / 未切换 / 畸形输入）返回 ''，
 * 调用方据此免渲染。纯字符串拼装，不读主题/env；displayName 由调用方注入
 * （TUI 的适配器显示名解析），缺省原样透传 key。渲染方**不得**把它注入回复正文，
 * 只能作为独立 notice 行追加（设计红线：避免污染复制/解析）。
 */
function formatCascadeNotice(fact, options = {}) {
  try {
    const f = fact && typeof fact === 'object' ? fact : {};
    const served = _str(f.served && f.served.adapter);
    const from = _str(f.switchedFrom);
    if (_str(f.outcome) !== 'ok' || !served || !from || from === served) return '';
    const o = options && typeof options === 'object' ? options : {};
    const name = typeof o.displayName === 'function' ? o.displayName : null;
    const reason = SWITCH_REASON_LABELS[_str(f.switchReason).toLowerCase()] || _str(f.switchReason) || '异常';
    return `⚑ 本次由 ${_safeLabel(name, served)} 完成（首选 ${_safeLabel(name, from)} 因${reason}，已自动兜底）。如需固定通道：khy provider use`;
  } catch {
    return '';
  }
}

/** displayName 解析的安全包装（解析器抛错或返回空 → 回落适配器 key 原文）。 */
function _safeLabel(name, v) {
  if (!name) return _str(v) || v;
  try {
    return _str(name(v)) || _str(v) || v;
  } catch {
    return _str(v) || v;
  }
}

/**
 * 面向 UI 的一行摘要（页脚/报错共用口径）。
 *
 * 三种形态：
 *   - 意图≠实际且失败   `windsurf ✗ → agnes-3.0-flash`  （本次事故的形态）
 *   - 意图≠实际且成功   `windsurf → api`                （曾回退过）
 *   - 意图=实际         `agnes-3.0-flash`               （无歧义，不加装饰）
 *
 * 纯字符串拼装，不读主题/不读 env，故可在任何渲染环境（Ink / 经典 REPL / 日志）复用。
 *
 * @param {object} fact
 * @returns {string}
 */
function formatRouteFactLabel(fact) {
  const f = fact && typeof fact === 'object' ? fact : {};
  const reqA = _str(f.requested?.adapter);
  const attA = _str(f.attempted?.adapter);
  const srvA = _str(f.served?.adapter);
  const actA = srvA || attA;
  const model = _str(f.resolved?.model) || _str(f.attempted?.model) || _str(f.requested?.model);
  const failed = _str(f.outcome) !== 'ok';

  if (!actA) {
    return model || _str(f.reason) || '(未路由)';
  }
  // 'auto' 是哨兵值不是通道名——绝不让它出现在面向用户的标签里。
  const intentA = isPinnedAdapter(reqA) ? reqA : '';
  const tail = model ? `${model} (${actA})` : actA;

  // 失败且无回退（意图=实际）：这是本次事故的形态，必须带失败标记，
  // 否则页脚会显示得像「正常服务在 agnes 上」，与报错再次矛盾。
  if (failed && (!intentA || intentA === actA)) {
    return `✗ ${tail}`;
  }
  if (!intentA || intentA === actA) {
    return tail;
  }
  return `${intentA} ${failed ? '✗ →' : '→'} ${tail}`;
}

module.exports = {
  createEmptyRouteFact,
  buildRouteFact,
  formatRouteFactLabel,
  formatCascadeNotice,
  isPinnedAdapter,
  isStrictPinned,
  OUTCOMES,
  SWITCH_REASON_LABELS,
  // 测试缝：纯函数一致性断言
  _assertCoherent,
};
