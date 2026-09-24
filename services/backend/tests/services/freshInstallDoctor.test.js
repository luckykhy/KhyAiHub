'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  CATEGORY,
  PORTABLE_CATEGORY,
  assessFreshInstall,
  gatherFreshInstallFacts,
  freshInstallChecks,
  describeBundledRuntime,
  _gateEnabled,
  _proxyCoreHintEnabled,
  _dualInstallCheckEnabled,
  _detectChannel,
  _defaultWhich,
} = require('../../src/services/freshInstallDoctor');

const ALL_PRESENT = {
  bundleRoot: '/bundle',
  binEntryPresent: true,
  serverEntryPresent: true,
  nodeModulesPresent: true,
  hydrationSentinelPresent: true,
  khyOnPath: true,
  khyResolvedName: 'khy',
};

function byLabel(checks, needle) {
  return checks.find((c) => c.label.includes(needle));
}

test('assessFreshInstall: all facts present → every check ok, under the 离机还原自检 category', () => {
  const checks = assessFreshInstall(ALL_PRESENT);
  assert.ok(checks.length >= 4);
  for (const c of checks) {
    assert.strictEqual(c.category, CATEGORY);
    assert.strictEqual(c.ok, true, c.label);
  }
});

test('assessFreshInstall: missing bin/khy.js → fail with 原因+解决方法 and reinstall fix', () => {
  const checks = assessFreshInstall({ ...ALL_PRESENT, binEntryPresent: false });
  const entry = byLabel(checks, 'bin/khy.js');
  assert.strictEqual(entry.ok, false);
  assert.strictEqual(entry.level, 'error');
  assert.match(entry.detail, /原因：/);
  assert.match(entry.detail, /解决方法：/);
  assert.match(entry.detail, /force-reinstall/);
});

test('assessFreshInstall: node_modules present but empty shell → hydration fail names 空壳', () => {
  const checks = assessFreshInstall({
    ...ALL_PRESENT, nodeModulesPresent: true, hydrationSentinelPresent: false,
  });
  const hy = byLabel(checks, '依赖水合');
  assert.strictEqual(hy.ok, false);
  assert.match(hy.detail, /空壳/);
  assert.match(hy.detail, /npm install|首启/);
});

test('assessFreshInstall: node_modules absent → hydration fail names 缺失', () => {
  const checks = assessFreshInstall({
    ...ALL_PRESENT, nodeModulesPresent: false, hydrationSentinelPresent: false,
  });
  const hy = byLabel(checks, '依赖水合');
  assert.strictEqual(hy.ok, false);
  assert.match(hy.detail, /缺失/);
});

test('assessFreshInstall: khy off PATH → warn level and points to python -m khy_platform', () => {
  const checks = assessFreshInstall({ ...ALL_PRESENT, khyOnPath: false, khyResolvedName: '' });
  const reach = byLabel(checks, 'khy 命令可达');
  assert.strictEqual(reach.ok, false);
  assert.strictEqual(reach.level, 'warn'); // fallback exists → not a hard error
  assert.match(reach.detail, /python -m khy_platform/);
});

test('assessFreshInstall: never throws on garbage input', () => {
  for (const bad of [undefined, null, 42, 'x', {}, []]) {
    assert.doesNotThrow(() => assessFreshInstall(bad));
    assert.ok(Array.isArray(assessFreshInstall(bad)));
  }
});

// ── Proxy-core (mihomo) download hint — check #5 (OPS-137 SSOT, CLI surface) ──
const CORE_DESC = {
  version: 'v1.18.10',
  releasesPage: 'https://github.com/MetaCubeX/mihomo/releases',
  binDir: '/home/u/.khy/bin',
  dest: '/home/u/.khy/bin/mihomo',
  platform: 'linux',
  arch: 'x64',
  supported: true,
  url: 'https://github.com/MetaCubeX/mihomo/releases/download/v1.18.10/mihomo-linux-amd64-v1.18.10.gz',
  assetFile: 'mihomo-linux-amd64-v1.18.10.gz',
  kind: 'gz',
};

test('assessFreshInstall: no coreDescriptor → no proxy-core check (byte-revert, 4 checks)', () => {
  const checks = assessFreshInstall(ALL_PRESENT);
  assert.strictEqual(byLabel(checks, '代理内核'), undefined);
  assert.strictEqual(checks.length, 4);
});

