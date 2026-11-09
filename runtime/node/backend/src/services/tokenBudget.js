'use strict';

// tokenBudget.js — hard token-budget governor (pure leaf · zero IO · deterministic
// · fail-soft · env-gated). The "系统层 D2" enforcement layer the agent loop was
// missing: token accounting already flowed (per-round onCost(aiResult.tokenUsage)),
// and advancedDiagnostics could *observe* a budget overrun, but NOTHING ever aborted
// the loop on spend. The loop condition gated on iteration count only, so a session
// could burn unbounded tokens — the production risk "无界 token 预算是生产事故的头号
// 原因 / 超预算强制停止而非无限重试".
//
// This leaf decides; the thin shell (toolUseLoop) accumulates spend at the existing
// onCost emit point and, at the top of each round (before the next chat()), stops
// cleanly when assessBudget returns 'stop' — synthesizing a final reply from work
// already done, with NO extra model round.
//
// Gate: KHY_TOKEN_BUDGET is the ceiling itself and doubles as the on/off switch.
//   unset / 0 / non-finite / negative  ⇒  ceiling 0  ⇒  assessBudget always 'ok'
//   ⇒  the loop never stops on tokens  ⇒  byte-identical legacy behavior.
// KHY_TOKEN_BUDGET_WARN_RATIO (default 0.8, clamped 0..1) sets the 'warn' band.
//
// Amount (CNY) dimension — sibling gate KHY_TOKEN_BUDGET_COST_CNY, same dialect
// (the ceiling IS the switch: unset/0/off ⇒ disabled). Its default comes from
// constants/serviceDefaults.js and is 0 — the amount gate starts OFF because the
// threshold must be set from real S1-recorded spend, not guessed (PROCESS-008 S1
// observer; [RESEARCH-028] P1-1 金额预算门). Pricing is NOT this leaf's job
// (zero-IO leaf): the shell prices each round through tokenUsageService and
// injects the cumulative CNY total into assessCostBudget.
//
// 防呆: every function is total and fail-soft. Bad input never throws; the worst
// case degrades to "disabled" (ceiling 0 → never stops), never to a spurious stop.

const OFF_VALUES = ['0', 'false', 'off', 'no', ''];

const DEFAULT_WARN_RATIO = 0.8;

// Amount (CNY) gate env name — sibling of KHY_TOKEN_BUDGET (KHY_* house dialect).
const COST_CEILING_ENV = 'KHY_TOKEN_BUDGET_COST_CNY';

// Non-finite / negative → 0. Counters and ceilings are never negative.
function _nonNeg(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    return 0;
  }
  return n;
}

