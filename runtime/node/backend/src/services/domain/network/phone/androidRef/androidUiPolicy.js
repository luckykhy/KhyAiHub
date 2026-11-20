'use strict';

/**
 * androidUiPolicy.js — pure decision leaf: gating, confirm plan, device argv and
 * post-action verdict for the Android GUI loop.
 *
 * Zero IO, deterministic, never throws. The code that actually spawns adb lives in
 * uidrefAdapter / index.js; this file only answers "may this action run, what does
 * it send, and did it take effect".
 *
 * Why text input does not use `adb shell input text`: upstream textin found only 4
 * of 19 character classes land cleanly, and a backtick is executed by the device
 * shell — that is an injection surface. Here every keystroke is a numeric
 * `input keyevent` code; anything outside the table is refused and pointed at the
 * accessibility/approval-backed alternatives.
 */

const ACTIONS = Object.freeze([
  'snapshot', 'tap', 'longpress', 'swipe', 'back', 'home', 'recents', 'type',
]);
const REF_ACTIONS = Object.freeze(['tap', 'longpress', 'swipe', 'type']);
const DIRECTIONS = Object.freeze(['up', 'down', 'left', 'right']);
const REF_PATTERN = /^e\d+$/;

const MAX_TEXT_CHARS = 80;
const LONG_PRESS_MS = 600;
const SWIPE_DURATION_MS = 300;
const DEFAULT_SWIPE_DISTANCE = 300;
const MIN_SWIPE_DISTANCE = 100;
const MAX_SWIPE_DISTANCE = 1500;

// /dev/tty is the Android-side convention for "write the dump to stdout". The
// device path is one named constant with an env override: ROMs that reject it
// can be worked around without touching code.
const DUMP_TARGET_DEFAULT = '/dev/tty';

const ACTION_TARGETS = Object.freeze({
  back: '系统返回键',
  home: '系统主屏键',
  recents: '最近任务键',
});

const ACTION_LABELS = Object.freeze({
  tap: '点击',
  longpress: '长按',
  swipe: '滑动',
  back: '返回',
  home: '回主屏',
  recents: '打开最近任务',
  type: '输入文本到',
});

// Android KeyEvent codes for characters a single key produces. Uppercase, quotes,
// backtick, $ and newlines all need shift or a sub-shell, which is exactly the
// injection surface this table exists to avoid.
const KEYCODE_BY_CHAR = Object.freeze({
  '0': 7, '1': 8, '2': 9, '3': 10, '4': 11, '5': 12, '6': 13, '7': 14, '8': 15, '9': 16,
  '*': 17, '#': 18,
  a: 29, b: 30, c: 31, d: 32, e: 33, f: 34, g: 35, h: 36, i: 37, j: 38,
  k: 39, l: 40, m: 41, n: 42, o: 43, p: 44, q: 45, r: 46, s: 47, t: 48,
  u: 49, v: 50, w: 51, x: 52, y: 53, z: 54,
  ',': 55, '.': 56,
  ' ': 62,
  '-': 69, '=': 70, '[': 71, ']': 72, ';': 74, '/': 76, '@': 77, '+': 81,
});

const KEYEVENT_ACTIONS = Object.freeze({ back: '4', home: '3', recents: '187' });

const VISIBLE_CHARS = Object.freeze({
  '\n': '换行', '\r': '回车', '\t': '制表', '\b': '退格', '\f': '换页',
});

/** The parent chain is resolved inside isFlagEnabled (KHY_ANDROID_UI_* -> KHY_ANDROID_UI_TOOL). */
function _flagEnabled(name, env) {
  try {
    // eslint-disable-next-line global-require
    return require('../../../../../utils/flagRegistry').isFlagEnabled(name, env);
  } catch {
    const raw = env && env[name];
    if (raw === undefined || raw === null) {
      return true;
    }
    return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
  }
}

function buildDumpDeviceArgs(env = process.env) {
  const explicit = String((env && env.KHY_ANDROID_UI_DUMP_PATH) || '').trim();
  return ['exec-out', 'uiautomator', 'dump', explicit || DUMP_TARGET_DEFAULT];
}

