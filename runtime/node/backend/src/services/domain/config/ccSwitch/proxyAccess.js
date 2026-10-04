'use strict';

/**
 * ccSwitch proxyAccess — 代理模式的「接入凭据」解析层（DESIGN-ARCH-101 §5 / §7 步骤 2）。
 *
 * 直连模式写的是 provider 真实端点 + 真实 key；代理模式写的是 **khy 网关端点 + 网关令牌**，
 * 真实 provider 密钥只留在 api_keys.json 池里给网关自己用。本模块只负责回答两个问题：
 *   1. 网关在哪、令牌是什么       → resolveProxyAccess()
 *   2. 这张卡在池里对应哪个 poolKey → resolvePoolKeyFromCard()
 *
 * 零硬编码（契约 C4 / 工程规则 1 RUNTIME-001）：端点只来自 dataHome 下
 * `proxy_server_runtime.json`（网关启动时动态写入）或 env `KHY_PROXY_ENDPOINT`；
 * 令牌只来自 dataHome 下 `proxy_server_auth.json`（网关首次启动自动生成 `khy-<48hex>`）。
 * 两者都不存在时 **fail-soft 返回具体原因**（状态透明，规则 2.2），绝不假装成功。
 *
 * 本模块只读，不写任何文件；也不 require 网关本体（避免拉起服务器）。
 */

const fs = require('fs');
const path = require('path');

const { getDataHome, getLegacyDataHome } = require('../../../../utils/dataHome');

const PROXY_RUNTIME_FILE = 'proxy_server_runtime.json';
const PROXY_AUTH_FILE = 'proxy_server_auth.json';
const API_KEYS_FILE = 'api_keys.json';

// 运行时文件「新鲜度」窗口：网关每次 start/mode 变更都会重写 runtime（含 endpoint/port）。
// 超过该窗口没被刷新，说明该文件是上一次会话的残留 → 不当作「正在运行」。
const RUNTIME_FRESHNESS_MS = 24 * 60 * 60 * 1000;

function _dataHomeCandidates() {
  const out = [];
  try {
    out.push(getDataHome());
  } catch {
    /* resolution failed */
  }
  try {
    const legacy = getLegacyDataHome();
    if (legacy && !out.includes(legacy)) {
      out.push(legacy);
    }
  } catch {
    /* no legacy home */
  }
  return out;
}

