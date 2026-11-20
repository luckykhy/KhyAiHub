// Uses Jest's global describe/it/expect (previously imported from node:test,
// which Jest does not collect).
const {
  apiLimiter,
  getClientIp,
  shouldSkipRateLimit,
  _limitKey,
} = require('../src/middleware/rateLimit');

describe('apiLimiter', () => {
  it('should be a function', () => {
    expect(typeof apiLimiter).toBe('function');
  });
});

// ── 限流键不可伪造（SEC-02）─────────────────────────────────────────────────
//
// 此前 getClientIp 直接取 X-Forwarded-For 的第一段：客户端自填 XFF=127.0.0.1
// 即让 shouldSkipRateLimit 判为回环 → 整条跳过限流；XFF 轮换则每个请求换一个
// 限流键。登录防爆破（30 次/15 分钟）与 api/ai 限流因此全部可绕。
// 现在限流键只认 TCP 对端地址，请求头仅在「对端是受信反代」时才采信。
describe('限流键：X-Forwarded-For 不可伪造', () => {
  const mkReq = (remoteAddress, xff) => {
    const headers = {};
    if (xff) headers['x-forwarded-for'] = xff;
    return { socket: { remoteAddress }, headers, originalUrl: '/api/auth/login', method: 'POST' };
  };

  afterEach(() => {
    delete process.env.KHY_TRUSTED_PROXIES;
  });

  it('远程对端伪造 XFF=127.0.0.1:不再跳过限流', () => {
    const req = mkReq('192.168.1.50', '127.0.0.1');
    expect(shouldSkipRateLimit(req)).toBe(false);
    expect(getClientIp(req)).toBe('192.168.1.50');
  });

  it('远程对端轮换 XFF:限流键恒为真实对端地址', () => {
    const a = mkReq('192.168.1.50', '1.1.1.1');
    const b = mkReq('192.168.1.50', '203.0.113.7');
    expect(getClientIp(a)).toBe('192.168.1.50');
    expect(getClientIp(b)).toBe('192.168.1.50');
  });

  it('远程对端不带 XFF:键仍是对端地址', () => {
    expect(getClientIp(mkReq('192.168.1.50'))).toBe('192.168.1.50');
  });

  it('本机直连(无 XFF):仍跳过限流,本地开发路径不受影响', () => {
    const req = mkReq('127.0.0.1');
    expect(shouldSkipRateLimit(req)).toBe(true);
  });

  it('配置 KHY_TRUSTED_PROXIES 后,受信反代取 XFF 最后一段(反代是追加方)', () => {
    process.env.KHY_TRUSTED_PROXIES = '127.0.0.1';
    // nginx 的 proxy_add_x_forwarded_for 是追加:最左段是客户端自填,最后一段才是真实对端
    expect(getClientIp(mkReq('127.0.0.1', '6.6.6.6, 203.0.113.9'))).toBe('203.0.113.9');
  });

  it('配置 KHY_TRUSTED_PROXIES 后,非受信对端的 XFF 仍不被采信', () => {
    process.env.KHY_TRUSTED_PROXIES = '127.0.0.1';
    expect(getClientIp(mkReq('192.168.1.50', '6.6.6.6'))).toBe('192.168.1.50');
  });

  it('IPv6 限流键按 /64 归并:换地址不能绕过限流', () => {
    expect(_limitKey('2001:db8::1')).toBe(_limitKey('2001:db8::2'));
  });
});
