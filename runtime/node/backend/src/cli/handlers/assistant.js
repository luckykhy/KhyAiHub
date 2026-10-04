/**
 * Assistant CLI Handler — commands for KAIROS persistent assistant mode.
 *
 * Commands:
 *   assistant on/off     — Toggle assistant mode
 *   assistant status     — Show current status
 *   assistant dream      — Manually trigger memory consolidation
 *   assistant log        — Show today's daily log
 *   brief                — Morning briefing (today's log summary)
 */
'use strict';

const { padToWidth } = require('../formatters');

let _chalk;
function chalk() {
  if (_chalk) {
    return _chalk;
  }
  const m = require('chalk');
  _chalk = m.default || m;
  return _chalk;
}

/**
 * Handle /assistant CLI command.
 * @param {string} subCommand - on/off/status/dream/log/brief
 * @param {string[]} args
 * @param {object} options
 * @returns {Promise<boolean>}
 */
async function handleAssistantCommand(subCommand, args, options) {
  const c = chalk();

  // Feature gate
  try {
    const { isEnabled } = require('../../services/featureFlags');
    if (!isEnabled('assistant')) {
      console.log(
        c.gray('助手功能已关闭。设置 KHY_FEATURE_ASSISTANT=true 可开启。')
      );
      return true;
    }
  } catch {
    /* no feature flags */
  }

  const assistant = require('../../assistant');

  switch (subCommand) {
    case 'on':
    case 'activate': {
      assistant.activate();
      console.log(c.green('\n  KAIROS 助手模式已开启。'));
      console.log(
        c.gray('  将记录每日日志；满足条件时自动进行记忆整理。\n')
      );
      return true;
    }

    case 'off':
    case 'deactivate': {
      assistant.deactivate();
      console.log(c.yellow('\n  助手模式已关闭。\n'));
      return true;
    }

    case 'status': {
      const status = assistant.getStatus();
      console.log(c.bold('\n  KAIROS 助手状态'));
      console.log(c.gray('  ' + '\u2500'.repeat(35)));
      const lw = 12;
      console.log(`  ${padToWidth('模式:', lw)}${status.active ? c.green('运行中') : c.gray('未运行')}`);
      console.log(`  ${padToWidth('主动:', lw)}${status.proactive ? c.green('开') : c.gray('关')}`);
      console.log(`  ${padToWidth('日志文件:', lw)}${c.cyan(status.logCount)}`);
      console.log(`  ${padToWidth('上次整理:', lw)}${c.cyan(status.lastDream === 'never' ? '从未' : status.lastDream)}`);
      console.log(`  ${padToWidth('待整理:', lw)}${status.dreamNeeded ? c.yellow('是') : c.gray('否')}`);
      if (status.dreamReason) {
        console.log(`  ${padToWidth('原因:', lw)}${c.gray(status.dreamReason)}`);
      }
      console.log('');
      return true;
    }

    case 'dream': {
      console.log(c.cyan('\n  开始记忆整理（dream）……\n'));

      let aiModule;
      try {
        aiModule = require('../ai');
      } catch {
        aiModule = null;
      }

      const result = await assistant.runDream(aiModule);
      if (result.success) {
        console.log(c.green('  记忆整理完成！'));
        console.log(c.gray(`  阶段: ${result.phases.join(' → ')}`));
        if (result.filesCreated.length > 0) {
          console.log(c.gray(`  文件: ${result.filesCreated.join(', ')}`));
        }
      } else {
        console.log(c.red(`  记忆整理失败: ${result.error}`));
      }
      console.log('');
      return true;
    }

    case 'log': {
      const log = assistant.readTodayLog();
      if (log) {
        console.log(c.bold('\n  今日日志'));
        console.log(c.gray('  ' + '\u2500'.repeat(35)));
        console.log(log);
      } else {
        console.log(c.gray('\n  今日暂无日志。\n'));
      }
      return true;
    }

    case 'brief': {
      const recentLogs = assistant.getRecentLogs(3);
      if (recentLogs.length === 0) {
        console.log(c.gray('\n  暂无可摘要的近期活动。\n'));
        return true;
      }

      console.log(c.bold('\n  晨间简报'));
      console.log(c.gray('  ' + '\u2500'.repeat(35)));

      for (const { date, content } of recentLogs) {
        console.log(c.cyan(`\n  ${date}`));
        // Show first 5 entries from each day
        const entries = content.split(/^## /m).filter(Boolean).slice(0, 5);
        for (const entry of entries) {
          const firstLine = entry.split('\n')[0].trim();
          if (firstLine) {
            console.log(c.gray(`    \u2022 ${firstLine}`));
          }
        }
      }
      console.log('');
      return true;
    }

    case 'commitment':
    case 'commitments': {
      const ct = require('../../services/commitmentTrack');
      const action = (args[0] || 'list').toLowerCase();
      const idArg = args[1] || '';
      if (action === 'expire') {
        const n = ct.expireOld();
        console.log(c.gray(`\n  已清理 ${n} 条过期承诺。\n`));
        return true;
      }
      if (action === 'sent' || action === 'dismiss') {
        if (!idArg) {
          console.log(c.gray(`用法: assistant commitment ${action} <id 前8位>`));
          return true;
        }
        const all = ct.listCommitments();
        const match = all.find((r) => r.id && r.id.startsWith(idArg));
        if (!match) {
          console.log(c.yellow(`未找到承诺: ${idArg}`));
          return true;
        }
        if (action === 'sent') {
          ct.markSent(match.id);
          console.log(c.green(`\n  已标记「${match.id.slice(0, 8)}」为已发。\n`));
        } else {
          ct.dismiss(match.id);
          console.log(c.gray(`\n  已忽略「${match.id.slice(0, 8)}」。\n`));
        }
        return true;
      }
      const all = ct.listCommitments();
      if (all.length === 0) {
        console.log(c.gray('\n  暂无承诺记录。\n'));
        return true;
      }
      console.log(c.bold('\n  承诺 / 提醒'));
      console.log(c.gray('  ' + '\u2500'.repeat(35)));
      for (const rec of all) {
        const kindLabel =
          {
            event_check_in: '事件回访',
            deadline_check: '截止提醒',
            care_check_in: '关怀回访',
            open_loop: '未闭合事项',
          }[rec.kind] || rec.kind;
        const status = rec.status === 'pending' ? c.yellow('待办') : c.gray(rec.status);
        const due =
          rec.dueWindow && rec.dueWindow.earliestMs
            ? new Date(rec.dueWindow.earliestMs).toLocaleString('zh-CN')
            : '';
        console.log(
          `  ${c.cyan(rec.id.slice(0, 8))} [${kindLabel}] ${status}${due ? ' · ' + due : ''}`
        );
        if (rec.suggestedText) {
          console.log(c.gray(`      ${rec.suggestedText}`));
        }
      }
      console.log('');
      console.log(c.gray('  assistant commitment <id 前8位>   — 标记为已发'));
      console.log(c.gray('  assistant commitment dismiss <id> — 忽略'));
      console.log(c.gray('  assistant commitment expire       — 清理过期'));
      console.log('');
      return true;
    }

    default: {
      const status = assistant.getStatus();
      console.log(c.bold('\n  KAIROS 助手'));
      console.log(c.gray('  ' + '\u2500'.repeat(35)));
      console.log(`  状态: ${status.active ? c.green('运行中') : c.gray('未运行')}`);
      console.log('');
      console.log(c.gray('  命令:'));
      console.log(c.gray('    assistant on      — 开启'));
      console.log(c.gray('    assistant off     — 关闭'));
      console.log(c.gray('    assistant status  — 查看状态'));
      console.log(c.gray('    assistant dream   — 手动记忆整理'));
      console.log(c.gray('    assistant log     — 查看今日日志'));
      console.log(c.gray('    brief             — 晨间简报'));
      console.log(
        c.gray(
          '    assistant commitment — 承诺/提醒追踪 (list / sent <id> / dismiss <id> / expire)'
        )
      );
      console.log('');
      return true;
    }
  }
}

module.exports = { handleAssistantCommand };
