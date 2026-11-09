'use strict';

/**
 * auth.test.js — token file lifecycle, constant-time comparison, fail-closed
 * behavior, bearer parsing, and the tokens.json registry.
 *
 * All state lives in a per-test temp directory; no default port is touched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const C = require('../lib/contracts');
const {
  createAuth,
  createTokenStore,
  ensureTokenFile,
  constantTimeEqual,
  constantTimeEqualHex,
  generateToken,
  hashToken,
  parseBearer,
  sha256Hex,
  hardenTokenFile,
  hardenDirectory,
  tokenFileFor,
} = require('../lib/auth');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amoon-auth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeConfig(dir) {
  const tokenFile = path.join(dir, 'operator.token');
  return {
    stateDir: dir,
    local: { tokenFile },
    paths: {
      operatorToken: tokenFile,
      tokens: path.join(dir, 'tokens.json'),
    },
  };
}

test('generateToken produces khy_ tokens with 256 bits of entropy', () => {
  const token = generateToken();
  assert.match(token, /^khy_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(token, generateToken());
  assert.equal(Buffer.from(token.slice(4), 'base64url').length, 32);
});

test('constantTimeEqual compares strings and rejects non-strings', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'abcdef'), false);
  assert.equal(constantTimeEqual('', ''), false);
  assert.equal(constantTimeEqual(null, 'abc'), false);
  assert.equal(constantTimeEqual(undefined, undefined), false);
  assert.equal(constantTimeEqual(123, '123'), false);
});

test('constantTimeEqualHex only compares 64-char hex digests', () => {
  const a = sha256Hex('x');
  assert.equal(constantTimeEqualHex(a, a), true);
  assert.equal(constantTimeEqualHex(a, sha256Hex('y')), false);
  assert.equal(constantTimeEqualHex('zz', 'zz'), false);
});

test('parseBearer accepts a strict bearer header and rejects everything else', () => {
  assert.equal(parseBearer('Bearer abcdefgh'), 'abcdefgh');
  assert.equal(parseBearer('bearer abcdefgh'), 'abcdefgh');
  assert.equal(parseBearer('  Bearer   abcdefgh  '), 'abcdefgh');
  assert.equal(parseBearer('Basic abcdefgh'), null);
  assert.equal(parseBearer('Bearer '), null);
  assert.equal(parseBearer('Bearer short'), null);
  assert.equal(parseBearer('Bearer abc def'), null);
  assert.equal(parseBearer(null), null);
});

test('missing token file is fail-closed, never permissive', (t) => {
  const dir = tempDir(t);
  const auth = createAuth({ config: makeConfig(dir) });

  assert.equal(auth.available(), false);
  assert.equal(auth.verify('anything'), false);
  assert.deepEqual(auth.verifyDetailed('anything'), { ok: false, reason: 'token_file_missing_or_short' });
  assert.equal(auth.describe().present, false);
  assert.equal(auth.describe().valid, false);
});

test('a short token file is rejected instead of accepted', (t) => {
  const dir = tempDir(t);
  const config = makeConfig(dir);
  fs.writeFileSync(config.local.tokenFile, 'short');

  const auth = createAuth({ config });
  assert.equal(auth.available(), false);
  assert.equal(auth.verify('short'), false);
  assert.equal(auth.describe().present, true);
  assert.equal(auth.describe().valid, false);
});

test('ensure creates a token once, verifies it, and rotates only on force', (t) => {
  const dir = tempDir(t);
  const config = makeConfig(dir);
  const auth = createAuth({ config });

  const first = auth.ensure();
  assert.equal(first.created, true);
  assert.match(first.token, /^khy_/);
  assert.ok(first.token.length >= C.LIMITS.tokenMinLength);
  assert.equal(first.file, config.local.tokenFile);
  assert.equal(fs.readFileSync(first.file, 'utf8'), first.token);
  assert.equal(auth.available(), true);
  assert.equal(auth.verify(first.token), true);
  assert.equal(auth.verify(`${first.token}x`), false);
  assert.equal(auth.verify(first.token.slice(0, -1)), false);
  assert.equal(auth.verify(''), false);
  assert.equal(auth.verify(null), false);
  assert.equal(auth.verifyDetailed(first.token).ok, true);
  assert.equal(auth.verifyDetailed('wrong-token-value').reason, 'token_mismatch');

  const second = auth.ensure();
  assert.equal(second.created, false);
  assert.equal(second.token, first.token);

  const rotated = auth.ensure({ force: true });
  assert.equal(rotated.created, true);
  assert.notEqual(rotated.token, first.token);
  assert.equal(auth.verify(first.token), false);
  assert.equal(auth.verify(rotated.token), true);

  // The atomic writer must not leave temp files behind.
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('verifyHeader parses and checks a real Authorization header', (t) => {
  const dir = tempDir(t);
  const auth = createAuth({ config: makeConfig(dir) });
  const { token } = auth.ensure();

  assert.deepEqual(auth.verifyHeader(`Bearer ${token}`), {
    ok: true,
    reason: 'ok',
    token,
  });
  const missing = auth.verifyHeader(undefined);
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'missing_bearer');
  const wrong = auth.verifyHeader(`Bearer ${generateToken()}`);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, 'token_mismatch');
});

test('token file permissions are tightened where the platform supports it', (t) => {
  const dir = tempDir(t);
  const config = makeConfig(dir);
  const auth = createAuth({ config });
  const { token, file, acl } = auth.ensure();

  assert.equal(fs.readFileSync(file, 'utf8'), token);
  assert.equal(typeof acl, 'boolean');
  if (process.platform === 'win32') {
    // NTFS ignores chmod; the implementation calls icacls. We only assert the
    // file is readable by the current user, not the exact ACL text.
    assert.ok(fs.statSync(file).size > 0);
  } else {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(hardenTokenFile(file), true);
  }
});

test('hardenDirectory keeps pre-existing state files readable', (t) => {
  const dir = tempDir(t);
  const capability = path.join(dir, C.STATE_FILES.capability);
  const payload = '{"status":"verified","http":true}\n';
  fs.writeFileSync(capability, payload);

  assert.equal(hardenDirectory(dir), true);
  assert.equal(fs.readFileSync(capability, 'utf8'), payload);
});

test('tokenFileFor accepts local, paths, and stateDir configurations', (t) => {
  const dir = tempDir(t);
  assert.equal(
    tokenFileFor({ local: { tokenFile: path.join(dir, 'a.token') } }),
    path.join(dir, 'a.token')
  );
  assert.equal(
    tokenFileFor({ paths: { operatorToken: path.join(dir, 'b.token') } }),
    path.join(dir, 'b.token')
  );
  assert.equal(tokenFileFor({ stateDir: dir }), path.join(dir, C.STATE_FILES.operatorToken));
  assert.throws(() => tokenFileFor({}), (err) => err.code === 'invalid_config');
});

test('ensureTokenFile is a thin provisioning wrapper', (t) => {
  const dir = tempDir(t);
  const config = makeConfig(dir);
  const first = ensureTokenFile({ config });
  assert.equal(first.created, true);
  const second = ensureTokenFile({ config });
  assert.equal(second.created, false);
  assert.equal(second.token, first.token);
});

test('token store issues, verifies, revokes, and rotates phone tokens', (t) => {
  const dir = tempDir(t);
  const config = makeConfig(dir);
  const auth = createAuth({ config });
  const operator = auth.ensure().token;
  const store = createTokenStore({ config });

  // The operator token file stays authoritative.
  assert.deepEqual(store.verify(operator), {
    kind: 'operator',
    scope: 'operator',
    tokenId: 'operator-file',
    source: 'operator.token',
  });

  const issued = store.issue({ scope: 'phone', name: 'pixel', ttlMs: 60000 });
  assert.match(issued.token, /^khy_/);
  assert.equal(issued.record.scope, 'phone');
  assert.equal(issued.record.name, 'pixel');
  assert.equal(issued.record.sha256, sha256Hex(issued.token));
  assert.equal(store.verify(issued.token).scope, 'phone');
  assert.equal(store.verify(issued.token).tokenId, issued.record.id);
  assert.equal(store.verify(generateToken()), null);

  // The raw token must not be in tokens.json, only its digest.
  const raw = fs.readFileSync(config.paths.tokens, 'utf8');
  assert.ok(!raw.includes(issued.token));
  assert.ok(raw.includes(issued.record.sha256));

  assert.deepEqual(store.revoke(issued.record.id), { revoked: true });
  assert.equal(store.verify(issued.token), null);
  assert.deepEqual(store.revoke(issued.record.id), { revoked: false });

  const firstPhone = store.rotatePhone();
  assert.match(firstPhone.token, /^khy_/);
  assert.ok(Date.parse(firstPhone.expiresAt) > Date.now());
  assert.equal(store.verify(firstPhone.token).scope, 'phone');

  const secondPhone = store.rotatePhone();
  assert.match(secondPhone.record_id, /^[A-Za-z0-9_-]{8,64}$/);
  // Issuing is two-phase: the old token stays valid until the caller has
  // pushed the new one and explicitly commits the rotation.
  assert.equal(store.verify(firstPhone.token).scope, 'phone');
  assert.equal(store.verify(secondPhone.token).scope, 'phone');
  store.commitPhoneRotation(secondPhone.record_id);
  assert.equal(store.verify(firstPhone.token), null);
  assert.equal(store.verify(secondPhone.token).scope, 'phone');
});

test('token store rejects invalid scopes and expired tokens', (t) => {
  const dir = tempDir(t);
  const config = makeConfig(dir);
  let now = Date.now();
  const store = createTokenStore({ config, clock: () => now });

  assert.throws(() => store.issue({ scope: 'root' }), (err) => err.code === 'invalid_args');

  const issued = store.issue({ scope: 'phone', ttlMs: 1000 });
  assert.equal(store.verify(issued.token).scope, 'phone');
  now += 2000;
  assert.equal(store.verify(issued.token), null);
});

test('token store without an operator file still verifies issued tokens', (t) => {
  const dir = tempDir(t);
  const config = makeConfig(dir);
  const store = createTokenStore({ config });
  const issued = store.issue({ scope: 'file', name: 'mailbox' });
  const principal = store.verify(issued.token);
  assert.equal(principal.scope, 'file');
  assert.equal(principal.kind, 'file');
});

test('hashToken is stable and 32 bytes', () => {
  const digest = hashToken('khy_example');
  assert.equal(digest.length, 32);
  assert.ok(hashToken('khy_example').equals(digest));
  assert.ok(!hashToken('khy_example').equals(hashToken('khy_other')));
});
