'use strict';

/**
 * perfTier — 静态硬件档位（full / lean / minimal）的唯一定档处。
 *
 * 定档只用两条**不会抖动**的静态读数：os.availableParallelism() 与 os.totalmem()
 * （实测 0.009ms）。freemem **不参与** —— 本机 freemem 实测只剩约 6%，把它写进
 * 判据会把基准机（8 核 / 16GB）误判成 lean（[DESIGN-PERF-007] T1）。同一静态签名
 * `platform|arch|totalRamMB|cores` 永远得同一档：决策是签名的纯函数，没有时间维度，
 * 所以**无 TTL**、相邻启动不抖动。任何异常 fail-open 到 full。
 *
 * 档位的效果是「写既有 env 键」（不新开 KHY_* 开关 —— check-tui-gates 已超标）：
 *   full    零写入 —— 今天的高档机行为逐字节不变
 *   lean    LOW_POWER 伞 + 心跳显式钉 1000ms + 预热增强段延迟 2500ms
 *   minimal 再加「预热只跑 core 段」+ perf 条目清理周期 5000ms
 *
 * 用户偏好走既有的 ~/.khyquant/tui.json `perf.tier`（'auto'|'full'|'lean'|'minimal'）。
 * 由调用方读好传进来：本模块在 services 层，不反向依赖 cli/tui（层向守卫）。
 */

const os = require('os');

const TIERS = ['full', 'lean', 'minimal'];

// 阈值一次定死（改它要重新评估档位稳定性）。
const LEAN_MAX_CORES = 4;
const LEAN_MAX_RAM_MB = 8192;
const MINIMAL_MAX_CORES = 2;
const MINIMAL_MAX_RAM_MB = 4096;

// 档位 → 既有 env 键。全部是 TUI 树里**已在读**的键（perfTunables /
// useQueryBridge / perfEntryReaper），其中 KHY_HEARTBEAT_MS 的 1000 是给
// LOW_POWER 伞（会把默认放宽到 2000）钉回默认粒度：档位降的是渲染/后台开销，
// 不是把「已 30s」的读数粒度变粗（[DESIGN-ARCH-102] §5 心跳语义）。
const TIER_ENV = Object.freeze({
  full: Object.freeze({}),
  lean: Object.freeze({
    KHY_TUI_LOW_POWER: '1',
    KHY_HEARTBEAT_MS: '1000',
    KHY_TUI_PREWARM_ENHANCED_DELAY_MS: '2500',
  }),
  minimal: Object.freeze({
    KHY_TUI_LOW_POWER: '1',
    KHY_HEARTBEAT_MS: '1000',
    KHY_TUI_PREWARM_ENHANCED_DELAY_MS: '2500',
    KHY_TUI_PREWARM: 'core',
    KHY_PERF_ENTRY_REAP_MS: '5000',
  }),
});

/** @returns {'full'|'lean'|'minimal'|null} 合法档位名，其余一律 null。 */
function normalizeTier(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  return TIERS.includes(v) ? v : null;
}

function _ramGB(ramMB) {
  return `${(ramMB / 1024).toFixed(1)}GB`;
}

/** 静态读数；任一读不到就抛（由调用方 fail-open）。 */
function _readings() {
  return {
    platform: process.platform,
    arch: process.arch,
    cores: os.availableParallelism(),
    totalRamMB: Math.round(os.totalmem() / (1024 * 1024)),
  };
}

/**
 * 定档。纯函数（除 os 读数外无副作用、无 IO）。
 *
 * @param {{override?: string}} [options] override = 用户偏好（tui.json perf.tier），
 *   非合法档位/缺省 → 走静态定档。
 * @returns {{tier: string, source: 'user'|'static'|'fail-open', reason: string,
 *   signature: string|null, readings: object|null}}
 */
function detectTier(options = {}) {
  try {
    const override = normalizeTier(options && options.override);
    if (override) {
      return {
        tier: override,
        source: 'user',
        reason: '用户偏好 ~/.khyquant/tui.json perf.tier',
        signature: null,
        readings: null,
      };
    }
    const r = _readings();
    const signature = `${r.platform}|${r.arch}|${r.totalRamMB}|${r.cores}`;
    const readingsText = `${r.cores} 核 / ${_ramGB(r.totalRamMB)} 内存`;

    if (r.cores <= MINIMAL_MAX_CORES || r.totalRamMB <= MINIMAL_MAX_RAM_MB) {
      return {
        tier: 'minimal',
        source: 'static',
        reason: `静态读数 ${readingsText} 命中 minimal 阈值（≤${MINIMAL_MAX_CORES} 核或 ≤${MINIMAL_MAX_RAM_MB / 1024}GB）`,
        signature,
        readings: r,
      };
    }
    if (r.cores <= LEAN_MAX_CORES || r.totalRamMB <= LEAN_MAX_RAM_MB) {
      return {
        tier: 'lean',
        source: 'static',
        reason: `静态读数 ${readingsText} 命中 lean 阈值（≤${LEAN_MAX_CORES} 核或 ≤${LEAN_MAX_RAM_MB / 1024}GB）`,
        signature,
        readings: r,
      };
    }
    return {
      tier: 'full',
      source: 'static',
      reason: `静态读数 ${readingsText} 高于 lean 阈值`,
      signature,
      readings: r,
    };
  } catch (e) {
    return {
      tier: 'full',
      source: 'fail-open',
      reason: `静态读数失败（${(e && e.message) || String(e)}），按 full 处理`,
      signature: null,
      readings: null,
    };
  }
}

/**
 * 把档位写进 env —— **只写没被用户显式设过的键**（`=== undefined` 守卫，
 * 不是 falsy：用户显式 KHY_TUI_LOW_POWER=0 / KHY_HEARTBEAT_MS=0 必须原样保留）。
 * full 档表为空 ⇒ 零写入。
 *
 * @param {object} env 目标（一般 process.env）
 * @param {string} tier
 * @returns {string[]} 本次实际写入的键名（供调用方留痕/测试断言）
 */
function applyTierEnv(env, tier) {
  const table = TIER_ENV[normalizeTier(tier)] || TIER_ENV.full;
  const written = [];
  for (const [key, value] of Object.entries(table)) {
    if (env[key] === undefined) {
      env[key] = value;
      written.push(key);
    }
  }
  return written;
}

/** 一行展示串（BootScreen 尾部 / `/hardware` 共用同一口径）。 */
function describeTier(result) {
  const r = result && result.tier ? result : detectTier();
  return `性能档位 ${r.tier} · ${r.reason}`;
}

module.exports = { TIERS, TIER_ENV, normalizeTier, detectTier, applyTierEnv, describeTier };