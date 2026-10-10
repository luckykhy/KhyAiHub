/**
 * Receipts CLI handler — browse structured execution receipts (A3).
 *
 * Commands:
 *   khy receipts list [--session <id>] [--limit <n>]   — recent receipts
 *   khy receipts show <id>                              — full receipt detail
 *   khy receipts search <keyword>                       — full-text search
 *   khy receipts orch [--limit <n>]                     — orchestration receipts
 *     (alias: receipts orchestration; written only by sub-agent runs)
 *   khy receipts stats                                  — 轨迹⟂回执对账与达成率
 */
const chalk = (() => {
  const m = require('chalk');
  return m.default || m;
})();
const { MANIFEST_EXPORT_KEY } = require('../commandManifest');
const { ccFormatDurationOr } = require('../ccFormat');
const { printError, printInfo } = require('../formatters');
const _markFailure = require('../../utils/markProcessFailure');

// Single source of truth for the verb slot: the manifest declares it (so
// commandAutoRegistry._alignSubCommand can reconcile a typed token) and the
// unknown-verb error below renders it, so the two cannot drift apart.
const SUB_COMMANDS = ['list', 'show', 'search', 'orch', 'orchestration', 'stats'];

const RISK_COLOR = {
  safe: (s) => chalk.dim(s),
  low: (s) => chalk.green(s),
  medium: (s) => chalk.cyan(s),
  high: (s) => chalk.yellow(s),
  critical: (s) => chalk.red(s),
};

// 内部枚举 → 中文标签:仅渲染壳翻译,回执 JSON 字段保持英文(DATA);未知值原样回退。
const RISK_LABEL_ZH = { critical: '严重', high: '高危', medium: '中危', low: '低危', safe: '安全' };
const STATUS_LABEL_ZH = {
  completed: '已完成',
  partial: '部分完成',
  failed: '失败',
  interrupted: '已中断',
  running: '运行中',
};
const PERMISSION_LABEL_ZH = { allow: '允许', deny: '拒绝', ask: '询问', auto: '自动', unknown: '未知' };
const ACTION_LABEL_ZH = { write: '写入', edit: '编辑', delete: '删除' };

const STATUS_ICON = {
  completed: chalk.green('✓'),
  partial: chalk.yellow('◑'),
  failed: chalk.red('✗'),
  interrupted: chalk.yellow('⏸'),
  running: chalk.dim('…'),
};

function _riskTag(risk) {
  const fn = RISK_COLOR[risk] || ((s) => s);
  return fn(`[${RISK_LABEL_ZH[risk] || risk}]`);
}

function _fmtTime(iso) {
  // 遗留/半写的回执记录可能缺 startedAt；new Date(undefined|'').toLocaleString 不抛、
  // 直接吐英文 "Invalid Date"（旧/半写记录读到 undefined）。orchestration 的 null → 1970 误导。
  if (iso == null || iso === '') return '未知时间';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso); // 无法解析则如实回显原值
  try {
    return d.toLocaleString('zh-CN');
  } catch {
    return String(iso);
  }
}

