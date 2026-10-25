'use strict';

/**
 * gelabActionGrammar.js — parse what the GUI-agent model actually emits.
 *
 * WHY this module exists as a pure leaf. The model is the least reliable
 * component in the loop: it wraps its answer in whatever tags it feels like,
 * drops fields, emits coordinates as "500,500" or "500 500", fences its output
 * in markdown, and occasionally answers twice. Everything downstream — the
 * translator, the actuator, the runner — is written against a validated dict,
 * so all of that tolerance has to be absorbed here, once, and be unit-testable
 * without a model or a phone.
 *
 * WHY the grammar is deliberately NOT the upstream one. Upstream gelab-zero
 * ships several parser generations and its shipped config pairs the 4B model
 * with the OLD one (a nine-action variant reached through a confusingly named
 * alias). This module implements the superset — eleven actions — and is
 * tolerant of both prompt shapes, so switching prompt generations is an env
 * change rather than a code change. Actions the old model never emits (BACK,
 * CALL_USER) simply never appear; nothing breaks.
 *
 * Contract: pure, deterministic, never throws. Every failure is a coded object,
 * never an exception — a parse failure is a normal turn of the agent loop and
 * must be reportable to the model as feedback, not crash the runner.
 */

/** The full action space. Order is the order shown to the model. */
const GELAB_ACTIONS = Object.freeze([
  'CLICK',
  'LONGPRESS',
  'SLIDE',
  'TYPE',
  'AWAKE',
  'BACK',
  'HOME',
  'WAIT',
  'INFO',
  'CALL_USER',
  'COMPLETE',
  'ABORT',
]);

/**
 * Required fields per action.
 *
 * PINNED TO THE SHIPPED GRAMMAR, not to the newest one. Upstream's own
 * mcp_server_config.yaml sets task_type to "parser_0922_summary", which
 * parser_factory.py maps to copilot_tools/parser_0920_summary — the NINE-action
 * generation. That alias is a trap: the name says 0922, the class is 0920. So
 * the required-field table below follows 0920's own documentation, and the
 * eleven-action superset is kept only so a future prompt-generation switch does
 * not need a code change.
 *
 * Two 0920 rules that differ from the newer generation and are honoured here:
 *   - ABORT's reason lives in `value`, not `explain`. Both are accepted,
 *     because both are honest and the model emits either.
 *   - TYPE requires `value` and a `point`. `point` is deliberately NOT enforced
 *     by this table — see gelabActionMap, which prefers a live dump's EditText
 *     centre over the model's normalized guess. That is strictly better
 *     geometry, so the field is optional rather than mandatory.
 *
 * COMPLETE reports through `return`, NOT `value`.
 */
const REQUIRED_FIELDS = Object.freeze({
  CLICK: Object.freeze(['point']),
  LONGPRESS: Object.freeze(['point']),
  SLIDE: Object.freeze(['point1', 'point2']),
  TYPE: Object.freeze(['value']),
  AWAKE: Object.freeze(['value']),
  INFO: Object.freeze(['value']),
  WAIT: Object.freeze(['value']),
  COMPLETE: Object.freeze(['return']),
  CALL_USER: Object.freeze(['value', 'tag']),
  BACK: Object.freeze([]),
  HOME: Object.freeze([]),
  ABORT: Object.freeze([]),
});

/**
 * Fields where at least one must be present, for actions whose reason field
 * moved between generations.
 */
const ANY_OF_FIELDS = Object.freeze({
  ABORT: Object.freeze(['value', 'explain']),
});

/**
 * Required on every action regardless of kind.
 *
 * `explain` is what a human reads in the plan and the step log, so an action
 * without it is not executable-in-good-conscience. `cot` is deliberately NOT
 * here: a model that emits no think block is tolerated and gets an empty cot,
 * which is a documented tolerance rather than a failure.
 */
const COMMON_REQUIRED = Object.freeze(['explain']);

/** Fields that carry free text and may span several lines. */
const TEXT_FIELDS = Object.freeze([
  'explain', 'note', 'verify', 'key_process', 'summary', 'return', 'tag',
]);

