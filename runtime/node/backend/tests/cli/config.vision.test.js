'use strict';

/**
 * `khy config set model.vision.*` — the eyes-only vision endpoint.
 *
 * These three keys live on a different plane from every other config key: their
 * source of truth is <dataHome>/vision_endpoint.json plus the khy-vision pool in
 * api_keys.json, **not .env**. So the assertion that matters most here is that
 * the .env file is byte-identical after a set.
 *
 * Why this is its own file rather than a block in config.handler.test.js:
 * utils/dataHome caches its resolution in a module-level variable on first call,
 * and config.js loads apiKeyPool (which resolves dataHome at import time) on the
 * GLM-mirror path. By the time a later describe block in that file runs, the
 * cache already points at the real dataHome, so a per-test KHY_DATA_HOME is
 * silently ignored and every write lands in the user's real home. Here the
 * sandbox is pinned at module scope, before the first project require — the same
 * discipline visionEndpointStore.test.js uses.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-config-vision-'));
const _savedDataHome = process.env.KHY_DATA_HOME;
process.env.KHY_DATA_HOME = SANDBOX;

jest.mock('../../src/cli/formatters', () => ({
  printSuccess: jest.fn(),
  printError: jest.fn(),
  printInfo: jest.fn(),
  printWarn: jest.fn(),
  printTable: jest.fn(),
}));

const { printSuccess, printError, printInfo, printTable } = require('../../src/cli/formatters');
const { handleConfig } = require('../../src/cli/handlers/config');
const store = require('../../src/services/visionEndpointStore');
const logger = require('../../src/utils/logger');

const RAW_KEY = 'sk-test-1234567890abcdef';
const FAKE_URL = 'https://your-vision-api.example.com/v1';

describe('config handler — model.vision.*', () => {
  const ORIGINAL_ENV = process.env;
  let tmpDir;
  let envPath;
  let consoleLogSpy;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-config-vision-env-'));
    envPath = path.join(tmpDir, '.env');
    fs.writeFileSync(envPath, '', 'utf-8');
    process.env = {
      ...ORIGINAL_ENV,
      HOME: tmpDir,
      USERPROFILE: tmpDir,
      KHY_ENV_FILE: envPath,
      KHY_ENV_SYNC_ROOT: 'false',
      // Re-assert after the process.env swap above.
      KHY_DATA_HOME: SANDBOX,
    };
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.clearAllMocks();
    // Every case starts from a clean endpoint.
    store.clearVisionEndpoint(require('../../src/services/apiKeyPool'));
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    process.env = ORIGINAL_ENV;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  afterAll(() => {
    if (_savedDataHome === undefined) {
      delete process.env.KHY_DATA_HOME;
    } else {
      process.env.KHY_DATA_HOME = _savedDataHome;
    }
    // SANDBOX is deliberately NOT deleted. The shared winston logger resolves its
    // log dir once, at the first project require — and that require happens after
    // KHY_DATA_HOME was pinned to SANDBOX above, so its dailyRotateFile streams
    // point inside this directory. Deleting it under a live stream makes the next
    // write fail to open (ENOENT) and emit an unhandled 'error', which kills the
    // jest worker AFTER the suite reported PASS: the run exits 1 and every suite
    // still queued in that worker is silently dropped. Closing the logger is not
    // enough (something reopens it on the next write), so the directory stays.
    // Leaving one mkdtemp dir behind matches what the repo's own isolation setup
    // does (tests/jest.taskStoreIsolation.setup.js never cleans its data homes).
  });

  const readVisionFile = () =>
    JSON.parse(fs.readFileSync(path.join(SANDBOX, 'vision_endpoint.json'), 'utf-8'));
  const visionFileExists = () => fs.existsSync(path.join(SANDBOX, 'vision_endpoint.json'));
  const lastJson = () => JSON.parse(consoleLogSpy.mock.calls.at(-1)[0]);

  test('分两步完成首次配置，且 .env 一字节未动', async () => {
    const envBefore = fs.readFileSync(envPath);

    await handleConfig('set', ['model.vision.base_url', FAKE_URL]);
    // Half-configured: the endpoint must behave exactly like "not configured",
    // otherwise a URL without a model would pin the router to an empty id.
    expect(store.readVisionEndpoint()).toBeNull();

    await handleConfig('set', ['model.vision.model', 'step-2-16k']);

    expect(fs.readFileSync(envPath).equals(envBefore)).toBe(true);
    expect(readVisionFile()).toMatchObject({ baseUrl: FAKE_URL, model: 'step-2-16k' });
    expect(store.readVisionEndpoint().pin).toBe('khy-vision/step-2-16k');
    expect(printError).not.toHaveBeenCalled();
  });

  test('半配置（只有 URL）读回来是未配置，不往路由里钉任何东西', async () => {
    await handleConfig('set', ['model.vision.base_url', FAKE_URL]);
    await handleConfig('get', ['model.vision.model'], {});
    expect(printTable).toHaveBeenCalledWith([['键', '值']], [['model.vision.model', '（未设置）']]);
  });

  test('裸 key 只进 api_keys.json，vision_endpoint.json 零密钥材料（R2 回归锁）', async () => {
    await handleConfig('set', ['model.vision.base_url', FAKE_URL]);
    await handleConfig('set', ['model.vision.model', 'step-2-16k']);
    await handleConfig('set', ['model.vision.api_key', RAW_KEY]);

    const declarative = fs.readFileSync(path.join(SANDBOX, 'vision_endpoint.json'), 'utf-8');
    expect(declarative).not.toContain(RAW_KEY);

    const pool = fs.readFileSync(path.join(SANDBOX, 'api_keys.json'), 'utf-8');
    expect(JSON.parse(pool)).toHaveProperty('khy-vision');
    expect(pool).toContain(RAW_KEY); // the pool is the only place a key may land
  });

  test('--json 回执掩码 key，envPath 明确为 null，裸 key 不出现在任何输出里', async () => {
    await handleConfig('set', ['model.vision.base_url', FAKE_URL]);
    await handleConfig('set', ['model.vision.model', 'step-2-16k']);
    // Clear the formatter mocks too, not just console.log: the two non-JSON sets
    // above already called printSuccess, and the JSON branch must print nothing.
    jest.clearAllMocks();
    await handleConfig('set', ['model.vision.api_key', RAW_KEY], { json: true });

    const payload = lastJson();
    expect(payload).toMatchObject({ ok: true, action: 'set', key: 'model.vision.api_key' });
    expect(payload.vision.apiKey).not.toContain(RAW_KEY);
    expect(payload.vision.keyCount).toBe(1);
    expect(JSON.stringify(payload)).not.toContain(RAW_KEY);
    // The whole point of this branch: nothing was written to .env.
    expect(payload.envPath).toBeNull();
    expect(printSuccess).not.toHaveBeenCalled();
    expect(printError).not.toHaveBeenCalled();
  });

  test('config get --json 的掩码同样不含裸 key', async () => {
    await handleConfig('set', ['model.vision.base_url', FAKE_URL]);
    await handleConfig('set', ['model.vision.model', 'step-2-16k']);
    await handleConfig('set', ['model.vision.api_key', RAW_KEY]);
    jest.clearAllMocks();
    await handleConfig('get', ['model.vision.api_key'], { json: true });
    expect(lastJson().value).not.toContain(RAW_KEY);
  });

  test('别名 vision_base_url / vision_model 归一到规范键', async () => {
    await handleConfig('set', ['vision_base_url', FAKE_URL]);
    await handleConfig('set', ['vision_model', 'step-2-16k']);
    expect(readVisionFile()).toMatchObject({ baseUrl: FAKE_URL, model: 'step-2-16k' });
  });

  test('model.vision.api_key 不带值 = 清钥匙，不动端点其余配置', async () => {
    await handleConfig('set', ['model.vision.base_url', FAKE_URL]);
    await handleConfig('set', ['model.vision.model', 'step-2-16k']);
    await handleConfig('set', ['model.vision.api_key', RAW_KEY]);

    await handleConfig('set', ['model.vision.api_key'], { json: true });
    expect(lastJson().vision.keyCount).toBe(0);
    expect(readVisionFile()).toMatchObject({ baseUrl: FAKE_URL, model: 'step-2-16k' });
  });

  test('坏 URL 走 vision_config_write_failed，且不落任何文件', async () => {
    await handleConfig('set', ['model.vision.base_url', 'ftp://nope'], { json: true });
    expect(lastJson()).toMatchObject({ ok: false, error: 'vision_config_write_failed' });
    expect(visionFileExists()).toBe(false);
  });

  test('未知的 model.vision.* 键走 unsupported_key，不碰管理漏斗', async () => {
    await handleConfig('set', ['model.vision.nope', 'x'], { json: true });
    expect(lastJson()).toMatchObject({ ok: false, error: 'unsupported_key' });
    expect(printError).not.toHaveBeenCalled();
    expect(visionFileExists()).toBe(false);
  });

  test('缺少 model.vision.base_url 的值 → missing_value，不写盘', async () => {
    await handleConfig('set', ['model.vision.base_url', '   '], { json: true });
    expect(lastJson()).toMatchObject({ ok: false, error: 'missing_value' });
    expect(visionFileExists()).toBe(false);
  });

  test('show 把三个键和其余 model.* 键列在同一张表里', async () => {
    await handleConfig('set', ['model.vision.base_url', FAKE_URL]);
    await handleConfig('set', ['model.vision.model', 'step-2-16k']);
    jest.clearAllMocks();
    await handleConfig('show', [], { json: true });
    expect(lastJson().values).toMatchObject({
      'model.vision.base_url': FAKE_URL,
      'model.vision.model': 'step-2-16k',
      'model.vision.api_key': '(not set)',
    });
  });

  test('config get 不带键时，帮助串从白名单派生（含三个 vision 键）', async () => {
    await handleConfig('get', [], {});
    expect(printInfo).toHaveBeenCalledWith(expect.stringContaining('model.vision.base_url'));
    expect(printInfo).toHaveBeenCalledWith(expect.stringContaining('model.vision.model'));
    expect(printInfo).toHaveBeenCalledWith(expect.stringContaining('model.vision.api_key'));
  });
});
