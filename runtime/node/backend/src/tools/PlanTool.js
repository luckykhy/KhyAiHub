/**
 * PlanTool — session-scoped task planning checklist (TodoWrite equivalent).
 *
 * Lets the agent lay out a plan BEFORE executing, then update each item's
 * status as it progresses. The plan is displayed to the user as a checklist
 * so they can see what the agent intends to do and track completion.
 *
 * Design choices:
 *   - Session-scoped in-memory Map (not persisted) — the plan is a working
 *     scaffold for the current turn/session, not a durable task record.
 *     Durable tasks use _taskStore (largeTaskRuntimeStore); this tool does
 *     NOT compete with it.
 *   - Full-replacement semantics (like Claude Code's TodoWrite): each call
 *     replaces the entire plan. This keeps the plan coherent — the agent
 *     re-emit the full list with updated statuses rather than patching.
 *   - Non-blocking, non-intercepting — pure display aid, no PROCESS-008 gate.
 *
 * Integration hook: when a plan item carries a `dependsOn` array, the
 * harness's _tryAutoDecompose / dependencyWaveScheduler MAY consume the plan
 * to schedule sub-agent waves. That wiring is opt-in via KHY_PLAN_DECOMPOSE.
 */
'use strict';

const { defineTool } = require('./_baseTool');

/**
 * In-memory plan store: sessionId → plan items.
 * @type {Map<string, Array<{content:string,status:string,priority:string,dependsOn?:string[]}>>}
 */
const _plans = new Map();

const STATUS_ORDER = Object.freeze(['in_progress', 'pending', 'completed']);
const STATUS_ICONS = Object.freeze({
  pending: '○',
  in_progress: '◐',
  completed: '●',
});
const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed']);
const VALID_PRIORITIES = new Set(['high', 'medium', 'low']);

function _sessionId(context) {
  const sid =
    (context && context.sessionId) ||
    (context && context.chatOpts && context.chatOpts.sessionId) ||
    (context && context.traceContext && context.traceContext.sessionId) ||
    '_default';
  return String(sid);
}

function _normalizeItem(raw) {
  const content = String((raw && raw.content) || '').trim();
  const status = String((raw && raw.status) || 'pending')
    .trim()
    .toLowerCase();
  const priority = String((raw && raw.priority) || 'medium')
    .trim()
    .toLowerCase();
  const dependsOn = Array.isArray(raw && raw.dependsOn) ? raw.dependsOn.map(String) : [];
  return {
    content,
    status: VALID_STATUSES.has(status) ? status : 'pending',
    priority: VALID_PRIORITIES.has(priority) ? priority : 'medium',
    dependsOn,
  };
}

function _renderPlan(items) {
  if (!items || items.length === 0) {
    return '(empty plan)';
  }
  // Sort: in_progress first, then pending, then completed; within group by priority
  const priorityRank = { high: 0, medium: 1, low: 2 };
  const sorted = items.slice().sort((a, b) => {
    const sa = STATUS_ORDER.indexOf(a.status);
    const sb = STATUS_ORDER.indexOf(b.status);
    if (sa !== sb) return sa - sb;
    return (priorityRank[a.priority] || 1) - (priorityRank[b.priority] || 1);
  });
  const lines = [];
  for (const item of sorted) {
    const icon = STATUS_ICONS[item.status] || '○';
    const tag = item.priority === 'high' ? ' [P0]' : item.priority === 'low' ? ' [P2]' : '';
    const deps = item.dependsOn.length > 0 ? ` (依赖: ${item.dependsOn.join(', ')})` : '';
    lines.push(`  ${icon} ${item.content}${tag}${deps}`);
  }
  const total = items.length;
  const done = items.filter((i) => i.status === 'completed').length;
  const active = items.filter((i) => i.status === 'in_progress').length;
  lines.push(`  ── ${done}/${total} 完成 · ${active} 进行中`);
  return lines.join('\n');
}