async function handleReceipts(subCommand, args, options) {
  const svc = require('../../services/receiptService');

  // A bare `khy receipts` means the list view, but a token that matched neither
  // the router's static table nor SUB_COMMANDS must not be silently discarded:
  // `receipts lst` used to render the receipt list as if nothing was wrong.
  const cmd = subCommand || (args[0] ? String(args[0]).toLowerCase() : 'list');

  if (cmd === 'list') {
    const limit = parseInt(options.limit, 10) || 20;
    const sessionId = options.session || null;
    const rows = svc.listReceipts({ sessionId, limit });
    console.log(chalk.bold('\n  执行回执\n'));
    if (rows.length === 0) {
      // Rule 2.2: an empty table must say who fills it. Receipts are written by
      // the tool loop (startReceipt → appendToolCall → finalizeReceipt), never by
      // a CLI command, so "run a tool-bearing turn" is the only real way out.
      printInfo('暂无回执记录：回执由 AI 每执行一轮工具自动写入，先在会话里让 AI 动手（读写文件或执行命令）');
      console.log('');
      return true;
    }
    for (const r of rows) {
      const icon = STATUS_ICON[r.status] || chalk.dim('•');
      console.log(
        `  ${icon} ${chalk.cyan(r.id)} ${_riskTag(r.maxRisk)} ` +
          `${chalk.dim(_fmtTime(r.startedAt))} ${chalk.dim(`(${r.tools} 工具)`)}`
      );
      if (r.goal) {
        console.log(`     ${chalk.dim(r.goal)}`);
      }
    }
    console.log(
      chalk.dim(`\n  共 ${rows.length} 条 · 用法: receipts show <id> · receipts search <kw>\n`)
    );
    return true;
  }

  if (cmd === 'show') {
    const id = args[0];
    if (!id) {
      printError('用法: receipts show <RCPT-id>');
      _markFailure();
      return true;
    }
    const r = svc.getReceipt(id);
    if (!r) {
      printError(`未找到回执: ${id}`);
      _markFailure();
      return true;
    }

    const icon = STATUS_ICON[r.status] || '•';
    console.log(chalk.bold(`\n  回执 ${chalk.cyan(r.id)}  ${icon} ${STATUS_LABEL_ZH[r.status] || r.status}\n`));
    // 1. 执行目标
    console.log(chalk.bold('  执行目标'));
    console.log(`    ${r.goal || chalk.dim('(无)')}`);
    // 2. 执行计划
    if (r.plan) {
      console.log(chalk.bold('\n  执行计划'));
      console.log(`    ${r.plan.replace(/\n/g, '\n    ')}`);
    }
    // 3. 工具调用链
    console.log(chalk.bold('\n  工具调用链'));
    if (!r.toolChain || r.toolChain.length === 0) {
      console.log(chalk.dim('    (无)'));
    } else {
      for (const c of r.toolChain) {
        const ci =
          c.status === 'ok'
            ? chalk.green('✓')
            : c.status === 'denied'
              ? chalk.red('⊘')
              : chalk.red('✗');
        const gate = c.stepType === 'human-gate' ? chalk.red('人闸门') : '';
        console.log(
          `    ${ci} ${String(c.seq).padStart(2)}. ${chalk.cyan(c.tool)} ` +
            `${_riskTag(c.risk)} ${chalk.dim(`${c.elapsedMs}ms · ${PERMISSION_LABEL_ZH[c.permission] || c.permission}`)}${gate}`
        );
        if (c.error) {
          console.log(chalk.red(`        ↳ ${c.error}`));
        }
      }
    }
    // 4. 产物与变更
    console.log(chalk.bold('\n  产物与变更'));
    if (r.artifacts?.files?.length) {
      for (const f of r.artifacts.files) {
        console.log(`    ${chalk.magenta(ACTION_LABEL_ZH[f.action] || f.action)} ${f.path}`);
      }
    } else {
      console.log(chalk.dim('    (无文件变更)'));
    }
    if (r.artifacts?.summary) {
      console.log(`    ${chalk.dim(r.artifacts.summary)}`);
    }
    // 5. 风险与审批
    console.log(chalk.bold('\n  风险与审批'));
    console.log(`    最高风险: ${_riskTag(r.riskApproval?.maxRisk || 'safe')}`);
    console.log(
      `    人闸门: ${r.riskApproval?.humanGated?.length || 0} · 拒绝: ${r.riskApproval?.denied?.length || 0}`
    );
    // 6. 错误信息
    if (r.error) {
      console.log(chalk.bold('\n  错误信息'));
      console.log(chalk.red(`    ${r.error}`));
    }
    // 遗留/半写记录可能缺 durationMs；直接模板插值会吐 "耗时 undefinedms"（同 _fmtTime 病因）。
    const dur = typeof r.durationMs === 'number' && Number.isFinite(r.durationMs)
      ? `耗时 ${r.durationMs}ms`
      : '耗时 未知';
    console.log(
      chalk.dim(
        `\n  ${r.counts?.ok || 0} 成功 / ${r.counts?.failed || 0} 失败 · ` +
          `${dur}${r.gitCommit ? ` · commit ${r.gitCommit.slice(0, 8)}` : ''}\n`
      )
    );
    return true;
  }

  if (cmd === 'search') {
    const kw = args[0];
    if (!kw) {
      printError('用法: receipts search <keyword>');
      _markFailure();
      return true;
    }
    const hits = svc.searchReceipts(kw, { limit: parseInt(options.limit, 10) || 30 });
    console.log(chalk.bold(`\n  搜索 "${kw}"\n`));
    if (hits.length === 0) {
      printInfo('无匹配回执');
    } else {
      for (const h of hits) {
        const icon = STATUS_ICON[h.status] || chalk.dim('•');
        console.log(`  ${icon} ${chalk.cyan(h.id)} ${chalk.dim(_fmtTime(h.startedAt))}`);
        if (h.goal) {
          console.log(`     ${chalk.dim(h.goal)}`);
        }
      }
    }
    console.log('');
    return true;
  }

  if (cmd === 'orchestration' || cmd === 'orch') {
    const limit = parseInt(options.limit, 10) || 20;
    const rows = svc.listOrchestrationReceipts({ limit });
    console.log(chalk.bold('\n  编排回执\n'));
    if (rows.length === 0) {
      // Writer is saveOrchestrationReceipt, called only from AgentTool — so the
      // way out is a sub-agent run, not a command.
      printInfo('暂无编排回执：编排回执只由子智能体（Agent 委派）运行时写入');
      console.log('');
      return true;
    }
    for (const r of rows) {
      const icon = STATUS_ICON[r.status] || chalk.dim('•');
      const dur = ccFormatDurationOr(
        r.totalDurationMs || 0,
        `${((r.totalDurationMs || 0) / 1000).toFixed(1)}s`,
        process.env
      );
      console.log(
        `  ${icon} ${chalk.cyan(r.id)} ${chalk.magenta(`[${r.mode}]`)} ` +
          `${chalk.dim(`${r.successCount}/${r.subtaskCount} 成功 · ${dur}`)}`
      );
      if (r.goal) {
        console.log(`     ${chalk.dim(r.goal)}`);
      }
      const exec = Object.entries(r.byExecutor || {})
        .map(([k, v]) => `${k}:${v}`)
        .join(' ');
      const steps = Object.entries(r.byStepType || {})
        .map(([k, v]) => `${k}:${v}`)
        .join(' ');
      if (exec || steps) {
        console.log(chalk.dim(`     executors[${exec}] steps[${steps}]`));
      }
    }
    console.log(chalk.dim(`\n  共 ${rows.length} 条\n`));
    return true;
  }

  // 任务达成率对账：轨迹（toolLoop journal）⟂ 裁决（receipts），按 requestId 连接。
  // 覆盖率是这张表的主行，不是脚注——对不上账就没有「率」，只有猜测。
  if (cmd === 'stats') {
    let journal = null;
    let all = [];
    try {
      journal = require('../../services/tool/toolLoopJournal');
    } catch {
      /* 模块不可用 → 按 0 覆盖如实报，不编数 */
    }
    try {
      all = require('../../services/receiptService').listReceipts({ full: true });
    } catch {
      /* 同上 */
    }

    const runs = journal ? journal.listRunIds().map((id) => journal.readJournal(id)) : [];
    const runById = new Map();
    const bySource = new Map();
    let workMeasurable = 0;
    let workAchieved = 0;
    const byReason = new Map();
    let withEnd = 0;
    let withRequestId = 0;
    let truncated = 0;
    let zeroTool = 0;
    let guardHits = 0;
    let guardRuns = 0;
    let guardEnded = 0;
    for (const recs of runs) {
      let start = null;
      let end = null;
      for (const r of recs) {
        if (r.type === 'start') start = r;
        else if (r.type === 'end') end = r;
      }
      if (!start) continue;
      if (start.requestId) {
        withRequestId += 1;
        runById.set(String(start.requestId), { start, end });
      }
      if (!end) continue;
      withEnd += 1;
      const reason = String(end.reason || 'unknown');
      byReason.set(reason, (byReason.get(reason) || 0) + 1);
      if (reason === 'max-iterations') truncated += 1;
      if ((Number(end.totalToolCalls) || 0) === 0) zeroTool += 1;
      // 护栏掐断动作的读数：只有改造后的新 run 才带这两个字段，历史 run 为 null。
      const gi = Number(end.guardInterventions) || 0;
      if (gi > 0) { guardHits += gi; guardRuns += 1; }
      if (end.endedOnGuard === true) guardEnded += 1;
    }

    const receiptByReq = new Map();
    for (const r of all) {
      if (r && r.requestId) receiptByReq.set(String(r.requestId), r);
    }
    // 可度量 = 同一回合既有终点记录、又有裁决。这是达成率唯一的合法分母。
    let measurable = 0;
    let achieved = 0;
    for (const [reqId, run] of runById) {
      if (!run.end) continue;
      const rc = receiptByReq.get(reqId);
      if (!rc || !rc.outcome || typeof rc.outcome.achieved !== 'boolean') continue;
      measurable += 1;
      if (rc.outcome.achieved) achieved += 1;
      // 出处切分：夹具/测试流量必须能被单列出去，否则比率是对着一堆探针算的。
      const src = String(run.start.source || rc.source || '未标注');
      bySource.set(src, (bySource.get(src) || 0) + 1);
      if (src !== 'test' && src !== '未标注') {
        workMeasurable += 1;
        if (rc.outcome.achieved) workAchieved += 1;
      }
    }
    const legacyNoOutcome = all.filter((r) => !r.outcome).length;
    const superseded = all.filter((r) => r.finalizeReason === 'superseded').length;
    // 裁决族分布：intent-unfulfilled 是「模型宣告要做、本轮零工具却按完成收口」那一族。
    const verdicts = new Map();
    for (const r of all) {
      const v = (r.outcome && r.outcome.verdict) || 'no-outcome';
      verdicts.set(v, (verdicts.get(v) || 0) + 1);
    }
    const tagged = all.filter((r) => r.source).length;
    const pct = (n, d) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—');

    console.log(chalk.bold(`\n  任务达成率对账 · 轨迹 ${runs.length} 个 run · 回执 ${all.length} 张`));
    console.log(`    终点覆盖      ${withEnd}/${runs.length}  ${pct(withEnd, runs.length)}`);
    console.log(`    requestId 覆盖 ${withRequestId}/${runs.length}  ${pct(withRequestId, runs.length)}`);
    console.log(`    可对账回合    ${measurable}  ${pct(measurable, runs.length)}`);
    if (measurable > 0) {
      console.log(chalk.green(`    达成率        ${achieved}/${measurable}  ${pct(achieved, measurable)}`));
      console.log(`    截断率        ${truncated}/${withEnd}  ${pct(truncated, withEnd)}`);
      console.log(`    零工具直答    ${zeroTool}/${withEnd}  ${pct(zeroTool, withEnd)}`);
    } else {
      printInfo('    达成率        不可计算：没有同时具备「终点记录 + 裁决」的回合');
    }
    if (bySource.size) {
      console.log(chalk.dim(
        '    出处切分      ' + [...bySource.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ':' + v).join(' · ')
      ));
    }
    if (workMeasurable > 0) {
      console.log(chalk.green(
        '    真人/业务达成 ' + workAchieved + '/' + workMeasurable + '  '
        + (workMeasurable ? (100 * workAchieved / workMeasurable).toFixed(1) + '%' : '—')
      ));
    }
    // 任务被自家闸门掐断的直接读数：拦停发生几次、波及几个 run、
    // 以及其中多少个 run 在拦停后就再没有下一步动作。
    if (guardHits > 0) {
      console.log(chalk.yellow(
        `    护栏拦停      ${guardHits} 次 / ${guardRuns} 个 run`
        + `，其中 ${guardEnded} 个 run 拦停后即收尾  ${pct(guardEnded, guardRuns)}`
      ));
    }
    const reasons = [...byReason.entries()].sort((a, b) => b[1] - a[1]);
    if (reasons.length) {
      console.log(chalk.dim(`    终点原因      ${reasons.map(([k, v]) => `${k}:${v}`).join(' · ')}`));
    }
    const vrows = [...verdicts.entries()].sort((a, b) => b[1] - a[1]);
    if (vrows.length) {
      console.log(chalk.dim(`    裁决族        ${vrows.map(([k, v]) => `${k}:${v}`).join(' · ')}`));
    }
    // 分母纯度：回执里没有任何出处标记时，测试/自动化流量与真人请求混在同一分母内。
    console.log(chalk.dim(
      `    出处标注      ${tagged}/${all.length}  ${pct(tagged, all.length)}`
      + (tagged === 0 ? '  ← 全部未标注，分母混有测试/自动化流量' : '')
    ));
    // 改造前落盘的数据不带 requestId、多数没有 end，无法回溯，只能等新一轮累积。
    if (legacyNoOutcome > 0 || withEnd < runs.length) {
      console.log(chalk.yellow(
        `\n  ⚠ 覆盖率不足：${legacyNoOutcome} 张回执无裁决字段（改造前落盘），`
        + `${runs.length - withEnd} 个 run 没有终点记录。`
        + `\n    上面的比率只对「可对账回合」成立，不代表历史全量。`
      ));
    }
    if (superseded > 0) {
      console.log(chalk.dim(
        `  · ${superseded} 张回执 finalizeReason=superseded（被下一轮顶掉的遗留，非任务失败）`
      ));
    }
    console.log('');
    return true;
  }

  // r222 门型(r219/r220):`receipts help` 走用法墙 rc=0,不进 ✗/rc=1 回捞门。
  if (cmd === 'help') {
    printInfo(`用法: receipts ${SUB_COMMANDS.join(' | ')}`);
    return true;
  }

  printError(`未知子命令: receipts ${cmd} (支持: ${SUB_COMMANDS.join(' | ')})`);
  _markFailure();
  return true;
}

module.exports = {
  handleReceipts,
  _fmtTime,
  [MANIFEST_EXPORT_KEY]: {
    name: 'receipts',
    description: '浏览结构化执行回执（A3 审计）',
    category: 'system',
    // orch/orchestration are dispatched below but absent from the static router
    // sub-command table, so the typed token would stay in args[0] and the list
    // branch would answer for a view the user never asked for. Declaring them
    // lets commandAutoRegistry._alignSubCommand reconcile it.
    subCommands: SUB_COMMANDS,
    handler: async (parsed) => handleReceipts(parsed.subCommand, parsed.args, parsed.options),
  },
};
