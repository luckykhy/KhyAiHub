'use strict';

// Co-located unit test for sshCredentialGuard.js (thin IO: stat only, never a
// socket, never the real ~/.ssh — key fixtures are written into a temp dir).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function pinSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-remote-'));
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.KHY_DATA_HOME = path.join(root, 'data');
  process.env.KHY_PROJECT_DATA_HOME = path.join(root, 'project-data');
  process.env.XDG_CONFIG_HOME = path.join(root, 'config');
  process.env.KHY_REMOTE_SSH_ENABLE_EXEC = 'false';
  return root;
}

const SANDBOX = pinSandbox();

const guard = require('./sshCredentialGuard');

function writeKeyFixture(name, mode) {
  const target = path.join(SANDBOX, name);
  fs.writeFileSync(target, 'not a real private key\n', 'utf-8');
  if (typeof mode === 'number') {
    try {
      fs.chmodSync(target, mode);
    } catch {
      /* chmod is best effort on this platform */
    }
  }
  return target;
}

test('export surface is exactly the two validators', () => {
  assert.deepStrictEqual(Object.keys(guard), ['validateIdentityFile', 'validateHostCredentials']);
});

test('a present key file validates and is reported with a home-relative path', () => {
  const key = writeKeyFixture('id_ed25519_fixture');
  const res = guard.validateIdentityFile(key);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.code, 'identity_file_valid');
  assert.ok(!res.identityFile.includes(SANDBOX) || res.identityFile.startsWith('~'), 'home must be compacted away');
  assert.ok(!/PRIVATE KEY/.test(res.message), 'the message never echoes key material');
});

test('a missing key file is rejected with a machine code', () => {
  const res = guard.validateIdentityFile(path.join(SANDBOX, 'no_such_key'));
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'identity_file_missing');
  assert.match(res.message, /is missing/);
});

test('a directory is rejected as not-a-file', () => {
  const res = guard.validateIdentityFile(SANDBOX);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'identity_file_not_file');
});

test('validateHostCredentials rejects a non-object host entry', () => {
  assert.strictEqual(guard.validateHostCredentials(null).ok, false);
  assert.strictEqual(guard.validateHostCredentials(null).code, 'invalid_host_entry');
  assert.strictEqual(guard.validateHostCredentials('prod').code, 'invalid_host_entry');
  assert.strictEqual(guard.validateHostCredentials(undefined).ok, false);
});

// B31-R5 (registered, NOT fixed): deployOrchestrator.js:125 comment says step 2 of
// a dry-run "Validate credentials (key exists, permissions <= 600)", and the file
// header (:9) says the orchestrator "validate[s] its key permissions
// (sshCredentialGuard)". Measured here: a host entry with no IdentityFile at all
// returns ok:true, so every host without an explicit key sails through the guard;
// validateHostCredentials also ignores host/user/port entirely.
test('B31-R5 the credential guard is fail-open when no key is configured', () => {
  const noKey = guard.validateIdentityFile(null);
  assert.strictEqual(noKey.ok, true, 'documented current behaviour: absent key is "ok"');
  assert.strictEqual(noKey.code, 'no_identity_file');
  assert.strictEqual(guard.validateIdentityFile('').ok, true);
  assert.strictEqual(guard.validateIdentityFile(undefined).ok, true);
  const viaHost = guard.validateHostCredentials({ alias: 'prod', host: 'prod.example.invalid', user: 'root' });
  assert.strictEqual(viaHost.ok, true);
  assert.strictEqual(viaHost.code, 'no_identity_file');
  // A host entry that names a *different* field as its key is still "no key":
  // validateHostCredentials only ever reads hostEntry.identityFile (:89).
  assert.strictEqual(guard.validateHostCredentials({ alias: 'prod', identityfile: '/never/read' }).code, 'no_identity_file');
});

// B31-R5b (registered, NOT fixed): _compactHomePath (:13) tests
// `normalized.startsWith(homeDir)` without a path separator, so a sibling
// directory of the home directory is rewritten into a bogus `~…` path. This
// string is what the user actually sees in identity_file_missing / _not_file /
// _insecure_mode messages.
test('B31-R5b home compaction leaks into sibling directories sharing the prefix', () => {
  const home = os.homedir();
  const sibling = path.join(`${home}ness`, 'keys', 'id_ed25519');
  const res = guard.validateIdentityFile(sibling);
  assert.strictEqual(res.ok, false);
  assert.ok(res.identityFile.startsWith('~ness'), `expected the mangled prefix leak, got ${res.identityFile}`);
  assert.ok(!res.identityFile.includes(home), 'the real absolute path is gone from the message');
});

test('permissions: on win32 the mode branch is skipped, elsewhere loose modes are rejected', (t) => {
  const loose = writeKeyFixture('id_loose_fixture', 0o666);
  const res = guard.validateIdentityFile(loose);
  if (process.platform === 'win32') {
    // sshCredentialGuard.js:20-23 returns { mode: 0o600, secure: true } without
    // consulting stat, so nothing can ever fail the mode check here.
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.code, 'identity_file_valid');
    return;
  }
  // POSIX: the same fixture must be rejected (this assertion only runs off-Windows).
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'identity_file_insecure_mode');
  t.skip('posix path verified only on posix runners');
});

// B31-R5c (registered, NOT fixed): the win32 short-circuit fabricates
// `mode: 0o600`, which is only ever used to build the failure string
// `${modeState.mode.toString(8)}` at :67 — i.e. the number it would print is a
// literal the code invented, not a measured mode, and the 'require
// 600-level permission' promise in that message can never be kept (or broken) on
// Windows. Recorded here as an instrument note so nobody reads a Windows "pass"
// as a permission check.
test('B31-R5c the win32 pass is a skip, not a check (instrument note)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'sshCredentialGuard.js'), 'utf-8').split(/\r?\n/);
  const winLine = src.findIndex((l) => l.includes("process.platform === 'win32'"));
  assert.ok(winLine > -1, 'the platform short-circuit must still be there for this note to hold');
  assert.ok(/mode:\s*0o600/.test(src[winLine + 1] || ''), 'the synthesized literal mode is the next line');
  assert.strictEqual(process.platform === 'win32', true, 'this note is measured on win32 only');
});
