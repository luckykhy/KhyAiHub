'use strict';

/**
 * Contract tests for r56: `publish --version` failures must be owned by the
 * handler — native Chinese error, honest exit code, dispatch handled:true —
 * instead of throwing through to the registry's generic catch (jargon header,
 * handled:false → REPL re-forwards the raw publish text to the AI gateway).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const publish = require('../../src/cli/handlers/publish');

function captureConsole(fn) {
  const lines = [];
  const spyLog = jest.spyOn(console, 'log').mockImplementation((...a) => lines.push(a.join(' ')));
  const spyErr = jest.spyOn(console, 'error').mockImplementation((...a) => lines.push(a.join(' ')));
  const spyWrite = jest
    .spyOn(process.stdout, 'write')
    .mockImplementation((...a) => lines.push(String(a[0])));
  return Promise.resolve()
    .then(fn)
    .then((result) => ({ result, out: lines.join('\n') }))
    .finally(() => {
      spyLog.mockRestore();
      spyErr.mockRestore();
      spyWrite.mockRestore();
    });
}

function makeFixtureRoot(tweaks = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-r56-'));
  fs.mkdirSync(path.join(root, 'services', 'backend'), { recursive: true });
  const pyproject =
    tweaks.missingVersionField
      ? '[project]\nname = "fixture-pkg"\n'
      : '[project]\nname = "fixture-pkg"\nversion = "0.0.1"\n';
  fs.writeFileSync(path.join(root, 'pyproject.toml'), pyproject, 'utf-8');
  fs.writeFileSync(
    path.join(root, 'services', 'backend', 'package.json'),
    JSON.stringify({ name: 'fixture-backend', version: '0.0.1' }, null, 2) + '\n',
    'utf-8'
  );
  return root;
}

describe('publish --version failure honesty (r56)', () => {
  const savedExitCode = process.exitCode;
  afterEach(() => {
    process.exitCode = savedExitCode;
  });

  test('T1 illegal version via real dispatch: native error, no registry jargon, handled:true, rc=1', async () => {
    process.exitCode = undefined;
    const registry = require('../../src/cli/commandAutoRegistry');
    registry.init();
    const parsed = {
      command: 'publish',
      subCommand: 'pypi',
      args: [],
      options: { version: 'not-a-version!!' },
      rawInput: 'publish pypi --version not-a-version!!',
    };
    const { result, out } = await captureConsole(() =>
      registry.dispatch('publish', {
        ...parsed,
        parsed,
        printError: (m) => console.log(m),
      })
    );
    expect(result.handled).toBe(true);
    expect(result.result).toBe(true);
    expect(out).toContain('版本同步失败');
    expect(out).toContain('版本号格式不合法');
    expect(out).not.toContain('自注册命令执行失败');
    expect(process.exitCode).toBe(1);
  });

  test('T2 engine happy path still writes every version source (fixture root)', () => {
    const root = makeFixtureRoot();
    publish._updateVersions(root, '9.9.9');
    const pyproject = fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf-8');
    const backendPkg = JSON.parse(
      fs.readFileSync(path.join(root, 'services', 'backend', 'package.json'), 'utf-8')
    );
    expect(pyproject).toContain('version = "9.9.9"');
    expect(backendPkg.version).toBe('9.9.9');
  });

  test('T3 missing version field surfaces through the same native catch (not jargon)', async () => {
    process.exitCode = undefined;
    const root = makeFixtureRoot({ missingVersionField: true });
    const { result, out } = await captureConsole(() =>
      publish.handlePublish('pypi', [], { version: '9.9.9', root })
    );
    expect(result).toBe(true);
    expect(out).toContain('版本同步失败');
    expect(out).toContain('未在 pyproject.toml 找到可更新的版本字段');
    expect(out).not.toContain('自注册命令执行失败');
    expect(process.exitCode).toBe(1);
  });

  test('T4 unknown subcommand contract unchanged: native line, returns false', async () => {
    const { result, out } = await captureConsole(() =>
      publish.handlePublish('frobnicate-subcommand', [], {})
    );
    expect(result).toBe(false);
    expect(out).toContain('未知 publish 子命令');
  });
});