test('assessFreshInstall: core absent → info-only (ok:true), carries download URL + version', () => {
  const checks = assessFreshInstall({ ...ALL_PRESENT, coreDescriptor: CORE_DESC, corePresent: false });
  const core = byLabel(checks, '代理内核');
  assert.ok(core, 'proxy-core check present');
  assert.strictEqual(core.level, 'info');
  assert.strictEqual(core.ok, true, 'optional capability — absence is never a failure');
  assert.match(core.detail, /未安装/);
  assert.match(core.detail, /http\/https 直连型无需/); // does-not-block framing
  assert.match(core.detail, /mihomo-linux-amd64-v1\.18\.10\.gz/); // exact URL from SSOT
  assert.match(core.detail, /v1\.18\.10/);
  assert.match(core.detail, /\/home\/u\/\.khy\/bin/); // where to place it
});

test('assessFreshInstall: core present → info “已就绪” with the resolved path', () => {
  const checks = assessFreshInstall({ ...ALL_PRESENT, coreDescriptor: CORE_DESC, corePresent: true });
  const core = byLabel(checks, '代理内核');
  assert.strictEqual(core.ok, true);
  assert.strictEqual(core.level, 'info');
  assert.match(core.detail, /已就绪/);
  assert.match(core.detail, /\/home\/u\/\.khy\/bin\/mihomo/);
});

test('assessFreshInstall: cold platform (supported:false, no url) → points at releases page', () => {
  const cold = {
    version: 'v1.18.10',
    releasesPage: 'https://github.com/MetaCubeX/mihomo/releases',
    binDir: '/x/bin', dest: '/x/bin/mihomo', platform: 'sunos', arch: 'sparc', supported: false,
  };
  const checks = assessFreshInstall({ ...ALL_PRESENT, coreDescriptor: cold, corePresent: false });
  const core = byLabel(checks, '代理内核');
  assert.strictEqual(core.ok, true);
  assert.match(core.detail, /无预置资产/);
  assert.match(core.detail, /MetaCubeX\/mihomo\/releases/);
});

test('_proxyCoreHintEnabled: default-on; only 0/false/off/no disable', () => {
  assert.strictEqual(_proxyCoreHintEnabled({}), true);
  assert.strictEqual(_proxyCoreHintEnabled({ KHY_DOCTOR_PROXY_CORE_HINT: '1' }), true);
  for (const w of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(_proxyCoreHintEnabled({ KHY_DOCTOR_PROXY_CORE_HINT: w }), false, w);
  }
});

test('gatherFreshInstallFacts: injected describeCoreDownload + dest present → corePresent true', () => {
  const present = new Set([CORE_DESC.dest]);
  const facts = gatherFreshInstallFacts({
    bundleRoot: '/b',
    existsSync: (p) => present.has(p),
    which: () => 'khy',
    env: {},
    platform: 'linux',
    arch: 'x64',
    describeCoreDownload: () => CORE_DESC,
  });
  assert.deepStrictEqual(facts.coreDescriptor, CORE_DESC);
  assert.strictEqual(facts.corePresent, true);
});

test('gatherFreshInstallFacts: dest absent → coreDescriptor kept, corePresent false', () => {
  const facts = gatherFreshInstallFacts({
    bundleRoot: '/b',
    existsSync: () => false,
    which: () => 'khy',
    env: {},
    platform: 'linux',
    arch: 'x64',
    describeCoreDownload: () => CORE_DESC,
  });
  assert.deepStrictEqual(facts.coreDescriptor, CORE_DESC);
  assert.strictEqual(facts.corePresent, false);
});

test('gatherFreshInstallFacts: sub-gate off → no descriptor gathered (byte-revert)', () => {
  const facts = gatherFreshInstallFacts({
    bundleRoot: '/b',
    existsSync: () => true,
    which: () => 'khy',
    env: { KHY_DOCTOR_PROXY_CORE_HINT: 'off' },
    platform: 'linux',
    arch: 'x64',
    describeCoreDownload: () => CORE_DESC,
  });
  assert.strictEqual(facts.coreDescriptor, null);
  assert.strictEqual(facts.corePresent, false);
});

test('gatherFreshInstallFacts: describeCoreDownload throws → fail-soft null, no throw', () => {
  let facts;
  assert.doesNotThrow(() => {
    facts = gatherFreshInstallFacts({
      bundleRoot: '/b',
      existsSync: () => true,
      which: () => 'khy',
      env: {},
      platform: 'linux',
      arch: 'x64',
      describeCoreDownload: () => { throw new Error('subsystem boom'); },
    });
  });
  assert.strictEqual(facts.coreDescriptor, null);
});