/** Known scalar/point fields, used to reject unknown keys silently. */
const KNOWN_FIELDS = Object.freeze([
  'action', 'explain', 'cot', 'note', 'verify', 'key_process', 'summary',
  'point', 'point1', 'point2', 'value', 'return', 'tag',
]);

const ACTION_SET = new Set(GELAB_ACTIONS);

// ── public API ──────────────────────────────────────────────────────────────

/**
 * Parse one model turn into a validated action dict.
 *
 * @param {string} rawText
 * @returns {{ok:true, action:object} | {ok:false, code:string, error:string, tail:string}}
 */
function str2action(rawText) {
  if (typeof rawText !== 'string' || rawText.trim().length === 0) {
    return { ok: false, code: 'empty', error: '模型输出为空', tail: '' };
  }

  // Fences first: the model loves ``` wrappers and they carry no meaning here.
  let text = stripFences(rawText).replace(/\r\n?/g, '\n');

  const cot = extractLastThink(text);

  // Everything after the LAST `action:` marker is the field section. Taking the
  // last one matters: a model that answers twice (or quotes its own previous
  // answer) would otherwise have its first, stale answer parsed.
  const marker = lastFieldMarker(text, 'action');
  if (!marker) {
    return {
      ok: false,
      code: 'no_action',
      error: '输出里找不到 action: 字段',
      tail: tail(text),
    };
  }

  const section = text.slice(marker.keyStart);
  const fields = parseFields(section);
  const actionName = (fields.action || '').trim().toUpperCase();

  if (!actionName) {
    return { ok: false, code: 'no_action', error: 'action: 字段为空', tail: tail(text) };
  }
  if (!ACTION_SET.has(actionName)) {
    return {
      ok: false,
      code: 'unknown_action',
      error: `未知动作 ${actionName}，可选：${GELAB_ACTIONS.join('/')}`,
      tail: tail(text),
    };
  }

  const action = {
    action: actionName,
    explain: (fields.explain || '').trim(),
    cot,
  };
  for (const key of ['note', 'verify', 'key_process', 'summary', 'value', 'return', 'tag']) {
    if (typeof fields[key] === 'string' && fields[key].trim().length > 0) {
      action[key] = fields[key].trim();
    }
  }
  for (const key of ['point', 'point1', 'point2']) {
    if (typeof fields[key] === 'string' && fields[key].trim().length > 0) {
      const parsed = parsePoint(fields[key]);
      if (!parsed.ok) {
        return {
          ok: false,
          code: 'bad_point',
          error: `${key} 不是合法坐标：${JSON.stringify(fields[key].trim())}（要 "x,y" 或 "x y"）`,
          tail: tail(text),
        };
      }
      action[key] = parsed.point;
    }
  }

  const required = COMMON_REQUIRED
    .concat(REQUIRED_FIELDS[actionName] || [])
    .filter((f) => action[f] === undefined || action[f] === null
      || (typeof action[f] === 'string' && action[f].trim().length === 0));
  if (required.length > 0) {
    return {
      ok: false,
      code: 'missing_field',
      error: `${actionName} 缺少必填字段：${required.join(', ')}`,
      tail: tail(text),
    };
  }
  const anyOf = ANY_OF_FIELDS[actionName];
  if (anyOf && !anyOf.some((f) => typeof action[f] === 'string' && action[f].trim().length > 0)) {
    return {
      ok: false,
      code: 'missing_field',
      error: `${actionName} 需要 ${anyOf.join(' 或 ')} 之一`,
      tail: tail(text),
    };
  }

  return { ok: true, action };
}

/**
 * Render an action dict back to text.
 *
 * WHY this exists. Training-data round-tripping and the debug log both need the
 * inverse direction. Upstream's version compares with `type(value) == int`,
 * which is Python 2 and is always false — so every number was rendered as a
 * float. `typeof` is used here instead.
 */
