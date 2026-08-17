'use strict';

/**
 * trajectoryStatsStore.js — Trajectory-driven model routing statistics.
 *
 * WHY THIS EXISTS:
 *   khy-os's multi-vendor gateway gives it access to multiple model providers.
 *   Combined with the delivery gate (which measures whether a task actually
 *   succeeded), this creates a self-improving quality loop: record which
 *   (task-type, model) pairs pass the delivery gate, and route future tasks
 *   to the historically best-performing model. No single-vendor competitor
 *   can replicate this — they lack both the multi-vendor access AND the
 *   delivery gate to measure quality.
 *
 * WHAT IT DOES:
 *   - record(cwd, stats): append a delivery outcome to the project + global stores
 *   - getStatsForTaskType(taskType, scope): aggregated pass-rate per model
 *   - recommendModel(taskType, cwd): pick the best historical model for a task type
 *
 * ROLLOUT (PROCESS-008):
 *   S1 observer — records stats and emits recommendations, does NOT change
 *   actual routing. Graduates to S2 (auto-route + override) then S3 (auto-route).
 *   Gate: KHY_TRAJECTORY_ROUTING (default on). Stage: KHY_TRAJECTORY_ROUTING_STAGE.
 *
 * Storage:
 *   - Project-scoped: ~/.khyquant/projects/<hash>/trajectory-stats.json
 *   - Global:         ~/.khyquant/trajectory-stats-global.json
 *   Project takes precedence (learned on THIS codebase is more relevant).
 *
 * Contract: fail-soft everywhere — IO errors never throw, just return empty
 * results. The trajectory loop is a quality enhancer, never a blocker.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const _FALSY = new Set(['0', 'false', 'off', 'no']);
const MAX_RECORDS_PER_FILE = 1000;
const MIN_SAMPLES_FOR_ROUTING = 10;
const SIGNIFICANT_ADVANTAGE_THRESHOLD = 0.15; // 15% better than default

// ── Gate ────────────────────────────────────────────────────────────────

function isEnabled(env = process.env) {
  const raw = String((env && env.KHY_TRAJECTORY_ROUTING) || 'true')
    .trim()
    .toLowerCase();
  return !_FALSY.has(raw);
}

function getStage(env = process.env) {
  const raw = String((env && env.KHY_TRAJECTORY_ROUTING_STAGE) || 'S1')
    .trim()
    .toUpperCase();
  if (raw === 'S2' || raw === 'S3') {
    return raw;
  }
  return 'S1';
}

// ── Path resolution ────────────────────────────────────────────────────

function _hashPath(dirPath) {
  return crypto.createHash('sha256').update(dirPath).digest('hex').slice(0, 16);
}

function _projectsDir() {
  try {
    const dataHome = require('../utils/dataHome');
    if (typeof dataHome.isPortableDeployment === 'function' && dataHome.isPortableDeployment()) {
      return dataHome.getProjectDataDir('projects');
    }
  } catch {
    /* fall through */
  }
  return path.join(os.homedir(), '.khyquant', 'projects');
}

function _projectStatsPath(cwd) {
  const hash = _hashPath(path.resolve(cwd || process.cwd()));
  return path.join(_projectsDir(), hash, 'trajectory-stats.json');
}

function _globalStatsPath() {
  return path.join(os.homedir(), '.khyquant', 'trajectory-stats-global.json');
}

// ── IO helpers ─────────────────────────────────────────────────────────

function _readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function _writeJson(filePath, data) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch {
    /* best-effort — never throw */
  }
}

// ── Core API ───────────────────────────────────────────────────────────

/**
 * Record a delivery outcome for a (taskType, model) pair.
 * Writes to both project-scoped and global stores.
 *
 * @param {string} cwd - Project working directory
 * @param {object} stats
 * @param {string} stats.taskType - Intent mode (coding/analyze/goal/ultrawork/conversation)
 * @param {string} stats.model - Model ID used
 * @param {string} stats.vendor - Vendor family
 * @param {string} stats.deliveryVerdict - pass/warn/fail
 * @param {boolean} stats.verificationPassed - Did the verification gate pass?
 * @param {number} stats.iterations - Tool loop iterations
 * @param {number} stats.durationMs - Total duration
 * @param {boolean} stats.success - Overall success
 * @param {string} [stats.crossModelVerified] - Whether cross-model verify ran
 * @returns {boolean} true if recorded
 */
