'use strict';

/**
 * SSRF 严格档 / 宽松档(2026-09-27)。
 *
 * 前提经实测核实(不是推断):本仓安装的 `ipaddr.js@1.9.1` 把代理占位池
 * `198.18.0.0/15` 判为 **`unicast`**,`isPrivateOrLocalHostname('198.18.0.42')`
 * 返回 false —— 所以**今天 fake-IP 用户并没有被拒绝**,`KHY_FAKE_IP_CIDRS` 对该段
 * 目前其实是惰性的。ipaddr.js 2.x 才加入 `benchmarking` 条目,届时升级会让所有
 * Clash fake-IP 用户突然全盘被拒。
 *
 * 于是两档的价值都不是「放宽今天的拒绝」,而是:
 *   - lenient(默认):把占位池当代理占位(等价今天行为),并在 ipaddr 升级后继续可用;
 *   - strict:把占位池**直接拒绝** —— 补上 ipaddr 1.9.1 把它当公网放行的口子,
 *     给企业/多租户一个零宽限姿态。
 * 显式 KHY_FAKE_IP_CIDRS 在两档下都优先(运维点名即有意决定)。
 */

const {
  assertPublicHttpUrlResolved,
  classifyResolvedAddress,
  ssrfStrictnessMode,
  PROXY_FAKE_IP_POOL,
  __setDnsLookupForTests,
} = require('../../src/services/urlSafety');

// 全部开关显式设定,绝不依赖机器环境(否则「本机恰好设了 HTTPS_PROXY」会让断言漂移)。
// 注:proxyConfigService 的模块态 _activeProxy 在新进程里为 null,本套件从不 enable/detect,
// 故代理态不影响本套件判定 —— 判定本身也刻意不依赖代理探测(TUN 用户没有 *_PROXY 变量)。
const TOUCHED = ['KHY_FAKE_IP_CIDRS', 'KHY_SSRF_MODE'];
const saved = {};

beforeAll(() => {
  for (const k of TOUCHED) saved[k] = process.env[k];
});
afterAll(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function clearEnv() {
  for (const k of TOUCHED) delete process.env[k];
}

beforeEach(clearEnv);
afterEach(() => {
  __setDnsLookupForTests();
  clearEnv();
});

describe('ssrfStrictnessMode', () => {
  test('默认 lenient;仅显式 strict 才收窄', () => {
    expect(ssrfStrictnessMode({})).toBe('lenient');
    expect(ssrfStrictnessMode({ KHY_SSRF_MODE: '' })).toBe('lenient');
    expect(ssrfStrictnessMode({ KHY_SSRF_MODE: 'STRICT' })).toBe('strict');
    expect(ssrfStrictnessMode({ KHY_SSRF_MODE: 'strict' })).toBe('strict');
    // 打错的值不得偶然开启严格档(它会拒掉整个占位池,必须是显式决定)
    expect(ssrfStrictnessMode({ KHY_SSRF_MODE: 'true' })).toBe('lenient');
    expect(ssrfStrictnessMode({ KHY_SSRF_MODE: '1' })).toBe('lenient');
  });
});

describe('classifyResolvedAddress', () => {
  test('前提核实:ipaddr.js 1.9.1 把占位池判为 unicast,故 lenient 下它就是「可接受的占位」', () => {
    expect(PROXY_FAKE_IP_POOL).toContain('198.18.0.0/15');
    expect(classifyResolvedAddress('198.18.0.42', {})).toBe('allowed-placeholder');
    expect(classifyResolvedAddress('198.19.255.254', {})).toBe('allowed-placeholder');
  });

  test('strict 下占位池被判 reject(补上 ipaddr 1.9.1 放行的口子)', () => {
    const env = { KHY_SSRF_MODE: 'strict' };
    expect(classifyResolvedAddress('198.18.0.42', env)).toBe('reject');
    expect(classifyResolvedAddress('198.19.255.254', env)).toBe('reject');
  });

  test('显式 KHY_FAKE_IP_CIDRS 在两档下都优先(自定义 fake-IP 池)', () => {
    const env = { KHY_FAKE_IP_CIDRS: '10.99.0.0/16' };
    expect(classifyResolvedAddress('10.99.1.7', env)).toBe('allowed-placeholder');
    expect(classifyResolvedAddress('10.99.1.7', { ...env, KHY_SSRF_MODE: 'strict' })).toBe(
      'allowed-placeholder'
    );
  });

  test('显式白名单可覆盖占位池的 strict 拒绝(运维点名即有意决定)', () => {
    expect(
      classifyResolvedAddress('198.18.0.42', {
        KHY_FAKE_IP_CIDRS: '198.18.0.0/15',
        KHY_SSRF_MODE: 'strict',
      })
    ).toBe('allowed-placeholder');
  });

  test('真正的内网段在任何档位都 reject', () => {
    for (const env of [{}, { KHY_SSRF_MODE: 'strict' }]) {
      for (const ip of [
        '127.0.0.1',
        '10.0.0.5',
        '192.168.1.1',
        '172.16.0.1',
        '169.254.169.254',
        '::1',
      ]) {
        expect(classifyResolvedAddress(ip, env)).toBe('reject');
      }
    }
  });

  test('普通公网地址两档都 public', () => {
    for (const env of [{}, { KHY_SSRF_MODE: 'strict' }]) {
      for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) {
        expect(classifyResolvedAddress(ip, env)).toBe('public');
      }
    }
  });

  test('IPv4-mapped IPv6 回环仍 reject(不被档位绕过)', () => {
    expect(classifyResolvedAddress('::ffff:127.0.0.1', {})).toBe('reject');
  });
});

