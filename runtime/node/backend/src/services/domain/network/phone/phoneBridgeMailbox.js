'use strict';

/**
 * phoneBridgeMailbox.js — file-mailbox fallback channel for the phone bridge.
 *
 * The bridge's HTTP listener is a ServerSocket bound to the wildcard address
 * with no retry: if port 8896 is already taken, start() swallows the bind
 * Throwable, sets running=false and never tries again. /status then just fails
 * to connect while the mailbox keeps working — so a dead HTTP channel looks
 * exactly like a dead phone. This module is the second door.
 *
 * Two measured constraints shape it:
 *   - BridgeService.loop() is ONE thread processing cmd_ files sequentially. A
 *     single hung exec (the code drains stdout to EOF before it polls the exit
 *     code, so `sleep 300` blocks readLine forever) freezes every later cmd_.
 *     HTTP /call is thread-per-socket and unaffected. So: HTTP first, mailbox
 *     only as fallback, and never run a possibly-hanging command over it.
 *   - cmd_ files are deleted after the result is written, INCLUDING on failure,
 *     and even when they fail to parse. There is no "retry the same id".
 *
 * The IO half (fs + adb push/cat) is injected; the decision half (ids, file
 * names, payload shape, deadline arithmetic, result parsing) is pure.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAILBOX_CMD_PREFIX = 'cmd_';
const MAILBOX_RESULT_PREFIX = 'result_';
const MAILBOX_JSON_SUFFIX = '.json';
const MAX_MAILBOX_PAYLOAD_BYTES = 512 * 1024;

function createMailboxId(randomHex) {
  const raw = typeof randomHex === 'string' && randomHex.trim() ? randomHex.trim() : null;
  const body = raw || crypto.randomBytes(6).toString('hex');
  return `khy${body}`;
}

function buildMailboxFileNames(id) {
  const safeId = String(id || '').replace(/[^A-Za-z0-9_-]/g, '');
  return {
    cmdFileName: `${MAILBOX_CMD_PREFIX}${safeId}${MAILBOX_JSON_SUFFIX}`,
    resultFileName: `${MAILBOX_RESULT_PREFIX}${safeId}${MAILBOX_JSON_SUFFIX}`,
  };
}

function buildMailboxRemotePaths(mailboxDir, id) {
  const names = buildMailboxFileNames(id);
  const dir = String(mailboxDir || '');
  return {
    cmdRemotePath: `${dir}/${names.cmdFileName}`,
    resultRemotePath: `${dir}/${names.resultFileName}`,
  };
}

/**
 * The worker derives a missing `id` from the filename as substring(4, len-5),
 * so the payload id and the filename must agree or the result comes back under
 * a name we are not polling for.
 */
function buildMailboxCmdPayload({ id, tool, args }) {
  return {
    id: String(id || ''),
    tool: String(tool || ''),
    args: args && typeof args === 'object' ? args : {},
  };
}

function serializeMailboxCmdPayload(payload) {
  return JSON.stringify(payload);
}

/**
 * Deadline arithmetic, kept pure so the "no unbounded wait" property is
 * assertable without a device. Returns an integer attempt count; a poll loop
 * driven by this can never spin forever.
 */
function computeMailboxDeadline({ startedAtMs = Date.now(), timeoutMs, pollMs }) {
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000;
  const poll = Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 500;
  const maxAttempts = Math.max(1, Math.ceil(timeout / poll));
  return {
    deadlineMs: startedAtMs + timeout,
    pollMs: poll,
    maxAttempts,
  };
}

/**
 * The result file merges {id, tool, ts} with every key of Tools.dispatch, so
 * ok/error/out land at top level. A file that exists but does not parse is a
 * failure, not an empty success.
 */
