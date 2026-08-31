'use strict';

/**
 * orchestrate.js — thin CLI handler for the unified multi-agent orchestration entry.
 *
 * One command, three workflow types (sequential / parallel / phase), plus the
 * pause / resume / replay / status / list control surface. All real logic lives in
 * services/orchestrator/orchestrationService.js; this handler only parses args,
 * loads the spec, and renders via the shared formatters. Nothing orchestration-
 * related is scattered elsewhere.
 *
 * Spec format (JSON file or inline):
 *   { "mode": "sequential", "label": "...", "steps": [ { "prompt": "...", "role": "...", "duration": 3 } ] }
 *   { "mode": "parallel",   "steps": [ ... ] }
 *   { "mode": "phase",      "phases": [ { "name": "research", "steps": [...] }, { "steps": [...] } ] }
 *
 * The `schedule` (alias `plan`) sub-command computes the 统筹/critical-path plan
 * WITHOUT running any agent and additionally accepts a raw task DAG so any
 * dependency graph is expressible:
 *   { "tasks": [ { "id": "boil", "label": "烧水", "duration": 15, "dependsOn": ["kettle"] }, ... ] }
 */

const fs = require('fs');

function _fmt() {
  return require('../formatters');
}

function _loadSpec(arg) {
  if (!arg) {
    throw new Error('缺少 spec：请提供 JSON 文件路径、内联 JSON 或 -（stdin）');
  }
  const trimmed = String(arg).trim();
  if (trimmed === '-') {
    const data = fs.readFileSync(0, 'utf-8'); // stdin
    return JSON.parse(data);
  }
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed);
  }
  const text = fs.readFileSync(trimmed, 'utf-8');
  return JSON.parse(text);
}

function _renderStatus(status, fmt) {
  const { printInfo, printTable } = fmt;
  const p = status.progress || {};
  printInfo(
    `运行 ${status.runId}  ·  模式=${status.mode}  ·  控制=${status.control}  ·  ` +
      `已完成 ${p.done || 0}/${p.total || 0}` +
      (p.failed ? `  ·  失败 ${p.failed}` : '') +
      (p.running ? `  ·  进行中 ${p.running}` : '')
  );
  const rows = (status.steps || []).map((s) => [
    s.stepId,
    s.role || '',
    s.status,
    s.error ? `✗ ${s.error}` : s.result != null ? s.result : '',
  ]);
  if (rows.length) {
    printTable(['步骤', '角色', '状态', '结果 / 错误'], rows);
  }
}

/** Short, table-friendly label for a plan step / DAG task in the schedule view. */
function _stepLabel(step) {
  if (step.label && step.label !== step.id) {
    return String(step.label);
  }
  if (step.role && step.role !== 'general') {
    return step.role;
  }
  const p = String(step.prompt || step.id || '')
    .replace(/\s+/g, ' ')
    .trim();
  return p.length > 40 ? p.slice(0, 39) + '…' : p || step.id;
}

/**
 * Render the 统筹 / critical-path schedule analysis (no agents are run). This is
 * the "boil water while you watch TV" planner: it shows the minimum wall-clock
 * time (critical path), how much it beats doing everything one-by-one, and which
 * flexible tasks can be slotted into each long task's wait.
 */
function _renderSchedule(plan, analysis, fmt) {
  const { printInfo, printTable, printSuccess } = fmt;
  const labelById = {};
  for (const s of plan.steps) {
    labelById[s.id] = _stepLabel(s);
  }

  printInfo(`统筹计划「${plan.label}」  ·  模式=${plan.mode}  ·  ${plan.stepCount} 个任务`);
  const saved = analysis.savedTime;
  const pct = analysis.serialTotal > 0 ? Math.round((saved / analysis.serialTotal) * 100) : 0;
  printSuccess(
    `逐个做完：${analysis.serialTotal}  →  统筹后：${analysis.makespan}  ` +
      `(省 ${saved}${pct ? `，即 ${pct}%` : ''}；单位 = spec 里的 "duration")`
  );

  const rows = analysis.tasks.map((t) => [
    t.id,
    labelById[t.id] || t.label,
    String(t.duration),
    `${t.es}–${t.ef}`,
    String(t.slack),
    t.critical ? '★ 关键' : '',
  ]);
  printTable(['步骤', '名称', '耗时', '时间窗', '浮动', ''], rows);

  if (analysis.criticalPath.length) {
    printInfo(
      '关键路径（决定总时长的主干）：' +
        analysis.criticalPath.map((id) => labelById[id] || id).join(' → ')
    );
  }

  if (analysis.waitFill.length) {
    printInfo('统筹提示 — 等待时间可以顺手做的事（烧水的同时洗杯子）：');
    for (const w of analysis.waitFill) {
      const chores = w.canDo.map((c) => `${labelById[c.id] || c.label}(${c.duration})`).join('、');
      printInfo(
        `  ⏳ 「${labelById[w.during] || w.label}」运行的间隙 [${w.window[0]}–${w.window[1]}]，可同时做：${chores}`
      );
    }
  } else if (analysis.stepCount > 1) {
    printInfo('没有可并行的空隙 — 每个任务都在关键路径上（严格串行链）。');
  }
}

