'use strict';

/**
 * phone-tools.js — phone-side tool handlers.
 *
 * Scope:
 *   Phase 1 core: phone_screenshot, phone_ui_dump
 *   Phase 1 restricted read-only: phone_info, phone_app_list, phone_ls, phone_exec
 *   Phase 2: phone_ui_tap, phone_ui_swipe, phone_key, phone_text,
 *            phone_file_push, phone_file_pull
 *
 * Restricted vs prohibited (deliberate narrowing of the reference bridge):
 *   - phone_exec is NOT a shell. It accepts a structured {op,...} and only
 *     builds fixed diagnostic commands (echo/getprop/wm size/pm list/dumpsys
 *     battery). Unknown ops, non-whitelisted props and shell metacharacters
 *     are rejected.
 *   - phone_ls only lists an allowlist of /sdcard roots, re-checks realpath on
 *     the device and refuses traversal/symlink escapes.
 *   - phone_app_list only runs `pm list packages` and reads the foreground
 *     activity; it cannot start/stop apps.
 *   - phone_shell / phone_su / arbitrary file read/write and app control stay
 *     in PHONE_PROHIBITED_TOOLS.
 *
 * Every exported handler has the shape `(args) => Promise<{ok:true,...}>` or
 * `{ok:false,error:{code,message,details?}}`. No handler throws into its
 * caller; a process crash in a tool must not take the daemon down.
 *
 * Commands are fixed templates. User values are passed through `shQuote()`
 * before reaching the device shell; local spawn never uses a shell.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const C = require('./contracts');
const { shQuote, assertAsciiText, assertSafeRemoteName } = require('./adb');

const PHONE_PHASE1_TOOLS = Object.freeze([
  'phone_screenshot',
  'phone_ui_dump',
  'phone_info',
  'phone_app_list',
  'phone_ls',
  'phone_exec',
]);
const PHONE_PHASE2_TOOLS = Object.freeze([
  'phone_ui_tap',
  'phone_ui_swipe',
  'phone_key',
  'phone_text',
  'phone_file_push',
  'phone_file_pull',
]);

/** Read-only capabilities that are deliberately narrower than a shell. */
const PHONE_RESTRICTED_TOOLS = Object.freeze(['phone_exec', 'phone_ls', 'phone_app_list']);

/** Names that remain forbidden: arbitrary shell, root, file write, app control. */
const PHONE_PROHIBITED_TOOLS = Object.freeze([
  'phone_shell',
  'phone_su',
  'phone_read',
  'phone_write',
  'phone_app_start',
  'phone_app_stop',
  'phone_notify',
  'phone_task_send',
  'phone_task_replies',
  'phone_agent_open',
  'phone_agent_prompt',
]);

/** phone_exec ops; anything else is invalid_args. */
const PHONE_EXEC_OPS = Object.freeze(['echo', 'getprop', 'wm_size', 'pm_list', 'dumpsys_battery']);

/** Only these properties may be read through phone_exec getprop. */
const PHONE_EXEC_GETPROP_KEYS = Object.freeze([
  'ro.product.model',
  'ro.product.brand',
  'ro.product.device',
  'ro.product.manufacturer',
  'ro.build.version.sdk',
  'ro.build.version.release',
  'ro.build.display.id',
  'ro.serialno',
  'ro.debuggable',
]);

/** phone_ls roots (the /sdcard alias and its resolved /storage form). */
const PHONE_LS_ROOTS = Object.freeze([
  '/sdcard/khy-amoon-bridge',
  '/sdcard/Download',
  '/sdcard/Documents',
  '/sdcard/Pictures',
  '/sdcard/DCIM',
]);

const PHONE_LS_REAL_ROOTS = Object.freeze([
  '/storage/emulated/0/khy-amoon-bridge',
  '/storage/emulated/0/Download',
  '/storage/emulated/0/Documents',
  '/storage/emulated/0/Pictures',
  '/storage/emulated/0/DCIM',
  '/storage/self/primary/khy-amoon-bridge',
  '/storage/self/primary/Download',
  '/storage/self/primary/Documents',
  '/storage/self/primary/Pictures',
  '/storage/self/primary/DCIM',
]);

/** The resolved form of /sdcard may only be listed itself, never its children. */
const PHONE_LS_REAL_TOPS = Object.freeze(['/sdcard', '/storage/emulated/0', '/storage/self/primary']);

