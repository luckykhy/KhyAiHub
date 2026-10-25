'use strict';

/**
 * gelabActionMap.js — the single translation table from model actions to
 * device steps.
 *
 * WHY one table, and why it is a pure leaf. Everything the agent can do to the
 * phone goes through here, so this is the file to read to answer "what can the
 * model actually make this phone do". Keeping it pure means that question is
 * answerable without a phone, a model, or a network — and it is unit-tested
 * that way.
 *
 * WHY coordinates are converted here and not at gesture time. The model's
 * coordinates refer to the frame it just saw. Converting at translation time
 * against the geometry of THAT frame is semantically correct; re-reading live
 * metrics at gesture time would map the model's point onto a layout it never
 * saw if the screen rotated in between.
 *
 * WHY every tool name in the table is resolved through the catalog. A name
 * typed here and not registered in phoneBridgeCatalog would fail at runtime
 * with a confusing error, on a device, minutes into an agent run. The test
 * asserts every name resolves, which turns that into a red test instead.
 */

const { findPhoneBridgeTool, isPhoneBridgeUiToolName } = require('../phoneBridgeCatalog');

/** Actions that stop the loop rather than touch the device. */
const CONTROL_ACTIONS = Object.freeze({
  COMPLETE: 'complete',
  ABORT: 'abort',
  INFO: 'info',
  CALL_USER: 'call_user',
  WAIT: 'wait',
});

const DEFAULTS = Object.freeze({
  slideMs: 300,
  longpressMs: 700,
  // Ceiling forwarded to the bridge for a long press. The bridge's gesture
  // latch historically waited a fixed 2s regardless of the requested duration,
  // so anything above ~1900ms was reported as "gesture cancelled" even though
  // it ran. Capping is a workaround, not a fix — see gelabConfig.
  longpressMaxMs: 1500,
});

/**
 * Convert one normalized 0-1000 coordinate to pixels for a given geometry.
 *
 * Exported for the tests and for the runner's geometry self-check. Rounding is
 * `Math.round`, and the result is clamped to `[0, size-1]` — clamping to `size`
 * would land one pixel outside the screen, which the gesture dispatcher
 * silently drops.
 */
function toPixel(normalized, size) {
  const px = Math.round((Number(normalized) / 1000) * Number(size));
  return Math.min(Math.max(px, 0), Math.max(0, Number(size) - 1));
}

/** Human-readable note when a coordinate had to be clamped. */
function clampNote(normalized, size, px) {
  const want = Math.round((Number(normalized) / 1000) * Number(size));
  if (want === px) {
    return '';
  }
  return `坐标 ${normalized} 已夹到 ${px}（屏幕边 ${Math.max(0, Number(size) - 1)}）`;
}

/**
 * Translate one validated action into a plan.
 *
 * @param {object} action a dict that already passed gelabActionGrammar
 * @param {object} ctx
 * @param {{width:number,height:number}|null} ctx.geometry pixels of the frame
 *        the model saw; null means "unknown", which is a hard stop rather than
 *        a guess
 * @param {'bridge'|'adb'} ctx.backend
 * @param {Array<{package:string,label:string}>} [ctx.apps] device-measured app
 *        index, used to resolve AWAKE names
 * @param {{x:number,y:number}|null} [ctx.lastInputBox] centre of the input box
 *        found by a live dump, preferred over the model's guess for TYPE
 * @param {{slideMs?:number,longpressMs?:number,longpressMaxMs?:number}} [ctx.limits]
 * @returns {object} TranslationPlan — never throws
 */
function translateAction(action, ctx) {
  const c = ctx || {};
  const limits = Object.assign({}, DEFAULTS, c.limits || {});
  const backend = c.backend === 'adb' ? 'adb' : 'bridge';
  const geo = c.geometry && Number.isFinite(c.geometry.width) && Number.isFinite(c.geometry.height)
    ? c.geometry
    : null;

  if (!action || typeof action !== 'object' || typeof action.action !== 'string') {
    return {
      ok: false,
      code: 'bad_action',
      observation: '动作对象不合法，无法翻译。',
      steps: [],
      access: 'read',
    };
  }

  const name = action.action.toUpperCase();

  // Control actions need no geometry and touch nothing.
  if (CONTROL_ACTIONS[name]) {
    return controlPlan(name, action);
  }

  if (name === 'BACK' || name === 'HOME') {
    return globalPlan(name, backend);
  }

  if (name === 'WAIT') {
    return waitPlan(action);
  }

  if (name === 'AWAKE') {
    return awakePlan(action, c, backend);
  }

  // Everything below needs real pixel geometry.
  if (!geo) {
    return {
      ok: false,
      code: 'no_geometry',
      observation: '拿不到屏幕几何，无法把归一化坐标换成像素。先确认截图通道可用'
        + '（桥的 shot_b64 或 adb exec-out screencap），再重试。',
      steps: [],
      access: 'read',
    };
  }

  if (name === 'CLICK') {
    return pointPlan(action, geo, backend, 'ui_tap', '点击', limits);
  }
  if (name === 'LONGPRESS') {
    return longpressPlan(action, geo, backend, limits);
  }
  if (name === 'SLIDE') {
    return slidePlan(action, geo, backend, limits);
  }
  if (name === 'TYPE') {
    return typePlan(action, geo, backend, c);
  }

  return {
    ok: false,
    code: 'unknown_action',
    observation: `未知动作 ${name}，翻译层不猜它想干什么。`,
    steps: [],
    access: 'read',
  };
}

