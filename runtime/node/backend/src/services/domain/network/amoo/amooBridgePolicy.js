'use strict';

/**
 * amooBridgePolicy.js — pure leaf: what the Amoo bridge is allowed to do, and the
 * exact argv for every adb/bridge operation.
 *
 * WHY here: the installed StepBridge artifact is the **lite** build — it exposes
 * 22 tools and NO UI automation at all (ui_dump / ui_tap / ui_swipe / shot_b64
 * all answer `unknown tool`; the APK manifest declares no accessibility
 * service). Every screen read and every tap therefore goes through **PC-side
 * adb shell** (`uiautomator dump`, `input tap`, `input keyevent`), which runs as
 * the shell uid and does work. This leaf is where that split is encoded, so the
 * allow-list can be asserted without a phone attached.
 *
 * Two more measured constraints baked in as policy, not folklore:
 *   - `adb pair` must NEVER be issued: 33743 is the wireless-debug CONNECT port,
 *     not a pairing port. `pair` there fails with a protocol fault.
 *   - The bridge's only reliable revival is `monkey -p <pkg> -c
 *     android.intent.category.LAUNCHER 1`. `am start -n .../.MainActivity` is
 *     swallowed by a stale AMS top-most record and `am start-service` is refused
 *     (BridgeService is exported=false).
 *
 * Contract: zero IO, deterministic, never throws.
 *
 * @module services/domain/network/amoo/amooBridgePolicy
 */

