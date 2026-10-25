'use strict';

/**
 * stepneoCloud/accountToken.js — read the account token from the phone's own
 * account-service log (parser is pure; the adb shell is injectable).
 *
 * WHY THIS EXISTS AT ALL. The upstream needs a bearer token that only the phone
 * holds. There is no refresh endpoint: the token is issued by the phone's account
 * service and the client cannot see its expiry. So the only way to get a fresh
 * one is to read the one the phone already issued for itself.
 *
 * WHY IT IS NOT A CREDENTIAL THEFT PATH. The parser reads a diagnostic log line
 * the account service already printed for the AIEngine / Ability packages — the
 * same packages that are entitled to this token. It never touches the account
 * password, never writes to the phone, and the value is held in memory only.
 * R2: the token is never persisted to source, config or a commit.
 *
 * The token is self-describing base64 JSON. There is no `exp` field, so its
 * lifetime can only be observed, not computed — hence ageHours() rather than
 * any expiry check.
 */

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);

/** Log tag the account service prints under. */
const ACCOUNT_LOG_TAG = '[Cloud]Account:V';

/**
 * Packages entitled to an account token, most preferred first.
 *
 * Both are StepOS system packages; aiengine is the one that actually talks to
 * the model gateway, so it wins when both are present.
 */
const TOKEN_PACKAGES = ['com.stepos.aiengine', 'com.stepos.ability'];

/** Matches the threadtime prefix: date, time, pid, tid. */
const LOG_LINE = /^(\d\d-\d\d\s+\S+)\s+(\d+)\s+(\d+)\s+\w\s+/;

/**
 * Parse the account token out of a logcat dump.
 *
 * Pure: takes text, returns a result. The two-step correlation is the whole
 * trick and the part worth testing —
 *
 *   1. a `[getAuthToken] ... package = <pkg>, basic,` line marks a thread as one
 *      that fetched a BASIC (not full) auth token for a package we care about;
 *   2. a `local db token:` line in that SAME thread carries the value.
 *
 * Matching on the value alone would pick up tokens issued for packages that are
 * not entitled to them; matching without the `basic` marker would pick up the
 * full-account credential, which this service has no business holding.
 *
 * @param {string} stdout raw `logcat -d -v threadtime -s <tag>` output
 * @returns {{token: string, sourcePackage: string, observedAt: string}|null}
 */
function parseAccountToken(stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0) return null;

  const contexts = new Map();
  const candidates = new Map();

  for (const line of stdout.split(/\r?\n/)) {
    const stamp = line.match(LOG_LINE);
    if (!stamp) continue;
    const threadKey = `${stamp[2]}:${stamp[3]}`;

    if (line.includes('[getAuthToken]') && line.includes('package =')) {
      const pkg = line.match(/package =\s*([A-Za-z0-9_.]+)/)?.[1];
      if (pkg) {
        contexts.set(threadKey, { pkg, basic: /,\s*basic,/.test(line) });
      }
    }

    const context = contexts.get(threadKey);
    if (!context || !context.basic) continue;
    if (!TOKEN_PACKAGES.includes(context.pkg)) continue;
    if (!line.includes('local db token:')) continue;

    const value = line.split('local db token:')[1].trim();
    if (value && value !== 'null') {
      candidates.set(context.pkg, { token: value, observedAt: stamp[1] });
    }
  }

  const preferred = TOKEN_PACKAGES.find((pkg) => candidates.has(pkg));
  return preferred ? { ...candidates.get(preferred), sourcePackage: preferred } : null;
}

/**
 * Decode the token's self-describing JSON.
 *
 * The only fields consumed are `a` (device id, sent as zy-device-id) and `t`
 * (issue time, for the age display). Everything else is opaque and is returned
 * untouched so a caller can log the shape without this module interpreting it.
 *
 * @returns {{deviceId: string, issuedAt: number, ageHours: number, fields: string[]}|null}
 */
function decodeToken(token, { now = () => Date.now() } = {}) {
  if (typeof token !== 'string' || token.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const deviceId = typeof parsed.a === 'string' ? parsed.a : '';
  const issuedAt = typeof parsed.t === 'number' ? parsed.t : 0;
  return {
    deviceId,
    issuedAt,
    ageHours: issuedAt > 0 ? (now() - issuedAt) / 3600000 : null,
    fields: Object.keys(parsed),
    // No `exp` field exists. Anything that claims to know the expiry is guessing.
    hasExpiryField: 'exp' in parsed,
  };
}

/**
 * Pull a fresh token off the device over adb.
 *
 * `adb` and `exec` are injectable so the tests need no device. The read is
 * one-shot and non-mutating: `logcat -d` dumps and exits.
 */
async function readAccountTokenFromDevice({
  serial,
  adbExecutable = 'adb',
  exec = run,
  logTag = ACCOUNT_LOG_TAG,
} = {}) {
  const args = ['-s', serial, 'logcat', '-d', '-v', 'threadtime', '-s', logTag];
  let stdout;
  try {
    ({ stdout } = await exec(adbExecutable, args, {
      timeout: 30000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8',
    }));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { ok: false, code: 'ADB_MISSING', error: '找不到 adb；请安装 Android platform-tools。' };
    }
    return { ok: false, code: 'ADB_FAILED', error: `adb 读取账号日志失败：${error && error.message}` };
  }

  const found = parseAccountToken(stdout);
  if (!found) {
    return {
      ok: false,
      code: 'TOKEN_NOT_FOUND',
      error: '账号日志里没有找到已登录账号的 token；请先在手机原生助手里确认账号可正常问答，再重试。',
    };
  }

  const decoded = decodeToken(found.token);
  if (!decoded || !decoded.deviceId) {
    return { ok: false, code: 'TOKEN_UNDECODABLE', error: '取到的 token 不是可解码的自描述 JSON。' };
  }

  return {
    ok: true,
    token: found.token,
    deviceId: decoded.deviceId,
    sourcePackage: found.sourcePackage,
    observedAt: found.observedAt,
    ageHours: decoded.ageHours,
    fields: decoded.fields,
  };
}

module.exports = {
  ACCOUNT_LOG_TAG,
  TOKEN_PACKAGES,
  parseAccountToken,
  decodeToken,
  readAccountTokenFromDevice,
};
