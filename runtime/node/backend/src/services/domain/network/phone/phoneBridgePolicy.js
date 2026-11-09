'use strict';

/**
 * phoneBridgePolicy.js — pure leaf (zero IO, deterministic, never throws).
 *
 * Every judgement the phone bridge needs before it touches the device: is this
 * tool name on the allow-list, are the args shaped right, does this call actuate
 * the phone (and therefore need an explicit confirm), how big may the result be,
 * and what exact adb argv do the four post-install grants need.
 *
 * Mirrors desktop/deviceApps/uninstallRoute.js: the decision half is a pure
 * function of its inputs, so the risk contract is assertable with no phone
 * attached. The IO shell (phoneBridgeClient) only ever executes argv this file
 * produced.
 *
 * The four grants are the ones the shipped APK exposes. The accessibility
 * grant is flagged applicableToLiteBuild:false for the lite artifact (it
 * declares no accessibility service); the v2.3.0 build ships one, and the
 * gate there is the bridge's live `ui` field — see classifyBridgeCall.
 */

const {
  ACCESS_READ,
  ACCESS_ACTUATE,
  UI_TOOL_ACCESS,
  findPhoneBridgeTool,
  isPhoneBridgeToolName,
  isPhoneBridgeUiToolName,
  resolveBridgeToolName,
  getResultCapChars,
  ACCESSIBILITY_GAP_REASON,
} = require('./phoneBridgeCatalog');

// 桥的宿主：2026-10-22 起 StepBridge 并入 khy-os 手机端（原独立 APK
// com.stepx.amoobridge 退役）。端口/信箱目录/token 文件名都没变，PC 侧配置
// 零迁移；变了的只有包名、无障碍服务类名与唤醒方式。
const BRIDGE_PACKAGE = 'com.khyos.khy_os_client';
const BRIDGE_ACCESSIBILITY_SERVICE = `${BRIDGE_PACKAGE}/.KhyAccessibilityService`;
const BRIDGE_REVIVE_ACTION = 'com.khyos.khy_os_client.bridge.REVIVE';
const BRIDGE_REVIVE_COMPONENT = `${BRIDGE_PACKAGE}/com.khyos.khy_os_client.bridge.ReviveReceiver`;
const BRIDGE_APK_NAME = 'stepx-amoo-bridge';

const ARG_TYPES = Object.freeze(['string', 'integer', 'boolean', 'object']);

// Grants, in the order a fresh install needs them. `verify` is the read-back
// command, so the caller can prove a grant instead of assuming it.
const GRANTS = Object.freeze([
  {
    id: 'manage_external_storage',
    label: '所有文件访问（MANAGE_EXTERNAL_STORAGE）',
    required: true,
    applicableToLiteBuild: true,
    argv: ['appops', 'set', BRIDGE_PACKAGE, 'MANAGE_EXTERNAL_STORAGE', 'allow'],
    verifyArgv: ['appops', 'get', BRIDGE_PACKAGE, 'MANAGE_EXTERNAL_STORAGE'],
    expectIncludes: 'allow',
    why: 'Android 11+ 上 /sdcard 不再有 requestLegacyExternalStorage 可用；不授权信箱目录不可写，token 无法持久化。',
  },
  {
    id: 'battery_optimization',
    label: '电池优化白名单（允许后台常驻）',
    required: true,
    applicableToLiteBuild: true,
    argv: ['cmd', 'deviceidle', 'whitelist', `+${BRIDGE_PACKAGE}`],
    verifyArgv: ['cmd', 'deviceidle', 'whitelist'],
    expectIncludes: BRIDGE_PACKAGE,
    why: 'Watchdog 用 setInexactRepeating，Doze 下会被批掉；不进白名单服务被杀后不会自己回来。',
  },
  {
    id: 'write_settings',
    label: '修改系统设置（WRITE_SETTINGS，可选）',
    required: false,
    applicableToLiteBuild: true,
    argv: ['appops', 'set', BRIDGE_PACKAGE, 'WRITE_SETTINGS', 'allow'],
    verifyArgv: ['appops', 'get', BRIDGE_PACKAGE, 'WRITE_SETTINGS'],
    expectIncludes: 'allow',
    why: '只有调屏幕亮度用得到；不给也能用，brightness 会返回中文权限错误。',
  },
  {
    id: 'accessibility_service',
    label: '无障碍服务（UI 自动化必需）',
    required: false,
    applicableToLiteBuild: true,
    argv: [
      'settings',
      'put',
      'secure',
      'enabled_accessibility_services',
      BRIDGE_ACCESSIBILITY_SERVICE,
    ],
    verifyArgv: ['settings', 'get', 'secure', 'enabled_accessibility_services'],
    expectIncludes: BRIDGE_PACKAGE,
    why: '桥并入 khy-os App 后由 App 既有的 KhyAccessibilityService 承接 UI 工具；不开它 ui_* 与 shot 全部不可用（/status 的 ui 恒 false）。',
  },
  {
    id: 'usb_install_permission',
    label: 'USB 安装按包授权（安装前置条件）',
    required: false,
    applicableToLiteBuild: true,
    argv: [
      'settings',
      'put',
      'secure',
      `usb_install_item_${BRIDGE_PACKAGE}`,
      `${BRIDGE_APK_NAME}:1`,
    ],
    verifyArgv: ['settings', 'get', 'secure', `usb_install_item_${BRIDGE_PACKAGE}`],
    expectIncludes: ':1',
    why: 'StepOS/MIUI 派生的「USB 安装」按包授权；安装失败后系统会写下 :0 记录，不改回 :1 同一个包永远装不上。',
  },
]);

