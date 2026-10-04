/**
 * serviceRegistry.js — Lazy-loaded centralized service discovery
 *
 * Optional layer over scattered require() calls that enables health
 * checks, introspection, and future dependency injection. Instances
 * are created on first access and cached for singleton behavior.
 *
 * @module services/serviceRegistry
 */
'use strict';

// ── Imports ──

const path = require('path');

// ── Registry state ─────────────────────────────────────────────────

const _entries = new Map(); // name → { factory, instance, category, description, loaded }

// ── Public API ─────────────────────────────────────────────────────

/**
 * Register a service.
 *
 * @param {string} name - Unique service name
 * @param {function} factory - () => require('./someService') — lazy loader
 * @param {object} [meta]
 * @param {string} [meta.category] - Service category (e.g., 'core', 'gateway', 'cli')
 * @param {string} [meta.description] - Human-readable description
 */
function register(name, factory, meta = {}) {
  if (!name || typeof name !== 'string') {
    throw new Error('Service name must be a non-empty string');
  }
  if (typeof factory !== 'function') {
    throw new Error(`Service "${name}": factory must be a function`);
  }

  _entries.set(name, {
    factory,
    instance: null,
    category: meta.category || 'general',
    description: meta.description || '',
    loaded: false,
    error: null,
  });
}

/**
 * Get a service instance (lazy-loaded on first access).
 *
 * @param {string} name
 * @returns {*} The service module/instance
 * @throws {Error} If service is not registered or fails to load
 */
function get(name) {
  const entry = _entries.get(name);
  if (!entry) {
    throw new Error(`Service not registered: "${name}"`);
  }

  if (!entry.loaded) {
    try {
      entry.instance = entry.factory();
      entry.loaded = true;
      entry.error = null;
    } catch (err) {
      entry.error = err.message;
      throw new Error(`Failed to load service "${name}": ${err.message}`);
    }
  }

  return entry.instance;
}

/**
 * Check if a service is registered.
 * @param {string} name
 * @returns {boolean}
 */
function has(name) {
  return _entries.has(name);
}

/**
 * Get services by category.
 * @param {string} category
 * @returns {Map<string, object>}
 */
function getByCategory(category) {
  const result = new Map();
  for (const [name, entry] of _entries) {
    if (entry.category === category) {
      result.set(name, entry);
    }
  }
  return result;
}

/**
 * List all registered services with metadata.
 * @returns {Array<{name, category, description, loaded, error}>}
 */
function list() {
  return [..._entries.entries()].map(([name, entry]) => ({
    name,
    category: entry.category,
    description: entry.description,
    loaded: entry.loaded,
    error: entry.error,
  }));
}

/**
 * Run a health check on all loaded services.
 * Services that expose a healthCheck() method will be tested.
 *
 * @returns {Array<{name, healthy, error?, latency?}>}
 */
async function healthCheck() {
  const results = [];

  for (const [name, entry] of _entries) {
    if (!entry.loaded || !entry.instance) {
      results.push({ name, healthy: null, note: 'not loaded' });
      continue;
    }

    const start = Date.now();

    // Check if service has a health check method
    const svc = entry.instance;
    if (typeof svc.healthCheck === 'function') {
      try {
        await svc.healthCheck();
        results.push({ name, healthy: true, latency: Date.now() - start });
      } catch (err) {
        results.push({ name, healthy: false, error: err.message, latency: Date.now() - start });
      }
    } else if (typeof svc.getStatus === 'function') {
      // Fallback: try getStatus()
      try {
        const status = svc.getStatus();
        results.push({
          name,
          healthy: status.available !== false,
          latency: Date.now() - start,
        });
      } catch (err) {
        results.push({ name, healthy: false, error: err.message });
      }
    } else {
      // Service is loaded but has no health check — assume healthy
      results.push({ name, healthy: true, note: 'no health check method' });
    }
  }

  return results;
}

/**
 * Get the count of registered services.
 * @returns {{ total: number, loaded: number, errored: number }}
 */
function stats() {
  let loaded = 0,
    errored = 0;
  for (const entry of _entries.values()) {
    if (entry.loaded) {
      loaded++;
    }
    if (entry.error) {
      errored++;
    }
  }
  return { total: _entries.size, loaded, errored };
}

// ── Auto-register known services ───────────────────────────────────
// Only registers factories — nothing is loaded until get() is called.

