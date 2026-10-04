'use strict';

/**
 * crossModelVerify.js — Cross-vendor model verification (the surpass mechanism).
 *
 * WHY THIS EXISTS:
 *   A model reviewing its own output has systematic blind spots — it tends to
 *   approve its own errors. Cross-VENDOR verification catches these. Claude
 *   Code only has Claude, Cursor only has one model — they are structurally
 *   unable to do cross-vendor verification. khy-os's multi-vendor gateway is
 *   the one structural advantage that can produce higher code quality than
 *   any single-vendor competitor.
 *
 * WHAT IT DOES:
 *   After the primary model's tool loop + delivery gate, this service routes a
 *   REVIEW request to a DIFFERENT vendor's model. The reviewer gets: the task,
 *   the changed files (diffs), the delivery criteria, and the primary model's
 *   final response. It returns a verdict + any issues found.
 *
 * INTEGRATION:
 *   Called from agenticHarnessService.js AFTER the delivery gate remediation
 *   loop, BEFORE the verification agent. If the cross-model reviewer finds
 *   issues the same-model verification missed, one more remediation round is
 *   triggered with the reviewer's feedback.
 *
 * ROLLOUT (PROCESS-008):
 *   S1 observer — records what cross-model verification found, does NOT block
 *   delivery. Graduates to S2 (advisory) then S3 (blocking) per sample count.
 *   Gate: KHY_CROSS_MODEL_VERIFY (default on). Stage: KHY_CROSS_MODEL_VERIFY_STAGE.
 *
 * Contract: pure-ish leaf — no fs writes, no tool dispatch. The only IO is the
 * chat() call (provided by the harness). Never throws; fail-soft to { skipped }.
 */

const path = require('path');

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * Gate: is cross-model verification enabled?
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  const raw = String((env && env.KHY_CROSS_MODEL_VERIFY) || 'true')
    .trim()
    .toLowerCase();
  return !_FALSY.has(raw);
}

/**
 * Current rollout stage.
 * @param {Record<string,string>} [env]
 * @returns {'S1'|'S2'|'S3'}
 */
function getStage(env = process.env) {
  const raw = String((env && env.KHY_CROSS_MODEL_VERIFY_STAGE) || 'S1')
    .trim()
    .toUpperCase();
  if (raw === 'S2' || raw === 'S3') {
    return raw;
  }
  return 'S1';
}

// ── Vendor classification ──────────────────────────────────────────────

/**
 * Map an adapter name + model id to a vendor family.
 * This is a heuristic — it does not need to be perfect, only good enough
 * to pick a DIFFERENT vendor for cross-verification.
 * @param {string} adapter
 * @param {string} model
 * @returns {string}
 */
function _classifyVendor(adapter, model) {
  const a = String(adapter || '').toLowerCase();
  const m = String(model || '').toLowerCase();
  if (a.includes('claude') || a.includes('anthropic') || m.includes('claude')) {
    return 'anthropic';
  }
  if (a.includes('codex') || a.includes('openai') || m.includes('gpt') || m.includes('o1') || m.includes('o3')) {
    return 'openai';
  }
  if (m.includes('deepseek')) {
    return 'deepseek';
  }
  if (m.includes('glm') || a.includes('glm') || a.includes('zhipu')) {
    return 'zhipu';
  }
  if (m.includes('qwen') || m.includes('tongyi')) {
    return 'qwen';
  }
  if (m.includes('doubao') || m.includes('ernie') || m.includes('wenxin')) {
    return 'domestic_cn';
  }
  if (a.includes('ollama') || a.includes('local')) {
    return 'local';
  }
  return 'unknown';
}

/**
 * Pick a cross-vendor review model — a model from a DIFFERENT vendor family.
 * Preference order prioritizes the strongest available alternative.
 * @param {string} primaryVendor
 * @returns {Array<{model: string, vendor: string, reason: string}>}
 */
function _crossVendorCandidates(primaryVendor) {
  const all = [
    { model: 'deepseek-chat', vendor: 'deepseek', reason: 'DeepSeek 对代码审查敏感度高' },
    { model: 'glm-4', vendor: 'zhipu', reason: 'GLM-4 与 Anthropic 差异大，盲区互补' },
    { model: 'claude-sonnet-4-20250514', vendor: 'anthropic', reason: 'Claude 对语义完整性审查强' },
    { model: 'gpt-4o', vendor: 'openai', reason: 'GPT-4o 跨供应商交叉验证' },
    { model: 'qwen-max', vendor: 'qwen', reason: '通义千问 中文语境理解' },
  ];
  return all.filter((c) => c.vendor !== primaryVendor);
}

// ── Review prompt construction ─────────────────────────────────────────