function _isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function _badArg(argName, message) {
  return { ok: false, error: `参数 ${argName} ${message}` };
}

/**
 * Device-side path guard. adb shell is a shell: a newline or a NUL in a path is
 * not a typo, it is command injection into the phone's /system/bin/sh.
 */
function validateDevicePath(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, error: '必须是非空字符串' };
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith('/')) {
    return { ok: false, error: '必须是设备上的绝对路径（以 / 开头）' };
  }
  if (/[\0\n\r]/.test(trimmed)) {
    return { ok: false, error: '含有换行或空字符，不能作为 shell 参数' };
  }
  if (/\s/.test(trimmed)) {
    return { ok: false, error: '含有空白字符，请先转义或换一个路径' };
  }
  return { ok: true, value: trimmed };
}

function _validateStringArg(argName, spec, value) {
  if (typeof value !== 'string') {
    return _badArg(argName, '必须是字符串');
  }
  if (Number.isFinite(spec.maxLength) && value.length > spec.maxLength) {
    return _badArg(argName, `长度 ${value.length} 超出上限 ${spec.maxLength}`);
  }
  if (spec.enum && !spec.enum.includes(value)) {
    return _badArg(argName, `必须是 ${spec.enum.join(' / ')} 之一`);
  }
  return { ok: true, value };
}

function _validateIntegerArg(argName, spec, value) {
  // 数值型字符串被归一成整数：JSON 体与命令行来的值常是字符串。
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(parsed)) {
    return _badArg(argName, '必须是整数');
  }
  if (Number.isFinite(spec.minimum) && parsed < spec.minimum) {
    return _badArg(argName, `不得小于 ${spec.minimum}`);
  }
  if (Number.isFinite(spec.maximum) && parsed > spec.maximum) {
    return _badArg(argName, `不得大于 ${spec.maximum}`);
  }
  return { ok: true, value: parsed };
}

function _validateBooleanArg(argName, value) {
  if (typeof value !== 'boolean') {
    return _badArg(argName, '必须是布尔值');
  }
  return { ok: true, value };
}

function _validateObjectArg(argName, value) {
  if (!_isPlainObject(value)) {
    return _badArg(argName, '必须是对象');
  }
  return { ok: true, value };
}

function _validateArgValue(argName, spec, value) {
  if (value === undefined || value === null) {
    return spec.required ? _badArg(argName, '是必填项') : { ok: true, value: undefined };
  }
  switch (spec.type) {
    case 'string':
      return _validateStringArg(argName, spec, value);
    case 'integer':
      return _validateIntegerArg(argName, spec, value);
    case 'boolean':
      return _validateBooleanArg(argName, value);
    case 'object':
      return _validateObjectArg(argName, value);
    default:
      return _badArg(argName, `类型 ${String(spec.type)} 未被桥接契约支持`);
  }
}