module.exports = defineTool({
  name: 'PlanTool',
  description:
    'Create or update a session task plan (checklist). Use it BEFORE starting multi-step work so the user can see ' +
    'the intended steps, and UPDATE it as each step progresses (pending → in_progress → completed). ' +
    'Each call replaces the entire plan — re-emit the full list with updated statuses. ' +
    'Constraints: keep items concise (one action per item); mark an item in_progress only when actively working on it; ' +
    'mark completed only when truly done. Do NOT use for durable cross-session tasks (use RecordProgress for those).',
  category: 'system',
  risk: 'low',
  isReadOnly: true,
  isConcurrencySafe: true,

  // `todowrite` 不在别名之列：该归一化键归 TodoWriteTool（其 toolName 即 `TodoWrite`）。
  // 两个工具同时声明它构成跨 risk 冲突（PlanTool low / TodoWrite safe），归一键由注册表
  // 迭代序决定，模型可见清单与风险门会跟着漂。别名收敛到 PlanTool 自己的名字族即可。
  aliases: ['planTool', 'plan', 'todo', 'taskPlan'],
  searchHint: 'plan todo checklist task list progress 计划 任务清单',

  inputSchema: {
    tasks: {
      type: 'array',
      required: true,
      description:
        'Full list of plan items. Each item: {content (string, required), status (pending|in_progress|completed, default pending), priority (high|medium|low, default medium), dependsOn (string[], optional — names of items this one depends on)}. Example: [{content:"读取配置文件",status:"completed",priority:"high"},{content:"修复端口解析",status:"in_progress",priority:"high"}]',
      items: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Plan item text (imperative form)' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          dependsOn: {
            type: 'array',
            items: { type: 'string' },
            description: 'Names of items this one depends on',
          },
        },
      },
      example: [
        { content: '读取配置文件', status: 'completed', priority: 'high' },
        { content: '修复端口解析', status: 'in_progress', priority: 'high' },
        { content: '补充测试用例', status: 'pending', priority: 'medium' },
      ],
    },
  },

  getActivityDescription(input) {
    const n = Array.isArray(input.tasks) ? input.tasks.length : 0;
    return `更新计划清单 (${n} 项)`;
  },

  getToolUseSummary(input) {
    if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
      return null;
    }
    const done = input.tasks.filter((t) => t.status === 'completed').length;
    const active = input.tasks.filter((t) => t.status === 'in_progress').length;
    return `计划 ${done}/${input.tasks.length} 完成 · ${active} 进行中`;
  },

  async execute(params, context) {
    const tasks = Array.isArray(params.tasks) ? params.tasks : [];
    if (tasks.length === 0) {
      return { success: false, error: 'tasks array is empty — provide at least one plan item.' };
    }

    const items = tasks.map(_normalizeItem);
    // Validate: exactly one in_progress at a time (best practice, not hard block)
    const inProgress = items.filter((i) => i.status === 'in_progress');
    if (inProgress.length > 1) {
      // Soft warning — still accept the plan but note the issue
      // (the model may have valid reasons for parallel work)
    }

    const sid = _sessionId(context);
    _plans.set(sid, items);

    const rendered = _renderPlan(items);
    const total = items.length;
    const done = items.filter((i) => i.status === 'completed').length;
    const active = items.filter((i) => i.status === 'in_progress').length;
    const pending = items.filter((i) => i.status === 'pending').length;

    return {
      success: true,
      plan: rendered,
      summary: {
        total,
        completed: done,
        inProgress: active,
        pending,
      },
      message: `计划已更新：${done}/${total} 完成 · ${active} 进行中 · ${pending} 待办`,
    };
  },
  // Export the store accessors for the harness/TUI to read the current plan for
  // display. Declared inside the config (NOT attached to the frozen export after
  // the fact) — `defineTool` returns a frozen object, so `module.exports._getPlan
  // = …` throws `Cannot add property _getPlan, object is not extensible` under
  // 'use strict' and the whole tool fails to load. That bug made PlanTool a dead
  // file (invisible to the model) until [DESIGN-ARCH-153] D5. See defineTool's
  // `extraExports` handling in _baseTool.js.
  extraExports: {
    _getPlan: (sessionId) => _plans.get(sessionId || '_default') || null,
    _clearPlan: (sessionId) => {
      _plans.delete(sessionId || '_default');
    },
  },
});
