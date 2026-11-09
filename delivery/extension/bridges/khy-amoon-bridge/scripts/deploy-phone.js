#!/usr/bin/env node
'use strict';

/**
 * scripts/deploy-phone.js — push the phone onboarding bundle safely.
 *
 * Rotation is two-phase:
 *   1. issuePhone() creates a new phone token WITHOUT revoking old ones;
 *   2. bootstrap pushes token.txt (tmp+mv);
 *   3. only after a verified push does commitPhoneRotation(record_id) revoke
 *      the old phone tokens.
 * A failed push therefore leaves the previous token valid.
 *
 * It never prints the token, never touches the operator token, and never sends
 * an amoon chat message. `--open-chat` only starts ChatMainActivity.
 */

const path = require('path');

const C = require('../lib/contracts');
const { loadConfig, ensureStateDirs } = require('../lib/config');
const { createLogger } = require('../lib/logger');
const { createAdbTransport } = require('../lib/adb');
const { createTokenStore } = require('../lib/auth');
const { createBootstrap } = require('../lib/bootstrap');

const CHAT_ACTIVITY = 'com.stepos.ailauncher/.chat.activity.ChatMainActivity';
const OPEN_CHAT_ACTION = 'com.stepos.ailauncher.action.OPEN_CHAT';

/**
 * @param {{
 *   config: object,
 *   adb: object,
 *   tokenStore: object,
 *   assetsDir?: string,
 *   serial?: string,
 *   rotate?: boolean,
 *   openChat?: boolean,
 *   port?: number,
 * }} options
 */
async function deploy(options) {
  const config = options.config;
  const tokenStore = options.tokenStore;
  const adb = options.adb;
  const issued = tokenStore.issuePhone();
  let rotationCommitted = false;
  let report = null;
  let error = null;

  try {
    const bootstrap = createBootstrap({
      config,
      adb,
      assetsDir: options.assetsDir || path.join(__dirname, '..', 'phone'),
    });
    report = await bootstrap.run({
      token: issued.token,
      port: options.port || config.port,
      force: options.rotate === true,
    });
    if (report && report.token && report.token.pushed) {
      tokenStore.commitPhoneRotation(issued.record.id);
      rotationCommitted = true;
    }
  } catch (err) {
    error = { code: err.code || 'internal_error', message: err.message };
  }

  let chatStarted = null;
  if (options.openChat) {
    try {
      const result = await adb.shell(
        `am start -W -a ${OPEN_CHAT_ACTION} -n ${CHAT_ACTIVITY}`,
        { timeoutMs: 15000, maxBytes: 64 * 1024 }
      );
      chatStarted = result.exit === 0;
    } catch {
      chatStarted = false;
    }
  }

  return {
    ok: Boolean(report && report.ok && rotationCommitted),
    token: {
      record_id: issued.record.id,
      expires_at: issued.expiresAt,
      pushed: Boolean(report && report.token && report.token.pushed),
      rotation_committed: rotationCommitted,
      note: rotationCommitted
        ? '新 token 已推送并提交；旧 phone token 已失效。'
        : '新 token 未确认推送；旧 phone token 仍有效（未提交轮换）。',
    },
    chat_started: chatStarted,
    bootstrap: report,
    error,
  };
}

function parseArgs(argv) {
  const flags = { rotate: false, openChat: false, json: false, serial: null, stateDir: null, port: null, assetsDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--rotate') flags.rotate = true;
    else if (arg === '--open-chat') flags.openChat = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--serial') flags.serial = argv[++i] || null;
    else if (arg === '--state-dir') flags.stateDir = argv[++i] || null;
    else if (arg === '--port') flags.port = Number(argv[++i]);
    else if (arg === '--assets-dir') flags.assetsDir = argv[++i] || null;
  }
  return flags;
}

async function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  const config = loadConfig({ stateDir: flags.stateDir || undefined });
  if (Number.isInteger(flags.port) && flags.port > 0) config.port = flags.port;
  if (flags.serial) config.serial = flags.serial;
  ensureStateDirs(config);
  const logger = createLogger({ level: config.log.level, file: null });
  const adb = createAdbTransport({ config, logger, serial: flags.serial || config.serial || undefined });
  const tokenStore = createTokenStore({ config, logger });
  const result = await deploy({
    config,
    adb,
    tokenStore,
    assetsDir: flags.assetsDir || undefined,
    serial: flags.serial || undefined,
    rotate: flags.rotate,
    openChat: flags.openChat,
    port: config.port,
  });
  if (flags.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 3;
}

module.exports = { deploy, main, CHAT_ACTIVITY, OPEN_CHAT_ACTION };

if (require.main === module) {
  main().then(
    (code) => { process.exitCode = code; },
    (err) => {
      process.stderr.write(`deploy-phone failed: ${err && err.stack ? err.stack : err}\n`);
      process.exitCode = 1;
    }
  );
}