// Tool inventory of the installed lite build (Tools.NAMES in the APK source).
// `exec` and `rm` are the only two that can destroy state, so they carry
// `requiresConfirm`.
const BRIDGE_TOOLS = Object.freeze({
  ping: { risk: 'low', readOnly: true, requiresConfirm: false, args: {} },
  info: { risk: 'low', readOnly: true, requiresConfirm: false, args: {} },
  ls: {
    risk: 'low',
    readOnly: true,
    requiresConfirm: false,
    // 必填性对齐手机原生 `Tools.ls`（Tools.java:873）：
    // `a.optString("path", "/sdcard")` —— **path 有默认值**，故不该声明为必填。
    // 原实现把 path 标成必填，于是「列默认目录」会被 PC 侧拒掉。
    args: { path: { type: 'string', required: false, maxLen: 512 } },
  },
  read: {
    risk: 'low',
    readOnly: true,
    requiresConfirm: false,
    args: {
      path: { type: 'string', required: true, maxLen: 512 },
      max: { type: 'integer', required: false, max: 200000 },
    },
  },
  stat: {
    risk: 'low',
    readOnly: true,
    requiresConfirm: false,
    args: { path: { type: 'string', required: true, maxLen: 512 } },
  },
  list_apps: { risk: 'low', readOnly: true, requiresConfirm: false, args: {} },
  battery: { risk: 'low', readOnly: true, requiresConfirm: false, args: {} },
  clipboard: {
    risk: 'medium',
    readOnly: false,
    requiresConfirm: false,
    // 必填性对齐手机原生 `Tools.clipboard`（Tools.java:529）：
    // `a.optString("op", "get")` —— **op 有默认值 get**，故不该声明为必填。
    // 原实现把 op 标成必填，于是「只读剪贴板」不传 op 会被 PC 侧拒掉。
    args: {
      op: { type: 'string', required: false, allowed: ['get', 'set'], maxLen: 8 },
      text: { type: 'string', required: false, maxLen: 20000 },
    },
  },
  write: {
    risk: 'medium',
    readOnly: false,
    requiresConfirm: false,
    // 参数名对齐手机原生 `Tools.write`（Tools.java:944-951）：原生读的是
    // `content` 与 `append`，**不是** `text`。原来这里声明 `text`，
    // 于是 evaluateBridgeCall 会拒掉手机原生的真实参数名（`content` 必填），
    // 而 `text` 到了手机侧根本没人读——这是一条必然失败的调用路径。
    args: {
      path: { type: 'string', required: true, maxLen: 512 },
      content: { type: 'string', required: false, maxLen: 200000 },
      append: { type: 'boolean', required: false },
    },
  },
  mkdir: {
    risk: 'medium',
    readOnly: false,
    requiresConfirm: false,
    args: { path: { type: 'string', required: true, maxLen: 512 } },
  },
  mv: {
    risk: 'medium',
    readOnly: false,
    requiresConfirm: false,
    args: {
      path: { type: 'string', required: true, maxLen: 512 },
      dest: { type: 'string', required: true, maxLen: 512 },
    },
  },
  cp: {
    risk: 'medium',
    readOnly: false,
    requiresConfirm: false,
    args: {
      path: { type: 'string', required: true, maxLen: 512 },
      dest: { type: 'string', required: true, maxLen: 512 },
    },
  },
  rm: {
    risk: 'high',
    readOnly: false,
    requiresConfirm: true,
    args: {
      path: { type: 'string', required: true, maxLen: 512 },
      recursive: { type: 'boolean', required: false },
    },
  },
  exec: {
    risk: 'high',
    readOnly: false,
    requiresConfirm: true,
    // NOTE: the bridge's exec timeout is ineffective for commands that hold
    // stdout open (`sleep 300` never trips it) and one hung exec freezes the
    // whole file mailbox. HTTP /call is unaffected (thread per connection).
    args: {
      cmd: { type: 'string', required: true, maxLen: 2000 },
      timeout: { type: 'integer', required: false, min: 1, max: 120 },
    },
  },
  start_app: {
    risk: 'medium',
    readOnly: false,
    requiresConfirm: false,
    // 参数集对齐手机原生 `Tools.startApp`（Tools.java:587-600）与桥目录
    // `phone_start_app`：原生认 package / component / extras / action / uri。
    // 原实现只声明了 package+component，漏掉 action/extras/uri——那三个参数
    // 在手机侧被接受，但 PC 侧策略会当「未知参数」拒掉。
    // `package` 必填：原生走 `getLaunchIntentForPackage(pkg)`，缺包名起不来。
    args: {
      package: { type: 'string', required: true, maxLen: 256 },
      component: { type: 'string', required: false, maxLen: 256 },
      extras: { type: 'object', required: false },
      action: { type: 'string', required: false, maxLen: 512 },
      uri: { type: 'string', required: false, maxLen: 2048 },
    },
  },
  open_url: {
    risk: 'medium',
    readOnly: false,
    requiresConfirm: false,
    args: { url: { type: 'string', required: true, maxLen: 2048 } },
  },
  share_text: {
    risk: 'medium',
    readOnly: false,
    requiresConfirm: false,
    args: {
      text: { type: 'string', required: true, maxLen: 20000 },
      title: { type: 'string', required: false, maxLen: 128 },
    },
  },
  toast: {
    risk: 'low',
    readOnly: false,
    requiresConfirm: false,
    args: { text: { type: 'string', required: true, maxLen: 512 } },
  },
  notify: {
    risk: 'low',
    readOnly: false,
    requiresConfirm: false,
    // 必填性对齐手机原生 `Tools.notify`（Tools.java:548）：
    // `a.optString("title", "khy-os 桥")` 与 `a.optString("text", "")`
    // ——**两个参数都有默认值**，故都不该声明为必填。
    // 原实现把 title/text 都标成必填，于是「只发正文」这种最常见的
    // 通知调用会被 PC 侧策略拒掉，而手机侧本来是能跑的。
    args: {
      title: { type: 'string', required: false, maxLen: 128 },
      text: { type: 'string', required: false, maxLen: 1024 },
    },
  },
  volume: {
    risk: 'low',
    readOnly: false,
    requiresConfirm: false,
    // 参数名对齐手机原生 `Tools.volume`（Tools.java:835）：原生读 `level`。
    // 原实现写成 `value`——`value` 到了手机侧没人读，音量**静默不变**
    // （比报错更坏：调用方以为调成功了）。注意与 `brightness` 区分：
    // 亮度原生确实读 `value`（:849），音量读 `level`。
    // 类型对齐原生 `a.optInt`（整数），与桥目录 `phone_volume` 一致。
    args: { level: { type: 'integer', required: false, min: 0, max: 100 } },
  },
  brightness: {
    risk: 'low',
    readOnly: false,
    requiresConfirm: false,
    // 类型对齐原生 `a.optInt`（Tools.java:849），与桥目录 `phone_brightness` 一致。
    args: { value: { type: 'integer', required: false, min: 0, max: 255 } },
  },
  vibrate: {
    risk: 'low',
    readOnly: false,
    requiresConfirm: false,
    // 类型对齐原生 `a.optInt`（Tools.java:557），与桥目录 `phone_vibrate` 一致。
    args: { ms: { type: 'integer', required: false, min: 1, max: 60000 } },
  },
});