const PATH_ARGS = Object.freeze({
  ls: ['path'],
  read: ['path'],
  write: ['path'],
  mkdir: ['path'],
  rm: ['path'],
  mv: ['path', 'dest'],
  cp: ['path', 'dest'],
  stat: ['path'],
});

/**
 * Full arg validation for one bridge tool. Unknown args are rejected rather
 * than dropped: silently discarding an arg is how "I asked for recursive and
 * got a bare rm" happens.
 */
function validateBridgeArgs(toolName, args) {
  const hit = findPhoneBridgeTool(toolName);
  if (!hit) {
    return { ok: false, error: `桥接工具不存在：${String(toolName || '(空)')}`, unknownTool: true };
  }
  const params = _isPlainObject(args) ? args : {};
  const specs = hit.args || {};
  const pathArgs = PATH_ARGS[hit.bridgeName] || [];
  const normalized = {};

  for (const [argName, value] of Object.entries(params)) {
    const spec = specs[argName];
    if (!spec) {
      return { ok: false, error: `工具 ${hit.bridgeName} 不接受参数 ${argName}` };
    }
    const checked = _validateArgValue(argName, spec, value);
    if (!checked.ok) {
      return checked;
    }
    if (checked.value !== undefined) {
      normalized[argName] = checked.value;
    }
  }

  for (const argName of Object.keys(specs)) {
    if (specs[argName].required && normalized[argName] === undefined) {
      return _badArg(argName, '是必填项');
    }
  }

  for (const argName of pathArgs) {
    if (normalized[argName] === undefined) {
      continue;
    }
    const pathCheck = validateDevicePath(normalized[argName]);
    if (!pathCheck.ok) {
      return { ok: false, error: `参数 ${argName} ${pathCheck.error}` };
    }
    normalized[argName] = pathCheck.value;
  }

  return { ok: true, bridgeName: hit.bridgeName, khyName: hit.khyName, args: normalized };
}

/**
 * v2.3.0 起 UI 工具的准入判据：桥自己在 /status 与 ping 里回报的 ui 字段
 * （lite 包恒 false；v2 包装了无障碍服务并授权后为 true）。默认拿不到 ui
 * 状态一律拒绝——宁可误拒，也不把「需要无障碍」说成成功。读/执行分级见
 * catalog 的 UI_TOOL_ACCESS（工具清单与分级同属工具真相，policy 只消费）。
 */
function classifyBridgeCall(toolName, args = {}, opts = {}) {
  if (isPhoneBridgeUiToolName(toolName)) {
    if (opts.uiAvailable !== true) {
      return {
        ok: false,
        code: 'ui_tool_unavailable',
        error: `桥接工具 ${toolName} 需要无障碍权限，当前桥未报告 UI 能力`,
        detail: ACCESSIBILITY_GAP_REASON,
        requiresAccessibility: true,
      };
    }
    const access = UI_TOOL_ACCESS[toolName] === ACCESS_ACTUATE ? ACCESS_ACTUATE : ACCESS_READ;
    return {
      ok: true,
      bridgeName: toolName,
      khyName: toolName,
      args,
      access,
      tier: access === ACCESS_ACTUATE ? 'high' : 'medium',
      requiresConfirm: access === ACCESS_ACTUATE,
      requiresAccessibility: true,
      // Floor for fields with no per-field exemption. Without it this is
      // undefined and _shapeResult falls back to the 8000-char default, which
      // shreds shot_b64's base64. The field-level whitelist in the catalog
      // overrides this where it matters; this line only stops the silent
      // fallback for everything else.
      resultCapChars: 400000,
    };
  }
  const validation = validateBridgeArgs(toolName, args);
  if (!validation.ok) {
    return {
      ok: false,
      code: validation.unknownTool ? 'unknown_tool' : 'invalid_args',
      error: validation.error,
    };
  }
  const hit = findPhoneBridgeTool(toolName);
  const access = hit.accessDependsOnOp
    ? _resolveOpDependentAccess(hit, validation.args)
    : hit.access;
  return {
    ok: true,
    bridgeName: hit.bridgeName,
    khyName: hit.khyName,
    access,
    tier: hit.dangerous ? 'critical' : access === ACCESS_ACTUATE ? 'high' : 'medium',
    requiresConfirm: access === ACCESS_ACTUATE,
    args: validation.args,
    resultCapChars: getResultCapChars(hit.bridgeName),
    warning: hit.dangerous
      ? `${hit.bridgeName} 的 recursive 参数默认为 false：删除整棵目录树必须显式传 recursive: true。`
      : null,
  };
}