function _autoRegister() {
  const svcDir = path.join(__dirname);

  const known = [
    [
      'aiGateway',
      () => require('./gateway/aiGateway'),
      { category: 'gateway', description: 'AI 请求路由（多适配器级联）' },
    ],
    [
      'multiFreeService',
      () => require('./multiFreeService'),
      { category: 'core', description: '免费额度 AI 供应商聚合' },
    ],
    [
      'strategyEngine',
      () => require('./strategyEngine'),
      { category: 'core', description: '交易策略执行引擎' },
    ],
    [
      'backtestEngine',
      () => require('./backtestEngine'),
      { category: 'core', description: '策略回测引擎' },
    ],
    [
      'marketDataService',
      () => require('./marketDataService'),
      { category: 'data', description: '行情数据访问层' },
    ],
    [
      'klineDataService',
      () => require('./klineDataService'),
      { category: 'data', description: 'K 线数据服务' },
    ],
    [
      'akshareDataService',
      () => require('./akshareDataService'),
      { category: 'data', description: 'AKShare 数据集成' },
    ],
    [
      'toolCalling',
      () => require('./toolCalling'),
      { category: 'core', description: '带权限体系的工具执行' },
    ],
    [
      'permissionStore',
      () => require('./permissionStore'),
      { category: 'security', description: '按档位的权限管理' },
    ],
    [
      'auditLog',
      () => require('../middleware/auditLog'),
      { category: 'security', description: '工具执行审计轨迹' },
    ],
    [
      'toolSandbox',
      () => require('./toolSandbox'),
      { category: 'security', description: '沙箱化代码/命令执行' },
    ],
    [
      'toolUseLoop',
      () => require('./toolUseLoop'),
      { category: 'core', description: 'AI ↔ 工具迭代执行循环' },
    ],
    [
      'agenticHarnessService',
      () => require('./agenticHarnessService'),
      { category: 'core', description: '统一的上下文/循环/技能/记忆运行时' },
    ],
    [
      'securityGuardService',
      () => require('./securityGuardService'),
      { category: 'security', description: '输入/输出安全扫描' },
    ],
    [
      'resourceGuard',
      () => require('./resourceGuard'),
      { category: 'security', description: '资源限制与安全执行' },
    ],
    [
      'baseSelfCheckService',
      () => require('./baseSelfCheckService'),
      { category: 'monitoring', description: '周期性底座可靠性自检循环' },
    ],
    [
      'webSearchService',
      () => require('./webSearchService'),
      { category: 'data', description: '网络搜索集成' },
    ],
    [
      'tradingAgentsService',
      () => require('./tradingAgentsService'),
      { category: 'core', description: '多智能体交易系统' },
    ],
    [
      'tokenUsageService',
      () => require('./tokenUsageService'),
      { category: 'monitoring', description: 'Token 用量统计' },
    ],
    [
      'growthService',
      () => require('./growthService'),
      { category: 'user', description: '用户增长与活跃度统计' },
    ],
    [
      'versionService',
      () => require('./versionService'),
      { category: 'system', description: '版本管理与更新' },
    ],
    [
      'cloudSync',
      () => require('./cloudSync'),
      { category: 'system', description: '云端数据同步' },
    ],
    // Bootstrap-level services (used early in startup, registering for unified health/discovery)
    [
      'hardwareProfileService',
      () => require('./hardwareProfileService'),
      { category: 'system', description: '硬件检测与模型推荐' },
    ],
    [
      'networkDetector',
      () => require('./networkDetector'),
      { category: 'system', description: '网络可用性与代理探测' },
    ],
    [
      'cacheService',
      () => require('./cacheService'),
      { category: 'core', description: '多级缓存（内存/Redis/文件）' },
    ],
    [
      'cleanupService',
      () => require('./cleanupService'),
      { category: 'system', description: '周期性数据与临时文件清理' },
    ],
    [
      'projectMemoryService',
      () => require('./projectMemoryService'),
      { category: 'core', description: '项目级持久记忆（khy.md）' },
    ],
    [
      'fileIntegrityService',
      () => require('./fileIntegrityService'),
      { category: 'security', description: '文件完整性校验（哈希校验和）' },
    ],
    [
      'adminService',
      () => require('./adminService'),
      { category: 'security', description: '管理员认证与用户管理' },
    ],
    [
      'skillLearningService',
      () => require('./skillLearningService'),
      { category: 'core', description: '技能用量统计与自动学习' },
    ],
  ];

  for (const [name, factory, meta] of known) {
    if (!_entries.has(name)) {
      _entries.set(name, {
        factory,
        instance: null,
        category: meta.category || 'general',
        description: meta.description || '',
        loaded: false,
        error: null,
      });
    }
  }
}

// Auto-register on module load
_autoRegister();

// Publish stats through the zero-dependency provider sink so low-level
// consumers (telemetry) can read service health without importing this module
// — inverts the telemetry → serviceRegistry edge out of the giant SCC
// ([DESIGN-ARCH-051] §6.7).
require('./serviceStatsSink').setServiceStatsProvider(stats);

// ── Exports ────────────────────────────────────────────────────────

module.exports = {
  register,
  get,
  has,
  getByCategory,
  list,
  healthCheck,
  stats,
};
