'use strict';

/**
 * bridge-tools.js — the 6 wire tools that no single module owned:
 * ping, bridge_status, khy_ask, amoon_send, amoon_inbox, mailbox_status.
 *
 * phone_screenshot / phone_ui_dump come from lib/phone-tools.js; the other two
 * phone tools in the contract are Phase 1 names implemented there. Local tools
 * (exec/read/...) stay in lib/local-tools.js and are only registered for the
 * operator scope by lib/registry.js.
 *
 * Every handler here returns a plain object on success and THROWS a BridgeError
 * on failure. lib/registry.js normalizes phone-tools' {ok:false,error} results
 * into the same throwing form so HTTP/MCP see one error shape.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const C = require('./contracts');
const { shQuote } = require('./adb');

const AMOON_PACKAGE = 'com.stepos.ailauncher';
const SHARE_ACTIVITY = '.chat.activity.ShareActivity';
const CHAT_ACTIVITY = '.chat.activity.ChatMainActivity';
const OPEN_CHAT_ACTION = 'com.stepos.ailauncher.action.OPEN_CHAT';

function silentLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function asObject(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new C.BridgeError('invalid_args', '参数必须是 JSON 对象');
  }
  return value;
}

function requireString(value, name, min, max) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new C.BridgeError('invalid_args', `${name} 必须是 ${min}..${max} 字符的字符串`);
  }
  return value;
}

function optionalBoolean(value, name, def) {
  if (value === undefined || value === null) return def;
  if (typeof value !== 'boolean') throw new C.BridgeError('invalid_args', `${name} 必须是布尔值`);
  return value;
}

function optionalInt(value, name, min, max, def) {
  if (value === undefined || value === null) return def;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new C.BridgeError('invalid_args', `${name} 必须是 ${min}..${max} 的整数`);
  }
  return number;
}

function assertKnownKeys(args, allowed) {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      throw new C.BridgeError('invalid_args', `不支持的参数：${key}`);
    }
  }
}

/**
 * Read %LOCALAPPDATA%/khy-amoon-bridge/capability.json (Phase 0 evidence).
 * Missing or corrupt evidence is unverified, never "verified".
 */
function readCapability(config) {
  const file = config && config.paths ? config.paths.capability : null;
  const fallback = {
    status: C.CAPABILITY_STATUS.UNVERIFIED,
    amoonToPc: C.CAPABILITY_STATUS.UNVERIFIED,
    http: false,
    evidence: null,
    at: null,
    by: null,
  };
  if (!file) return fallback;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
  if (!data || typeof data !== 'object') return fallback;
  const status = Object.values(C.CAPABILITY_STATUS).includes(data.status)
    ? data.status
    : C.CAPABILITY_STATUS.UNVERIFIED;
  return { ...data, status, amoonToPc: status };
}

/**
 * @param {{
 *   config: object,
 *   adb: object,
 *   localTools: object,
 *   phoneTools: object,
 *   getMailbox?: ()=>object|null,
 *   getWireless?: ()=>object|null,
 *   getTasks?: ()=>object|null,
 *   getRuntime?: ()=>object,
 *   logger?: object,
 *   clock?: Function,
 * }} options
 * @returns {object} handlers keyed by wire tool name
 */
