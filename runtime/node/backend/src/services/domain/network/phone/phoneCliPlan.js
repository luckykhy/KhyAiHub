'use strict';

/**
 * phoneCliPlan.js — 纯叶子（零 IO、确定性、绝不抛）。
 *
 * `khy phone` 这一族的解析与文本渲染。判定（哪个子命令、参数是否合法、要不要
 * confirm、走哪条通道）与面向用户的文案都在这里，IO 全部留在
 * `cli/handlers/phone.js` 那一层——所以「没插手机也能把命令行判错」是可断言的。
 *
 * 与 PhoneBridgeTool 的分工：工具面给模型看，本叶子给人看。两者共用同一个
 * policy/catalog 真源（`phoneBridgePolicy` / `phoneBridgeCatalog`），不另立一份
 * 工具表，否则 UI 工具清单会漂移。
 *
 * 安全：令牌是 R2 级机密。本叶子渲染的任何文本都过 `redactSecrets`，命令行回显
 * 桥返回体时不会把设备上的 token 原文打到屏幕上。
 */

const { redactSecrets } = require('./phoneBridgePolicy');

const ACTIONS = Object.freeze([
  'help',
  'status',
  'ping',
  'probe',
  'tools',
  'call',
  'pull',
  'push',
  'collect',
  'scan',
  'setup',
  'revive',
  'connect',
  'devices',
]);

const DEFAULT_ACTION = 'status';
const CHANNELS = Object.freeze(['http', 'mailbox']);
const DEFAULT_CHANNEL = 'http';
// 桥返回体可能很大（ls /sdcard 的全量条目）；命令行回显只留一个上限。
const MAX_ECHO_CHARS = 4000;

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
 * 通道只接受 http / mailbox。信箱是兜底不是优选：桥的信箱 worker 单线程顺序
 * 处理 cmd_ 文件，一个卡死的 exec 会冻结整条队列，所以默认永远走 HTTP。
 * @param {unknown} raw
 * @returns {{ ok: boolean, channel?: string, code?: string, error?: string }}
 */
function normalizeChannel(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, channel: DEFAULT_CHANNEL };
  }
  const value = String(raw).trim().toLowerCase();
  if (CHANNELS.includes(value)) {
    return { ok: true, channel: value };
  }
  return {
    ok: false,
    code: 'unknown_channel',
    error: `未知通道：${raw}（可用：${CHANNELS.join(' / ')}）`,
  };
}

/**
 * 拆 `call <tool> [json]`。
 * @param {string[]} tokens
 * @returns {{ ok: boolean, tool?: string, args?: object, code?: string, error?: string }}
 */
function parseCallArgs(tokens) {
  const rest = _cleanTokens(tokens);
  if (rest.length === 0) {
    return {
      ok: false,
      code: 'tool_missing',
      error: 'call 需要桥工具名，例如 khy phone call battery。可用名用 khy phone tools 列出。',
    };
  }
  const tool = rest[0];
  if (rest.length === 1) {
    return { ok: true, tool, args: {} };
  }
  const raw = rest.slice(1).join(' ');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      code: 'args_not_json',
      error: `工具参数不是合法 JSON：${raw}。例：khy phone call exec '{"cmd":"getprop ro.product.model"}'`,
    };
  }
  if (!_isPlainObject(parsed)) {
    return {
      ok: false,
      code: 'args_not_object',
      error: '工具参数必须是 JSON 对象（例如 {"path":"/sdcard"}），不能是数组或标量。',
    };
  }
  return { ok: true, tool, args: parsed };
}

/**
 * 拆首段子命令。空参落到默认动作（status），未知词明确拒绝并列出可用词——
 * 静默落到默认动作会让 `khy phone statuss` 看起来像成功了。
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
 * @param {string[]} tokens 位置参数（subCommand + args，由 router 传入）
 * @param {object} [options] router 解析出的选项（--confirm / --channel）
 * @returns {object} 解析结果；ok:false 时带 code + error（中文，直接可显示）
 */
