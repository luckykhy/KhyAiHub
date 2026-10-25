'use strict';

/**
 * amooMailbox.js — file-mailbox fallback channel for the Amoo bridge.
 *
 * WHY it exists: the bridge's HTTP port can die (observed: one wedged `clipboard`
 * call froze the whole server until the process was revived). The bridge also
 * watches a directory on the phone: drop `cmd_<id>.json` in, pick up
 * `result_<id>.json`. That path survives an HTTP outage, so it is the fallback —
 * never the default.
 *
 * Two measured limits that shape this file:
 *   1. `BridgeService.loop()` handles cmd files single-threaded and in order, so
 *      ONE hung command freezes the mailbox for every later command. Never send
 *      something that can hang (`sleep 300`, an interactive shell) through here.
 *   2. The worker deletes the cmd file after handling it, so a missing cmd file
 *      means "already picked up", not "never arrived".
 *
 * Measured paths: the mailbox lives in /sdcard/bridge-amoobridge (NOT
 * /sdcard/bridge), and the bridge only becomes able to write there once
 * MANAGE_EXTERNAL_STORAGE is granted.
 *
 * Contract: no method throws; every method resolves to a result object.
 *
 * @module services/domain/network/amoo/amooMailbox
 */

const fs = require('fs');
const nodePath = require('path');

const { buildPushArgv, buildPullArgv, buildRemoveArgv, buildShellArgv } = require('./amooBridgePolicy');

const MAILBOX_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Build a mailbox command id. Deterministic when a seed is supplied (tests),
 * time-based otherwise.
 * @param {string} [prefix]
 * @param {string|number} [seed]
 * @returns {string}
 */
function buildMailboxId(prefix = 'khy', seed = null) {
  const safePrefix = String(prefix || 'khy').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16) || 'khy';
  if (seed !== null && seed !== undefined && String(seed).trim()) {
    const safeSeed = String(seed).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
    if (MAILBOX_ID_RE.test(safeSeed)) {
      return `${safePrefix}_${safeSeed}`;
    }
  }
  const stamp = Date.now().toString(36);
  const noise = Math.random().toString(36).slice(2, 8);
  return `${safePrefix}_${stamp}${noise}`;
}

/**
 * Serialise a mailbox command file. The body is written to disk and pushed as a
 * file, so no shell ever re-parses it — this is the UTF-8-safe path.
 * @param {{id:string, tool:string, args?:object, ts?:number}} command
 * @returns {string}
 */
function buildCommandFile(command) {
  return JSON.stringify({
    id: String(command.id),
    tool: String(command.tool),
    args: command.args && typeof command.args === 'object' ? command.args : {},
    ts: Number(command.ts) || Date.now(),
  });
}

/**
 * Parse a mailbox result file.
 * @param {string} raw
 * @returns {{ok:boolean, id:string|null, body:object|null, reason:string|null}}
 */
function parseResultFile(raw) {
  let parsed = null;
  try {
    parsed = JSON.parse(String(raw || ''));
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, id: null, body: null, reason: 'result_not_json' };
  }
  return {
    ok: true,
    id: typeof parsed.id === 'string' ? parsed.id : null,
    body: parsed,
    reason: null,
  };
}

/**
 * Decide whether the mailbox should be used for this attempt.
 * @param {{httpOk:boolean, mailboxEnabled:boolean, attempt:number}} state
 * @returns {boolean}
 */
function shouldUseMailbox(state = {}) {
  if (state.mailboxEnabled !== true) {
    return false;
  }
  if (state.httpOk === true) {
    return false;
  }
  return Number(state.attempt) >= 1;
}