/** Map a built plan's steps into the schedule leaf's task shape. */
function _planToScheduleTasks(plan) {
  return plan.steps.map((s) => ({
    id: s.id,
    label: _stepLabel(s),
    duration: s.duration, // undefined → schedule leaf defaults to 1
    dependsOn: s.dependsOn || [],
  }));
}

function _help(fmt) {
  fmt.printInfo(
    [
      'khy orchestrate — 统一多智能体编排',
      '',
      '  run <spec.json|->     启动工作流（sequential / parallel / phase）',
      '  schedule <spec|->     统筹/关键路径分析（不跑智能体）：最短耗时、',
      '                        相比逐个做的节省、等待间隙可以顺手做的事',
      '  status [runId]        统一监控视图（省略 id 时看最近一次运行）',
      '  list                  列出已知运行',
      '  pause   <runId>       停止接收新步骤（进行中的步骤会跑完）',
      '  resume  <runId>       继续已暂停的运行',
      '  replay  <runId>       重置受阻/失败的步骤并重跑（已完成步骤跳过）',
      '  cancel  <runId>       标记运行为已取消',
      '',
      '  Spec: { "mode":"sequential|parallel|phase", "steps":[{"prompt","role","duration"}] }',
      '        phase 模式用 "phases":[{"name","steps":[...]}]',
      '        schedule 还接受原始 DAG：{ "tasks":[{"id","label","duration","dependsOn":[]}] }',
      '        "duration"（可选，单位自定）驱动统筹分析。',
      '  开关: KHY_ORCHESTRATE=0 禁用本命令；',
      '        KHY_ORCHESTRATE_SCHEDULE=0 仅禁用 schedule 子命令。',
    ].join('\n')
  );
}

