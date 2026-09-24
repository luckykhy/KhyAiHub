'use strict';

/**
 * r61 contract: the publish alignment guard must compare the SAME source set
 * as the version-sync gate (G1 'main-khy-os': pyproject / packaging-npm /
 * backend / modules.json). Before r61, _readState never read the npm or
 * modules manifests, so drift confined to those tracks produced a silent
 * panel and a vacuously-true `versionAligned` — a false green the release
 * gate would later reject (same family as r58's comment-hijack).
 *
 * All probes run through the REAL code path (handlePublish('_check') against
 * throwaway mkdtemp fixtures). Fixtures keep at least one track misaligned
 * where a full pass would otherwise continue into python/db steps; the check
 * action's panel+guard output is what is asserted.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  handlePublish,
  _readState,
  _updateVersions,
} = require('../../src/cli/handlers/publish.js');

const DYNAMIC_INIT =
  '"""Launcher package. __version__ is resolved DYNAMICALLY."""\n\n' +
  'def _detect_version():\n    return "9.9.9"\n\n__version__ = _detect_version()\n';
const LITERAL_INIT = 'name = "x"\n__version__ = "1.2.0"\n';

function makeFixtureRoot(overrides = {}) {
  const {
    pyVersion = '1.2.0',
    initBody = DYNAMIC_INIT,
    backendVersion = '1.2.0',
    npmVersion = '1.2.0',
    modulesVersion = '1.2.0',
    omitNpm = false,
    omitModules = false,
  } = overrides;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-r61t-'));
  fs.writeFileSync(
    path.join(root, 'pyproject.toml'),
    '# [project] version is the STATIC single source of truth.\n' +
      '\n[build-system]\nrequires = ["setuptools>=68"]\n\n[project]\n' +
      `name = "khy-os"\nversion = "${pyVersion}"\n\n[project.scripts]\nkhy = "cli:main"\n`,
    'utf-8'
  );
  const backendDir = path.join(root, 'services', 'backend');
  fs.mkdirSync(backendDir, { recursive: true });
  fs.writeFileSync(
    path.join(backendDir, 'package.json'),
    JSON.stringify({ name: 'fixture-backend', version: backendVersion }, null, 2) + '\n',
    'utf-8'
  );
  const npmDir = path.join(root, 'packaging', 'npm');
  fs.mkdirSync(npmDir, { recursive: true });
  if (!omitNpm) {
    fs.writeFileSync(
      path.join(npmDir, 'package.json'),
      JSON.stringify({ name: '@khy-os/khy-os', version: npmVersion }, null, 2) + '\n',
      'utf-8'
    );
  }
  const modDir = path.join(root, 'packaging', 'modules');
  fs.mkdirSync(modDir, { recursive: true });
  if (!omitModules) {
    fs.writeFileSync(
      path.join(modDir, 'modules.json'),
      JSON.stringify({ version: modulesVersion, modules: [{ id: 'm1' }] }, null, 2) + '\n',
      'utf-8'
    );
  }
  if (initBody !== null) {
    const pyDir = path.join(root, 'platform', 'khy_platform');
    fs.mkdirSync(pyDir, { recursive: true });
    fs.writeFileSync(path.join(pyDir, '__init__.py'), initBody, 'utf-8');
  }
  return root;
}

function captureOutput(fn) {
  const lines = [];
  const sinks = [
    [console, 'log'],
    [console, 'error'],
    [process.stdout, 'write'],
  ];
  const saved = sinks.map(([obj, key]) => {
    const orig = obj[key];
    obj[key] = (msg) => {
      lines.push(String(msg));
      return undefined;
    };
    return [obj, key, orig];
  });
  let result;
  try {
    result = fn();
  } finally {
    for (const [obj, key, orig] of saved) obj[key] = orig;
  }
  return { text: lines.join(''), result };
}

let savedExitCode;
beforeEach(() => {
  savedExitCode = process.exitCode;
});
afterEach(() => {
  process.exitCode = savedExitCode;
});

// T1: npm-only drift must flip versionAligned to false (pre-fix: true — the
// false green this round kills).
test('T1 npm-only drift is no longer invisible to the guard', () => {
  const root = makeFixtureRoot({ npmVersion: '1.1.9' });
  const state = _readState(root);
  expect(state.versions.npm).toBe('1.1.9');
  expect(state.versionAligned).toBe(false);
});

// T2: modules-only drift likewise joins the comparison.
test('T2 modules-only drift flips the guard', () => {
  const root = makeFixtureRoot({ modulesVersion: '1.1.9' });
  const state = _readState(root);
  expect(state.versions.modules).toBe('1.1.9');
  expect(state.versionAligned).toBe(false);
});

// T3: the panel must SHOW every participating track and name the real culprit.
test('T3 panel prints npm/modules tracks and names npm as the drifting party', async () => {
  const root = makeFixtureRoot({ npmVersion: '1.1.9' });
  const { text } = captureOutput(() => handlePublish('check', [], { root }));
  expect(text).toContain('版本(npm渠道): 1.1.9');
  expect(text).toContain('版本(modules清单): 1.2.0');
  expect(text).toContain('版本号未对齐');
  expect(text).toContain('npm=1.1.9');
  // r60 party rule: tracks with no value never get named as culprits.
  expect(text).not.toContain('khy_platform=');
});

// T4: the advertised single-knob remedy must actually satisfy the extended
// guard — `--version` writes ALL FOUR G1 sources, then alignment recomputes true.
test('T4 _updateVersions syncs all four G1 sources (remedy honesty)', async () => {
  const root = makeFixtureRoot({ npmVersion: '1.1.9', modulesVersion: '1.1.9' });
  expect(_readState(root).versionAligned).toBe(false);
  _updateVersions(root, '2.0.0');
  const state = _readState(root);
  expect(state.versions).toMatchObject({
    pyproject: '2.0.0',
    backend: '2.0.0',
    npm: '2.0.0',
    modules: '2.0.0',
  });
  expect(state.versionAligned).toBe(true);
  const { text } = captureOutput(() => handlePublish('check', [], { root }));
  expect(text).not.toContain('版本号未对齐');
});

// T5 (regression guard, must stay green pre- AND post-fix): a LITERAL
// khy_platform version still participates in the comparison, and an all-4
// aligned healthy tree reports aligned with the dynamic label intact.
test('T5 literal init participates; healthy tree stays green', () => {
  const drifted = makeFixtureRoot({ initBody: LITERAL_INIT });
  const dState = _readState(drifted);
  expect(dState.versions.python).toBe('1.2.0');
  // literal 1.2.0 vs all-1.2.0 → aligned; drift it via backend instead:
  const bRoot = makeFixtureRoot({ initBody: LITERAL_INIT, backendVersion: '1.1.9' });
  expect(_readState(bRoot).versionAligned).toBe(false);

  const healthy = makeFixtureRoot();
  const hState = _readState(healthy);
  expect(hState.versionAligned).toBe(true);
  expect(hState.pythonDynamic).toBe(true);
});