function _resolveOpDependentAccess(hit, args) {
  if (hit.bridgeName === 'clipboard') {
    return String(args.op || 'get').toLowerCase() === 'set' ? ACCESS_ACTUATE : ACCESS_READ;
  }
  return args.level !== undefined || args.value !== undefined ? ACCESS_ACTUATE : ACCESS_READ;
}

/**
 * The plan returned when a call actuates the phone but carries no
 * confirm:true. Nothing is executed — the caller gets argv-level detail so a
 * human can approve a specific action rather than a vague intent.
 */
function planBridgeCall({ tool, args, baseUrl, uiAvailable } = {}) {
  const classified = classifyBridgeCall(tool, args, { uiAvailable });
  if (!classified.ok) {
    return { success: false, error: classified.error, code: classified.code };
  }
  if (!classified.requiresConfirm) {
    return { success: true, requiresConfirm: false, classification: classified };
  }
  return {
    success: true,
    requiresConfirm: true,
    code: 'requires_confirm',
    plan: {
      bridgeName: classified.bridgeName,
      endpoint: baseUrl ? `${baseUrl}/call` : '/call',
      args: classified.args,
      access: classified.access,
      tier: classified.tier,
    },
    message: `将在手机上执行 ${classified.bridgeName}（${_accessLabel(classified.access)}）。`
      + '这会改变你手机的状态。确认后重发并带 confirm:true 才会真正执行。',
    warning: classified.warning,
  };
}

function _accessLabel(access) {
  return access === ACCESS_ACTUATE ? '写操作' : '只读';
}

function listGrants({ includeOptional = true } = {}) {
  return GRANTS.filter((grant) => (includeOptional ? true : grant.required)).map((grant) => ({
    id: grant.id,
    label: grant.label,
    required: grant.required,
    applicableToLiteBuild: grant.applicableToLiteBuild,
    argv: grant.argv.slice(),
    verifyArgv: grant.verifyArgv.slice(),
    expectIncludes: grant.expectIncludes,
    why: grant.why,
  }));
}

function findGrant(grantId) {
  const hit = GRANTS.find((grant) => grant.id === grantId);
  if (!hit) {
    return null;
  }
  return {
    id: hit.id,
    label: hit.label,
    required: hit.required,
    applicableToLiteBuild: hit.applicableToLiteBuild,
    argv: hit.argv.slice(),
    verifyArgv: hit.verifyArgv.slice(),
    expectIncludes: hit.expectIncludes,
    why: hit.why,
  };
}

/**
 * Wraps a bridge-side argv (adb subcommand args) into a full adb invocation.
 * argv only — never a shell string, so nothing in a device path can be
 * reinterpreted by the PC's shell.
 */
function buildAdbArgv(config, args = []) {
  const parts = Array.isArray(args) ? args.map((value) => String(value)) : [];
  const serial = config && config.serial ? String(config.serial) : '';
  return serial ? ['-s', serial, ...parts] : parts;
}

/**
 * Recovery: the bridge does not come back on its own. am start is swallowed by
 * a stale AMS top-most record, am start-service is refused (exported=false),
 * so the only measured way back is the launcher monkey event.
 */
function buildReviveArgv(config) {
  // v2.3.0 起（桥并入 khy-os App）首选导出广播：不起界面、不依赖 AMS 的
  // top-most 记录。monkey 是独立 APK 时代的唯一活路，留作兜底注释。
  return buildAdbArgv(config, [
    'shell',
    'am',
    'broadcast',
    '-a',
    BRIDGE_REVIVE_ACTION,
    '-n',
    BRIDGE_REVIVE_COMPONENT,
  ]);
}