class AmooBridgeMailbox {
  /**
   * @param {object} [opts]
   * @param {object} [opts.config] output of resolveAmooConfig
   * @param {object} [opts.client] an AmooBridgeClient (used for adb + fs paths)
   * @param {Function} [opts.sleep]
   * @param {Function} [opts.now]
   * @param {Function} [opts.getAppDataDir]
   */
  constructor(opts = {}) {
    this.config = opts.config;
    this.client = opts.client;
    this._sleep = typeof opts.sleep === 'function' ? opts.sleep : (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this._getAppDataDir =
      typeof opts.getAppDataDir === 'function' ? opts.getAppDataDir : null;
    this._lastError = null;
  }

  _localDir() {
    if (this._getAppDataDir) {
      return this._getAppDataDir(this.config.local.scratchSubdir, 'mailbox');
    }
    return nodePath.join(require('os').tmpdir(), 'khy-amoo-mailbox');
  }

  /**
   * Run one bridge tool through the mailbox.
   * @param {string} tool
   * @param {object} [args]
   * @param {{id?:string}} [opts]
   * @returns {Promise<{ok:boolean, status:'completed'|'timeout'|'failed',
   *                    id:string, body:object|null, error:string|null,
   *                    durationMs:number, waitedMs:number}>}
   */
  async call(tool, args = {}, opts = {}) {
    const id = buildMailboxId('khy', opts.id || null);
    const startedAt = this._now();
    const dir = this._localDir();
    fs.mkdirSync(dir, { recursive: true });
    const localCmd = nodePath.join(dir, `cmd_${id}.json`);
    const localResult = nodePath.join(dir, `result_${id}.json`);
    const remoteDir = this.config.mailbox.dir;
    const remoteCmd = `${remoteDir}/cmd_${id}.json`;
    const remoteResult = `${remoteDir}/result_${id}.json`;
    const serial = this.config.adb.serial;
    const deadlineMs = this.config.mailbox.timeoutMs;
    const pollMs = this.config.mailbox.pollMs;

    fs.writeFileSync(localCmd, buildCommandFile({ id, tool, args }), 'utf8');
    const pushed = await this.client.runAdb(buildPushArgv(serial, localCmd, remoteCmd));
    if (!pushed.ok) {
      this._lastError = pushed.error || 'push_failed';
      return {
        ok: false,
        status: 'failed',
        id,
        body: null,
        error: `命令文件推送失败：${(pushed.stderr || pushed.error || '').trim() || '未知原因'}`,
        durationMs: Math.max(0, this._now() - startedAt),
        waitedMs: 0,
      };
    }

    let waitedMs = 0;
    let lastRaw = '';
    while (waitedMs < deadlineMs) {
      await this._sleep(pollMs);
      waitedMs += pollMs;
      const pulled = await this.client.runAdb(buildPullArgv(serial, remoteResult, localResult));
      if (!pulled.ok) {
        continue;
      }
      let raw = '';
      try {
        raw = fs.readFileSync(localResult, 'utf8');
      } catch {
        continue;
      }
      if (!raw.trim()) {
        continue;
      }
      const parsed = parseResultFile(raw);
      if (!parsed.ok) {
        lastRaw = raw;
        continue;
      }
      await this._cleanup(serial, remoteResult, localCmd, localResult);
      const bodyOk = parsed.body && parsed.body.ok === true;
      return {
        ok: bodyOk,
        status: bodyOk ? 'completed' : 'failed',
        id,
        body: parsed.body,
        error: bodyOk ? null : String((parsed.body && parsed.body.error) || 'bridge_tool_error'),
        durationMs: Math.max(0, this._now() - startedAt),
        waitedMs,
      };
    }

    await this._cleanup(serial, remoteCmd, remoteResult, localCmd, localResult);
    this._lastError = 'mailbox_timeout';
    return {
      ok: false,
      status: 'timeout',
      id,
      body: null,
      error: `信箱等待超时（${deadlineMs}ms）${lastRaw ? `，末次读到 ${lastRaw.length} 字节非法内容` : ''}`,
      durationMs: Math.max(0, this._now() - startedAt),
      waitedMs,
    };
  }

  async _cleanup(serial, ...remoteAndLocal) {
    const remotes = remoteAndLocal.filter((value) => typeof value === 'string' && value.startsWith('/'));
    const locals = remoteAndLocal.filter((value) => typeof value === 'string' && !value.startsWith('/'));
    for (const remote of remotes) {
      await this.client.runAdb(buildRemoveArgv(serial, remote));
    }
    for (const local of locals) {
      try {
        fs.rmSync(local, { force: true });
      } catch {
        /* best effort */
      }
    }
  }

  /**
   * Cheap liveness read: the heartbeat file the bridge rewrites every ~2s.
   * @returns {Promise<{ok:boolean, raw:string, error:string|null}>}
   */
  async readHeartbeat() {
    const serial = this.config.adb.serial;
    const read = await this.client.runAdb(
      buildShellArgv(serial, `cat ${this.config.mailbox.dir}/status.json`)
    );
    if (!read.ok) {
      return { ok: false, raw: '', error: (read.stderr || read.error || '').trim() || 'status.json 读取失败' };
    }
    return { ok: true, raw: read.stdout, error: null };
  }

  lastError() {
    return this._lastError;
  }
}

module.exports = {
  AmooBridgeMailbox,
  buildMailboxId,
  buildCommandFile,
  parseResultFile,
  shouldUseMailbox,
  MAILBOX_ID_RE,
};