/** 在 dataHome（+ 遗留 home）里找第一个存在的文件；找不到返回 null。 */
function _findInDataHome(name) {
  for (const dir of _dataHomeCandidates()) {
    try {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) {
        return file;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

function _readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * 网关端点 + 令牌发现（零硬编码）。
 *
 * @returns {{
 *   ok: boolean,
 *   proxyEndpoint: string,   // 形如 http://127.0.0.1:9100（不含 /v1；调用方按需拼）
 *   proxyToken: string,      // khy-<48hex>；agent 侧只持有这个，不持有 provider 真实 key
 *   source: { endpoint: string, token: string },  // 'runtime-file' | 'env' | 'absent'
 *   error?: string           // ok=false 时的具体原因（含修复动作）
 * }}
 */
function resolveProxyAccess() {
  const envEndpoint = String(process.env.KHY_PROXY_ENDPOINT || '').trim();

  // ── 端点 ────────────────────────────────────────────────────────────────
  let endpoint = '';
  let endpointSource = 'absent';
  if (envEndpoint) {
    endpoint = envEndpoint.replace(/\/+$/, '');
    endpointSource = 'env';
  } else {
    const runtimeFile = _findInDataHome(PROXY_RUNTIME_FILE);
    const doc = runtimeFile ? _readJson(runtimeFile) : null;
    if (doc && typeof doc === 'object') {
      const raw = String(doc.endpoint || '').trim();
      if (raw) {
        const startedAt = doc.startedAt ? Date.parse(doc.startedAt) : NaN;
        const fresh = Number.isFinite(startedAt)
          ? Date.now() - startedAt < RUNTIME_FRESHNESS_MS
          : true;
        if (fresh) {
          endpoint = raw.replace(/\/+$/, '');
          endpointSource = 'runtime-file';
        }
      }
    }
  }

  // ── 令牌 ────────────────────────────────────────────────────────────────
  let token = '';
  let tokenSource = 'absent';
  const authFile = _findInDataHome(PROXY_AUTH_FILE);
  const authDoc = authFile ? _readJson(authFile) : null;
  if (authDoc && typeof authDoc === 'object') {
    const raw = String(authDoc.authToken || '').trim();
    if (raw) {
      token = raw;
      tokenSource = 'runtime-file';
    }
  }

  if (!endpoint && !token) {
    return {
      ok: false,
      proxyEndpoint: '',
      proxyToken: '',
      source: { endpoint: endpointSource, token: tokenSource },
      error:
        '代理未运行：未发现网关端点（proxy_server_runtime.json 缺失或已过期）且网关令牌不可用。' +
        '修复动作: 在终端执行 khy gateway manage 启动 khy 网关，或在网关运行中的环境重试；' +
        '也可改用直连模式（direct）',
    };
  }
  if (!endpoint) {
    return {
      ok: false,
      proxyEndpoint: '',
      proxyToken: token,
      source: { endpoint: endpointSource, token: tokenSource },
      error:
        '网关端点不可用：proxy_server_runtime.json 缺失、损坏或已过期（status 透明）。' +
        '修复动作: 先启动 khy 网关，或设 env KHY_PROXY_ENDPOINT 指向已运行网关',
    };
  }
  if (!token) {
    return {
      ok: false,
      proxyEndpoint: endpoint,
      proxyToken: '',
      source: { endpoint: endpointSource, token: tokenSource },
      error:
        '网关令牌不可用：proxy_server_auth.json 缺失或无 authToken。' +
        '修复动作: 启动一次 khy 网关以生成令牌（khy gateway manage），或改用直连模式（direct）',
    };
  }

  return {
    ok: true,
    proxyEndpoint: endpoint,
    proxyToken: token,
    source: { endpoint: endpointSource, token: tokenSource },
  };
}

/** 取卡片在密钥池里对应的 provider 名（poolKey）；扫不到返回 ''。 */
function _scanPoolKeyForCard(keyId) {
  if (!keyId) {
    return '';
  }
  const poolFile = _findInDataHome(API_KEYS_FILE);
  const doc = poolFile ? _readJson(poolFile) : null;
  if (!doc || typeof doc !== 'object') {
    return '';
  }
  for (const [provider, entries] of Object.entries(doc)) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      const key = entry && typeof entry.key === 'string' ? entry.key : '';
      if (key && _keyIdFor(provider, key) === keyId) {
        return provider;
      }
    }
  }
  return '';
}

/** 与 apiKeyPool._registerKey 同式：md5(`${provider}:${key}`) 前 12 位 hex。 */
function _keyIdFor(provider, key) {
  const crypto = require('crypto');
  return crypto
    .createHash('md5')
    .update(`${provider}:${key}`)
    .digest('hex')
    .slice(0, 12);
}

/** 卡片名 → 合法 poolKey 形态（小写字母数字，空格折叠为下划线）。 */
function _slug(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * 解析卡片对应的池内 provider 名（poolKey），用于构造可路由模型名
 * `api:<poolKey>:<model>`。
 *
 * 解析顺序：
 *   1. api_keys.json 全池扫描 keyId 命中（最准）
 *   2. 回退：card.name 归一化 slug
 *
 * @param {object} card
 * @param {{ raw?: boolean }} [opts]  raw=true 时返回 { poolKey, source } 便于审计
 * @returns {string|{ poolKey: string, source: 'pool-scan' | 'name-fallback' }}
 */
function resolvePoolKeyFromCard(card, opts = {}) {
  const keyId = card && typeof card.keyId === 'string' ? card.keyId : '';
  let poolKey = _scanPoolKeyForCard(keyId);
  let source = 'pool-scan';
  if (!poolKey) {
    poolKey = _slug(card && card.name);
    source = 'name-fallback';
  }
  if (opts && opts.raw) {
    return { poolKey, source };
  }
  return poolKey;
}

/**
 * 组装「代理卡片」——把真实卡片里会被各 agent 适配器消费的字段就地替换为代理接入值，
 * 从而 **复用既有适配器 add() 而零侵入适配器**（DESIGN-ARCH-101 §7 步骤 1 方案 b）。
 *
 * - baseUrl      → 网关端点（无 /v1；各适配器自己按协议拼路径）
 * - defaultModel → 可路由模型名 `api:<poolKey>:<model>`（三段格式始终可路由，§3.3）
 *
 * 注意：真实 key 不进这里 —— 调用方在 applyCardToApp 里用网关令牌作为 `key` 传入 opts。
 *
 * @param {object} card
 * @param {{ proxyEndpoint: string, poolKey: string, model?: string }} input
 * @returns {object} 新的卡片对象（不修改入参）
 */
function buildProxyCard(card, input = {}) {
  const model = String(input.model || card.defaultModel || '').trim();
  const poolKey = String(input.poolKey || '').trim();
  const routableModel = _routableModelName(poolKey, model);
  return {
    ...card,
    baseUrl: String(input.proxyEndpoint || '').replace(/\/+$/, ''),
    defaultModel: routableModel,
  };
}

/**
 * 构造可路由模型名。已是 `api:<pool>:<model>` 三段格式则原样透传（幂等，避免二次拼接）。
 */
function _routableModelName(poolKey, model) {
  const m = String(model || '').trim();
  if (/^api:[^:]+:.+/.test(m)) {
    return m;
  }
  if (!poolKey || !m) {
    return m;
  }
  return `api:${poolKey}:${m}`;
}

module.exports = {
  resolveProxyAccess,
  resolvePoolKeyFromCard,
  buildProxyCard,
  PROXY_RUNTIME_FILE,
  PROXY_AUTH_FILE,
  API_KEYS_FILE,
  __test__: { _keyIdFor, _slug, _findInDataHome, _routableModelName },
};
