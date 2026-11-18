'use strict';

const { CoreError } = require('../contracts/errors');
const { readCoreEnv } = require('../contracts/core-env');
const { CORE_PROTOCOL_VERSION, CoreHealthResponseSchema, healthMatchesLocator } = require('../contracts/health');
const { HelloRequestSchema, HelloResponseSchema } = require('../contracts/schemas/core-handle.schema');

// suite 注入验活窗口（[DESIGN-ARCH-220] §4.1 第 3 步）：protocol 相等且 capabilities.list()
// 在窗口内返回数组才算活；失败只丢弃并继续发现，不起第二个核心。
const SUITE_INJECTION_KEY = Symbol.for('khy.core');
const INJECTION_LIVENESS_MS = 250;

function resolveFetch(fetchImpl) {
  return fetchImpl || (typeof fetch === 'function' ? fetch : null);
}

async function fetchJson(fetchImpl, url, options) {
  const doFetch = resolveFetch(fetchImpl);
  if (!doFetch) {
    throw new CoreError('CORE_LOCATOR_FAILED', '当前环境没有 fetch：浏览器侧请确认运行时有全局 fetch，Node 侧请用 obtainCoreNode');
  }
  let res;
  try {
    res = await doFetch(url, options);
  } catch (cause) {
    throw new CoreError('CORE_UNAVAILABLE', `无法访问 ${url}：${cause && cause.message ? cause.message : String(cause)}`, {
      retryable: true,
      details: { url },
    });
  }
  if (!res.ok) {
    let payload = null;
    try {
      payload = await res.json();
    } catch (_) {
      payload = null;
    }
    const code = payload && payload.code ? payload.code : 'CORE_UNAVAILABLE';
    throw new CoreError(code, `${url} 返回 ${res.status}：${payload && payload.message ? payload.message : '未给错误说明'}`, {
      retryable: res.status >= 500 || res.status === 429,
      details: { status: res.status, payload: payload || undefined },
    });
  }
  return res.json();
}

// 第 1/2 步：显式坐标优先于用户显式 env，两者都不读发现文件。
function resolveExplicitTarget(opts) {
  if (opts.endpoint) {
    return { endpoint: String(opts.endpoint).replace(/\/+$/, ''), token: opts.token, source: 'explicit' };
  }
  const env = readCoreEnv(opts.env);
  if (env.endpoint) {
    return { endpoint: env.endpoint.replace(/\/+$/, ''), token: opts.token || env.token, source: 'env' };
  }
  return null;
}

async function trySuiteInjection(opts, warnings) {
  const injected = typeof globalThis !== 'undefined' ? globalThis[SUITE_INJECTION_KEY] : undefined;
  if (!injected) return null;
  try {
    if (!injected.version || injected.version.protocol !== CORE_PROTOCOL_VERSION) {
      throw new Error(`注入句柄 protocol=${injected.version && injected.version.protocol}`);
    }
    const live = await Promise.race([
      injected.capabilities.list(),
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('capabilities.list 超时')), INJECTION_LIVENESS_MS);
      }),
    ]);
    if (!Array.isArray(live)) throw new Error('capabilities.list 未返回数组');
    return injected;
  } catch (cause) {
    const message = `core.stale-injection：suite 注入的句柄验活失败（${cause.message}），已丢弃并继续发现`;
    warnings.push(message);
    if (typeof opts.onWarning === 'function') opts.onWarning(message);
    return null;
  }
}

// 六成员通道在 S4/S5 才接线；本刀交付发现与握手，成员调用如实报未接线而不是假装可用。
function pendingMember(label) {
  const notYet = async () => {
    throw new CoreError(
      'CORE_UNAVAILABLE',
      `${label} 成员通道未接线：六成员调用面随 S4/S5 落地，当前仅完成发现与握手`,
      { retryable: false, details: { reason: 'member-pending', member: label } },
    );
  };
  return new Proxy(
    {},
    {
      get(_target, prop) {
        return typeof prop === 'string' ? notYet : undefined;
      },
    },
  );
}

