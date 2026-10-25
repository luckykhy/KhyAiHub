'use strict';

/**
 * activeProviderSnapshot — `khy status` 的 Provider 行快照（跨进程磁盘缓存）。
 *
 * `khy status` 只打印一行 Provider，却经 `ai.getActiveProvider()` → `getGateway()`
 * 装载整个 aiGateway（20 个适配器模块，实测 257ms / 49 个子请求），连带 cli/ai 与
 * multiFreeService。单命令进程每次冷启，进程内缓存毫无用处 —— 与 PERF-006 的
 * git-hud 磁盘缓存同一格局：把**上一次真实解析的结果**落盘，TTL 内复用。
 *
 * 边界（读它就是读一份复本，不是读真源）：
 *   - 只服务冷单命令进程的展示行；TUI / 交互路径照旧实时解析（网关本来就要装载）；
 *   - 落盘时记下当时决定结果的 env 钉选（GATEWAY_PREFERRED_ADAPTER/MODEL）与
 *     网关 .env 指纹（canonical 路径的 mtimeMs+size），任一对不上 → 视为未命中，
 *     宁可多花钱不显示错行；
 *   - 写路径不变：任何一次完整解析都会刷新快照（见 ai.js getActiveProvider）；
 *   - 门控 KHY_PROVIDER_SNAPSHOT=0 → 两个函数都退化为不存在，逐字节回退旧行为。
 *
 * [DESIGN-PERF-007] W2-1。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TTL_MS = 300000; // 5 分钟,一次定死。原 30s 与 git-hud 同值,但 Provider 行
// 的事实源(网关配置 + env)变化频率远低于 git 状态 —— 隔一分钟连跑两条命令必走
// 未命中(未命中即拉 aiGateway 20 适配器 + multiFreeService + jsonwebtoken,
// 命中 84 模块 vs 未命中 373 模块)。正确性由下面的对账面兜底,不由短 TTL 兜底。

// 决定 Provider 行的 env 钉选。换了其中任何一个，旧快照就不再对账。
const PIN_ENV_KEYS = ['GATEWAY_PREFERRED_ADAPTER', 'GATEWAY_PREFERRED_MODEL'];

/**
 * 网关 .env 指纹(对账面的第二半)。PIN_ENV_KEYS 只盖两个键,配置文件里其它字节
 * 的变化(API key / base URL / 提供方清单)同样改写 Provider 行的依据,而它们
 * 不一定以同名 env 出现在 process.env 里。canonical 路径经
 * utils/resolveGatewayEnvPaths 解析 —— 与 gatewayEnvFile.js:22-25 同源。
 * 记 mtimeMs + size,任一不一致即视作未命中。文件不存在/不可 stat → null
 * (「对不上账宁可未命中」)。
 * @returns {{path: string, mtimeMs: number, size: number}|null}
 */
function _envFingerprint() {
  try {
    const resolved = require('../utils/resolveGatewayEnvPaths')();
    const canonical = resolved && resolved.canonicalPath;
    if (!canonical) return null;
    const st = fs.statSync(canonical);
    return { path: canonical, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/** 两个指纹是否一致(缺失一律归一为 null,老快照无 env 字段时按「都缺」比)。 */
function _sameFingerprint(a, b) {
  const an = a && typeof a === 'object' ? a : null;
  const bn = b && typeof b === 'object' ? b : null;
  if (!an || !bn) return an === bn;
  return (
    String(an.path) === String(bn.path) &&
    Number(an.mtimeMs) === Number(bn.mtimeMs) &&
    Number(an.size) === Number(bn.size)
  );
}

function _enabled(env) {
  try {
    return require('../services/flagRegistry').isFlagEnabled('KHY_PROVIDER_SNAPSHOT', env);
  } catch {
    const raw = env.KHY_PROVIDER_SNAPSHOT;
    if (raw === undefined || raw === null || raw === '') return true;
    return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
  }
}

function _pin(env) {
  const pin = {};
  for (const k of PIN_ENV_KEYS) pin[k] = String(env[k] || '');
  return pin;
}

function _cachePath() {
  // 与 hudRenderer 的 git-hud 缓存同一寻址链：KHY_DATA_HOME → ~/.khy/.location.json
  // 指针 → ~/.khy。Provider 是机器级事实（网关配置 + env），不按 cwd 分片。
  const env = process.env;
  if (env.KHY_DATA_HOME) {
    return path.join(env.KHY_DATA_HOME, 'cache', 'active-provider.json');
  }
  try {
    const pointerFile = env.KHY_LOCATION_FILE || path.join(os.homedir(), '.khy', '.location.json');
    const obj = JSON.parse(fs.readFileSync(pointerFile, 'utf8'));
    if (obj && typeof obj === 'object' && obj.dataHome) {
      return path.join(String(obj.dataHome), 'cache', 'active-provider.json');
    }
  } catch {
    /* 无指针 → 默认 home */
  }
  return path.join(os.homedir(), '.khy', 'cache', 'active-provider.json');
}

/**
 * 读一份仍然新鲜且对得上账的快照；未启用 / 缺失 / 过期 / env/.env 对不上 →
 * null（调用方走完整解析）。命中即返回并退出：不做后台刷新 —— 冷单命令进程
 * 活不到「装载完整 aiGateway 写回」那一刻，naive SWR 只会把「命中即退出」
 * 变成「等刷新才退出」。刷新责任完全由写路径承担（任何一次完整解析都会
 * remember，见 ai.js getActiveProvider）。
 * @param {object} [env] process.env
 * @returns {string|null}
 */
function readFresh(env = process.env) {
  if (!_enabled(env)) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(_cachePath(), 'utf8'));
    if (!obj || typeof obj.provider !== 'string' || !obj.provider) return null;
    if (Date.now() - Number(obj.t || 0) >= TTL_MS) return null;
    const want = _pin(env);
    const got = obj.pin || {};
    for (const k of PIN_ENV_KEYS) {
      if (String(got[k] || '') !== want[k]) return null;
    }
    if (!_sameFingerprint(obj.env, _envFingerprint())) return null;
    return obj.provider;
  } catch {
    return null;
  }
}

/**
 * 记一次完整解析的结果，供后续冷单命令进程复用。best-effort：写失败绝不影响调用方。
 * @param {string} text getActiveProvider() 的展示串
 * @param {object} [env] process.env
 */
function remember(text, env = process.env) {
  if (!_enabled(env)) return;
  if (typeof text !== 'string' || !text) return;
  try {
    const file = _cachePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        t: Date.now(),
        provider: text,
        pin: _pin(env),
        env: _envFingerprint(),
      })
    );
  } catch {
    /* best effort */
  }
}

module.exports = { readFresh, remember, TTL_MS };