function parsePhoneArgv(tokens = [], options = {}) {
  const list = _cleanTokens(tokens);
  const opts = _isPlainObject(options) ? options : {};
  const resolved = _resolveAction(list);
  if (!resolved.ok) {
    return resolved;
  }
  const { action, rest } = resolved;

  const base = {
    ok: true,
    action,
    confirm: opts.confirm === true,
  };
  const channel = normalizeChannel(opts.channel);
  if (!channel.ok) {
    return channel;
  }
  base.channel = channel.channel;

  if (action === 'help') {
    return base;
  }
  if (action === 'pull') {
    // 设备路径必给，主机路径可省（默认当前目录同名文件）。
    if (rest.length === 0) {
      return {
        ok: false,
        code: 'missing_args',
        error: '子命令 pull 需要设备侧路径，例：khy phone pull /sdcard/DCIM/Camera/x.jpg out/x.jpg',
      };
    }
    if (rest.length > 2) {
      return {
        ok: false,
        code: 'unexpected_args',
        error: `子命令 pull 只接受「设备路径 [主机路径]」两个参数：${rest.join(' ')}`,
      };
    }
    return { ...base, remotePath: rest[0], localPath: rest[1] || '' };
  }
  if (action === 'collect') {
    // 设备目录与主机目录必给；类型可选（逗号分隔），时间窗可选（7d/48h/2w）。
    if (rest.length < 2) {
      return {
        ok: false,
        code: 'missing_args',
        error: '子命令 collect 需要「设备目录 主机目录」，例：khy phone collect /sdcard/DCIM out/dcim [image,video] [7d]',
      };
    }
    if (rest.length > 4) {
      return {
        ok: false,
        code: 'unexpected_args',
        error: `子命令 collect 只接受「设备目录 主机目录 [类型] [时间窗]」四个参数：${rest.join(' ')}`,
      };
    }
    const types = rest[2]
      ? rest[2].split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
      : [];
    return { ...base, remoteDir: rest[0], localDir: rest[1], types, since: rest[3] || '' };
  }
  if (action === 'scan') {
    // 只枚举不下载：设备目录必给，类型与时间窗可选。
    if (rest.length === 0) {
      return {
        ok: false,
        code: 'missing_args',
        error: '子命令 scan 需要设备侧目录，例：khy phone scan /sdcard/DCIM [image,video] [7d]',
      };
    }
    if (rest.length > 3) {
      return {
        ok: false,
        code: 'unexpected_args',
        error: `子命令 scan 只接受「设备目录 [类型] [时间窗]」三个参数：${rest.join(' ')}`,
      };
    }
    const types = rest[1]
      ? rest[1].split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
      : [];
    return { ...base, remoteDir: rest[0], types, since: rest[2] || '' };
  }
  if (action === 'push') {
    // 主机源文件与设备目标路径都必给。
    if (rest.length < 2) {
      return {
        ok: false,
        code: 'missing_args',
        error: '子命令 push 需要「主机文件 设备路径」，例：khy phone push out/app.apk /sdcard/Download/app.apk',
      };
    }
    if (rest.length > 2) {
      return {
        ok: false,
        code: 'unexpected_args',
        error: `子命令 push 只接受「主机文件 设备路径」两个参数：${rest.join(' ')}`,
      };
    }
    return { ...base, localPath: rest[0], remotePath: rest[1] };
  }
  if (action !== 'call') {
    if (rest.length > 0) {
      return {
        ok: false,
        code: 'unexpected_args',
        error: `子命令 ${action} 不接受参数：${rest.join(' ')}`,
      };
    }
    return base;
  }

  const call = parseCallArgs(rest);
  if (!call.ok) {
    return call;
  }
  return { ...base, tool: call.tool, args: call.args };
}

function renderPhoneHelp() {
  return [
    '手机桥接（khy-os → 手机 khy-os App，出站方向）',
    '',
    '  khy phone                     读桥状态（默认子命令）',
    '  khy phone status              设备 / 转发 / 桥 / 令牌一览',
    '  khy phone ping                只探活，不做任何准备',
    '  khy phone probe               读 status.json 心跳，区分「服务死了」与「端口死了」',
    '  khy phone tools               列出桥上可调用的工具与参数',
    '  khy phone call <工具> [json]  调用桥上工具',
    '  khy phone pull <设备路径> [主机路径]  把设备上的文件拉下来（图片/视频/音频/JSON 通用）',
    '  khy phone push <主机文件> <设备路径>  把本地文件推到手机（构建产物/脚本/配置）',
    '  khy phone collect <设备目录> <主机目录> [类型]  按类型批量采集并落清单（image,audio,video,json,text）',
    '  khy phone scan <设备目录> [类型] [时间窗]  只列清单不下载（7d/48h/2w）',
    '  khy phone call <工具> --channel mailbox   强制走文件信箱兜底',
    '  khy phone devices             列出 adb 看到的设备',
    '  khy phone connect             执行 adb connect（设备掉线时）',
    '  khy phone setup               列出装机后需要授权的各项及命令',
    '  khy phone revive              桥服务被杀后把它拉回来',
    '',
    '写操作（exec / write / rm / mv / cp / mkdir / start_app / toast / notify …）',
    '默认只回计划，加 --confirm 才真正执行。',
    '',
    '例：khy phone call battery',
    '例：khy phone call ls \'{"path":"/sdcard"}\'',
    '例：khy phone call exec \'{"cmd":"getprop ro.product.model"}\' --confirm',
    '',
    '诚实边界：UI 工具（ui_dump / ui_tap / shot …）需要手机上的无障碍服务已开启，',
    '未开启时会被明确拒绝；截图与操作别的应用界面依赖该服务。',
  ].join('\n');
}

