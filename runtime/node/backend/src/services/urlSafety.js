/**
 * urlSafety — SSRF guard for outbound HTTP fetches.
 *
 * Any tool that fetches a model- or user-supplied URL (WebFetch, future
 * content extractors) must route through here before opening a socket.
 * The danger is a public-looking hostname that resolves to — or redirects
 * to — an internal target: cloud metadata (169.254.169.254), loopback,
 * RFC1918 ranges, link-local, etc. We reject those.
 *
 * Two tiers of CHECKING:
 *   - assertPublicHttpUrl()         — synchronous: protocol + IP-literal check.
 *   - assertPublicHttpUrlResolved() — async: also DNS-resolves the hostname
 *                                     and rejects if ANY answer is a target.
 *
 * ── Strictness mode (KHY_SSRF_MODE) ───────────────────────────────────────
 * The proxy fake-IP placeholder pool (RFC 2544 `198.18.0.0/15`) is the one
 * address block where "what does this address mean" depends on the operator:
 * Clash / V2Ray / sing-box / Shadowrocket answer every DNS query from that
 * pool in fake-IP mode, and only the local proxy knows where the placeholder
 * leads. Two facts were verified empirically (2026-09-27) before writing this:
 *
 *   1. With the installed `ipaddr.js@1.9.1` the pool is classified `unicast`,
 *      NOT `benchmarking` — so today `isPrivateOrLocalHostname()` returns false
 *      for `198.18.x.x` and the resolved-address check **accepts** it. Fake-IP
 *      users are therefore not broken today; `KHY_FAKE_IP_CIDRS` is currently
 *      inert for this range.
 *   2. `ipaddr.js` 2.x adds the `benchmarking` entry for 198.18.0.0/15, which
 *      would silently flip every Clash fake-IP user to "rejected" on upgrade.
 *
 * Hence the two modes, neither of which widens what is accepted today:
 *   - `lenient` (default) — the placeholder pool is treated as a proxy
 *     placeholder (what the current guard effectively does), and keeps working
 *     after an ipaddr.js upgrade. Every genuinely internal range stays blocked.
 *   - `strict` (`KHY_SSRF_MODE=strict`) — the placeholder pool is **rejected
 *     outright**, closing the opening that ipaddr.js 1.9.1 leaves (it currently
 *     waves 198.18.x.x through as if it were public unicast). For enterprise /
 *     multi-tenant deployments that control egress and want no latitude.
 *
 * An explicit `KHY_FAKE_IP_CIDRS` entry wins in BOTH modes — an operator who
 * names a pool has made a deliberate decision. Note that fake-IP users on
 * transparent/TUN setups usually have no `*_PROXY` env var, so mode selection
 * is deliberately NOT tied to proxy detection: it is one explicit switch, not a
 * guess about the environment.
 *
 * Modeled on open-webSearch's urlSafety.ts; adapted to CommonJS + Node core.
 */
'use strict';

const dns = require('node:dns/promises');
const { isIP } = require('node:net');

const ipaddr = require('ipaddr.js');

// The placeholder pool the mainstream proxy clients ship with by default.
// RFC 2544 benchmarking space: reserved, never globally routable, so it can
// only ever mean "the local proxy will translate this".
const PROXY_FAKE_IP_POOL = ['198.18.0.0/15'];

/** `strict` only on an explicit opt-in; anything else (incl. unset) → `lenient`. */
function ssrfStrictnessMode(env) {
  const v = String((env || process.env || {}).KHY_SSRF_MODE || '')
    .trim()
    .toLowerCase();
  return v === 'strict' ? 'strict' : 'lenient';
}

/**
 * Explicit allowlist for fake-IP CIDRs beyond the well-known proxy pool —
 * comma-separated CIDRs in KHY_FAKE_IP_CIDRS. Honoured in BOTH modes.
 * @param {object} [env]
 */
function _fakeIpCidrs(env) {
  const raw = (env || process.env || {}).KHY_FAKE_IP_CIDRS;
  if (!raw) {
    return [];
  }
  return String(raw)
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
}

// URL.hostname keeps the brackets for IPv6 literals (`[::1]`), which break
// isIP and dns.lookup. Strip them once here.
function _stripIpv6Brackets(host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function _matchesAnyCidr(address, cidrs) {
  if (isIP(address) === 0 || cidrs.length === 0) {
    return false;
  }
  let parsed;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    return false;
  }
  return cidrs.some((cidr) => {
    try {
      return parsed.match(ipaddr.parseCIDR(cidr));
    } catch {
      return false;
    }
  });
}

/**
 * True if the hostname is localhost, an internal name, or an IP literal that
 * is NOT a public unicast address. Plain (non-literal) hostnames return false
 * here — they must go through DNS resolution to be judged (see *Resolved).
 * @param {string} hostname
 * @returns {boolean}
 */
