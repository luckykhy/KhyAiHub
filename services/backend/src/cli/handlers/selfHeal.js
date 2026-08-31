'use strict';

/**
 * SelfHeal Command Handler — khy 运行时路径自愈命令入口。
 *
 * 报告 bootstrap/moduleSelfHeal 钩子的开关、安装状态与自愈记录：
 *   khy selfheal           显示帮助
 *   khy selfheal status    查看开关/钩子/自愈记录
 *   khy selfheal test      自检钩子是否生效
 *   khy selfheal index     说明模块索引的惰性构建
 *
 * @module handlers/selfHeal
 */

const { MANIFEST_EXPORT_KEY } = require('../commandManifest');
const chalk = require('chalk').default || require('chalk');
const { printInfo, printWarn, printError } = require('../formatters');

// The hook lives in bootstrap/moduleSelfHeal.js and exposes only three read-only
// probes; everything below reports them. The former getStats/getModuleMap calls
// resolved through services/selfHeal (a stub that re-exports this very handler),
// so every branch threw "is not a function".
function _probe() {
  return require('../../bootstrap/moduleSelfHeal');
}

function _gateLine() {
  const v = process.env.KHY_MODULE_SELF_HEAL;
  return (v === undefined || v === '')
    ? '默认开启（未设置 KHY_MODULE_SELF_HEAL）'
    : `KHY_MODULE_SELF_HEAL=${v}`;
}

/**
 * @param {string} subCommand
 * @param {string[]} args
 * @param {object} options
 */
async function handleSelfHeal(subCommand, args = [], options = {}) {
  let heal;
  try {
    heal = _probe();
  } catch (err) {
    printError(`自愈模块加载失败：src/bootstrap/moduleSelfHeal.js 不可用 —— ${err.message}；请用 khy doctor 检查环境，或重新拉取该文件`);
    return true;
  }

  const enabled = heal.isEnabled();
  const installed = heal.isInstalled();
  const log = heal.getHealLog();

  if (options.status || subCommand === 'status') {
    console.log(chalk.bold('\n  📊 运行时路径自愈 · bootstrap/moduleSelfHeal'));
    console.log('');
    console.log(`    开关: ${enabled ? chalk.green('允许') : chalk.yellow('已关闭')} —— ${_gateLine()}`);
    console.log(`    钩子: ${installed ? chalk.green('已安装（Module._resolveFilename 已接管）') : chalk.yellow('未安装')}`);
    console.log(`    本进程已自愈: ${log.length} 次`);
    if (log.length > 0) {
      console.log('');
      for (const e of log.slice(-5)) {
        console.log(`      ${chalk.dim(e.ts)}  ${e.from}  require('${e.requested}') → ${e.healedTo}`);
      }
    }
    if (!installed) {
      console.log('');
      printWarn('钩子未生效：启动流程尚未调用 moduleSelfHeal.install()，路径自愈不会发生（接线属新机制，需维护者确认）。');
      printInfo('若你正被 MODULE_NOT_FOUND 卡住，请把报错的 require 路径反馈给维护者，或先运行 khy doctor 检查环境。');
    }
    console.log('');
    return true;
  }

  if (options.test || subCommand === 'test') {
    console.log(chalk.blue('  🧪 自检 bootstrap/moduleSelfHeal · 第 1/2 步：读取钩子状态'));
    console.log(`    开关 ${enabled ? '允许' : '已关闭'} · 钩子 ${installed ? '已安装' : '未安装'} · 记录 ${log.length} 条`);
    if (installed) {
      console.log(chalk.green('  ✓ 第 2/2 步：自愈钩子工作正常'));
    } else {
      console.log(chalk.yellow('  ⚠ 第 2/2 步：钩子未安装 —— 当前构建的启动流程不接线，自愈不会发生'));
    }
    console.log('');
    return true;
  }

  if (options.index || subCommand === 'index') {
    printInfo('模块索引在首次解析失败时才惰性扫描，moduleSelfHeal 未对外暴露索引内容；运行 khy selfheal status 查看已发生的自愈记录。');
    printInfo('想看到每一次自愈的改写：设置 KHY_MODULE_SELF_HEAL_DEBUG=1 或 KHY_DEBUG=1 后重跑。');
    return true;
  }

  console.log(chalk.bold('\n  🔧 khy selfHeal — 运行时路径自愈'));
  console.log('');
  console.log('  用法:');
  console.log('    khy selfheal            显示本帮助');
  console.log('    khy selfheal status     查看开关/钩子/自愈记录（等价 --status）');
  console.log('    khy selfheal test       自检钩子是否生效（等价 --test）');
  console.log('    khy selfheal index      说明模块索引的惰性构建（等价 --index）');
  console.log('');
  console.log('  说明:');
  console.log('    钩子拦截相对路径的 MODULE_NOT_FOUND，按同名文件扫描结果改写路径后重新解析。');
  console.log('    可用 KHY_MODULE_SELF_HEAL=0 关闭。');
  console.log('');
  return true;
}

module.exports = {
  handleSelfHeal,
  [MANIFEST_EXPORT_KEY]: {
    name: 'selfheal',
    aliases: ['selfHeal', '自愈', '修复路径', 'fixpaths'],
    description: '运行时路径自愈：统计/模块索引/自检',
    usage: 'selfheal [status|index|test|--apply]',
    subCommands: ['status', 'index', 'test'],
    category: 'system',
    handler: async (parsed) => handleSelfHeal(parsed.subCommand, parsed.args, parsed.options),
  },
};
