/**
 * Receipts CLI handler — browse structured execution receipts (A3).
 *
 * Commands:
 *   khy receipts list [--session <id>] [--limit <n>]   — recent receipts
 *   khy receipts show <id>                              — full receipt detail
 *   khy receipts search <keyword>                       — full-text search
 *   khy receipts orch [--limit <n>]                     — orchestration receipts
 *     (alias: receipts orchestration; written only by sub-agent runs)
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
const SUB_COMMANDS = ['list', 'show', 'search', 'orch', 'orchestration'];

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
    console.log(chalk.bold('\n  📑 执行回执\n'));
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
    console.log(chalk.bold(`\n  📑 回执 ${chalk.cyan(r.id)}  ${icon} ${STATUS_LABEL_ZH[r.status] || r.status}\n`));
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
        const gate = c.stepType === 'human-gate' ? chalk.red(' 🔒人闸门') : '';
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
    console.log(chalk.bold(`\n  🔍 搜索 "${kw}"\n`));
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
    console.log(chalk.bold('\n  🧭 编排回执\n'));
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
