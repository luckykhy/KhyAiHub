'use strict';

/**
 * scan.js 契约测试 —— 「应用中心」本机只读探测的纯函数与 fail-soft 边界。
 *
 * 钉住四件事：
 *   1. badgeFor 五档裁决与信号组合一一对应（未安装 / 未接入 / 未配置 / 配置未完成 / 已配置）。
 *   2. sameGatewayOrigin 只认 protocol+host+port 全等，非法输入一律 false（绝不抛）。
 *   3. resolveProbeTarget 对 adapter allowlist 与三种 probe.kind 的解析；未登记/未知一律
 *      交回 path=null + reason，而不是抛。
 *   4. scanApp/scanAll 的 fail-soft 与「令牌绝不进返回值」：单卡探测失败收敛为
 *      badge='探测失败' 且整次扫描仍返回全部卡片；网关令牌只用于布尔判断。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  scanAll,
  scanApp,
  badgeFor,
  sameGatewayOrigin,
  resolveProbeTarget,
} = require('./scan');

// 测试可注入替身（形状同 scan.js 的 _defaultContext）。
function ctx(overrides = {}) {
  return {
    env: {},
    homedir: path.join(path.sep, 'home', 'tester'),
    platform: process.platform,
    existsSync: () => false,
    detectFn: () => ({ success: false, reason: 'no-detector' }),
    gatewayAccessFn: () => ({ ok: false, error: 'absent' }),
    adapterLoaders: {},
    ...overrides,
  };
}

// 一条带 home 探针的登记条目：探测落点 = ctx.homedir + segs，测试里用 existsSync 控制「装了没」。
function entry(overrides = {}) {
  return {
    appId: 'claude-code',
    category: 'cli',
    name: 'Claude Code',
    probe: { kind: 'home', segs: ['.app'] },
    ...overrides,
  };
}

// ── 1. badgeFor 五档 ────────────────────────────────────────────────────

test('badgeFor：五档与信号组合一一对应', () => {
  const base = { installed: true, hasDetector: true, configured: true, configuredVerified: true, gatewayAvailable: true };
  assert.equal(badgeFor({ ...base, installed: false }), '未安装');
  assert.equal(badgeFor({ ...base, hasDetector: false }), '未接入');
  assert.equal(badgeFor({ ...base, configured: false, configuredVerified: false }), '未配置');
  assert.equal(badgeFor({ ...base, configuredVerified: false }), '配置未完成');
  assert.equal(badgeFor(base), '已配置');
});

// ── 2. sameGatewayOrigin ────────────────────────────────────────────────

test('sameGatewayOrigin：只认同源（protocol+host+port），非法输入 false', () => {
  assert.equal(sameGatewayOrigin('http://127.0.0.1:9100/v1', 'http://127.0.0.1:9100'), true);
  assert.equal(sameGatewayOrigin('  http://127.0.0.1:9100  ', 'http://127.0.0.1:9100'), true);
  assert.equal(sameGatewayOrigin('http://127.0.0.1:9100', 'http://127.0.0.1:9101'), false, '端口不同不同源');
  assert.equal(sameGatewayOrigin('http://127.0.0.1:9100', 'https://127.0.0.1:9100'), false, '协议不同不同源');
  for (const bad of [null, undefined, '', 'not-a-url', 42]) {
    assert.equal(sameGatewayOrigin(bad, 'http://127.0.0.1:9100'), false, `left=${String(bad)}`);
    assert.equal(sameGatewayOrigin('http://127.0.0.1:9100', bad), false, `right=${String(bad)}`);
  }
});

// ── 3. resolveProbeTarget ───────────────────────────────────────────────

test('resolveProbeTarget：adapter 走 allowlist 的 configPath()', () => {
  const loaders = { myAdapter: () => ({ configPath: () => '/etc/myapp/config.json' }) };
  const hit = resolveProbeTarget({ adapter: 'myAdapter' }, ctx({ adapterLoaders: loaders }));
  assert.deepEqual(hit, { path: '/etc/myapp/config.json' });
});

test('resolveProbeTarget：adapter 未登记 / 未导出 configPath → path=null + reason', () => {
  const miss = resolveProbeTarget({ adapter: 'nope' }, ctx({ adapterLoaders: {} }));
  assert.equal(miss.path, null);
  assert.match(miss.reason, /未在 ADAPTER_LOADERS 登记/);

  const noFn = resolveProbeTarget({ adapter: 'bare' }, ctx({ adapterLoaders: { bare: () => ({}) } }));
  assert.equal(noFn.path, null);
  assert.match(noFn.reason, /未导出 configPath/);
});

test('resolveProbeTarget：probe.kind=home 拼 homedir', () => {
  const home = path.join(path.sep, 'home', 'tester');
  const hit = resolveProbeTarget({ probe: { kind: 'home', segs: ['.myapp', 'config.json'] } }, ctx({ homedir: home }));
  assert.equal(hit.path, path.join(home, '.myapp', 'config.json'));
});

test('resolveProbeTarget：probe.kind=userAppConfig 拼 userAppConfigDir', () => {
  // win32 + APPDATA 是确定分支：base = APPDATA；两端都用宿主 path.join，故断言与平台无关。
  const base = path.join(path.sep, 'AppData', 'Roaming');
  const hit = resolveProbeTarget(
    { probe: { kind: 'userAppConfig', segs: ['MyApp', 'settings.json'] } },
    ctx({ platform: 'win32', env: { APPDATA: base } })
  );
  assert.equal(hit.path, path.join(base, 'MyApp', 'settings.json'));
});

test('resolveProbeTarget：未知 probe.kind → path=null + reason', () => {
  const hit = resolveProbeTarget({ probe: { kind: 'mars' } }, ctx());
  assert.equal(hit.path, null);
  assert.match(hit.reason, /未知 probe.kind/);
});

// ── 4. scanApp fail-soft 与信号 ─────────────────────────────────────────

test('scanApp：未安装 → badge 未安装', () => {
  const r = scanApp(entry(), ctx({ existsSync: () => false }));
  assert.equal(r.installed, false);
  assert.equal(r.configured, false);
  assert.equal(r.badge, '未安装');
});

test('scanApp：装了但 appId 不在 ccSwitch APPS → 未接入', () => {
  const r = scanApp(
    entry({ appId: 'no-such-app', category: 'desktop', name: 'X' }),
    ctx({ existsSync: () => true })
  );
  assert.equal(r.installed, true);
  assert.equal(r.badge, '未接入');
  assert.match(r.detail.note, /暂无反向读配置器/);
});

test('scanApp：装了 + 有探测器 + 无 provider → 未配置', () => {
  const r = scanApp(
    entry(),
    ctx({
      existsSync: () => true,
      detectFn: () => ({ success: true, providers: [] }),
      _gateway: { available: true, endpoint: 'http://127.0.0.1:9100' },
    })
  );
  assert.equal(r.configured, false);
  assert.equal(r.badge, '未配置');
});

test('scanApp：配置了且指向本网关 → 已配置（verified）', () => {
  const r = scanApp(
    entry(),
    ctx({
      existsSync: () => true,
      detectFn: () => ({ success: true, providers: [{ endpoint: 'http://127.0.0.1:9100/v1' }] }),
      _gateway: { available: true, endpoint: 'http://127.0.0.1:9100' },
    })
  );
  assert.equal(r.configured, true);
  assert.equal(r.configuredVerified, true);
  assert.equal(r.manualConfig, false);
  assert.equal(r.badge, '已配置');
});

test('scanApp：配置了但未指向本网关 → 配置未完成 + manualConfig 说明', () => {
  const r = scanApp(
    entry(),
    ctx({
      existsSync: () => true,
      detectFn: () => ({ success: true, providers: [{ endpoint: 'https://api.other.example/v1' }] }),
      _gateway: { available: true, endpoint: 'http://127.0.0.1:9100' },
    })
  );
  assert.equal(r.configured, true);
  assert.equal(r.manualConfig, true);
  assert.equal(r.badge, '配置未完成');
  assert.match(r.detail.note, /未指向本网关/);
});

test('scanApp：反向读配置失败 → 收敛为未配置且带 detectReason', () => {
  const r = scanApp(
    entry(),
    ctx({ existsSync: () => true, detectFn: () => ({ success: false, reason: 'EACCES' }) })
  );
  assert.equal(r.configured, false);
  assert.equal(r.badge, '未配置');
  assert.match(r.detail.detectReason, /EACCES/);
});

test('scanApp：探测抛错 → badge 探测失败（fail-soft，绝不外抛）', () => {
  const r = scanApp(entry(), ctx({ existsSync: () => { throw new Error('EIO'); } }));
  assert.equal(r.badge, '探测失败');
  assert.equal(r.detail.error, 'EIO');
  assert.equal(r.appId, 'claude-code');
});

// ── 5. scanAll ──────────────────────────────────────────────────────────

test('scanAll：网关不可解析 → available=false，令牌绝不进返回值', () => {
  const out = scanAll(
    [entry()],
    ctx({
      existsSync: () => false,
      gatewayAccessFn: () => ({ ok: false, error: '网关不可解析', token: 'SECRET' }),
    })
  );
  assert.equal(out.gateway.available, false);
  assert.equal(out.gateway.endpoint, '');
  assert.equal(out.count, 1);
  assert.equal(out.apps.length, 1);
  assert.equal(out.apps[0].badge, '未安装');
  assert.equal(JSON.stringify(out).includes('SECRET'), false, '令牌不得出现在任何返回值里');
});

test('scanAll：网关可解析 → 回显 endpoint，令牌仍不回显', () => {
  const out = scanAll(
    [entry()],
    ctx({
      existsSync: () => false,
      gatewayAccessFn: () => ({
        ok: true,
        proxyEndpoint: 'http://127.0.0.1:9100',
        token: 'SECRET',
        source: { endpoint: 'runtime', token: 'runtime' },
      }),
    })
  );
  assert.equal(out.gateway.available, true);
  assert.equal(out.gateway.endpoint, 'http://127.0.0.1:9100');
  assert.equal(JSON.stringify(out).includes('SECRET'), false);
});

test('scanAll：空登记表 → count=0 且不抛', () => {
  const out = scanAll([], ctx());
  assert.equal(out.count, 0);
  assert.deepEqual(out.apps, []);
});
