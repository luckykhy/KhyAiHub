'use strict';

// Co-located unit test for remoteWorkspaceResolver.js (pure leaf, no IO).
//
// Sandbox contract: the module reads KHY_REMOTE_WORKSPACE_ALLOWLIST live from
// process.env, so every case sets/deletes that one variable and never touches a
// socket, a child process or a real key file.

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
  delete process.env.KHY_REMOTE_WORKSPACE_ALLOWLIST;
  return root;
}

pinSandbox();

const { resolveWorkspace } = require('./remoteWorkspaceResolver');

function throwsWith(code, fn) {
  try {
    fn();
  } catch (error) {
    assert.strictEqual(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`expected a throw with code ${code}`);
  return null;
}

test('exports only resolveWorkspace', () => {
  assert.deepStrictEqual(Object.keys(require('./remoteWorkspaceResolver')), ['resolveWorkspace']);
});

test('falls back to the host entry workspace, then to the home shortcut', () => {
  assert.strictEqual(resolveWorkspace({ requestedWorkspace: '/srv/app', hostEntry: { remoteWorkspace: '/home/deploy' } }), '/srv/app');
  assert.strictEqual(resolveWorkspace({ requestedWorkspace: '', hostEntry: { remoteWorkspace: '/home/deploy' } }), '/home/deploy');
  assert.strictEqual(resolveWorkspace({ requestedWorkspace: null, hostEntry: null }), '~');
});

test('trims surrounding whitespace before validating', () => {
  assert.strictEqual(resolveWorkspace({ requestedWorkspace: '  /srv/app  ', hostEntry: null }), '/srv/app');
});

test('rejects an all-whitespace workspace with workspace_empty', () => {
  throwsWith('workspace_empty', () => resolveWorkspace({ requestedWorkspace: '   ', hostEntry: null }));
});

test('rejects a null byte with its own code before any other check', () => {
  const error = throwsWith('workspace_contains_null_byte', () => resolveWorkspace({
    requestedWorkspace: `/srv/app${String.fromCharCode(0)}/escape`,
    hostEntry: null,
  }));
  assert.match(error.message, /null byte/);
});

test('rejects an over-long workspace with workspace_too_long', () => {
  throwsWith('workspace_too_long', () => resolveWorkspace({
    requestedWorkspace: `/srv/${'a'.repeat(4096)}`,
    hostEntry: null,
  }));
});

test('allowlist prefix accepts a listed workspace', () => {
  process.env.KHY_REMOTE_WORKSPACE_ALLOWLIST = '/srv/app, /opt/deploy';
  try {
    assert.strictEqual(resolveWorkspace({ requestedWorkspace: '/srv/app/current', hostEntry: null }), '/srv/app/current');
    assert.strictEqual(resolveWorkspace({ requestedWorkspace: '/opt/deploy', hostEntry: null }), '/opt/deploy');
  } finally {
    delete process.env.KHY_REMOTE_WORKSPACE_ALLOWLIST;
  }
});

test('allowlist rejects an unlisted workspace', () => {
  process.env.KHY_REMOTE_WORKSPACE_ALLOWLIST = '/srv/app';
  try {
    const error = throwsWith('workspace_not_allowed', () => resolveWorkspace({
      requestedWorkspace: '/etc',
      hostEntry: null,
    }));
    assert.ok(error.message.includes('/srv/app'), 'the message must name the allowed prefixes');
  } finally {
    delete process.env.KHY_REMOTE_WORKSPACE_ALLOWLIST;
  }
});

// B31-R3 (registered, NOT fixed): deployOrchestrator.js:26 tells the reader that
// "the remote deploy directory is validated against the workspace allowlist", and
// resolveWorkspace is the guard that is supposed to back that claim. Measured
// here: the guard is absent by default and boundary-free when present.
test('B31-R3 allowlist is fail-open when the env var is unset or blank', () => {
  delete process.env.KHY_REMOTE_WORKSPACE_ALLOWLIST;
  assert.strictEqual(resolveWorkspace({ requestedWorkspace: '/', hostEntry: null }), '/');
  assert.strictEqual(resolveWorkspace({ requestedWorkspace: '/etc', hostEntry: null }), '/etc');
  process.env.KHY_REMOTE_WORKSPACE_ALLOWLIST = '  ';
  assert.strictEqual(resolveWorkspace({ requestedWorkspace: '/etc', hostEntry: null }), '/etc');
  delete process.env.KHY_REMOTE_WORKSPACE_ALLOWLIST;
});

test('B31-R3 prefix match has no path boundary and no traversal check', () => {
  process.env.KHY_REMOTE_WORKSPACE_ALLOWLIST = '/srv/app';
  try {
    // A sibling directory whose name merely starts with the allowed prefix passes.
    assert.strictEqual(resolveWorkspace({ requestedWorkspace: '/srv/application/secrets', hostEntry: null }), '/srv/application/secrets');
    // Dot-dot traversal is never normalised away, and it then reaches the remote
    // shell inside `cd '<ws>' && ...` (remoteExecService.js:148).
    assert.strictEqual(resolveWorkspace({ requestedWorkspace: '/srv/app/../../../etc', hostEntry: null }), '/srv/app/../../../etc');
  } finally {
    delete process.env.KHY_REMOTE_WORKSPACE_ALLOWLIST;
  }
});
