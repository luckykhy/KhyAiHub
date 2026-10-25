'use strict';

/**
 * stepneoCloud/config.js — env resolution for the cloud gateway (single source).
 *
 * WHY THIS FILE EXISTS RATHER THAN READING process.env AT CALL SITES. The tool,
 * the CLI handler and the session builder all need the same six values with the
 * same defaults and the same refusals. Reading env in three places is how
 * "works from the CLI, mysteriously fails from the tool" happens.
 *
 * R2: the app secret is read from env or from a file path in env, never from
 * source and never written anywhere. A missing secret is a refusal, not a
 * default — a silently-wrong secret produces 401s that read as an expired token.
 */

const { PROD_APP_ID, DEFAULT_BASE_URL } = require('./signing');
const { DEFAULT_MAX_ROUNDS } = require('./agentLoop');

/** Gate flag. Single source is here, not flagRegistry — see README. */
const GATE_ENV = 'STEPNEO_ENABLED';

const FALSY = new Set(['0', 'false', 'off', 'no', 'disabled']);

function _bool(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  return !FALSY.has(String(raw).trim().toLowerCase());
}

function _int(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Resolve the cloud gateway config.
 *
 * `adbExecutable` / `serial` are taken from the phone bridge config rather than
 * redefined here: the token has to come off the same device the tools act on, so
 * a second serial env var would be a second answer to "which phone".
 */
function resolveStepneoConfig(env = process.env) {
  // The phone bridge config is called WITH the probe. Without it,
  // resolveAdbExecutable returns the bare name `adb.exe`, which only works when
  // adb is on PATH — on this machine it is not (it lives under
  // ~/.khyos/android_sdk/platform-tools), so the token fetch would fail with
  // ENOENT and nothing pointing at the real binary.
  let phone = {};
  try {
    const phoneConfig = require('../phone/phoneBridgeConfig');
    phone = phoneConfig.resolvePhoneBridgeConfig(env, {
      hasExecutable: phoneConfig.defaultExecutableProbe,
    }) || {};
  } catch {
    // The phone unit is a sibling in the same domain and always present. If it
    // somehow is not, fall back to bare defaults rather than failing to load.
    phone = {};
  }

  return {
    enabled: _bool(env[GATE_ENV], true),
    appSecret: _readString(env.STEPNEO_APP_SECRET),
    appSecretFile: _readString(env.STEPNEO_APP_SECRET_FILE),
    token: _readString(env.STEPNEO_TOKEN),
    baseUrl: _readString(env.STEPNEO_BASE_URL) || DEFAULT_BASE_URL,
    appId: _readString(env.STEPNEO_APP_ID) || PROD_APP_ID,
    maxRounds: _int(env.STEPNEO_MAX_ROUNDS, DEFAULT_MAX_ROUNDS),
    // UI tools are advertised by default but refused by the bridge unless the
    // accessibility service is up. Advertising them lets the model learn that
    // from a real refusal; hiding them makes it guess the capability is absent.
    includeUi: _bool(env.STEPNEO_INCLUDE_UI, true),
    adbExecutable: phone.adbExecutable || 'adb',
    serial: phone.serial || '',
    localPort: phone.localPort || phone.httpPort || 18896,
  };
}

function _readString(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

/**
 * Read the app secret, from env or from the file named in env.
 *
 * Synchronous on purpose: this runs once per session build, and the async
 * variant would push a promise through every caller for no benefit.
 *
 * @returns {{ok: true, secret: string, source: string}
 *          |{ok: false, code: string, error: string}}
 */
function readAppSecret(config) {
  // Trimmed here rather than trusted from the caller. A trailing newline from a
  // copy-paste changes the HMAC and 401s every single request, with nothing in
  // the error pointing at the cause — so the function that produces the secret
  // is the one that has to guarantee its shape.
  const inline = _readString(config && config.appSecret);
  if (inline) return { ok: true, secret: inline, source: 'env:STEPNEO_APP_SECRET' };

  const file = config && config.appSecretFile;
  if (file) {
    try {
      const fs = require('node:fs');
      const text = fs.readFileSync(file, 'utf8').trim();
      if (text) return { ok: true, secret: text, source: `file:${file}` };
      return { ok: false, code: 'APP_SECRET_EMPTY_FILE', error: `密钥文件是空的：${file}` };
    } catch (e) {
      return {
        ok: false,
        code: 'APP_SECRET_FILE_UNREADABLE',
        error: `读不到密钥文件 ${file}：${e && e.message}`,
      };
    }
  }

  return {
    ok: false,
    code: 'APP_SECRET_REQUIRED',
    error: '缺少应用签名密钥。设 STEPNEO_APP_SECRET，或把密钥写进文件后设 '
      + 'STEPNEO_APP_SECRET_FILE 指向它。密钥不落源码、不进提交。',
  };
}

module.exports = {
  GATE_ENV,
  resolveStepneoConfig,
  readAppSecret,
};