const KEY_EVENT_PASTE = 279; // KEYCODE_PASTE — the only CJK-safe text route.
const KEY_EVENT_ENTER = 66; // KEYCODE_ENTER
const KEY_EVENT_DEL = 67; // KEYCODE_DEL

/**
 * Validate one bridge call. Pure: the answer must be identical with or without
 * a phone on the other end.
 * @param {{tool:string, args?:object, confirm?:boolean}} request
 * @returns {{ok:true, tool:string, args:object, risk:string, readOnly:boolean,
 *            requiresConfirm:boolean, willExecute:boolean}
 *          |{ok:false, code:string, message:string}}
 */
function evaluateBridgeCall(request = {}) {
  const tool = typeof request.tool === 'string' ? request.tool.trim() : '';
  const spec = BRIDGE_TOOLS[tool];
  if (!spec) {
    return {
      ok: false,
      code: 'tool_not_allowed',
      message: `桥工具不在允许清单：${tool || '(空)'}。可用：${Object.keys(BRIDGE_TOOLS).join('、')}`,
    };
  }
  const args = request.args && typeof request.args === 'object' ? request.args : {};
  // 未知参数**必须拒掉**，不能放行。
  //
  // WHY：手机原生按固定名字取参（`a.optString("content","")`、
  // `a.optInt("level")`），PC 侧放行一个原生不认的名字，参数会在手机侧
  // 被**静默丢弃**——调用方以为写成功了，其实：
  //   - `write` 传 `text` → 原生读不到 content → **用空串覆盖目标文件**（数据丢失）；
  //   - `volume` 传 `value` → 原生读不到 level → **音量静默不变**（比报错更坏）。
  // phone-bridge 侧策略早有同一条判据（phoneBridgePolicy.js:229-231
  // 「工具 X 不接受参数 Y」），此处对齐。
  const declared = spec.args || {};
  for (const name of Object.keys(args)) {
    if (!declared[name]) {
      return {
        ok: false,
        code: 'arg_unknown',
        message: `工具 ${tool} 不接受参数 ${name}（可用：${Object.keys(declared).join('、') || '无'}）`,
      };
    }
  }
  for (const [name, rule] of Object.entries(declared)) {
    const present = args[name] !== undefined && args[name] !== null;
    if (rule.required && !present) {
      return { ok: false, code: 'arg_required', message: `缺少参数 ${name}` };
    }
    if (!present) {
      continue;
    }
    const value = args[name];
    if (rule.type === 'string') {
      if (typeof value !== 'string') {
        return { ok: false, code: 'arg_type', message: `参数 ${name} 必须是字符串` };
      }
      if (rule.maxLen && value.length > rule.maxLen) {
        return {
          ok: false,
          code: 'arg_too_long',
          message: `参数 ${name} 超过 ${rule.maxLen} 字（实测 ${value.length} 字）`,
        };
      }
      if (rule.allowed && !rule.allowed.includes(value)) {
        return {
          ok: false,
          code: 'arg_not_allowed',
          message: `参数 ${name} 只能是 ${rule.allowed.join(' / ')}`,
        };
      }
    } else if (rule.type === 'number' || rule.type === 'integer') {
      const num = Number(value);
      if (!Number.isFinite(num)) {
        return { ok: false, code: 'arg_type', message: `参数 ${name} 必须是数字` };
      }
      // integer 档必须是整数：原生取参用的是 optInt，传 1.5 会被原生截断
      // （或取整），那等于「调用方以为设了 1.5，实际设了 1」。
      if (rule.type === 'integer' && !Number.isInteger(num)) {
        return { ok: false, code: 'arg_type', message: `参数 ${name} 必须是整数` };
      }
      if (rule.min !== undefined && num < rule.min) {
        return { ok: false, code: 'arg_range', message: `参数 ${name} 不得小于 ${rule.min}` };
      }
      if (rule.max !== undefined && num > rule.max) {
        return { ok: false, code: 'arg_range', message: `参数 ${name} 不得大于 ${rule.max}` };
      }
    } else if (rule.type === 'boolean' && typeof value !== 'boolean') {
      return { ok: false, code: 'arg_type', message: `参数 ${name} 必须是布尔值` };
    }
  }
  const willExecute = !spec.requiresConfirm || request.confirm === true;
  return {
    ok: true,
    tool,
    args,
    risk: spec.risk,
    readOnly: spec.readOnly,
    requiresConfirm: spec.requiresConfirm,
    willExecute,
  };
}