test('freshInstallChecks: real describeCoreDownload SSOT wired end-to-end (no injection)', () => {
  // No describeCoreDownload injected → the leaf lazily requires the real
  // proxyCoreInstaller SSOT. Assert the proxy-core check appears with a concrete
  // dest/releasesPage, proving the wiring (OPS-137 SSOT → CLI doctor) is live.
  const out = freshInstallChecks({
    bundleRoot: '/nonexistent-bundle',
    existsSync: () => false,
    which: () => '',
    env: {},
    platform: 'linux',
    arch: 'x64',
  });
  const core = out.find((c) => c.label.includes('代理内核'));
  assert.ok(core, 'real SSOT produced a proxy-core hint');
  assert.strictEqual(core.level, 'info');
  assert.match(core.detail, /mihomo|MetaCubeX/);
});

test('_gateEnabled: default-on; only 0/false/off/no disable', () => {
  assert.strictEqual(_gateEnabled({}), true);
  assert.strictEqual(_gateEnabled({ KHY_DOCTOR_FRESH_INSTALL: '1' }), true);
  for (const w of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(_gateEnabled({ KHY_DOCTOR_FRESH_INSTALL: w }), false, w);
  }
});

test('freshInstallChecks: gate off → [] (byte-revert, doctor shows nothing new)', () => {
  const out = freshInstallChecks({
    bundleRoot: '/bundle',
    existsSync: () => true,
    env: { KHY_DOCTOR_FRESH_INSTALL: 'off' },
  });
  assert.deepStrictEqual(out, []);
});

test('gatherFreshInstallFacts: injected existsSync drives facts (bin present, server missing)', () => {
  const present = new Set([
    path.join('/b', 'bin', 'khy.js'),
    path.join('/b', 'node_modules'),
    path.join('/b', 'node_modules', '.bin'),
  ]);
  const facts = gatherFreshInstallFacts({
    bundleRoot: '/b',
    existsSync: (p) => present.has(p),
    which: () => 'khy',
    env: {},
    platform: 'linux',
  });
  assert.strictEqual(facts.binEntryPresent, true);
  assert.strictEqual(facts.serverEntryPresent, false);
  assert.strictEqual(facts.nodeModulesPresent, true);
  assert.strictEqual(facts.hydrationSentinelPresent, true);
  assert.strictEqual(facts.khyOnPath, true);
});

// ── SSOT-alignment regression (深挖 defect) ──────────────────────────────────
// The pip launcher's hydration check (cli.py:1820) is content-AGNOSTIC:
// `node_modules exists AND is non-empty`. On a hoisted/workspace layout the real
// deps live at the repo-root node_modules, so services/backend/node_modules holds
// only a few hoist-stragglers — none of the old name-allowlist (express /
// .package-lock.json). The doctor MUST agree with the launcher and report
// hydrated, not falsely cry "空壳".
test('gatherFreshInstallFacts: hoisted layout (non-empty, no express/.package-lock) → hydrated via readdir SSOT', () => {
  const present = new Set([path.join('/b', 'node_modules')]);
  const facts = gatherFreshInstallFacts({
    bundleRoot: '/b',
    existsSync: (p) => present.has(p),
    // hoist-stragglers only — deliberately none of the old sentinel names
    readdir: (p) => (p === path.join('/b', 'node_modules')
      ? ['ansi-regex', 'brace-expansion', '@khy'] : []),
    which: () => 'khy',
    env: {},
    platform: 'linux',
  });
  assert.strictEqual(facts.nodeModulesPresent, true);
  assert.strictEqual(
    facts.hydrationSentinelPresent, true,
    'non-empty node_modules must count as hydrated (launcher SSOT)',
  );
});

test('gatherFreshInstallFacts: truly empty node_modules → not hydrated (readdir SSOT)', () => {
  const present = new Set([path.join('/b', 'node_modules')]);
  const facts = gatherFreshInstallFacts({
    bundleRoot: '/b',
    existsSync: (p) => present.has(p),
    readdir: () => [], // empty shell — the real "空壳"
    which: () => 'khy',
    env: {},
    platform: 'linux',
  });
  assert.strictEqual(facts.nodeModulesPresent, true);
  assert.strictEqual(facts.hydrationSentinelPresent, false);
});

