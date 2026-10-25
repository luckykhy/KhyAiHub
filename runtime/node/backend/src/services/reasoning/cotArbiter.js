'use strict';

// cotArbiter.js — L1 of [DESIGN-ARCH-191]: closed-loop reasoning-budget arbiter
// (pure leaf · zero IO · deterministic · fail-soft · env-gated).
//
// Companion to autoReasoning.js. autoReasoning decides the effort tier ONCE, from
// user-message keywords (toolUseLoopCore.js:2472-2474, whose comment states
// "follow-ups keep same tier"). This leaf closes the loop: it observes what each
// round ACTUALLY cost and re-decides the tier for the next round.
//
// The house pattern is tokenBudget.js (see its header): this leaf decides, the
// thin shell accumulates at the round boundary and applies the verdict before the
// next chat(). Every function is total and fail-soft — the worst case degrades to
// "hold the current tier", never to a spurious change.
//
// Gate: KHY_COT_L1. unset / 0 / false / off / no  ⇒  disabled  ⇒  the shell skips
// the whole block and effectiveChatOpts stays byte-identical to pre-L1 behavior.
//
// L1 adjusts BUDGET ONLY. It never touches thinking content: signed thinking blocks
// are immutable (tampering returns 400), and content rewriting is L3 with its own
// guardrails. Keeping the two apart means each is independently revertible.

const OFF_VALUES = ['0', 'false', 'off', 'no', ''];

// Tier ladder — mirrors the `_order` table already inlined at
// toolUseLoopCore.js:2483. Ascending = more thinking budget.
const TIERS = ['low', 'high', 'max'];
const _ORDER = { low: 0, high: 1, max: 2 };

const DEFAULTS = {
  floor: null, // null ⇒ never below the harness's own thinkingFloor
  ceiling: 'max',
  maxAdjust: 4, // adjustments allowed per turn — anti-oscillation bound
  stagnationRounds: 2, // tool calls must stall this many rounds to count
};

// Single source of truth for the char→token estimate. Guarded: this leaf must not
// be able to break the loop by failing to load a helper (same pattern as
// contentBlockUtils.js:5-10). The module exports the function itself, plus a
// `fromCharCount` property — hence the typeof check rather than destructuring.
let _estimateTokens;
try {
  const _m = require('../../utils/simpleTokenEstimate');
  _estimateTokens = typeof _m === 'function' ? _m : null;
} catch {
  _estimateTokens = null;
}
function _tokensOf(text) {
  const s = typeof text === 'string' ? text : '';
  if (!s) {
    return 0;
  }
  if (typeof _estimateTokens === 'function') {
    try {
      const n = Number(_estimateTokens(s));
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      /* fall through to local estimate */
    }
  }
  return Math.ceil(s.length / 4);
}

