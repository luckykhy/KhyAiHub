const { BaseTool } = require('../_baseTool');
const { resolveToolTimeoutMs, withDeadline } = require('../_toolTimeout');

// Per-item measured result. The service scores these and never fabricates
// them: an item without a measured `passed` makes the whole call error out.
const METRIC_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    metric: { type: 'string', description: 'Metric name (accuracy, relevance, coherence, fluency, safety)' },
    passed: { type: 'boolean', description: 'Measured outcome for this item' },
    weight: { type: 'number', description: 'Weight in the weighted aggregate (default 1)' },
    evidence: { type: 'string', description: 'Why the item passed or failed' },
  },
  required: ['metric', 'passed'],
};

const EVALUATION_CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    model: { type: 'string', description: 'Model to evaluate' },
    prompt: { type: 'string', description: 'Evaluation prompt' },
    expectedOutput: { type: 'string', description: 'Expected output for comparison' },
    metrics: {
      type: 'array',
      description: 'Per-item measured results, same shape as the run operation',
      items: METRIC_ITEM_SCHEMA,
    },
  },
  required: ['model', 'prompt'],
};

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    operation: {
      type: 'string',
      enum: ['run', 'batch', 'compare', 'list', 'save'],
      description: 'Operation to perform',
    },
    model: {
      type: 'string',
      description: 'Model to evaluate (for run operation)',
    },
    prompt: {
      type: 'string',
      description: 'Evaluation prompt',
    },
    expectedOutput: {
      type: 'string',
      description: 'Expected output for comparison',
    },
    metrics: {
      type: 'array',
      description: 'Evaluation metrics with measured results. Each item: { metric: string, passed: boolean, weight?: number, evidence?: string }. Per-item measured results are required — this service has no provider measurement layer and never fabricates scores',
      items: METRIC_ITEM_SCHEMA,
    },
    models: {
      type: 'array',
      items: { type: 'string' },
      description: 'Models to compare (for compare operation)',
    },
    evaluations: {
      type: 'array',
      description: 'Evaluation configs (for batch operation): { model, prompt, expectedOutput?, metrics: [{ metric, passed, weight?, evidence? }] }',
      items: EVALUATION_CONFIG_SCHEMA,
    },
  },
  required: ['operation'],
};

class EvalsTool extends BaseTool {
  static toolName = 'Evals';
  static category = 'analysis';
  static risk = 'low';
  static aliases = ['evals', 'evaluation', 'test_model'];
  static searchHint = 'model evaluation testing metrics';
  static shouldDefer = false;

  isReadOnly() {
    return false;
  }
  isConcurrencySafe() {
    return true;
  }

  prompt() {
    return `Model evaluation and testing service.

Operations:
- "run" — Run a single evaluation
- "batch" — Run batch evaluations
- "compare" — Compare multiple models
- "list" — List evaluation history
- "save" — Save evaluation result

metrics carries per-item measured results: [{ metric, passed, weight?, evidence? }].
There is no provider measurement layer here, so unmeasured input returns an
error instead of a score — never a simulated number.`;
  }

  get inputSchema() {
    return INPUT_SCHEMA;
  }

  async execute(params) {
    const timeoutMs = resolveToolTimeoutMs({
      paramMs: params?.timeoutMs,
      envKey: 'KHY_EVALS_TIMEOUT_MS',
      defaultMs: 120000,
      min: 1000,
      max: 300000,
    });

    try {
      const evals = require('../../services/evals');

      switch (params.operation) {
        case 'run':
          if (!params.model || !params.prompt) {
            return { success: false, error: 'model and prompt are required' };
          }
          return await withDeadline(
            () => evals.runEvaluation({
              model: params.model,
              prompt: params.prompt,
              expectedOutput: params.expectedOutput,
              metrics: params.metrics,
            }),
            timeoutMs
          );

        case 'batch':
          if (!params.evaluations) {
            return { success: false, error: 'evaluations array is required' };
          }
          return await withDeadline(
            () => evals.runBatchEvaluations(params.evaluations),
            timeoutMs
          );

        case 'compare':
          if (!params.models || !params.prompt) {
            return { success: false, error: 'models and prompt are required' };
          }
          return await withDeadline(
            () => evals.compareModels(params.models, params.prompt, {
              expectedOutput: params.expectedOutput,
              metrics: params.metrics,
            }),
            timeoutMs
          );

        case 'list':
          return await withDeadline(() => evals.listEvaluationResults(), timeoutMs);

        case 'save':
          if (!params.evaluations) {
            return { success: false, error: 'evaluations result is required' };
          }
          return await withDeadline(
            () => evals.saveEvaluationResult(params.evaluations),
            timeoutMs
          );

        default:
          return { success: false, error: `Unknown operation: ${params.operation}` };
      }
    } catch (err) {
      return { success: false, error: `Evals error: ${err.message}` };
    }
  }

  getActivityDescription(input) {
    return `评估：${input.operation || ''}`;
  }
}

module.exports = EvalsTool;