function parseMailboxResult(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, error: '信箱尚未返回结果' };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `信箱返回的不是合法 JSON：${err && err.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '信箱返回的不是一个对象' };
  }
  if (parsed.ok === false) {
    return { ok: false, error: String(parsed.error || '桥接返回失败'), result: parsed };
  }
  return { ok: true, result: parsed };
}

function _defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * @param {object} options
 * @param {object} options.config resolved phoneBridgeConfig
 * @param {object} options.transport { push(local, remote), run(argv, opts) }
 * @param {Function} [options.fsFactory] returns the fs module to use
 * @param {Function} [options.tmpDirFactory] returns a writable scratch dir
 * @param {Function} [options.now]
 * @param {Function} [options.sleep]
 * @param {Function} [options.createId]
 */
function createPhoneBridgeMailbox(options = {}) {
  const config = options.config;
  const transport = options.transport;
  const fsImpl = options.fs || fs;
  const osImpl = options.os || os;
  const pathImpl = options.path || path;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const sleep = typeof options.sleep === 'function' ? options.sleep : _defaultSleep;
  const createId = typeof options.createId === 'function' ? options.createId : () => createMailboxId();
  const tmpDirFactory =
    typeof options.tmpDirFactory === 'function' ? options.tmpDirFactory : () => osImpl.tmpdir();

  function _scratchDir() {
    const base = tmpDirFactory();
    const dir = pathImpl.join(base, 'khy-phone-bridge');
    fsImpl.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function _readLocal(filePath) {
    try {
      return fsImpl.readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }
  }

  function _removeLocal(filePath) {
    try {
      fsImpl.unlinkSync(filePath);
    } catch {
      /* scratch file, nothing to reclaim */
    }
  }

  /**
   * Push a command and wait for result_<id>.json.
   * Returns { ok, channel:'mailbox', ... } and never throws — a dead fallback
   * must read as a failure, not crash the caller.
   */
  async function call(tool, args = {}, callOptions = {}) {
    if (!transport || typeof transport.push !== 'function' || typeof transport.run !== 'function') {
      return { ok: false, channel: 'mailbox', error: '信箱通道未注入 transport' };
    }
    const mailboxDir = (config && config.mailboxDir) || '/sdcard/bridge-amoobridge';
    const id = createId();
    const { cmdRemotePath, resultRemotePath } = buildMailboxRemotePaths(mailboxDir, id);
    const payload = serializeMailboxCmdPayload(
      buildMailboxCmdPayload({ id, tool, args })
    );

    let scratch = null;
    let localCmdPath = null;
    try {
      if (Buffer.byteLength(payload, 'utf8') > MAX_MAILBOX_PAYLOAD_BYTES) {
        return { ok: false, channel: 'mailbox', error: '信箱载荷超过 512KB 上限，请改用 HTTP 主通道' };
      }
      scratch = _scratchDir();
      localCmdPath = pathImpl.join(scratch, buildMailboxFileNames(id).cmdFileName);
      fsImpl.writeFileSync(localCmdPath, payload, 'utf8');

      const pushed = await transport.push(localCmdPath, cmdRemotePath);
      if (!pushed || pushed.ok !== true) {
        return {
          ok: false,
          channel: 'mailbox',
          error: (pushed && pushed.error) || '信箱命令推送失败',
        };
      }

      const timeoutMs =
        Number(callOptions.timeoutMs) > 0
          ? Number(callOptions.timeoutMs)
          : (config && config.mailboxTimeoutMs) || 30000;
      const pollMs = (config && config.mailboxPollMs) || 500;
      const deadline = computeMailboxDeadline({ startedAtMs: now(), timeoutMs, pollMs });

      for (let attempt = 1; attempt <= deadline.maxAttempts; attempt += 1) {
        if (callOptions.signal && callOptions.signal.aborted) {
          return { ok: false, channel: 'mailbox', error: '信箱等待被取消' };
        }
        if (now() >= deadline.deadlineMs && attempt > 1) {
          break;
        }
        const probe = await transport.run(
          ['shell', 'cat', resultRemotePath],
          { timeoutMs: Math.max(1000, pollMs * 4) }
        );
        if (probe && probe.ok === true && typeof probe.stdout === 'string' && probe.stdout.trim()) {
          const parsed = parseMailboxResult(probe.stdout);
          return { ...parsed, channel: 'mailbox', attempts: attempt };
        }
        if (attempt < deadline.maxAttempts) {
          await sleep(pollMs);
        }
      }

      return {
        ok: false,
        channel: 'mailbox',
        error: `信箱在 ${timeoutMs}ms 内没有返回结果（已等待 ${deadline.maxAttempts} 次轮询）。`
          + 'HTTP 主通道不受此影响；若桥服务进程还活着，优先重试 HTTP。',
      };
    } catch (err) {
      return {
        ok: false,
        channel: 'mailbox',
        error: `信箱通道异常：${(err && err.message) || String(err)}`,
      };
    } finally {
      if (localCmdPath) {
        _removeLocal(localCmdPath);
      }
    }
  }

  return { call, createId, buildMailboxRemotePaths };
}

module.exports = {
  MAILBOX_CMD_PREFIX,
  MAILBOX_RESULT_PREFIX,
  MAILBOX_JSON_SUFFIX,
  MAX_MAILBOX_PAYLOAD_BYTES,
  createMailboxId,
  buildMailboxFileNames,
  buildMailboxRemotePaths,
  buildMailboxCmdPayload,
  serializeMailboxCmdPayload,
  computeMailboxDeadline,
  parseMailboxResult,
  createPhoneBridgeMailbox,
};
