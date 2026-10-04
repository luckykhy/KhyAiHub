'use strict';

/**
 * Behavior tests for the createSwitchStore convergence inside cli/handlers/proxy.js.
 *
 * createSwitchStore is a private (non-exported) factory, so it is covered through the named thin
 * bindings it backs (loadTraeSwitchStore / saveTraeSwitchStore). Those bindings are not in
 * module.exports either; the host surfaces them via the __test__ export for exactly this purpose.
 *
 * 2026-09-23：Windsurf 适配器随其 IDE 退役更名 Devin Desktop 而下线，windsurf_switch_profiles.json
 * 的 store 绑定随之下线。本测试原先借「trae / windsurf 双 store 互不串写」来证明工厂的参数化隔离，
 * 现收敛为只覆盖 trae store 的落盘契约（缺失→兜底、损坏→兜底、存读往返、activeId 归一）。
 *
 * Isolation: KHY_APP_HOME redirects utils/dataHome.getAppHome() to a fresh os.tmpdir()
 * sandbox BEFORE proxy.js computes KHY_DIR at require time, so no real ~/.khy data is
 * ever read or written. Store calls run in child node processes so each probe gets a
 * clean require cache with the sandboxed home. The sandbox is removed on exit.
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Must be set before proxy.js (and utils/dataHome) is required in any probe process.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-switchstore-test-'));
process.env.KHY_APP_HOME = TMP_HOME;

const proxyPath = require.resolve('../../../src/cli/handlers/proxy');
const proxyModule = require(proxyPath);

const TRAE_FILE = path.join(TMP_HOME, 'trae_switch_profiles.json');

/** Run a snippet in a child node process with the sandboxed KHY_APP_HOME. */
function probe(snippet) {
  const script = `const proxy = require(${JSON.stringify(proxyPath)});\n${snippet}`;
  return execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, KHY_APP_HOME: TMP_HOME },
    encoding: 'utf-8',
  }).trim();
}

function cleanStores() {
  try {
    fs.rmSync(TRAE_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

test.after(() => {
  try {
    fs.rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('host module loads under sandboxed KHY_APP_HOME with contract exports intact', () => {
  for (const n of ['handleProxyTraeSwitch', 'handleProxySwitchCenter', 'maybeAutoSyncSwitchCenter']) {
    assert.strictEqual(typeof proxyModule[n], 'function', `missing ${n}`);
  }
  assert.strictEqual(proxyModule.handleProxyWindsurfSwitch, undefined, 'windsurf handler retired');
  assert.strictEqual(typeof proxyModule.__test__.loadTraeSwitchStore, 'function');
  assert.strictEqual(typeof proxyModule.__test__.saveTraeSwitchStore, 'function');
});

test('load returns { activeId: "", profiles: [] } fallback when store file is missing', () => {
  cleanStores();
  const out = probe(`
    const store = proxy.__test__.loadTraeSwitchStore();
    console.log(JSON.stringify(store));
  `);
  assert.deepStrictEqual(JSON.parse(out), { activeId: '', profiles: [] });
});

test('load returns fallback on corrupted JSON (no throw)', () => {
  cleanStores();
  fs.writeFileSync(TRAE_FILE, '{ not valid json !!!', 'utf-8');
  const out = probe(`
    const store = proxy.__test__.loadTraeSwitchStore();
    console.log(JSON.stringify(store));
  `);
  assert.deepStrictEqual(JSON.parse(out), { activeId: '', profiles: [] });
  cleanStores();
});

test('save→load round-trips a valid profile and keeps a valid activeId', () => {
  cleanStores();
  const out = probe(`
    const saved = proxy.__test__.saveTraeSwitchStore({
      activeId: 'alpha',
      profiles: [{ id: 'alpha', name: 'Alpha', endpoint: 'https://api.example.com/v1', key: 'k', models: ['model-a'] }],
    });
    const loaded = proxy.__test__.loadTraeSwitchStore();
    console.log(JSON.stringify({ saved, loaded }));
  `);
  const { saved, loaded } = JSON.parse(out);
  assert.strictEqual(saved.activeId, 'alpha');
  assert.strictEqual(saved.profiles.length, 1);
  assert.strictEqual(saved.profiles[0].id, 'alpha');
  assert.deepStrictEqual(saved.profiles[0].models, ['model-a']);
  assert.strictEqual(loaded.activeId, 'alpha');
  assert.strictEqual(loaded.profiles.length, 1);
  assert.strictEqual(loaded.profiles[0].endpoint, saved.profiles[0].endpoint);
  // Store file lands in the sandbox, never in the real .khy dir.
  assert.ok(fs.existsSync(TRAE_FILE), 'trae store file written to sandbox');
  cleanStores();
});

test('save normalizes an invalid activeId to empty string', () => {
  cleanStores();
  const out = probe(`
    const saved = proxy.__test__.saveTraeSwitchStore({
      activeId: 'does-not-exist',
      profiles: [{ id: 'beta', endpoint: 'https://api.example.com/v1', models: ['model-b'] }],
    });
    console.log(JSON.stringify(saved));
  `);
  const saved = JSON.parse(out);
  assert.strictEqual(saved.activeId, '');
  assert.strictEqual(saved.profiles.length, 1);
  assert.strictEqual(saved.profiles[0].id, 'beta');
  cleanStores();
});
