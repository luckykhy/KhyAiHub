'use strict';

/**
 * r58 contract tests — _extractProjectBlock must key on the `[project]` TOML
 * table header at LINE START, never on a `[project]` literal inside a comment.
 *
 * Real-world defect: pyproject.toml line 2 is
 *   `# [project] version is the STATIC single source of truth ...`
 * and the old first-literal regex captured that comment span, so _readState
 * returned packageName='' / pyproject version='' on the REAL repo — lying
 * status panel plus a vacuously-true versionAligned that silently disabled the
 * 「版本未对齐」publish guard.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ps = require('../../src/services/domain/deploy/publish/projectState.js');

function makeFixtureRoot(tweak = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-r58-'));
  const pyproject =
    '# Khy OS — pip channel manifest (PyPI package: khy-os).\n' +
    '# [project] version is the STATIC single source of truth for the pip channel;\n' +
    '# scripts/ci/check-version-sync.js enforces that it matches.\n' +
    '\n' +
    '[build-system]\n' +
    'requires = ["setuptools>=68", "wheel"]\n' +
    '\n' +
    '[project]\n' +
    `name = "${tweak.name || 'khy-os'}"\n` +
    `version = "${tweak.pyVersion || '1.2.0'}"\n` +
    'description = "demo"\n' +
    '\n' +
    '[project.scripts]\n' +
    'khy = "khy_platform.cli:main"\n';
  fs.writeFileSync(path.join(root, 'pyproject.toml'), pyproject, 'utf-8');
  const backendDir = path.join(root, 'services', 'backend');
  fs.mkdirSync(backendDir, { recursive: true });
  fs.writeFileSync(
    path.join(backendDir, 'package.json'),
    JSON.stringify({ name: 'fixture-backend', version: tweak.backendVersion || '1.2.0' }, null, 2) + '\n',
    'utf-8'
  );
  return root;
}

describe('r58 projectState comment-hijack contract', () => {
  test('T1: comment mentioning [project] does not hijack header extraction', () => {
    const root = makeFixtureRoot();
    const content = ps._readFileSafe(path.join(root, 'pyproject.toml'));
    expect(ps._extractProjectField(content, 'name')).toBe('khy-os');
    expect(ps._extractProjectField(content, 'version')).toBe('1.2.0');
  });

  test('T2: versionAligned guard is live (misaligned pyproject vs backend => false)', () => {
    const root = makeFixtureRoot({ pyVersion: '1.2.0', backendVersion: '9.9.9' });
    const state = ps._readState(root);
    expect(state.versions.pyproject).toBe('1.2.0');
    expect(state.versionAligned).toBe(false);
  });

  test('T3: aligned real-shape repo reports truthful state', () => {
    const root = makeFixtureRoot();
    const state = ps._readState(root);
    expect(state.packageName).toBe('khy-os');
    expect(state.versions.backend).toBe('1.2.0');
    expect(state.versionAligned).toBe(true);
  });

  test('T4: block ends at next table header; [project.scripts] body excluded', () => {
    const root = makeFixtureRoot({ name: 'block-scope' });
    const content = ps._readFileSafe(path.join(root, 'pyproject.toml'));
    const block = ps._extractProjectBlock(content);
    expect(block).toContain('name = "block-scope"');
    expect(block).not.toContain('khy = "khy_platform.cli:main"');
  });

  test('T5: no [project] table at all => empty block, no throw', () => {
    const content = '# [project] only ever mentioned in a comment\n[build-system]\nrequires = []\n';
    expect(ps._extractProjectBlock(content)).toBe('');
    expect(ps._extractProjectField(content, 'version')).toBe('');
  });
});
