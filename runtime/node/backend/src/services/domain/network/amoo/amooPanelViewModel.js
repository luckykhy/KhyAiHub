'use strict';

/**
 * amooPanelViewModel.js — 纯叶子（零 IO、确定性、绝不抛）。
 *
 * collectStatus() 快照 + 最近一次 dispatchTask() 结果 → 面板行模型。判定与文案
 * 在这里，IO（adb / 桥 HTTP / 屏幕 dump）全在 services/domain/network/amoo/ 的薄壳里
 * ——所以「没插手机也能把面板的每一种状态判对」是可断言的。
 *
 * 与 amooCliPlan.js 的分工：那个叶子服务命令行（`khy amoo status` 的多行文本），
 * 本叶子服务面板（固定行、固定键、可逐行 React.memo 比对的行模型）。两边都消费同一个
 * collectStatus 形状，但**不互相复用格式**：命令行要的是完整排查信息，面板要的是
 * 30 列内的结论。重复的只有 stopReason 的中文映射，它单一真源在 amooDispatchPlan。
 *
 * 三条硬约束（面板侧 AGENTS.md 的下沉）：
 *   ① 行模型一次性建成，render 里不新建对象/数组 —— 所以行是固定 7 项、固定顺序、
 *      固定 key，调用方按 key 比对即可；
 *   ② 截断只按字符数并带省略号；CJK 双宽等显示宽度是面板的职责，本叶子不猜终端列宽；
 *   ③ 输入容差：status / dispatch / progress 为 null、非对象、字段缺失时全部走
 *      '—' + tone 'idle'，绝不抛，也绝不把「没测」显示成「测了是 0」。
 */

const { describeStopReason } = require('./amooDispatchPlan');

// 面板行的固定顺序。调用方按 key 取行，不要按下标——下标会随增删漂移。
const ROW_KEYS = Object.freeze(['adb', 'device', 'forward', 'bridge', 'tools', 'token', 'screen']);
const ROW_LABELS = Object.freeze({
  adb: 'adb',
  device: '设备',
  forward: '转发',
  bridge: '桥',
  tools: '工具',
  token: '令牌',
  screen: '界面',
});
const TONES = Object.freeze(['ok', 'warn', 'error', 'idle', 'busy']);
const UNKNOWN = '—';

const DEFAULT_MAX_VALUE_CHARS = 24;
const MAX_DETAIL_CHARS = 120;
const MAX_DETAILS = 8;
const MAX_STEPS = 12;
const REPLY_PREVIEW_CHARS = 120;

// 桥不在线时给人的恢复提示。命令与 phoneCliPlan 的 revive 同源：monkey 是这台 ROM 上
// 唯一实测有效的恢复路（am start 被 AMS 陈旧记录吞掉，start-service 因 exported=false 被拒）。
const REVIVE_HINT = '桥不在线时可试 khy phone revive（monkey 拉起，实测唯一恢复路）';
// lite 构建的边界：没有无障碍服务、没有任何 UI 工具，读屏与点击只能走 PC 侧 adb。
const LITE_NOTE = 'lite 桥无 UI 工具：读屏与点击走 PC 侧 adb（uiautomator dump）';
const PARTIAL_NOTE = '下发进行中：只保留桥心跳，未巡检设备、未读屏';

