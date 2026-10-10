/**
 * doctorConnectivity.js — async connectivity checks for `khy doctor`
 *
 * Three checks appended to the doctor report:
 *   1. Backend WebSocket reachability: discover the daemon port dynamically
 *      (runtime JSON / env vars — never hardcoded), open a WS connection to
 *      the loopback address, send the same auth message the frontend sends
 *      and wait for `auth_ok`.
 *   2. Proxy connectivity: reuse proxyConfigService's loadConfig/testProxy
 *      to probe the configured proxy endpoint (skipped when not configured).
 *   3. Per-provider proxy connectivity: probe the `proxy` endpoints declared
 *      by individual providers in custom_providers.json, which check 2 does
 *      not cover (skipped when no provider declares one).
 *
 * These probes are async, so they live outside the synchronous
 * runDoctorChecks() and are merged into the report by handleDoctor().
 * All timeouts are ≤10s (connect/probe exemption).
 *
 * @module handlers/doctorConnectivity
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Category shown in the doctor report for both checks.
const CATEGORY = '连接诊断';

// Connect/probe timeout budget (≤10s exemption for handshake probes).
const PROBE_TIMEOUT_MS = 10000;

// ── Backend port discovery ───────────────────────────────────────────────────
// Mirrors delivery/web/ai-frontend/backendDiscovery.mjs precedence:
//   1. apiPort from ai_manage_runtime.json across known data homes
//      (KHY_DATA_HOME → pinned pointer → ~/.khy → ~/.khyquant)
//   2. env port hints (KHY_DAEMON_PORT / AI_MGMT_PORT)
// No hardcoded fallback port: when nothing is found the check reports a
// "backend not running" warning instead of probing a guessed port.

function _parsePort(raw) {
  const port = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(port) && port > 0 && port <= 65535 ? port : null;
}

function _readApiPortFromRuntime(dataHome) {
  if (!dataHome) {
    return null;
  }
  try {
    const file = path.join(dataHome, 'ai_manage_runtime.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return _parsePort(raw?.apiPort);
  } catch {
    /* missing/corrupt → try next candidate */
  }
  return null;
}

function _readPointerDataHome(env, homedir) {
  try {
    const pointerFile = env.KHY_LOCATION_FILE || path.join(homedir, '.khy', '.location.json');
    const obj = JSON.parse(fs.readFileSync(pointerFile, 'utf-8'));
    if (obj && typeof obj === 'object' && obj.dataHome) {
      return String(obj.dataHome);
    }
  } catch {
    /* no/corrupt pointer → ignore */
  }
  return null;
}

/**
 * Resolve the backend loopback endpoint from dynamic sources only.
 * @returns {{ port: number, source: string } | null}
 */
function resolveBackendEndpoint(env = process.env) {
  const homedir = os.homedir();
  const dataHomes = [];
  if (env.KHY_DATA_HOME) {
    dataHomes.push(env.KHY_DATA_HOME);
  }
  const pointerHome = _readPointerDataHome(env, homedir);
  if (pointerHome) {
    dataHomes.push(pointerHome);
  }
  dataHomes.push(path.join(homedir, '.khy'));
  dataHomes.push(path.join(homedir, '.khyquant'));

  for (const dataHome of dataHomes) {
    const port = _readApiPortFromRuntime(dataHome);
    if (port) {
      return { port, source: `ai_manage_runtime.json (${dataHome})` };
    }
  }

  const envPort = _parsePort(env.KHY_DAEMON_PORT || env.AI_MGMT_PORT);
  if (envPort) {
    const sourceVar = env.KHY_DAEMON_PORT ? 'KHY_DAEMON_PORT' : 'AI_MGMT_PORT';
    return { port: envPort, source: `环境变量 ${sourceVar}` };
  }
  return null;
}

// ── Check 1: backend WebSocket connectivity ──────────────────────────────────