// Default CNY ceiling truth source (RUNTIME-001: the threshold is not a literal
// here). Lazy require keeps this leaf load-side-effect-free; the default is only
// consulted when the env does not carry the gate explicitly.
function _defaultCostCeilingCNY() {
  const d = require('../constants/serviceDefaults').TOKEN_BUDGET_DEFAULT_COST_CEILING_CNY;
  const n = Number(d);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Amount ceiling, same dialect as the token gate: explicit off-tokens (incl. '')
// / 0 / negative / non-finite ⇒ 0 = disabled. Unset ⇒ the serviceDefaults truth
// source (itself 0 unless an operator sets one ⇒ the gate starts OFF).
function _resolveCostCeilingCNY(env) {
  const raw = env[COST_CEILING_ENV];
  if (raw === undefined || raw === null) {
    return _defaultCostCeilingCNY();
  }
  const v = String(raw)
    .trim()
    .toLowerCase();
  if (OFF_VALUES.includes(v)) {
    return 0;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Resolve the token ceiling + warn ratio from the environment.
 * @param {object} [env] process.env-shaped object
 * @returns {{ ceiling:number, warnRatio:number, costCeilingCNY:number }}
 *   ceiling 0 ⇒ disabled (no enforcement, byte-fallback);
 *   costCeilingCNY 0 ⇒ the amount dimension is disabled as well.
 */
function resolveBudget(env) {
  const e = env || {};
  const raw = e.KHY_TOKEN_BUDGET;
  const v = String(raw == null ? '' : raw)
    .trim()
    .toLowerCase();
  // Explicit off-tokens (and unset) ⇒ disabled. Floor to an integer ceiling.
  const ceiling = OFF_VALUES.includes(v) ? 0 : Math.floor(_nonNeg(raw));

  let warnRatio = Number(e.KHY_TOKEN_BUDGET_WARN_RATIO);
  if (!Number.isFinite(warnRatio)) {
    warnRatio = DEFAULT_WARN_RATIO;
  }
  if (warnRatio < 0) {
    warnRatio = 0;
  }
  if (warnRatio > 1) {
    warnRatio = 1;
  }

  return { ceiling, warnRatio, costCeilingCNY: _resolveCostCeilingCNY(e) };
}

/**
 * Extract this round's total token count from a provider tokenUsage object.
 * Summing per-round totals is the correct *spend* notion: each call re-pays for
 * its (growing) input context, which is exactly what a cost ceiling should bound.
 * Tries total → prompt+completion (OpenAI-style) → input+output (Anthropic-style).
 * @param {object} tokenUsage
 * @returns {number} >=0; non-object / unparsable → 0.
 */
function extractTokenCount(tokenUsage) {
  if (!tokenUsage || typeof tokenUsage !== 'object') {
    return 0;
  }
  const t = tokenUsage;
  if (t.total_tokens != null) {
    return _nonNeg(t.total_tokens);
  }
  if (t.totalTokens != null) {
    return _nonNeg(t.totalTokens);
  }
  const prompt = _nonNeg(t.prompt_tokens != null ? t.prompt_tokens : t.input_tokens);
  const completion = _nonNeg(t.completion_tokens != null ? t.completion_tokens : t.output_tokens);
  return prompt + completion;
}

/**
 * Split this round's tokenUsage into the billable input/output buckets pricing
 * needs apart (input and output carry different unit prices). Probing order
 * mirrors loop/usage.js's _accumUsage. A round that reports ONLY a total cannot
 * be attributed between buckets — it prices at 0 rather than at a fabricated
 * split (the token dimension still counts it in full).
 * @param {object} tokenUsage
 * @returns {{ input:number, output:number }} both >=0; non-object → {0,0}.
 */
function extractInputOutputTokens(tokenUsage) {
  if (!tokenUsage || typeof tokenUsage !== 'object') {
    return { input: 0, output: 0 };
  }
  const t = tokenUsage;
  const input = _nonNeg(
    t.prompt_tokens != null
      ? t.prompt_tokens
      : t.promptTokens != null
        ? t.promptTokens
        : t.input_tokens != null
          ? t.input_tokens
          : t.inputTokens
  );
  const output = _nonNeg(
    t.completion_tokens != null
      ? t.completion_tokens
      : t.completionTokens != null
        ? t.completionTokens
        : t.output_tokens != null
          ? t.output_tokens
          : t.outputTokens
  );
  return { input, output };
}

// Shared ok/warn/stop ladder for one scalar dimension (tokens or CNY). Kept
// private so the two public assessors cannot drift into different state machines.
function _assessScalar(spentRaw, ceilingRaw, warnRatio) {
  const spent = _nonNeg(spentRaw);
  const ceiling = _nonNeg(ceilingRaw);
  if (ceiling <= 0) {
    return { state: 'ok', spent, ceiling: 0, remaining: Infinity, ratio: 0 };
  }
  let warn = Number(warnRatio);
  if (!Number.isFinite(warn)) {
    warn = DEFAULT_WARN_RATIO;
  }
  if (warn < 0) {
    warn = 0;
  }
  if (warn > 1) {
    warn = 1;
  }

  const ratio = spent / ceiling;
  const remaining = Math.max(0, ceiling - spent);
  let state = 'ok';
  if (spent >= ceiling) {
    state = 'stop';
  } else if (spent >= ceiling * warn) {
    state = 'warn';
  }
  return { state, spent, ceiling, remaining, ratio };
}

/**
 * Decide the budget state for the cumulative spend so far.
 * @param {{ spent:number, ceiling:number, warnRatio?:number }} arg
 * @returns {{ state:'ok'|'warn'|'stop', spent:number, ceiling:number, remaining:number, ratio:number }}
 *   ceiling <= 0 ⇒ always 'ok' (disabled / byte-fallback).
 */
function assessBudget({ spent, ceiling, warnRatio } = {}) {
  const r = _assessScalar(spent, ceiling, warnRatio);
  return { state: r.state, spent: r.spent, ceiling: r.ceiling, remaining: r.remaining, ratio: r.ratio };
}

/**
 * Decide the amount-budget state for the cumulative CNY spend so far. Same
 * ladder as assessBudget; ceilingCNY <= 0 ⇒ always 'ok' (amount gate disabled).
 * The shell feeds the CNY total priced through tokenUsageService; when that
 * service is unreachable the shell never accumulates, so spentCNY stays 0 and
 * this verdict stays 'ok' — the automatic degrade to the token-only dimension.
 * @param {{ spentCNY:number, ceilingCNY:number, warnRatio?:number }} arg
 * @returns {{ state:'ok'|'warn'|'stop', spentCNY:number, ceilingCNY:number, remainingCNY:number, ratio:number }}
 */
function assessCostBudget({ spentCNY, ceilingCNY, warnRatio } = {}) {
  const r = _assessScalar(spentCNY, ceilingCNY, warnRatio);
  return {
    state: r.state,
    spentCNY: r.spent,
    ceilingCNY: r.ceiling,
    remainingCNY: r.remaining,
    ratio: r.ratio,
  };
}

// ── In-prompt per-turn budget directive (CC utils/tokenBudget.ts) ───────────
// CC lets the user set a per-turn token TARGET inline in their own prompt:
//   "+500k" (start shorthand), "do this +1.5m." (end shorthand),
//   "use 2M tokens" / "spend 500k tokens" (verbose, matches anywhere).
// This is the missing half of khy's budget story: the governor above is live but
// its ceiling came SOLELY from KHY_TOKEN_BUDGET env — this adds CC's "type it in
// the prompt" path. The loop shell wires it to set THIS turn's ceiling (transient,
// user-explicit, never persisted), layered over the env default.
//
// Faithful port of CC's three recognizers, checked in the same order
// (start-shorthand → end-shorthand → verbose), same MULTIPLIERS. The shorthand
// forms require a literal '+' anchored to start/end so natural language like
// "500k rows" or "the +2 case" never matches; verbose requires the trailing
// "token(s)" word. Regexes copied verbatim from CC (the end form deliberately
// captures a leading \s rather than using a lookbehind, per CC's JSC/YARR note).
const _SHORTHAND_START_RE = /^\s*\+(\d+(?:\.\d+)?)\s*(k|m|b)\b/i;
const _SHORTHAND_END_RE = /\s\+(\d+(?:\.\d+)?)\s*(k|m|b)\s*[.!?]?\s*$/i;
const _VERBOSE_RE = /\b(?:use|spend)\s+(\d+(?:\.\d+)?)\s*(k|m|b)\s*tokens?\b/i;
const _BUDGET_MULTIPLIERS = { k: 1000, m: 1000000, b: 1000000000 };

function _parseBudgetMatch(value, suffix) {
  const mult = _BUDGET_MULTIPLIERS[String(suffix).toLowerCase()];
  const n = parseFloat(value);
  if (!Number.isFinite(n) || !mult) {
    return null;
  }
  return n * mult;
}

/**
 * Parse a per-turn token budget directive out of the user's prompt text.
 * @param {string} text raw user prompt
 * @returns {number|null} the token target, or null when no directive is present
 *   (bare "500k" without '+', "+500" without suffix, plain text, non-string → null).
 */
function parseTokenBudget(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return null;
  }
  const start = text.match(_SHORTHAND_START_RE);
  if (start) {
    return _parseBudgetMatch(start[1], start[2]);
  }
  const end = text.match(_SHORTHAND_END_RE);
  if (end) {
    return _parseBudgetMatch(end[1], end[2]);
  }
  const verbose = text.match(_VERBOSE_RE);
  if (verbose) {
    return _parseBudgetMatch(verbose[1], verbose[2]);
  }
  return null;
}

/**
 * Gate for the in-prompt budget directive. Default ON (unset → enabled). Note this
 * uses its OWN off-set WITHOUT '' — unlike KHY_TOKEN_BUDGET (where '' means the env
 * ceiling is disabled), an unset KHY_PROMPT_TOKEN_BUDGET means the parser is on.
 * @param {object} [env]
 * @returns {boolean}
 */
function promptTokenBudgetEnabled(env) {
  const raw = env && env.KHY_PROMPT_TOKEN_BUDGET;
  const v = String(raw == null ? '' : raw)
    .trim()
    .toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

/**
 * Resolve the per-turn ceiling contributed by an in-prompt directive.
 * Gate off / no directive / non-positive → null (loop keeps the env ceiling,
 * byte-identical). fail-soft: never throws.
 * @param {string} text raw user prompt
 * @param {object} [env]
 * @returns {number|null} floored positive ceiling, or null.
 */
function resolvePromptBudget(text, env) {
  if (!promptTokenBudgetEnabled(env)) {
    return null;
  }
  const n = parseTokenBudget(text);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  return Math.floor(n);
}

/**
 * Honest closure lines appended when the loop hard-stops on budget. Returns ''
 * when the governor is disabled (ceiling <= 0) so a disabled run never gains a
 * notice. Each dimension speaks only when ITS OWN cumulative spend reached ITS
 * OWN ceiling — a cost-side stop with the token gate still under its ceiling
 * must NOT claim the tokens ran out (and vice versa). When the amount gate is
 * on but pricing was unavailable, the degrade is stated instead of faked.
 * @param {{ spent:number, ceiling:number, costSpentCNY?:number,
 *           costCeilingCNY?:number, costPricingAvailable?:boolean, env?:object }} arg
 * @returns {string}
 */
function buildBudgetStopNotice({
  spent,
  ceiling,
  costSpentCNY,
  costCeilingCNY,
  costPricingAvailable,
  env,
} = {}) {
  const cfg = resolveBudget(env || (typeof process !== 'undefined' ? process.env : {}));
  const lines = [];
  // Token dimension: meaningful only under an active env ceiling AND when the
  // token spend really reached it. If the env says disabled, stay silent
  // regardless of the passed numbers (defensive against a stray call) — same
  // contract as before the amount dimension existed.
  if (cfg.ceiling > 0) {
    const _spent = Math.floor(_nonNeg(spent));
    const _ceiling = Math.floor(_nonNeg(ceiling));
    if (_ceiling > 0 && _spent >= _ceiling) {
      lines.push(
        `⚠ Token 预算已达上限（${_spent}/${_ceiling} tokens），已停止本轮以防无界消耗。` +
          `如需继续，请调高 KHY_TOKEN_BUDGET 或拆分任务。`
      );
    }
  }
  // Amount dimension.
  if (cfg.costCeilingCNY > 0) {
    const _cCeiling = _nonNeg(costCeilingCNY);
    const _cSpent = _nonNeg(costSpentCNY);
    if (_cCeiling > 0 && _cSpent >= _cCeiling) {
      lines.push(
        `⚠ 金额预算已达上限（累计约 ¥${_cSpent.toFixed(2)} / 上限 ¥${_cCeiling.toFixed(2)}），` +
          `已停止本轮以防无界消耗。如需继续，请调高 KHY_TOKEN_BUDGET_COST_CNY 或拆分任务。`
      );
    } else if (costPricingAvailable === false) {
      lines.push('金额维度未生效：tokenUsageService 计价不可达，本轮仅按 token 维度收口。');
    }
  }
  return lines.join('\n');
}

module.exports = {
  resolveBudget,
  extractTokenCount,
  extractInputOutputTokens,
  assessBudget,
  assessCostBudget,
  buildBudgetStopNotice,
  parseTokenBudget,
  promptTokenBudgetEnabled,
  resolvePromptBudget,
};