function record(cwd, stats) {
  if (!isEnabled()) {
    return false;
  }
  const entry = {
    taskType: String(stats.taskType || 'unknown'),
    model: String(stats.model || ''),
    vendor: String(stats.vendor || ''),
    deliveryVerdict: String(stats.deliveryVerdict || ''),
    verificationPassed: !!stats.verificationPassed,
    iterations: Number(stats.iterations || 0),
    durationMs: Number(stats.durationMs || 0),
    success: !!stats.success,
    crossModelVerified: !!stats.crossModelVerified,
    timestamp: new Date().toISOString(),
  };

  // Append to project-scoped store
  const projPath = _projectStatsPath(cwd);
  const projData = _readJson(projPath);
  projData.push(entry);
  // Cap to prevent unbounded growth (keep most recent)
  const projTrimmed = projData.slice(-MAX_RECORDS_PER_FILE);
  _writeJson(projPath, projTrimmed);

  // Append to global store
  const globalPath = _globalStatsPath();
  const globalData = _readJson(globalPath);
  globalData.push(entry);
  const globalTrimmed = globalData.slice(-MAX_RECORDS_PER_FILE);
  _writeJson(globalPath, globalTrimmed);

  return true;
}

/**
 * Get aggregated statistics for a task type, grouped by model.
 *
 * @param {string} taskType
 * @param {string} scope - 'project' | 'global' | 'both' (default 'both')
 * @param {string} [cwd] - Required for scope='project' or 'both'
 * @returns {Array<{model, vendor, deliveryPassRate, sampleCount, avgIterations, avgDurationMs}>}
 */
function getStatsForTaskType(taskType, scope = 'both', cwd) {
  const results = new Map(); // model → aggregated

  function _aggregate(records) {
    for (const r of records) {
      if (r.taskType !== taskType || !r.model) {
        continue;
      }
      const key = r.model;
      if (!results.has(key)) {
        results.set(key, {
          model: r.model,
          vendor: r.vendor || '',
          passCount: 0,
          totalCount: 0,
          totalIterations: 0,
          totalDurationMs: 0,
        });
      }
      const agg = results.get(key);
      agg.totalCount += 1;
      if (r.success || r.deliveryVerdict === 'pass') {
        agg.passCount += 1;
      }
      agg.totalIterations += Number(r.iterations || 0);
      agg.totalDurationMs += Number(r.durationMs || 0);
    }
  }

  if (scope === 'project' || scope === 'both') {
    _aggregate(_readJson(_projectStatsPath(cwd)));
  }
  if (scope === 'global' || scope === 'both') {
    // Deduplicate: global may contain the same records as project
    // (they're written to both). For 'both' scope, project records take
    // priority — they're already aggregated above, so global is only
    // consulted when scope is 'global' or project had zero results.
    if (scope === 'global' || results.size === 0) {
      _aggregate(_readJson(_globalStatsPath()));
    }
  }

  return [...results.values()].map((agg) => ({
    model: agg.model,
    vendor: agg.vendor,
    deliveryPassRate: agg.totalCount > 0 ? agg.passCount / agg.totalCount : 0,
    sampleCount: agg.totalCount,
    avgIterations: agg.totalCount > 0 ? Math.round(agg.totalIterations / agg.totalCount) : 0,
    avgDurationMs: agg.totalCount > 0 ? Math.round(agg.totalDurationMs / agg.totalCount) : 0,
  }));
}

/**
 * Recommend the best model for a task type based on historical delivery outcomes.
 *
 * @param {string} taskType
 * @param {string} [cwd]
 * @returns {{ recommended: boolean, model: string, vendor: string, passRate: number, sampleCount: number, reason: string } | null}
 */
function recommendModel(taskType, cwd) {
  if (!isEnabled()) {
    return null;
  }
  const stats = getStatsForTaskType(taskType, 'both', cwd);
  if (stats.length === 0) {
    return null;
  }

  // Sort by delivery pass rate descending, then by sample count (more samples = more confident)
  const sorted = stats
    .filter((s) => s.sampleCount >= MIN_SAMPLES_FOR_ROUTING)
    .sort((a, b) => {
      if (b.deliveryPassRate !== a.deliveryPassRate) {
        return b.deliveryPassRate - a.deliveryPassRate;
      }
      return b.sampleCount - a.sampleCount;
    });

  if (sorted.length === 0) {
    return null;
  }

  const best = sorted[0];
  const others = sorted.slice(1);
  const secondBest = others[0];

  // Only recommend if the best is significantly better than alternatives
  if (
    secondBest &&
    best.deliveryPassRate - secondBest.deliveryPassRate < SIGNIFICANT_ADVANTAGE_THRESHOLD
  ) {
    // No significant advantage — don't recommend
    return null;
  }

  return {
    recommended: true,
    model: best.model,
    vendor: best.vendor,
    passRate: best.deliveryPassRate,
    sampleCount: best.sampleCount,
    reason: `${best.model} 在「${taskType}」任务上交付通过率 ${Math.round(best.deliveryPassRate * 100)}%（${best.sampleCount} 次样本）`,
    stage: getStage(),
  };
}

module.exports = {
  isEnabled,
  getStage,
  record,
  getStatsForTaskType,
  recommendModel,
  // Constants for testing
  MIN_SAMPLES_FOR_ROUTING,
  MAX_RECORDS_PER_FILE,
};