// ── per-action builders ─────────────────────────────────────────────────────

function controlPlan(name, action) {
  const control = CONTROL_ACTIONS[name];
  const plan = {
    ok: true,
    control,
    steps: [],
    access: 'read',
    observation: '',
  };
  if (name === 'WAIT') {
    const ms = parseWaitMs(action.value);
    plan.waitMs = ms;
    plan.observation = `等待 ${ms} 毫秒。`;
  } else if (name === 'INFO') {
    plan.question = action.value || '';
    plan.observation = '需要向人提问，循环暂停。';
  } else if (name === 'CALL_USER') {
    plan.question = action.value || '';
    plan.tag = action.tag || '';
    plan.observation = '需要人介入，循环暂停。';
  } else if (name === 'COMPLETE') {
    plan.report = action.return || action.explain || '';
    plan.observation = '任务完成。';
  } else if (name === 'ABORT') {
    plan.report = action.explain || '';
    plan.observation = '模型主动放弃。';
  }
  return plan;
}

function globalPlan(name, backend) {
  if (backend === 'adb') {
    return {
      ok: true,
      steps: [step('shell', { argv: ['input', 'keyevent', name === 'BACK' ? '4' : '3'] }, 'adb', 'actuate', 300)],
      access: 'actuate',
      observation: name === 'BACK' ? '发送返回键。' : '回到桌面。',
    };
  }
  return {
    ok: true,
    steps: [step(name === 'BACK' ? 'ui_back' : 'ui_home', {}, 'bridge', 'actuate', 300)],
    access: 'actuate',
    observation: name === 'BACK' ? '发送返回键。' : '回到桌面。',
  };
}

function waitPlan(action) {
  const ms = parseWaitMs(action.value);
  return {
    ok: true,
    control: 'wait',
    waitMs: ms,
    steps: [],
    access: 'read',
    observation: `等待 ${ms} 毫秒（零设备步骤）。`,
  };
}

function awakePlan(action, ctx, backend) {
  const requested = String(action.value || '').trim();
  if (!requested) {
    return refuse('app_unresolved', 'AWAKE 没有给出应用名。');
  }
  const apps = Array.isArray(ctx.apps) ? ctx.apps : [];
  const hit = resolveApp(requested, apps);
  if (!hit) {
    const candidates = apps.slice(0, 8).map((a) => a.label || a.package);
    return {
      ok: false,
      code: 'app_unresolved',
      observation: `应用「${requested}」在设备上认不出来。`
        + (candidates.length > 0
          ? `已装的部分应用：${candidates.join('、')}。请用其中一个名字重试。`
          : '设备应用清单是空的——先确认 list_apps 能返回。'),
      steps: [],
      access: 'read',
    };
  }
  if (backend === 'adb') {
    return {
      ok: true,
      steps: [step('shell', {
        argv: ['monkey', '-p', hit.package, '-c', 'android.intent.category.LAUNCHER', '1'],
      }, 'adb', 'actuate', 1200)],
      access: 'actuate',
      observation: `打开「${hit.label || hit.package}」（${hit.package}）。`,
    };
  }
  return {
    ok: true,
    steps: [step('start_app', { package: hit.package }, 'bridge', 'actuate', 1200)],
    access: 'actuate',
    observation: `打开「${hit.label || hit.package}」（${hit.package}）。`,
  };
}