/**
 * Build a diff summary from the tool call log for the reviewer.
 * @param {Array} toolCallLog
 * @returns {string}
 */
function _buildDiffSummary(toolCallLog) {
  if (!Array.isArray(toolCallLog)) {
    return '(no tool calls recorded)';
  }
  const EDIT_RE = /^(editFile|edit_file|edit|write_file|writeFile|scaffoldFiles|MultiEdit|multi_edit|multiedit|apply_patch)$/i;
  const edits = toolCallLog.filter((e) => EDIT_RE.test(String(e.tool || e.name || '')));
  if (edits.length === 0) {
    return '(no file edits in this run)';
  }
  const lines = [];
  for (const e of edits.slice(0, 20)) {
    const file = e.params?.file_path || e.params?.path || e.params?.filePath || '(unknown)';
    const oldStr = String(e.params?.old_string || '').slice(0, 200);
    const newStr = String(e.params?.new_string || '').slice(0, 200);
    lines.push(`--- ${path.basename(file)}`);
    if (oldStr) {
      lines.push(`- ${oldStr.replace(/\n/g, '\\n')}`);
    }
    if (newStr) {
      lines.push(`+ ${newStr.replace(/\n/g, '\\n')}`);
    }
  }
  return lines.join('\n');
}

/**
 * Build the review prompt for the cross-vendor model.
 * @param {object} args
 * @returns {string}
 */
function _buildReviewPrompt(args) {
  const { task, diffSummary, criteria, primaryResponse, primaryModel } = args;
  const criteriaText = Array.isArray(criteria) && criteria.length > 0
    ? criteria.map((c) => `  · ${c.label || c.id || String(c).slice(0, 100)}`).join('\n')
    : '(no explicit criteria — judge by task completion)';

  return [
    '你是一个独立的代码审查者。另一个 AI 模型刚完成了一项编码任务，现在需要你交叉验证其工作。',
    '',
    `原模型: ${primaryModel || '(unknown)'}`,
    '',
    '【用户任务】',
    String(task || '').slice(0, 2000),
    '',
    '【变更摘要 (diff)】',
    diffSummary,
    '',
    '【交付验收标准】',
    criteriaText,
    '',
    '【原模型的最终回复】',
    String(primaryResponse || '').slice(0, 3000),
    '',
    '【你的任务】',
    '1. 代码是否真正解决了用户的任务？',
    '2. 是否有逻辑错误、遗漏的边界情况、或不完整的实现？',
    '3. 变更是否引入了新的问题？',
    '',
    '请用以下格式回复：',
    'VERDICT: PASS 或 ISSUES 或 FAIL',
    'ISSUES:',
    '- (每个问题一行，含文件名和具体描述)',
    'SUGGESTED_FIXES:',
    '- (每个建议一行)',
  ].join('\n');
}

/**
 * Parse the cross-vendor model's review response.
 * @param {string} text
 * @returns {{ verdict: string, issues: string[], suggestedFixes: string[] }}
 */
function _parseReview(text) {
  const t = String(text || '');
  let verdict = 'pass';
  const issues = [];
  const suggestedFixes = [];

  const verdictMatch = t.match(/VERDICT:\s*(PASS|ISSUES|FAIL)/i);
  if (verdictMatch) {
    verdict = verdictMatch[1].toLowerCase();
  }

  // Extract issues
  const issuesSection = t.match(/ISSUES:\s*\n([\s\S]*?)(?=SUGGESTED_FIXES:|$)/i);
  if (issuesSection) {
    const lines = issuesSection[1].split('\n').map((l) => l.trim()).filter((l) => l.startsWith('-'));
    issues.push(...lines.map((l) => l.replace(/^[-\s]+/, '')));
  }

  // Extract suggested fixes
  const fixesSection = t.match(/SUGGESTED_FIXES:\s*\n([\s\S]*?)$/i);
  if (fixesSection) {
    const lines = fixesSection[1].split('\n').map((l) => l.trim()).filter((l) => l.startsWith('-'));
    suggestedFixes.push(...lines.map((l) => l.replace(/^[-\s]+/, '')));
  }

  // If no structured verdict found, do a heuristic: if text mentions "问题" or "错误" or "issue" → issues
  if (!verdictMatch) {
    const lower = t.toLowerCase();
    if (lower.includes('问题') || lower.includes('错误') || lower.includes('issue') || lower.includes('bug')) {
      verdict = 'issues';
    }
  }

  return { verdict, issues, suggestedFixes };
}

/**
 * Build a remediation prompt from the cross-model review findings.
 * @param {string} originalTask
 * @param {{ verdict: string, issues: string[], suggestedFixes: string[] }} review
 * @returns {string}
 */