test('gatherFreshInstallFacts: readdir throws → fail-soft to not-hydrated, no throw', () => {
  const present = new Set([path.join('/b', 'node_modules')]);
  let facts;
  assert.doesNotThrow(() => {
    facts = gatherFreshInstallFacts({
      bundleRoot: '/b',
      existsSync: (p) => present.has(p),
      readdir: () => { throw new Error('io boom'); },
      which: () => '',
      env: {},
      platform: 'linux',
    });
  });
  assert.strictEqual(facts.hydrationSentinelPresent, false);
});

test('gatherFreshInstallFacts: no readdir injected → falls back to name probe (.bin)', () => {
  const present = new Set([
    path.join('/b', 'node_modules'),
    path.join('/b', 'node_modules', '.bin'),
  ]);
  const facts = gatherFreshInstallFacts({
    bundleRoot: '/b',
    existsSync: (p) => present.has(p),
    which: () => 'khy',
    env: {},
    platform: 'linux',
  });
  assert.strictEqual(facts.hydrationSentinelPresent, true);
});

test('gatherFreshInstallFacts: fail-soft when existsSync throws → all-false facts, no throw', () => {
  let facts;
  assert.doesNotThrow(() => {
    facts = gatherFreshInstallFacts({
      bundleRoot: '/b',
      existsSync: () => { throw new Error('io boom'); },
      which: () => '',
      env: {},
      platform: 'linux',
    });
  });
  assert.strictEqual(facts.binEntryPresent, false);
  assert.strictEqual(facts.khyOnPath, false);
});

test('_defaultWhich: finds a command on PATH via injected existsSync', () => {
  const found = _defaultWhich(['khy'], {
    existsSync: (p) => p === path.join('/opt/py/bin', 'khy'),
    env: { PATH: ['/usr/bin', '/opt/py/bin'].join(':') },
    platform: 'linux',
  });
  assert.strictEqual(found, 'khy');
});

test('_defaultWhich: Windows tries .exe extension', () => {
  const found = _defaultWhich(['khy'], {
    existsSync: (p) => p === path.join('C:\\py\\Scripts', 'khy.exe'),
    env: { PATH: 'C:\\py\\Scripts' },
    platform: 'win32',
  });
  assert.strictEqual(found, 'khy');
});

test('_defaultWhich: returns empty string when nothing matches', () => {
  const found = _defaultWhich(['khy', 'khy-os'], {
    existsSync: () => false,
    env: { PATH: '/usr/bin' },
    platform: 'linux',
  });
  assert.strictEqual(found, '');
});

// ---- Check #6: dual-channel version parity (pip / npm) — wires KHY_DUAL_INSTALL_CHECK ----

