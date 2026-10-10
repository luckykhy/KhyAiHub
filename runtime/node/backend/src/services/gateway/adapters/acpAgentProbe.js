'use strict';

/**
 * acpAgentProbe.js — 外部 ACP 智能体的**四态探测**（T-025 / [MGMT-PLAN-011] L4）。
 *
 * 为什么不是复用 adapter 的 `detect()`：`detect()` 的契约是**布尔**（网关只关心
 * 「这个适配器能不能进候选池」），而 `khy onboard`（T-025）需要区分四态——
 * 尤其是「已装但未登录」，这是用户唯一能自己动手修的一态。两者目的不同，
 * 故本模块**加法式**存在，`detect()` 一行不动（避免动网关可用性判定路径）。
 *
 * 四态与结构化错误码（借鉴 AionUi `error_code()` 的形状，非其实现）：
 *
 * | 状态 | 错误码 | 含义 | 用户该做什么 |
 * |---|---|---|---|
 * | `not_installed` | `command_not_found` | PATH 上找不到可执行 | 装它 |
 * | `unavailable`  | `version_probe_failed` / `version_probe_timeout` / `session_probe_failed` | 装了但跑不起来 | 看 message |
 * | `auth_required`| `auth_required` | 装了能跑，但没登录 | 去登录 |
 * | `ready`        | — | 可调度 | 无需动作 |
 *
 * 判据（对齐 AionUi `cli_probe.rs` / `custom_agent_probe.rs` 的实证做法）：
 *   1. PATH 可达（win: where + `.cmd/.ps1/.bat` shim 回退；nix: which）
 *   2. 实跑 `--version`，退出码 0 —— **装了但坏掉的必须判不可用**，PATH 可达不算数
 *   3. 开一个空 `session/new`（不跑 prompt）—— 只有这一步能分出「未登录」
 *
 * 设计约束：**叶子、绝不抛错**。所有 IO 经注入的 deps 进入，分类逻辑是纯函数，
 * 因此「什么输入 → 什么态」可以完全离线测试（见 tests/gateway/acpAgentProbe.test.js）。
 */

const { execFile } = require('child_process');

/** 四态（单一真源，UI 与测试都读它）。 */
const AGENT_STATE = Object.freeze({
  READY: 'ready',
  AUTH_REQUIRED: 'auth_required',
  NOT_INSTALLED: 'not_installed',
  UNAVAILABLE: 'unavailable',
});

/** 结构化错误码（与 AGENT_STATE 一一对应，auth_required 两处共用）。 */
const PROBE_ERROR = Object.freeze({
  COMMAND_NOT_FOUND: 'command_not_found',
  VERSION_PROBE_FAILED: 'version_probe_failed',
  VERSION_PROBE_TIMEOUT: 'version_probe_timeout',
  AUTH_REQUIRED: 'auth_required',
  SESSION_PROBE_FAILED: 'session_probe_failed',
});

// 探测预算分级（对齐 AionUi ProbePolicy：inline 5s / 重查 30s）。
// 超时不等于坏——`version_probe_timeout` 是独立态，UI 可提示「稍后重试」。
const DEFAULT_VERSION_TIMEOUT_MS = 5000;

/**
 * 纯函数：把探测事实映射成四态结论。**不碰任何 IO**，是全模块唯一需要被穷举测试的地方。
 *
 * @param {{registered:boolean, onPath:boolean, version:'ok'|'failed'|'timeout'|'skipped',
 *          session?:{ok:boolean, errorCode?:string}}} facts
 * @returns {{state:string, errorCode?:string, hint?:string}}
 */
