/**
 * Customer Quota Enforcer
 *
 * Real-time quota enforcement for external AI-gateway customers.
 *
 * Responsibilities:
 *   1. Resolve which customer a presented managed token belongs to
 *      (managed tokens live in proxy_server_auth.json; the customer →
 *      tokenIds binding lives in ai_gateway_customers.json).
 *   2. Enforce, BEFORE a request is dispatched to any model adapter:
 *      - disabled customer          → 403
 *      - monthly request quota hit  → 429
 *      - monthly token quota hit    → 429
 *      - monthly budget (CNY) hit   → 429
 *      A quota field of 0 means "unlimited" (backward compatible).
 *   3. Meter usage (requests / tokens / cost CNY) into monthly buckets
 *      keyed by YYYY-MM, so month rollover naturally starts from zero.
 *
 * Design notes:
 *   - This module reads the JSON stores directly instead of requiring
 *     customerRegistry, because customerRegistry requires proxyServer and
 *     proxyServer requires this module (avoids a require cycle).
 *   - Enforcement fails CLOSED on internal errors (a broken store must not
 *     silently bill nobody), unless KHY_QUOTA_FAIL_OPEN=true. Quota verdicts
 *     themselves are strict in both modes.
 *   - Usage persistence is write-through with atomic tmp+rename, matching
 *     the customerRegistry persistence pattern.
 *
 * Single-writer usage persistence (fixes a dual-process write race):
 *   The ai-backend process (customerUsageService) owns and rewrites
 *   ai_gateway_customer_usage.json with its own in-memory counters. If this
 *   gateway process rewrote the SAME file per request, the two processes
 *   would clobber each other's read-modify-write cycles and lose counts.
 *   Chosen fix: writer-scoped files + merge-on-read.
 *     - This module is the ONLY writer of its own sibling file
 *       ai_gateway_customer_usage.gateway.json (write-through, atomic).
 *     - The ai-backend file is treated as a READ-ONLY peer source here and
 *       is merged into the quota verdict, so a customer's spend through
 *       either data plane counts against the same monthly quota.
 *   No JSON file ever has two concurrent read-modify-rewrite writers, and
 *   the verdict is always consistent with what this process has written
 *   (own counters are in-memory authoritative, peer data lags by at most
 *   the peer's debounce plus the read cache TTL below).
 */
const fs = require('fs');
const path = require('path');

const { getDataHome, getLegacyDataHome, getAppHome } = require('../../utils/dataHome');

// 收敛到 utils/mkdirpSync 单一真源
const ensureDir = require('../../utils/mkdirpSync');

// Peer file: owned (written) exclusively by ai-backend customerUsageService.
const PEER_USAGE_FILE_ENV = 'AI_GATEWAY_CUSTOMER_USAGE_FILE';
const PEER_USAGE_FILE_NAME = 'ai_gateway_customer_usage.json';
// Own file: written exclusively by this gateway process.
const GATEWAY_USAGE_FILE_ENV = 'AI_GATEWAY_CUSTOMER_USAGE_GATEWAY_FILE';
const GATEWAY_USAGE_FILE_NAME = 'ai_gateway_customer_usage.gateway.json';

// Hot-path store reads (proxy auth / customers / peer usage) are cached in
// process with a sliding TTL + mtime check, so enforce() no longer does two
// synchronous readFileSync+parse per request. Fail-open semantics and the
// single data source stay unchanged — only the read frequency drops.
const STORE_TTL_MS = Math.max(
  1000,
  parseInt(process.env.AI_GATEWAY_QUOTA_STORE_TTL_MS || '10000', 10) || 10000
);
const _storeCache = new Map(); // key → { data, srcPath, mtimeMs, expiresAt }

let _usageState = null; // { [customerId]: { [YYYY-MM]: bucket } } (own writes only)
let _usageLoadedFrom = ''; // file path the in-memory state was loaded from

function customersFile() {
  return path.join(getDataHome(), 'ai_gateway_customers.json');
}

function legacyCustomersFile() {
  return path.join(getLegacyDataHome(), 'ai_gateway_customers.json');
}

