'use strict';

/**
 * test/manifest.test.js — khy.extension.json / package.json / extension.js
 * must match both lib/contracts.js and the real KhyOS extension rules:
 *
 *   - id equals the leaf directory name   (scripts/ci/check-repo-layout.js:724)
 *   - kind=runtime requires an existing main (same file :731-735)
 *   - namespace must not collide with another extension in delivery/extension
 *   - engines.khy must match the host version when the host is present
 *   - no schemaVersion 2.0 (v1 manifest)
 *   - mcp.tools must equal the 8 frozen Phase 1 names
 *   - extension.js must be side-effect free at require time
 *
 * No daemon, no ADB, no network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const C = require('../lib/contracts');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'khy.extension.json');
const PKG_PATH = path.join(ROOT, 'package.json');
const README_PATH = path.join(ROOT, 'README.md');

const PHASE1 = [
  'ping',
  'bridge_status',
  'khy_ask',
  'phone_screenshot',
  'phone_ui_dump',
  'phone_info',
  'phone_app_list',
  'phone_ls',
  'phone_exec',
  'amoon_send',
  'amoon_inbox',
  'mailbox_status',
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * @param {string} version e.g. 1.2.1
 * @param {string} range e.g. ">=1.1.0"
 */
function satisfiesGte(version, range) {
  const match = /^>=\s*(\d+)\.(\d+)\.(\d+)\s*$/.exec(String(range).trim());
  if (!match) return false;
  const actual = String(version).split('.').map(Number);
  const floor = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let i = 0; i < 3; i += 1) {
    if (actual[i] > floor[i]) return true;
    if (actual[i] < floor[i]) return false;
  }
  return true;
}

/**
 * Collect every khy.extension.json under delivery/extension (depth <= 4).
 *
 * @param {string} dir
 * @returns {Array<{file:string, manifest:object}>}
 */
function collectManifests(dir, depth = 0, out = []) {
  if (depth > 4) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      collectManifests(full, depth + 1, out);
    } else if (entry.name === 'khy.extension.json') {
      try {
        out.push({ file: full, manifest: readJson(full) });
      } catch {
        // A broken sibling manifest is not this test's subject.
      }
    }
  }
  return out;
}

test('manifest has no BOM and required KhyOS v1 fields', () => {
  const raw = fs.readFileSync(MANIFEST_PATH);
  assert.notEqual(raw[0], 0xef, 'khy.extension.json must not start with a UTF-8 BOM');

  const manifest = readJson(MANIFEST_PATH);

  assert.equal(manifest.id, path.basename(ROOT), 'id must equal the leaf directory name');
  assert.equal(typeof manifest.name, 'string');
  assert.ok(manifest.name.length > 0);
  assert.equal(manifest.kind, 'runtime');
  assert.equal(manifest.namespace, 'amoon');
  assert.ok(manifest.engines && typeof manifest.engines.khy === 'string');
  assert.match(manifest.engines.khy, /^>=/);
  assert.equal(typeof manifest.main, 'string');
  assert.ok(fs.existsSync(path.join(ROOT, manifest.main)), 'manifest.main must exist on disk');
  assert.equal(manifest.schemaVersion, undefined, 'v1 manifest must not declare schemaVersion 2.0');

  assert.ok(Array.isArray(manifest.capabilities));
  assert.ok(manifest.capabilities.includes('mcp'));
  assert.ok(Array.isArray(manifest.provides));
  assert.ok(manifest.provides.includes('amoon-bridge'));
  assert.equal(manifest.permissions.network, true);
  assert.equal(manifest.permissions.spawn, true);
});

test('namespace amoon is unique across delivery/extension', () => {
  const extensionRoot = path.resolve(ROOT, '..', '..');
  const manifests = collectManifests(extensionRoot);
  const owners = manifests
    .filter(({ manifest }) => manifest && manifest.namespace === 'amoon')
    .map(({ file }) => file);

  assert.equal(owners.length, 1, `namespace "amoon" must be unique, found: ${owners.join(', ')}`);
  assert.equal(path.resolve(owners[0]), MANIFEST_PATH);
});

test('engines.khy matches the host KhyOS version when present', () => {
  const manifest = readJson(MANIFEST_PATH);
  const hostPkg = path.resolve(
    ROOT,
    '..',
    '..',
    '..',
    '..',
    'runtime',
    'node',
    'backend',
    'package.json'
  );
  if (!fs.existsSync(hostPkg)) {
    // Portable host not present: the range syntax check above is all we can do.
    return;
  }
  const host = readJson(hostPkg);
  assert.equal(typeof host.version, 'string');
  assert.ok(
    satisfiesGte(host.version, manifest.engines.khy),
    `host KhyOS ${host.version} does not satisfy ${manifest.engines.khy}`
  );
});

test('mcp block declares the same 12 tools as the frozen contract', () => {
  const manifest = readJson(MANIFEST_PATH);

  assert.ok(manifest.mcp && typeof manifest.mcp === 'object');
  assert.equal(manifest.mcp.transport, 'stdio');
  assert.equal(typeof manifest.mcp.command, 'string');
  assert.ok(Array.isArray(manifest.mcp.args));
  assert.ok(manifest.mcp.args.includes('bin/mcp-server.js'));
  assert.ok(fs.existsSync(path.join(ROOT, 'bin', 'mcp-server.js')));

  assert.deepEqual(manifest.mcp.tools, C.listToolNames());
  assert.deepEqual(manifest.mcp.tools, PHASE1);
  if (manifest.tools !== undefined) {
    assert.deepEqual(manifest.tools, C.listToolNames());
  }
});

test('extension.js loads without side effects and exposes activate/deactivate', async () => {
  const manifest = readJson(MANIFEST_PATH);
  const entry = require(path.join(ROOT, manifest.main));

  assert.equal(typeof entry.activate, 'function');
  assert.equal(typeof entry.deactivate, 'function');
  if (typeof entry.isActivated === 'function') {
    assert.equal(entry.isActivated(), false, 'require() must not activate the plugin');
  }

  const result = await entry.activate({});
  assert.equal(result.namespace, 'amoon');
  assert.equal(result.mcpEntry, 'bin/mcp-server.js');
  await entry.deactivate();
});

test('package.json stays private, dependency-free and points at real files', () => {
  const pkg = readJson(PKG_PATH);

  assert.equal(pkg.name, C.EXTENSION_ID);
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'commonjs');
  assert.equal(pkg.dependencies, undefined, 'zero third-party dependencies');
  assert.equal(pkg.devDependencies, undefined, 'zero third-party dev dependencies');
  assert.equal(typeof pkg.bin['khy-amoon-bridge'], 'string');
  assert.ok(fs.existsSync(path.join(ROOT, pkg.bin['khy-amoon-bridge'])));
  assert.equal(typeof pkg.engines.node, 'string');
  assert.match(pkg.engines.node, />=\s*22/);
  assert.equal(typeof pkg.scripts.test, 'string');
});

test('README documents the Phase 0 gate, install path and security invariants', () => {
  assert.ok(fs.existsSync(README_PATH), 'README.md must exist');
  const text = fs.readFileSync(README_PATH, 'utf8');

  for (const needle of [
    'Phase 0',
    'khy mcp add',
    'mcp__amoon__',
    '127.0.0.1',
    'unverified',
    'install.ps1',
    'doctor.ps1',
    'khy_ask',
  ]) {
    assert.ok(text.includes(needle), `README.md must mention ${needle}`);
  }
  assert.ok(!/双向可用/.test(text), 'README must not claim bidirectional delivery');
});
