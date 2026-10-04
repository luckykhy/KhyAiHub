'use strict';

/**
 * inertia/planSchema.js — 惯性单 schema v0 校验 + bash 授权裁决（纯函数）。
 *
 * [DESIGN-ARCH-160] §3.2/§3.8：fail-closed——
 *   - 校验失败拒绝启动（四查①②在此完成：schema 合法 + 授权白名单非空）；
 *   - 未声明字段取默认（defaults.js 冻结值）；
 *   - 预算各上界只允许 ≤ 默认（放宽必拒 budget_widening_forbidden）；
 *   - decay 方向校验：惩罚 ≥ 默认 / progressRestore ≤ 默认 / stopBelow ≥ 默认
 *     ——全部只许「更容易停」方向（decay_relaxation_forbidden）；
 *   - 未知字段拒绝（防 typo 静默失效，fail-closed 一致）。
 *
 * 叶子纪律：零 IO、绝不抛、不读 env、不改入参。
 */

const {
  DEFAULTS,
  HARD_DENY_BASH,
  SCHEMA_VER,
  SUPPORTED_COMPLETION_KINDS,
  SUPPORTED_CONTROL_POLICIES,
  SUPPORTED_AMBIGUITY_POLICIES,
} = require('./defaults');

// ── 小工具（不抛） ──────────────────────────────────────────────────────

function _isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function _isStrArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim().length > 0);
}

/**
 * 通配匹配：`*` → 任意字符序列（含空串）；大小写不敏感；整串锚定。
 * 纯字符串运算，不涉及正则注入面（pattern 先逐段转义再拼接）。
 */
function wildcardMatch(pattern, value) {
  if (typeof pattern !== 'string' || typeof value !== 'string') {
    return false;
  }
  if (pattern.indexOf('*') === -1) {
    return pattern.trim().toLowerCase() === value.trim().toLowerCase();
  }
  let re;
  try {
    re = new RegExp(
      '^' +
        pattern
          .split('*')
          .map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('[\\s\\S]*') +
        '$',
      'i'
    );
  } catch {
    return false;
  }
  return re.test(value.trim());
}

/** 返回第一个命中的 pattern；无命中返回 null。 */
function matchAny(value, patterns) {
  const list = Array.isArray(patterns) ? patterns : [];
  for (const p of list) {
    if (wildcardMatch(p, value)) {
      return p;
    }
  }
  return null;
}

// ── bash 授权裁决（§3.8.1/§3.8.2） ─────────────────────────────────────

/** §3.8.2 硬拒清单命中 → 返回命中的 pattern；否则 null。 */
function isHardDenied(command) {
  return matchAny(String(command || ''), HARD_DENY_BASH);
}

/**
 * bashPolicy 裁决：deny 先于 allow（§3.8.2 明文顺序）；
 * 两者都未命中 → deny（fail-closed：未在 allow 白名单即拒，未声明≠全权）。
 */
function evaluateBashPolicy(command, bashPolicy) {
  const cmd = String(command || '');
  const bp = _isPlainObject(bashPolicy) ? bashPolicy : DEFAULTS.authorization.bashPolicy;
  const denyHit = matchAny(cmd, bp.deny);
  if (denyHit) {
    return { decision: 'deny', matchedBy: denyHit };
  }
  const allowHit = matchAny(cmd, bp.allow);
  if (allowHit) {
    return { decision: 'allow', matchedBy: allowHit };
  }
  return { decision: 'deny', matchedBy: null };
}

/**
 * 合成裁决（惯性单语境）：硬拒清单 > bashPolicy（deny 先于 allow）。
 * decision ∈ 'hard_deny' | 'deny' | 'allow'，matchedBy 为命中 pattern 或 null。
 */
function evaluateCommandAuthorization(command, plan) {
  const hard = isHardDenied(command);
  if (hard) {
    return { decision: 'hard_deny', matchedBy: hard };
  }
  const bp = plan && plan.authorization ? plan.authorization.bashPolicy : null;
  return evaluateBashPolicy(command, bp);
}

// ── schema 校验（§3.2） ────────────────────────────────────────────────