function _describeChars(chars) {
  return chars.slice(0, 8).map((c) => VISIBLE_CHARS[c] || `'${c}'`).join(' ');
}

/**
 * Text -> numeric keyevent codes. No escaping happens anywhere (there is no shell
 * string), so there is no path where a character is reinterpreted by the device.
 */
function encodeTextToKeycodes(text) {
  const input = String(text == null ? '' : text);
  const codes = [];
  const unsupported = [];
  for (const ch of input) {
    const code = KEYCODE_BY_CHAR[ch];
    if (code === undefined) {
      if (!unsupported.includes(ch)) {
        unsupported.push(ch);
      }
      continue;
    }
    codes.push(code);
  }
  if (unsupported.length) {
    return {
      ok: false,
      codes,
      unsupported,
      message: `文本含 ${unsupported.length} 个码表外字符（${_describeChars(unsupported)}），未发送任何按键`,
    };
  }
  return {
    ok: true,
    codes,
    unsupported: [],
    message: `文本 ${input.length} 字符 → ${codes.length} 个 keyevent 码`,
  };
}

function clampDistance(value) {
  const n = Number.parseInt(String(value == null ? '' : value), 10);
  if (!Number.isFinite(n)) {
    return DEFAULT_SWIPE_DISTANCE;
  }
  if (n < MIN_SWIPE_DISTANCE) {
    return MIN_SWIPE_DISTANCE;
  }
  if (n > MAX_SWIPE_DISTANCE) {
    return MAX_SWIPE_DISTANCE;
  }
  return n;
}