// Minimal TCP reachability probe — used only when the `ws` package cannot be
// loaded (degraded mode); a full WS handshake needs frame codecs we must not
// reimplement here.
function _probeTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const net = require('net');
    const socket = net.createConnection({ host, port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function checkBackendWebSocket({ onProgress } = {}) {
  const notify = typeof onProgress === 'function' ? onProgress : () => {};
  const label = '后端 WebSocket 连通性';

  const endpoint = resolveBackendEndpoint(process.env);
  if (!endpoint) {
    return {
      category: CATEGORY,
      label,
      ok: false,
      detail:
        '后端服务未运行（未发现 ai_manage_runtime.json，且未设置 KHY_DAEMON_PORT / AI_MGMT_PORT），请先执行 khy server start',
      level: 'warn',
      summary: '后端服务未运行，Web/API 通道不可用',
      fix: '先执行 khy server start 启动后端，再重跑 khy doctor',
    };
  }

  const { port, source } = endpoint;
  const target = `127.0.0.1:${port}`;
  notify(`连接后端 WebSocket (${target})，等待 auth_ok（第 1/1 次）...`);

  let WebSocketCtor = null;
  try {
    WebSocketCtor = require('ws');
  } catch {
    /* ws unavailable → degraded TCP probe below */
  }

  if (!WebSocketCtor) {
    const reachable = await _probeTcp('127.0.0.1', port, PROBE_TIMEOUT_MS);
    return {
      category: CATEGORY,
      label,
      ok: reachable,
      detail: reachable
        ? `端口可达 (${target}，来源: ${source})，但 ws 依赖缺失，仅完成 TCP 探测（未验证 auth_ok），可运行 npm install 补齐`
        : `后端服务未运行（端口 ${port} 不可达，来源: ${source}），请先执行 khy server start`,
      level: 'warn',
      summary: reachable
        ? `端口 ${port} 可达，但 ws 缺失未验证认证`
        : `后端端口 ${port} 不可达，服务未运行`,
      ...(reachable
        ? { fix: '运行 npm install 补齐 ws 依赖后重跑，即可验证完整握手' }
        : { fix: '先执行 khy server start 启动后端，再重跑 khy doctor' }),
    };
  }

  return new Promise((resolve) => {
    let settled = false;
    let ws = null;
    let timer = null;

    const finish = (check) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      try {
        if (ws) {
          ws.close();
        }
      } catch {
        /* best effort */
      }
      try {
        if (ws) {
          ws.terminate();
        }
      } catch {
        /* best effort */
      }
      resolve({ category: CATEGORY, label, ...check });
    };

    timer = setTimeout(() => {
      finish({
        ok: false,
        detail: `连接后端 WebSocket 超时 (${target}，>${Math.round(PROBE_TIMEOUT_MS / 1000)}s，来源: ${source})，请确认后端状态或执行 khy server start`,
        level: 'warn',
        summary: `连接 ${target} 超时（>${Math.round(PROBE_TIMEOUT_MS / 1000)}s）`,
        fix: '运行 khy server status 确认后端状态，或重启后端后重跑 khy doctor',
      });
    }, PROBE_TIMEOUT_MS);

    try {
      ws = new WebSocketCtor(`ws://${target}/ws`);
    } catch (err) {
      finish({
        ok: false,
        detail: `无法创建 WebSocket 连接 (${target}): ${String(err?.message || err).slice(0, 120)}`,
        level: 'warn',
        summary: `无法建立到 ${target} 的 WebSocket 连接`,
        fix: '运行 khy server start 重启后端；若仍失败执行 khy proxy status 排除代理劫持',
      });
      return;
    }

    ws.on('open', () => {
      // Same auth flow as the frontend: send { type: 'auth', token } and
      // wait for the server's auth_ok / auth_error verdict.
      try {
        ws.send(
          JSON.stringify({
            type: 'auth',
            token: String(process.env.AI_MGMT_AUTH_TOKEN || ''),
          })
        );
      } catch (err) {
        finish({
          ok: false,
          detail: `WebSocket 已连接 (${target}) 但发送认证消息失败: ${String(err?.message || err).slice(0, 120)}`,
          level: 'warn',
          summary: `已连接 ${target} 但认证消息发送失败`,
          fix: '重跑 khy doctor；若持续失败执行 khy server start --restart 重启后端',
        });
      }
    });

    ws.on('message', (raw) => {
      let msg = null;
      try {
        msg = JSON.parse(String(raw || '{}'));
      } catch {
        return;
      }
      const type = String(msg?.type || '');
      if (type === 'auth_ok') {
        finish({
          ok: true,
          detail: `已连接 ${target} 并收到 auth_ok（端口来源: ${source}）`,
          level: 'info',
          summary: `后端 WebSocket 已连通并完成认证（${target}）`,
        });
      } else if (type === 'auth_error' || type === 'auth_failed') {
        // Server's free-form English message used to bleed into detail
        // mid-word ("for trusted-LAN p"); keep detail Chinese + actionable
        // and park the raw verdict text in note (--verbose only).
        const rawVerdict = String(msg?.message || '')
          .replace(/\s+/g, ' ')
          .trim();
        finish({
          ok: false,
          detail: `WebSocket 可达 (${target}) 但认证被拒：token 缺失或不正确（来源: ${source}）`,
          level: 'warn',
          summary: `后端可达但认证被拒（${target}）`,
          fix: '在 .env 或环境变量设置 AI_MGMT_AUTH_TOKEN 为后端同值 token 后重跑 khy doctor',
          ...(rawVerdict ? { note: `服务端原始返回: ${rawVerdict}` } : {}),
        });
      }
      // Other message types: keep waiting until auth verdict or timeout.
    });

    ws.on('error', (err) => {
      const code = String(err?.code || '');
      const refused = code === 'ECONNREFUSED';
      finish({
        ok: false,
        detail: refused
          ? `后端服务未运行（端口 ${port} 不可达，来源: ${source}），请先执行 khy server start`
          : `连接后端 WebSocket 失败 (${target}): ${String(err?.message || err).slice(0, 120)}`,
        level: 'warn',
        summary: refused
          ? `后端端口 ${port} 不可达，服务未运行`
          : `连接后端 WebSocket 失败（${target}）`,
        fix: refused
          ? '先执行 khy server start 启动后端，再重跑 khy doctor'
          : '运行 khy server status 确认后端状态；若端口来源不对，检查 ai_manage_runtime.json 或 KHY_DAEMON_PORT',
      });
    });
  });
}

// ── Check 2: proxy connectivity ──────────────────────────────────────────────

async function checkProxyConnectivity({ onProgress } = {}) {
  const notify = typeof onProgress === 'function' ? onProgress : () => {};
  const label = '代理连接测试';

  // Reuse proxyConfigService for both config loading and TCP probing —
  // no duplicated proxy.json parsing here.
  let proxyService = null;
  try {
    proxyService = require('../../services/proxyConfigService');
  } catch (err) {
    return {
      category: CATEGORY,
      label,
      ok: false,
      detail: `无法加载代理配置服务: ${String(err?.message || err).slice(0, 120)}`,
      level: 'warn',
      summary: '代理配置服务加载失败，无法测试代理',
      fix: '运行 npm install 补齐依赖后重跑；仍失败看 khy proxy status 是否可用',
    };
  }

  const config = proxyService.loadConfig();
  if (!config || config.enabled !== true) {
    return {
      category: CATEGORY,
      label,
      ok: true,
      detail: '已跳过（未配置代理）',
      level: 'info',
      summary: '未配置共享代理，本项跳过',
    };
  }

  const target = `${config.host}:${config.port}`;
  notify(`测试代理连接 (${config.type} ${target})，执行 TCP 可达性探测（第 1/1 次）...`);
  const reachable = await proxyService.testProxy(config.host, config.port, PROBE_TIMEOUT_MS);
  return {
    category: CATEGORY,
    label,
    ok: reachable,
    detail: reachable
      ? `代理可达 (${config.type} ${target})`
      : `代理不可达 (${config.type} ${target})，请确认代理服务已启动，或执行 khy proxy status 查看配置`,
    level: reachable ? 'info' : 'warn',
    summary: reachable ? `共享代理可达（${config.type} ${target}）` : `共享代理不可达（${target}）`,
    fix: reachable
      ? undefined
      : '启动本地代理服务，或运行 khy proxy status 检查/关闭代理配置',
  };
}

// ── Check 3: per-provider proxy connectivity ─────────────────────────────────
// Providers registered in custom_providers.json may carry their own `proxy`
// field; multiFreeService then routes that provider's traffic through it
// instead of the shared agent. Check 2 only probes the *shared* proxy, so a
// stopped local proxy client behind a per-provider endpoint stayed invisible
// to doctor until every model call failed with ECONNREFUSED (BUG-005).
// Probe those endpoints too, deduplicated by URL.

// Default port per proxy scheme, applied only when the configured URL omits
// one. These are protocol defaults, not endpoint configuration — the endpoint
// itself always comes from the provider's own `proxy` value.
const PROXY_SCHEME_PORTS = {
  'http:': 80,
  'https:': 443,
  'socks:': 1080,
  'socks4:': 1080,
  'socks5:': 1080,
};

// Parse a proxy URL into a probe target. Returns null when unusable so the
// caller can report it instead of probing a guessed address.
function _parseProxyEndpoint(proxyUrl) {
  try {
    const u = new URL(String(proxyUrl || '').trim());
    const port = _parsePort(u.port) || PROXY_SCHEME_PORTS[u.protocol] || null;
    if (!u.hostname || !port) {
      return null;
    }
    // Only hostname/port are kept: a proxy URL may embed credentials and those
    // must never reach the doctor report.
    return { host: u.hostname, port, label: `${u.hostname}:${port}` };
  } catch {
    return null;
  }
}

async function checkProviderProxies({ onProgress } = {}) {
  const notify = typeof onProgress === 'function' ? onProgress : () => {};
  const label = 'Provider 独立代理';

  // Reuse the provider registry and proxyConfigService's TCP probe — no
  // duplicated custom_providers.json parsing or socket logic here.
  let registry = null;
  let proxyService = null;
  try {
    registry = require('../../services/customProviderRegistry');
    proxyService = require('../../services/proxyConfigService');
  } catch (err) {
    return {
      category: CATEGORY,
      label,
      ok: false,
      detail: `无法加载 provider 代理配置: ${String(err?.message || err).slice(0, 120)}`,
      level: 'warn',
      summary: 'provider 代理配置加载失败，无法探测',
      fix: '运行 npm install 补齐依赖后重跑 khy doctor',
    };
  }

  let providers = [];
  try {
    providers = registry.listProviders() || [];
  } catch (err) {
    return {
      category: CATEGORY,
      label,
      ok: false,
      detail: `读取 provider 注册表失败: ${String(err?.message || err).slice(0, 120)}`,
      level: 'warn',
      summary: 'provider 注册表读取失败，无法探测',
      fix: '检查 ~/.khyquant/custom_providers.json 是否损坏，修复后重跑 khy doctor',
    };
  }

  // Group provider names by endpoint so one dead port is reported once even
  // when several providers share it.
  const byEndpoint = new Map();
  const invalid = [];
  for (const provider of providers) {
    const raw = String(provider?.proxy || '').trim();
    if (!raw) {
      continue;
    }
    const name = String(provider?.poolKey || provider?.name || 'provider');
    const endpoint = _parseProxyEndpoint(raw);
    if (!endpoint) {
      invalid.push(name);
      continue;
    }
    const existing = byEndpoint.get(endpoint.label);
    if (existing) {
      existing.names.push(name);
    } else {
      byEndpoint.set(endpoint.label, { ...endpoint, names: [name] });
    }
  }

  if (byEndpoint.size === 0 && invalid.length === 0) {
    return {
      category: CATEGORY,
      label,
      ok: true,
      detail: '已跳过（无 provider 配置独立代理）',
      level: 'info',
      summary: '无 provider 配置独立代理，本项跳过',
    };
  }

  const targets = [...byEndpoint.values()];
  let dead = [];
  if (targets.length > 0) {
    notify(
      `测试 provider 独立代理可达性（${targets.length} 个端点），执行 TCP 探测（第 1/1 次）...`
    );
    const results = await Promise.all(
      targets.map((t) => proxyService.testProxy(t.host, t.port, PROBE_TIMEOUT_MS))
    );
    dead = targets.filter((_, i) => !results[i]);
  }

  const problems = [];
  if (dead.length > 0) {
    problems.push(
      `代理未监听: ${dead.map((d) => `${d.label}（${d.names.join('、')}）`).join('；')}` +
        '，这些 provider 的请求将回退直连；请启动对应本地代理，或清除其 proxy 配置'
    );
  }
  if (invalid.length > 0) {
    problems.push(`代理地址无法解析: ${invalid.join('、')}，请检查其 proxy 字段格式`);
  }

  if (problems.length === 0) {
    return {
      category: CATEGORY,
      label,
      ok: true,
      detail: `${targets.length} 个端点全部可达（${targets.map((t) => t.label).join('、')}）`,
      level: 'info',
      summary: `${targets.length} 个 provider 独立代理端点全部可达`,
    };
  }
  return {
    category: CATEGORY,
    label,
    ok: false,
    detail: problems.join('；'),
    level: 'warn',
    summary: dead.length > 0 ? `${dead.length} 个 provider 独立代理不可达` : 'provider 代理地址格式错误',
    fix:
      dead.length > 0
        ? '启动对应的本地代理服务，或用 khy gateway config 清除该 provider 的 proxy 配置'
        : '修正 custom_providers.json 中对应 provider 的 proxy 字段格式（需含主机与端口）',
  };
}

// ── Entry: run all checks ────────────────────────────────────────────────────

/**
 * Run all connectivity checks in parallel; each item matches the shape of
 * runDoctorChecks() entries: { category, label, ok, detail, level }.
 */
async function runConnectivityChecks({ onProgress } = {}) {
  return Promise.all([
    checkBackendWebSocket({ onProgress }),
    checkProxyConnectivity({ onProgress }),
    checkProviderProxies({ onProgress }),
  ]);
}

module.exports = {
  runConnectivityChecks,
  checkBackendWebSocket,
  checkProxyConnectivity,
  checkProviderProxies,
  resolveBackendEndpoint,
};