function createBridgeTools(options = {}) {
  const config = options.config || {};
  const adb = options.adb || null;
  const localTools = options.localTools || null;
  const phoneTools = options.phoneTools || null;
  const logger = options.logger || silentLogger();
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const getMailbox = typeof options.getMailbox === 'function' ? options.getMailbox : () => null;
  const getWireless = typeof options.getWireless === 'function' ? options.getWireless : () => null;
  const getTasks = typeof options.getTasks === 'function' ? options.getTasks : () => null;
  const getRuntime = typeof options.getRuntime === 'function' ? options.getRuntime : () => ({});
  const startedAt = clock();

  function requireAdb() {
    if (!adb || typeof adb.shell !== 'function' || typeof adb.push !== 'function') {
      throw new C.BridgeError('adb_unavailable', 'ADB transport 未就绪，手机/amoon 操作不可用。');
    }
    return adb;
  }

  function remoteRoot() {
    return (config.remote && config.remote.root) || C.REMOTE_ROOT;
  }

  // ── ping ────────────────────────────────────────────────────────────────

  async function ping(args) {
    assertKnownKeys(asObject(args), []);
    return {
      pong: true,
      ts: iso(clock()),
      pid: process.pid,
      version: C.BRIDGE_VERSION,
      protocol: C.PROTOCOL,
    };
  }

  // ── bridge_status ───────────────────────────────────────────────────────

  async function bridgeStatus(rawArgs, ctx = {}) {
    const args = asObject(rawArgs);
    assertKnownKeys(args, ['verbose']);
    const verbose = optionalBoolean(args.verbose, 'verbose', false);

    const wireless = getWireless();
    const mailbox = getMailbox();
    const tasks = getTasks();
    const runtime = getRuntime() || {};
    const adbSnapshot = wireless && typeof wireless.snapshot === 'function' ? wireless.snapshot() : {};
    const localStatus = localTools && typeof localTools.status === 'function' ? localTools.status() : {};
    const mailboxStatus = mailbox && typeof mailbox.status === 'function' ? mailbox.status() : null;
    const taskStatus = tasks && typeof tasks.status === 'function' ? tasks.status() : null;
    const capability = readCapability(config);

    const data = {
      version: C.BRIDGE_VERSION,
      protocol: C.PROTOCOL,
      pid: process.pid,
      started_at: runtime.started_at || iso(startedAt),
      uptime_s: Math.max(0, Math.round((clock() - startedAt) / 1000)),
      port: runtime.port || config.port || C.DEFAULTS.port,
      state: adbSnapshot.state || C.STATES.STOPPED,
      reasons: adbSnapshot.reasons || [],
      adb: {
        state: adbSnapshot.state || C.STATES.STOPPED,
        serial: adbSnapshot.serial || config.serial || null,
        model: adbSnapshot.model || null,
        sdk: adbSnapshot.sdk || null,
        reverse: adbSnapshot.reverse || null,
        last_error: adbSnapshot.lastError || null,
        last_seen: adbSnapshot.lastSeen || null,
        command: config.adb ? config.adb.command : null,
      },
      mailbox: mailboxStatus
        ? {
            running: mailboxStatus.running,
            inflight: mailboxStatus.inflight,
            last_poll_at: mailboxStatus.last_poll_at,
            last_error: mailboxStatus.last_error,
            counters: mailboxStatus.counters,
            root: mailboxStatus.root,
            dirs: mailboxStatus.dirs,
          }
        : { running: false, note: 'mailbox poller 未装配' },
      tasks: taskStatus,
      khy: {
        js: config.khy ? config.khy.js : null,
        configured: Boolean(config.khy && config.khy.js),
        phone_ask_enabled: Boolean(config.allowPhoneAsk),
        high_risk_enabled: Boolean(config.allowHighRisk),
      },
      capabilities: {
        amoonToPc: capability.amoonToPc,
        status: capability.status,
        // Raw Phase 0 field only: a verified status must not imply HTTP.
        http: capability.http === true,
        shell: capability.shell === true,
        file_write: capability.fileWrite === true,
        file_read: capability.fileRead === true,
        doze_writer: capability.dozeWriter === true,
        at: capability.at || null,
        by: capability.by || null,
      },
      counters: {
        local: localStatus.counters || null,
        mailbox: mailboxStatus ? mailboxStatus.counters : null,
      },
      security: {
        loopback_only: true,
        file_scope_tools: C.TOOL_POLICY.fileScope.tools,
        allow_phone_ask: Boolean(config.allowPhoneAsk),
        allow_high_risk: Boolean(config.allowHighRisk),
      },
    };

    if (verbose) {
      data.state_dir = config.stateDir || null;
      data.tools = C.listToolNames();
      data.mailbox_workers = mailboxStatus ? mailboxStatus.workers : null;
    }

    // phone/file callers get no serial, paths, command line, state dir, task
    // state dir or tool inventory beyond what their scope can call.
    const scope = (ctx && ctx.principal && ctx.principal.scope) || C.SCOPES.FILE;
    if (scope !== C.SCOPES.OPERATOR) {
      delete data.state_dir;
      delete data.tools;
      delete data.adb.command;
      delete data.adb.serial;
      delete data.khy.js;
      if (data.tasks && typeof data.tasks === 'object') delete data.tasks.state_dir;
      if (data.mailbox) {
        delete data.mailbox.root;
        delete data.mailbox.dirs;
      }
    }

    return data;
  }

  // ── khy_ask ─────────────────────────────────────────────────────────────

  async function khyAsk(rawArgs, ctx = {}) {
    if (!localTools || typeof localTools.call !== 'function') {
      throw new C.BridgeError('not_implemented', 'khy_ask 未接线：local-tools 未装配');
    }
    const args = { ...asObject(rawArgs) };
    assertKnownKeys(args, ['question', 'cwd', 'max_turns', 'timeout_ms', 'allowed_tools']);

    const descriptor = C.getTool('khy_ask');
    const scope = (ctx && ctx.principal && ctx.principal.scope) || C.SCOPES.OPERATOR;
    if (scope === C.SCOPES.PHONE) {
      if (!config.allowPhoneAsk) {
        throw new C.BridgeError(
          'phone_ask_disabled',
          '手机侧 khy_ask 默认关闭（需 KHY_AMOON_PHONE_ASK=1）。'
        );
      }
      args.max_turns = 1;
      args.cwd = '';
      args.allowed_tools = [C.TOOL_POLICY.sentinelTool];
      args.timeout_ms = Math.min(optionalInt(args.timeout_ms, 'timeout_ms', 1000, 120000, 30000), 30000);
    }

    const question = requireString(args.question, 'question', 1, 8000);
    args.question = question;
    const timeoutMs = optionalInt(args.timeout_ms, 'timeout_ms', 1000, 120000, descriptor.timeoutMs);

    const started = clock();
    const queued = await localTools.call('khy.ask', args, {
      requestId: ctx.requestId,
      source: ctx.source || 'http',
      signal: ctx.signal,
    });
    const pending = queued && queued.data ? queued.data : null;
    if (!pending || pending.pending !== true || typeof pending.job_id !== 'string') {
      throw new C.BridgeError('internal_error', 'khy_ask 队列未返回 job id');
    }

    const job = await localTools.waitForJob(pending.job_id, timeoutMs + 2000, ctx.signal);
    if (job.state === 'done') {
      const result = job.result || {};
      return {
        ...result,
        duration_ms: result.duration_ms !== undefined ? result.duration_ms : clock() - started,
        job_id: job.id,
      };
    }
    if (job.state === 'failed') {
      const code = job.error && job.error.code ? job.error.code : 'internal_error';
      throw new C.BridgeError(
        code,
        (job.error && job.error.message) || 'khy_ask 失败',
        { job_id: job.id, ...(job.error && job.error.details ? job.error.details : {}) }
      );
    }
    if (job.state === 'cancelled') {
      throw new C.BridgeError('timeout', 'khy_ask 已取消', { job_id: job.id });
    }
    throw new C.BridgeError('timeout', `khy_ask 在 ${timeoutMs}ms 内未完成`, { job_id: job.id });
  }

  // ── amoon_send ──────────────────────────────────────────────────────────

  function writeSpool(config, fileName, value) {
    const dir = config.paths.dirs.outbox;
    fs.mkdirSync(dir, { recursive: true });
    const final = path.join(dir, fileName);
    const tmp = `${final}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, final);
    return final;
  }

  /**
   * Retire a delivered spool envelope from the retry set. Archiving under
   * outbox/sent keeps the audit trail; if the move fails we delete instead so
   * a later flushOutbox cannot duplicate a message that was already delivered.
   * Returns true only when the envelope is no longer in the retry set.
   */
  function retireSpoolFile(localPath) {
    if (!localPath) return false;
    const dir = path.dirname(localPath);
    const base = path.basename(localPath);
    try {
      const sentDir = path.join(dir, 'sent');
      fs.mkdirSync(sentDir, { recursive: true });
      fs.renameSync(localPath, path.join(sentDir, base));
      return true;
    } catch (moveErr) {
      try {
        fs.rmSync(localPath, { force: true });
        return true;
      } catch (removeErr) {
        logger.warn('amoon_send: spool file could not be retired', {
          path: localPath,
          move_error: moveErr && moveErr.message ? moveErr.message : String(moveErr),
          remove_error: removeErr && removeErr.message ? removeErr.message : String(removeErr),
        });
        return false;
      }
    }
  }

  async function runAm(args, extraArgs, timeoutMs = 15000) {
    const transport = requireAdb();
    const command = `am start -W ${extraArgs}`;
    const result = await transport.shell(command, { timeoutMs, maxBytes: 64 * 1024 });
    if (result.timedOut) {
      throw new C.BridgeError('timeout', `am start 超时（${args}）`);
    }
    return result;
  }

  async function sendIntent(text) {
    const extra = `-a android.intent.action.SEND -t text/plain -n ${AMOON_PACKAGE}/${SHARE_ACTIVITY} --es android.intent.extra.TEXT ${shQuote(text)}`;
    const result = await runAm('send', extra);
    return {
      sent: result.exit === 0,
      exit: result.exit,
      stderr: result.exit === 0 ? '' : String(result.stderr || '').trim().slice(0, 300),
    };
  }

  async function openChat() {
    const extra = `-a ${OPEN_CHAT_ACTION} -n ${AMOON_PACKAGE}/${CHAT_ACTIVITY}`;
    const result = await runAm('open-chat', extra);
    return { started: result.exit === 0, exit: result.exit };
  }

  async function amoonSend(rawArgs) {
    const args = asObject(rawArgs);
    assertKnownKeys(args, ['text', 'mode', 'open_chat', 'requires_ack']);
    const text = requireString(args.text, 'text', 1, 4000);
    const mode = args.mode === undefined ? 'file' : args.mode;
    if (!['file', 'intent', 'both'].includes(mode)) {
      throw new C.BridgeError('invalid_args', 'mode 只能是 file/intent/both');
    }
    const open = optionalBoolean(args.open_chat, 'open_chat', false);
    const requiresAck = optionalBoolean(args.requires_ack, 'requires_ack', true);

    const id = crypto.randomUUID();
    const now = clock();
    const fileName = `msg_${id}.json`;
    const envelope = {
      v: 1,
      id,
      kind: 'text',
      text,
      ts: iso(now),
      expires_at: iso(now + C.LIMITS.idempotencyTtlMs),
      requires_ack: requiresAck,
    };
    const needsFile = mode === 'file' || mode === 'both';
    const localPath = needsFile ? writeSpool(config, fileName, envelope) : null;

    let pushed = false;
    let remotePath = null;
    let pushError = null;
    if (mode === 'file' || mode === 'both') {
      const transport = requireAdb();
      const root = remoteRoot();
      const tmpPath = `${root}/tmp/${fileName}.tmp`;
      remotePath = C.remotePath(C.REMOTE_DIRS.outbox, fileName);
      try {
        const mk = await transport.shell(
          `mkdir -p ${shQuote(`${root}/outbox`)} ${shQuote(`${root}/tmp`)}`,
          { timeoutMs: 10000, maxBytes: 16 * 1024 }
        );
        if (mk.exit !== 0) throw new C.BridgeError('adb_unavailable', '无法创建手机 outbox/tmp 目录');
        await transport.push(localPath, tmpPath, { timeoutMs: 30000 });
        const mv = await transport.shell(
          `mv -f ${shQuote(tmpPath)} ${shQuote(remotePath)}`,
          { timeoutMs: 10000, maxBytes: 16 * 1024 }
        );
        if (mv.exit !== 0) {
          throw new C.BridgeError('internal_error', '手机端 mv 失败（outbox 未写入）');
        }
        pushed = true;
      } catch (err) {
        pushError = C.isBridgeError(err)
          ? err
          : new C.BridgeError('adb_unavailable', err && err.message ? err.message : String(err));
        if (mode === 'file') {
          throw new C.BridgeError(pushError.code, pushError.message, {
            id,
            state: 'queued',
            local_path: localPath,
          });
        }
        logger.warn('amoon_send: file push failed; continuing with intent', {
          id,
          error: pushError.message,
        });
      }
    }

    let intentSent = false;
    let intentError = null;
    if (mode === 'intent' || mode === 'both') {
      try {
        const intent = await sendIntent(text);
        intentSent = intent.sent;
        if (!intent.sent) intentError = intent.stderr || `am start 退出码 ${intent.exit}`;
      } catch (err) {
        intentError = err && err.message ? err.message : String(err);
        if (mode === 'intent') {
          throw new C.BridgeError('adb_unavailable', `Intent 发送失败：${intentError}`, { id, state: 'failed' });
        }
      }
    }

    const delivered = pushed || intentSent;
    const spoolRetired = delivered ? retireSpoolFile(localPath) : false;

    let chatStarted = null;
    if (open) {
      try {
        chatStarted = (await openChat()).started;
      } catch (err) {
        chatStarted = false;
        logger.warn('amoon_send: open_chat failed', { error: err && err.message });
      }
    }

    return {
      id,
      state: pushed ? 'pushed' : intentSent ? 'sent' : 'queued',
      channel: mode,
      intent_sent: intentSent,
      intent_error: intentError,
      open_chat: chatStarted,
      requires_ack: requiresAck,
      verified: false,
      local_path: localPath,
      spool_retired: spoolRetired,
      remote_path: remotePath,
      push_error: pushError ? pushError.message : null,
    };
  }

  /**
   * Re-deliver messages left in the local spool by a failed amoon_send.
   * Called when wireless reaches HEALTHY; successful files move to spool/sent.
   * @returns {Promise<{sent:number,failed:number}>}
   */
  async function flushOutbox() {
    const dir = config.paths && config.paths.dirs ? config.paths.dirs.outbox : null;
    if (!dir) return { sent: 0, failed: 0 };
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((name) => /^msg_[A-Za-z0-9_-]{8,64}\.json$/.test(name));
    } catch {
      return { sent: 0, failed: 0 };
    }
    let sent = 0;
    let failed = 0;
    const transport = requireAdb();
    const root = remoteRoot();
    for (const name of names) {
      const local = path.join(dir, name);
      const remoteFinal = C.remotePath(C.REMOTE_DIRS.outbox, name);
      const remoteTmp = `${root}/tmp/${name}.tmp`;
      try {
        await transport.shell(`mkdir -p ${shQuote(`${root}/outbox`)} ${shQuote(`${root}/tmp`)}`, {
          timeoutMs: 10000,
          maxBytes: 16 * 1024,
        });
        await transport.push(local, remoteTmp, { timeoutMs: 30000 });
        const mv = await transport.shell(`mv -f ${shQuote(remoteTmp)} ${shQuote(remoteFinal)}`, {
          timeoutMs: 10000,
          maxBytes: 16 * 1024,
        });
        if (mv.exit !== 0) throw new C.BridgeError('internal_error', '手机端 mv 失败');
        if (!retireSpoolFile(local)) {
          throw new C.BridgeError('internal_error', '本地 spool 清理失败');
        }
        sent += 1;
      } catch (err) {
        failed += 1;
        logger.warn('spool re-delivery failed', { name, error: err && err.message });
      }
    }
    return { sent, failed };
  }

  // ── amoon_inbox ─────────────────────────────────────────────────────────

  async function amoonInbox(rawArgs) {
    const args = asObject(rawArgs);
    assertKnownKeys(args, ['since', 'limit']);
    const limit = optionalInt(args.limit, 'limit', 1, 100, 20);
    let sinceMs = null;
    if (args.since !== undefined && args.since !== null) {
      sinceMs = Date.parse(String(args.since));
      if (!Number.isFinite(sinceMs)) {
        throw new C.BridgeError('invalid_args', 'since 必须是可解析的时间字符串');
      }
    }

    const dir = config.paths.dirs.replies;
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
    } catch {
      names = [];
    }

    const messages = [];
    let skipped = 0;
    for (const name of names) {
      const full = path.join(dir, name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        skipped += 1;
        continue;
      }
      if (!stat.isFile() || stat.size > C.LIMITS.resultBytes) {
        skipped += 1;
        continue;
      }
      let body;
      try {
        body = JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch {
        skipped += 1;
        continue;
      }
      if (!body || typeof body !== 'object') {
        skipped += 1;
        continue;
      }
      const ts = typeof body.ts === 'string' ? body.ts : iso(stat.mtimeMs);
      const tsMs = Date.parse(ts);
      if (sinceMs !== null && (!Number.isFinite(tsMs) || tsMs < sinceMs)) continue;
      messages.push({
        id: typeof body.id === 'string' ? body.id : name.replace(/\.json$/, ''),
        kind: typeof body.kind === 'string' ? body.kind : name.startsWith('ack_') ? 'ack' : 'reply',
        text: typeof body.text === 'string' ? body.text : null,
        ts,
        status: typeof body.status === 'string' ? body.status : 'received',
        unverified: true,
      });
    }

    messages.sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0));
    return {
      messages: messages.slice(0, limit),
      count: Math.min(messages.length, limit),
      total: messages.length,
      skipped,
      unverified: true,
    };
  }

  // ── mailbox_status ──────────────────────────────────────────────────────

  async function mailboxStatus(rawArgs, ctx = {}) {
    assertKnownKeys(asObject(rawArgs), []);
    const mailbox = getMailbox();
    const wireless = getWireless();
    const tasks = getTasks();
    const snapshot = wireless && typeof wireless.snapshot === 'function' ? wireless.snapshot() : {};
    const capability = readCapability(config);
    const state = snapshot.state || C.STATES.STOPPED;

    const data = {
      running: mailbox ? mailbox.status().running : false,
      adb_ok: state === C.STATES.HEALTHY || state === C.STATES.DEGRADED_REVERSE,
      state,
      last_poll: mailbox ? mailbox.status().last_poll_at : null,
      last_error: mailbox ? mailbox.status().last_error : null,
      capabilities: {
        amoonToPc: capability.amoonToPc,
        status: capability.status,
      },
      tasks: tasks ? tasks.status() : null,
    };
    if (mailbox) {
      const status = mailbox.status();
      const counts = status.counts || {};
      data.inbox = counts.inbox === undefined ? null : counts.inbox;
      data.working = counts.working === undefined ? null : counts.working;
      data.outbox = counts.outbox === undefined ? null : counts.outbox;
      data.done = counts.done === undefined ? null : counts.done;
      data.failed = counts.failed === undefined ? null : counts.failed;
      data.ack = counts.ack === undefined ? null : counts.ack;
      data.scanned_total = status.counters ? status.counters.scanned : null;
      data.counts_note =
        'inbox/working 是最近一次轮询的实时深度；outbox/done/failed/ack 未逐步计数（null）。scanned_total 是累计扫描数。';
      data.counters = status.counters;
      data.root = status.root;
      data.dirs = status.dirs;
      data.inflight = status.inflight;
    }

    const scope = (ctx && ctx.principal && ctx.principal.scope) || C.SCOPES.FILE;
    if (scope !== C.SCOPES.OPERATOR) {
      delete data.root;
      delete data.dirs;
      if (data.tasks && typeof data.tasks === 'object') delete data.tasks.state_dir;
    }
    return data;
  }

  // ── facades ─────────────────────────────────────────────────────────────

  const handlers = {
    ping,
    bridge_status: bridgeStatus,
    khy_ask: khyAsk,
    amoon_send: amoonSend,
    amoon_inbox: amoonInbox,
    mailbox_status: mailboxStatus,
  };

  // phone tools return {ok:true,...}/{ok:false,error}; registry normalizes them.
  if (phoneTools) {
    for (const name of [
      'phone_screenshot',
      'phone_ui_dump',
      'phone_info',
      'phone_app_list',
      'phone_ls',
      'phone_exec',
    ]) {
      if (typeof phoneTools[name] === 'function') handlers[name] = phoneTools[name];
    }
  }

  return {
    handlers,
    flushOutbox,
    readCapability: () => readCapability(config),
  };
}

/**
 * Build the bridge handlers from the frozen ToolContext shape
 * ({config, adb, localTools, phoneTools, mailbox, wireless, tasks, ...}).
 * Used by the contract-path shims under lib/tools/.
 *
 * @param {object} [ctx]
 */
function createBridgeToolsFromContext(ctx = {}) {
  const valueOf = (candidate) => (typeof candidate === 'function' ? candidate : () => candidate || null);
  return createBridgeTools({
    config: ctx.config || {},
    adb: ctx.adb || null,
    localTools: ctx.localTools || null,
    phoneTools: ctx.phoneTools || null,
    getMailbox: valueOf(ctx.mailbox),
    getWireless: valueOf(ctx.wireless),
    getTasks: valueOf(ctx.tasks),
    getRuntime: valueOf(ctx.runtime),
    logger: ctx.logger,
    clock: ctx.clock,
  });
}

module.exports = {
  AMOON_PACKAGE,
  SHARE_ACTIVITY,
  CHAT_ACTIVITY,
  OPEN_CHAT_ACTION,
  createBridgeTools,
  createBridgeToolsFromContext,
  readCapability,
};