function classifyProbe(facts) {
  const f = facts || {};
  if (!f.registered) {
    return { state: AGENT_STATE.NOT_INSTALLED, errorCode: PROBE_ERROR.COMMAND_NOT_FOUND, hint: '未在 KHY_ACPCLIENT_AGENTS 中登记' };
  }
  if (!f.onPath) {
    return { state: AGENT_STATE.NOT_INSTALLED, errorCode: PROBE_ERROR.COMMAND_NOT_FOUND, hint: 'PATH 上找不到可执行文件' };
  }
  if (f.version === 'timeout') {
    return { state: AGENT_STATE.UNAVAILABLE, errorCode: PROBE_ERROR.VERSION_PROBE_TIMEOUT, hint: '--version 超时：可能装了但启动极慢，可稍后重试' };
  }
  if (f.version === 'failed') {
    return { state: AGENT_STATE.UNAVAILABLE, errorCode: PROBE_ERROR.VERSION_PROBE_FAILED, hint: '--version 非零退出：可执行存在但跑不起来' };
  }
  if (f.version === 'skipped') {
    // 显式路径已由 resolveAgentCommand 做过存在性检查，允许跳过版本探测
    return { state: AGENT_STATE.READY };
  }
  const s = f.session;
  if (s && s.ok === false) {
    if (s.errorCode === PROBE_ERROR.AUTH_REQUIRED) {
      return { state: AGENT_STATE.AUTH_REQUIRED, errorCode: PROBE_ERROR.AUTH_REQUIRED, hint: '已安装但未登录，登录后即可调度' };
    }
    return { state: AGENT_STATE.UNAVAILABLE, errorCode: s.errorCode || PROBE_ERROR.SESSION_PROBE_FAILED, hint: s.message || '会话握手失败' };
  }
  return { state: AGENT_STATE.READY };
}

/**
 * PATH 可达性探测：win 用 `where` 并对 npm 全局 shim 做 `.cmd/.ps1/.bat` 回退，
 * nix 用 `which`。**绝不抛错**——任何异常都按「不可达」处理。
 *
 * @param {string} command 裸命令名
 * @param {{platform?:string, execFile?:Function, timeoutMs?:number}} [deps]
 * @returns {Promise<{onPath:boolean, resolvedPath?:string}>}
 */
function resolveOnPath(command, deps = {}) {
  const platform = deps.platform || process.platform;
  const run = deps.execFile || execFile;
  const timeoutMs = deps.timeoutMs || DEFAULT_VERSION_TIMEOUT_MS;
  const candidates = platform === 'win32'
    ? [command, `${command}.cmd`, `${command}.ps1`, `${command}.bat`]
    : [command];

  return new Promise((resolve) => {
    let pending = candidates.length;
    let found = null;
    if (!pending) {
      resolve({ onPath: false });
      return;
    }
    for (const cand of candidates) {
      const bin = platform === 'win32' ? 'where' : 'which';
      try {
        run(bin, [cand], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
          if (!err && stdout && String(stdout).trim()) {
            if (!found) found = String(stdout).trim().split(/\r?\n/)[0].trim();
          }
          pending -= 1;
          if (pending === 0) {
            resolve(found ? { onPath: true, resolvedPath: found } : { onPath: false });
          }
        });
      } catch {
        // execFile 同步抛错（如 bin 本身不存在）——按该候选不可达处理，绝不向外抛。
        pending -= 1;
        if (pending === 0) {
          resolve(found ? { onPath: true, resolvedPath: found } : { onPath: false });
        }
      }
    }
  });
}

/**
 * 实跑 `<command> --version`，按退出码/超时/信号给出三值结论。
 * @returns {Promise<{version:'ok'|'failed'|'timeout'}>}
 */
function probeVersion(command, args = [], deps = {}) {
  const run = deps.execFile || execFile;
  const timeoutMs = deps.timeoutMs || DEFAULT_VERSION_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve({ version: v }); } };
    try {
      run(command, ['--version', ...(Array.isArray(args) ? args : [])], { timeout: timeoutMs, windowsHide: true }, (err) => {
        // execFile 的超时/被杀在 err.killed/signal 上体现
        if (err && (err.killed || err.signal === 'SIGTERM')) { done('timeout'); return; }
        done(err ? 'failed' : 'ok');
      });
    } catch {
      done('failed');
    }
  });
}