async function handleOrchestrate(subCommand, args = [], options = {}) {
  const fmt = _fmt();
  const { printError, printSuccess } = fmt;
  const svc = require('../../services/domain/state/orchestrator/orchestrationService.js');

  if (!svc.orchestrateEnabled(process.env)) {
    fmt.printWarn('orchestrate 已被禁用（KHY_ORCHESTRATE=0）；取消该环境变量即可恢复。');
    return true;
  }

  const sub = String(subCommand || (args && args[0]) || 'help').toLowerCase();
  // If subCommand was peeled by the router, args holds the remainder; otherwise drop args[0].
  const rest = subCommand ? args : (args || []).slice(1);
  const arg0 = rest && rest[0];

  try {
    switch (sub) {
      case 'run': {
        const spec = _loadSpec(arg0);
        fmt.printInfo(`启动编排（模式=${spec.mode || '?'}），共 ${(spec.steps || spec.phases || []).length} 个顶层步骤`);
        const status = await svc.runOrchestration(spec, {
          timeout: options.timeout ? Number(options.timeout) : undefined,
          maxRetries: options.retries ? Number(options.retries) : undefined,
        });
        const ok = status.control === 'done';
        (ok ? printSuccess : fmt.printWarn)(
          `运行 ${status.runId} 结束：控制=${status.control}，` +
            `已完成 ${status.progress.done}/${status.progress.total}` +
            (status.progress.failed ? `，失败 ${status.progress.failed}` : '')
        );
        _renderStatus(status, fmt);
        if (!ok && status.progress.failed) {
          fmt.printInfo(`重跑失败步骤：khy orchestrate replay ${status.runId}`);
        }
        return true;
      }
      case 'schedule':
      case 'plan': {
        const sched = require('../../services/domain/state/orchestrator/criticalPathSchedule.js');
        if (!sched.scheduleEnabled(process.env)) {
          fmt.printWarn(
            'orchestrate schedule 已被禁用（KHY_ORCHESTRATE_SCHEDULE=0）；取消该环境变量即可恢复。'
          );
          return true;
        }
        const spec = _loadSpec(arg0);
        // Two spec shapes:
        //   1. a raw task DAG  { "tasks": [{ id, label, duration, dependsOn:[...] }] }
        //      — expresses ANY dependency graph (e.g. the true 烧水泡茶 example).
        //   2. a workflow spec { "mode": ..., "steps"|"phases": ... } — reuses the
        //      sequential/parallel/phase plan builder so `run` and `schedule` share one spec.
        let label, stepCount, scheduleTasks, mode;
        if (Array.isArray(spec.tasks)) {
          mode = 'dag';
          label = (typeof spec.label === 'string' && spec.label.trim()) || 'schedule';
          scheduleTasks = spec.tasks;
          stepCount = spec.tasks.length;
        } else {
          const builtPlan =
            require('../../services/domain/state/orchestrator/orchestrationPlan.js').buildOrchestrationPlan(spec);
          mode = builtPlan.mode;
          label = builtPlan.label;
          stepCount = builtPlan.stepCount;
          scheduleTasks = _planToScheduleTasks(builtPlan);
        }
        const analysis = sched.analyzeSchedule(scheduleTasks);
        _renderSchedule({ label, mode, stepCount, steps: scheduleTasks }, analysis, fmt);
        return true;
      }
      case 'status': {
        let runId = arg0;
        if (!runId) {
          const runs = svc.listRuns({});
          if (!runs.length) {
            fmt.printInfo('暂无编排运行记录。用 `khy orchestrate run <spec.json>` 启动一次。');
            return true;
          }
          runId = runs[runs.length - 1].runId;
        }
        const status = svc.getRunStatus(runId, {});
        if (!status) {
          printError(`未找到运行 ${runId}：跑 \`khy orchestrate list\` 核对 runId。`);
          return false;
        }
        _renderStatus(status, fmt);
        return true;
      }
      case 'list': {
        const runs = svc.listRuns({});
        if (!runs.length) {
          fmt.printInfo('暂无编排运行记录。用 `khy orchestrate run <spec.json>` 启动一次。');
          return true;
        }
        const rows = runs.map((r) => [
          r.runId,
          r.mode,
          r.control,
          `${r.progress.done}/${r.progress.total}`,
          r.progress.failed ? String(r.progress.failed) : '',
          r.label || '',
        ]);
        fmt.printTable(['运行 ID', '模式', '控制', '已完成', '失败', '名称'], rows);
        return true;
      }
      case 'pause':
      case 'cancel': {
        if (!arg0) {
          printError(`用法：khy orchestrate ${sub} <runId>（runId 见 \`khy orchestrate list\`）`);
          return false;
        }
        const status = sub === 'pause' ? svc.pauseRun(arg0, {}) : svc.cancelRun(arg0, {});
        if (!status) {
          printError(`未找到运行 ${arg0}：跑 \`khy orchestrate list\` 核对 runId。`);
          return false;
        }
        printSuccess(
          `运行 ${arg0} 已${sub === 'pause' ? '暂停' : '取消'}（控制=${status.control}）。`
        );
        return true;
      }
      case 'resume':
      case 'replay': {
        if (!arg0) {
          printError(`用法：khy orchestrate ${sub} <runId>（runId 见 \`khy orchestrate list\`）`);
          return false;
        }
        fmt.printInfo(`${sub === 'replay' ? '重跑' : '继续'}运行 ${arg0}`);
        const status =
          sub === 'resume' ? await svc.resumeRun(arg0, {}) : await svc.replayRun(arg0, {});
        if (!status) {
          printError(`未找到运行 ${arg0}：跑 \`khy orchestrate list\` 核对 runId。`);
          return false;
        }
        const ok = status.control === 'done';
        (ok ? printSuccess : fmt.printWarn)(
          `运行 ${arg0} ${sub === 'resume' ? '继续' : '重跑'}结束：控制=${status.control}，` +
            `已完成 ${status.progress.done}/${status.progress.total}`
        );
        _renderStatus(status, fmt);
        return true;
      }
      case 'help':
      default:
        _help(fmt);
        return true;
    }
  } catch (e) {
    printError(`orchestrate ${sub} 失败：${(e && e.message) || e}；spec 格式见 \`khy orchestrate help\`。`);
    return false;
  }
}

module.exports = { handleOrchestrate };
