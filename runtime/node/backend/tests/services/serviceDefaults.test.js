'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function composeLocalUrl(port) {
  return `http://localhost:${port}`;
}

describe('serviceDefaults AI backend discovery', () => {
  const ORIGINAL_ENV = { ...process.env };
  let tempHome = null;
  let homedirSpy = null;

  beforeEach(() => {
    jest.resetModules();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-service-defaults-'));
    homedirSpy = jest.spyOn(os, 'homedir').mockReturnValue(tempHome);
    process.env = {
      ...ORIGINAL_ENV,
      KHY_DATA_HOME: path.join(tempHome, '.khy'),
    };
    delete process.env.AI_BACKEND_URL;
    delete process.env.KHY_DAEMON_PORT;
    delete process.env.AI_MGMT_PORT;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    if (homedirSpy) {
      homedirSpy.mockRestore();
      homedirSpy = null;
    }
    if (tempHome && fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    tempHome = null;
  });

  test('discovers AI backend URL from primary runtime file', () => {
    const dataHome = process.env.KHY_DATA_HOME;
    fs.mkdirSync(dataHome, { recursive: true });
    fs.writeFileSync(path.join(dataHome, 'ai_manage_runtime.json'), JSON.stringify({
      apiPort: 19090,
    }, null, 2), 'utf-8');

    const serviceDefaults = require('../../src/constants/serviceDefaults');

    expect(serviceDefaults.getAiBackendUrl()).toBe(composeLocalUrl(19090));
    expect(serviceDefaults.AI_BACKEND_URL).toBe(composeLocalUrl(19090));
  });

  test('falls back to legacy runtime file when primary runtime is missing', () => {
    const legacyDataHome = path.join(tempHome, '.khyquant');
    fs.mkdirSync(legacyDataHome, { recursive: true });
    fs.writeFileSync(path.join(legacyDataHome, 'ai_manage_runtime.json'), JSON.stringify({
      apiPort: 29090,
    }, null, 2), 'utf-8');

    const serviceDefaults = require('../../src/constants/serviceDefaults');

    expect(serviceDefaults.getAiBackendUrl()).toBe(composeLocalUrl(29090));
    expect(serviceDefaults.AI_BACKEND_URL).toBe(composeLocalUrl(29090));
  });

  test('AI_BACKEND_URL getter reflects runtime discovered after module load', () => {
    const serviceDefaults = require('../../src/constants/serviceDefaults');
    const dataHome = process.env.KHY_DATA_HOME;

    expect(serviceDefaults.AI_BACKEND_URL).toBe(composeLocalUrl(9090));

    fs.mkdirSync(dataHome, { recursive: true });
    fs.writeFileSync(path.join(dataHome, 'ai_manage_runtime.json'), JSON.stringify({
      apiPort: 19091,
    }, null, 2), 'utf-8');

    expect(serviceDefaults.AI_BACKEND_URL).toBe(composeLocalUrl(19091));
    expect(serviceDefaults.getAiBackendUrl()).toBe(composeLocalUrl(19091));
  });

  test('prefers explicit AI_BACKEND_URL over runtime discovery', () => {
    const dataHome = process.env.KHY_DATA_HOME;
    fs.mkdirSync(dataHome, { recursive: true });
    fs.writeFileSync(path.join(dataHome, 'ai_manage_runtime.json'), JSON.stringify({
      apiPort: 19090,
    }, null, 2), 'utf-8');

    const serviceDefaults = require('../../src/constants/serviceDefaults');

    expect(serviceDefaults.getAiBackendUrl({
      ...process.env,
      AI_BACKEND_URL: 'https://api.example.com',
    })).toBe('https://api.example.com');
  });

  test('falls back to daemon port env when runtime files are absent', () => {
    const serviceDefaults = require('../../src/constants/serviceDefaults');

    expect(serviceDefaults.getAiBackendUrl({
      ...process.env,
      KHY_DAEMON_PORT: '39090',
    })).toBe(composeLocalUrl(39090));
  });
});

describe('serviceDefaults cloud endpoint single source of truth', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.resetModules();
  });

  test('exposes the production cloud endpoint and derived defaults', () => {
    delete process.env.KHY_CLOUD_ENDPOINT;
    delete process.env.KHY_TELEMETRY_ENDPOINT;
    jest.resetModules();
    const sd = require('../../src/constants/serviceDefaults');
    expect(sd.CLOUD_DEFAULT_ENDPOINT).toBe('https://api.khyquant.top');
    expect(sd.CLOUD_FALLBACK_ENDPOINTS).toContain('https://api.khyquant.top');
    expect(sd.TELEMETRY_DEFAULT_ENDPOINT).toBe('https://api.khyquant.top/telemetry');
    expect(sd.CLOUD_DEFAULT_HOST).toBe('khyquant.top');
  });

  test('KHY_CLOUD_ENDPOINT overrides the endpoint and its derivations', () => {
    process.env.KHY_CLOUD_ENDPOINT = 'https://api.self-hosted.example';
    delete process.env.KHY_TELEMETRY_ENDPOINT;
    jest.resetModules();
    const sd = require('../../src/constants/serviceDefaults');
    expect(sd.CLOUD_DEFAULT_ENDPOINT).toBe('https://api.self-hosted.example');
    expect(sd.CLOUD_FALLBACK_ENDPOINTS[0]).toBe('https://api.self-hosted.example');
    expect(sd.TELEMETRY_DEFAULT_ENDPOINT).toBe('https://api.self-hosted.example/telemetry');
    expect(sd.CLOUD_DEFAULT_HOST).toBe('self-hosted.example');
  });

  test('AI backend default port is the single source mirrored by the frontend', () => {
    delete process.env.KHY_DAEMON_PORT;
    jest.resetModules();
    const sd = require('../../src/constants/serviceDefaults');
    expect(sd.AI_BACKEND_DEFAULT_PORT).toBe(9090);
    expect(sd.AI_BACKEND_DEFAULT_URL).toBe('http://localhost:9090');
  });
});