const KNOWN_TOP_FIELDS = [
  'schemaVer',
  'runId',
  'kickedBy',
  'goal',
  'completion',
  'authorization',
  'budget',
  'decay',
  'ambiguity',
  'model',
  'leaseMs',
];
const KNOWN_BUDGET_FIELDS = ['maxTurns', 'maxCostCny', 'maxWallMs', 'maxIdleMs', 'maxDenies'];
const KNOWN_DECAY_FIELDS = [
  'noProgressPenalty',
  'repeatPenalty',
  'denyPenalty',
  'errorPenalty',
  'progressRestore',
  'stopBelow',
];
const RUN_ID_RE = /^ir-\d{8}-[a-z0-9]{2,16}$/;

/**
 * 校验惯性单。返回
 *   { ok: true,  errors: [], plan: normalized }
 *   { ok: false, errors: [{field, reason}], plan: null }
 * 绝不抛；任何分支都返回形状一致的结果（fail-closed 语义的一部分）。
 */
function validatePlan(plan) {
  const errors = [];
  if (!_isPlainObject(plan)) {
    return { ok: false, errors: [{ field: '$', reason: 'not_an_object' }], plan: null };
  }

  for (const k of Object.keys(plan)) {
    if (!KNOWN_TOP_FIELDS.includes(k)) {
      errors.push({ field: k, reason: 'unknown_field' });
    }
  }

  if (plan.schemaVer !== SCHEMA_VER) {
    errors.push({ field: 'schemaVer', reason: 'must_be_' + SCHEMA_VER });
  }

  if (plan.runId !== undefined) {
    if (typeof plan.runId !== 'string' || !RUN_ID_RE.test(plan.runId)) {
      errors.push({ field: 'runId', reason: 'bad_format' });
    }
  }

  if (plan.kickedBy !== undefined && !_isPlainObject(plan.kickedBy)) {
    errors.push({ field: 'kickedBy', reason: 'must_be_object' });
  }

  if (typeof plan.goal !== 'string' || !plan.goal.trim()) {
    errors.push({ field: 'goal', reason: 'required' });
  } else if (plan.goal.length > 2000) {
    errors.push({ field: 'goal', reason: 'too_long_max_2000' });
  }

  // completion（§3.2/§3.4；S1 仅 command_green）
  if (!_isPlainObject(plan.completion)) {
    errors.push({ field: 'completion', reason: 'required_object' });
  } else {
    if (!SUPPORTED_COMPLETION_KINDS.includes(plan.completion.kind)) {
      errors.push({ field: 'completion.kind', reason: 'unsupported_kind' });
    }
    if (typeof plan.completion.command !== 'string' || !plan.completion.command.trim()) {
      errors.push({ field: 'completion.command', reason: 'required' });
    }
    if (
      plan.completion.expectExit !== undefined &&
      !Number.isInteger(plan.completion.expectExit)
    ) {
      errors.push({ field: 'completion.expectExit', reason: 'must_be_integer' });
    }
  }

  // authorization —— 白名单必填非空（§3.3 四查②，fail-closed，无默认全权）
  if (!_isPlainObject(plan.authorization)) {
    errors.push({ field: 'authorization', reason: 'required_object' });
  } else {
    const auth = plan.authorization;
    if (!_isStrArray(auth.tools) || auth.tools.length === 0) {
      errors.push({ field: 'authorization.tools', reason: 'non_empty_whitelist_required' });
    }
    if (auth.bashPolicy !== undefined) {
      if (!_isPlainObject(auth.bashPolicy)) {
        errors.push({ field: 'authorization.bashPolicy', reason: 'must_be_object' });
      } else {
        for (const side of ['allow', 'deny']) {
          const v = auth.bashPolicy[side];
          if (v !== undefined && !_isStrArray(v)) {
            errors.push({ field: 'authorization.bashPolicy.' + side, reason: 'must_be_string_array' });
          }
        }
      }
    }
    if (auth.paths !== undefined && !_isStrArray(auth.paths)) {
      errors.push({ field: 'authorization.paths', reason: 'must_be_string_array' });
    }
    if (
      auth.onControlRequest !== undefined &&
      !SUPPORTED_CONTROL_POLICIES.includes(auth.onControlRequest)
    ) {
      errors.push({ field: 'authorization.onControlRequest', reason: 'unsupported_policy' });
    }
  }

  // budget：只允许收紧（§3.8.4）
  if (plan.budget !== undefined) {
    if (!_isPlainObject(plan.budget)) {
      errors.push({ field: 'budget', reason: 'must_be_object' });
    } else {
      for (const k of Object.keys(plan.budget)) {
        if (!KNOWN_BUDGET_FIELDS.includes(k)) {
          errors.push({ field: 'budget.' + k, reason: 'unknown_field' });
          continue;
        }
        const v = plan.budget[k];
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
          errors.push({ field: 'budget.' + k, reason: 'must_be_positive_number' });
          continue;
        }
        if (v > DEFAULTS.budget[k]) {
          errors.push({ field: 'budget.' + k, reason: 'budget_widening_forbidden' });
        }
      }
    }
  }

  // decay：方向校验（只许「更容易停」）
  if (plan.decay !== undefined) {
    if (!_isPlainObject(plan.decay)) {
      errors.push({ field: 'decay', reason: 'must_be_object' });
    } else {
      for (const k of Object.keys(plan.decay)) {
        if (!KNOWN_DECAY_FIELDS.includes(k)) {
          errors.push({ field: 'decay.' + k, reason: 'unknown_field' });
          continue;
        }
        const v = plan.decay[k];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
          errors.push({ field: 'decay.' + k, reason: 'must_be_number_in_0_1' });
          continue;
        }
        const d = DEFAULTS.decay[k];
        if (k === 'progressRestore') {
          if (v > d) {
            errors.push({ field: 'decay.' + k, reason: 'decay_relaxation_forbidden' });
          }
        } else if (v < d) {
          errors.push({ field: 'decay.' + k, reason: 'decay_relaxation_forbidden' });
        }
      }
    }
  }

  if (plan.ambiguity !== undefined) {
    if (
      !_isPlainObject(plan.ambiguity) ||
      !SUPPORTED_AMBIGUITY_POLICIES.includes(plan.ambiguity.policy)
    ) {
      errors.push({ field: 'ambiguity.policy', reason: 'unsupported_policy' });
    }
  }

  if (plan.model !== undefined) {
    if (
      !_isPlainObject(plan.model) ||
      (plan.model.preferredAdapter !== undefined &&
        typeof plan.model.preferredAdapter !== 'string')
    ) {
      errors.push({ field: 'model', reason: 'must_be_object_with_string_preferredAdapter' });
    }
  }

  if (
    plan.leaseMs !== undefined &&
    (typeof plan.leaseMs !== 'number' || !Number.isFinite(plan.leaseMs) || plan.leaseMs <= 0)
  ) {
    errors.push({ field: 'leaseMs', reason: 'must_be_positive_number' });
  }

  if (errors.length > 0) {
    return { ok: false, errors, plan: null };
  }
  return { ok: true, errors: [], plan: _normalize(plan) };
}