function proxyAuthFile() {
  return path.join(getDataHome(), 'proxy_server_auth.json');
}

function legacyProxyAuthFile() {
  return path.join(getLegacyDataHome(), 'proxy_server_auth.json');
}

function peerUsageFile() {
  const explicit = String(process.env[PEER_USAGE_FILE_ENV] || '').trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  // Same file name/home the ai-backend customerUsageService converges on.
  return path.join(getAppHome(), PEER_USAGE_FILE_NAME);
}

function gatewayUsageFile() {
  const explicit = String(process.env[GATEWAY_USAGE_FILE_ENV] || '').trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.join(getAppHome(), GATEWAY_USAGE_FILE_NAME);
}

function readJsonSafe(filePaths, fallback) {
  for (const filePath of filePaths) {
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        continue;
      }
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        continue;
      }
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch {
      /* try next candidate */
    }
  }
  return fallback;
}

/**
 * True when a store file is present but could not be parsed / read.
 *
 * This distinction is load-bearing: "no customer resolved" means two very
 * different things. A missing store is a fresh install with nothing to bill,
 * but an UNREADABLE store means every managed customer silently falls into the
 * internal-channel exemption and gets served for free. Without this check the
 * exemption path is itself the fail-open (repro b).
 */
function isStoreUnreadable(filePaths) {
  for (const filePath of filePaths) {
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        continue;
      }
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        continue;
      }
      JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return false; // first existing candidate parsed cleanly
    } catch {
      return true;
    }
  }
  return false;
}

function isFailOpenAllowed() {
  return String(process.env.KHY_QUOTA_FAIL_OPEN || '').toLowerCase() === 'true';
}

function buildStoreUnreadableVerdict() {
  // Paths stay in the operator log, not in the response: DESIGN-API-002 §5
  // lists internal file paths as not exposable.
  try {
    console.warn(
      `[Proxy] 客户库/令牌库不可读，本次请求已拒绝：${customersFile()} / ${proxyAuthFile()}；` +
        '若为应急放行可设 KHY_QUOTA_FAIL_OPEN=true'
    );
  } catch {
    /* logging must not affect the verdict */
  }
  return {
    allowed: false,
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
    details: { reason: 'customer_store_unreadable' },
    message:
      '服务暂不可用 (503)：配额存储不可读，本次请求未计费也未放行；请稍后重试，持续失败请联系管理员并提供 traceId',
  };
}

/**
 * TTL + mtime cached JSON read for per-request hot paths.
 * Within the TTL the cached object is returned with zero fs calls; after the
 * TTL a cheap stat() decides whether a re-parse is needed (unchanged mtime
 * just extends the TTL). Unreadable sources fall back (fail-open) and the
 * fallback is cached too, so a broken store cannot hammer the disk.
 */
function cachedReadJson(cacheKey, filePaths, fallback) {
  const now = Date.now();
  const entry = _storeCache.get(cacheKey);
  if (entry && now < entry.expiresAt) {
    return entry.data;
  }

  let srcPath = '';
  let mtimeMs = 0;
  try {
    for (const p of filePaths) {
      if (!p) {
        continue;
      }
      const stat = fs.statSync(p, { throwIfNoEntry: false });
      if (stat && stat.isFile()) {
        srcPath = p;
        mtimeMs = stat.mtimeMs;
        break;
      }
    }
  } catch {
    /* treated as a missing source below */
  }

  if (entry && entry.srcPath === srcPath && entry.mtimeMs === mtimeMs) {
    entry.expiresAt = now + STORE_TTL_MS; // unchanged on disk → skip re-parse
    return entry.data;
  }
  const data = srcPath ? readJsonSafe([srcPath], fallback) : fallback;
  _storeCache.set(cacheKey, { data, srcPath, mtimeMs, expiresAt: now + STORE_TTL_MS });
  return data;
}