function buildHandle(session, target) {
  let closed = false;
  const handle = {
    mode: 'attached',
    coreId: session.coreId,
    epoch: session.epoch,
    version: { core: session.coreVersion, protocol: session.protocolVersion, enginesKhy: session.enginesKhy },
    paths: session.paths || {},
    gateway: pendingMember('gateway'),
    events: pendingMember('events'),
    storage: pendingMember('storage'),
    session: pendingMember('session'),
    capabilities: pendingMember('capabilities'),
    plugins: pendingMember('plugins'),
    async close() {
      closed = true;
    },
  };
  Object.defineProperty(handle, 'isClosed', { get: () => closed });
  Object.defineProperty(handle, 'endpoint', { get: () => target.endpoint });
  return handle;
}

/**
 * obtainCore（[DESIGN-ARCH-220] §4）：浏览器/第三方 attached 专用，零 node:、永不 spawn。
 * 优先级：显式参数 > 用户显式 env > suite 注入验活 > locator 发现探测。
 */
async function obtainCore(opts) {
  if (!opts || !opts.terminalId || !opts.clientVersion) {
    throw new CoreError('CORE_INVALID_ARGUMENT', 'obtainCore 需要 terminalId 与 clientVersion');
  }
  const warnings = [];

  const explicit = resolveExplicitTarget(opts);
  if (explicit) {
    const health = CoreHealthResponseSchema.parse(await fetchJson(opts.fetchImpl, `${explicit.endpoint}/core/health`));
    return buildHandle(await sayHello(explicit, opts), explicit);
  }

  const injected = await trySuiteInjection(opts, warnings);
  if (injected) return injected;

  const locator = opts.locator;
  if (locator) {
    const target = { endpoint: String(locator.endpoint).replace(/\/+$/, ''), token: opts.token, source: 'locator' };
    const health = CoreHealthResponseSchema.parse(await fetchJson(opts.fetchImpl, `${target.endpoint}/core/health`));
    if (!healthMatchesLocator(health, locator)) {
      throw new CoreError(
        'CORE_PROTOCOL_MISMATCH',
        `发现端点指纹不符：health(coreId=${health.coreId}, protocol=${health.protocolVersion}, pid=${health.pid}) ` +
          `与 locator(coreId=${locator.coreId}, protocol=${locator.protocolVersion}, pid=${locator.pid}) 不一致；` +
          '禁止对该端口另起核心，请修正 locator 或改用显式 endpoint',
        { retryable: false, details: { health: healthFingerprintOf(health), locator: locatorFingerprintOf(locator) } },
      );
    }
    return buildHandle(await sayHello(target, opts, opts), target);
  }

  throw new CoreError(
    'CORE_LOCATOR_FAILED',
    '无法定位核心：浏览器/第三方侧只能 attach，没有可探测的发现面；请在 opts 传 endpoint/token，或由 Node 宿主经 obtainCoreNode 提供 locator',
    { retryable: false },
  );
}

function healthFingerprintOf(health) {
  return { coreId: health.coreId, protocolVersion: health.protocolVersion, pid: health.pid };
}

function locatorFingerprintOf(locator) {
  return { coreId: locator.coreId, protocolVersion: locator.protocolVersion, pid: locator.pid };
}

async function sayHello(target, opts) {
  const request = HelloRequestSchema.parse({
    protocolVersion: CORE_PROTOCOL_VERSION,
    clientVersion: opts.clientVersion,
    terminalId: opts.terminalId,
    required: opts.required || [],
  });
  const response = await fetchJson(opts.fetchImpl, `${target.endpoint}/core/hello`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  const session = HelloResponseSchema.parse(response);
  if (session.protocolVersion !== CORE_PROTOCOL_VERSION) {
    throw new CoreError(
      'CORE_PROTOCOL_MISMATCH',
      `核心 protocolVersion=${session.protocolVersion}，客户端要求 ${CORE_PROTOCOL_VERSION}：协议版本必须相等才可连接`,
      { retryable: false, details: { coreProtocol: session.protocolVersion } },
    );
  }
  return session;
}

module.exports = { obtainCore, SUITE_INJECTION_KEY, INJECTION_LIVENESS_MS };