/**
 * 入站发送者准入默认值 —— **本组是整个默认档的最后一道真实读数**。
 *
 * 为什么单独立一组、且刻意不共用上面两组：微信那条线的两个套件
 * （tests/services/channels/ilinkAllowlist.test.js 的 defaultsStub、
 * tests/cli/handlers/wxMultiAccount.test.js 的 DEFAULTS_STUB）都把整个
 * serviceDefaults 模块换成了桩，两边还各自显式写死了 `ILINK_ALLOW_UNLISTED: false`。
 * 于是把源码里的 fallback 从 false 翻回 true 时，这两个套件里的用例**全绿** ——
 * 桩把源码的默认值整个遮住了，55 条断言没有一条读过真实的第 346 行。
 *
 * 本组在桩之外另起一路：直接 require 真的 serviceDefaults 与真的
 * ilinkPeerAllowlist，不装任何 require.cache 桩。这是**读源码**，不是读桩。
 *
 * 两条断言各自能抓到什么（别把它们的分工说反）：
 *   - 常量断言（ILINK_ALLOW_UNLISTED === false）既能抓 fallback 被翻成 true，
 *     也能抓字段被整条删掉 / 改名（toBe(false) 对 undefined 是红的）；
 *   - allowMode().strict 同样能抓 fallback 被翻成 true —— ilinkPeerAllowlist.js:265
 *     读的是 `defaults.ILINK_ALLOW_UNLISTED !== true`，常量翻成 true 就落成
 *     `{ strict:false }`。但它**抓不到**「字段缺失」：undefined !== true 也落严格档。
 *   两条都留：一条钉源码字面，一条钉下游消费者真正读到的档位语义。
 *
 * resetModules 是纪律不是形式：模块级 require 会把上一条用例装过的版本留在缓存里，
 * 不 reset 就等于在测「上一条用例的环境」，而不是这条用例描述的「未设环境变量」。
 */
describe('serviceDefaults inbound allowlist default (real module, no stub)', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.KHY_ILINK_ALLOW_UNLISTED;
    jest.resetModules();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.resetModules();
  });

  test('ILINK_ALLOW_UNLISTED falls back to false when the env var is unset', () => {
    const sd = require('../../src/constants/serviceDefaults');

    // Constant itself, not just its downstream effect: `undefined` must also fail
    // here, so deleting or renaming the constant cannot pass silently.
    expect(sd.ILINK_ALLOW_UNLISTED).toBe(false);
  });

  test('allowMode() reports strict for the real allowlist module without the env var', () => {
    const allowlist = require('../../src/services/domain/messaging/messaging/ilinkPeerAllowlist.js');

    expect(allowlist.allowMode().strict).toBe(true);
  });

  test('explicit opt-in is the only way out of strict', () => {
    process.env.KHY_ILINK_ALLOW_UNLISTED = '1';
    jest.resetModules();

    const allowlist = require('../../src/services/domain/messaging/messaging/ilinkPeerAllowlist.js');

    // Pins the polarity: the guard above is not satisfied by "constant is falsy
    // somehow", it is satisfied by an explicit human opt-in.
    expect(allowlist.allowMode().strict).toBe(false);
  });
});