/** Self-heal: a stray empty DIRECTORY squatting on the usage-file path. */
function healUsagePathSquatter(filePath) {
  try {
    const stat = fs.statSync(filePath, { throwIfNoEntry: false });
    if (stat && stat.isDirectory()) {
      // Only an EMPTY artifact dir is removed; real data is never deleted.
      if (fs.readdirSync(filePath).length === 0) {
        fs.rmdirSync(filePath);
      }
    }
  } catch {
    /* best-effort; save path below stays fail-soft */
  }
}

function writeJsonAtomic(filePath, payload) {
  ensureDir(path.dirname(filePath));
  healUsagePathSquatter(filePath);
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

function monthKey(date = new Date()) {
  return date.toISOString().slice(0, 7); // YYYY-MM
}

function emptyBucket() {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costCny: 0,
    billedCny: 0,
  };
}

function ensureUsageLoaded() {
  const file = gatewayUsageFile();
  if (_usageState && _usageLoadedFrom === file) {
    return;
  }
  const raw = readJsonSafe([file], { customers: {} });
  _usageState = raw.customers && typeof raw.customers === 'object' ? raw.customers : {};
  _usageLoadedFrom = file;
}

function saveUsage() {
  try {
    // Single-writer contract: only THIS process writes the gateway file.
    writeJsonAtomic(gatewayUsageFile(), {
      version: 1,
      updatedAt: new Date().toISOString(),
      customers: _usageState || {},
    });
  } catch {
    /* metering persistence is fail-soft; in-memory state stays live */
  }
}

function addBucketInto(target, bucket) {
  if (!bucket || typeof bucket !== 'object') {
    return target;
  }
  target.requests += Number(bucket.requests) || 0;
  target.inputTokens += Number(bucket.inputTokens) || 0;
  target.outputTokens += Number(bucket.outputTokens) || 0;
  target.totalTokens += Number(bucket.totalTokens) || 0;
  target.costCny += Number(bucket.costCny) || 0;
  target.billedCny += Number(bucket.billedCny) || 0;
  return target;
}

/**
 * Current-month usage for a customer, merged across BOTH data planes:
 * own gateway metering (in-memory authoritative) + the ai-backend peer file
 * (read-only here, cached with a short TTL). Spend through either plane
 * counts against the same monthly quota.
 */
function getMonthUsage(customerId, date = new Date()) {
  ensureUsageLoaded();
  const cid = String(customerId || '');
  const mk = monthKey(date);
  const merged = emptyBucket();
  addBucketInto(merged, _usageState[cid] && _usageState[cid][mk]);
  const peerRaw = cachedReadJson('peerUsage', [peerUsageFile()], { customers: {} });
  const peerCustomers =
    peerRaw.customers && typeof peerRaw.customers === 'object' ? peerRaw.customers : {};
  addBucketInto(merged, peerCustomers[cid] && peerCustomers[cid][mk]);
  return { ...merged, month: mk, customerId: cid };
}

/** Add usage to the current-month bucket (write-through persistence). */
function addUsage(
  customerId,
  { requests = 0, inputTokens = 0, outputTokens = 0, costCny = 0, billedCny = 0 } = {},
  date = new Date()
) {
  ensureUsageLoaded();
  const cid = String(customerId || '');
  if (!cid) {
    return null;
  }
  const mk = monthKey(date);
  if (!_usageState[cid]) {
    _usageState[cid] = {};
  }
  if (!_usageState[cid][mk]) {
    _usageState[cid][mk] = emptyBucket();
  }
  const b = _usageState[cid][mk];
  b.requests += Number(requests) || 0;
  b.inputTokens += Number(inputTokens) || 0;
  b.outputTokens += Number(outputTokens) || 0;
  b.totalTokens += (Number(inputTokens) || 0) + (Number(outputTokens) || 0);
  b.costCny += Number(costCny) || 0;
  b.billedCny += Number(billedCny) || 0;
  saveUsage();
  return { ...b, month: mk, customerId: cid };
}

