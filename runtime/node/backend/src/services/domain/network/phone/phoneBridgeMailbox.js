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
 * Consumer-side cleanup (the guide's first-responsibility path, previously
 * unimplemented — measured 2026-11-14: 67 unconsumed result_ files piled up in
 * /sdcard/bridge-amoobridge because every caller read its receipt and left it):
 *   - call() deletes result_<id>.json right after reading and verifying it, and
 *     clears that id's cmd_/processing_ residue in the same breath;
 *   - sweep() replays the same rule over the whole directory for residue pushed
 *     by hand (tests, dead consumers). It is repeatable and idempotent: a clean
 *     mailbox is a no-op. A leftover processing_<id>.json means the command's
 *     side effects are unknown, so sweep only removes one whose id the caller
 *     explicitly confirmed via confirmedProcessingIds — the same gate the
 *     bridge's duplicate_id rejection points at.
 *
 * <h2>S1: the ONE consumer per result, and why "delete" is not "consume"</h2>
 * The consumer of result_<id>.json is exactly the caller that created
 * cmd_<id>.json — the issuer. For the phone channel that is this module
 * (call()/sweep()); the amoo channel has its own issuer-consumer
 * (amooMailbox.js, wired to amooDispatchRunner's clipboard fallback). Neither
 * may consume the other's ids, and NO third party may open a result file:
 * status readers use the counts/ages the device publishes in status.json's
 * mailbox block (pending/processing/results/tmp/oldest_result_age_ms/dropped),
 * and the device-side GC only drops expired files (counted as `dropped`,
 * audited in gc_audit.jsonl) — GC is NOT consumption and must never be
 * reported as one.
 *
 * Consumption = read the body, verify it, report what it said, and only then
 * delete that one file: sweep() puts every consumed receipt into
 * report.harvested as {id, tool, ok, state, ms, preview} (preview redacted and
 * capped at PREVIEW_MAX_CHARS), and a file that cannot be read/parsed/verified
 * is kept on the device. A "deleted N files" report that did not first read N
 * bodies is the clearing-a-directory theater this contract forbids.
 *
 * The IO half (fs + adb push/cat) is injected; the decision half (ids, file
 * names, payload shape, deadline arithmetic, result parsing) is pure.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { redactSecrets } = require('./phoneBridgePolicy');

const MAILBOX_CMD_PREFIX = 'cmd_';
const MAILBOX_RESULT_PREFIX = 'result_';
const MAILBOX_PROCESSING_PREFIX = 'processing_';
const MAILBOX_JSON_SUFFIX = '.json';
const MAX_MAILBOX_PAYLOAD_BYTES = 512 * 1024;
/** 消费摘要的 preview 上限（S1）：只给内容摘要，绝不把回执正文整份搬走。 */
const PREVIEW_MAX_CHARS = 120;

/** Mailbox ids as the bridge worker accepts them (BridgeService.isValidMailboxId). */
const MAILBOX_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Measured device default; the resolved config normally carries it explicitly. */
const DEFAULT_MAILBOX_DIR = '/sdcard/bridge-amoobridge';

/**
 * Per-step adb deadline for the sweep's ls/cat/rm round trips. These are short
 * IO hops, not task deadlines — the same exception class as the poll timeout
 * inside call().
 */
const SWEEP_STEP_TIMEOUT_MS = 15000;

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
 * 一条被消费回执的摘要（S1）。`preview` 只取最像「结果正文」的那个字段并
 * 过 redactSecrets、压成单行、截到 PREVIEW_MAX_CHARS —— 它是「读到了什么」
 * 的凭证，不是正文的第二份出口。
 */
function harvestSummary(id, parsed) {
  const candidate = parsed && typeof parsed === 'object'
    ? (typeof parsed.out === 'string' ? parsed.out
      : typeof parsed.text === 'string' ? parsed.text
        : typeof parsed.stdout === 'string' ? parsed.stdout
          : typeof parsed.error === 'string' ? parsed.error
            : JSON.stringify(parsed))
    : '';
  const flat = redactSecrets(String(candidate || '')).replace(/\s+/g, ' ').trim();
  const ms = parsed && parsed.ms !== undefined && parsed.ms !== null && Number.isFinite(Number(parsed.ms))
    ? Number(parsed.ms)
    : null;
  return {
    id,
    tool: parsed && typeof parsed.tool === 'string' ? parsed.tool : '',
    ok: !(parsed && parsed.ok === false),
    state: parsed && typeof parsed.state === 'string' ? parsed.state : null,
    ms,
    preview: flat.length > PREVIEW_MAX_CHARS ? flat.slice(0, PREVIEW_MAX_CHARS) : flat,
  };
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

  const mailboxDir = (config && config.mailboxDir) || DEFAULT_MAILBOX_DIR;

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
   * Best-effort remote removal. Never throws: cleanup failing must not turn a
   * receipt the caller already holds into a failed call — the bridge's own GC
   * (24h/72h/1h) remains the backstop.
   *
   * @param {string[]} paths absolute remote paths
   * @returns {Promise<{ok:boolean, removed:string[], error:string|null}>}
   */
  async function _removeRemoteFiles(paths) {
    const list = (Array.isArray(paths) ? paths : [paths]).filter(
      (value) => typeof value === 'string' && value.length > 0
    );
    if (list.length === 0) return { ok: true, removed: [], error: null };
    try {
      const res = await transport.run(['shell', 'rm', '-f', ...list], {
        timeoutMs: SWEEP_STEP_TIMEOUT_MS,
      });
      if (res && res.ok === true) return { ok: true, removed: list, error: null };
      return {
        ok: false,
        removed: [],
        error: (res && (res.stderr || res.error)) || 'adb rm 未返回 0',
      };
    } catch (err) {
      return { ok: false, removed: [], error: (err && err.message) || String(err) };
    }
  }

  /**
   * The guide's first-responsibility path: the receipt was read and verified,
   * so delete result_<id>.json now and clear this id's cmd_/processing_ residue
   * with it. Skipping the delete is what let 67 unconsumed results pile up
   * (measured 2026-11-14) until the 24h server GC.
   */
  async function _consumeReceipt(id) {
    const paths = [
      `${mailboxDir}/result_${id}${MAILBOX_JSON_SUFFIX}`,
      `${mailboxDir}/processing_${id}${MAILBOX_JSON_SUFFIX}`,
      `${mailboxDir}/cmd_${id}${MAILBOX_JSON_SUFFIX}`,
    ];
    await _removeRemoteFiles(paths);
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
          // Read + verified as a receipt object (a bridge-side ok:false counts:
          // it is still the receipt this id was waiting for) → the consumer's
          // first-responsibility cleanup fires here, before the caller sees it.
          // An unparseable body is NOT verified, so it stays for the deadline
          // path rather than being deleted unread.
          if (parsed.result && typeof parsed.result === 'object') {
            await _consumeReceipt(id);
          }
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

  /**
   * Repeatable, idempotent mailbox sweep — the same rule call() applies per id,
   * replayed over the whole directory for residue nobody consumed (hand-pushed
   * test files, dead consumers). Never throws; every outcome is reported.
   *
   * Rules, in the guide's order:
   *   - result_<id>.json: read it, verify it (JSON object; a body id that
   *     disagrees with the filename is NOT verified), then delete it together
   *     with that id's cmd_/processing_ residue.
   *   - processing_<id>.json with no result: the command's side effects are
   *     unknown — kept unless the caller passed the id in
   *     confirmedProcessingIds (the confirmation the bridge's duplicate_id
   *     rejection asks for).
   *   - cmd_<id>.json with no result: the bridge may still execute it — kept.
   *
   * @param {{confirmedProcessingIds?:string[], dryRun?:boolean}} [options]
   *        dryRun=true 时只读、只报计划（harvested + kept:dry_run_would_delete），
   *        不删设备上任何文件。
   * @returns {Promise<{ok:boolean,scanned:number,harvested:Array<object>,
   *                    deleted:string[], kept:Array<{name:string,reason:string}>,
   *                    failed:Array<{name:string,error:string}>,error?:string}>}
   */
  async function sweep(options = {}) {
    const dryRun = options && options.dryRun === true;
    const report = {
      ok: true,
      scanned: 0,
      harvested: [],
      deleted: [],
      kept: [],
      failed: [],
    };
    const confirmed = new Set(
      (Array.isArray(options && options.confirmedProcessingIds)
        ? options.confirmedProcessingIds
        : []
      )
        .map((value) => String(value))
        .filter((value) => MAILBOX_ID_RE.test(value))
    );

    let names;
    try {
      const ls = await transport.run(['shell', 'ls', '-1', mailboxDir], {
        timeoutMs: SWEEP_STEP_TIMEOUT_MS,
      });
      if (!ls || ls.ok !== true) {
        report.ok = false;
        report.error = `信箱目录列举失败：${(ls && (ls.stderr || ls.error)) || 'adb 未返回 0'}`;
        return report;
      }
      names = String(ls.stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((name) => name && !name.includes('/'));
    } catch (err) {
      report.ok = false;
      report.error = `信箱目录列举异常：${(err && err.message) || String(err)}`;
      return report;
    }
    report.scanned = names.length;
    const present = new Set(names);

    const resultIds = [];
    const processingIds = [];
    const cmdIds = [];
    for (const name of names) {
      for (const prefix of [MAILBOX_RESULT_PREFIX, MAILBOX_PROCESSING_PREFIX, MAILBOX_CMD_PREFIX]) {
        if (!name.startsWith(prefix) || !name.endsWith(MAILBOX_JSON_SUFFIX)) continue;
        const rawId = name.slice(prefix.length, name.length - MAILBOX_JSON_SUFFIX.length);
        if (!MAILBOX_ID_RE.test(rawId)) {
          report.kept.push({ name, reason: `${prefix.replace(/_$/, '')}_id_shape` });
          continue;
        }
        if (prefix === MAILBOX_RESULT_PREFIX) resultIds.push(rawId);
        else if (prefix === MAILBOX_PROCESSING_PREFIX) processingIds.push(rawId);
        else cmdIds.push(rawId);
      }
    }

    // Ids whose result could not be read/verified/removed: their residue is
    // neither consumable nor an unconfirmed leftover, so the loops below skip
    // them instead of misreporting.
    const unsettledResultIds = new Set();

    for (const id of resultIds) {
      const resultName = `${MAILBOX_RESULT_PREFIX}${id}${MAILBOX_JSON_SUFFIX}`;
      try {
        const cat = await transport.run(['shell', 'cat', `${mailboxDir}/${resultName}`], {
          timeoutMs: SWEEP_STEP_TIMEOUT_MS,
        });
        if (!cat || cat.ok !== true || typeof cat.stdout !== 'string' || !cat.stdout.trim()) {
          report.kept.push({ name: resultName, reason: 'result_unreadable' });
          unsettledResultIds.add(id);
          continue;
        }
        let parsed = null;
        try {
          parsed = JSON.parse(cat.stdout);
        } catch {
          parsed = null;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          report.kept.push({ name: resultName, reason: 'result_not_json_object' });
          unsettledResultIds.add(id);
          continue;
        }
        if (typeof parsed.id === 'string' && parsed.id !== id) {
          report.kept.push({ name: resultName, reason: 'result_id_mismatch' });
          unsettledResultIds.add(id);
          continue;
        }
        // 读到并核对通过 = 这一次消费的内容凭证。先入账再删文件：
        // 「删了 N 个」必须意味着「读到了 N 份回执并报告了它们」。
        report.harvested.push(harvestSummary(id, parsed));
        if (dryRun) {
          // dryRun 只报计划：文件留在设备上，等下一次真跑再消费。
          report.kept.push({ name: resultName, reason: 'dry_run_would_delete' });
          unsettledResultIds.add(id);
          continue;
        }
      } catch (err) {
        report.kept.push({
          name: resultName,
          reason: `result_read_error: ${(err && err.message) || String(err)}`,
        });
        unsettledResultIds.add(id);
        continue;
      }
      const targets = [resultName];
      const processingName = `${MAILBOX_PROCESSING_PREFIX}${id}${MAILBOX_JSON_SUFFIX}`;
      const cmdName = `${MAILBOX_CMD_PREFIX}${id}${MAILBOX_JSON_SUFFIX}`;
      if (present.has(processingName)) targets.push(processingName);
      if (present.has(cmdName)) targets.push(cmdName);
      const removal = await _removeRemoteFiles(
        targets.map((name) => `${mailboxDir}/${name}`)
      );
      if (removal.ok) {
        report.deleted.push(...targets);
      } else {
        report.failed.push({ name: resultName, error: removal.error || 'unknown' });
        unsettledResultIds.add(id);
      }
    }

    const consumed = new Set(resultIds.filter((id) => !unsettledResultIds.has(id)));
    for (const id of processingIds) {
      if (consumed.has(id)) continue;
      const processingName = `${MAILBOX_PROCESSING_PREFIX}${id}${MAILBOX_JSON_SUFFIX}`;
      if (!confirmed.has(id)) {
        report.kept.push({ name: processingName, reason: 'processing_leftover_unconfirmed' });
        continue;
      }
      if (dryRun) {
        report.kept.push({ name: processingName, reason: 'dry_run_would_delete' });
        continue;
      }
      const removal = await _removeRemoteFiles([`${mailboxDir}/${processingName}`]);
      if (removal.ok) report.deleted.push(processingName);
      else report.failed.push({ name: processingName, error: removal.error || 'unknown' });
    }

    for (const id of cmdIds) {
      if (consumed.has(id)) continue;
      report.kept.push({
        name: `${MAILBOX_CMD_PREFIX}${id}${MAILBOX_JSON_SUFFIX}`,
        reason: 'cmd_unprocessed',
      });
    }

    return report;
  }

  return { call, sweep, createId, buildMailboxRemotePaths };
}

module.exports = {
  MAILBOX_CMD_PREFIX,
  MAILBOX_RESULT_PREFIX,
  MAILBOX_JSON_SUFFIX,
  MAX_MAILBOX_PAYLOAD_BYTES,
  PREVIEW_MAX_CHARS,
  harvestSummary,
  createMailboxId,
  buildMailboxFileNames,
  buildMailboxRemotePaths,
  buildMailboxCmdPayload,
  serializeMailboxCmdPayload,
  computeMailboxDeadline,
  parseMailboxResult,
  createPhoneBridgeMailbox,
};
