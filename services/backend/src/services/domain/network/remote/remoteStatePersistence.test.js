'use strict';

// Co-located unit test for remoteStatePersistence.js. Every state path used here
// is inside a mkdtemp directory; KHY_DATA_HOME is pinned before the module is
// required so the default path can never resolve into the real data home.

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
  delete process.env.KHY_REMOTE_SSH_PERSIST_STATE;
  delete process.env.KHY_REMOTE_SSH_STATE_PATH;
  return root;
}

const SANDBOX = pinSandbox();

const mod = require('./remoteStatePersistence');
const { createRemoteStatePersistence, RemoteStatePersistence } = mod;

function tmpState(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'khy-remote-')), name);
}

test('export surface', () => {
  assert.deepStrictEqual(Object.keys(mod), ['RemoteStatePersistence', 'createRemoteStatePersistence']);
  assert.ok(createRemoteStatePersistence() instanceof RemoteStatePersistence);
});

test('persistence is OFF unless something turns it on', () => {
  assert.strictEqual(createRemoteStatePersistence().isEnabled(), false);
  process.env.KHY_REMOTE_SSH_PERSIST_STATE = 'true';
  assert.strictEqual(createRemoteStatePersistence().isEnabled(), true);
  process.env.KHY_REMOTE_SSH_PERSIST_STATE = '0';
  assert.strictEqual(createRemoteStatePersistence().isEnabled(), false);
  delete process.env.KHY_REMOTE_SSH_PERSIST_STATE;
});

test('the default state path resolves under the pinned data home', () => {
  const p = createRemoteStatePersistence();
  assert.strictEqual(p.getStatePath(), path.join(process.env.KHY_DATA_HOME, 'remote', 'ssh_state.json'));
  assert.ok(p.getStatePath().startsWith(SANDBOX), 'never the real ~/.khyquant or repo .khy/');
});

test('the env and option path overrides win over the default, in that order', () => {
  process.env.KHY_REMOTE_SSH_STATE_PATH = tmpState('from-env.json');
  assert.strictEqual(createRemoteStatePersistence().getStatePath(), process.env.KHY_REMOTE_SSH_STATE_PATH);
  const explicit = tmpState('from-option.json');
  assert.strictEqual(createRemoteStatePersistence({ statePath: explicit }).getStatePath(), explicit);
  delete process.env.KHY_REMOTE_SSH_STATE_PATH;
});

test('save writes versioned JSON and load reads it back', () => {
  const target = tmpState('state.json');
  const p = createRemoteStatePersistence({ enabled: true, statePath: target });
  const res = p.save({ approvals: [{ ticket_id: 'a' }], streams: [{ stream_id: 's' }] });
  assert.deepStrictEqual(res, { saved: true, path: target, approvals: 1, streams: 1 });
  const raw = JSON.parse(fs.readFileSync(target, 'utf-8'));
  assert.strictEqual(raw.version, 1);
  assert.strictEqual(typeof raw.saved_at, 'string');
  assert.strictEqual(p.load().approvals[0].ticket_id, 'a');
  assert.strictEqual(p.load().streams[0].stream_id, 's');
  assert.ok(!fs.existsSync(`${target}.tmp`), 'the temp file is renamed away');
});

test('save coerces non-array payloads to empty arrays', () => {
  const target = tmpState('coerce.json');
  const p = createRemoteStatePersistence({ enabled: true, statePath: target });
  const res = p.save({ approvals: 'nope', streams: undefined });
  assert.strictEqual(res.approvals, 0);
  assert.strictEqual(res.streams, 0);
  assert.deepStrictEqual(p.load(), { version: 1, approvals: [], streams: [] });
});

test('disabled instances refuse to read, write or clear', () => {
  const target = tmpState('never.json');
  const p = createRemoteStatePersistence({ enabled: false, statePath: target });
  assert.deepStrictEqual(p.save({ approvals: [], streams: [] }), { saved: false, reason: 'persistence_disabled' });
  assert.strictEqual(p.load(), null);
  assert.deepStrictEqual(p.clear(), { cleared: false, reason: 'persistence_disabled' });
  assert.strictEqual(fs.existsSync(target), false);
});

test('a missing state file loads as null, not as an empty state', () => {
  const p = createRemoteStatePersistence({ enabled: true, statePath: tmpState('absent.json') });
  assert.strictEqual(p.load(), null);
  assert.deepStrictEqual(p.clear(), { cleared: true });
});

