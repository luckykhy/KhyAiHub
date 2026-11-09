'use strict';

/**
 * auth.js — operator / phone bearer tokens for the local bridge.
 *
 * Two layers:
 *
 *   1. The operator token file (operator.token). It holds one raw token, is
 *      created with an atomic write and its permissions are tightened on a
 *      best-effort basis (POSIX chmod 0600, Windows icacls). Verification is
 *      fail-closed: a missing, unreadable or too-short file means "unavailable",
 *      never "accept everything".
 *
 *   2. An optional token registry (tokens.json) used by createTokenStore().
 *      Only SHA-256 digests of issued tokens are persisted; raw tokens are
 *      returned exactly once by issue()/rotatePhone().
 *
 * Every comparison hashes both sides with SHA-256 first and then calls
 * crypto.timingSafeEqual, so differing lengths cannot leak through a length
 * check or an early return.
 *
 * Comments are English; user-facing messages are Chinese (see contracts.js).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const C = require('./contracts');

const TOKEN_PREFIX = 'khy_';
const DEFAULT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TOKEN_LENGTH = 512;
const MAX_TOKEN_NAME = 64;

/** SHA-256 hex digest of an arbitrary string (used for token storage). */
function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/**
 * Hash a token so both sides always have the same length before comparing.
 *
 * @param {string} token
 * @returns {Buffer} 32-byte digest
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest();
}

/**
 * Constant-time comparison of two token strings.
 * Returns false for non-strings instead of throwing.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || b.length === 0) return false;
  return crypto.timingSafeEqual(hashToken(a), hashToken(b));
}

/** Constant-time comparison of two 64-char SHA-256 hex digests. */
function constantTimeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * @param {string} [prefix]
 * @returns {string} `khy_` + 43 base64url characters (32 random bytes)
 */
function generateToken(prefix = TOKEN_PREFIX) {
  return `${prefix}${crypto.randomBytes(32).toString('base64url')}`;
}

/**
 * Extract a bearer token from an Authorization header.
 * The strict alphabet keeps control characters and spaces out of the compare.
 *
 * @param {unknown} header
 * @returns {string|null}
 */
function parseBearer(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]{8,512})$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Resolve the operator token file for a config object. Accepts both the
 * local-server config ({local:{tokenFile}}) and the bridge config
 * ({paths:{operatorToken}}), falling back to <stateDir>/operator.token.
 *
 * @param {object} config
 * @returns {string} absolute path
 */
function tokenFileFor(config) {
  if (config && config.local && typeof config.local.tokenFile === 'string' && config.local.tokenFile) {
    return path.resolve(config.local.tokenFile);
  }
  if (config && config.paths && typeof config.paths.operatorToken === 'string' && config.paths.operatorToken) {
    return path.resolve(config.paths.operatorToken);
  }
  if (config && typeof config.stateDir === 'string' && config.stateDir) {
    return path.join(path.resolve(config.stateDir), C.STATE_FILES.operatorToken);
  }
  throw new C.BridgeError('invalid_config', '无法确定 operator token 文件：config 缺少 stateDir');
}

/**
 * Tighten file permissions where the platform supports it.
 *
 * Windows: fs.chmod() has no effect on NTFS (measured mode stays 0666), so use
 * icacls to remove inheritance and grant the current user full control only.
 * POSIX: chmod 0600.
 *
 * Best effort: a failure is logged and reported, never thrown, because the
 * caller decides whether strict permissions are a startup blocker.
 *
 * @param {string} file
 * @param {{warn?: Function}|null} [logger]
 * @returns {boolean} true when the platform call succeeded
 */
function hardenTokenFile(file, logger) {
  const warn = logger && typeof logger.warn === 'function' ? logger.warn.bind(logger) : null;
  try {
    if (process.platform === 'win32') {
      const user = process.env.USERNAME || process.env.USER;
      if (!user) {
        if (warn) warn('token ACL not tightened: USERNAME is unset', { file });
        return false;
      }
      const domain = process.env.USERDOMAIN;
      const principal = domain ? `${domain}\\${user}` : user;
      const result = spawnSync('icacls', [file, '/inheritance:r', '/grant:r', `${principal}:F`], {
        windowsHide: true,
        stdio: 'ignore',
      });
      if (result.status !== 0) {
        if (warn) warn('token ACL not tightened: icacls failed', { file, status: result.status });
        return false;
      }
      return true;
    }
    fs.chmodSync(file, 0o600);
    return true;
  } catch (err) {
    if (warn) warn('token file permissions could not be tightened', { file, error: err.message });
    return false;
  }
}

/**
 * Tighten a state directory to the current user (Windows icacls / POSIX 0700).
 * Returns false instead of throwing; callers decide whether to fail closed.
 */
