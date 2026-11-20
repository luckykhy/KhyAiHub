/**
 * Rate Limiting Middleware
 *
 * Access & Routing Layer (接入与路由层) - Step 3 of 5 in the middleware chain.
 * Controls per-IP request frequency (default 100 req/min for API,
 * stricter limits for auth and AI endpoints).
 * See thesis Chapter 4.2, Table 12.
 * @pattern Proxy
 */
const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');

/**
 * 可信反代名单（逗号分隔的 IP / CIDR），由 KHY_TRUSTED_PROXIES 配置。
 *
 * 为空 ⇒ 不采信任何 X-Forwarded-For（除非 TCP 对端本身是回环，见 getClientIp）。
 *
 * 为什么必须这样：此前 getClientIp 直接取 XFF 的**第一段**，客户端自填即得：
 *   - XFF=127.0.0.1 ⇒ shouldSkipRateLimit 判为回环 → 整条跳过限流；
 *   - XFF 轮换 ⇒ 每个请求换一个限流键。
 * 于是登录防爆破（30 次/15 分钟）、resetLimiter、apiLimiter、aiLimiter 全部可绕
 * （SEC-02）。口径对齐 aiManagementServer.js 的 _getTrustedProxyIps：没有受信
 * 反代就不把请求头当可信输入。
 */
function _getTrustedProxyIps() {
  const raw = process.env.KHY_TRUSTED_PROXIES || '';
  if (!raw.trim()) {
    return new Set();
  }
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

/** IPv4-mapped IPv6（::ffff:1.2.3.4）归一为 IPv4，避免同一台主机出现两个键。 */
function _normalizeIp(ip) {
  if (!ip) return '';
  let v = String(ip).trim();
  if (v.toLowerCase().startsWith('::ffff:')) {
    v = v.slice(7);
  }
  return v;
}

function _isIpv4(ip) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
}

/** 简单 IPv4 CIDR 匹配（反代白名单用；不匹配则视为不可信）。 */
function _cidrMatch(ip, cidr) {
  if (!cidr.includes('/') || !_isIpv4(ip)) {
    return false;
  }
  const [range, bitsStr] = cidr.split('/');
  if (!_isIpv4(range)) {
    return false;
  }
  const bits = parseInt(bitsStr, 10);
  if (!Number.isFinite(bits) || bits < 0 || bits > 32) {
    return false;
  }
  const toLong = (s) => s.split('.').reduce((acc, o) => ((acc << 8) + Number(o)) >>> 0, 0);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toLong(ip) & mask) === (toLong(range) & mask);
}

function isLoopback(ip) {
  if (!ip) return false;
  const v = _normalizeIp(ip);
  return v === '127.0.0.1' || v === '::1' || v.startsWith('127.');
}

/**
 * 取 XFF 的**最后一段**。
 *
 * 反代是追加方（仓内两个 nginx 都用 proxy_add_x_forwarded_for）：客户端自填的值
 * 在最左段，反代看到的真实对端追加在最后一段。取最后一段才是真实客户端。
 */
function _xffLastSegment(xff) {
  const hops = String(xff)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return hops.length ? hops[hops.length - 1] : '';
}

/**
 * 限流键的来源：TCP 对端地址（请求头默认不可信）。
 *
 * 采信 XFF 的两种情形，都以「TCP 对端是可信反代」为前提：
 *   1. 对端命中 KHY_TRUSTED_PROXIES ⇒ 取 XFF 最后一段；
 *   2. 对端是回环（本机反代/本机客户端）⇒ 取 XFF 最后一段。
 *      远程攻击者的 TCP 对端不是回环，取不到这条路径 —— 所以「XFF=127.0.0.1
 *      关掉限流」这条路对远程攻击者已关闭。
 * 其余情况只用 req.socket.remoteAddress，不看任何请求头。
 */
function getClientIp(req) {
  const remote = _normalizeIp(req && req.socket && req.socket.remoteAddress);
  if (!remote) {
    return '';
  }
  const xff = req && req.headers && req.headers['x-forwarded-for'];
  if (xff) {
    for (const proxy of _getTrustedProxyIps()) {
      if (remote === proxy || _cidrMatch(remote, proxy)) {
        return _xffLastSegment(xff) || remote;
      }
    }
    if (isLoopback(remote)) {
      return _xffLastSegment(xff) || remote;
    }
  }
  return remote;
}

/** 展开压缩写法（2001:db8::1 → 8 段）。 */
function _expandIpv6(ip) {
  const [head, tail] = ip.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const fill = 8 - headParts.length - tailParts.length;
  return [...headParts, ...new Array(Math.max(0, fill)).fill('0'), ...tailParts];
}

/**
 * 限流键。IPv6 按 /64 归并 —— 同一 /64 内的地址算同一客户端，否则客户端换个
 * IPv6 地址就能绕过限流（express-rate-limit 默认键用 ipKeyGenerator 做同样的事，
 * 这里自带一份是因为我们不能把键建立在 req.ip 上）。
 */
function _limitKey(ip) {
  const v = _normalizeIp(ip);
  if (!v) return 'unknown';
  if (v.includes(':') && !_isIpv4(v)) {
    const parts = _expandIpv6(v);
    if (parts.length >= 8) {
      return [...parts.slice(0, 4).map((p) => p || '0'), '0', '0', '0', '0'].join(':');
    }
  }
  return v;
}

function shouldSkipRateLimit(req) {
  const ip = getClientIp(req);
  // Only skip rate limiting for true loopback addresses.
  // Private/Docker IPs still get (relaxed) rate limits to
  // prevent abuse from within the same network.
  return isLoopback(ip);
}

function createLimiter(options) {
  return rateLimit({
    ...options,
    standardHeaders: true,
    legacyHeaders: false,
    // 键必须自己算：默认键用 req.ip，而 req.ip 在 trust proxy=1 下由 XFF 推导，
    // 依然可被客户端伪造（SEC-02）。本函数不读 req.ip，故不触发
    // express-rate-limit 的 ERR_ERL_KEY_GEN_IPV6 校验。
    keyGenerator: (req) => _limitKey(getClientIp(req)),
    skip: shouldSkipRateLimit,
    handler: (req, res) => {
      const ip = getClientIp(req);
      logger.warn('Rate limit exceeded', {
        ip,
        path: req.originalUrl,
        method: req.method,
      });
      res.status(429).json({
        success: false,
        message: '请求过于频繁，请稍后重试'
      });
    }
  });
}

// General API rate limiter: 600 requests/minute
const apiLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_API_MAX || '600', 10)
});

// Auth endpoints: 30 attempts per 15 minutes
const authLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_AUTH_MAX || '30', 10)
});

// AI/ML endpoints: 120 requests per minute
const aiLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_AI_MAX || '120', 10)
});

module.exports = {
  apiLimiter,
  authLimiter,
  aiLimiter,
  // 导出给测试与诊断（SEC-02 的回归用例直接打这几个纯函数）
  getClientIp,
  shouldSkipRateLimit,
  isLoopback,
  _limitKey,
  _getTrustedProxyIps,
};
