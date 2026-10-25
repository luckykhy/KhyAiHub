'use strict';

/**
 * 模型可用性判定 + 可靠性裁剪 + 展示文案的单一真源。
 *
 * 桌面端（Electron host）与终端（CLI / Ink TUI）此前各写一套：终端在
 * cli/handlers/gateway.js 里判 isAdapterOperational 并跑
 * _filterModelsByReliability，桌面端 apps/khyos-desktop/src/host/index.ts 的
 * listModelOptions 只按 id 去重、不判可用性——于是同一个模型在两边「可不可选」
 * 不一致（用户报的「桌面端模型列表和终端模型列表不统一」）。
 *
 * 本叶承载全部纯逻辑：无 IO（探活层按需 lazy require 且 fail-soft）、无 chalk、
 * 无交互、无 inquirer/readline。两边的 host 都能直 require 它。
 *
 * cli/handlers/gateway.js 改为从本叶 re-import 符号并经原有 DI 注入
 * gatewayModelChoices，终端画面字节不变；chalk 上色仍留在 cli 侧，本叶只出
 * 纯文本，桌面端用同一份纯文本，不另立第二套文案。
 */

// 宽度截断取自共享底座 utils/text/width（cli/formatters 里的同名符号就是从它再导出的，
// 同一份实现）。原写法 require('../../cli/formatters') 是 services → cli 的 R1 分层倒置，
// 还把 chalk 拖进了这个自称「无 chalk」的纯逻辑叶。
const { truncateToWidth } = require('../../utils/text/width');

// ── 环境常量（只在此声明一次）──────────────────────────────────────────────
const STRICT_OPERATIONAL_ADAPTERS = new Set(
  String(process.env.KHY_MODEL_STRICT_ADAPTERS || 'codex,claude,trae,cursor,relay_api')
    .split(',')
    .map((x) =>
      String(x || '')
        .trim()
        .toLowerCase()
    )
    .filter(Boolean)
);

const MODEL_HIDE_UNVERIFIED_ENABLED =
  String(process.env.KHY_MODEL_HIDE_UNVERIFIED || 'true').toLowerCase() !== 'false';
const MODEL_HIDE_FALLBACK_MODELS_ENABLED =
  String(process.env.KHY_MODEL_HIDE_FALLBACK_MODELS || 'false').toLowerCase() !== 'false';
const MODEL_HIDE_HINT_MODELS_ENABLED =
  String(process.env.KHY_MODEL_HIDE_HINT_MODELS || 'false').toLowerCase() !== 'false';
const MODEL_WARN_KEEP_MAX = Math.max(
  1,
  parseInt(process.env.KHY_MODEL_WARN_KEEP_MAX || '3', 10) || 3
);

// ── 探测原因分类（纯文本）─────────────────────────────────────────────────

function _compactReasonText(text, maxLen = 140) {
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) {
    return '';
  }
  // Width-aware truncation (CJK = 2 columns): result display width <= maxLen.
  return truncateToWidth(clean, maxLen);
}

function _isTimeoutLikeReason(reasonText = '') {
  return /timeout|timed out|stream stalled|reconnecting|channel closed|socket hang up|econnreset|broken pipe|fetch failed|network error/i.test(
    String(reasonText || '')
  );
}

function _isAuthOrInstallLikeReason(reasonText = '') {
  return /auth|api[_\s-]?key|apikeysource|token|not authenticated|unauthorized|forbidden|login|permission denied|no token|not set|unavailable|command .* not found|not found|enoent/i.test(
    String(reasonText || '')
  );
}

function _isTransientProbeLikeReason(reasonText = '') {
  return (
    _isTimeoutLikeReason(reasonText) ||
    /exited with code|without emitting stream-json output|launch blocked|failed to record rollout items|temporarily unavailable|service unavailable|try again later|overloaded|busy/i.test(
      String(reasonText || '')
    )
  );
}

function _extractProbeReasonText(test = {}) {
  return String(
    test?.generation?.error || test?.models?.error || test?.connectivity?.error || ''
  ).trim();
}