/** Shell metacharacters and control chars that must never reach a command. */
const SHELL_META_RE = /[|&;<>`$(){}\\\n\r\t'"]/;

const REMOTE_UI_DIR = '/data/local/tmp';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const KEY_WHITELIST = Object.freeze({
  HOME: 'KEYCODE_HOME',
  BACK: 'KEYCODE_BACK',
  ENTER: 'KEYCODE_ENTER',
  DEL: 'KEYCODE_DEL',
  WAKEUP: 'KEYCODE_WAKEUP',
  SLEEP: 'KEYCODE_SLEEP',
});

const BATTERY_STATUS = Object.freeze({
  1: '未知',
  2: '充电中',
  3: '放电中',
  4: '未充电',
  5: '已充满',
});

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function fail(code, message, details) {
  return new C.BridgeError(code, message, details);
}

function asObject(args) {
  if (args === undefined || args === null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw fail('invalid_args', '工具参数必须是 JSON 对象');
  }
  return args;
}

function requireString(value, name, min, max) {
  if (typeof value !== 'string' || value.length < min || value.length > max || value.includes('\u0000')) {
    throw fail('invalid_args', `${name} 必须是长度 ${min}..${max} 的字符串`);
  }
  return value;
}

function optionalInteger(value, name, min, max) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw fail('invalid_args', `${name} 必须是 ${min}..${max} 的整数`);
  }
  return number;
}

function assertAllowedKeys(args, allowed) {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw fail('invalid_args', `不支持的参数：${key}`);
  }
}

/** Reject anything that could turn a fixed template into a shell command. */
function assertNoShellMeta(value, name) {
  if (typeof value !== 'string' || SHELL_META_RE.test(value)) {
    throw fail('invalid_args', `${name} 含有不允许的 shell 元字符或控制字符`, {
      reason: 'shell_meta',
    });
  }
  return value;
}

function isUnderAnyRoot(candidate, roots) {
  return roots.some((root) => candidate === root || candidate.startsWith(`${root}/`));
}

function assertLsPathRequested(requested) {
  if (requested === '/sdcard') return requested;
  if (!isUnderAnyRoot(requested, PHONE_LS_ROOTS)) {
    throw fail('forbidden_scope', `phone_ls 只允许白名单目录：${PHONE_LS_ROOTS.join(', ')}（以及 /sdcard 顶层）`, {
      reason: 'path_not_allowlisted',
    });
  }
  return requested;
}

function assertLsPathResolved(resolved) {
  if (PHONE_LS_REAL_TOPS.includes(resolved)) return resolved;
  if (!isUnderAnyRoot(resolved, PHONE_LS_REAL_ROOTS)) {
    throw fail('forbidden_scope', `路径解析后越界或符号链接逃逸：${resolved}`, {
      reason: 'path_escape',
    });
  }
  return resolved;
}

/**
 * Parse `ls -la` output (toybox) into entries. Names with spaces are kept.
 * Unknown lines (e.g. "total 18") are skipped.
 */
function parseLsEntries(text) {
  const entries = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line || /^total\s+/i.test(line)) continue;
    const match = /^([dlbcps-][rwxstST-]{9}[.+@]?)\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.+)$/.exec(line);
    if (!match) continue;
    const kind = match[1][0];
    entries.push({
      name: match[3],
      type: kind === 'd' ? 'dir' : kind === 'l' ? 'link' : kind === '-' ? 'file' : 'other',
      mode: match[1],
      size: Number(match[2]),
    });
  }
  return entries;
}

function failureOf(err) {
  const be = C.isBridgeError(err)
    ? err
    : new C.BridgeError(
        'internal_error',
        err && err.message ? `内部错误：${String(err.message).slice(0, 300)}` : '内部错误'
      );
  return { ok: false, error: be.toJSON() };
}

function withOk(fn) {
  return async (rawArgs) => {
    try {
      return await fn(asObject(rawArgs));
    } catch (err) {
      return failureOf(err);
    }
  };
}

function tailText(value, max = 300) {
  const text = String(value || '')
    .replace(/\r/g, '')
    .trim();
  if (!text) return '';
  return text.length > max ? text.slice(-max) : text;
}

function classifyCommandFailure(result) {
  if (result && result.timedOut) return 'timeout';
  const text = `${(result && result.stderr) || ''} ${(result && result.stdout) || ''}`.toLowerCase();
  if (/no devices|device offline|device unauthorized|not found|closed|unauthorized/.test(text)) {
    return 'adb_unavailable';
  }
  return 'internal_error';
}

function parseGetprop(text) {
  const props = {};
  if (typeof text !== 'string') return props;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\[([^\]]+)\]:\s*\[(.*)\]\s*$/.exec(line.trim());
    if (match) props[match[1]] = match[2];
  }
  return props;
}

function decodeXmlEntities(value) {
  return String(value).replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (whole, entity) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        const hex = entity.toLowerCase().startsWith('#x');
        const code = Number.parseInt(entity.replace(/^#x?/i, ''), hex ? 16 : 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
    }
  });
}

function parseAttrs(text) {
  const attrs = {};
  const re = /([A-Za-z0-9:_-]+)="([^"]*)"/g;
  let match;
  while ((match = re.exec(text))) {
    attrs[match[1]] = decodeXmlEntities(match[2]);
  }
  return attrs;
}

function parseBounds(value) {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(String(value || '').trim());
  if (!match) return null;
  return {
    x1: Number(match[1]),
    y1: Number(match[2]),
    x2: Number(match[3]),
    y2: Number(match[4]),
  };
}

/**
 * Parse a uiautomator XML dump. Pure; exported for fixture tests.
 *
 * @param {string} xml
 * @param {number} [maxNodes]
 * @returns {{nodes:Array<object>, package:string|null, total:number, truncated:boolean}}
 */
function parseUiXml(xml, maxNodes = C.LIMITS.maxNodes) {
  const nodes = [];
  let total = 0;
  const packages = new Map();
  if (typeof xml !== 'string') return { nodes, package: null, total: 0, truncated: false };

  const re = /<node\b([^>]*)>/g;
  let match;
  while ((match = re.exec(xml))) {
    total += 1;
    if (nodes.length >= maxNodes) continue;
    const attrs = parseAttrs(match[1]);
    const pkg = attrs.package || '';
    if (pkg) packages.set(pkg, (packages.get(pkg) || 0) + 1);
    nodes.push({
      index: nodes.length,
      text: attrs.text || attrs['content-desc'] || '',
      rid: attrs['resource-id'] || '',
      cls: attrs.class || '',
      package: pkg,
      bounds: parseBounds(attrs.bounds),
      clickable: attrs.clickable === 'true',
      enabled: attrs.enabled !== 'false',
    });
  }

  let packageName = null;
  let best = 0;
  for (const [pkg, count] of packages.entries()) {
    if (count > best) {
      best = count;
      packageName = pkg;
    }
  }
  return { nodes, package: packageName, total, truncated: total > maxNodes };
}

function parseActivities(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  const re = /ACTIVITY\s+([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    out.push({ package: match[1], activity: match[2] });
  }
  return out;
}

function parseActivityTop(text) {
  if (typeof text !== 'string') return null;
  // Prefer the foreground record over the first ACTIVITY block: `dumpsys
  // activity top` can contain several stacked activities from other tasks.
  const direct =
    /topResumedActivity=.*?([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/.exec(text) ||
    /mResumedActivity:.*?([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/.exec(text);
  if (direct) return { package: direct[1], activity: direct[2] };
  const match = /ACTIVITY\s+([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/.exec(text);
  if (!match) return null;
  return { package: match[1], activity: match[2] };
}

/**
 * Parse the foreground activity out of `dumpsys window` when `activity top`
 * only offers a stale/stacked task.
 */
function parseForegroundActivity(text) {
  if (typeof text !== 'string') return null;
  const patterns = [
    /topResumedActivity=.*?([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/,
    /mCurrentFocus=.*?([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/,
    /mFocusedApp=.*?([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return { package: match[1], activity: match[2] };
  }
  return null;
}

function pngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (buffer.readUInt32BE(12) !== 0x49484452) return null; // "IHDR"
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function isPng(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_MAGIC);
}

function spoolDir(config) {
  const dirs = (config && config.paths && config.paths.dirs) || {};
  return path.resolve(dirs.spool || path.join(os.tmpdir(), 'khy-amoon-bridge', 'spool'));
}

function screenshotDir(config) {
  const dirs = (config && config.paths && config.paths.dirs) || {};
  return path.resolve(dirs.screenshots || path.join(spoolDir(config), 'screenshots'));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function randomSuffix() {
  return crypto.randomBytes(6).toString('hex');
}

function nowStamp(ms) {
  return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

function assertRemotePullPath(remotePath) {
  const value = requireString(remotePath, 'remote_path', 1, 512);
  if (/[\u0000-\u001f]/.test(value)) {
    throw fail('invalid_args', 'remote_path 包含控制字符');
  }
  if (!value.startsWith(`${C.REMOTE_ROOT}/`)) {
    throw fail('invalid_args', `remote_path 必须位于 ${C.REMOTE_ROOT} 之下`);
  }
  const segments = value.split('/');
  if (segments.includes('..') || segments.includes('.')) {
    throw fail('invalid_args', 'remote_path 不能包含 . 或 .. 路径段');
  }
  if (value.includes('\\') || value.includes('//')) {
    throw fail('invalid_args', 'remote_path 格式不合法');
  }
  return value;
}

function assertUnderAnyRoot(candidate, roots) {
  for (const root of roots) {
    if (candidate === root || candidate.startsWith(`${root}/`)) return true;
  }
  return false;
}

/**
 * Create the phone tool handlers.
 *
 * @param {{config?: object, adb?: object, logger?: object, clock?: ()=>number}} [ctx]
 * @returns {object} flat handlers plus `ui`/`tools` facades
 */
function createPhoneTools(ctx = {}) {
  const config = ctx.config || {};
  const adb = ctx.adb || null;
  const logger = ctx.logger || silentLogger;
  const clock = typeof ctx.clock === 'function' ? ctx.clock : Date.now;
  const maxNodes = (config.limits && config.limits.maxNodes) || C.LIMITS.maxNodes;
  const screenshotsRetainMs =
    (config.limits && config.limits.screenshotRetainMs) || C.LIMITS.screenshotRetainMs;

  let uiChain = Promise.resolve();
  let screenCache = null;
  let screenCacheAt = 0;

  function requireAdb() {
    if (!adb || typeof adb.shell !== 'function') {
      throw fail('adb_unavailable', 'ADB transport 未就绪，手机工具不可用。');
    }
    return adb;
  }

  function requireExecOut() {
    const transport = requireAdb();
    if (typeof transport.execOut !== 'function') {
      throw fail('adb_unavailable', 'ADB transport 不支持 exec-out，截图/UI 快照不可用。');
    }
    return transport;
  }

  async function runDeviceShell(command, opts = {}) {
    const result = await requireAdb().shell(command, {
      timeoutMs: opts.timeoutMs || 20000,
      maxBytes: opts.maxBytes || C.LIMITS.responseDefaultBytes,
    });
    if (result.timedOut) {
      throw fail('timeout', `手机命令超时（${opts.timeoutMs || 20000}ms）`);
    }
    if (result.exit !== 0) {
      const code = classifyCommandFailure(result);
      const detail = tailText(result.stderr) || tailText(result.stdout) || `退出码 ${result.exit}`;
      throw fail(code, `手机命令失败：${detail}`, { exit: result.exit });
    }
    if (result.truncated && !opts.allowTruncated) {
      throw fail('payload_too_large', '手机命令输出超过大小上限');
    }
    return result.stdout || '';
  }

  async function runExecOut(command, opts = {}) {
    const result = await requireExecOut().execOut(command, {
      timeoutMs: opts.timeoutMs || 20000,
      maxBytes: opts.maxBytes || C.LIMITS.responseDefaultBytes,
    });
    if (result.timedOut) {
      throw fail('timeout', `手机命令超时（${opts.timeoutMs || 20000}ms）`);
    }
    if (result.exit !== 0) {
      const code = classifyCommandFailure(result);
      const detail = tailText(result.stderr) || `退出码 ${result.exit}`;
      throw fail(code, `手机命令失败：${detail}`, { exit: result.exit });
    }
    if (result.truncated && !opts.allowTruncated) {
      throw fail('payload_too_large', '手机命令输出超过大小上限');
    }
    return result.stdout;
  }

  function assertHighRisk(tool) {
    if (config.allowHighRisk === true) return;
    throw fail(
      'invalid_config',
      `高风险工具 ${tool} 默认关闭：仅在 KHY_AMOON_ALLOW_HIGH_RISK=1 时可用。`,
      { reason: 'high_risk_disabled', tool }
    );
  }

  function withUiLock(fn) {
    const run = uiChain.then(fn, fn);
    uiChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async function getScreenSize(force = false) {
    if (!force && screenCache && clock() - screenCacheAt < 30000) return screenCache;
    try {
      const output = await runDeviceShell('wm size', { timeoutMs: 8000, maxBytes: 64 * 1024 });
      const match =
        /Override size:\s*(\d+)x(\d+)/i.exec(output) || /Physical size:\s*(\d+)x(\d+)/i.exec(output);
      screenCache = match ? { width: Number(match[1]), height: Number(match[2]) } : null;
      screenCacheAt = clock();
      return screenCache;
    } catch (err) {
      logger.warn('wm size failed', { error: String(err && err.message) });
      return null;
    }
  }

  function assertPoint(x, y, screen) {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 100000 || y > 100000) {
      throw fail('invalid_args', '坐标必须是非负整数');
    }
    if (screen && (x >= screen.width || y >= screen.height)) {
      throw fail('invalid_args', `坐标 (${x},${y}) 超出屏幕 ${screen.width}x${screen.height}`);
    }
  }

  async function dumpUiInternal() {
    const remote = `${REMOTE_UI_DIR}/khy_amoon_ui_${randomSuffix()}.xml`;
    try {
      await runDeviceShell(`uiautomator dump ${shQuote(remote)}`, {
        timeoutMs: 25000,
        maxBytes: 64 * 1024,
      });
      const result = await requireExecOut().execOut(`cat ${shQuote(remote)}`, {
        timeoutMs: 15000,
        maxBytes: 2 * 1024 * 1024,
      });
      if (result.timedOut) throw fail('timeout', '读取 UI XML 超时');
      if (result.exit !== 0) {
        throw fail('internal_error', `读取 UI XML 失败：${tailText(result.stderr) || `退出码 ${result.exit}`}`);
      }
      const xml = result.stdout.toString('utf8');
      if (!/<hierarchy\b/.test(xml)) {
        throw fail('internal_error', 'uiautomator 未返回有效的 UI XML（屏幕锁定或界面动画未结束）');
      }
      const parsed = parseUiXml(xml, maxNodes);
      return {
        ...parsed,
        xml,
        bufferTruncated: Boolean(result.truncated),
        truncated: Boolean(result.truncated) || parsed.truncated,
      };
    } finally {
      try {
        await runDeviceShell(`rm -f ${shQuote(remote)}`, { timeoutMs: 5000, maxBytes: 8192 });
      } catch {
        // Best effort cleanup; a leftover /data/local/tmp file is harmless.
      }
    }
  }

  function matchNodes(nodes, selector) {
    if (selector.rid) {
      const wanted = selector.rid;
      return nodes.filter((node) => node.rid === wanted || node.rid.endsWith(`/${wanted}`) || node.rid.endsWith(`:id/${wanted}`));
    }
    const wanted = selector.text.toLowerCase();
    const exact = nodes.filter((node) => node.text.toLowerCase() === wanted);
    if (exact.length > 0) return exact;
    return nodes.filter((node) => node.text.toLowerCase().includes(wanted));
  }

  function centerOf(node) {
    if (!node.bounds) return null;
    const { x1, y1, x2, y2 } = node.bounds;
    return { x: Math.floor((x1 + x2) / 2), y: Math.floor((y1 + y2) / 2) };
  }

  function cleanupScreenshots(dir, nowMs) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!/^shot_.*\.png$/.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const stat = fs.statSync(file);
        if (stat.isFile() && nowMs - stat.mtimeMs > screenshotsRetainMs) fs.unlinkSync(file);
      } catch {
        // best effort
      }
    }
  }

  async function phoneInfo() {
    const propText = await runDeviceShell('getprop', { timeoutMs: 10000, maxBytes: 512 * 1024 });
    const props = parseGetprop(propText);
    const serial =
      props['ro.serialno'] || (typeof adb.getSerial === 'function' ? adb.getSerial() : null) || null;

    let screen = null;
    try {
      const output = await runDeviceShell('wm size', { timeoutMs: 8000, maxBytes: 64 * 1024 });
      const match =
        /Override size:\s*(\d+)x(\d+)/i.exec(output) || /Physical size:\s*(\d+)x(\d+)/i.exec(output);
      if (match) screen = { width: Number(match[1]), height: Number(match[2]) };
    } catch {
      screen = null;
    }

    let battery = null;
    try {
      const output = await runDeviceShell('dumpsys battery', { timeoutMs: 8000, maxBytes: 256 * 1024 });
      const level = /level:\s*(\d+)/i.exec(output);
      const status = /status:\s*(\d+)/i.exec(output);
      if (level || status) {
        const statusCode = status ? Number(status[1]) : null;
        battery = {
          level: level ? Number(level[1]) : null,
          status: statusCode,
          status_label: statusCode !== null ? BATTERY_STATUS[statusCode] || '未知' : null,
        };
      }
    } catch {
      battery = null;
    }

    let wakefulness = null;
    let screenOn = null;
    try {
      const output = await runDeviceShell('dumpsys power', { timeoutMs: 8000, maxBytes: 512 * 1024 });
      const match = /mWakefulness=(\w+)/.exec(output);
      wakefulness = match ? match[1] : null;
      if (wakefulness) screenOn = wakefulness === 'Awake';
      else {
        const display = /Display Power:\s*state=(\w+)/i.exec(output);
        if (display) screenOn = display[1].toUpperCase() === 'ON';
      }
    } catch {
      wakefulness = null;
    }

    let keyguard = null;
    try {
      const output = await runDeviceShell('dumpsys window policy', { timeoutMs: 10000, maxBytes: 1024 * 1024, allowTruncated: true });
      const match =
        /isKeyguardShowing=(\w+)/i.exec(output) ||
        /mShowingLockscreen=(\w+)/i.exec(output) ||
        /mKeyguardShowing=(\w+)/i.exec(output);
      if (match) keyguard = match[1].toLowerCase() === 'true';
    } catch {
      keyguard = null;
    }

    return {
      ok: true,
      serial,
      model: props['ro.product.model'] || null,
      brand: props['ro.product.brand'] || null,
      sdk: props['ro.build.version.sdk'] ? Number(props['ro.build.version.sdk']) : null,
      release: props['ro.build.version.release'] || null,
      screen,
      battery,
      screen_on: screenOn,
      keyguard,
      wakefulness,
    };
  }

  async function phoneScreenshot(args) {
    const inline = args.inline === true;
    const buffer = await runExecOut('screencap -p', {
      timeoutMs: 30000,
      maxBytes: C.LIMITS.responseHardMaxBytes,
    });
    if (!isPng(buffer)) {
      throw fail('internal_error', 'screencap 未返回 PNG（可能是屏幕锁定或设备不支持）', {
        bytes: buffer.length,
      });
    }
    const size = pngSize(buffer);
    if (!size) {
      throw fail('internal_error', 'screencap 返回的 PNG 缺少 IHDR，拒绝保存');
    }
    const digest = crypto.createHash('sha256').update(buffer).digest('hex');
    const dir = ensureDir(screenshotDir(config));
    const file = path.join(dir, `shot_${nowStamp(clock())}_${randomSuffix()}.png`);
    fs.writeFileSync(file, buffer, { mode: 0o600 });

    const nowMs = clock();
    cleanupScreenshots(dir, nowMs);

    const descriptor = C.getTool('phone_screenshot');
    const inlineLimit = descriptor ? descriptor.responseMaxBytes : C.LIMITS.responseHardMaxBytes;
    const result = {
      ok: true,
      path: file,
      bytes: buffer.length,
      sha256: digest,
      width: size ? size.width : null,
      height: size ? size.height : null,
      truncated: false,
    };
    if (inline) {
      const encoded = buffer.toString('base64');
      if (encoded.length <= inlineLimit) {
        result.base64 = encoded;
      } else {
        result.inline_skipped = true;
        result.inline_limit = inlineLimit;
      }
    }
    return result;
  }

  /** Foreground package/activity from dumpsys window, with an activity fallback. */
  async function currentForeground() {
    try {
      const windowText = await runDeviceShell('dumpsys window', {
        timeoutMs: 8000,
        maxBytes: 512 * 1024,
        allowTruncated: true,
      });
      const parsed = parseForegroundActivity(windowText);
      if (parsed) return parsed;
    } catch {
      // fall through
    }
    try {
      const activityText = await runDeviceShell('dumpsys activity activities', {
        timeoutMs: 8000,
        maxBytes: 512 * 1024,
        allowTruncated: true,
      });
      return parseActivityTop(activityText);
    } catch {
      return null;
    }
  }

  async function phoneUiDump(args) {
    const dump = await dumpUiInternal();
    const descriptor = C.getTool('phone_ui_dump');
    const responseLimit = descriptor ? descriptor.responseMaxBytes : 1024 * 1024;

    let activity = null;
    let foreground = null;
    let topText = null;
    try {
      topText = await runDeviceShell('dumpsys activity top', {
        timeoutMs: 8000,
        maxBytes: 512 * 1024,
        allowTruncated: true,
      });
      const all = parseActivities(topText);
      // The UI dump package is the truth: pick its activity, not the first
      // stacked ACTIVITY block belonging to another task.
      if (dump.package) {
        activity = all.find((entry) => entry.package === dump.package) || null;
      } else {
        activity = parseActivityTop(topText);
      }
    } catch {
      activity = null;
    }
    if (!activity) {
      const current = await currentForeground();
      if (current) {
        if (!dump.package || current.package === dump.package) activity = current;
        else foreground = current;
      }
    }

    const result = {
      ok: true,
      package: dump.package || (activity ? activity.package : null),
      activity: activity ? `${activity.package}/${activity.activity}` : null,
      nodes: dump.nodes,
      node_count: dump.nodes.length,
      total_nodes: dump.total,
      truncated: dump.truncated,
    };
    if (foreground) {
      result.foreground = foreground;
      result.activity_note =
        '前台 activity 与 UI dump 的 package 不一致（常见于浮层/多窗口）；activity 置 null，foreground 单独给出。';
    }

    if (args.include_raw === true) {
      const bytes = Buffer.byteLength(dump.xml, 'utf8');
      if (bytes <= responseLimit) result.raw_xml = dump.xml;
      else result.raw_omitted = true;
    }
    return result;
  }

  /**
   * phone_app_list — read-only `pm list packages` + foreground activity.
   * It cannot start/stop apps.
   */
  async function phoneAppList(args) {
    const input = asObject(args);
    assertAllowedKeys(input, ['filter', 'limit']);
    const filter =
      input.filter === undefined || input.filter === null ? null : requireString(input.filter, 'filter', 1, 64);
    if (filter && !/^[A-Za-z0-9._-]+$/.test(filter)) {
      throw fail('invalid_args', 'filter 只允许字母、数字、点、下划线、连字符');
    }
    const limit = optionalInteger(input.limit, 'limit', 1, 1000) || 200;

    const raw = await runDeviceShell('pm list packages', {
      timeoutMs: 20000,
      maxBytes: 512 * 1024,
      allowTruncated: true,
    });
    let packages = String(raw)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('package:'))
      .map((line) => line.slice('package:'.length).trim())
      .filter(Boolean);
    if (filter) packages = packages.filter((name) => name.toLowerCase().includes(filter.toLowerCase()));
    packages.sort();
    const foreground = await currentForeground();
    return {
      ok: true,
      packages: packages.slice(0, limit),
      count: Math.min(packages.length, limit),
      total: packages.length,
      truncated: packages.length > limit,
      filter,
      foreground,
    };
  }

  /**
   * phone_ls — read-only listing of an allowlisted /sdcard root. The device
   * realpath is checked again so a symlink cannot escape the allowlist.
   */
  async function phoneLs(args) {
    const input = asObject(args);
    assertAllowedKeys(input, ['path', 'limit']);
    const rawPath = input.path === undefined ? C.REMOTE_ROOT : requireString(input.path, 'path', 1, 512);
    if (!rawPath.startsWith('/') || rawPath.includes('\\') || rawPath.includes('..') || /[\u0000-\u001f]/.test(rawPath)) {
      throw fail('invalid_args', `path 必须是绝对 POSIX 路径，且不能包含 ..、反斜杠或控制字符：${rawPath}`);
    }
    const requested = rawPath.replace(/\/+$/, '') || '/';
    assertLsPathRequested(requested);
    const limit = optionalInteger(input.limit, 'limit', 1, 1000) || 200;

    let resolved;
    try {
      const output = await runDeviceShell(`realpath -e ${shQuote(requested)}`, {
        timeoutMs: 10000,
        maxBytes: 16 * 1024,
      });
      resolved = output.trim();
    } catch (err) {
      throw fail('invalid_args', `路径不存在或不可读：${requested}`, {
        cause: tailText(err && err.message),
      });
    }
    if (!resolved) throw fail('invalid_args', `realpath 未返回路径：${requested}`);
    assertLsPathResolved(resolved);

    const listing = await runDeviceShell(`ls -la ${shQuote(resolved)}`, {
      timeoutMs: 10000,
      maxBytes: 256 * 1024,
      allowTruncated: true,
    });
    const entries = parseLsEntries(listing);
    return {
      ok: true,
      requested,
      path: resolved,
      entries: entries.slice(0, limit),
      total: entries.length,
      truncated: entries.length > limit,
      allowed_roots: PHONE_LS_ROOTS,
    };
  }

  /**
   * phone_exec — fixed diagnostic ops only. It never accepts a shell string.
   */
  async function phoneExec(args) {
    const input = asObject(args);
    assertAllowedKeys(input, ['op', 'text', 'key', 'value', 'filter', 'limit']);
    const op = requireString(input.op, 'op', 1, 32);
    if (!PHONE_EXEC_OPS.includes(op)) {
      throw fail('invalid_args', `不允许的 op：${op}`, { allowed: PHONE_EXEC_OPS });
    }

    if (op === 'echo') {
      const text = input.text !== undefined ? input.text : input.value !== undefined ? input.value : '';
      requireString(text, 'text', 0, 200);
      assertNoShellMeta(text, 'text');
      const output = await runDeviceShell(`echo ${shQuote(text)}`, {
        timeoutMs: 8000,
        maxBytes: 64 * 1024,
      });
      return { ok: true, op, stdout: output.replace(/\r?\n$/, ''), exit_code: 0 };
    }

    if (op === 'getprop') {
      const key = input.key !== undefined ? input.key : input.value;
      requireString(key, 'key', 1, 128);
      assertNoShellMeta(key, 'key');
      if (!PHONE_EXEC_GETPROP_KEYS.includes(key)) {
        throw fail('forbidden_scope', `getprop key 不在白名单：${key}`, {
          allowed: PHONE_EXEC_GETPROP_KEYS,
        });
      }
      const output = await runDeviceShell(`getprop ${shQuote(key)}`, {
        timeoutMs: 8000,
        maxBytes: 64 * 1024,
      });
      return { ok: true, op, key, value: output.trim() };
    }

    if (op === 'wm_size') {
      const output = await runDeviceShell('wm size', { timeoutMs: 8000, maxBytes: 64 * 1024 });
      const override = /Override size:\s*(\d+)x(\d+)/i.exec(output);
      const physical = /Physical size:\s*(\d+)x(\d+)/i.exec(output);
      return {
        ok: true,
        op,
        physical: physical ? { width: Number(physical[1]), height: Number(physical[2]) } : null,
        override: override ? { width: Number(override[1]), height: Number(override[2]) } : null,
      };
    }

    if (op === 'pm_list') {
      const filter =
        input.filter === undefined || input.filter === null ? null : requireString(input.filter, 'filter', 1, 64);
      if (filter && !/^[A-Za-z0-9._-]+$/.test(filter)) {
        throw fail('invalid_args', 'filter 只允许字母、数字、点、下划线、连字符');
      }
      const limit = optionalInteger(input.limit, 'limit', 1, 1000) || 500;
      const output = await runDeviceShell('pm list packages', {
        timeoutMs: 20000,
        maxBytes: 512 * 1024,
        allowTruncated: true,
      });
      let packages = String(output)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('package:'))
        .map((line) => line.slice('package:'.length).trim())
        .filter(Boolean);
      if (filter) packages = packages.filter((name) => name.toLowerCase().includes(filter.toLowerCase()));
      packages.sort();
      return {
        ok: true,
        op,
        packages: packages.slice(0, limit),
        count: Math.min(packages.length, limit),
        total: packages.length,
        truncated: packages.length > limit,
        filter,
      };
    }

    // dumpsys_battery
    const output = await runDeviceShell('dumpsys battery', { timeoutMs: 8000, maxBytes: 256 * 1024 });
    const level = /level:\s*(\d+)/i.exec(output);
    const status = /status:\s*(\d+)/i.exec(output);
    const statusCode = status ? Number(status[1]) : null;
    return {
      ok: true,
      op,
      level: level ? Number(level[1]) : null,
      status: statusCode,
      status_label: statusCode !== null ? BATTERY_STATUS[statusCode] || '未知' : null,
    };
  }

  async function phoneUiTap(args) {
    assertHighRisk('phone_ui_tap');
    return withUiLock(async () => {
      const hasX = args.x !== undefined;
      const hasY = args.y !== undefined;
      const screen = await getScreenSize();

      if (hasX || hasY) {
        if (!hasX || !hasY) throw fail('invalid_args', '坐标点击需要同时提供 x 和 y');
        const x = optionalInteger(args.x, 'x', 0, 100000);
        const y = optionalInteger(args.y, 'y', 0, 100000);
        assertPoint(x, y, screen);
        await runDeviceShell(`input tap ${x} ${y}`, { timeoutMs: 10000, maxBytes: 64 * 1024 });
        return { ok: true, x, y, matched: 'coords', matches: 1 };
      }

      const text = args.text !== undefined ? requireString(args.text, 'text', 1, 256) : null;
      const rid = args.rid !== undefined ? requireString(args.rid, 'rid', 1, 256) : null;
      if (!text && !rid) throw fail('invalid_args', '需要 x/y 坐标，或 text/rid 选择器');
      const explicitIndex = args.index !== undefined ? optionalInteger(args.index, 'index', 0, 100000) : null;

      const dump = await dumpUiInternal();
      const matches = matchNodes(dump.nodes, { text, rid });
      if (matches.length === 0) {
        throw fail('not_found', '没有匹配的 UI 节点', { text, rid });
      }
      if (matches.length > 1 && explicitIndex === null) {
        throw fail('invalid_args', '选择器匹配到多个节点，请提供 index 指定其中一个', {
          reason: 'ambiguous_selector',
          matches: matches.length,
        });
      }
      const index = explicitIndex === null ? 0 : explicitIndex;
      if (index >= matches.length) {
        throw fail('not_found', `index 超出匹配数量（${matches.length}）`, { index });
      }
      const node = matches[index];
      const point = centerOf(node);
      if (!point) throw fail('internal_error', '匹配节点没有可用的 bounds');
      assertPoint(point.x, point.y, screen);
      await runDeviceShell(`input tap ${point.x} ${point.y}`, { timeoutMs: 10000, maxBytes: 64 * 1024 });
      return {
        ok: true,
        x: point.x,
        y: point.y,
        matched: 'selector',
        matches: matches.length,
        index,
        node: { text: node.text, rid: node.rid, cls: node.cls, bounds: node.bounds },
      };
    });
  }

  async function phoneUiSwipe(args) {
    assertHighRisk('phone_ui_swipe');
    return withUiLock(async () => {
      const x1 = optionalInteger(args.x1, 'x1', 0, 100000);
      const y1 = optionalInteger(args.y1, 'y1', 0, 100000);
      const x2 = optionalInteger(args.x2, 'x2', 0, 100000);
      const y2 = optionalInteger(args.y2, 'y2', 0, 100000);
      if ([x1, y1, x2, y2].some((value) => value === null)) {
        throw fail('invalid_args', '滑动需要 x1/y1/x2/y2');
      }
      const duration = optionalInteger(args.duration_ms, 'duration_ms', 50, 5000) || 300;
      const screen = await getScreenSize();
      assertPoint(x1, y1, screen);
      assertPoint(x2, y2, screen);
      await runDeviceShell(`input swipe ${x1} ${y1} ${x2} ${y2} ${duration}`, {
        timeoutMs: 15000,
        maxBytes: 64 * 1024,
      });
      return { ok: true, x1, y1, x2, y2, duration_ms: duration };
    });
  }

  async function phoneKey(args) {
    const key = requireString(args.key, 'key', 1, 16).toUpperCase();
    const code = KEY_WHITELIST[key];
    if (!code) {
      throw fail('invalid_args', `不支持的 key：${args.key}（只允许 ${Object.keys(KEY_WHITELIST).join('/')}）`);
    }
    await runDeviceShell(`input keyevent ${code}`, { timeoutMs: 10000, maxBytes: 64 * 1024 });
    return { ok: true, key };
  }

  async function phoneText(args) {
    const text = assertAsciiText(requireString(args.text, 'text', 1, 512));
    // `input text` uses %s as the space transport.
    const encoded = text.replace(/ /g, '%s');
    await runDeviceShell(`input text ${shQuote(encoded)}`, { timeoutMs: 15000, maxBytes: 64 * 1024 });
    return { ok: true, typed: text.length };
  }

  async function phoneFilePush(args) {
    const localPath = requireString(args.local_path, 'local_path', 1, 512);
    const remoteName = requireString(args.remote_name, 'remote_name', 1, 128);
    assertSafeRemoteName(remoteName);

    const spoolRoot = spoolDir(config);
    let localAbs;
    try {
      localAbs = fs.realpathSync(path.resolve(localPath));
    } catch {
      throw fail('invalid_args', `本地文件不存在：${localPath}`);
    }
    if (!isInside(spoolRoot, localAbs)) {
      throw fail('invalid_args', `本地文件必须位于 spool 目录内：${spoolRoot}`);
    }
    const stat = fs.statSync(localAbs);
    if (!stat.isFile()) throw fail('invalid_args', 'local_path 不是文件');
    if (stat.size > C.LIMITS.blobBytes) {
      throw fail('payload_too_large', `文件超过 ${C.LIMITS.blobBytes} 字节上限`);
    }
    requireAdb();
    if (typeof adb.push !== 'function') throw fail('adb_unavailable', 'ADB transport 不支持 push');

    const digest = crypto.createHash('sha256').update(fs.readFileSync(localAbs)).digest('hex');
    const remoteFinal = `${C.REMOTE_DIRS.blobs}/${remoteName}`;
    const remoteTmp = `${C.REMOTE_DIRS.tmp}/${remoteName}.${randomSuffix()}.tmp`;

    try {
      await adb.push(localAbs, remoteTmp, { timeoutMs: 120000 });
      await runDeviceShell(`mv -f ${shQuote(remoteTmp)} ${shQuote(remoteFinal)}`, {
        timeoutMs: 10000,
        maxBytes: 64 * 1024,
      });
    } catch (err) {
      try {
        await runDeviceShell(`rm -f ${shQuote(remoteTmp)}`, { timeoutMs: 5000, maxBytes: 8192 });
      } catch {
        // best effort
      }
      throw err;
    }

    let remoteHash = null;
    try {
      const output = await runDeviceShell(`sha256sum ${shQuote(remoteFinal)}`, {
        timeoutMs: 10000,
        maxBytes: 16 * 1024,
      });
      const candidate = (output.trim().split(/\s+/)[0] || '').toLowerCase();
      if (/^[0-9a-f]{64}$/.test(candidate)) remoteHash = candidate;
    } catch {
      remoteHash = null;
    }
    if (remoteHash && remoteHash !== digest) {
      try {
        await runDeviceShell(`rm -f ${shQuote(remoteFinal)}`, { timeoutMs: 5000, maxBytes: 8192 });
      } catch {
        // best effort
      }
      throw fail('internal_error', '远端 sha256 与本地不一致，已删除远端文件');
    }

    return {
      ok: true,
      remote: remoteFinal,
      sha256: remoteHash || digest,
      bytes: stat.size,
      verified: Boolean(remoteHash),
    };
  }

  async function phoneFilePull(args) {
    const remotePath = assertRemotePullPath(args.remote_path);
    const maxBytes = Math.min(
      Math.max(optionalInteger(args.max_bytes, 'max_bytes', 1, C.LIMITS.responseHardMaxBytes) || 8 * 1024 * 1024, 1),
      C.LIMITS.responseHardMaxBytes
    );
    requireAdb();
    if (typeof adb.pull !== 'function') throw fail('adb_unavailable', 'ADB transport 不支持 pull');

    let resolvedRemote;
    try {
      const output = await runDeviceShell(`realpath ${shQuote(remotePath)}`, {
        timeoutMs: 10000,
        maxBytes: 16 * 1024,
      });
      resolvedRemote = output.trim();
    } catch (err) {
      throw fail('invalid_args', `无法解析远端路径（可能不存在）：${remotePath}`, {
        cause: tailText(err && err.message),
      });
    }
    if (!assertUnderAnyRoot(resolvedRemote, [C.REMOTE_DIRS.blobs, C.REMOTE_DIRS.outbox])) {
      throw fail('invalid_args', `远端路径解析后不在允许目录（blobs/outbox）：${resolvedRemote}`);
    }

    const extension = path.extname(resolvedRemote);
    const safeExtension = /^\.[A-Za-z0-9]{1,8}$/.test(extension) ? extension : '.bin';
    const localDir = ensureDir(spoolDir(config));
    const localAbs = path.join(localDir, `pull_${nowStamp(clock())}_${randomSuffix()}${safeExtension}`);

    const pulled = await adb.pull(resolvedRemote, localAbs, { timeoutMs: 120000, maxBytes });
    if (Number(pulled.bytes) > maxBytes) {
      try {
        fs.unlinkSync(localAbs);
      } catch {
        // best effort
      }
      throw fail('payload_too_large', `拉取结果超过 ${maxBytes} 字节上限`);
    }
    return {
      ok: true,
      local_path: pulled.local || localAbs,
      remote: resolvedRemote,
      sha256: pulled.sha256,
      bytes: pulled.bytes,
    };
  }

  const handlers = {
    phone_info: withOk(phoneInfo),
    phone_screenshot: withOk(phoneScreenshot),
    phone_ui_dump: withOk(phoneUiDump),
    phone_app_list: withOk(phoneAppList),
    phone_ls: withOk(phoneLs),
    phone_exec: withOk(phoneExec),
    phone_ui_tap: withOk(phoneUiTap),
    phone_ui_swipe: withOk(phoneUiSwipe),
    phone_key: withOk(phoneKey),
    phone_text: withOk(phoneText),
    phone_file_push: withOk(phoneFilePush),
    phone_file_pull: withOk(phoneFilePull),
  };

  const ui = {
    dump: handlers.phone_ui_dump,
    tap: handlers.phone_ui_tap,
    click: handlers.phone_ui_tap,
    swipe: handlers.phone_ui_swipe,
    key: handlers.phone_key,
    text: handlers.phone_text,
  };

  // Dot-style facade. exec/ls/apps are restricted read-only diagnostics, not a
  // shell; phone_shell/phone_su/read/write/app control remain prohibited.
  const phone = {
    info: handlers.phone_info,
    screenshot: handlers.phone_screenshot,
    shot: handlers.phone_screenshot,
    dump: handlers.phone_ui_dump,
    apps: handlers.phone_app_list,
    ls: handlers.phone_ls,
    exec: handlers.phone_exec,
    ui,
    push: handlers.phone_file_push,
    pull: handlers.phone_file_pull,
  };

  return {
    ...handlers,
    phone_ui_click: handlers.phone_ui_tap,
    tools: handlers,
    ui,
    phone,
    info: handlers.phone_info,
    shot: handlers.phone_screenshot,
    screenshot: handlers.phone_screenshot,
    dump: handlers.phone_ui_dump,
    apps: handlers.phone_app_list,
    ls: handlers.phone_ls,
    exec: handlers.phone_exec,
    push: handlers.phone_file_push,
    pull: handlers.phone_file_pull,
    PHASE1_TOOL_NAMES: PHONE_PHASE1_TOOLS,
    PHASE2_TOOL_NAMES: PHONE_PHASE2_TOOLS,
    RESTRICTED_TOOL_NAMES: PHONE_RESTRICTED_TOOLS,
  };
}

module.exports = {
  PHONE_PHASE1_TOOLS,
  PHONE_PHASE2_TOOLS,
  PHONE_RESTRICTED_TOOLS,
  PHONE_PROHIBITED_TOOLS,
  PHONE_EXEC_OPS,
  PHONE_EXEC_GETPROP_KEYS,
  PHONE_LS_ROOTS,
  KEY_WHITELIST,
  createPhoneTools,
  parseUiXml,
  parseActivities,
  parseActivityTop,
  parseForegroundActivity,
  parseGetprop,
  parseLsEntries,
  pngSize,
  isPng,
  assertRemotePullPath,
};