describe('assertPublicHttpUrlResolved × 档位', () => {
  test('Clash fake-IP 用户(默认档)→ 抓取照常可用', async () => {
    __setDnsLookupForTests(async () => [{ address: '198.18.0.42', family: 4 }]);
    await expect(assertPublicHttpUrlResolved('https://example.com/')).resolves.toBeUndefined();
  });

  test('企业 strict 档 → 同一地址被拒(零宽限姿态)', async () => {
    process.env.KHY_SSRF_MODE = 'strict';
    __setDnsLookupForTests(async () => [{ address: '198.18.0.42', family: 4 }]);
    await expect(assertPublicHttpUrlResolved('https://example.com/')).rejects.toThrow(
      /private or local/
    );
  });

  test('strict 档下正常公网地址不受影响(收窄不误伤)', async () => {
    process.env.KHY_SSRF_MODE = 'strict';
    __setDnsLookupForTests(async () => [{ address: '93.184.216.34' }]);
    await expect(assertPublicHttpUrlResolved('https://example.com/')).resolves.toBeUndefined();
  });

  test('内网解析在默认档下依然拒绝(档位不越界)', async () => {
    __setDnsLookupForTests(async () => [{ address: '169.254.169.254' }]);
    await expect(assertPublicHttpUrlResolved('https://metadata.example/')).rejects.toThrow(
      /private or local/
    );
  });

  test('混合应答:任一条被拒即拒(公网 + 内网)', async () => {
    __setDnsLookupForTests(async () => [{ address: '8.8.8.8' }, { address: '192.168.0.10' }]);
    await expect(assertPublicHttpUrlResolved('https://mixed.example/')).rejects.toThrow(
      /private or local/
    );
  });

  test('占位池的 IP 字面量:默认档照常放行(与解析路径同姿态)', async () => {
    await expect(assertPublicHttpUrlResolved('http://198.18.0.42/')).resolves.toBeUndefined();
  });

  test('占位池的 IP 字面量:strict 档拒绝(口径与解析路径一致)', async () => {
    process.env.KHY_SSRF_MODE = 'strict';
    await expect(assertPublicHttpUrlResolved('http://198.18.0.42/')).rejects.toThrow(
      /placeholder pool/
    );
  });

  test('拒绝消息给出两条自助出路(白名单 / strict)', async () => {
    __setDnsLookupForTests(async () => [{ address: '192.168.0.10' }]);
    await expect(assertPublicHttpUrlResolved('https://example.com/')).rejects.toThrow(
      /KHY_FAKE_IP_CIDRS[\s\S]*KHY_SSRF_MODE=strict/
    );
  });
});