function normalizeQuota(input) {
  const source = input && typeof input === 'object' ? input : {};
  const clampLimit = (field) => {
    const raw = source[field];
    const num = Number(raw);
    if (raw !== undefined && raw !== null && raw !== '' && (!Number.isFinite(num) || num < 0)) {
      // Negative / non-finite limits are coerced to 0 (= unlimited); warn so a
      // misconfigured quota is visible instead of silently unrestricted.
      try {
        console.warn(
          `[Proxy] 配额字段 ${field} 的值非法（${String(raw)}），已按 0=无限制处理，请检查客户配额配置`
        );
      } catch {
        /* logging must not affect the verdict */
      }
    }
    return Math.max(0, num || 0);
  };
  // monthlyBudgetCny is a BALANCE, not a ceiling: a refund may legitimately
  // push it below zero (the customer is then in credit and must be blocked —
  // see checkQuota). The other two stay clamped because they are usage
  // ceilings and a negative ceiling has no meaning.
  const rawBudget = Number(source.monthlyBudgetCny);
  const budgetFinite = Number.isFinite(rawBudget);
  if (source.monthlyBudgetCny !== undefined && !budgetFinite) {
    try {
      console.warn(
        `[Proxy] 配额字段 monthlyBudgetCny 的值非法（${String(source.monthlyBudgetCny)}），已按 0 处理，请检查客户配额配置`
      );
    } catch {
      /* logging must not affect the verdict */
    }
  }
  return {
    monthlyRequests: clampLimit('monthlyRequests'),
    monthlyTokens: clampLimit('monthlyTokens'),
    monthlyBudgetCny: budgetFinite ? roundFen(rawBudget) : 0,
  };
}

/**
 * Map a presented bearer token → the customer that owns it.
 * Returns null for the primary auth token / unknown / unbound tokens
 * (those callers are not customers and stay quota-exempt — backward compat).
 *
 * Exemption boundary (by design, not an oversight): the primary auth token
 * and any tokens injected via the PROXY_AUTH_TOKENS env are INTERNAL /
 * operations channels — they authenticate the owner's own tooling, never a
 * paying customer, so they bypass quota. The primary token must therefore
 * NEVER be handed out to external customers; customers only ever receive
 * managed tokens bound to a customer record via tokenIds.
 */
function resolveCustomerByToken(presentedToken) {
  const token = String(presentedToken || '').trim();
  if (!token) {
    return null;
  }

  const authRaw = cachedReadJson('proxyAuth', [proxyAuthFile(), legacyProxyAuthFile()], {});
  const managedRows = Array.isArray(authRaw.managedTokens) ? authRaw.managedTokens : [];
  const matched = managedRows.find((row) => String(row?.token || '') === token);
  if (!matched || !matched.id) {
    return null;
  }

  const customersRaw = cachedReadJson('customers', [customersFile(), legacyCustomersFile()], {
    customers: [],
  });
  const rows = Array.isArray(customersRaw.customers) ? customersRaw.customers : [];
  const owner = rows.find(
    (row) => Array.isArray(row?.tokenIds) && row.tokenIds.includes(matched.id)
  );
  if (!owner) {
    return null;
  }

  return {
    id: String(owner.id || ''),
    name: String(owner.name || owner.id || ''),
    enabled: owner.enabled !== false,
    quota: normalizeQuota(owner.quota),
  };
}

/** Convert a CNY amount to integer fen (分) for precision-safe compares. */
function toFen(cny) {
  return Math.round((Number(cny) || 0) * 100);
}

/** CNY rounded to whole fen, keeping the sign (refunds must stay negative). */
function roundFen(cny) {
  return toFen(cny) / 100;
}

/**
 * Pure quota verdict for a customer against current-month usage.
 * Gate semantics: block when already-used >= limit (the last request may
 * slightly overshoot; that is reconciled by the next check).
 * @returns {{ ok: true } | { ok: false, scope, used, limit, month }}
 */
