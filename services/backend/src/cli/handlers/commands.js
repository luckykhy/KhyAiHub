'use strict';

/**
 * commands.js — `khy commands [--all]` 命令目录入口。
 *
 * 背景(#58):帮助文案承诺「查看全部命令」,但全仓从未有全量枚举入口 ——
 * `khy commands`/`khy catalog` 只渲染 22 条精选速查,`--all` 与任何裸参数
 * 一样被静默忽略(复现:commands 与 commands --all 输出逐字节相同的 42 行框)。
 * 本 handler 经 commandAutoRegistry 自注册(先于 router 的硬编码 switch 派发),
 * 补上 `--all` 全量枚举;其余形态**逐字节委托**旧路径 renderCommandCatalog(),
 * 保证裸 `khy commands` 零回归。
 *
 * 门控 KHY_COMMANDS_ALL:默认开;{0,false,off,no} 关 → `--all` 回到被静默忽略
 * 的历史行为(渲染精选框),与旧输出逐字节一致。
 */

const { MANIFEST_EXPORT_KEY } = require('../commandManifest');

const _OFF = ['0', 'false', 'off', 'no'];

function allCommandsEnabled(env = process.env) {
  const raw = env && env.KHY_COMMANDS_ALL;
  const v = String(raw == null ? '' : raw)
    .trim()
    .toLowerCase();
  return !_OFF.includes(v);
}

function _wantsAll(parsed) {
  const p = parsed || {};
  if (p.options && p.options.all) return true;
  if (Array.isArray(p.args) && p.args.includes('--all')) return true;
  if (p.subCommand === '--all') return true;
  return false;
}

async function handleCommands(parsed = {}) {
  const ui = require('../commandCatalogUi');
  if (_wantsAll(parsed) && allCommandsEnabled()) {
    ui.renderAllCommands();
    return true;
  }
  ui.renderCommandCatalog();
  return true;
}

module.exports = {
  handleCommands,
  allCommandsEnabled,
  [MANIFEST_EXPORT_KEY]: {
    name: 'commands',
    aliases: ['catalog'],
    description: '命令目录：精选速查菜单；--all 枚举全部已注册命令',
    usage: 'commands [--all]',
    subCommands: [],
    category: 'system',
    handler: handleCommands,
  },
};