function hardenDirectory(dir, logger) {
  const warn = logger && typeof logger.warn === 'function' ? logger.warn.bind(logger) : null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (process.platform === 'win32') {
      const user = process.env.USERNAME || process.env.USER;
      if (!user) return false;
      const principal = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user;
      // Removing inheritance on a directory that already holds files strips the
      // inherited ACEs those children rely on (Windows leaves them with no ACE
      // at all). Only tighten an empty directory; for a non-empty one, add the
      // current user's inheritable ACE without removing existing entries.
      let entries = null;
      try {
        entries = fs.readdirSync(dir);
      } catch {
        entries = null;
      }
      const canTighten = Array.isArray(entries) && entries.length === 0;
      const args = canTighten
        ? [dir, '/inheritance:r', '/grant:r', `${principal}:(OI)(CI)F`]
        : [dir, '/grant:r', `${principal}:(OI)(CI)F`];
      const result = spawnSync('icacls', args, {
        windowsHide: true,
        stdio: 'ignore',
      });
      if (result.status !== 0) {
        if (warn) warn('directory ACL not tightened: icacls failed', { dir });
        return false;
      }
      return true;
    }
    fs.chmodSync(dir, 0o700);
    return true;
  } catch (err) {
    if (warn) warn('directory permissions could not be tightened', { dir, error: err.message });
    return false;
  }
}

/**
 * Read the raw operator token. Returns null for any read/format problem; this
 * is intentionally silent so callers can fail closed with one code.
 *
 * @param {string} file
 * @returns {string|null}
 */
function readTokenFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Atomically create/replace a token file:
 *   write a sibling temp file -> fsync -> rename over the target -> harden ACL.
 *
 * @param {string} file
 * @param {string} token
 * @param {object|null} [logger]
 * @returns {{file:string, acl:boolean}}
 */
function writeTokenFile(file, token, logger) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeSync(fd, String(token), 0, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
  const acl = hardenTokenFile(file, logger);
  return { file, acl };
}

/**
 * Create the operator-token verifier.
 *
 * @param {{config: object, logger?: object}} options
 * @returns {{
 *   file: string,
 *   read: () => string|null,
 *   available: () => boolean,
 *   verify: (token: unknown) => boolean,
 *   verifyDetailed: (token: unknown) => {ok:boolean, reason:string},
 *   verifyHeader: (header: unknown) => {ok:boolean, reason:string, token:string|null},
 *   ensure: (opts?: {force?: boolean}) => {token:string, created:boolean, file:string, acl?:boolean},
 *   describe: () => {file:string, present:boolean, valid:boolean, length:number}
 * }}
 */
function createAuth(options = {}) {
  const { config, logger } = options;
  if (!config || typeof config !== 'object') {
    throw new C.BridgeError('invalid_config', 'createAuth 需要 config');
  }
  const file = tokenFileFor(config);

  // Cache keyed on mtime so a rotated token is picked up without re-reading
  // the file on every request and without ever caching a token across rotation.
  let cached = null;
  let cachedMtime = -1;

  function read() {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      cached = null;
      cachedMtime = -1;
      return null;
    }
    if (stat.mtimeMs === cachedMtime) return cached;
    cached = readTokenFile(file);
    cachedMtime = stat.mtimeMs;
    return cached;
  }

  function available() {
    const token = read();
    return typeof token === 'string' && token.length >= C.LIMITS.tokenMinLength;
  }

  /**
   * Plain boolean verify. Missing/short token files always return false.
   * Use verifyDetailed() when the HTTP layer must distinguish 401 from 503.
   */
  function verify(token) {
    const expected = read();
    if (!expected || expected.length < C.LIMITS.tokenMinLength) return false;
    return constantTimeEqual(token, expected);
  }

  function verifyDetailed(token) {
    const expected = read();
    if (!expected || expected.length < C.LIMITS.tokenMinLength) {
      return { ok: false, reason: 'token_file_missing_or_short' };
    }
    if (typeof token !== 'string' || !token) return { ok: false, reason: 'missing_bearer' };
    if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'token_too_long' };
    return constantTimeEqual(token, expected) ? { ok: true, reason: 'ok' } : { ok: false, reason: 'token_mismatch' };
  }

  function verifyHeader(header) {
    const token = parseBearer(header);
    if (!token) return { ok: false, reason: 'missing_bearer', token: null };
    const result = verifyDetailed(token);
    return { ok: result.ok, reason: result.reason, token };
  }

  /**
   * Create the token file if it is missing (or rotate when force=true).
   * Never silently replaces an existing valid token unless force is explicit.
   */
  function ensure(ensureOptions = {}) {
    const force = ensureOptions.force === true;
    if (!force) {
      const existing = read();
      if (existing) {
        return { token: existing, created: false, file };
      }
    }
    const token = generateToken();
    const written = writeTokenFile(file, token, logger);
    cached = token;
    try {
      cachedMtime = fs.statSync(file).mtimeMs;
    } catch {
      cachedMtime = -1;
    }
    return { token, created: true, file, acl: written.acl };
  }

  function describe() {
    const token = read();
    return {
      file,
      present: token !== null,
      valid: typeof token === 'string' && token.length >= C.LIMITS.tokenMinLength,
      length: token ? token.length : 0,
    };
  }

  return { file, read, available, verify, verifyDetailed, verifyHeader, ensure, describe };
}