/**
 * 状态渲染。只消费已取到的数据，不碰设备。
 * @param {{config?:object, status?:object, state?:object, tokenReady?:boolean,
 *          tokenError?:string}} [input]
 * @returns {string}
 */
function renderStatusText(input = {}) {
  const cfg = _isPlainObject(input.config) ? input.config : {};
  const status = _isPlainObject(input.status) ? input.status : {};
  const state = _isPlainObject(input.state) ? input.state : {};
  const lines = [];
  lines.push(
    `设备：${cfg.serial || '未解析'}${
      cfg.serialSource === 'auto'
        ? '（自动探测）'
        : cfg.serialSource === 'default'
          ? '（默认值，未探测到设备）'
          : ''
    }`
  );
  lines.push(`HTTP 通道：${cfg.baseUrl || '未解析'}`);
  lines.push(`信箱目录：${cfg.mailboxDir || '未解析'}（仅兜底）`);
  if (input.tokenReady) {
    lines.push('令牌：已从设备读取（不回显）');
  } else {
    lines.push(`令牌：不可用（${input.tokenError || '未读取'}）`);
  }
  const tools = Number(status.tools);
  lines.push(
    `桥：${status.up === false ? '未回应' : '在线'}，模式 ${status.mode || '未知'}，`
    + `工具 ${Number.isFinite(tools) ? tools : '未知'} 个`
  );
  lines.push(
    `进程内计数：调用 ${Number(state.totalCalls) || 0} 次，最近通道 ${state.lastChannel || '无'}`
  );
  return lines.join('\n');
}

/**
 * @param {{tools:object[], unavailableUiTools:string[], unavailableUiReason:string}} input
 * @returns {string}
 */
function renderToolListText(input = {}) {
  const tools = Array.isArray(input.tools) ? input.tools : [];
  const uiTools = Array.isArray(input.unavailableUiTools) ? input.unavailableUiTools : [];
  const assistantTools = Array.isArray(input.unavailableAssistantTools) ? input.unavailableAssistantTools : [];
  const lines = [];
  lines.push(`可调用工具 ${tools.length} 个：`);
  for (const tool of tools) {
    const risk = tool.risk ? ` [${tool.risk}]` : '';
    lines.push(`  ${tool.bridgeName}${risk} — ${tool.description || ''}`);
  }
  if (uiTools.length > 0) {
    lines.push('');
    lines.push(`不可用 ${uiTools.length} 个：${uiTools.join(' / ')}`);
    lines.push(`原因：${input.unavailableUiReason || '当前构建未提供'}`);
  }
  // 助手协同（Amoo 反代）组的不可用段，形态与 UI 工具一致：只在桥明确报「 withheld 」
  // （assistantAvailable===false）时才出现；桥没报到（null）时不渲染，见 phone.js _tools。
  if (assistantTools.length > 0) {
    lines.push('');
    lines.push(`不可用 ${assistantTools.length} 个：${assistantTools.join(' / ')}`);
    lines.push(`原因：${input.unavailableAssistantReason || '当前构建未提供'}`);
  }
  return lines.join('\n');
}

/**
 * 协作链两段的一屏速览：PC→手机（8896 这条命令走的通道）与 KhyOS↔amoon（18765）。
 *
 * 两段各自独立：任何一段缺席都只影响那一行，另一段照常工作——这正是「协作加强、
 * 各自也能单独干活」要显示的形态。amoon 段的数据来自它自己的 runtime.json /
 * capability.json，本行不要求它存在；缺失就写「未安装/未运行」，不写「故障」。
 *
 * @param {{amoon?:{installed:boolean,running:boolean,port?:number,capability?:string,
 *          serial?:string,error?:string}}} input
 * @returns {string}
 */
function renderChainText(input = {}) {
  const amoon = _isPlainObject(input.amoon) ? input.amoon : {};
  const lines = [];
  lines.push('协作链（两段独立，任一段缺席另一段照常可用）：');
  lines.push('  · PC → 手机   8896 · khy phone call / probe');
  if (amoon.installed !== true) {
    lines.push(`  · KhyOS ↔ amoon 18765 · 未安装（${amoon.error || '状态目录不存在'}）`);
    return lines.join('\n');
  }
  if (amoon.running !== true) {
    lines.push(`  · KhyOS ↔ amoon 18765 · 未运行（${amoon.error || '没有 runtime.json 或 /health 不通'}）`);
    lines.push('    启动：node delivery/extension/bridges/khy-amoon-bridge/bin/cli.js start');
    return lines.join('\n');
  }
  const port = Number(amoon.port);
  const cap = amoon.capability || 'unverified';
  lines.push(`  · KhyOS ↔ amoon ${Number.isFinite(port) ? port : '?'} · 运行中`);
  lines.push(`    amoon→PC 能力：${cap}${cap === 'unverified' ? '（未经 Phase 0 探测，不宣称可用）' : ''}`);
  return lines.join('\n');
}