function _isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function _str(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

/**
 * 数字字段归一。null / undefined / 空串一律返 null（「没测」），**不能变成 0**——
 * `Number(null) === 0` 会把「桥没探活所以没问工具数」画成「0 个工具」，把
 * latencyMs 缺席画成「在线 0ms」，都是把没测显示成测了。
 * @param {unknown} value
 * @returns {number|null}
 */
function _num(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 单行化 + 按字符数截断。多行原文（如 `adb forward --list` 的输出）绝不进行模型。 */
function _oneLine(text) {
  return _str(text).replace(/\s+/g, ' ').trim();
}

/**
 * 按字符数截断并加省略号。空值统一显示成 UNKNOWN——「没测」和「测了个空」在面板上
 * 必须是同一个样子，猜一个空串出来比显示 — 更危险。
 * @param {unknown} text
 * @param {number} maxChars
 * @returns {{value:string, truncated:boolean}}
 */
function clipValue(text, maxChars) {
  const value = _oneLine(text);
  const cap = _num(maxChars);
  const limit = cap !== null && cap > 0 ? cap : DEFAULT_MAX_VALUE_CHARS;
  if (!value) {
    return { value: UNKNOWN, truncated: false };
  }
  if (value.length <= limit) {
    return { value, truncated: false };
  }
  return { value: `${value.slice(0, Math.max(1, limit - 1))}…`, truncated: true };
}

function _row(key, value, tone, hint, state) {
  const clipped = clipValue(value, state.maxValueChars);
  if (clipped.truncated) {
    state.truncated = true;
  }
  return { key, label: ROW_LABELS[key], value: clipped.value, tone, hint: _oneLine(hint) || null };
}

function _detail(text, state) {
  const line = _oneLine(text);
  if (!line) {
    return;
  }
  const clipped = line.length > MAX_DETAIL_CHARS ? `${line.slice(0, MAX_DETAIL_CHARS - 1)}…` : line;
  if (clipped) {
    state.details.push(clipped);
  }
}

// ── 状态行 ─────────────────────────────────────────────────────────────────

function _buildStatusRows(input, state) {
  const { status, partial } = input;
  const adb = status && _isPlainObject(status.adb) ? status.adb : null;
  const device = status && _isPlainObject(status.device) ? status.device : null;
  const forwards = status && _isPlainObject(status.forwards) ? status.forwards : null;
  const bridge = status && _isPlainObject(status.bridge) ? status.bridge : null;
  const screen = status && _isPlainObject(status.screen) ? status.screen : null;
  // 「测了没读到」与「没测」的判据：collectStatus 总带 screen 键（失败时为 null），
  // 而心跳快照和畸形输入压根没有这个键。
  const screenFieldPresent = !!status && Object.prototype.hasOwnProperty.call(status, 'screen');

  // 没有快照（或只是下发期间的心跳快照）时，没测过的行一律 —，不猜。
  if (!status) {
    return {
      rows: ROW_KEYS.map((key) => _row(key, UNKNOWN, 'idle', null, state)),
      adb, device, forwards, bridge, screen, measured: false,
    };
  }

  const rows = [];

  // adb：解析失败是整条链的最根上一环，它的 message 是唯一能说清「为什么」的东西。
  if (!adb) {
    rows.push(_row('adb', UNKNOWN, 'idle', null, state));
  } else if (adb.resolved === true) {
    rows.push(_row('adb', `已解析（${adb.source || '未知来源'}）`, 'ok', null, state));
  } else {
    rows.push(_row('adb', '未解析', partial ? 'warn' : 'error', adb.message, state));
    _detail(`adb：${adb.message || '未解析'}`, state);
  }

  // 设备：reason（adb_unresolved / adb_devices_failed / device_unreachable）是唯一
  // 能说清「哪一级断了」的字段，必须进 hint。
  if (!device) {
    rows.push(_row('device', UNKNOWN, 'idle', null, state));
  } else if (device.connected === true) {
    rows.push(_row('device', device.serial, 'ok', null, state));
  } else {
    rows.push(_row('device', '未连接', partial ? 'warn' : 'error', device.reason, state));
    _detail(`设备：未连接（${device.reason || 'unknown'}）${device.detail ? ` — ${device.detail}` : ''}`, state);
  }

  // 转发：优先 ports（'tcp:8896 + tcp:8898'），只有失败时才用 detail——detail 是
  // `adb forward --list` 的原文多行，进行模型会把 30 列看板撑爆。
  if (!forwards) {
    rows.push(_row('forward', UNKNOWN, 'idle', null, state));
  } else if (forwards.ok === true) {
    const ports = Array.isArray(forwards.ports) ? forwards.ports.filter(Boolean) : [];
    rows.push(_row('forward', ports.length > 0 ? ports.join(' + ') : '已建立', 'ok', null, state));
  } else {
    rows.push(_row('forward', '未建立', partial ? 'warn' : 'error', forwards.detail, state));
    _detail(`转发：${forwards.detail || '未建立'}`, state);
  }

  // 桥：不在线时必须带 detail（bridge_request_timeout / http_401 / bridge_unreachable…）。
  // 心跳快照（partial）下的「在线」是更弱的断言，降一档成 warn。
  if (!bridge) {
    rows.push(_row('bridge', UNKNOWN, 'idle', null, state));
  } else if (bridge.online === true) {
    const latency = _num(bridge.latencyMs);
    rows.push(
      _row(
        'bridge',
        latency !== null ? `在线 ${latency}ms` : '心跳正常',
        partial ? 'warn' : 'ok',
        partial ? bridge.detail : null,
        state
      )
    );
  } else {
    rows.push(_row('bridge', '不在线', partial ? 'warn' : 'error', bridge.detail, state));
    _detail(`桥：${bridge.detail || '不在线'}`, state);
  }

  // 工具数：collectStatus 在桥没探活时给 null。null 是「没问」，不是「0 个」。
  if (!bridge) {
    rows.push(_row('tools', UNKNOWN, 'idle', null, state));
  } else {
    const tools = _num(bridge.tools);
    if (tools === null) {
      rows.push(_row('tools', UNKNOWN, 'idle', null, state));
    } else {
      rows.push(_row('tools', `${tools} 个${bridge.mode ? `（${bridge.mode}）` : ''}`, 'ok', null, state));
    }
  }

  // 令牌：collectStatus 给的 token 已经是掩码形态（5500…8d30），原样显示即可，
  // 但 tokenDetail 要留痕——「不可用：读取超时」和「桥不在线所以没读」不是一件事。
  if (!bridge) {
    rows.push(_row('token', UNKNOWN, 'idle', null, state));
  } else if (bridge.token) {
    rows.push(_row('token', bridge.token, 'ok', null, state));
  } else {
    rows.push(_row('token', '不可用', 'warn', bridge.tokenDetail, state));
    _detail(`令牌：${bridge.tokenDetail || '不可用'}`, state);
  }

  // 界面：screen 为 null 时显示「读不到」，绝不显示成 0 字——0 字和读不到是两件事。
  // collectStatus 不保留 dump 的 error，所以 hint 只能从已测字段推导，不编。
  // 但「字段压根不在」是另一回事：那是没测（心跳快照 / 畸形输入），画 —。
  if (screen) {
    const nodes = _num(screen.nodes);
    const chatChars = _num(screen.chatChars);
    const hint =
      chatChars !== null && chatChars > 0
        ? `聊天 ${chatChars} 字 / ${_num(screen.chatLines) || 0} 行，输入框 ${_num(screen.inputChars) || 0} 字`
        : null;
    rows.push(_row('screen', nodes !== null ? `${nodes} 节点` : '已读取', 'ok', hint, state));
  } else if (screenFieldPresent) {
    const deviceOnline = !!(device && device.connected === true);
    const hint = partial
      ? PARTIAL_NOTE
      : deviceOnline
        ? '设备在线但没读到界面（Amoo 可能不在前台）'
        : null;
    rows.push(_row('screen', '读不到', partial || deviceOnline ? 'warn' : 'idle', hint, state));
    if (deviceOnline) {
      _detail('界面：读不到', state);
    }
  } else {
    rows.push(_row('screen', UNKNOWN, 'idle', null, state));
  }

  // measured = 「至少有一环真的测到了」。全缺失 / 全畸形的快照与没有快照同级，
  // 不能进后面的断裂判定（那里的每个分支都只看已测字段）。
  const measured = Boolean(adb || device || forwards || bridge || screen);
  return { rows, adb, device, forwards, bridge, screen, measured };
}

// ── headline ───────────────────────────────────────────────────────────────

/**
 * 一行中文结论。tone 由链路上**最早断裂**的一环决定，保证「红在最根上」——桥不在线时
 * 同时设备也没连，headline 说设备，因为修好设备之前修桥没有意义。
 */
function _buildHeadline(input) {
  const { status, partial, adb, device, forwards, bridge, screen, busy, measured } = input;
  if (busy) {
    return { tone: 'busy', headline: '正在向 Amoo 下发任务…' };
  }
  if (!status) {
    return { tone: 'idle', headline: '尚未读取手机状态' };
  }
  if (!measured) {
    // 快照在但一个字段都没测到（形状不对 / 全缺失）。这和「没读」对面板是同一件事，
    // 但说法要分开，否则排查时会去找一个不存在的读取动作。
    return { tone: 'idle', headline: '快照没有可读字段' };
  }
  if (partial) {
    // 心跳快照：adb / 设备 / 转发都是「没测」，不能拿去参与断裂判定。
    return { tone: 'warn', headline: '只有桥心跳快照（未巡检设备）' };
  }
  if (adb && adb.resolved !== true) {
    return { tone: 'error', headline: '协作链断裂：adb 未解析' };
  }
  if (device && device.connected !== true) {
    return { tone: 'error', headline: `设备未连接（${device.reason || 'unknown'}）` };
  }
  if (forwards && forwards.ok !== true) {
    return { tone: 'error', headline: '端口转发未建立' };
  }
  if (bridge && bridge.online !== true) {
    return { tone: 'error', headline: '桥服务不在线' };
  }
  if (!adb || !device || !forwards || !bridge) {
    // 没有断在上面任何一环，但链路本身没测全。说「正常」是 overclaim。
    return { tone: 'warn', headline: '快照不完整（部分链路未测）' };
  }
  if (!screen) {
    return { tone: 'warn', headline: '链路正常，但读不到当前界面' };
  }
  return { tone: 'ok', headline: '协作链正常' };
}

// ── dispatch 段 ────────────────────────────────────────────────────────────

function _dispatchRows(res, state) {
  const reply = _isPlainObject(res.reply) ? res.reply : null;
  const poll = _isPlainObject(res.poll) ? res.poll : null;
  const bridge = _isPlainObject(res.bridge) ? res.bridge : null;
  const rows = [];

  rows.push(
    _row(
      'result',
      res.ok === true ? '已收到答复' : `失败（${res.code || 'unknown'}）`,
      res.ok === true ? 'ok' : 'error',
      null,
      state
    )
  );
  // 停止原因的中文映射单一真源在 amooDispatchPlan（runner 也用它），此处不重抄。
  if (poll && poll.stopReason) {
    rows.push(
      _row('stop', describeStopReason(poll.stopReason), res.ok === true ? 'ok' : 'warn', poll.stopReason, state)
    );
  }
  if (reply) {
    const chars = _num(reply.originalChars);
    rows.push(
      _row(
        'reply',
        `${_str(reply.text).length} 字`,
        _str(reply.text).trim() ? 'ok' : 'idle',
        reply.truncated === true && chars !== null ? `原文 ${chars} 字，已截断` : null,
        state
      )
    );
  }
  if (poll && _num(poll.waitedMs) !== null) {
    rows.push(_row('elapsed', `${Math.round(poll.waitedMs / 1000)}s`, 'idle', null, state));
  }
  if (bridge && bridge.revived === true) {
    rows.push(_row('bridge', '执行中被重启', 'warn', bridge.detail, state));
  }
  return rows;
}

function _progressRows(progress, state) {
  const steps = Array.isArray(progress.steps) ? progress.steps : [];
  const done = steps.length;
  const poll = _isPlainObject(progress.poll) ? progress.poll : null;
  const last = steps.length > 0 ? steps[steps.length - 1] : null;
  const rows = [
    _row('step', `${done} 步`, 'idle', last ? `${last.id}${last.ok === true ? '' : '（失败）'}` : null, state),
  ];
  if (poll && _num(poll.round)) {
    rows.push(_row('poll', `第 ${_num(poll.round)}/${_num(poll.maxRounds) || '?'} 轮`, 'idle', null, state));
  }
  if (_num(progress.elapsedMs) !== null) {
    rows.push(_row('elapsed', `${Math.round(_num(progress.elapsedMs) / 1000)}s`, 'idle', null, state));
  }
  return rows;
}

function _capSteps(steps) {
  const list = Array.isArray(steps) ? steps.filter(_isPlainObject) : [];
  return list.slice(-MAX_STEPS).map((step) => ({
    id: _str(step.id),
    ok: step.ok === true,
    detail: _oneLine(step.detail) || null,
  }));
}

// ── 主入口 ─────────────────────────────────────────────────────────────────

/**
 * @param {object} [input]
 * @param {object|null} [input.status] collectStatus() 的快照（或 provider 合成的心跳快照）
 * @param {object|null} [input.dispatch] 最近一次 dispatchTask() 的返回值
 * @param {object|null} [input.progress] 下发中的实时进度（onStep / onPoll 喂出来的）
 * @param {boolean} [input.busy] 是否正在下发
 * @param {boolean} [input.stale] 快照是否已过 TTL
 * @param {number} [input.ageMs] 快照年龄（stale 徽章用）
 * @param {number} [input.now] 调用方的时钟；本叶子自己不读时钟
 * @param {number} [input.maxValueChars] 行值字符上限，默认 24
 * @returns {object} 行模型；结构与输入合法与否无关，绝不抛
 */
function buildAmooPanelModel(input = {}) {
  const opts = _isPlainObject(input) ? input : {};
  const state = {
    maxValueChars: opts.maxValueChars,
    details: [],
    truncated: false,
  };
  const status = _isPlainObject(opts.status) ? opts.status : null;
  const partial = !!(status && status.partial === true);
  const busy = opts.busy === true;
  const stale = opts.stale === true;
  const ageMs = _num(opts.ageMs);
  const dispatch = _isPlainObject(opts.dispatch) ? opts.dispatch : null;
  const progress = _isPlainObject(opts.progress) ? opts.progress : null;

  const built = _buildStatusRows({ status, partial }, state);
  const head = _buildHeadline({
    status,
    partial,
    busy,
    measured: built.measured,
    adb: built.adb,
    device: built.device,
    forwards: built.forwards,
    bridge: built.bridge,
    screen: built.screen,
  });

  const badges = [];
  if (busy) {
    badges.push({ key: 'busy', text: '下发中', tone: 'busy' });
  }
  if (stale) {
    badges.push({
      key: 'stale',
      text: ageMs !== null ? `数据停更 ${Math.max(1, Math.round(ageMs / 1000))}s` : '数据可能过期',
      tone: 'warn',
    });
  }
  if (dispatch && _isPlainObject(dispatch.bridge) && dispatch.bridge.revived === true) {
    badges.push({ key: 'revived', text: '桥被重启过', tone: 'warn' });
  }

  const notes = [];
  if (partial) {
    notes.push(PARTIAL_NOTE);
  }
  if (status && !built.screen && built.device && built.device.connected === true) {
    notes.push(LITE_NOTE);
  }

  // 桥不在线时把恢复提示放在 details 最前面：这是面板上唯一可执行的下一步。
  if (built.bridge && built.bridge.online !== true) {
    state.details.unshift(REVIVE_HINT);
  }

  const model = {
    at: _num(opts.now),
    tone: head.tone,
    headline: head.headline,
    rows: built.rows,
    badges,
    screen: built.screen,
    dispatch: null,
    progress: null,
    notes,
    details: state.details.slice(0, MAX_DETAILS),
    truncated: false,
  };

  if (progress) {
    model.progress = {
      steps: _capSteps(progress.steps),
      rows: _progressRows(progress, state),
    };
    model.dispatch = {
      tone: 'busy',
      headline: '正在向 Amoo 下发任务…',
      rows: model.progress.rows,
      steps: model.progress.steps,
      replyPreview: '',
      replyChars: 0,
      truncated: false,
    };
  } else if (dispatch) {
    const reply = _isPlainObject(dispatch.reply) ? dispatch.reply : null;
    const replyText = reply ? _str(reply.text) : '';
    model.dispatch = {
      tone: dispatch.ok === true ? 'ok' : 'error',
      headline: clipValue(dispatch.message, MAX_DETAIL_CHARS).value,
      rows: _dispatchRows(dispatch, state),
      steps: _capSteps(dispatch.steps),
      replyPreview: replyText.length > REPLY_PREVIEW_CHARS ? `${replyText.slice(0, REPLY_PREVIEW_CHARS)}…` : replyText,
      replyChars: replyText.length,
      truncated: reply ? reply.truncated === true : false,
    };
  }

  // 截断标记最后算：dispatch 段的行也会贡献截断。
  model.truncated = state.truncated;

  return model;
}

module.exports = {
  ROW_KEYS,
  ROW_LABELS,
  TONES,
  UNKNOWN,
  DEFAULT_MAX_VALUE_CHARS,
  REVIVE_HINT,
  LITE_NOTE,
  clipValue,
  buildAmooPanelModel,
};