function checkQuota(customer, date = new Date()) {
  const quota = normalizeQuota(customer?.quota);
  const usage = getMonthUsage(customer?.id, date);

  if (quota.monthlyRequests > 0 && usage.requests >= quota.monthlyRequests) {
    return {
      ok: false,
      scope: 'requests',
      used: usage.requests,
      limit: quota.monthlyRequests,
      month: usage.month,
    };
  }
  if (quota.monthlyTokens > 0 && usage.totalTokens >= quota.monthlyTokens) {
    return {
      ok: false,
      scope: 'tokens',
      used: usage.totalTokens,
      limit: quota.monthlyTokens,
      month: usage.month,
    };
  }
  const spentCny = Math.max(usage.costCny || 0, usage.billedCny || 0);
  // A negative balance means a refund pushed the customer past zero. That is
  // arrears, not headroom, so it blocks before any spend — otherwise the
  // legacy "0 means unlimited" reading would hand a fully-refunded customer
  // unlimited usage.
  if (quota.monthlyBudgetCny < 0) {
    return {
      ok: false,
      scope: 'arrears',
      used: spentCny,
      limit: quota.monthlyBudgetCny,
      month: usage.month,
    };
  }
  // Compare in integer fen so accumulated float error (0.1+0.2 style) can
  // never flip the budget verdict; display values stay 2-decimal CNY.
  if (quota.monthlyBudgetCny > 0 && toFen(spentCny) >= toFen(quota.monthlyBudgetCny)) {
    return {
      ok: false,
      scope: 'budget',
      used: spentCny,
      limit: quota.monthlyBudgetCny,
      month: usage.month,
    };
  }
  return { ok: true };
}

function buildRejection(customer, verdict) {
  const id = customer.id;
  if (verdict.scope === 'arrears') {
    return {
      allowed: false,
      status: 429,
      code: 'ARREARS',
      details: { reason: 'refund_exceeds_paid', scope: verdict.scope },
      scope: verdict.scope,
      used: verdict.used,
      limit: verdict.limit,
      month: verdict.month,
      message: `客户 ${id} 的月预算余额为负（¥${Number(verdict.limit).toFixed(2)}，退款已超出其已付额度），AI 网关已拒绝本次模型请求；请先为该客户充值补足余额`,
    };
  }
  if (verdict.scope === 'requests') {
    return {
      allowed: false,
      status: 429,
      code: 'CREDITS_EXHAUSTED',
      details: { reason: 'monthly_requests_exceeded', scope: 'requests' },
      scope: verdict.scope,
      used: verdict.used,
      limit: verdict.limit,
      month: verdict.month,
      message: `客户 ${id} 月度请求数已超限（${verdict.month} 已用 ${verdict.used}/${verdict.limit} 次），AI 网关已拒绝本次模型请求`,
    };
  }
  if (verdict.scope === 'tokens') {
    return {
      allowed: false,
      status: 429,
      code: 'CREDITS_EXHAUSTED',
      details: { reason: 'monthly_tokens_exceeded', scope: 'tokens' },
      scope: verdict.scope,
      used: verdict.used,
      limit: verdict.limit,
      month: verdict.month,
      message: `客户 ${id} 月度 token 用量已超限（${verdict.month} 已用 ${verdict.used}/${verdict.limit} tokens），AI 网关已拒绝本次模型请求`,
    };
  }
  return {
    allowed: false,
    status: 429,
    code: 'CREDITS_EXHAUSTED',
    details: { reason: 'monthly_budget_exceeded', scope: 'budget' },
    scope: verdict.scope,
    used: verdict.used,
    limit: verdict.limit,
    month: verdict.month,
    message: `客户 ${id} 月度预算已超限（${verdict.month} 已消费 ¥${Number(verdict.used).toFixed(2)}/上限 ¥${Number(verdict.limit).toFixed(2)}），AI 网关已拒绝本次模型请求`,
  };
}

/**
 * Gateway entry-point enforcement: token → customer → enabled + quota gate.
 *
 * On an internal error the verdict is now DENY by default: this module is the
 * enforcement path actually wired into backend/proxyServer.js:2862, so a
 * fail-open here means a broken store silently bills nobody. Set
 * KHY_QUOTA_FAIL_OPEN=true to restore the old availability-first behaviour for
 * deployments that would rather serve the request than check it.
 *
 * Note: primary-token / PROXY_AUTH_TOKENS callers resolve to no customer and
 * are quota-exempt internal channels (see resolveCustomerByToken above).
 * @returns {{ allowed: true, customer: object|null } |
 *           { allowed: false, status, code, scope?, used?, limit?, month?, message }}
 */