function isPrivateOrLocalHostname(hostname) {
  const host = _stripIpv6Brackets(
    String(hostname || '')
      .trim()
      .toLowerCase()
  );
  if (!host || host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }
  // Common internal TLDs that should never reach the public internet.
  if (host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  if (isIP(host) === 0) {
    return false;
  } // not an IP literal — defer to DNS
  try {
    let addr = ipaddr.parse(host);
    // Unwrap IPv4-mapped IPv6 (::ffff:127.0.0.1) so the IPv4 ranges apply.
    if (
      addr.kind() === 'ipv6' &&
      typeof addr.isIPv4MappedAddress === 'function' &&
      addr.isIPv4MappedAddress()
    ) {
      addr = addr.toIPv4Address();
    }
    return addr.range() !== 'unicast';
  } catch {
    return false;
  }
}

/**
 * True if the URL is a well-formed http(s) URL whose host is not an obvious
 * private/local IP literal. Does NOT perform DNS resolution.
 * @param {string} url
 * @returns {boolean}
 */
function isPublicHttpUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    return !isPrivateOrLocalHostname(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Throw if the URL is not http(s) or points to a private/local IP literal.
 *
 * In `strict` mode a literal address inside the proxy placeholder pool is also
 * rejected, so the mode reads as one coherent posture ("strict never accepts the
 * placeholder space") rather than applying only to DNS-derived addresses.
 * @param {string|URL} url
 * @param {string} label
 */
function assertPublicHttpUrl(url, label = 'URL') {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  if (isPrivateOrLocalHostname(parsed.hostname)) {
    throw new Error(`${label} points to a private or local network target, which is not allowed`);
  }
  const host = _stripIpv6Brackets(parsed.hostname);
  if (
    isIP(host) !== 0 &&
    ssrfStrictnessMode(undefined) === 'strict' &&
    _matchesAnyCidr(host, PROXY_FAKE_IP_POOL)
  ) {
    throw new Error(
      `${label} points into the proxy fake-IP placeholder pool (${PROXY_FAKE_IP_POOL.join(', ')}), ` +
        `which KHY_SSRF_MODE=strict rejects`
    );
  }
}

// Indirection point so tests can stub DNS without real network access.
// Includes a 5-second timeout to prevent slow/drifting DNS servers from
// hanging the request indefinitely.
const DNS_LOOKUP_TIMEOUT_MS = parseInt(process.env.KHY_DNS_LOOKUP_TIMEOUT_MS, 10) || 5000;

async function _timedDnsLookup(hostname) {
  // dns/promises.lookup takes no callback; race it against a timeout instead.
  // The timeout branch only rejects — the underlying lookup is left to settle
  // on its own (its result is simply discarded).
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`DNS lookup timed out after ${DNS_LOOKUP_TIMEOUT_MS}ms`));
    }, DNS_LOOKUP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([dns.lookup(hostname, { all: true, verbatim: true }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

let _dnsLookup = (hostname) => _timedDnsLookup(hostname);

function __setDnsLookupForTests(lookup) {
  _dnsLookup = lookup || ((hostname) => _timedDnsLookup(hostname));
}

/**
 * Verdict for ONE DNS-resolved address — the single place where "may we accept
 * this answer" is decided. Pure (no IO), so it is directly unit-testable.
 *
 * @param {string} address
 * @param {object} [env]
 * @returns {'public'|'allowed-placeholder'|'reject'}
 *   - public              : a normal public address.
 *   - allowed-placeholder : a proxy fake-IP placeholder the operator accepts
 *                           (explicit KHY_FAKE_IP_CIDRS entry, or the well-known
 *                           proxy pool in `lenient` mode).
 *   - reject              : a private/local/internal target, or the placeholder
 *                           pool under `strict`.
 */
function classifyResolvedAddress(address, env) {
  // An operator who names a pool has made a deliberate decision — wins in both modes.
  if (_matchesAnyCidr(address, _fakeIpCidrs(env))) {
    return 'allowed-placeholder';
  }
  const inProxyPool = _matchesAnyCidr(address, PROXY_FAKE_IP_POOL);
  if (ssrfStrictnessMode(env) === 'strict') {
    // strict closes the opening ipaddr.js 1.9.1 leaves: it classifies
    // 198.18.0.0/15 as `unicast`, so isPrivateOrLocalHostname() alone would
    // wave the placeholder pool through as if it were public.
    return inProxyPool || isPrivateOrLocalHostname(address) ? 'reject' : 'public';
  }
  // lenient: what the guard effectively accepts today, and what keeps working
  // after an ipaddr.js upgrade starts reporting the pool as `benchmarking`.
  if (inProxyPool) {
    return 'allowed-placeholder';
  }
  return isPrivateOrLocalHostname(address) ? 'reject' : 'public';
}

/**
 * Like assertPublicHttpUrl, but also DNS-resolves the hostname and rejects if
 * ANY resolved address is a target (see classifyResolvedAddress). This closes
 * the DNS-rebinding and "public CNAME → internal A record" holes.
 * Skipped for IP-literal hosts (already judged synchronously — and deliberately
 * stricter there: a placeholder-pool literal in a URL is never legitimate,
 * since fake-IPs only ever come from DNS).
 * @param {string|URL} url
 * @param {string} label
 * @returns {Promise<void>}
 */
async function assertPublicHttpUrlResolved(url, label = 'URL') {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  assertPublicHttpUrl(parsed, label);

  const host = _stripIpv6Brackets(parsed.hostname);
  if (isIP(host) !== 0) {
    return;
  } // IP literal already validated

  let resolved;
  try {
    resolved = await _dnsLookup(host);
  } catch {
    throw new Error(`${label} could not be resolved`);
  }
  const list = Array.isArray(resolved) ? resolved : [];
  const rejected = list.filter((entry) => classifyResolvedAddress(entry.address, undefined) === 'reject');
  if (rejected.length > 0) {
    throw new Error(
      `${label} resolves to a private or local network target, which is not allowed` +
        `（若这是 Clash/V2Ray 的 fake-IP 占位地址，可设置 KHY_FAKE_IP_CIDRS 加入白名单；` +
        `企业环境可用 KHY_SSRF_MODE=strict 拒绝全部占位段）`
    );
  }
}

module.exports = {
  isPrivateOrLocalHostname,
  isPublicHttpUrl,
  assertPublicHttpUrl,
  assertPublicHttpUrlResolved,
  classifyResolvedAddress,
  ssrfStrictnessMode,
  PROXY_FAKE_IP_POOL,
  __setDnsLookupForTests,
};