test('clear removes the state file', () => {
  const target = tmpState('gone.json');
  const p = createRemoteStatePersistence({ enabled: true, statePath: target });
  p.save({ approvals: [{ ticket_id: 'a' }], streams: [] });
  assert.strictEqual(fs.existsSync(target), true);
  assert.deepStrictEqual(p.clear(), { cleared: true });
  assert.strictEqual(fs.existsSync(target), false);
});

// B31-R15 (registered, NOT fixed): remoteStatePersistence.js:19-26 only respects a
// *boolean* `enabled` and only a *truthy* `statePath`. Every other falsy or
// string spelling of "off" — 0, 'false', 'no', '' — silently falls through to the
// process-level gate, so a caller that believes it disabled disk writes keeps the
// writes when KHY_REMOTE_SSH_PERSIST_STATE happens to be on. The same `||` shape
// means `statePath: ''` is discarded rather than rejected.
test('B31-R15 a non-boolean "off" falls through to the env gate', () => {
  process.env.KHY_REMOTE_SSH_PERSIST_STATE = '1';
  try {
    assert.strictEqual(createRemoteStatePersistence({ enabled: 0 }).isEnabled(), true);
    assert.strictEqual(createRemoteStatePersistence({ enabled: 'false' }).isEnabled(), true);
    assert.strictEqual(createRemoteStatePersistence({ enabled: 'no' }).isEnabled(), true);
    assert.strictEqual(createRemoteStatePersistence({ enabled: null }).isEnabled(), true);
    assert.strictEqual(createRemoteStatePersistence({ enabled: undefined }).isEnabled(), true);
    // only the literal boolean wins:
    assert.strictEqual(createRemoteStatePersistence({ enabled: false }).isEnabled(), false);
    assert.strictEqual(createRemoteStatePersistence({ statePath: '' }).getStatePath(),
      path.join(process.env.KHY_DATA_HOME, 'remote', 'ssh_state.json'));
  } finally {
    delete process.env.KHY_REMOTE_SSH_PERSIST_STATE;
  }
});

// B31-R15b (registered, NOT fixed): save() (:74-76) writes `<path>.tmp` and then
// renames it. When the rename fails the temp file is left behind and clear()
// (:96-98) only unlinks the final path — so a broken state directory accumulates
// orphan .tmp files, and index.js's failure alert reports the *rename* reason
// while pointing at a path that looks untouched.
test('B31-R15b a failed rename leaves the .tmp orphan behind', () => {
  const dir = tmpState('blocker');
  fs.mkdirSync(dir);
  const p = createRemoteStatePersistence({ enabled: true, statePath: dir });
  const res = p.save({ approvals: [{ ticket_id: 'x' }], streams: [] });
  assert.strictEqual(res.saved, false);
  assert.match(res.reason, /EPERM|EISDIR|EBUSY/);
  assert.strictEqual(fs.existsSync(`${dir}.tmp`), true, 'current behaviour: the temp file survives');
  assert.deepStrictEqual(p.clear(), { cleared: false, reason: p.clear().reason });
  assert.strictEqual(fs.existsSync(`${dir}.tmp`), true, 'clear() does not collect it either');
});

// B31-R15c (registered, NOT fixed): load() (:46-52) coerces the version with
// `Number.parseInt(parsed?.version, 10) || STATE_FILE_VERSION`, so version 0 and
// version 'abc' both come back as 1, and a future version 2 file is handed to the
// v1 readers unchanged — there is no migration hook and no "unsupported version"
// signal anywhere in the unit. The whole read is wrapped in one bare `catch`
// (:53) that folds "corrupt JSON", "unreadable", "EACCES" and "empty file" into
// the same `null`, which index.js:478 then reports as
// `state_file_missing_or_invalid`.
test('B31-R15c the version is coerced and every read error is the same null', () => {
  const f = tmpState('v.json');
  const p = createRemoteStatePersistence({ enabled: true, statePath: f });
  fs.writeFileSync(f, JSON.stringify({ version: 0, approvals: [{ ticket_id: 'kept' }], streams: 'bad' }), 'utf-8');
  assert.deepStrictEqual(p.load(), { version: 1, approvals: [{ ticket_id: 'kept' }], streams: [] });
  fs.writeFileSync(f, JSON.stringify({ version: 'abc' }), 'utf-8');
  assert.strictEqual(p.load().version, 1);
  fs.writeFileSync(f, JSON.stringify({ version: 99 }), 'utf-8');
  assert.strictEqual(p.load().version, 99, 'a newer file is accepted by a reader that cannot know its shape');
  fs.writeFileSync(f, '{ this is not json', 'utf-8');
  assert.strictEqual(p.load(), null);
  fs.writeFileSync(f, '', 'utf-8');
  assert.strictEqual(p.load(), null);
});
