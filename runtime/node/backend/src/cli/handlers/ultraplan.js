/**
 * Ultraplan CLI Handler — deep planning with extended AI sessions.
 *
 * Usage:
 *   ultraplan <prompt>   — Start a 30-minute deep planning session
 *   ultraplan status     — Show active/completed sessions
 *   ultraplan list       — List all sessions
 */
'use strict';

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
 * Handle /ultraplan <prompt> command.
 * @param {string[]} args
 * @param {object} options
 * @returns {Promise<boolean>}
 */
async function handleUltraplanCommand(args, options) {
  const c = chalk();

  // Feature gate
  try {
    const { isEnabled } = require('../../services/featureFlags');
    if (!isEnabled('ultraplan')) {
      console.log(
        c.gray('Ultraplan 功能已被关闭：设置环境变量 KHY_FEATURE_ULTRAPLAN=true 后重试。')
      );
      return true;
    }
  } catch {
    /* no feature flags */
  }

  const prompt = args.join(' ').trim();
  if (!prompt) {
    console.log(c.yellow('\n  用法: ultraplan <你的规划需求>'));
    console.log(c.gray('  示例: ultraplan 为用户认证设计微服务架构\n'));
    return true;
  }

  const { startSession } = require('../../services/ultraplanService');

  console.log(c.cyan('\n  开始深度规划会话…'));
  console.log(c.gray(`  需求: ${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}`));
  console.log(c.gray('  超时: 30 分钟\n'));

  const session = await startSession(prompt);

  console.log(c.green(`  会话 ${c.bold(session.id)} 已创建。`));
  console.log(c.gray('  规划正在后台运行。'));
  console.log(c.gray(`  查看进度: ${c.cyan('ultraplan status')}\n`));

  // Poll for completion with simple spinner
  let dots = 0;
  let waitedSec = 0;
  const poll = setInterval(() => {
    const { getSession } = require('../../services/ultraplanService');
    const current = getSession(session.id);
    if (!current || current.status === 'completed' || current.status === 'failed') {
      clearInterval(poll);
      _showResult(current, c);
    } else {
      dots = (dots + 1) % 4;
      waitedSec += 2;
      process.stdout.write(
        `\r  ${c.cyan('规划中' + '.'.repeat(dots).padEnd(3))}  ${c.gray(`(已 ${waitedSec}s)`)}  `
      );
    }
  }, 2000);

  // Wait for completion (with timeout)
  await new Promise((resolve) => {
    const check = setInterval(() => {
      const { getSession } = require('../../services/ultraplanService');
      const current = getSession(session.id);
      if (!current || current.status !== 'running') {
        clearInterval(check);
        clearInterval(poll);
        resolve();
      }
    }, 1000);
    // Hard timeout
    setTimeout(
      () => {
        clearInterval(check);
        clearInterval(poll);
        resolve();
      },
      31 * 60 * 1000
    );
  });

  return true;
}

function _showResult(session, c) {
  if (!session) {
    console.log(c.red('\n  未找到该规划会话。\n'));
    return;
  }

  console.log('\n');

  if (session.status === 'failed') {
    console.log(c.red(`  规划失败: ${session.error}\n`));
    return;
  }

  if (session.result) {
    const r = session.result;
    // 会话时长走 ccFormatDuration SSOT(门控 KHY_CC_FORMAT):多分钟/小时会话
    // 显 "5m 0s"/"1h 0m 0s" 而非裸 "300s"/"3600s"。门控关 → 逐字节回退旧 `${toFixed(0)}s`。
    const _durMs = session.completedAt - session.startedAt;
    const _durLegacy = `${(_durMs / 1000).toFixed(0)}s`;
    const elapsed = require('../ccFormat').ccFormatDurationOr(_durMs, _durLegacy, process.env);

    console.log(c.bold.cyan('  === 深度规划结果 ==='));
    console.log(c.gray(`  会话: ${session.id} | 耗时: ${elapsed}`));
    console.log(c.gray('  ' + '─'.repeat(50)));

    if (r.title) {
      console.log(c.bold(`\n  ${r.title}`));
    }
    if (r.analysis) {
      console.log(c.white(`\n  分析:\n  ${r.analysis.slice(0, 500)}`));
    }
    if (r.steps) {
      console.log(c.green(`\n  步骤:\n  ${r.steps.slice(0, 1000)}`));
    }
    if (r.risks) {
      console.log(c.yellow(`\n  风险:\n  ${r.risks.slice(0, 300)}`));
    }
    if (r.testing) {
      console.log(c.cyan(`\n  测试:\n  ${r.testing.slice(0, 300)}`));
    }

    console.log(c.gray('\n  ' + '─'.repeat(50)));
    console.log(c.gray(`  完整方案已保存: ~/.khyquant/ultraplans/${session.id}.json\n`));
  }
}

/**
 * Handle ultraplan status / list command.
 * @returns {Promise<boolean>}
 */
async function handleUltraplanStatus() {
  const c = chalk();
  const { listSessions } = require('../../services/ultraplanService');

  const sessions = listSessions();
  if (sessions.length === 0) {
    console.log(c.gray('\n  暂无规划会话。\n'));
    return true;
  }

  console.log(c.bold('\n  Ultraplan 会话列表'));
  console.log(c.gray('  ' + '─'.repeat(60)));

  const _ccFmt = require('../ccFormat');
  for (const s of sessions.slice(0, 10)) {
    const statusColor =
      s.status === 'completed' ? c.green : s.status === 'running' ? c.cyan : c.red;
    // 时长走 ccFormatDuration SSOT;运行中的 `...` 尾缀在 *Or 外拼接(门控关逐字节回退)。
    const elapsed = s.completedAt
      ? _ccFmt.ccFormatDurationOr(
          s.completedAt - s.startedAt,
          `${((s.completedAt - s.startedAt) / 1000).toFixed(0)}s`,
          process.env
        )
      : _ccFmt.ccFormatDurationOr(
          Date.now() - s.startedAt,
          `${((Date.now() - s.startedAt) / 1000).toFixed(0)}s`,
          process.env
        ) + '...';

    console.log(
      `  ${c.gray(s.id)} ${statusColor(s.status.padEnd(10))} ${c.gray(elapsed)} ${s.prompt.slice(0, 40)}`
    );
  }
  console.log('');
  return true;
}

module.exports = { handleUltraplanCommand, handleUltraplanStatus };