// ── Token registry (createTokenStore, see contracts MODULES.A) ───────────────

function tokenStoreFile(config) {
  if (config && config.paths && typeof config.paths.tokens === 'string' && config.paths.tokens) {
    return path.resolve(config.paths.tokens);
  }
  return path.join(path.resolve(config.stateDir), C.STATE_FILES.tokens);
}

function atomicWriteJson(file, value, logger) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeSync(fd, `${JSON.stringify(value)}\n`, 0, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
  hardenTokenFile(file, logger);
}

/**
 * Multi-token store with the frozen contract shape:
 *   issue({scope,name,ttlMs}) -> {token, record}
 *   verify(token) -> principal|null
 *   rotatePhone() -> {token, expiresAt, record_id}  // issue only; commit separately
 *   revoke(id) -> {revoked:boolean}
 *
 * Verification order: operator token file first (constant time), then the
 * registry (digest compare, also constant time).
 *
 * @param {{config: object, logger?: object, clock?: Function}} options
 */
function createTokenStore(options = {}) {
  const { config, logger } = options;
  if (!config || typeof config !== 'object') {
    throw new C.BridgeError('invalid_config', 'createTokenStore 需要 config');
  }
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const auth = createAuth({ config, logger });
  const file = tokenStoreFile(config);

  function load() {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return { v: 1, tokens: [] };
    }
    try {
      const data = JSON.parse(text);
      if (data && typeof data === 'object' && Array.isArray(data.tokens)) return data;
    } catch {
      // fall through: a corrupt registry is treated as empty, never trusted
    }
    return { v: 1, tokens: [] };
  }

  function save(data) {
    atomicWriteJson(file, data, logger);
  }

  function issue(issueOptions = {}) {
    const scope = issueOptions.scope || C.SCOPES.OPERATOR;
    if (!Object.values(C.SCOPES).includes(scope)) {
      throw new C.BridgeError('invalid_args', `未知 scope：${String(scope)}`);
    }
    const ttlMs = Number.isFinite(issueOptions.ttlMs) && issueOptions.ttlMs > 0
      ? issueOptions.ttlMs
      : DEFAULT_TOKEN_TTL_MS;
    const token = generateToken();
    const now = clock();
    const record = {
      id: crypto.randomUUID(),
      scope,
      name: String(issueOptions.name || 'token').slice(0, MAX_TOKEN_NAME),
      sha256: sha256Hex(token),
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + ttlMs).toISOString(),
      revoked: false,
      last_used: null,
    };
    const data = load();
    data.tokens.push(record);
    save(data);
    return { token, record: { ...record } };
  }

  function verify(token) {
    if (!auth.available()) {
      // Do not short-circuit the registry: a registry-only deployment may run
      // without an operator token file. The registry is still constant-time.
    } else if (auth.verify(token)) {
      return { kind: 'operator', scope: 'operator', tokenId: 'operator-file', source: 'operator.token' };
    }
    if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH) return null;
    const digest = sha256Hex(token);
    const now = clock();
    const data = load();
    for (const record of data.tokens) {
      if (!record || record.revoked) continue;
      if (!record.expires_at || Date.parse(record.expires_at) <= now) continue;
      if (constantTimeEqualHex(digest, record.sha256)) {
        return {
          kind: record.scope,
          scope: record.scope,
          tokenId: record.id,
          source: 'tokens.json',
        };
      }
    }
    return null;
  }

  /**
   * Issue a new phone token WITHOUT revoking the old ones. Call this before
   * pushing the token to the phone; only call commitPhoneRotation(record.id)
   * after the push succeeded, so a failed push leaves the old token valid.
   */
  function issuePhone() {
    const data = load();
    const token = generateToken();
    const now = clock();
    const expiresAt = new Date(now + DEFAULT_TOKEN_TTL_MS).toISOString();
    const record = {
      id: crypto.randomUUID(),
      scope: C.SCOPES.PHONE,
      name: 'phone',
      sha256: sha256Hex(token),
      created_at: new Date(now).toISOString(),
      expires_at: expiresAt,
      revoked: false,
      last_used: null,
    };
    data.tokens.push(record);
    save(data);
    return { token, record: { ...record }, expiresAt };
  }

  /**
   * Revoke every other phone token, keeping the just-pushed record valid.
   * @param {string} recordId
   */
  function commitPhoneRotation(recordId) {
    if (typeof recordId !== 'string' || !recordId) {
      throw new C.BridgeError('invalid_args', 'commitPhoneRotation 需要 record_id');
    }
    const data = load();
    let revoked = 0;
    let found = false;
    for (const record of data.tokens) {
      if (!record || record.scope !== C.SCOPES.PHONE) continue;
      if (record.id === recordId) {
        found = true;
        continue;
      }
      if (!record.revoked) {
        record.revoked = true;
        revoked += 1;
      }
    }
    if (!found) throw new C.BridgeError('not_found', `phone token record 不存在：${recordId}`);
    if (revoked > 0) save(data);
    return { revoked };
  }

  /**
   * Issue a new phone token WITHOUT revoking the previous one. Callers must
   * push the new token to the phone first, then call commitPhoneRotation();
   * a failed push therefore leaves the old token usable. This is the same
   * two-phase order install/deploy use.
   */
  function rotatePhone() {
    const issued = issuePhone();
    return { token: issued.token, expiresAt: issued.expiresAt, record_id: issued.record.id };
  }

  function revoke(id) {
    if (typeof id !== 'string' || !id) return { revoked: false };
    const data = load();
    let revoked = false;
    for (const record of data.tokens) {
      if (record && record.id === id && !record.revoked) {
        record.revoked = true;
        revoked = true;
      }
    }
    if (revoked) save(data);
    return { revoked };
  }

  return { issue, verify, rotatePhone, issuePhone, commitPhoneRotation, revoke, file, auth };
}

