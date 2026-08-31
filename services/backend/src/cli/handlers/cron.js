'use strict';

/**
 * Cron Command Handler — manage cron-scheduled jobs.
 *
 * Commands:
 *   cron list                          — list all cron jobs
 *   cron add "<cron>" "<prompt>" [opts] — add a new cron job
 *   cron remove <id>                   — remove a cron job
 *   cron enable <id>                   — enable a disabled job
 *   cron disable <id>                  — disable a job
 *   cron status                        — scheduler status + next fire times
 *
 * @module handlers/cron
 */
const { MANIFEST_EXPORT_KEY } = require('../commandManifest');
const chalk = require('chalk').default || require('chalk');
const { printSuccess, printError, printInfo, printTable } = require('../formatters');
const _markFailure = require('../../utils/markProcessFailure');

async function handleCronCommand(subCommand, args, options) {
  switch (subCommand) {
    case 'list':
    case undefined:
    case '':
      return handleCronList();
    case 'add':
      return handleCronAdd(args, options);
    case 'remove':
    case 'rm':
    case 'delete':
      return handleCronRemove(args[0]);
    case 'enable':
      return handleCronEnable(args[0]);
    case 'disable':
      return handleCronDisable(args[0]);
    case 'status':
      return handleCronStatus();
    case 'help':
      return _printHelp();
    default: {
      // parseInput's subCommand gating (#143) hands the router's fallback a null
      // subCommand for BOTH bare `cron` and unknown verbs, so the rejected token
      // has to be recovered from args. Bare and `help` are legitimate rc=0 exits;
      // an unknown verb must echo and exit 1 so `cron bogus && next` stops (#82 族).
      const token = String(subCommand || (args && args[0]) || '').trim();
      if (!token || token === 'help') return _printHelp();
      printError(`未知子命令: cron ${token}（'cron help' 查看用法）`);
      _markFailure();
      return _printHelp();
    }
  }
}

// ── Subcommand handlers ──────────────────────────────────────────

function handleCronList() {
  const cron = require('../../services/cronScheduler');
  const jobs = cron.listJobs();

  if (jobs.length === 0) {
    printInfo('暂无定时任务。用 `cron add "<cron>" "<提示词>"` 新建一条。');
    return;
  }

  console.log('');
  console.log(chalk.bold(`  定时任务 (${jobs.length})`));
  console.log('');

  const rows = jobs.map((j) => ({
    ID: j.id,
    Cron: j.cron,
    提示词: j.prompt.length > 40 ? j.prompt.slice(0, 37) + '...' : j.prompt,
    通道: j.channel || '-',
    启用: j.enabled ? chalk.green('是') : chalk.dim('否'),
    最近执行: j.lastRunAt ? new Date(j.lastRunAt).toLocaleString('zh-CN') : '-',
  }));

  printTable(rows);
}

function handleCronAdd(args, options) {
  const cron = require('../../services/cronScheduler');

  // Parse: cron add "*/5 * * * *" "run daily report" --channel slack:general --no-agent
  // args[0] = cron expression, args[1..] = prompt parts
  if (args.length < 2) {
    printError(
      '缺少参数：`cron add "<cron 表达式>" "<提示词>" [--channel <通道>] [--no-agent]'
    );
    _markFailure();
    return;
  }

  const cronExpr = args[0];
  const prompt = args.slice(1).join(' ');

  try {
    const { id, job } = cron.addJob({
      cron: cronExpr,
      prompt,
      channel: options.channel || null,
      noAgent: options.noAgent || options['no-agent'] || false,
      contextFrom: options.contextFrom || options['context-from'] || null,
      maxRuntimeMs: options.timeout ? parseInt(options.timeout, 10) * 1000 : undefined,
    });

    printSuccess(`已创建定时任务：${id}`);
    console.log(chalk.dim(`  排程   ：${job.cron}`));
    console.log(chalk.dim(`  提示词 ：${job.prompt}`));
    if (job.channel) {
      console.log(chalk.dim(`  通道   ：${job.channel}`));
    }
    if (job.noAgent) {
      console.log(chalk.dim(`  模式   ：纯 shell（不调 AI）`));
    }
    console.log('');
  } catch (err) {
    printError(`创建定时任务失败：${err.message}；请检查 cron 表达式（5 字段）与提示词是否非空。`);
    _markFailure();
  }
}

