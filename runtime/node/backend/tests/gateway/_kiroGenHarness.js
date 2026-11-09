'use strict';

/**
 * _kiroGenHarness.js — shared offline loader for kiroAdapter channel tests.
 *
 * Every load gives a fresh adapter instance whose environment seams are pinned:
 *   - os.homedir()      → a throwaway temp dir (token/profile scans stay inside it)
 *   - ipAnonymizer      → identity header sanitizer (no outbound shape changes)
 *   - proxyConfigService→ no live proxy event listener
 *   - _proxyTunnel      → requestJson replayed from canned responses (ZERO real network)
 *   - accountPool       → no pool tokens, no disk pool (hermetic getAccessToken)
 *
 * The module reads KIRO_* env at LOAD time, so per-test env overrides must be
 * passed to loadKiroAdapter() — they are applied BEFORE the require.
 *
 * Usage:
 *   const h = loadKiroAdapter({ env: { KIRO_PROXY_URL: 'https://kiro-proxy.example' } });
 *   try { ... } finally { h.adapter.destroy(); h.cleanup(); }
 */

const fs = require('fs');
const path = require('path');

// Env keys the adapter reads at load or call time — scrubbed so tests are
// deterministic, restored verbatim on cleanup().
const KIRO_ENV_KEYS = [
  'KIRO_PROXY_URL',
  'KIRO_DEBUG',
  'KIRO_AUTO_OPEN_LOGIN',
  'KIRO_AUTO_PROXY',
  'KIRO_TOKEN_PATH',
  'KIRO_INJECT_CLAUDE_MODELS',
  'KIRO_MODEL_CACHE_MS',
  'KIRO_WARM_CHECK_INTERVAL_MS',
  'KIRO_VERSION',
  'KIRO_LOGIN_URL',
  'KIRO_LOGIN_COOLDOWN_MS',
  'KIRO_ACTIVE_WINDOW_MS',
  'KIRO_DISCOVERY_REQUIRE_PROXY',
  'KIRO_PROXY_RETRY_MS',
  'KIRO_PROXY_ROUTE_MODE',
  'KIRO_HTTP_PROXY',
  'kiro_http_proxy',
  'GATEWAY_PREFERRED_ADAPTER',
  'KHY_KIRO_ABORT',
  // Windows SSO/IDE roots — pinned to fake values so no real user tree is read
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
];

function loadKiroAdapter(opts = {}) {
  jest.resetModules();

  const { env = {}, defaultRequest = null } = opts;
  // opts.cwWorking: array of CW events | true（用默认事件组）

  const realOs = jest.requireActual('os');
  const tempHome = fs.mkdtempSync(path.join(realOs.tmpdir(), 'khy-kiro-gen-'));

  jest.doMock('os', () => ({
    ...realOs,
    homedir: () => tempHome,
  }));

  jest.doMock('../../src/services/gateway/adapters/ipAnonymizer', () => ({
    sanitizeOutgoingHeaders: (h) => h,
  }));

  jest.doMock('../../src/services/proxyConfigService', () => ({
    proxyEvents: { on: jest.fn() },
    getActiveProxy: () => null,
  }));

  const requestJson = jest.fn(async () => {
    if (defaultRequest) {
      return defaultRequest;
    }
    return { status: 200, data: {} };
  });
  jest.doMock('../../src/services/gateway/adapters/_proxyTunnel', () => ({
    requestJson,
    collectProxyCandidates: jest.fn(() => []),
  }));

  jest.doMock('../../src/services/accountPool', () => ({
    init: jest.fn(async () => {}),
    getActiveToken: jest.fn(async () => null),
    saveObservedToken: jest.fn(async () => null),
    autoImportObservedCredentials: jest.fn(async () => {}),
    banActiveAccount: jest.fn(async () => null),
    cooldownAccount: jest.fn(async () => null),
    setActiveAccount: jest.fn(async () => {}),
  }));

  // Scrub real env, then apply the deterministic per-test overrides.
  const saved = {};
  for (const key of KIRO_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }


  // `cwWorking`：注入**能用的**假 CW SDK（_fakeCwSdk.js）。此前该路径只有「SDK 坏掉」
  // 一支被测过，`new CodeWhispererStreaming(...)` / `middlewareStack.add(...)` /
  // `client.send(...)` 这段真热路径从未覆盖——而它正是 [MGMT-RPT-035] L5 想抽的共享面。
  let cwRecord = null;
  if (opts.cwWorking) {
    const { makeFakeCwModule } = require('./_fakeCwSdk');
    const fake = makeFakeCwModule(Array.isArray(opts.cwWorking) ? opts.cwWorking : null);
    cwRecord = fake.__record;
    jest.doMock('../../src/services/gateway/adapters/_cwStreamParser', () => {
      const real = jest.requireActual('../../src/services/gateway/adapters/_cwStreamParser');
      return { ...real, getCWModule: jest.fn(async () => fake) };
    });
  }

  // `kiroToken`：往临时 home 的 .aws/sso/cache 写一份可用的 kiro-auth-token.json，
  // 否则 generate 在取 token 那一步就返回 auth 错，CW 客户端根本不会被构造。
  // 形状抄自 tests/kiroAdapter.refreshFallback.test.js 的既有 fixture。
  // 默认**不写**（opt-in）：harness 的既有默认行为是「无 token」，改成默认写会让
  // 将来想测「未登录」路径的用例被 surprise。要 CW 路径可达就显式传 kiroToken: true。
  if (opts.kiroToken === true) {
    const cacheDir = path.join(tempHome, ".aws", "sso", "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const clientIdHash = "e909a0580879b06ece1202964fbe9dda95ea4ce3";
    fs.writeFileSync(
      path.join(cacheDir, "kiro-auth-token.json"),
      JSON.stringify({
        accessToken: "a".repeat(232),
        refreshToken: "r".repeat(64),
        authMethod: "IdC",
        provider: "Internal",
        region: "us-east-1",
        profileArn: 'arn:aws:codewhisperer:us-east-1:699475941385:profile/ABCDEFGH',
        clientIdHash,
        expiresAt: new Date(Date.now() + 4 * 60 * 1000).toISOString(),
      }, null, 2),
      "utf8"
    );
  }
  const adapter = require('../../src/services/gateway/adapters/kiroAdapter');

  return {
    adapter,
    requestJson,
    cwRecord,
    tempHome,
    cleanup() {
      adapter.destroy();
      for (const key of KIRO_ENV_KEYS) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }
      try {
        fs.rmSync(tempHome, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

module.exports = { loadKiroAdapter, KIRO_ENV_KEYS };