/**
 * @param {{grants:object[], serial?:string, serialSource?:string}} input
 * @returns {string}
 */
function renderSetupText(input = {}) {
  const grants = Array.isArray(input.grants) ? input.grants : [];
  const serial = input.serial || '<序列号>';
  const lines = [];
  // serialSource 为 default 时，这个地址是仓库里的历史占位值（另一台机器的），
  // 不是用户的手机。照抄会报 device not found——必须先说清楚。
  if (input.serialSource === 'default') {
    lines.push('未探测到设备：下面的 ' + serial + ' 是历史占位地址，需替换为手机实际地址。');
    lines.push('查实际地址：adb mdns services（找 _adb-tls-connect._tcp 那一行，形如 192.168.x.x:端口）');
    lines.push('');
  }
  lines.push('装机后需要授权的各项（命令需在 PC 上执行，khy 不代跑）：');
  for (const grant of grants) {
    const mark = grant.required ? '必填' : '可选';
    const lite = grant.applicableToLiteBuild === false ? '（lite 构建不适用）' : '';
    lines.push('');
    lines.push(`[${mark}] ${grant.label}${lite}`);
    lines.push(`  命令：adb -s ${serial} shell ${(grant.argv || []).join(' ')}`);
    lines.push(`  校验：adb -s ${serial} shell ${(grant.verifyArgv || []).join(' ')}`);
    lines.push(`  期望输出包含：${grant.expectIncludes || ''}`);
    lines.push(`  为什么：${grant.why || ''}`);
  }
  return lines.join('\n');
}

/**
 * confirm 门未通过时的计划回显。绝不执行，只把要动什么讲清楚。
 * @param {{plan?:object, message?:string, warning?:string}} input
 * @returns {string}
 */
function renderCallPlanText(input = {}) {
  const plan = _isPlainObject(input.plan) ? input.plan : {};
  const lines = [];
  lines.push(input.message || '这一步会改变你手机的状态，确认后加 --confirm 再执行。');
  lines.push(`  工具：${plan.bridgeName || '未知'}`);
  lines.push(`  端点：${plan.endpoint || '未知'}`);
  lines.push(`  参数：${JSON.stringify(plan.args || {})}`);
  lines.push(`  档位：${plan.tier || '未知'}（${plan.access || '未知'}）`);
  if (input.warning) {
    lines.push(`  注意：${input.warning}`);
  }
  return lines.join('\n');
}

/**
 * 桥返回体回显。过 redactSecrets：命令行是人看的出口，同样受 R2 约束。
 *
 * HTTP 主通道给的是整形后的结果对象本身（client._shapeResult 的返回值），信箱
 * 兜底给的是 `{ result }` 包一层的形状——两种都由调用方拆成 `body` 再传进来，
 * 本叶子不猜通道差异。
 * @param {{tool?:string, channel?:string, truncated?:boolean, body?:unknown}} input
 * @returns {string}
 */
function renderCallResultText(input = {}) {
  const body = _isPlainObject(input.body) ? input.body : {};
  // success 是给调用方的判据，不是给用户看的桥返回内容。
  const printable = { ...body };
  delete printable.success;
  const raw = JSON.stringify(printable);
  const safe = redactSecrets(raw === '{}' ? '' : raw);
  const clipped = safe.length > MAX_ECHO_CHARS ? `${safe.slice(0, MAX_ECHO_CHARS)}…（已截断）` : safe;
  const lines = [`工具：${input.tool || body.tool || '未知'}，通道：${input.channel || '未知'}`];
  if (input.truncated === true) {
    lines.push('桥侧已按结果上限截断。');
  }
  lines.push(clipped || '（无返回体）');
  return lines.join('\n');
}

module.exports = {
  ACTIONS,
  CHANNELS,
  DEFAULT_ACTION,
  DEFAULT_CHANNEL,
  MAX_ECHO_CHARS,
  normalizeChannel,
  parseCallArgs,
  parsePhoneArgv,
  renderPhoneHelp,
  renderStatusText,
  renderToolListText,
  renderChainText,
  renderSetupText,
  renderCallPlanText,
  renderCallResultText,
};