function handleCronRemove(id) {
  if (!id) {
    printError('缺少任务 ID：`cron remove <job-id>`（列表见 `cron list`）。');
    _markFailure();
    return;
  }

  const cron = require('../../services/cronScheduler');
  const ok = cron.removeJob(id);
  if (ok) {
    printSuccess(`已删除定时任务：${id}`);
  } else {
    printError(`未找到任务 ${id}：跑 'cron list' 核对 ID。`);
    _markFailure();
  }
}

function handleCronEnable(id) {
  if (!id) {
    printError('缺少任务 ID：`cron enable <job-id>`（列表见 `cron list`）。');
    _markFailure();
    return;
  }

  const cron = require('../../services/cronScheduler');
  const ok = cron.enableJob(id);
  if (ok) {
    printSuccess(`已启用定时任务：${id}`);
  } else {
    printError(`未找到任务 ${id}：跑 'cron list' 核对 ID。`);
    _markFailure();
  }
}

function handleCronDisable(id) {
  if (!id) {
    printError('缺少任务 ID：`cron disable <job-id>`（列表见 `cron list`）。');
    _markFailure();
    return;
  }

  const cron = require('../../services/cronScheduler');
  const ok = cron.disableJob(id);
  if (ok) {
    printSuccess(`已停用定时任务：${id}`);
  } else {
    printError(`未找到任务 ${id}：跑 'cron list' 核对 ID。`);
    _markFailure();
  }
}

function handleCronStatus() {
  const cron = require('../../services/cronScheduler');
  const jobs = cron.listJobs();
  const enabled = jobs.filter((j) => j.enabled);
  const disabled = jobs.filter((j) => !j.enabled);

  console.log('');
  console.log(chalk.bold('  定时任务调度器状态'));
  console.log('');
  console.log(`  任务总数 ：${jobs.length}`);
  console.log(`  已启用   ：${chalk.green(enabled.length)}`);
  console.log(`  已停用   ：${chalk.dim(disabled.length)}`);
  console.log(`  心跳间隔 ：60 秒`);
  console.log(`  硬超时   ：${cron.DEFAULT_MAX_RUNTIME_MS / 1000} 秒 / 任务`);
  console.log('');

  if (enabled.length > 0) {
    console.log(chalk.bold('  生效中的任务：'));
    for (const j of enabled) {
      const lastRun = j.lastRunAt ? new Date(j.lastRunAt).toLocaleString('zh-CN') : '从未执行';
      console.log(
        `    ${chalk.cyan(j.id)}  ${chalk.dim(j.cron)}  ${j.prompt.slice(0, 40)}  (最近: ${lastRun})`
      );
    }
    console.log('');
  }
}

function _printHelp() {
  console.log('');
  console.log(chalk.bold('  定时任务（cron） — 持久化排程'));
  console.log('');
  console.log('  用法：');
  console.log(chalk.dim('    cron list                                 列出全部任务'));
  console.log(chalk.dim('    cron add "<cron>" "<提示词>"              新建一条任务'));
  console.log(chalk.dim('    cron remove <id>                          删除任务'));
  console.log(chalk.dim('    cron enable <id>                          启用已停用的任务'));
  console.log(chalk.dim('    cron disable <id>                         停用任务'));
  console.log(chalk.dim('    cron status                               查看调度器状态'));
  console.log('');
  console.log('  选项：');
  console.log(
    chalk.dim('    --channel <通道>        执行结果投递到指定通道（例：slack:general）')
  );
  console.log(
    chalk.dim('    --no-agent              纯 shell 模式（把提示词当命令执行，不调 AI）')
  );
  console.log(
    chalk.dim('    --context-from <id>     链式：把上一条任务的结果注入当前提示词')
  );
  console.log(chalk.dim('    --timeout <秒>          单任务超时（默认 180 秒）'));
  console.log('');
  console.log('  示例：');
  console.log(chalk.dim('    cron add "0 9 * * 1-5" "生成每日行情报告"'));
  console.log(chalk.dim('    cron add "*/30 * * * *" "df -h" --no-agent'));
  console.log(chalk.dim('    cron add "0 8 * * *" "morning briefing" --channel slack:general'));
  console.log('');
}

module.exports = {
  handleCronCommand,
  [MANIFEST_EXPORT_KEY]: {
    name: 'cron',
    description: '定时任务（cron 排程）',
    category: 'system',
    handler: async (parsed) => handleCronCommand(parsed.subCommand, parsed.args, parsed.options),
  },
};