function _classifyHiddenReason(status, test, fallbackReason = '') {
  const preferred =
    _compactReasonText(fallbackReason) ||
    _compactReasonText(test?.generation?.error) ||
    _compactReasonText(test?.models?.error) ||
    _compactReasonText(test?.connectivity?.error) ||
    '';
  const text = preferred.toLowerCase();
  if (!text) {
    return '实测失败';
  }
  if (_isAuthOrInstallLikeReason(text)) {
    return `未登录/缺少凭证或未安装: ${preferred}`;
  }
  if (_isTimeoutLikeReason(text)) {
    return `探测超时: ${preferred}`;
  }
  if (text.includes('not detected')) {
    return '未检测到通道可用';
  }
  return preferred;
}

function _shouldRetryProbeByDebounce(status = {}, test = {}) {
  const reasonText = _extractProbeReasonText(test);
  if (!reasonText) {
    return false;
  }
  if (_isAuthOrInstallLikeReason(reasonText)) {
    return false;
  }
  return _isTransientProbeLikeReason(reasonText);
}

function shouldTreatGenerationFailureAsWarning(adapterType) {
  // CLI-bridge related adapters can be environment-dependent.
  // Keep them selectable with warning instead of hard-blocking.
  // Local inference adapters must pass generation probe; otherwise mark unavailable.
  return ['cli', 'claude', 'codex'].includes(String(adapterType || '').toLowerCase());
}

// ── 可用性门槛（终端与桌面共用同一判据）────────────────────────────────────

function isAdapterOperational(
  status,
  test,
  strictOperationalAdapters = STRICT_OPERATIONAL_ADAPTERS
) {
  if (!status || !status.enabled || !status.available) {
    return false;
  }
  if (!test?.connectivity?.success) {
    return false;
  }
  const adapterType = String(status.type || '').toLowerCase();
  const strictMode = strictOperationalAdapters.has(adapterType);
  if (strictMode && test?.models) {
    if (!test.models.success) {
      return false;
    }
    if (Number(test.models.count || 0) <= 0) {
      return false;
    }
  }
  if (test?.generation && !test.generation.success) {
    if (!shouldTreatGenerationFailureAsWarning(adapterType)) {
      return false;
    }
    if (strictMode) {
      const reasonText = String(test?.generation?.error || '');
      // For strict adapters, keep auth/install failures blocked.
      // Timeout/process-like probe failures are treated as warning to avoid false negatives.
      if (_isAuthOrInstallLikeReason(reasonText)) {
        return false;
      }
      if (!_isTransientProbeLikeReason(reasonText)) {
        return false;
      }
    }
  }
  return true;
}

// ── 可靠性裁剪（modelListTruth 存在性真值 + 跨供应商/未验证裁剪）─────────────

/**
 * 探活状态查询(供 modelListTruth 的实测律注入)。fail-soft:modelCuration 不可用 /
 * 抛异常 → 恒 'unknown'(即不剔除),绝不因探活层故障影响模型列表。
 */
function _modelVerifyStatusOf(adapterKey, modelId) {
  try {
    const curation = require('./modelCuration');
    if (curation && typeof curation.getVerifyStatus === 'function') {
      return curation.getVerifyStatus(adapterKey, modelId);
    }
  } catch {
    /* fail-soft: 无探活层 → 不剔除 */
  }
  return 'unknown';
}

/**
 * 把一条适配器的候选模型列表送过 modelListTruth(存在性真值收敛)。fail-soft:真值层缺失 /
 * 门控关 / 抛异常 → 原样返回入参(零剔除),绝不因真值层故障影响模型列表。
 * @returns {{models:Array, dropped:number, reasons:string[]}}
 */
function _applyModelListTruth(adapterStatus = {}, list = []) {
  const passthrough = { models: Array.isArray(list) ? list : [], dropped: 0, reasons: [] };
  try {
    const truth = require('./modelListTruth');
    if (!truth.isEnabled()) {
      return passthrough;
    }
    const adapterType = String(adapterStatus.type || '').toLowerCase();
    const verdict = truth.filterByUpstreamAuthority(passthrough.models, {
      adapterKey: adapterType,
      verifyStatusOf: _modelVerifyStatusOf,
    });
    if (!verdict || !Array.isArray(verdict.models)) {
      return passthrough;
    }
    return { models: verdict.models, dropped: Number(verdict.dropped) || 0, reasons: verdict.reasons || [] };
  } catch {
    return passthrough;
  }
}