function action2str(dict) {
  if (!dict || typeof dict !== 'object' || typeof dict.action !== 'string') {
    return '';
  }
  const lines = [];
  for (const key of KNOWN_FIELDS) {
    const v = dict[key];
    if (v === undefined || v === null) {
      continue;
    }
    if (Array.isArray(v)) {
      lines.push(`${key}: ${v.map((n) => (typeof n === 'number' ? n : Number(n) || 0)).join(',')}`);
      continue;
    }
    if (typeof v === 'number') {
      // Integers stay integers; only genuinely fractional values get a point.
      lines.push(`${key}: ${Number.isInteger(v) ? v : v}`);
      continue;
    }
    lines.push(`${key}: ${v}`);
  }
  return lines.join('\n');
}

/** Validate an already-parsed dict without re-parsing text. */
function validateAction(dict) {
  if (!dict || typeof dict !== 'object') {
    return { ok: false, code: 'missing_field', error: '动作不是对象' };
  }
  const name = String(dict.action || '').toUpperCase();
  if (!ACTION_SET.has(name)) {
    return { ok: false, code: 'unknown_action', error: `未知动作 ${name}` };
  }
  const missing = COMMON_REQUIRED
    .concat(REQUIRED_FIELDS[name] || [])
    .filter((f) => dict[f] === undefined || dict[f] === null
      || (typeof dict[f] === 'string' && dict[f].trim().length === 0));
  if (missing.length > 0) {
    return { ok: false, code: 'missing_field', error: `${name} 缺少必填字段：${missing.join(', ')}` };
  }
  const anyOf = ANY_OF_FIELDS[name];
  if (anyOf && !anyOf.some((f) => typeof dict[f] === 'string' && dict[f].trim().length > 0)) {
    return { ok: false, code: 'missing_field', error: `${name} 需要 ${anyOf.join(' 或 ')} 之一` };
  }
  for (const key of ['point', 'point1', 'point2']) {
    if (dict[key] !== undefined) {
      if (!Array.isArray(dict[key]) || dict[key].length !== 2
          || !dict[key].every((n) => typeof n === 'number' && Number.isFinite(n))) {
        return { ok: false, code: 'bad_point', error: `${key} 不是 [x, y] 数字对` };
      }
    }
  }
  return { ok: true };
}

/**
 * One Chinese line describing the action, for the plan and the step log.
 *
 * Coordinates are printed in the model's own 0-1000 space, not pixels: that is
 * the space the human and the model share, and it survives a screen rotation.
 */
function describeAction(dict) {
  if (!dict || typeof dict !== 'object' || typeof dict.action !== 'string') {
    return '（无法描述的动作）';
  }
  const a = dict.action.toUpperCase();
  const fmt = (p) => (Array.isArray(p) ? `(${p[0]},${p[1]})` : '?');
  switch (a) {
    case 'CLICK':
      return `点击 ${fmt(dict.point)}`;
    case 'LONGPRESS':
      return `长按 ${fmt(dict.point)}`;
    case 'SLIDE':
      return `从 ${fmt(dict.point1)} 滑到 ${fmt(dict.point2)}`;
    case 'TYPE':
      return `输入「${truncate(dict.value, 30)}」`;
    case 'AWAKE':
      return `打开应用「${truncate(dict.value, 30)}」`;
    case 'BACK':
      return '返回';
    case 'HOME':
      return '回到桌面';
    case 'WAIT':
      return `等待 ${dict.value}`;
    case 'INFO':
      return `询问：${truncate(dict.value, 60)}`;
    case 'CALL_USER':
      return `需要人介入（${truncate(dict.tag, 20)}）：${truncate(dict.value, 60)}`;
    case 'COMPLETE':
      return `完成：${truncate(dict.return, 80)}`;
    case 'ABORT':
      return `放弃：${truncate(dict.explain, 80)}`;
    default:
      return a;
  }
}

// ── internals ───────────────────────────────────────────────────────────────

/** Remove ``` fences and their language tag, keeping the content. */
function stripFences(text) {
  return text.replace(/```[a-zA-Z0-9_-]*\s*\n?/g, '\n').replace(/```/g, '\n');
}

