'use strict';

/**
 * vision.js — `khy vision config`：识图端点（视觉模型只当眼睛）的终端入口。
 *
 * 自注册命令（commandAutoRegistry）：manifest 即注册，**不需要改 router.js 的
 * switch**。router.js 是基线钉死的上帝文件，为一个新子命令去动它不值得——而
 * commandSchema.getRouterSubCommands() 会从 manifest 自动补名字和子命令
 * （commandSchema.js:2247-2265），预扫描缓存按 handlers 目录 mtime + 文件数做键、
 * dispatch miss 会强制重扫（commandAutoRegistry.js:44-51），所以新 handler 无需
 * 手动清缓存。
 *
 * 真正的交互与写入逻辑在同目录 visionConfigEditor.js。本文件只做路由与 manifest。
 */

const { MANIFEST_EXPORT_KEY } = require('../commandManifest');
const { handleVisionConfig } = require('./visionConfigEditor');

async function handleVision(subCommand, args = [], options = {}) {
  const sub = String(subCommand || '').trim().toLowerCase();

  if (!sub || sub === 'help' || options.help) {
    _printHelp();
    return true;
  }

  if (sub === 'config') {
    return await handleVisionConfig(args, options);
  }

  const { printError } = require('../formatters');
  printError(`未知子命令：vision ${sub}`);
  _printHelp();
  return false;
}

function _printHelp() {
  const { printInfo } = require('../formatters');
  printInfo('用法: khy vision config [--base-url <url> --model <id> --api-key <key>]');
  printInfo('');
  printInfo('  khy vision config                    交互式三步配置识图端点');
  printInfo('  khy vision config --json             查看当前识图端点状态');
  printInfo('  khy vision config --clear            清除识图端点（同时收回密钥）');
  printInfo('  khy vision config --no-verify        跳过连通性自检（老中转没有 /models 时用）');
  printInfo('');
  printInfo('识图模型只负责描述图片，回答仍由你选定的推理模型给出（model.default）。');
  printInfo('三个键也有非交互写法：khy config set model.vision.base_url|model|api_key <值>');
}

module.exports = {
  handleVision,
  [MANIFEST_EXPORT_KEY]: {
    name: 'vision',
    aliases: ['识图'],
    description: '视觉识图端点（图片走独立端点，只当眼睛；回答仍由推理模型给出）',
    usage: 'vision config [--base-url <url> --model <id> --api-key <key>] [--json|--clear]',
    subCommands: ['config'],
    category: 'ai',
    handler: async (parsed) => handleVision(parsed.subCommand, parsed.args, parsed.options),
  },
};
