'use strict';

/**
 * amooCliPlan.js — 纯叶子（零 IO、确定性、绝不抛）。
 *
 * `khy amoo` 的解析与文案。判定与渲染在这里，IO（adb / 桥 HTTP / 屏幕 dump）全在
 * services/domain/network/amoo/ 的薄壳里——所以「没插手机也能把命令行判错」是可断言的。
 *
 * 两个方向都从这个命令面出去：
 *   ① PC → Amoo：`khy amoo send` 在手机界面上输入、发送、轮询答复（需 --confirm）；
 *   ② Amoo → PC ：`khy amoo client …` 转发给手机侧单文件客户端（方向 1 才是日常路径）。
 * 计划渲染复用 amooDispatchPlan.renderDispatchPlan，不另写一份步骤文案。
 */

const { renderDispatchPlan } = require('./amooDispatchPlan');

const ACTIONS = Object.freeze(['help', 'status', 'plan', 'send', 'client', 'prompts', 'workspace']);
const DEFAULT_ACTION = 'status';
const TEXT_ACTIONS = Object.freeze(['plan', 'send']);

function _cleanTokens(tokens) {
  if (!Array.isArray(tokens)) {
    return [];
  }
  return tokens
    .map((token) => (token === null || token === undefined ? '' : String(token)))
    .map((token) => token.trim())
    .filter(Boolean);
}

function _isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 把 router 解析出的选项还原成 `--k` / `--k=v`，原样转交给手机侧客户端。
 * 这一步必然有损（重复 flag、`--` 之后的位置参数都丢了），所以只用于转发，
 * 不用来做本命令自己的判定。
 * @param {object} options
 * @returns {string[]}
 */
function optionsToArgv(options) {
  if (!_isPlainObject(options)) {
    return [];
  }
  const out = [];
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (value === true) {
      out.push(`--${key}`);
    } else if (value === false) {
      continue;
    } else {
      out.push(`--${key}=${String(value)}`);
    }
  }
  return out;
}

/**
 * 拆首段子命令。空参落到默认动作（status），未知词明确拒绝并列出可用词。
 * @param {string[]} list
 * @returns {{ok:true, action:string, rest:string[]} | {ok:false, code:string, error:string}}
 */
function _resolveAction(list) {
  if (list.length === 0) {
    return { ok: true, action: DEFAULT_ACTION, rest: list };
  }
  const head = list[0].toLowerCase();
  if (ACTIONS.includes(head)) {
    return { ok: true, action: head, rest: list.slice(1) };
  }
  return {
    ok: false,
    code: 'unknown_action',
    error: `未知子命令：${list[0]}（可用：${ACTIONS.join(' / ')}）`,
  };
}

/**
 * @param {string[]} tokens 位置参数（subCommand + args）
 * @param {object} [options] router 解析出的选项
 * @returns {object} ok:false 时带 code + error（中文，直接可显示）
 */
function parseAmooArgv(tokens = [], options = {}) {
  const list = _cleanTokens(tokens);
  const opts = _isPlainObject(options) ? options : {};
  const resolved = _resolveAction(list);
  if (!resolved.ok) {
    return resolved;
  }
  const { action, rest } = resolved;

  const base = { ok: true, action, confirm: opts.confirm === true };
  if (action === 'client') {
    // `--help` 到不了这里：bin/khy.js 的快速路径会把 `<命令> --help` 变成命令卡片
    // （这正是 khy amoo --help 出卡片的原因）。所以手机侧客户端的用法改由
    // `khy amoo client help` 触发，在这里换算成客户端认识的 --help。
    const forwarded = [...rest];
    if (forwarded.length > 0 && ['help', '-h'].includes(forwarded[0].toLowerCase())) {
      forwarded[0] = '--help';
    }
    return { ...base, clientArgv: [...forwarded, ...optionsToArgv(opts)] };
  }
  if (TEXT_ACTIONS.includes(action)) {
    const taskText = rest.join(' ').trim();
    if (!taskText) {
      return {
        ok: false,
        code: 'task_empty',
        error: `子命令 ${action} 需要任务文本，例如 khy amoo ${action} 帮我查一下今天的电量。`,
      };
    }
    return { ...base, taskText };
  }
  if (action === 'workspace') {
    // workspace 的参数是「动作 + 目录」，交给 amooWorkspacePlan 解析——在这
    // 一层放开 rest，否则 `push <目录>` 会被下面的意外参数检查拒掉。
    return { ...base, workspaceArgv: rest };
  }
  if (rest.length > 0) {
    return {
      ok: false,
      code: 'unexpected_args',
      error: `子命令 ${action} 不接受参数：${rest.join(' ')}`,
    };
  }
  return base;
}