function pointPlan(action, geo, backend, tool, verb, limits) {
  const p = convertPoint(action.point, geo);
  if (!p.ok) {
    return refuse('bad_point', `${verb}的坐标不合法：${JSON.stringify(action.point)}`);
  }
  if (backend === 'adb') {
    return {
      ok: true,
      steps: [step('shell', { argv: ['input', 'tap', String(p.x), String(p.y)] }, 'adb', 'actuate', 400)],
      access: 'actuate',
      observation: `${verb} (${p.x},${p.y})。${p.note}`,
    };
  }
  return {
    ok: true,
    steps: [step(tool, { x: p.x, y: p.y }, 'bridge', 'actuate', 400)],
    access: 'actuate',
    observation: `${verb} (${p.x},${p.y})。${p.note}`,
  };
}

function longpressPlan(action, geo, backend, limits) {
  const p = convertPoint(action.point, geo);
  if (!p.ok) {
    return refuse('bad_point', `长按的坐标不合法：${JSON.stringify(action.point)}`);
  }
  const want = Number.isFinite(action.ms) ? action.ms : limits.longpressMs;
  const ms = Math.min(Math.max(Math.round(want), 200), limits.longpressMaxMs);
  const capped = ms !== Math.round(want);
  if (backend === 'adb') {
    // A long press over adb is a same-start same-end slow swipe, which is
    // exactly what the bridge's own longpress does deliberately.
    return {
      ok: true,
      steps: [step('shell', {
        argv: ['input', 'swipe', String(p.x), String(p.y), String(p.x), String(p.y), String(ms)],
      }, 'adb', 'actuate', ms + 200)],
      access: 'actuate',
      observation: `长按 (${p.x},${p.y}) ${ms} 毫秒。${p.note}`
        + (capped ? `（模型要 ${Math.round(want)}，已按上限夹到 ${ms}）` : ''),
    };
  }
  return {
    ok: true,
    steps: [step('ui_longpress', { x: p.x, y: p.y, ms }, 'bridge', 'actuate', ms + 200)],
    access: 'actuate',
    observation: `长按 (${p.x},${p.y}) ${ms} 毫秒。${p.note}`
      + (capped ? `（模型要 ${Math.round(want)}，已按上限夹到 ${ms}）` : ''),
  };
}

function slidePlan(action, geo, backend, limits) {
  const a = convertPoint(action.point1, geo);
  const b = convertPoint(action.point2, geo);
  if (!a.ok || !b.ok) {
    return refuse('bad_point', `滑动的坐标不合法：${JSON.stringify([action.point1, action.point2])}`);
  }
  if (a.x === b.x && a.y === b.y) {
    // NOT "the system treats a zero-length path as a hold" — the bridge's own
    // longpress is deliberately built on exactly that mechanism. The reason to
    // refuse is that the model BELIEVES it swiped while the device registers a
    // press: a silent semantic mismatch, which is worse than a loud failure.
    return {
      ok: false,
      code: 'degenerate_slide',
      observation: '滑动起点与终点重合，已拒绝执行——那会被当成一次长按，'
        + '而模型以为自己在滑动。请给不同的终点。',
      steps: [],
      access: 'read',
    };
  }
  const ms = limits.slideMs;
  if (backend === 'adb') {
    return {
      ok: true,
      steps: [step('shell', {
        argv: ['input', 'swipe', String(a.x), String(a.y), String(b.x), String(b.y), String(ms)],
      }, 'adb', 'actuate', ms + 200)],
      access: 'actuate',
      observation: `从 (${a.x},${a.y}) 滑到 (${b.x},${b.y})。${a.note}${b.note}`
        + '（只保留首末两点，中间轨迹由系统插值）',
    };
  }
  return {
    ok: true,
    steps: [step('ui_swipe', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, ms }, 'bridge', 'actuate', ms + 200)],
    access: 'actuate',
    observation: `从 (${a.x},${a.y}) 滑到 (${b.x},${b.y})。${a.note}${b.note}`
      + '（只保留首末两点，中间轨迹由系统插值）',
  };
}