function buildConnectArgv(config) {
  return buildAdbArgv(config, ['connect', String((config && config.serial) || '')]);
}

function buildForwardArgv(config, localPort, remotePort) {
  return buildAdbArgv(config, [
    'forward',
    `tcp:${Number(localPort)}`,
    `tcp:${Number(remotePort)}`,
  ]);
}

function buildTokenReadArgv(config, tokenRemotePath) {
  return buildAdbArgv(config, ['shell', 'cat', String(tokenRemotePath || '')]);
}

function buildStatusReadArgv(config, statusRemotePath) {
  return buildAdbArgv(config, ['shell', 'cat', String(statusRemotePath || '')]);
}

/**
 * 设备文件大小（字节）。拉取前先问一次体积，好过拉到一半才发现超限。
 * 用 wc -c 而不是 stat：toybox 的 stat 在老版本上并不总在。
 */
function buildSizeArgv(config, remotePath) {
  return buildAdbArgv(config, ['shell', 'wc', '-c', String(remotePath || '')]);
}

/**
 * 一次拿到大小与修改时间（stat -c '%s %Y'）。比 wc -c 多一个字段，却不多一次
 * adb 往返——采集要按时间窗筛文件，光有大小不够。
 */
function buildStatArgv(config, remotePath) {
  return buildAdbArgv(config, ['shell', 'stat', '-c', '%s %Y', String(remotePath || '')]);
}

/** 拉取设备文件到主机。路径都是参数，不拼进命令串。 */
function buildPullArgv(config, remotePath, localPath) {
  return buildAdbArgv(config, ['pull', String(remotePath || ''), String(localPath || '')]);
}

/** 推送主机文件到设备。设备侧父目录要先建（adb push 不会替我们建）。 */
function buildPushArgv(config, localPath, remotePath) {
  return buildAdbArgv(config, ['push', String(localPath || ''), String(remotePath || '')]);
}

/** 设备侧建目录（-p 递归），供 push 用。 */
function buildMkdirArgv(config, remoteDir) {
  return buildAdbArgv(config, ['shell', 'mkdir', '-p', String(remoteDir || '')]);
}

/**
 * The token is a bearer secret. It is read from the device at call time, never
 * written into the repo, and never echoed into a tool result or a log line —
 * this function is the single choke point every return path goes through.
 */
const TOKEN_PATTERNS = Object.freeze([
  /(Authorization\s*[:=]\s*Bearer\s+)[^\s"'`]+/gi,
  /\bBearer\s+[0-9a-fA-F]{32,}\b/g,
  /\b[0-9a-fA-F]{32}\b/g,
]);

function redactSecrets(text) {
  let out = String(text ?? '');
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, (match, ...groups) => {
      if (groups.length > 0 && typeof groups[0] === 'string') {
        return `${groups[0]}***`;
      }
      return '[redacted-token]';
    });
  }
  return out;
}

function isValidTokenShape(token) {
  return typeof token === 'string' && /^[0-9a-f]{32}$/i.test(token.trim());
}

function normalizeToken(raw) {
  if (typeof raw !== 'string') {
    return '';
  }
  return raw.trim().split(/\s+/).pop() || '';
}

module.exports = {
  BRIDGE_PACKAGE,
  BRIDGE_APK_NAME,
  GRANTS,
  ARG_TYPES,
  validateBridgeArgs,
  validateDevicePath,
  classifyBridgeCall,
  planBridgeCall,
  listGrants,
  findGrant,
  buildAdbArgv,
  buildConnectArgv,
  buildForwardArgv,
  buildReviveArgv,
  buildTokenReadArgv,
  buildStatusReadArgv,
  buildSizeArgv,
  buildStatArgv,
  buildPullArgv,
  buildPushArgv,
  buildMkdirArgv,
  redactSecrets,
  isValidTokenShape,
  normalizeToken,
  isPhoneBridgeToolName,
  resolveBridgeToolName,
};