function _modelFamilyKey(model = {}) {
  const base = String(model._baseModelId || '').trim();
  if (base) {
    return base;
  }
  const raw = String(model.id || model.name || '').trim();
  if (!raw) {
    return '';
  }
  return raw.includes('::') ? raw.split('::')[0] : raw;
}

function _isClaudeFamilyModel(model = {}) {
  const modelId = String(model.id || '')
    .trim()
    .toLowerCase();
  const modelName = String(model.name || '')
    .trim()
    .toLowerCase();
  return (
    modelId.startsWith('claude-') ||
    modelId.startsWith('claude_') ||
    modelName.startsWith('claude ')
  );
}

function _isPreferredAdapterModel(adapterType, modelId) {
  const preferredAdapter = String(process.env.GATEWAY_PREFERRED_ADAPTER || '')
    .trim()
    .toLowerCase();
  const preferredModel = String(process.env.GATEWAY_PREFERRED_MODEL || '').trim();
  if (!preferredAdapter || !preferredModel) {
    return false;
  }
  return (
    preferredAdapter ===
      String(adapterType || '')
        .trim()
        .toLowerCase() && String(modelId || '').trim() === preferredModel
  );
}

function _filterModelsByReliability(adapterStatus = {}, test = {}, models = []) {
  const sourceModels = Array.isArray(models) ? models.filter(Boolean) : [];
  // 真值律**先**跑,且不受下方「列表太短就跳过」的捷径豁免:单条垃圾模型不该因为列表只有
  // 一条就免检(那正是「列表里就一个不存在的模型」的成因)。形态律 + 实测律在此全覆盖。
  const truthVerdict = _applyModelListTruth(adapterStatus, sourceModels);
  let kept = truthVerdict.models.slice();
  let filtered = truthVerdict.dropped;
  const reasons = truthVerdict.reasons.slice();
  if (sourceModels.length <= 1) {
    return { models: kept, filtered, reasons };
  }
  const adapterType = String(adapterStatus.type || '').toLowerCase();
  const generationWarn = !!(
    test?.generation &&
    !test.generation.success &&
    shouldTreatGenerationFailureAsWarning(adapterType)
  );
  const hideFallbackForAdapter = adapterType === 'codex';
  const hideHintForAdapter = adapterType === 'codex';

  if (adapterType === 'codex') {
    const next = kept.filter((m) => !_isClaudeFamilyModel(m));
    const removed = kept.length - next.length;
    if (removed > 0) {
      filtered += removed;
      reasons.push('cross-provider-claude');
    }
    kept = next;
  }

  if (MODEL_HIDE_HINT_MODELS_ENABLED && hideHintForAdapter) {
    const next = kept.filter(
      (m) =>
        String(m.discoverySource || '')
          .trim()
          .toLowerCase() !== 'hint'
    );
    const removed = kept.length - next.length;
    if (removed > 0) {
      filtered += removed;
      reasons.push('hint');
    }
    kept = next;
  }

  if (MODEL_HIDE_FALLBACK_MODELS_ENABLED && hideFallbackForAdapter) {
    const next = kept.filter(
      (m) =>
        String(m.discoverySource || '')
          .trim()
          .toLowerCase() !== 'builtin'
    );
    const removed = kept.length - next.length;
    if (removed > 0) {
      filtered += removed;
      reasons.push('builtin');
    }
    kept = next;
  }

  // ── 存在性真值收敛(modelListTruth)────────────────────────────────────────
  // 已在函数开头(_applyModelListTruth)跑过一次,这里**必须再跑一次**:上面几步(codex 跨提供商
  // / hint / builtin 过滤)可能把最后一条 remote 记录剔掉,从而让「上游权威」消失 —— 此时原本
  // 被权威压制的猜测条目会重新获得豁免。重跑一次保证「裁剪后的集合」仍然自洽。
  {
    const again = _applyModelListTruth(adapterStatus, kept);
    if (again.dropped > 0) {
      filtered += again.dropped;
      for (const reason of again.reasons) {
        reasons.push(reason);
      }
    }
    kept = again.models;
  }

  if (MODEL_HIDE_UNVERIFIED_ENABLED && generationWarn && kept.length > MODEL_WARN_KEEP_MAX) {
    const strictKeep = kept.filter(
      (m) => !!m.isDefault || _isPreferredAdapterModel(adapterType, m.id)
    );
    const normalizedKeep = [];
    const seenIds = new Set();
    const seenFamilies = new Set();
    const pushOne = (m) => {
      if (!m || normalizedKeep.length >= MODEL_WARN_KEEP_MAX) {
        return;
      }
      const id = String(m.id || '');
      if (id && seenIds.has(id)) {
        return;
      }
      normalizedKeep.push(m);
      if (id) {
        seenIds.add(id);
      }
      const fam = _modelFamilyKey(m);
      if (fam) {
        seenFamilies.add(fam);
      }
    };
    for (const m of strictKeep) {
      pushOne(m);
    }
    for (const m of kept) {
      if (normalizedKeep.length >= MODEL_WARN_KEEP_MAX) {
        break;
      }
      const fam = _modelFamilyKey(m);
      if (fam && seenFamilies.has(fam)) {
        continue;
      }
      pushOne(m);
    }
    for (const m of kept) {
      if (normalizedKeep.length >= MODEL_WARN_KEEP_MAX) {
        break;
      }
      pushOne(m);
    }
    const removed = kept.length - normalizedKeep.length;
    if (removed > 0) {
      filtered += removed;
      reasons.push('warn-unverified');
    }
    kept = normalizedKeep;
  }

  if (kept.length === 0) {
    const fallback =
      sourceModels.find((m) => !!m.isDefault || _isPreferredAdapterModel(adapterType, m.id)) ||
      sourceModels[0];
    kept = fallback ? [fallback] : [];
  }
  return { models: kept, filtered, reasons };
}