function typePlan(action, geo, backend, ctx) {
  const text = typeof action.value === 'string' ? action.value : '';
  if (text.length === 0) {
    return refuse('missing_field', 'TYPE 没有给出要输入的文字。');
  }
  // Where to tap first. A live dump's EditText centre beats the model's
  // normalized guess: it is the real node geometry, not an inference about it.
  const focus = ctx.lastInputBox && Number.isFinite(ctx.lastInputBox.x) && Number.isFinite(ctx.lastInputBox.y)
    ? { x: Math.round(ctx.lastInputBox.x), y: Math.round(ctx.lastInputBox.y), note: '' }
    : (Array.isArray(action.point) ? convertPoint(action.point, geo) : null);

  const steps = [];
  let focusNote = '';
  if (focus && focus.ok !== false) {
    if (backend === 'adb') {
      steps.push(step('shell', {
        argv: ['input', 'tap', String(focus.x), String(focus.y)],
      }, 'adb', 'actuate', 300));
    } else {
      steps.push(step('ui_tap', { x: focus.x, y: focus.y }, 'bridge', 'actuate', 300));
    }
    focusNote = `先点输入框 (${focus.x},${focus.y})。`;
  }

  // The text goes through verbatim. No space→underscore mapping, no shell
  // escaping, no trimming beyond what the grammar already did: every one of
  // those transformations silently corrupts what the user asked to type.
  if (backend === 'adb') {
    // Over adb the only CJK-safe route is clipboard + paste, because
    // `input text` rejects non-ASCII. The bridge path needs none of that.
    steps.push(step('clipboard', { op: 'set', text }, 'bridge', 'actuate', 200, 'type'));
    steps.push(step('shell', { argv: ['input', 'keyevent', '279'] }, 'adb', 'actuate', 200));
    return {
      ok: true,
      steps,
      access: 'actuate',
      observation: `${focusNote}输入「${truncate(text, 30)}」（经剪贴板粘贴，因为 adb 的 input text 不收中文）。`,
    };
  }
  steps.push(step('ui_type', { text }, 'bridge', 'actuate', 200, 'type'));
  return {
    ok: true,
    steps,
    access: 'actuate',
    observation: `${focusNote}输入「${truncate(text, 30)}」。`,
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function step(tool, args, backend, access, postDelayMs, verify) {
  const s = { tool, args: args || {}, backend, access, postDelayMs: postDelayMs || 0 };
  if (verify) {
    s.verify = verify;
  }
  return s;
}

function refuse(code, observation) {
  return { ok: false, code, observation, steps: [], access: 'read' };
}

/** Convert a [x,y] in 0-1000 space to pixels, reporting any clamp. */
function convertPoint(point, geo) {
  if (!Array.isArray(point) || point.length !== 2
      || !point.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return { ok: false };
  }
  const x = toPixel(point[0], geo.width);
  const y = toPixel(point[1], geo.height);
  const note = [clampNote(point[0], geo.width, x), clampNote(point[1], geo.height, y)]
    .filter(Boolean).join('；');
  return { ok: true, x, y, note: note ? `${note}。` : '' };
}

/**
 * WAIT's value is in SECONDS.
 *
 * This is not a guess: the shipped parser (parser_0920_summary, which
 * mcp_server_config.yaml selects through the misleadingly named
 * "parser_0922_summary" alias) documents it as 「等待时间 value（秒）」. An
 * earlier revision of this module used a ">100 means milliseconds" heuristic
 * imported from a newer prompt generation; that heuristic has no basis in the
 * grammar actually shipped, and it silently turned `WAIT 3` into 3ms on one
 * reading and 3s on another depending on the number's size. Seconds, plainly.
 */
function parseWaitMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return 1000;
  }
  return Math.round(n * 1000);
}

/**
 * Resolve an app name against the device-measured index.
 *
 * Exact label match wins, then exact package, then a unique substring match on
 * either. Ambiguity and misses both return null — the caller turns that into a
 * refusal with the candidate list, so the model can retry with a real name.
 *
 * Deliberately NOT the upstream 285-line OPPO dictionary: it is a different
 * OEM's app set, it would be third-party content in this repo, and this device
 * reports its own labels through list_apps anyway.
 */
function resolveApp(requested, apps) {
  const q = requested.trim();
  const ql = q.toLowerCase();
  let substringHits = [];
  for (const app of apps) {
    const label = String(app.label || '');
    const pkg = String(app.package || '');
    if (label === q || pkg === q) {
      return app;
    }
    if ((label && label.toLowerCase().includes(ql)) || (pkg && pkg.toLowerCase().includes(ql))) {
      substringHits.push(app);
    }
  }
  // A substring hit that is also the only one whose label contains the query
  // exactly once is unambiguous; more than one is a guess, so refuse.
  const exactSub = substringHits.filter((a) => String(a.label || '').toLowerCase() === ql);
  if (exactSub.length === 1) {
    return exactSub[0];
  }
  if (substringHits.length === 1) {
    return substringHits[0];
  }
  return null;
}

function truncate(s, n) {
  const t = typeof s === 'string' ? s : String(s ?? '');
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

module.exports = {
  translateAction,
  toPixel,
  resolveApp,
  parseWaitMs,
  CONTROL_ACTIONS,
  DEFAULTS,
};
