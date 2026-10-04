'use strict';

/**
 * Contract tests for r57: `_updateVersions` must be validate-then-commit.
 * A corrupt/unparseable later version source must fail BEFORE pyproject.toml
 * is rewritten — previously the command reported failure while leaving the
 * G1 version sources half-bumped (check-version-sync drift).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const publish = require('../../src/cli/handlers/publish');

function makeFixtureRoot(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-r57-t-'));
  fs.mkdirSync(path.join(root, 'services', 'backend'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'pyproject.toml'),
    opts.missingVersionField
      ? '[project]\nname = "fixture-pkg"\n'
      : '[project]\nname = "fixture-pkg"\nversion = "0.0.1"\n',
    'utf-8'
  );
  fs.writeFileSync(
    path.join(root, 'services', 'backend', 'package.json'),
    opts.corruptBackend
      ? '{"name": "fixture-backend",,}'
      : JSON.stringify({ name: 'fixture-backend', version: '0.0.1' }, null, 2) + '\n',
    'utf-8'
  );
  if (opts.withNpm) {
    fs.mkdirSync(path.join(root, 'packaging', 'npm'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'packaging', 'npm', 'package.json'),
      opts.corruptNpm
        ? '{"name": "@khy/os",,}'
        : JSON.stringify({ name: '@khy/os', version: '0.0.1' }, null, 2) + '\n',
      'utf-8'
    );
  }
  return root;
}

const readPyprojectVersion = (root) =>
  fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf-8').match(/version = "([^"]+)"/)[1];

describe('publish version sync atomicity (r57)', () => {
  test('T1 corrupt backend package.json fails BEFORE pyproject is written', () => {
    const root = makeFixtureRoot({ corruptBackend: true });
    expect(() => publish._updateVersions(root, '9.9.9')).toThrow(/无法解析/);
    expect(readPyprojectVersion(root)).toBe('0.0.1');
  });

  test('T2 corrupt npm package.json fails BEFORE pyproject/backend are written', () => {
    const root = makeFixtureRoot({ withNpm: true, corruptNpm: true });
    expect(() => publish._updateVersions(root, '9.9.9')).toThrow(/无法解析/);
    expect(readPyprojectVersion(root)).toBe('0.0.1');
    const backend = JSON.parse(
      fs.readFileSync(path.join(root, 'services', 'backend', 'package.json'), 'utf-8')
    );
    expect(backend.version).toBe('0.0.1');
  });

  test('T3 happy path still bumps every present source (non-vacuous)', () => {
    const root = makeFixtureRoot({ withNpm: true });
    publish._updateVersions(root, '9.9.9');
    expect(readPyprojectVersion(root)).toBe('9.9.9');
    const backend = JSON.parse(
      fs.readFileSync(path.join(root, 'services', 'backend', 'package.json'), 'utf-8')
    );
    const npm = JSON.parse(
      fs.readFileSync(path.join(root, 'packaging', 'npm', 'package.json'), 'utf-8')
    );
    expect(backend.version).toBe('9.9.9');
    expect(npm.version).toBe('9.9.9');
  });

  test('T4 missing pyproject version field fails first, nothing written', () => {
    const root = makeFixtureRoot({ missingVersionField: true, corruptBackend: true });
    // pyproject is validated first: its error wins and NO file is touched.
    expect(() => publish._updateVersions(root, '9.9.9')).toThrow(/未在 pyproject/);
    expect(
      fs.readFileSync(path.join(root, 'services', 'backend', 'package.json'), 'utf-8')
    ).toContain(',,');
  });
});