/**
 * The content of the LAST think block, or '' when there is none.
 *
 * Tag variants are normalized because the model emits `<TINK>` about as often
 * as `<think>`, and case/whitespace vary on top of that. A missing or unclosed tag
 * is not an error: the fields are still parsed, `cot` is simply empty.
 *
 * Pairing is stack-based rather than "longest body wins". The longest-body
 * heuristic looks tempting and is wrong: with two blocks it returns everything
 * between the first open and the last close, which is prose plus tags, not
 * reasoning. The last COMPLETED block is what the model meant.
 */
function extractLastThink(text) {
  const re = /<\s*(\/?)\s*(?:tink|think)\s*>/gi;
  const open = [];
  let last = '';
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1] === '/') {
      if (open.length > 0) {
        last = text.slice(open.pop().end, m.index).trim();
      }
      // A closing tag with nothing open is stray markup; ignore it.
    } else {
      open.push({ end: m.index + m[0].length });
    }
  }
  return last;
}

/**
 * Locate the last `key:` marker in the text.
 *
 * A marker is a field name followed by a colon, at the start of the text, or
 * right after a tab or a newline. That positional requirement is what lets a
 * value contain colons (`value: https://x/y`) and URLs survive intact.
 *
 * `keyStart` is where the field name itself begins — the caller slices from
 * there, not from `valueStart`, so the marker's own key stays in the section
 * and is parsed like any other field.
 */
function lastFieldMarker(text, key) {
  const re = new RegExp(`(^|\\t|\\n)([ \\t]*)(${key})([ \\t]*)(:[ \\t]*)`, 'gi');
  let found = null;
  let m;
  while ((m = re.exec(text)) !== null) {
    found = {
      keyStart: m.index + m[1].length + m[2].length,
      valueStart: m.index + m[0].length,
    };
  }
  return found;
}

/**
 * Scan a field section into key → value.
 *
 * Fields are separated by a newline OR a tab, which is the upstream format's
 * own ambiguity: some generations put every field on its own line, others put
 * them all on one line separated by tabs. Both are accepted. A value runs until
 * the next marker's key, so free text with colons inside is preserved.
 */
function parseFields(section) {
  const re = /(^|\t|\n)([ \t]*)([A-Za-z_][A-Za-z0-9_]*)([ \t]*)(:[ \t]*)/g;
  const marks = [];
  let m;
  while ((m = re.exec(section)) !== null) {
    marks.push({
      key: m[3].toLowerCase(),
      keyStart: m.index + m[1].length + m[2].length,
      valueStart: m.index + m[0].length,
    });
  }
  const out = {};
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].keyStart : section.length;
    const raw = section.slice(marks[i].valueStart, Math.max(marks[i].valueStart, end));
    // First marker wins: a repeated key is the model repeating itself, and
    // guessing which one it meant is exactly the kind of guess this grammar
    // refuses to make.
    if (out[marks[i].key] === undefined) {
      out[marks[i].key] = raw;
    }
  }
  return out;
}

/**
 * Parse a coordinate.
 *
 * Accepted: "500,500" and "500 500". A TAB inside is rejected on purpose — with
 * the tab-as-separator rule above it means the model emitted a half-coordinate,
 * and guessing the other half is how an agent clicks the wrong thing.
 */
function parsePoint(raw) {
  const s = String(raw).trim();
  if (s.length === 0) {
    return { ok: false };
  }
  const parts = s.split(/[, ]+/).filter((p) => p.length > 0);
  if (parts.length !== 2) {
    return { ok: false };
  }
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false };
  }
  return { ok: true, point: [x, y] };
}

/** A short tail of the raw output, for the caller's error report. */
function tail(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length <= 200 ? t : `…${t.slice(t.length - 200)}`;
}

function truncate(s, n) {
  const t = typeof s === 'string' ? s : String(s ?? '');
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

module.exports = {
  GELAB_ACTIONS,
  REQUIRED_FIELDS,
  ANY_OF_FIELDS,
  COMMON_REQUIRED,
  KNOWN_FIELDS,
  str2action,
  action2str,
  validateAction,
  describeAction,
};