/** 缺省字段补默认（仅在校验通过后调用）。返回新对象，不改入参。 */
function _normalize(plan) {
  const bp = _isPlainObject(plan.authorization.bashPolicy) ? plan.authorization.bashPolicy : {};
  return {
    schemaVer: SCHEMA_VER,
    runId: plan.runId, // 缺省由 inertialRunService 生成
    kickedBy: _isPlainObject(plan.kickedBy) ? { ...plan.kickedBy } : { surface: 'cli', sessionId: '', machineId: '' },
    goal: plan.goal,
    completion: {
      kind: 'command_green',
      command: plan.completion.command.trim(),
      expectExit: plan.completion.expectExit === undefined ? 0 : plan.completion.expectExit,
    },
    authorization: {
      tools: plan.authorization.tools.slice(),
      bashPolicy: {
        allow: Array.isArray(bp.allow) ? bp.allow.slice() : [],
        deny: Array.isArray(bp.deny) ? bp.deny.slice() : [],
      },
      paths: _isStrArray(plan.authorization.paths) ? plan.authorization.paths.slice() : DEFAULTS.authorization.paths.slice(),
      onControlRequest: plan.authorization.onControlRequest || DEFAULTS.authorization.onControlRequest,
    },
    budget: { ...DEFAULTS.budget, ...(plan.budget || {}) },
    decay: { ...DEFAULTS.decay, ...(plan.decay || {}) },
    ambiguity: { policy: 'stop' },
    model: { preferredAdapter: (plan.model && plan.model.preferredAdapter) || 'auto' },
    leaseMs: plan.leaseMs === undefined ? DEFAULTS.leaseMs : plan.leaseMs,
  };
}

module.exports = {
  validatePlan,
  evaluateBashPolicy,
  evaluateCommandAuthorization,
  isHardDenied,
  wildcardMatch,
  matchAny,
  RUN_ID_RE,
};