/**
 * 探测单个已登记的智能体，返回四态结论。**绝不抛错**。
 *
 * @param {string} agentKey
 * @param {object} [deps] 全部可注入，便于离线测试
 * @param {object} [deps.env] 环境变量真源（默认 process.env）
 * @param {Function} [deps.resolveAgentCommand] 命令解析（默认走 acpAgentInvocation）
 * @param {Function} [deps.resolveOnPath]
 * @param {Function} [deps.probeVersion]
 * @param {Function} [deps.openSession] 空会话握手；返回 `{ok, errorCode?, message?}`
 * @returns {Promise<{agentKey:string, state:string, errorCode?:string, hint?:string,
 *                    command?:string, resolvedPath?:string, detail?:object}>}
 */
async function probeAgent(agentKey, deps = {}) {
  const base = { agentKey };
  const resolveCmd = deps.resolveAgentCommand
    || require('./acpAgentInvocation').resolveAgentCommand;
  const onPathFn = deps.resolveOnPath || resolveOnPath;
  const versionFn = deps.probeVersion || probeVersion;
  const openSession = deps.openSession;

  let resolved = null;
  try {
    resolved = resolveCmd(agentKey, deps.env || process.env);
  } catch {
    resolved = null;
  }
  if (!resolved) {
    return { ...base, ...classifyProbe({ registered: false }) };
  }

  const isExplicitPath = resolved.command.includes('/') || resolved.command.includes('\\');
  let pathInfo = { onPath: true, resolvedPath: resolved.command };
  if (!isExplicitPath) {
    try {
      pathInfo = await onPathFn(resolved.command, deps);
    } catch {
      pathInfo = { onPath: false };
    }
  }
  if (!pathInfo.onPath) {
    return { ...base, command: resolved.command, ...classifyProbe({ registered: true, onPath: false }) };
  }

  let version = 'ok';
  if (!isExplicitPath) {
    try {
      version = (await versionFn(resolved.command, resolved.args, deps)).version;
    } catch {
      version = 'failed';
    }
  } else {
    version = 'skipped';
  }

  if (version !== 'ok') {
    return {
      ...base, command: resolved.command, resolvedPath: pathInfo.resolvedPath,
      ...classifyProbe({ registered: true, onPath: true, version }),
    };
  }

  // 版本通过后才值得开会话——未登录只有这一步能测出来。
  if (typeof openSession !== 'function') {
    return {
      ...base, command: resolved.command, resolvedPath: pathInfo.resolvedPath,
      state: AGENT_STATE.READY,
      detail: { note: '未提供 openSession，跳过登录态探测' },
    };
  }
  let session;
  try {
    session = await openSession(agentKey, resolved, deps);
  } catch (err) {
    session = { ok: false, errorCode: PROBE_ERROR.SESSION_PROBE_FAILED, message: (err && err.message) || String(err) };
  }
  return {
    ...base, command: resolved.command, resolvedPath: pathInfo.resolvedPath,
    ...classifyProbe({ registered: true, onPath: true, version: 'ok', session }),
    detail: session,
  };
}

/**
 * 默认的 openSession 实现：走真实 ACP 连接（`probeSession()`）。
 * 单独导出以便测试注入与复用；探测失败不抛错，错误码已由 probeSession 归一。
 */
async function defaultOpenSession(agentKey, resolved) {
  try {
    const { getConnection } = require('./acpAgentInvocation');
    const conn = getConnection(agentKey, resolved);
    const r = await conn.probeSession();
    return r && typeof r.ok === 'boolean' ? r : { ok: false, errorCode: PROBE_ERROR.SESSION_PROBE_FAILED };
  } catch (err) {
    return { ok: false, errorCode: PROBE_ERROR.SESSION_PROBE_FAILED, message: (err && err.message) || String(err) };
  }
}

module.exports = {
  AGENT_STATE,
  PROBE_ERROR,
  DEFAULT_VERSION_TIMEOUT_MS,
  classifyProbe,
  resolveOnPath,
  probeVersion,
  probeAgent,
  defaultOpenSession,
};