function buildRemediationPrompt(originalTask, review) {
  return [
    '[SYSTEM: 跨模型交叉验证发现以下问题，请修复]',
    '',
    '[交叉验证模型发现的问题]:',
    ...review.issues.map((i, idx) => `  ${idx + 1}. ${i}`),
    '',
    '[建议修复方向]:',
    ...review.suggestedFixes.map((s, idx) => `  ${idx + 1}. ${s}`),
    '',
    '[原任务]:',
    String(originalTask || '').slice(0, 500),
    '',
    '[指令]',
    '逐一修复上述问题。修复后系统会重新验证。',
  ].join('\n');
}

// ── Main entry point ───────────────────────────────────────────────────

/**
 * Run cross-vendor model verification.
 *
 * @param {object} args
 * @param {string} args.task - Original user message / task
 * @param {Array}  args.toolCallLog - Tool calls from the primary run
 * @param {Array}  args.criteria - Delivery acceptance criteria
 * @param {string} args.primaryResponse - Primary model's final response
 * @param {string} args.primaryModel - Primary model ID
 * @param {string} args.primaryAdapter - Primary adapter name
 * @param {function} args.chat - The harness chat function: chat(text, opts) → { text, ... }
 * @param {object}  args.chatOpts - Base chat options to override
 * @param {function} [args.onEvent] - Event callback
 * @returns {Promise<object>} { performed, verdict, issues, suggestedFixes, reviewModel, remediationPrompt }
 */
async function verify(args) {
  const {
    task,
    toolCallLog,
    criteria,
    primaryResponse,
    primaryModel,
    primaryAdapter,
    chat,
    chatOpts,
    onEvent,
  } = args;

  if (!isEnabled()) {
    return { performed: false, reason: 'disabled' };
  }
  if (typeof chat !== 'function') {
    return { performed: false, reason: 'no chat function' };
  }

  const primaryVendor = _classifyVendor(primaryAdapter, primaryModel);
  const candidates = _crossVendorCandidates(primaryVendor);

  if (candidates.length === 0) {
    return { performed: false, reason: 'no cross-vendor candidates available' };
  }

  const diffSummary = _buildDiffSummary(toolCallLog);
  const reviewPrompt = _buildReviewPrompt({
    task,
    diffSummary,
    criteria,
    primaryResponse,
    primaryModel,
  });

  const stage = getStage();

  // Try candidates in order — first one that responds wins
  for (const candidate of candidates) {
    try {
      if (onEvent) {
        onEvent({
          type: 'cross_model_verify_attempt',
          reviewModel: candidate.model,
          reviewVendor: candidate.vendor,
          primaryVendor,
          stage,
        });
      }

      const result = await chat(reviewPrompt, {
        ...chatOpts,
        model: candidate.model,
        preferredModel: candidate.model,
        _isFollowUp: true,
        _isCrossModelReview: true,
      });

      const reviewText = typeof result === 'string' ? result : (result && (result.text || result.content)) || '';
      if (!reviewText || reviewText.length < 10) {
        // Likely model not available or returned empty — try next candidate
        continue;
      }

      const parsed = _parseReview(reviewText);

      if (onEvent) {
        onEvent({
          type: 'cross_model_verify_result',
          reviewModel: candidate.model,
          reviewVendor: candidate.vendor,
          verdict: parsed.verdict,
          issueCount: parsed.issues.length,
          stage,
        });
      }

      const remediationPrompt =
        parsed.issues.length > 0 ? buildRemediationPrompt(task, parsed) : null;

      return {
        performed: true,
        reviewModel: candidate.model,
        reviewVendor: candidate.vendor,
        primaryVendor,
        verdict: parsed.verdict,
        issues: parsed.issues,
        suggestedFixes: parsed.suggestedFixes,
        remediationPrompt,
        rawReview: reviewText.slice(0, 2000),
        stage,
      };
    } catch (err) {
      // This candidate failed (no key, model not found, timeout) — try next
      if (onEvent) {
        onEvent({
          type: 'cross_model_verify_skip',
          reviewModel: candidate.model,
          reason: err ? String(err.message || err).slice(0, 200) : 'unknown error',
        });
      }
      continue;
    }
  }

  // All candidates exhausted — no cross-vendor model was available
  return {
    performed: false,
    reason: 'no cross-vendor model available (all candidates failed)',
    primaryVendor,
    attemptedVendors: candidates.map((c) => c.vendor),
  };
}

module.exports = {
  isEnabled,
  getStage,
  verify,
  buildRemediationPrompt,
  // Exported for testing
  _classifyVendor,
  _crossVendorCandidates,
  _parseReview,
  _buildReviewPrompt,
};
