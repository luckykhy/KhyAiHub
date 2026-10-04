'use strict';

/**
 * 20 倍模式命令处理器 —— `khy 20x …`。
 *
 * CC 的「20x mode」= Max 20x 订阅(约 Pro 20 倍用量额度),体感是权力用户「满负荷跑」。
 * khy 自托管不受额度约束,对齐同一体感 → 一个可开关的满负荷档:开启后每个任务顶格投入算力
 * (effort=max + 扩展思考 + 更高工具迭代/并行子代理上限)。本命令是它对用户的入口:
 *
 *   20x            — 等同 20x status
 *   20x status     — 显示当前是否开启 + 各轴放大值
 *   20x on|off     — 持久化开启/关闭 KHY_20X_MODE(写入 .env,当前进程立即生效)
 *
 * 门控 opt-in(默认关):关 = 逐字节回退今日行为(effort/迭代/扇出不变)。
 *
 * @module handlers/twentyX
 */
const chalk = require('chalk').default || require('chalk');
const { MANIFEST_EXPORT_KEY } = require('../commandManifest');
const twentyXMode = require('../../services/twentyXMode');
const { printInfo, printError, printSuccess } = require('../formatters');
const _markFailure = require('../../utils/markProcessFailure');

function _handleStatus() {
  const s = twentyXMode.describeTwentyXState(process.env);
  printInfo(chalk.bold('20 倍模式(满负荷档)'));
  const tone = s.enabled ? chalk.green : chalk.yellow;
  console.log(`    状态:${tone(s.label)}(KHY_20X_MODE)`);
  if (s.hint) {
    console.log(`    ${chalk.dim(s.hint)}`);
  }
  console.log('');
  console.log(
    `    放大轴:effort=${chalk.cyan(s.effort)} · 工具循环迭代上限 ${chalk.cyan(s.maxIterations)} · 并行子代理扇出 ${chalk.cyan(`${s.maxChildren}/${s.maxTotalAgents}`)}`
  );
  console.log(
    `    说明:${chalk.dim('「20x」是模式名(沿用 CC 品牌语);khy 自托管不计费,放大取安全封顶值,非字面 20× 并行。')}`
  );
  console.log('');
  console.log(`    开关:${chalk.cyan('khy 20x on|off')}`);
  return true;
}

function _handleToggle(turnOn) {
  let writeEnvPatch;
  try {
    ({ _writeEnvPatch: writeEnvPatch } = require('./config'));
  } catch (err) {
    printError(`无法持久化开关:${(err && err.message) || err}`);
    _markFailure();
    return true;
  }
  const value = turnOn ? 'true' : 'false';
  let envPath;
  try {
    envPath = writeEnvPatch({ KHY_20X_MODE: value });
  } catch (err) {
    // Repro hci-r39: an unguarded throw escaped to the auto-registry's generic
    // catch (raw errno line), then handled:false re-routed the already-errored
    // command into the unknown-command fall-through. Own the error honestly.
    // Repro hci-r41: with canonical+mirror dual write the first file may already
    // be on disk — 「模式未改动」 would be the reverse-direction lie (a restart
    // WOULD flip the mode). Branch on the per-file outcome, and mark rc.
    const detail = err && err.path ? `:\n  ${err.path}` : '';
    const written = Array.isArray(err && err.envWriteWritten) ? err.envWriteWritten : [];
    const failed = (err && err.envWriteFailed) || (err && err.path) || '另一份 .env';
    printError(`20x 开关未能持久化：${(err && err.message) || err}`);
    if (written.length > 0) {
      printError(
        `半写入：${written.join('、')} 已写入 KHY_20X_MODE=${value}——重启后模式会切换；${failed} 未写入，两份 .env 已不一致。` +
          `请把已写入的内容同步到未写入的一份，或恢复其可写后重跑本命令${detail}`
      );
    } else {
      printError(
        `模式未改动(.env 与当前会话均未生效)。请确认 .env 目标路径的父目录存在且可写,或取消 KHY_ENV_FILE 覆盖后重试${detail}`
      );
    }
    _markFailure();
    return true;
  }
  process.env.KHY_20X_MODE = value; // 当前进程立即生效
  if (turnOn) {
    printSuccess(
      '20 倍模式已开启(KHY_20X_MODE=true)——每个任务顶格投入:effort=max + 扩展思考 + 更高迭代/并行上限。'
    );
  } else {
    printSuccess('20 倍模式已关闭(KHY_20X_MODE=false)——回到今日常规档。');
  }
  printInfo(`已写入:${envPath}`);
  return true;
}

/**
 * @param {{ subCommand?:string, args?:string[], options?:object }} parsed
 */
async function handleTwentyX(parsed = {}) {
  const sub = String(
    parsed.subCommand || (Array.isArray(parsed.args) && parsed.args[0]) || 'status'
  ).toLowerCase();
  switch (sub) {
    case 'on':
    case 'enable':
      return _handleToggle(true);
    case 'off':
    case 'disable':
      return _handleToggle(false);
    case 'status':
    case '':
      return _handleStatus();
    default:
      printError(`未知子命令:20x ${sub}`);
      printInfo('可用:khy 20x [status|on|off]');
      return true;
  }
}

module.exports = {
  handleTwentyX,
  [MANIFEST_EXPORT_KEY]: {
    name: '20x',
    aliases: ['20倍', '满负荷'],
    description: '20 倍满负荷模式：状态/开关（effort=max + 扩展思考 + 更高工具迭代上限）',
    usage: '20x [status|on|off]',
    subCommands: ['status', 'on', 'off'],
    category: 'system',
    handler: handleTwentyX,
  },
};