function elementCenter(element) {
  const center = element && Array.isArray(element.center) ? element.center : null;
  if (!center || center.length !== 2) {
    return null;
  }
  const x = Number(center[0]);
  const y = Number(center[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

function swipeEnd(center, direction, distance) {
  const dx = direction === 'left' ? -distance : direction === 'right' ? distance : 0;
  const dy = direction === 'up' ? -distance : direction === 'down' ? distance : 0;
  // The device clamps off-screen coordinates itself; only keep the sign positive
  // so a minus can never be read as an argv flag.
  return [Math.max(0, center[0] + dx), Math.max(0, center[1] + dy)];
}

/**
 * Plan one action. Without confirm this returns a plan and produces no device
 * side effect at all.
 *
 * @param {object} rawInput  {action, ref, text, direction, distance, confirm}
 * @param {object} [options] {env, isEnabled}
 * @returns {object} plan / plan-awaiting-confirm / refusal
 */
function planAndroidUiAction(rawInput = {}, options = {}) {
  const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
  const env = options.env || process.env;
  const isEnabled = typeof options.isEnabled === 'function'
    ? options.isEnabled
    : (name) => _flagEnabled(name, env);
  const action = String(input.action || 'snapshot').trim().toLowerCase();

  if (!ACTIONS.includes(action)) {
    return {
      success: false,
      code: 'unknown_action',
      error: `未知 action:${action}；可用：${ACTIONS.join(' / ')}`,
    };
  }

  const tier = action === 'snapshot' ? 'read' : 'write';

  // Every action needs a dump to resolve a ref, so the dump gate is the gate for
  // the whole chain, not just for snapshot.
  if (!isEnabled('KHY_ANDROID_UI_DUMP')) {
    return {
      success: false,
      code: 'dump_disabled',
      error: '界面抓取已关闭：KHY_ANDROID_UI_DUMP=off',
      hint: 'AndroidUi 的每个动作都要先抓一次 uiautomator dump；需要时显式设 KHY_ANDROID_UI_DUMP=1 后重试。',
    };
  }

  if (action === 'type' && !isEnabled('KHY_ANDROID_UI_TEXT')) {
    return {
      success: false,
      code: 'text_disabled',
      error: '文本输入已关闭：KHY_ANDROID_UI_TEXT=off',
      // Plan only, never send: the caller can see what would have been typed.
      plan: {
        action,
        tier,
        ref: String(input.ref || '').trim(),
        textChars: String(input.text == null ? '' : input.text).length,
      },
      hint: '点按/滑动仍可用；要输入文本需显式设 KHY_ANDROID_UI_TEXT=1，或改用 PhoneBridge 的 ui_type（full 构建 + 无障碍授权）/ hiao 的 ui_type（带审批）。',
    };
  }

  if (tier === 'read') {
    return { success: true, action, tier, requiresConfirm: false, plan: { action, tier } };
  }

  const needsRef = REF_ACTIONS.includes(action);
  const ref = String(input.ref || '').trim();
  if (needsRef && !REF_PATTERN.test(ref)) {
    return {
      success: false,
      code: 'invalid_args',
      error: `action "${action}" 需要 ref（形如 e14，取自最近一次 snapshot 的 digest）`,
      hint: '先执行 action:"snapshot"，再按 digest 里的 ref 选目标；坐标由服务端从 ref 的中心点解析，不用自己算。',
    };
  }

  const plan = {
    action,
    tier,
    ref: needsRef ? ref : null,
    target: needsRef ? `元素 ${ref}` : ACTION_TARGETS[action],
  };

  if (action === 'type') {
    const text = String(input.text == null ? '' : input.text);
    if (!text) {
      return {
        success: false,
        code: 'invalid_args',
        error: 'action "type" 需要 text',
        hint: '把要输入的文本放进 text 参数（小写 ASCII，单次 ≤80 字符）。',
      };
    }
    if (text.length > MAX_TEXT_CHARS) {
      return {
        success: false,
        code: 'text_too_long',
        error: `text 长 ${text.length} 字符，超过单次 ${MAX_TEXT_CHARS} 字符上限`,
        hint: '拆成多次 type，或改用 PhoneBridge / hiao 的 ui_type。',
      };
    }
    const encoded = encodeTextToKeycodes(text);
    if (!encoded.ok) {
      return {
        success: false,
        code: 'text_not_supported',
        error: encoded.message,
        hint: 'keyevent 码表只覆盖小写字母/数字/空格与少量符号；中文、大写、引号、反引号、$、换行都不发送。改用 PhoneBridge 的 ui_type 或 hiao 的 ui_type。',
      };
    }
    plan.textChars = text.length;
    plan.keyevents = encoded.codes.length;
    plan.deviceArgs = ['shell', 'input', 'keyevent'].concat(encoded.codes.map(String));
  } else if (action === 'swipe') {
    const direction = String(input.direction || '').trim().toLowerCase();
    if (!DIRECTIONS.includes(direction)) {
      return {
        success: false,
        code: 'invalid_args',
        error: `action "swipe" 需要 direction ∈ ${DIRECTIONS.join(' / ')}`,
        hint: '方向从目标元素中心起算，例如 direction:"up" 表示向上滑。',
      };
    }
    plan.direction = direction;
    plan.distance = clampDistance(input.distance);
    plan.deviceArgs = null; // depends on the element center, built after ref resolution
  } else if (KEYEVENT_ACTIONS[action]) {
    plan.deviceArgs = ['shell', 'input', 'keyevent', KEYEVENT_ACTIONS[action]];
  } else {
    plan.deviceArgs = null;
  }

  if (input.confirm !== true) {
    return {
      success: false,
      requiresConfirm: true,
      code: 'requires_confirm',
      plan,
      message: `将在手机上执行 ${ACTION_LABELS[action]} ${plan.target}（第 1/1 步，等待确认）；confirm:true 后才发送。`,
    };
  }

  return { success: true, action, tier, requiresConfirm: false, plan };
}

/**
 * Build the device-side argv (without -s; phoneBridgePolicy.buildAdbArgv adds the
 * serial). Returns null when the element is missing or the text is refused — the
 * caller decides how to report that.
 */
function buildDeviceArgs(intent = {}) {
  const action = String(intent.action || '');
  const center = elementCenter(intent.element);
  switch (action) {
    case 'tap':
      return center ? ['shell', 'input', 'tap', String(center[0]), String(center[1])] : null;
    case 'longpress':
      return center
        ? ['shell', 'input', 'swipe',
          String(center[0]), String(center[1]),
          String(center[0]), String(center[1]),
          String(LONG_PRESS_MS)]
        : null;
    case 'swipe': {
      if (!center) {
        return null;
      }
      const direction = String(intent.direction || '').trim().toLowerCase();
      const distance = clampDistance(intent.distance);
      const end = swipeEnd(center, direction, distance);
      return ['shell', 'input', 'swipe',
        String(center[0]), String(center[1]),
        String(end[0]), String(end[1]),
        String(SWIPE_DURATION_MS)];
    }
    case 'back':
    case 'home':
    case 'recents':
      return ['shell', 'input', 'keyevent', KEYEVENT_ACTIONS[action]];
    case 'type': {
      const encoded = encodeTextToKeycodes(intent.text);
      return encoded.ok
        ? ['shell', 'input', 'keyevent'].concat(encoded.codes.map(String))
        : null;
    }
    default:
      return null;
  }
}

/** Preconditions on the resolved target: the ref must still exist; type needs an input. */
function checkTarget(action, element) {
  if (!REF_ACTIONS.includes(action)) {
    return null;
  }
  if (!element) {
    return {
      code: 'stale_ref',
      error: 'ref 不在当前界面快照里',
      hint: '界面可能已经变了；先重新 action:"snapshot"，再按新 digest 选 ref。',
    };
  }
  if (action === 'type' && element.editable !== true) {
    return {
      code: 'target_not_editable',
      error: `目标 ${element.ref || ''} 不是输入框（editable=false）`,
      hint: '先点开输入框让光标落下，或用 action:"snapshot" 找一个 editable 元素再输入。',
    };
  }
  return null;
}

/**
 * Map screendiff.effectOf's four conclusions to one verdict.
 * The important part: "cannot tell" must stay null — never "did not work".
 */
function verdictOfEffect(effect, ref) {
  const conclusion = effect && effect.conclusion ? String(effect.conclusion) : 'unknown';
  const changes = Array.isArray(effect && effect.changes) ? effect.changes : [];
  const target = ref ? `元素 ${ref}` : '目标';
  if (conclusion === 'target_changed') {
    return {
      effective: true,
      conclusion,
      changes,
      message: `${target} 发生变化（${changes.join(', ') || '结构变化'}）——动作已生效`,
    };
  }
  if (conclusion === 'target_gone') {
    return {
      effective: true,
      conclusion,
      changes,
      message: `${target} 已从界面消失——动作已生效`,
    };
  }
  if (conclusion === 'target_unchanged') {
    return {
      effective: false,
      conclusion,
      changes: [],
      message: `${target} 无可见变化——可能没点中或应用未响应；先重新 snapshot 再换目标，不要原地重试`,
    };
  }
  return {
    effective: null,
    conclusion,
    changes: [],
    message: `无法判断 ${target} 是否生效（${conclusion === 'unknown_target' ? '该 ref 不在上一帧快照里' : '复检证据不足'}）——不把没有证据当作未生效`,
  };
}

/** System keys have no ref, so only a whole-screen identity check is available. */
function verdictOfScreenChange(changeSet) {
  const identical = !!(changeSet && changeSet.is_identical === true);
  if (identical) {
    return {
      effective: false,
      conclusion: 'screen_unchanged',
      changes: [],
      message: '整屏结构无变化——可能按键被应用吞掉；先重新 snapshot 再判断',
    };
  }
  return {
    effective: true,
    conclusion: 'screen_changed',
    changes: [],
    message: '整屏结构已变化——动作已生效',
  };
}

module.exports = {
  ACTIONS,
  REF_ACTIONS,
  DIRECTIONS,
  MAX_TEXT_CHARS,
  DEFAULT_SWIPE_DISTANCE,
  KEYCODE_BY_CHAR,
  buildDumpDeviceArgs,
  encodeTextToKeycodes,
  clampDistance,
  planAndroidUiAction,
  buildDeviceArgs,
  checkTarget,
  verdictOfEffect,
  verdictOfScreenChange,
};