// ── adb argv builders ───────────────────────────────────────────────────────
// Every builder returns a fresh array. Callers spawn with argv only — never a
// shell string — so no argument can be re-parsed by a shell.

function buildConnectArgv(host, port) {
  return ['connect', `${host}:${port}`];
}

function buildDevicesArgv() {
  return ['devices'];
}

function buildForwardArgv(serial, localPort, remotePort) {
  return ['-s', serial, 'forward', `tcp:${localPort}`, `tcp:${remotePort}`];
}

function buildForwardListArgv(serial) {
  return ['-s', serial, 'forward', '--list'];
}

function buildForwardRemoveArgv(serial, localPort) {
  return ['-s', serial, 'forward', '--remove', `tcp:${localPort}`];
}

function buildShellArgv(serial, command) {
  return ['-s', serial, 'shell', command];
}

function buildLaunchAmooArgv(serial, component, action) {
  return ['-s', serial, 'shell', 'am', 'start', '-n', component, '-a', action];
}

function buildTapArgv(serial, x, y) {
  return ['-s', serial, 'shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))];
}

function buildKeyEventArgv(serial, code) {
  return ['-s', serial, 'shell', 'input', 'keyevent', String(code)];
}

function buildUiDumpArgv(serial, remotePath) {
  return ['-s', serial, 'shell', 'uiautomator', 'dump', remotePath];
}

function buildPullArgv(serial, remotePath, localPath) {
  return ['-s', serial, 'pull', remotePath, localPath];
}

function buildPushArgv(serial, localPath, remotePath) {
  return ['-s', serial, 'push', localPath, remotePath];
}

function buildRemoveArgv(serial, remotePath) {
  return ['-s', serial, 'shell', 'rm', '-f', remotePath];
}

function buildTokenReadArgv(serial, tokenPath) {
  return ['-s', serial, 'shell', 'cat', tokenPath];
}

/**
 * The only bridge revival that works on this ROM.
 *
 * `-s <serial>` is NOT optional: Android 11+ wireless debugging also registers an
 * mDNS/TLS entry for the same phone (`adb-<serial>._adb-tls-connect._tcp`), so
 * `adb devices` legitimately lists TWO devices for one handset. Any command
 * without `-s` then dies with "more than one device/emulator" — which is exactly
 * how a missing serial here was found.
 *
 * `am start -n .../.MainActivity` is swallowed by a stale AMS top-most record and
 * `am start-service` is refused (BridgeService is exported=false), so monkey is
 * the only working route — and it works even when the process is still alive but
 * its HTTP thread has wedged.
 * @param {string} serial
 * @param {string} pkg
 * @returns {string[]}
 */
function buildRecoverBridgeArgv(serial, pkg) {
  // 桥并入 khy-os App 后首选导出广播（com.khyos.khy_os_client.bridge.REVIVE）：
  // 不起界面、不依赖 AMS 的 top-most 记录。monkey 是独立 APK 时代的唯一活路。
  return [
    '-s', serial, 'shell', 'am', 'broadcast',
    '-a', 'com.khyos.khy_os_client.bridge.REVIVE',
    '-n', `${pkg}/com.khyos.khy_os_client.bridge.ReviveReceiver`,
  ];
}

/**
 * Parse `adb devices` output.
 *
 * The serial is captured greedily and the state is anchored at end-of-line:
 * wireless-debugging mDNS/TLS serials legitimately contain a SPACE, e.g.
 *   adb-ZYPZ261A01M6870010L-R9QdlL (2)._adb-tls-connect._tcp<TAB>device
 * The previous `^(\S+)\s+` form stopped at that space and silently truncated the
 * serial, so classifyDeviceList could never match it and every call reported
 * device_absent even though `adb -s '<full serial>'` worked fine. adb separates
 * the two fields with a TAB, and greedy `.+` plus an anchored state copes with
 * both TAB- and space-separated output.
 *
 * @param {string} stdout
 * @returns {{serial:string, state:string}[]}
 */
function parseDeviceList(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const match = line.trim().match(/^(.+)\s+(device|unauthorized|offline|bootloader|recovery|host|no permissions)$/i);
    if (match) {
      out.push({ serial: match[1], state: match[2].toLowerCase() });
    }
  }
  return out;
}

