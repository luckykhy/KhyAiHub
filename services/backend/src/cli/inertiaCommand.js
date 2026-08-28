'use strict';

/**
 * inertiaCommand.js — `khy inertia` 命令族（S1 仅 run，[DESIGN-ARCH-160] §3.3 路径 C）。
 *
 * 人或脚本蹬一脚：`khy inertia run --plan <plan.json>`。
 * 退出码对齐 printOutputFormat.resolveExitCode 语义：completed=0；
 * budget/decay/ambiguity/external=3（可重试）；error/privilege/rejected=2。
 * S2 才补 status/stop/resume 子命令（方案 §4）。
 */

const path = require('path');

const EXIT_CODES = {
  completed: 0,
  budget: 3,
  decay: 3,
  ambiguity: 3,
  external: 3,
  error: 2,
  privilege: 2,
  rejected: 2,
};

async function handleInertiaCommand(args, io = {}) {
  const printSuccess = io.printSuccess || ((s) => console.log(s));
  const printError = io.printError || ((s) => console.error(s));
  const printInfo = io.printInfo || ((s) => console.log(s));

  const sub = String(args[0] || '');
  if (sub !== 'run') {
    printError('用法: khy inertia run --plan <plan.json>   （S1 仅支持 run；status/stop/resume 属 S2）');
    return true;
  }

  const pIdx = args.indexOf('--plan');
  const planFile = pIdx !== -1 ? args[pIdx + 1] : null;
  if (!planFile) {
    printError('缺少 --plan <plan.json>。惯性单 schema 见 [DESIGN-ARCH-160] §3.2。');
    return true;
  }

  const { runInertialPlan } = require('../services/inertia/inertialRunService');

  // 与 -p 无头同款前置（bin/khy.js:1783）；认证状态由 chat 自身的失败信封如实暴露
  process.env.KHYQUANT_AI_MODE = 'true';

  printInfo(`[惯性执行] 蹬一脚：${path.resolve(planFile)}`);
  let envelope;
  try {
    envelope = await runInertialPlan(path.resolve(planFile), { out: process.stdout });
  } catch (e) {
    printError(`[惯性执行] 控制器异常退出：${(e && e.message) || e}`);
    process.exitCode = 2;
    return true;
  }

  if (!envelope || envelope.status === 'rejected') {
    const errs = envelope && Array.isArray(envelope.errors) && envelope.errors.length > 0
      ? '：' + envelope.errors.map((x) => `${x.field}(${x.reason})`).join(', ')
      : '';
    printError(`[惯性执行] 拒绝启动（${(envelope && envelope.statusReason) || 'unknown'}）${errs}`);
    process.exitCode = EXIT_CODES.rejected;
    return true;
  }

  const d = envelope.resume && envelope.resume.contextDigest ? envelope.resume.contextDigest : '';
  if (d) {
    printInfo('── contextDigest（四段式开局摘要）──');
    printInfo(d);
  }
  if (Array.isArray(envelope.disclosures) && envelope.disclosures.length > 0) {
    printInfo('── disclosures（必留）──');
    for (const line of envelope.disclosures) printInfo(`  · ${line}`);
  }

  process.exitCode = EXIT_CODES[envelope.status] != null ? EXIT_CODES[envelope.status] : 2;
  printSuccess(
    `[惯性执行] ${envelope.runId} 结束：status=${envelope.status}（${envelope.statusReason}），退出码 ${process.exitCode}`
  );
  return true;
}

module.exports = { handleInertiaCommand, EXIT_CODES };
