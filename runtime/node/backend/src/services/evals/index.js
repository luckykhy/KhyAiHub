'use strict';

/**
 * Evals service — model evaluation and testing.
 * Supports running evaluations against models with various metrics.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function _env(name) {
  return String(process.env[`KHY_EVAL_${name}`] || '').trim();
}

// ── Evaluation Result Types ──
const RESULT_TYPES = {
  accuracy: 'Accuracy Score',
  relevance: 'Relevance Score',
  coherence: 'Coherence Score',
  fluency: 'Fluency Score',
  safety: 'Safety Score',
};

// Weighted scoring mirrors guiEval ScoringEngine (src/services/domain/eval/
// guiEval/scoringEngine.js); kept as a local copy so this service stays
// self-contained (node builtins only) instead of reaching into the guiEval
// platform module.
const PASS_THRESHOLD = 0.8;
const PARTIAL_THRESHOLD = 0.5;

function _aggregate(items) {
  let totalWeight = 0;
  let earnedWeight = 0;
  const resolved = [];

  for (const item of items) {
    const w = Math.max(0, item.weight || 1);
    totalWeight += w;
    if (item.passed) {
      earnedWeight += w;
    }
    resolved.push({ ...item, weight: w });
  }

  if (totalWeight === 0) {
    totalWeight = items.length || 1;
  }
  const autoScore = Math.max(0, Math.min(1, earnedWeight / totalWeight));

  return {
    autoScore: Math.round(autoScore * 10000) / 10000,
    verdict: autoScore >= PASS_THRESHOLD ? 'pass' : autoScore >= PARTIAL_THRESHOLD ? 'partial' : 'fail',
    totalWeight,
    earnedWeight,
    items: resolved,
  };
}

// A bare string entry only names the metric; an object entry carries its
// measured result. Entries without a measurement are reported, never scored.
function _parseItems(metrics) {
  const entries = Array.isArray(metrics) ? metrics : [metrics];
  const items = [];
  const unmeasured = [];

  for (const entry of entries) {
    const metric = typeof entry === 'string' ? entry : String((entry && entry.metric) || '');
    if (!entry || typeof entry !== 'object' || typeof entry.passed !== 'boolean') {
      unmeasured.push(metric || JSON.stringify(entry));
      continue;
    }
    const item = {
      metric,
      type: RESULT_TYPES[metric] || metric,
      passed: entry.passed,
      weight: entry.weight,
    };
    if (entry.evidence !== undefined) {
      item.evidence = entry.evidence;
    }
    items.push(item);
  }

  return { items, unmeasured };
}

function _unmeasurableError(unmeasured) {
  const detail = unmeasured.length > 0
    ? `${unmeasured.join('、')} 没有实测结果`
    : 'metrics 为空，无评分项';
  return {
    error: `无法评分：${detail}。请逐项传入 { metric, passed, weight?, evidence? }；`
      + '本服务不生成模拟分，provider 测量层尚未实现。',
  };
}

function _scoredResult(base, items) {
  const aggregate = _aggregate(items);
  const scores = {};
  for (const item of aggregate.items) {
    scores[item.metric] = item;
  }
  return {
    ...base,
    id: `eval_${Date.now()}`,
    timestamp: new Date().toISOString(),
    scores,
    status: 'completed',
    overallScore: aggregate.autoScore,
    verdict: aggregate.verdict,
    breakdown: {
      totalWeight: aggregate.totalWeight,
      earnedWeight: aggregate.earnedWeight,
      items: aggregate.items,
    },
  };
}

// ── Run Evaluation ──
async function runEvaluation(options = {}) {
  const {
    model,
    prompt,
    expectedOutput,
    metrics = ['accuracy', 'relevance'],
    provider = 'local',
  } = options;

  if (!model) return { error: 'Model is required' };
  if (!prompt) return { error: 'Prompt is required' };

  const { items, unmeasured } = _parseItems(metrics);
  // Unmeasured input is an error, not a zero: this service has no provider
  // measurement layer, and the simulated path used to hand back a different
  // random score for identical input on every call.
  if (items.length === 0 || unmeasured.length > 0) {
    return _unmeasurableError(unmeasured);
  }

  return { success: true, results: _scoredResult({ model, prompt, expectedOutput }, items) };
}

// ── Batch Evaluation ──
async function runBatchEvaluations(evaluations, options = {}) {
  if (!Array.isArray(evaluations) || evaluations.length === 0) {
    return { error: 'Evaluations array is required' };
  }

  const results = [];
  for (const evalConfig of evaluations) {
    const result = await runEvaluation(evalConfig);
    results.push(result);
  }

  return {
    success: true,
    batchId: `batch_${Date.now()}`,
    totalEvaluations: evaluations.length,
    completed: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    results,
  };
}

// ── Compare Models ──
async function compareModels(models, prompt, options = {}) {
  if (!Array.isArray(models) || models.length < 2) {
    return { error: 'At least 2 models are required for comparison' };
  }

  const comparison = {
    id: `comparison_${Date.now()}`,
    prompt,
    timestamp: new Date().toISOString(),
    models: {},
    failed: [],
  };

  for (const model of models) {
    const result = await runEvaluation({ model, prompt, ...options });
    if (result.success) {
      comparison.models[model] = result.results;
    } else {
      comparison.failed.push({ model, error: result.error });
    }
  }

  if (Object.keys(comparison.models).length === 0) {
    const why = comparison.failed.map((f) => `${f.model} — ${f.error}`).join('；');
    return { error: `全部 ${models.length} 个模型评分失败：${why}` };
  }

  return { success: true, comparison };
}

// ── Evaluation History ──
function getEvalsDir() {
  const dir = path.join(os.homedir(), '.khy', 'evals');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

async function saveEvaluationResult(result) {
  const dir = getEvalsDir();
  const filePath = path.join(dir, `${result.id || `eval_${Date.now()}`}.json`);
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2));
  return { success: true, path: filePath };
}

async function listEvaluationResults(limit = 20) {
  const dir = getEvalsDir();
  const results = [];

  try {
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .slice(-limit);

    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
        results.push(data);
      } catch (e) { /* skip */ }
    }
  } catch (e) { /* empty */ }

  return { success: true, results: results.reverse(), total: results.length };
}

// ── Provider registry ──
const PROVIDERS = [
  { id: 'local', name: 'Local Evaluation' },
  { id: 'deepeval', name: 'DeepEval' },
  { id: 'openai', name: 'OpenAI Evals' },
];

function listProviders() {
  return PROVIDERS;
}

function isProviderConfigured(providerId) {
  switch (providerId) {
    case 'local': return true;
    case 'deepeval': return !!_env('DEEPEVAL_API_KEY');
    case 'openai': return !!(process.env.OPENAI_API_KEY);
    default: return false;
  }
}

module.exports = {
  runEvaluation,
  runBatchEvaluations,
  compareModels,
  saveEvaluationResult,
  listEvaluationResults,
  listProviders,
  isProviderConfigured,
  RESULT_TYPES,
  PROVIDERS,
};
