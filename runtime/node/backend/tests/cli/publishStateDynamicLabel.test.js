'use strict';

/**
 * r59 contract tests — the publish status panel must not render the
 * dynamic-version khy_platform track as a read failure.
 *
 * Defect: `版本(khy_platform): -` used the SAME '-' glyph as genuine
 * missing/unreadable sources, while a literal-free
 * platform/khy_platform/__init__.py is the documented design (the literal is
 * forbidden by check-version-sync.js), so every healthy repo printed a
 * fault-looking row.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { handlePublish, _readState } = require('../../src/cli/handlers/publish.js');

function makeFixtureRoot({ initBody, backendVersion = '1.1.9' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-r59t-'));
  fs.writeFileSync(
    path.join(root, 'pyproject.toml'),
    '# [project] comment mention\n\n[build-system]\nrequires = []\n\n[project]\n' +
      'name = "khy-os"\nversion = "1.2.0"\n\n[project.scripts]\nkhy = "khy_platform.cli:main"\n',
    'utf-8'
  );
  const backendDir = path.join(root, 'services', 'backend');
  fs.mkdirSync(backendDir, { recursive: true });
  // Deliberately misaligned so handlePublish aborts at the alignment guard
  // right after the panel — the probe never reaches build/upload machinery.
  fs.writeFileSync(
    path.join(backendDir, 'package.json'),
    JSON.stringify({ name: 'fixture-backend', version: backendVersion }, null, 2) + '\n',
    'utf-8'
  );
  if (initBody !== null) {
    const pyDir = path.join(root, 'platform', 'khy_platform');
    fs.mkdirSync(pyDir, { recursive: true });
    fs.writeFileSync(path.join(pyDir, '__init__.py'), initBody, 'utf-8');
  }
  return root;
}

function captureOutput(fn) {
  const lines = [];
  const spies = [
    jest.spyOn(console, 'log').mockImplementation((...a) => lines.push(a.join(' '))),
    jest.spyOn(console, 'error').mockImplementation((...a) => lines.push(a.join(' '))),
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    }),
  ];
  return fn().finally(() => {
    spies.forEach((s) => s.mockRestore());
  }).then((result) => ({ result, out: lines.join('\n') }));
}

const DYNAMIC_INIT =
  '"""__version__ is resolved DYNAMICALLY — never hard-code a literal."""\n\n' +
  'def _detect_version():\n    return "1.2.0"\n\n__version__ = _detect_version()\n';
const LITERAL_INIT = 'name = "khy_platform"\n\n__version__ = "1.2.0"\n';

let prevExitCode;
beforeEach(() => {
  prevExitCode = process.exitCode;
});
afterEach(() => {
  process.exitCode = prevExitCode;
});

describe('r59 khy_platform dynamic-version panel row', () => {
  test('T1: dynamic init file (no literal) no longer prints the fault dash', async () => {
    const root = makeFixtureRoot({ initBody: DYNAMIC_INIT });
    expect(_readState(root).pythonDynamic).toBe(true);
    const { out } = await captureOutput(() => handlePublish('check', [], { root }));
    expect(out).toContain('版本(khy_platform): (动态解析，无字面量)');
    expect(out).not.toContain('版本(khy_platform): -');
  });

  test('T2: literal version still takes precedence and prints truthfully', async () => {
    // Regression guard: deliberately field-free so it stays green pre-fix too,
    // proving the fix did not change literal-value handling.
    const root = makeFixtureRoot({ initBody: LITERAL_INIT });
    const { out } = await captureOutput(() => handlePublish('check', [], { root }));
    expect(out).toContain('版本(khy_platform): 1.2.0');
  });

  test('T3: missing init file keeps the honest dash', async () => {
    // Regression guard (same rationale as T2): '-' for a genuinely absent
    // file must survive the dynamic-vs-missing split.
    const root = makeFixtureRoot({ initBody: null });
    const { out } = await captureOutput(() => handlePublish('check', [], { root }));
    expect(out).toContain('版本(khy_platform): -');
  });

  test('T4: non-vacuity — panel row differs between dynamic and missing cases', async () => {
    const dyn = makeFixtureRoot({ initBody: DYNAMIC_INIT });
    const miss = makeFixtureRoot({ initBody: null });
    const a = _readState(dyn).pythonDynamic;
    const b = _readState(miss).pythonDynamic;
    expect(a).not.toBe(b);
  });

  // r60: the 「未对齐」warning must name only sources that actually
  // participated in the comparison, with their values.
  test('T5: dynamic track is NOT listed as a misalignment party', async () => {
    const root = makeFixtureRoot({ initBody: DYNAMIC_INIT });
    const { out } = await captureOutput(() => handlePublish('check', [], { root }));
    expect(out).toContain('版本号未对齐（pyproject=1.2.0 / backend=1.1.9 不一致）');
    expect(out).not.toContain('pyproject / khy_platform / backend 不一致');
  });

  test('T6: literal python track legitimately participates and is listed', async () => {
    const root = makeFixtureRoot({ initBody: LITERAL_INIT, backendVersion: '1.1.9' });
    const { out } = await captureOutput(() => handlePublish('check', [], { root }));
    expect(out).toContain('pyproject=1.2.0 / khy_platform=1.2.0 / backend=1.1.9');
  });
});