/**
 * Decide whether the target device is reachable.
 * @param {string} stdout
 * @param {string} serial
 * @returns {{connected:boolean, entries:object[], reason:string|null}}
 */
function classifyDeviceList(stdout, serial) {
  const entries = parseDeviceList(stdout);
  const hit = entries.find((entry) => entry.serial === serial);
  if (!hit) {
    return { connected: false, entries, reason: 'device_absent' };
  }
  if (hit.state !== 'device') {
    return { connected: false, entries, reason: `device_${hit.state}` };
  }
  return { connected: true, entries, reason: null };
}

/**
 * Parse the bridge `status.json` heartbeat file content.
 * @param {string} raw
 * @returns {{running:boolean, pid:number|null, httpPort:number|null,
 *            mode:string|null, canWrite:boolean, tools:number|null, stale:boolean}}
 */
function parseBridgeStatus(raw, { nowMs = Date.now(), staleAfterMs = 15000 } = {}) {
  let parsed = null;
  try {
    parsed = JSON.parse(String(raw || ''));
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return {
      running: false,
      pid: null,
      httpPort: null,
      mode: null,
      canWrite: false,
      tools: null,
      stale: true,
    };
  }
  const ts = Number(parsed.ts);
  const ageMs = Number.isFinite(ts) ? Math.max(0, nowMs - ts) : Number.POSITIVE_INFINITY;
  return {
    running: parsed.running === true,
    pid: Number.isFinite(Number(parsed.pid)) ? Number(parsed.pid) : null,
    httpPort: Number.isFinite(Number(parsed.http_port)) ? Number(parsed.http_port) : null,
    mode: typeof parsed.mode === 'string' ? parsed.mode : null,
    canWrite: parsed.canWrite === true,
    tools: Number.isFinite(Number(parsed.tools)) ? Number(parsed.tools) : null,
    stale: ageMs > staleAfterMs,
  };
}

/**
 * Normalise a bearer token: 32-hex in practice, but accept any non-empty
 * printable run. The token is a secret — callers must never log the return.
 * @param {string} raw
 * @returns {{ok:boolean, token:string|null, reason:string|null}}
 */
function normalizeBridgeToken(raw) {
  const token = String(raw || '').trim();
  if (!token) {
    return { ok: false, token: null, reason: 'token_empty' };
  }
  if (token.length < 8) {
    return { ok: false, token: null, reason: 'token_too_short' };
  }
  if (!/^[\w-]+$/.test(token)) {
    return { ok: false, token: null, reason: 'token_malformed' };
  }
  return { ok: true, token, reason: null };
}

/**
 * Redact a token for any user-facing path.
 * @param {string|null} token
 * @returns {string}
 */
function maskToken(token) {
  const value = String(token || '');
  if (value.length <= 8) {
    return '****';
  }
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/**
 * Escape a payload for `adb shell input text '...'`.
 *
 * The command string is one argv element handed to the DEVICE shell, so it is
 * quoted there and only there: single quotes are closed and reopened
 * POSIX-style, and everything else (spaces, CJK, punctuation) is passed through
 * untouched. `input text` itself still refuses non-ASCII on most builds — that
 * is why the clipboard route exists.
 * @param {string} text
 * @returns {string}
 */
function escapeForDeviceShell(text) {
  const value = typeof text === 'string' ? text : '';
  return `'${value.replace(/'/g, "'\\''")}'`;
}

module.exports = {
  BRIDGE_TOOLS,
  KEY_EVENT_PASTE,
  KEY_EVENT_ENTER,
  KEY_EVENT_DEL,
  evaluateBridgeCall,
  buildConnectArgv,
  buildDevicesArgv,
  buildForwardArgv,
  buildForwardListArgv,
  buildForwardRemoveArgv,
  buildShellArgv,
  buildLaunchAmooArgv,
  buildTapArgv,
  buildKeyEventArgv,
  buildUiDumpArgv,
  buildPullArgv,
  buildPushArgv,
  buildRemoveArgv,
  buildTokenReadArgv,
  buildRecoverBridgeArgv,
  parseDeviceList,
  classifyDeviceList,
  parseBridgeStatus,
  normalizeBridgeToken,
  maskToken,
  escapeForDeviceShell,
};