function enforce(presentedToken, date = new Date()) {
  try {
    // Read the stores up front: an unreadable one must not degrade into "this
    // token belongs to no customer", which is the exemption that costs money.
    if (
      !isFailOpenAllowed() &&
      (isStoreUnreadable([customersFile(), legacyCustomersFile()]) ||
        isStoreUnreadable([proxyAuthFile(), legacyProxyAuthFile()]))
    ) {
      return buildStoreUnreadableVerdict();
    }
    const customer = resolveCustomerByToken(presentedToken);
    if (!customer) {
      return { allowed: true, customer: null };
    }
    if (customer.enabled === false) {
      return {
        allowed: false,
        status: 403,
        code: 'FORBIDDEN',
        details: { reason: 'customer_disabled' },
        message: `客户「${customer.name}」(${customer.id}) 已被停用，AI 网关已拒绝本次模型请求（恢复访问需管理员重新启用该客户）`,
      };
    }
    const verdict = checkQuota(customer, date);
    if (!verdict.ok) {
      return buildRejection(customer, verdict);
    }
    return { allowed: true, customer };
  } catch (err) {
    if (isFailOpenAllowed()) {
      try {
        console.warn(`[Proxy] 客户配额检查内部异常（已放行本次请求，异常: ${err.message}）`);
      } catch {
        /* ignore */
      }
      return { allowed: true, customer: null };
    }
    try {
      console.warn(
        `[Proxy] 客户配额检查内部异常（已拒绝本次请求，异常: ${err.message}）；` +
          '若为应急放行可设 KHY_QUOTA_FAIL_OPEN=true'
      );
    } catch {
      /* ignore */
    }
    return {
      allowed: false,
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: { reason: 'quota_check_failed' },
      message:
        '服务暂不可用 (503)：配额校验未完成，本次请求未计费也未放行；请稍后重试，持续失败请联系管理员并提供 traceId',
    };
  }
}

/** Normalize adapter token-usage shapes (camelCase / OpenAI / Anthropic). */
function extractTokenCounts(tokenUsage) {
  const tu = tokenUsage && typeof tokenUsage === 'object' ? tokenUsage : {};
  const inputTokens = Number(tu.inputTokens ?? tu.prompt_tokens ?? tu.input_tokens) || 0;
  const outputTokens = Number(tu.outputTokens ?? tu.completion_tokens ?? tu.output_tokens) || 0;
  return { inputTokens, outputTokens };
}

/**
 * Meter one completed gateway generate() call onto the owning customer.
 * Single accounting point — called from proxyServer.generateByRoute so no
 * route can double-count. Never throws.
 */
function recordUsage(customerId, { result = null, adapterKey = null } = {}) {
  try {
    const cid = String(customerId || '');
    if (!cid) {
      return null;
    }
    const { inputTokens, outputTokens } = extractTokenCounts(result?.tokenUsage);
    let costCny = 0;
    if (inputTokens > 0 || outputTokens > 0) {
      try {
        const tokenUsageService = require('../tokenUsageService');
        const provider = String(result?.provider || adapterKey || 'default');
        costCny = tokenUsageService.calculateCost(provider, inputTokens, outputTokens).costCNY || 0;
      } catch {
        /* pricing unavailable → count tokens/requests only */
      }
    }
    return addUsage(cid, { requests: 1, inputTokens, outputTokens, costCny });
  } catch {
    return null; // metering must never break the response path
  }
}

/** Test helper: drop in-memory caches so files are re-read. */
function _resetForTest() {
  _usageState = null;
  _usageLoadedFrom = '';
  _storeCache.clear();
}

module.exports = {
  enforce,
  checkQuota,
  resolveCustomerByToken,
  recordUsage,
  addUsage,
  getMonthUsage,
  monthKey,
  _resetForTest,
};