function renderAmooHelp() {
  return [
    'Amoo 协作层（khy-os ↔ 手机上的 Amoo）',
    '',
    '  khy amoo                     读协作状态（默认子命令）',
    '  khy amoo status              adb / 转发 / 桥 / 令牌 / 当前界面',
    '  khy amoo plan <任务文本>     只看下发计划，一条 adb 都不发',
    '  khy amoo send <任务文本>     真的在手机上输入并发送（需 --confirm）',
    '  khy amoo client [参数…]      转发给手机侧客户端 amoo-khy-client.js',
    '  khy amoo prompts             打印提示词包位置',
    '  khy amoo workspace <动作>    双向同步工作区（push/pull/status，走 adb）',
    '',
    '例：khy amoo plan 把今晚的复盘写到备忘录',
    '例：khy amoo send 把今晚的复盘写到备忘录 --confirm',
    '例：khy amoo client --help',
    '',
    '诚实边界：',
    '  - lite 桥没有无障碍服务、没有 UI 工具；读屏与点击全部走 PC 侧 adb。',
    '  - PC 驱动 Amoo 天生不能无人值守：Amoo 必须在前台，平台不允许助手打开侧载应用。',
    '  - 日常优先走方向 1（Amoo 主动来调 khy-os），即 khy amoo client 那一侧。',
  ].join('\n');
}

/**
 * 状态下渲染。消费 collectStatus() 的返回值，不再碰设备。
 * @param {object} [status]
 * @returns {string}
 */
function renderStatusText(status = {}) {
  const snap = _isPlainObject(status) ? status : {};
  const bridge = _isPlainObject(snap.bridge) ? snap.bridge : {};
  const device = _isPlainObject(snap.device) ? snap.device : {};
  const forwards = _isPlainObject(snap.forwards) ? snap.forwards : {};
  const screen = _isPlainObject(snap.screen) ? snap.screen : null;
  const lines = [];
  lines.push(`adb：${snap.adb && snap.adb.resolved ? `已解析（${snap.adb.source}）` : '未解析'}`);
  // 未连接时把 reason 与 detail 都带上：detail 里的「未发现手机：adb 设备表为空…」
  // 是「未发现手机」验收能成立的前提，只打 reason（device_not_found）排查时是死路。
  lines.push(`设备：${device.connected ? `已连接 ${device.serial || ''}` : `未连接（${device.reason || 'unknown'}）${device.detail ? '：' + device.detail : ''}`}`);
  lines.push(`转发：${forwards.ok ? `已建立 ${(forwards.ports || []).join(' + ')}` : forwards.detail || '未建立'}`);
  // An offline bridge without its reason is a dead end for whoever reads it:
  // collectStatus() always carries a detail (bridge_request_timeout,
  // bridge_unreachable, …), so print it instead of a bare "不在线".
  lines.push(
    bridge.online
      ? `桥：在线，端口 ${bridge.port}，传输 ${bridge.transport}`
      : `桥：不在线${bridge.detail ? `（${bridge.detail}）` : ''}`
  );
  lines.push(`令牌：${bridge.token ? `已读取 ${bridge.token}` : bridge.tokenDetail || '不可用'}`);
  if (screen) {
    lines.push(`当前界面：${screen.summary || '未知'}`);
  }
  return lines.join('\n');
}

/**
 * 下发结果渲染。答复文本是用户的资产，原样给出；步骤与计划复用单元内真源。
 * @param {object} [res] dispatchTask 的返回值
 * @returns {string}
 */
function renderDispatchResultText(res = {}) {
  const out = _isPlainObject(res) ? res : {};
  const lines = [];
  lines.push(out.message || '下发结束。');
  const reply = _isPlainObject(out.reply) ? out.reply : null;
  if (reply && typeof reply.text === 'string' && reply.text.trim()) {
    lines.push('');
    lines.push('── Amoo 答复 ──');
    lines.push(reply.text);
    if (reply.truncated === true) {
      lines.push(`（已截断，原文 ${reply.originalChars} 字）`);
    }
  }
  if (out.planText) {
    lines.push('');
    lines.push('── 执行计划 ──');
    lines.push(out.planText);
  } else if (out.plan) {
    lines.push('');
    lines.push(renderDispatchPlan(out.plan));
  }
  return lines.join('\n');
}

module.exports = {
  ACTIONS,
  DEFAULT_ACTION,
  TEXT_ACTIONS,
  optionsToArgv,
  parseAmooArgv,
  renderAmooHelp,
  renderStatusText,
  renderDispatchResultText,
};