test('_dualInstallCheckEnabled: default-on; only 0/false/off/no disable', () => {
  assert.strictEqual(_dualInstallCheckEnabled({}), true);
  assert.strictEqual(_dualInstallCheckEnabled({ KHY_DUAL_INSTALL_CHECK: undefined }), true);
  assert.strictEqual(_dualInstallCheckEnabled({ KHY_DUAL_INSTALL_CHECK: '1' }), true);
  assert.strictEqual(_dualInstallCheckEnabled({ KHY_DUAL_INSTALL_CHECK: 'on' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(_dualInstallCheckEnabled({ KHY_DUAL_INSTALL_CHECK: off }), false, off);
  }
});

test('_detectChannel: pip (site-packages / khy_platform), npm (node_modules), else source', () => {
  assert.strictEqual(_detectChannel('/usr/lib/python3.12/site-packages/khy_platform/services/backend'), 'pip');
  assert.strictEqual(_detectChannel('C:\\Python312\\Lib\\site-packages\\khy_platform\\services\\backend'), 'pip');
  assert.strictEqual(_detectChannel('/home/u/.nvm/versions/node/v20/lib/node_modules/@khy-os/khy-os/services/backend'), 'npm');
  assert.strictEqual(_detectChannel('/home/u/dev/Khy-OS/services/backend'), 'source');
  assert.strictEqual(_detectChannel(''), 'source');
  assert.strictEqual(_detectChannel(null), 'source');
});

test('gatherFreshInstallFacts: dualInstall gathered with injected readVersion → {version, channel}', () => {
  const facts = gatherFreshInstallFacts({
    bundleRoot: '/opt/py/site-packages/khy_platform/services/backend',
    existsSync: () => true,
    env: {},
    platform: 'linux',
    readVersion: () => '1.0.0',
    // silence the proxy-core hint so this test isolates the dual-install fact
    describeCoreDownload: () => null,
  });
  assert.deepStrictEqual(facts.dualInstall, { version: '1.0.0', channel: 'pip' });
});

test('gatherFreshInstallFacts: sub-gate off → dualInstall null (byte-revert)', () => {
  const facts = gatherFreshInstallFacts({
    bundleRoot: '/opt/py/site-packages/khy_platform/services/backend',
    existsSync: () => true,
    env: { KHY_DUAL_INSTALL_CHECK: 'off' },
    platform: 'linux',
    readVersion: () => '1.0.0',
  });
  assert.strictEqual(facts.dualInstall, null);
});

test('gatherFreshInstallFacts: readVersion throws / empty → dualInstall null (fail-soft, no throw)', () => {
  const thrown = gatherFreshInstallFacts({
    bundleRoot: '/bundle',
    existsSync: () => true,
    env: {},
    readVersion: () => { throw new Error('boom'); },
  });
  assert.strictEqual(thrown.dualInstall, null);
  const empty = gatherFreshInstallFacts({
    bundleRoot: '/bundle',
    existsSync: () => true,
    env: {},
    readVersion: () => '',
  });
  assert.strictEqual(empty.dualInstall, null);
});

test('assessFreshInstall: dualInstall fact → info check with version + both-channel parity commands', () => {
  const checks = assessFreshInstall({ ...ALL_PRESENT, dualInstall: { version: '1.0.0', channel: 'npm' } });
  const di = byLabel(checks, '双渠道');
  assert.ok(di, 'dual-install check must be present');
  assert.strictEqual(di.ok, true, 'guidance-only → never a fault');
  assert.strictEqual(di.level, 'info');
  assert.match(di.detail, /1\.0\.0/);
  assert.match(di.detail, /khy-os==1\.0\.0/);
  assert.match(di.detail, /@khy-os\/khy-os@1\.0\.0/);
  assert.match(di.detail, /npm/);
});

test('assessFreshInstall: no dualInstall fact (or no version) → check absent (byte-revert)', () => {
  assert.strictEqual(byLabel(assessFreshInstall(ALL_PRESENT), '双渠道'), undefined);
  assert.strictEqual(byLabel(assessFreshInstall({ ...ALL_PRESENT, dualInstall: { channel: 'pip' } }), '双渠道'), undefined);
});

test('freshInstallChecks: real version SSOT wired end-to-end (no readVersion injection)', () => {
  const fs = require('fs');
  const ROOT = path.resolve(__dirname, '..', '..'); // services/backend — the runtime bundle root
  const checks = freshInstallChecks({
    bundleRoot: ROOT,
    existsSync: fs.existsSync,
    readdir: fs.readdirSync,
    env: { KHY_DOCTOR_PROXY_CORE_HINT: 'off' }, // isolate the dual-install check
    platform: process.platform,
    arch: process.arch,
  });
  const di = byLabel(checks, '双渠道');
  assert.ok(di, 'dual-install check must appear with the real package.json version');
  assert.strictEqual(di.ok, true);
  // The bundle version is a non-empty semver-ish string read from services/backend/package.json.
  assert.match(di.detail, /本次运行版本 \d+\.\d+\.\d+/);
});

// ── Standalone-bundle channel (pip wheel / npm tarball) — describeBundledRuntime ──
// Measured payload shape (2026-09-25): BOTH off-machine channels ship exactly one
// runtime file, `runtime/khy/bundle.mjs`, and no backend tree — the wheel has 25
// members and `khy_platform/bundled/` holds only `runtime/`; the npm tarball's
// `bundled/` holds only `runtime/`. So `bin/khy.js`, `server.js`, `node_modules`
// and `.env` under the bundle root cannot exist there. Mirrors the launcher SSOT
// `_is_standalone_bundle_install()` (platform/khy_platform/cli.py:448), which
// likewise skips `npm install` / `.env` writing in bundle mode.

const PIP_ROOT = path.resolve(path.sep, 'site', 'khy_platform', 'bundled');
const PIP_RUNTIME_DIR = path.join(PIP_ROOT, 'runtime', 'khy');
const PIP_BUNDLE = path.join(PIP_RUNTIME_DIR, 'bundle.mjs');
const argvFor = (bundleFile) => ['node', bundleFile, 'doctor', '--json'];
const SOURCE_HANDLERS = path.resolve(path.sep, 'repo', 'services', 'backend', 'src', 'cli', 'handlers');
const SOURCE_ENTRY = path.resolve(path.sep, 'repo', 'services', 'backend', 'bin', 'khy.js');

test('describeBundledRuntime: running from bundle.mjs → active, payload root derived', () => {
  const r = describeBundledRuntime({
    runtimeDir: PIP_RUNTIME_DIR,
    argv: argvFor(PIP_BUNDLE),
    existsSync: (p) => p === PIP_BUNDLE,
  });
  assert.strictEqual(r.active, true);
  assert.strictEqual(r.present, true);
  assert.strictEqual(r.bundleFile, PIP_BUNDLE);
  assert.strictEqual(r.root, PIP_ROOT, 'payload root comes from the running file');
});

test('describeBundledRuntime: source checkout (entry = bin/khy.js) → inert (byte-revert)', () => {
  const r = describeBundledRuntime({
    runtimeDir: SOURCE_HANDLERS,
    argv: ['node', SOURCE_ENTRY, 'doctor'],
    existsSync: () => false,
  });
  assert.strictEqual(r.active, false);
  assert.strictEqual(r.present, false);
});

test('describeBundledRuntime: stray bundle.mjs beside a source module is NOT bundle mode', () => {
  // The running file decides — a lookalike on disk must not flip a dev tree into
  // bundle semantics (that would silence the tree-layout checks where they belong).
  const stray = path.join(SOURCE_HANDLERS, 'bundle.mjs');
  const r = describeBundledRuntime({
    runtimeDir: SOURCE_HANDLERS,
    argv: ['node', SOURCE_ENTRY, 'doctor'],
    existsSync: (p) => p === stray,
  });
  assert.strictEqual(r.present, true);
  assert.strictEqual(r.active, false);
});

test('describeBundledRuntime: no argv (in-process call) → presence alone decides', () => {
  const r = describeBundledRuntime({
    runtimeDir: PIP_RUNTIME_DIR,
    argv: [],
    existsSync: (p) => p === PIP_BUNDLE,
  });
  assert.strictEqual(r.active, true);
});

test('describeBundledRuntime: never throws on garbage input', () => {
  for (const bad of [undefined, null, 42, 'x', {}, []]) {
    assert.doesNotThrow(() => describeBundledRuntime(bad));
    assert.strictEqual(describeBundledRuntime(bad).active, false);
  }
});

test('gatherFreshInstallFacts: bundle runtimeDir/argv → bundledRuntime fact populated', () => {
  const facts = gatherFreshInstallFacts({
    bundleRoot: PIP_ROOT,
    runtimeDir: PIP_RUNTIME_DIR,
    argv: argvFor(PIP_BUNDLE),
    existsSync: (p) => p === PIP_BUNDLE,
    which: () => 'khy',
    env: { KHY_DOCTOR_PROXY_CORE_HINT: 'off' },
    platform: 'linux',
    describeCoreDownload: () => null,
  });
  assert.strictEqual(facts.bundledRuntime.active, true);
  assert.strictEqual(facts.bundledRuntime.present, true);
});

const BUNDLE_FACTS = {
  bundleRoot: PIP_ROOT,
  binEntryPresent: false,
  serverEntryPresent: false,
  nodeModulesPresent: false,
  hydrationSentinelPresent: false,
  khyOnPath: true,
  khyResolvedName: 'khy',
  bundledRuntime: { active: true, present: true, bundleFile: PIP_BUNDLE, root: PIP_ROOT },
};

test('assessFreshInstall: bundled channel → asserts bundle.mjs, zero hard failures', () => {
  const checks = assessFreshInstall(BUNDLE_FACTS);
  const launch = byLabel(checks, '启动入口');
  assert.ok(launch, 'launch-entry check present');
  assert.strictEqual(launch.ok, true, 'bundle.mjs is present → the channel is healthy');
  assert.match(launch.label, /bundle\.mjs/);
  const hard = checks.filter((c) => c.ok === false && (!c.level || c.level === 'error'));
  assert.deepStrictEqual(hard, [], 'no tree-layout assertion may hard-fail in a bundle channel');
  // server/hydration become informational, with the reason spelled out
  assert.strictEqual(byLabel(checks, '服务入口').level, 'info');
  assert.match(byLabel(checks, '服务入口').detail, /内联/);
  assert.strictEqual(byLabel(checks, '依赖水合').level, 'info');
  assert.match(byLabel(checks, '依赖水合').detail, /内联/);
});

test('assessFreshInstall: bundled fact with present:false → error naming the bundle (defensive)', () => {
  // The runtime predicate cannot produce this state (active requires present — in a
  // real install the launcher/shim exec-check dies before doctor ever runs), but the
  // assessor must stay total over its facts and still name the right artifact.
  const checks = assessFreshInstall({
    ...BUNDLE_FACTS,
    bundledRuntime: { active: true, present: false, bundleFile: PIP_BUNDLE, root: PIP_ROOT },
  });
  const launch = byLabel(checks, '启动入口');
  assert.strictEqual(launch.ok, false);
  assert.strictEqual(launch.level, 'error');
  assert.match(launch.label, /bundle\.mjs/);
  assert.match(launch.detail, /原因：/);
  assert.match(launch.detail, /force-reinstall/);
});

test('assessFreshInstall: bundledRuntime inactive → tree-layout semantics unchanged', () => {
  const checks = assessFreshInstall({ ...ALL_PRESENT, bundledRuntime: { active: false, present: false } });
  assert.strictEqual(byLabel(checks, '启动入口').label, '启动入口 bin/khy.js');
  assert.strictEqual(checks.length, 4);
});

// ── Portable geometry checks are gated on a directory FOREST existing ──────────
// junction / 数据指针 only mean something where `services/backend` and
// `platform/packages/shared` sit side by side (portable copy or source export).
// The off-machine payloads have no forest, so `_portableRootOf()` lands next to
// site-packages and both checks hard-failed on impossible paths — while
// recommending `khy doctor --fix`.

test('portableSelfHealChecks: no forest → geometry checks are info 不适用, SQLite still checked', () => {
  const { portableSelfHealChecks } = require('../../src/services/freshInstallDoctor');
  const stubFs = {
    existsSync: () => false,
    lstatSync: () => { throw new Error('ENOENT'); },
    realpathSync: () => { throw new Error('ENOENT'); },
  };
  const out = portableSelfHealChecks({
    bundleRoot: path.join('/site', 'khy_platform', 'bundled'),
    env: {},
    fs: stubFs,
    probeSqlite: () => ({ ok: true, driver: 'node:sqlite' }),
  });
  for (const c of out) {
    assert.strictEqual(c.category, PORTABLE_CATEGORY);
    // `level` is carried even by ok:true items — the tree-layout items must not be
    // the *failing* pair (ok:false + level:error) that doctor counts as a fault.
    assert.ok(
      !(c.ok === false && c.level === 'error'),
      `${c.label} must not hard-fail without a forest`
    );
  }
  const junction = out.find((c) => c.label.includes('junction'));
  assert.strictEqual(junction.ok, true);
  assert.match(junction.detail, /bundled 渠道/);
  const pointer = out.find((c) => c.label.includes('数据指针'));
  assert.strictEqual(pointer.ok, true);
  assert.match(pointer.detail, /bundled 渠道/);
  assert.ok(out.some((c) => c.label.includes('SQLite') && c.ok === true), 'SQLite probe stays real');
});

test('portableSelfHealChecks: forest present (portable copy) → broken junction still hard-fails', () => {
  const { portableSelfHealChecks } = require('../../src/services/freshInstallDoctor');
  // path.resolve (not path.join) so the root carries a drive letter on Windows and
  // matches what _portableRootOf() derives from the bundle root.
  const root = path.resolve(path.sep, 'opt', 'khy-portable');
  const forestMarker = path.join(root, 'platform', 'packages', 'shared');
  const stubFs = {
    existsSync: (p) => p === forestMarker,
    lstatSync: () => { throw new Error('ENOENT'); },
    realpathSync: () => { throw new Error('ENOENT'); },
  };
  const out = portableSelfHealChecks({
    bundleRoot: path.join(root, 'khy_platform', 'bundled'),
    env: {},
    fs: stubFs,
    probeSqlite: () => ({ ok: true, driver: 'node:sqlite' }),
  });
  const junction = out.find((c) => c.label.includes('junction'));
  assert.strictEqual(junction.ok, false, 'a missing link in a real forest is still a fault');
  assert.strictEqual(junction.level, 'error');
});