function _nonNeg(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function _tierIndex(tier) {
  return _ORDER[tier];
}

/**
 * Normalize a tier name to its ladder slot. Unknown ⇒ the default middle rung.
 * NOTE: this deliberately does NOT apply the floor/ceiling band. The band bounds
 * L1's own adjustments; it must never silently rewrite the tier auto-reasoning
 * already decided. On a hold the base tier is returned untouched.
 */
function _normTier(tier) {
  const i = _tierIndex(tier);
  const idx = i == null ? _ORDER.high : i;
  return { idx, tier: TIERS[idx] };
}

/** Clamp a ladder index into the configured band. */
function _clampIdx(idx, floor, ceiling) {
  const loI = _tierIndex(floor) == null ? 0 : _tierIndex(floor);
  const hiI = _tierIndex(ceiling) == null ? _ORDER.max : _tierIndex(ceiling);
  if (loI > hiI) {
    return { idx: hiI, clamped: 'inverted' };
  }
  const clamped = idx < loI ? 'floor' : idx > hiI ? 'ceiling' : null;
  return { idx: clamped ? (idx < loI ? loI : hiI) : idx, clamped };
}

/**
 * Resolve the L1 gate + tuning knobs from the environment.
 * @param {object} [env] process.env-shaped
 * @returns {{enabled:boolean, floor:string|null, ceiling:string, maxAdjust:number, stagnationRounds:number}}
 *   enabled false ⇒ the shell must skip L1 entirely (byte-fallback).
 */
function resolveGate(env) {
  const e = env || {};
  const raw = e.KHY_COT_L1;
  const v = String(raw == null ? '' : raw)
    .trim()
    .toLowerCase();
  const enabled = !OFF_VALUES.includes(v);

  const floorRaw = String(e.KHY_COT_L1_FLOOR == null ? '' : e.KHY_COT_L1_FLOOR)
    .trim()
    .toLowerCase();
  const floor = TIERS.includes(floorRaw) ? floorRaw : DEFAULTS.floor;

  const ceilRaw = String(e.KHY_COT_L1_CEILING == null ? '' : e.KHY_COT_L1_CEILING)
    .trim()
    .toLowerCase();
  const ceiling = TIERS.includes(ceilRaw) ? ceilRaw : DEFAULTS.ceiling;

  let maxAdjust = Math.floor(_nonNeg(e.KHY_COT_L1_MAX_ADJUST) || DEFAULTS.maxAdjust);
  if (!(maxAdjust > 0)) {
    maxAdjust = DEFAULTS.maxAdjust;
  }

  let stagn = Math.floor(_nonNeg(e.KHY_COT_L1_STAGNATION_ROUNDS) || DEFAULTS.stagnationRounds);
  if (!(stagn > 0)) {
    stagn = DEFAULTS.stagnationRounds;
  }

  return { enabled, floor, ceiling, maxAdjust, stagnationRounds: stagn };
}

/**
 * Extract this round's reasoning signal. Pure extraction — makes NO decision.
 * Every field degrades to a safe zero/null on malformed input.
 * @param {object} [input]
 * @returns {{thinkingTokens:number, toolCount:number, stopReason:string|null, derailed:boolean}}
 */
function observeRound(input) {
  const i = input && typeof input === 'object' ? input : {};
  let text = typeof i.thinking === 'string' ? i.thinking : '';
  if (!text && Array.isArray(i.thinkingBlocks)) {
    // Native thinking models may only populate the structured channel
    // (toolUseLoopCore.js:5170-5172) — never merged into `reply`.
    text = i.thinkingBlocks
      .map((b) => (b && typeof b.thinking === 'string' ? b.thinking : ''))
      .join('');
  }
  return {
    thinkingTokens: _tokensOf(text),
    toolCount: Math.floor(_nonNeg(i.toolCount)),
    stopReason: typeof i.stopReason === 'string' ? i.stopReason : null,
    // L2 fills this in after judgeTruncation() runs at the continuation site;
    // it rides along on the signal so nextTier() can honor it on the next round.
    derailed: i.derailed === true,
  };
}

/**
 * Has the model been thinking hard without making progress? Same toolCount across
 * the window AND no drop in thinking volume — i.e. it re-thinks without acting.
 *
 * This is the D4 shape: most CoT tokens are produced AFTER the answer is already
 * committed (DESIGN-ARCH-191 §10.1), so trimming those rounds costs nothing.
 */
function _isStagnant(history, rounds) {
  if (!Array.isArray(history) || history.length < rounds || rounds < 2) {
    return false;
  }
  const win = history.slice(-rounds);
  const toolCount = Math.floor(_nonNeg(win[0] && win[0].toolCount));
  for (let k = 1; k < win.length; k++) {
    const prev = win[k - 1];
    const cur = win[k];
    if (Math.floor(_nonNeg(cur && cur.toolCount)) !== toolCount) {
      return false;
    }
    if (_nonNeg(cur && cur.thinkingTokens) < _nonNeg(prev && prev.thinkingTokens)) {
      return false; // thinking is shrinking — that IS progress
    }
  }
  return true;
}

/**
 * Decide the tier for the next round from the rounds observed so far.
 * Pure function; never throws; always returns a usable tier.
 * @param {object} [arg]
 * @param {string} [arg.baseTier] tier decided by autoReasoning for this turn
 * @param {Array} [arg.history] observed rounds, oldest first
 * @param {object} [arg.cfg] resolveGate() output
 * @param {number} [arg.adjustUsed] adjustments already applied this turn
 * @returns {{tier:string, action:'up'|'down'|'hold', reason:string, clamped:string|null}}
 */
function nextTier(arg) {
  const a = arg && typeof arg === 'object' ? arg : {};
  const cfg = a.cfg && typeof a.cfg === 'object' ? a.cfg : resolveGate({});
  const history = Array.isArray(a.history) ? a.history.filter((h) => h && typeof h === 'object') : [];

  const base = _normTier(a.baseTier);

  if (cfg.enabled === false) {
    return { tier: base.tier, action: 'hold', reason: 'gate-off', clamped: null };
  }
  if (history.length === 0) {
    return { tier: base.tier, action: 'hold', reason: 'no-history', clamped: null };
  }
  // Anti-oscillation: bound how many times a single turn may change tier.
  const used = Math.floor(_nonNeg(a.adjustUsed));
  if (used >= cfg.maxAdjust) {
    return { tier: base.tier, action: 'hold', reason: 'adjust-budget-exhausted', clamped: null };
  }

  const last = history[history.length - 1];
  let step = 0;
  let reason = 'steady';

  if (last.derailed === true) {
    // [DESIGN-ARCH-191] L2 judged the truncated thinking as off-track rather than
    // merely unfinished. This OUTRANKS the truncation rule below on purpose: a
    // derailed trace that ran out of room must be given LESS budget, not more —
    // stepping up would spend more tokens on the same wrong path.
    step = -1;
    reason = 'derailed-by-L2';
  } else if (last.stopReason === 'length') {
    // Thinking hit max_tokens ⇒ it ran out of room, not of need. Step up.
    step = 1;
    reason = 'truncated-thinking';
  } else if (_isStagnant(history, cfg.stagnationRounds)) {
    // Re-thinking without acting ⇒ spend is not buying progress. Step down.
    step = -1;
    reason = 'stagnant';
  }

  if (step === 0) {
    return { tier: base.tier, action: 'hold', reason, clamped: null };
  }

  const moved = _clampIdx(base.idx + step, cfg.floor, cfg.ceiling);
  // A band that pushes against the step direction means there is nowhere to go.
  if (moved.idx === base.idx || (step > 0 && moved.idx < base.idx) || (step < 0 && moved.idx > base.idx)) {
    return { tier: base.tier, action: 'hold', reason: `${reason}-at-bound`, clamped: moved.clamped };
  }
  return { tier: TIERS[moved.idx], action: step > 0 ? 'up' : 'down', reason, clamped: moved.clamped };
}

/**
 * L3 capability probe — what a provider actually permits on its thinking channel.
 * Explicit table, never try/catch-probed: a silently-dropped rewrite on one vendor
 * and an effective one on another is undebuggable (DESIGN-ARCH-191 §3.2).
 * @param {string} [provider]
 * @returns {{signed:boolean, canRewrite:boolean, canResume:boolean, canSteer:boolean}}
 */
function resolveCapabilities(provider) {
  const p = String(provider == null ? '' : provider)
    .trim()
    .toLowerCase();
  if (p.includes('anthropic') || p.includes('claude')) {
    // thinking/redacted_thinking blocks carry a signature verified server-side;
    // content edits are rejected. An unclosed block after max_tokens may still be
    // resumed verbatim — that is L2's whole legal surface here.
    return { signed: true, canRewrite: false, canResume: true, canSteer: false };
  }
  if (p.includes('local') || p.includes('vllm')) {
    return { signed: false, canRewrite: true, canResume: true, canSteer: true };
  }
  if (p.includes('deepseek') || p.includes('zhipu') || p.includes('glm')) {
    return { signed: false, canRewrite: true, canResume: true, canSteer: false };
  }
  if (p.includes('openai') || p.includes('responses')) {
    return { signed: false, canRewrite: true, canResume: true, canSteer: false };
  }
  // Unknown vendor: assume the conservative Anthropic-shaped contract rather than
  // risk emitting a rewrite the vendor silently drops.
  return { signed: true, canRewrite: false, canResume: true, canSteer: false };
}

// ── L2 — judged truncation (DESIGN-ARCH-191 §5) ─────────────────────────────
//
// The existing length-truncation auto-continue (toolUseLoopCore.js:5203-5232)
// is BLIND: it fires on stop_reason==='length' and always re-prompts with the same
// fixed sentence, up to _LENGTH_AUTO_CONTINUE_MAX times. But running out of tokens
// has two very different causes, and the right response differs:
//
//   "unfinished" — the trace was mid-thought when the ceiling hit. Continue.
//   "derailed"   — the trace had already abandoned the thread (self-contradiction,
//                 retraction, "this approach won't work"). Continuing spends MORE
//                 budget on the same wrong path; the correct move is to step DOWN
//                 and re-plan, which is what L1's down-tier channel does.
//
// The judgment is deterministic and pattern-based: no extra model call, no IO.
// Its tail window is deliberately narrow — it only looks at the END of the trace,
// because that is where the evidence for "ran out of room" vs "gave up" lives.

const _TAIL_WINDOW = 400;

// Retraction / self-contradiction — decisive, checked FIRST. Matched against the
// tail only, so an earlier honest "wait, let me re-check" mid-trace does not
// mislabel a trace that recovered and kept going.
//
// Two deliberate exclusions: bare `no` is far too common ("there is no other
// option") to be evidence of derailment, and 实际上 is NOT the same word as 其实
// — homophones, different characters — so the pivot needs its own alternative.
const _DERAIL_RE = [
  /\b(?:wait|hold on|actually|scratch that|never ?mind)\b/i,
  /\b(?:that'?s wrong|that'?s not right|no,|nope)\b/i,
  /\b(?:let me reconsider|let me rethink|re-?think (?:this|that)|start over|abandon|give up on)\b/i,
  /\b(?:this (?:approach|method|way|idea) (?:won'?t|doesn'?t|will not|is wrong|fails?)|dead end|rabbit hole)\b/i,
  /(?:等等|不对|不是|其实|实际上|让我重新|重新想想|换个思路|这条路走不通|走不通|行不通|推倒重来|放弃)/,
];
// Dangling openers — the sentence was cut mid-structure ⇒ clearly unfinished.
const _UNFINISHED_TAIL_RE = /(?:[,，、;；:：\-—/([{]|(?:\band|\bor|\bbut|\bso|\bthen|\byet)\s*)$/i;
const _UNCLOSED_FENCE_RE = /```/g;

function _thinkingText(input) {
  const i = input && typeof input === 'object' ? input : {};
  let text = typeof i.thinking === 'string' ? i.thinking : '';
  if (!text && typeof i.reply === 'string') {
    // Text-protocol local models may inline <think>…</think> into reply instead of
    // using a separate channel (see toolUseLoopCore.js:5246-5248). Take the tail of
    // the payload either way — the judge only ever reads the END.
    text = i.reply;
  }
  if (!text && Array.isArray(i.thinkingBlocks)) {
    text = i.thinkingBlocks.map((b) => (b && b.thinking) || '').join('');
  }
  return text;
}

/**
 * L2 gate. Disabled by default; byte-fallback to the existing blind continue.
 * @param {object} [env]
 * @returns {{enabled:boolean, tailWindow:number}}
 */
function resolveGateL2(env) {
  const e = env || {};
  const raw = e.KHY_COT_L2;
  const v = String(raw == null ? '' : raw)
    .trim()
    .toLowerCase();
  let win = Math.floor(_nonNeg(e.KHY_COT_L2_TAIL_WINDOW) || _TAIL_WINDOW);
  if (!(win > 0)) {
    win = _TAIL_WINDOW;
  }
  return { enabled: !OFF_VALUES.includes(v), tailWindow: win };
}

/**
 * Judge a truncated thinking trace: was it cut off mid-thought (continue), or had
 * it already gone off the rails (step down and re-plan)?
 *
 * Returns 'unknown' when there is no usable text — the caller then behaves exactly
 * as it does today, which is the honest default.
 *
 * @param {object} [input] {thinking|reply|thinkingBlocks}
 * @param {object} [cfg] resolveGateL2() output
 * @returns {{verdict:'unfinished'|'derailed'|'unknown', reason:string, tail:string}}
 */
function judgeTruncation(input, cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : resolveGateL2({ KHY_COT_L2: '1' });
  if (c.enabled === false) {
    return { verdict: 'unknown', reason: 'gate-off', tail: '' };
  }
  const full = _thinkingText(input);
  if (typeof full !== 'string' || full.trim() === '') {
    return { verdict: 'unknown', reason: 'no-thinking-text', tail: '' };
  }
  const tail = full.slice(-Math.max(32, c.tailWindow));

  // Retraction markers outrank everything: they are evidence about INTENT, while
  // the unfinished markers below only describe the shape of the last sentence.
  for (const re of _DERAIL_RE) {
    if (re.test(tail)) {
      return { verdict: 'derailed', reason: 'retraction-marker', tail };
    }
  }
  // An unterminated code fence means the model was mid-emission — the strongest
  // possible evidence that it simply ran out of room.
  const fences = tail.match(_UNCLOSED_FENCE_RE);
  if (fences && fences.length % 2 === 1) {
    return { verdict: 'unfinished', reason: 'unclosed-code-fence', tail };
  }
  if (_UNFINISHED_TAIL_RE.test(tail.replace(/\s+$/, ''))) {
    return { verdict: 'unfinished', reason: 'dangling-clause', tail };
  }
  // Ended on a complete sentence but hit the ceiling: still unfinished work, but
  // we cannot prove it was mid-clause. Treat as unfinished — continuing is the
  // status-quo behavior and the safer of the two defaults.
  return { verdict: 'unfinished', reason: 'sentence-boundary', tail };
}

// ── L3 — whitelist-guarded continuation shaping (DESIGN-ARCH-191 §6) ─────────
//
// HARD GUARDRAIL: the caller may only ever select a key from this frozen table.
// There is deliberately no path for caller-supplied text — the whole risk of CoT
// injection (DESIGN-ARCH-191 §10.1: the model almost never notices its reasoning
// was edited) is precisely that an unconstrained string would silently steer it.
//
// Carrier note — this is an architectural constraint, not a simplification:
// unsigned thinking (reasoning_content) is NOT echoed back to the provider today.
// contentBlockUtils.buildAssistantContent only forwards thinking blocks that carry
// a signature, so anything unsigned is dropped on the way out. The ONE channel the
// loop genuinely controls and sends is the continuation message, so that is where
// L3 shapes. Making echo-back itself editable is a separate, larger change and is
// deliberately out of scope here.

const NUDGE_WHITELIST = Object.freeze({
  narrow: 'Re-state the single next concrete step before continuing.',
  verify: 'Before continuing, verify the claim you just made against the evidence you already gathered.',
  replan: 'The current approach is not working. Stop extending it and pick a different one.',
  finish: 'Do not explore further options. Commit to the best option you already have and finish.',
});

/**
 * L3 gate. Disabled by default.
 * @param {object} [env]
 * @returns {{enabled:boolean, nudge:string|null}}
 *   nudge is always a key of NUDGE_WHITELIST or null — never raw text.
 */
function resolveGateL3(env) {
  const e = env || {};
  const raw = e.KHY_COT_L3;
  const v = String(raw == null ? '' : raw)
    .trim()
    .toLowerCase();
  const enabled = !OFF_VALUES.includes(v);
  const key = String(e.KHY_COT_L3_NUDGE == null ? '' : e.KHY_COT_L3_NUDGE)
    .trim()
    .toLowerCase();
  return { enabled, nudge: enabled && Object.prototype.hasOwnProperty.call(NUDGE_WHITELIST, key) ? key : null };
}

/**
 * Build the continuation message for a truncated round.
 *
 * Returns the caller's `base` message UNCHANGED when L2/L3 are off, when the
 * provider cannot accept injected reasoning, or when nothing qualifies — so the
 * existing blind-continue behavior is preserved byte-for-byte in every default path.
 *
 * @param {object} [arg]
 * @param {string} [arg.base] the existing continuation text
 * @param {string} [arg.provider]
 * @param {object} [arg.verdict] judgeTruncation() output
 * @param {object} [arg.cfgL3] resolveGateL3() output
 * @param {string} [arg.defaultNudge] whitelist key to use when none is configured
 * @returns {{message:string, nudge:string|null, applied:boolean}}
 */
function buildContinuation(arg) {
  const a = arg && typeof arg === 'object' ? arg : {};
  const base = typeof a.base === 'string' ? a.base : '';
  const caps = resolveCapabilities(a.provider);
  const v = a.verdict && typeof a.verdict === 'object' ? a.verdict : { verdict: 'unknown' };

  // Signed providers reject edited thinking outright (400). Their only legal CoT
  // lever is L2's budget step-down — never a content rewrite.
  if (!caps.canRewrite) {
    return { message: base, nudge: null, applied: false };
  }

  const cfgL3 = a.cfgL3 && typeof a.cfgL3 === 'object' ? a.cfgL3 : resolveGateL3({});
  if (cfgL3.enabled !== true) {
    return { message: base, nudge: null, applied: false };
  }

  let key = cfgL3.nudge;
  if (!key) {
    // No key configured: pick by verdict, still strictly from the frozen table.
    key = v.verdict === 'derailed' ? 'replan' : typeof a.defaultNudge === 'string' ? a.defaultNudge : 'finish';
  }
  if (!Object.prototype.hasOwnProperty.call(NUDGE_WHITELIST, key)) {
    return { message: base, nudge: null, applied: false };
  }

  const text = NUDGE_WHITELIST[key];
  const message = base ? `${base}\n\n[Reasoning guidance] ${text}` : `[Reasoning guidance] ${text}`;
  return { message, nudge: key, applied: true };
}

module.exports = {
  TIERS,
  resolveGate,
  observeRound,
  nextTier,
  resolveCapabilities,
  resolveGateL2,
  judgeTruncation,
  resolveGateL3,
  NUDGE_WHITELIST,
  buildContinuation,
};