// ── 展示文案（纯文本；chalk 上色留在 cli 侧）───────────────────────────────

/**
 * 剥掉模型名里夹带的供应商前缀。
 *
 * api 适配器把行名拼成 `${provider} / ${mid}`，于是供应商名夹在模型名中间
 * （[DESIGN-ARCH-167] 截图里「划分不清楚」的本体之一）。供应商升格为分组标题后，
 * 行内只该留模型本体。**只在确实以该前缀开头时剥**，剥不动就原样返回——
 * 宁可显示得啰嗦，也不静默改掉一个模型名。
 */
function stripProviderPrefix(nameText, provider) {
  const text = String(nameText || '');
  const p = String(provider || '').trim();
  if (!p) {
    return text;
  }
  const prefix = `${p} / `;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

// 视觉徽章门控 KHY_MODEL_VISION_BADGE(默认开;flagRegistry 优先,注册表不可用 → 本地 CANON 回退)。
const _VISION_BADGE_FALSY = new Set(['0', 'false', 'off', 'no']);
function _visionBadgeEnabled(env) {
  const e = env || process.env || {};
  try {
    const reg = require('../flagRegistry');
    if (
      reg &&
      typeof reg.isRegistryEnabled === 'function' &&
      reg.isRegistryEnabled(e) &&
      typeof reg.isFlagEnabled === 'function'
    ) {
      return reg.isFlagEnabled('KHY_MODEL_VISION_BADGE', e);
    }
  } catch {
    /* 注册表不可用 → 本地回退 */
  }
  const v = e && e.KHY_MODEL_VISION_BADGE;
  return !(
    v !== undefined &&
    v !== null &&
    _VISION_BADGE_FALSY.has(String(v).trim().toLowerCase())
  );
}

/**
 * 「视觉」徽章的**纯文本**判定。终端与桌面共用同一判据（复用单一真源
 * visionCapability.isVisionCapableModel），只是终端再上 magenta。
 * 门控关 / 判不出 / 异常 → false（逐字节回退：不含徽章）。绝不抛。
 */
function isVisionModel(model = {}, env = process.env) {
  try {
    if (!_visionBadgeEnabled(env)) {
      return false;
    }
    const id = String((model && (model.id || model.model || model.name)) || '').trim();
    let isVision =
      String((model && model.modality) || '')
        .trim()
        .toLowerCase() === 'vision';
    if (!isVision && id) {
      const vc = require('./visionCapability');
      if (vc && typeof vc.isVisionCapableModel === 'function') {
        isVision = vc.isVisionCapableModel(id, { env });
      }
    }
    return !!isVision;
  } catch {
    return false;
  }
}

/** 「[远端发现]」「[未证实·远端发现]」等来源徽章的纯文本。 */
function plainSourceTag(model = {}) {
  const raw = String(model.discoverySource || model.source || '')
    .trim()
    .toLowerCase();
  if (!raw) {
    return '';
  }
  const map = {
    remote: '远端发现',
    local: '本地发现',
    'remote+local': '远端+本地',
    builtin: '内置',
    config: '配置项',
  };
  const label = map[raw] || raw;
  // 「未证实」标注(modelListTruth 的 unverified 标记):该通道无上游证据,这条只是本地猜测
  // (静态目录 / 本机扫描 / env 逗号串)。把「猜测」与「事实」在选择器里一眼分开。
  if (model.unverified === true) {
    return `[未证实·${label}]`;
  }
  return `[${label}]`;
}

/** 「直连」「中转桥接」「代理中转」「本地推理」「自动」的纯文本。 */
function plainConnectionTag(model = {}) {
  const mode = String(model.connectionMode || '')
    .trim()
    .toLowerCase();
  if (!mode) {
    return '';
  }
  const map = {
    direct: '直连',
    bridge: '中转桥接',
    proxy: '代理中转',
    local: '本地推理',
    auto: '自动',
  };
  return map[mode] || mode;
}

/** 「[上游:provider @ host]」的纯文本。 */
function plainUpstreamTag(model = {}) {
  const provider = String(model.upstreamProvider || '').trim();
  const host = String(model.upstreamHost || '').trim();
  if (!provider && !host) {
    return '';
  }
  const payload = host ? `${provider || 'unknown'} @ ${host}` : provider;
  return `[上游:${payload}]`;
}

/**
 * 一条模型行的**纯文本**展示三件套，终端与桌面共用同一份派生。
 *
 * @returns {{primary:string, secondary:string, group:string}}
 */
function composeModelDisplay({ model, adapterName, adapterType }) {
  const m = model || {};
  const provider = String(m.upstreamProvider || '').trim();
  const group = provider || adapterName || adapterType || '';
  const parts = [
    isVisionModel(m) ? '视觉' : '',
    plainSourceTag(m),
    plainUpstreamTag(m),
    plainConnectionTag(m),
    m.isDefault ? '✓ 当前' : '',
  ].filter(Boolean);
  return {
    primary: stripProviderPrefix(m.name || m.id || '', provider),
    secondary: parts.join(' '),
    group,
  };
}

/** 过滤原因码 → 人话（终端与桌面的诊断脚注共用）。 */
const FILTER_REASON_LABELS = {
  hint: '提示源模型',
  builtin: '内置回退模型',
  'warn-unverified': '告警通道的未验证模型',
  'cross-provider-claude': '跨提供商 Claude 模型',
  unconfirmed: '无上游证据的猜测模型（静态目录/本机扫描）',
  malformed: '形态非法的模型 ID',
  'verify-failed': '实测探活失败的模型',
};

module.exports = {
  STRICT_OPERATIONAL_ADAPTERS,
  MODEL_HIDE_UNVERIFIED_ENABLED,
  MODEL_HIDE_FALLBACK_MODELS_ENABLED,
  MODEL_HIDE_HINT_MODELS_ENABLED,
  MODEL_WARN_KEEP_MAX,
  FILTER_REASON_LABELS,

  shouldTreatGenerationFailureAsWarning,
  isAdapterOperational,
  _filterModelsByReliability,
  _applyModelListTruth,
  _modelVerifyStatusOf,

  _compactReasonText,
  _isTimeoutLikeReason,
  _isAuthOrInstallLikeReason,
  _isTransientProbeLikeReason,
  _extractProbeReasonText,
  _classifyHiddenReason,
  _shouldRetryProbeByDebounce,
  _modelFamilyKey,
  _isClaudeFamilyModel,
  _isPreferredAdapterModel,

  stripProviderPrefix,
  isVisionModel,
  plainSourceTag,
  plainConnectionTag,
  plainUpstreamTag,
  composeModelDisplay,
};