/**
 * Auth adapter for the HTTP server: accepts the operator token file first, then
 * phone-scope tokens from TokenStore. A missing operator token file still fails
 * closed (available() is false), but issued phone tokens are not ignored.
 *
 * @param {{config: object, logger?: object, tokenStore?: object}} options
 */
function createCompositeAuth(options = {}) {
  const { config, logger } = options;
  const operatorAuth = createAuth({ config, logger });
  let store = options.tokenStore || null;
  if (!store) {
    try {
      store = createTokenStore({ config, logger });
    } catch {
      store = null;
    }
  }

  function verifyDetailed(token) {
    const detail = operatorAuth.verifyDetailed(token);
    if (detail.ok) {
      return {
        ok: true,
        reason: 'ok',
        principal: { kind: 'operator', scope: 'operator', tokenId: 'operator', source: 'http' },
      };
    }
    if (store) {
      const principal = store.verify(token);
      if (principal) return { ok: true, reason: 'ok', principal: { ...principal, source: 'http' } };
    }
    return detail;
  }

  return {
    file: operatorAuth.file,
    available: () => operatorAuth.available(),
    describe: () => (typeof operatorAuth.describe === 'function' ? operatorAuth.describe() : {}),
    ensure: (ensureOptions) => operatorAuth.ensure(ensureOptions),
    verify: (token) => verifyDetailed(token).ok,
    verifyDetailed,
    verifyHeader: (header) => verifyDetailed(parseBearer(header)).ok,
  };
}

/**
 * Convenience wrapper used by CLI provisioning: create the operator token file
 * when missing.
 *
 * @param {{config: object, logger?: object, force?: boolean}} options
 */
function ensureTokenFile(options = {}) {
  const logger = options.logger;
  const auth = createAuth({ config: options.config, logger });
  const result = auth.ensure({ force: options.force === true });
  const acl = result.created ? result.acl !== false : hardenTokenFile(auth.file, logger);
  if (options.strictAcl !== false && acl === false) {
    throw new C.BridgeError(
      'auth_unavailable',
      'operator token 文件 ACL 无法收紧，拒绝继续（fail-closed）',
      { file: auth.file }
    );
  }
  return { ...result, acl };
}

module.exports = {
  TOKEN_PREFIX,
  DEFAULT_TOKEN_TTL_MS,
  MAX_TOKEN_LENGTH,
  sha256Hex,
  hashToken,
  constantTimeEqual,
  constantTimeEqualHex,
  generateToken,
  parseBearer,
  tokenFileFor,
  hardenTokenFile,
  hardenDirectory,
  readTokenFile,
  writeTokenFile,
  createAuth,
  createTokenStore,
  createCompositeAuth,
  ensureTokenFile,
};
